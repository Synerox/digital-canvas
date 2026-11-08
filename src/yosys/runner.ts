/**
 * Loads @yowasp/yosys from the app's own files and runs elaboration.
 * Works both inside a Web Worker and on the main thread.
 *
 * The 68 MB Yosys core is shipped gzip-compressed (about 16 MB) and inflated
 * in the browser. Yosys' share/ resources (techmap libraries) are not needed
 * for elaboration, so an empty archive is served instead of the 10 MB tar.
 *
 * The compressed core is kept in this browser's Cache Storage after the first
 * download, keyed by its SHA-256, so later visits (and new deploys of the app
 * with the same Yosys) start Yosys without downloading it again.
 */
import type { runYosys as RunYosys, Tree } from '@yowasp/yosys';
import { JSON_OUT, type ScriptOptions, isSourceFile, yosysArgs } from './script';

export interface YosysModuleFile {
  /** Files relative to the yosys/ folder, concatenated in order. */
  chunks: string[];
  gzip: boolean;
  /** Bytes of all chunks together (compressed when gzip). */
  size: number;
  /** SHA-256 of all chunks together, hex. Builds before it was added have none. */
  sha256?: string;
}

export interface YosysManifest {
  /** Files relative to the yosys/ folder. */
  bundle: string;
  /** Version of @yowasp/yosys. */
  version?: string;
  /** Core module name (as the bundle requests it) -> its files. */
  modules: Record<string, YosysModuleFile>;
}

export interface RunResult {
  json: string;
  log: string;
}

/**
 * Where loading Yosys is: 'load' reads its list of files (and this browser's saved copy),
 * 'download' counts compressed bytes from the network, 'start' decompresses and compiles it.
 */
export type LoadStatus =
  | { stage: 'load' }
  | { stage: 'download'; loaded: number; total: number }
  | { stage: 'start'; fromCache: boolean };

/** Yosys could not be downloaded or started: nothing to do with the design. */
export class YosysLoadError extends Error {
  readonly loadFailure = true;
}

const GZIP_MAGIC = [0x1f, 0x8b];

/** Cache Storage name; the keys do not depend on the page's folder, so the site and its previews share one copy. */
export const CACHE_NAME = 'digital-canvas-yosys';

export function cacheKey(origin: string, file: string, sha256: string): string {
  return new URL(`/__digital-canvas-yosys/${sha256}/${file}`, origin).href;
}

function fileName(url: URL | string): string {
  return String(url).split('?')[0].split('/').pop() ?? String(url);
}

const NETWORK_HINT = 'Check the internet connection, then reload the page.';

async function readAll(res: Response, onBytes: (n: number) => void): Promise<Uint8Array> {
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
    onBytes(value.length);
  }
  return concat(parts, total);
}

function concat(parts: Uint8Array[], total = parts.reduce((s, p) => s + p.length, 0)): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Fetch one file with progress; any failure is a YosysLoadError that says what to do. */
async function download(
  fetchFn: typeof fetch,
  url: URL,
  onBytes: (n: number) => void,
  cache: RequestCache = 'default',
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url, { cache });
  } catch (e) {
    throw new YosysLoadError(`Could not download Yosys (${(e as Error).message}). ${NETWORK_HINT}`);
  }
  if (!res.ok) throw new YosysLoadError(`Could not download Yosys: ${fileName(url)} answered HTTP ${res.status}. Reload the page to try again.`);
  try {
    return await readAll(res, onBytes);
  } catch (e) {
    throw new YosysLoadError(`The Yosys download broke off (${(e as Error).message}). ${NETWORK_HINT}`);
  }
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  // Some servers already decode .gz transparently; only inflate real gzip data.
  if (data[0] !== GZIP_MAGIC[0] || data[1] !== GZIP_MAGIC[1]) return data;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(data: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  // Only secure pages (https, localhost) have it; elsewhere the files are used unchecked.
  if (!subtle) return undefined;
  const digest = new Uint8Array(await subtle.digest('SHA-256', data as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface FetchModulesDeps {
  fetch: typeof fetch;
  /** Cache Storage of this browser, if the page may use it. */
  cache?: Cache;
  origin: string;
  onStatus(s: LoadStatus): void;
}

/**
 * The core modules' bytes (still compressed), from this browser's cache when it has the same
 * files, otherwise downloaded with progress, checked against the manifest and saved for next time.
 */
export async function fetchModules(manifest: YosysManifest, baseUrl: string, deps: FetchModulesDeps): Promise<Map<string, Uint8Array>> {
  const entries = Object.entries(manifest.modules);
  const out = new Map<string, Uint8Array>();
  const missing: [string, YosysModuleFile][] = [];
  for (const [name, mod] of entries) {
    const saved = await readCached(deps, name, mod);
    if (saved) out.set(name, saved);
    else missing.push([name, mod]);
  }
  if (missing.length === 0) return out;

  const total = missing.reduce((s, [, m]) => s + m.size, 0);
  let done = 0;
  const tick = (n: number) => {
    done = Math.min(total, done + n);
    deps.onStatus({ stage: 'download', loaded: done, total });
  };
  deps.onStatus({ stage: 'download', loaded: 0, total });
  await Promise.all(
    missing.map(async ([name, mod]) => {
      const get = async (cache: RequestCache) =>
        concat(await Promise.all(mod.chunks.map((c) => download(deps.fetch, new URL(c, baseUrl), tick, cache))));
      let bytes = await get('default');
      const sum = mod.sha256 ? await sha256Hex(bytes) : undefined;
      if (sum !== undefined && sum !== mod.sha256) {
        // The HTTP cache can still hold a chunk of an earlier Yosys for a few minutes after a deploy:
        // download it again, past that cache.
        done = Math.max(0, done - bytes.length);
        bytes = await get('reload');
        if ((await sha256Hex(bytes)) !== mod.sha256) {
          throw new YosysLoadError(`The downloaded Yosys file ${name} is damaged. Reload the page to download it again.`);
        }
      }
      out.set(name, bytes);
      if (deps.cache && mod.sha256) {
        // Saving is only for next time: a full disk or a refusal must not stop this run.
        deps.cache
          .put(cacheKey(deps.origin, name, mod.sha256), new Response(bytes as BodyInit, { headers: { 'content-type': 'application/octet-stream' } }))
          .catch(() => {});
      }
    }),
  );
  return out;
}

async function readCached(deps: FetchModulesDeps, name: string, mod: YosysModuleFile): Promise<Uint8Array | undefined> {
  if (!deps.cache || !mod.sha256) return undefined;
  const key = cacheKey(deps.origin, name, mod.sha256);
  try {
    const res = await deps.cache.match(key);
    if (!res) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === mod.size && (await sha256Hex(bytes)) === mod.sha256) return bytes;
    await deps.cache.delete(key);
  } catch {
    // An unreadable entry is downloaded again.
  }
  return undefined;
}

/** Drop saved copies of other Yosys versions. */
export async function pruneCache(cache: Cache, origin: string, manifest: YosysManifest): Promise<void> {
  const keep = new Set(
    Object.entries(manifest.modules)
      .filter(([, m]) => m.sha256)
      .map(([name, m]) => cacheKey(origin, name, m.sha256!)),
  );
  for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
}

async function openCache(): Promise<Cache | undefined> {
  try {
    // Only secure pages (https, localhost) have Cache Storage; private windows may refuse it.
    return typeof caches === 'undefined' ? undefined : await caches.open(CACHE_NAME);
  } catch {
    return undefined;
  }
}

function pageOrigin(): string {
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? 'http://localhost';
}

let loaded: Promise<typeof RunYosys> | undefined;
let attempt = 0;
/** Status listener of whoever is waiting for Yosys to load, and the latest status for late listeners. */
let statusListener: ((s: LoadStatus) => void) | undefined;
let lastStatus: LoadStatus | undefined;

export function isYosysLoaded(): boolean {
  return loaded !== undefined;
}

/**
 * Download (or read from this browser's cache) and compile Yosys once; later calls share it.
 * Failures are YosysLoadErrors, and the next call tries again.
 */
export function loadYosys(baseUrl: string, onStatus?: (s: LoadStatus) => void): Promise<typeof RunYosys> {
  if (onStatus) {
    statusListener = onStatus;
    if (loaded && lastStatus) onStatus(lastStatus);
  }
  if (loaded) return loaded;
  const thisAttempt = ++attempt;
  const emit = (s: LoadStatus) => {
    lastStatus = s;
    statusListener?.(s);
  };
  loaded = (async () => {
    emit({ stage: 'load' });
    const realFetch = globalThis.fetch.bind(globalThis);
    const manifestUrl = new URL('manifest.json', baseUrl);
    if (thisAttempt > 1) manifestUrl.search = `?r=${thisAttempt}`;
    let manifest: YosysManifest;
    try {
      // Always ask the server whether the list changed, so it never names files of an older Yosys.
      manifest = JSON.parse(new TextDecoder().decode(await download(realFetch, manifestUrl, () => {}, 'no-cache')));
    } catch (e) {
      if (e instanceof YosysLoadError) throw e;
      throw new YosysLoadError(`Could not read the Yosys file list (${(e as Error).message}). Reload the page to try again.`);
    }
    const cache = await openCache();
    const origin = pageOrigin();
    let fromCache = true;
    const modulesReady = fetchModules(manifest, baseUrl, {
      fetch: realFetch,
      cache,
      origin,
      onStatus: (s) => {
        if (s.stage === 'download') fromCache = false;
        emit(s);
      },
    });
    // Reported where it is awaited below, as the download error it is.
    modulesReady.catch(() => {});

    const shim: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const file = fileName(url);
      const mod = manifest.modules[file];
      if (mod) {
        const all = await modulesReady;
        let bytes = all.get(file);
        if (!bytes) throw new YosysLoadError(`Yosys asked for ${file} twice.`);
        // Free the compressed copy once handed over.
        all.delete(file);
        if (mod.gzip) bytes = await gunzip(bytes);
        return new Response(bytes as BodyInit, { headers: { 'content-type': 'application/wasm' } });
      }
      if (/-resources\.\d+\.tar$/.test(file)) {
        // Empty tar archive: two zero blocks.
        return new Response(new Uint8Array(1024), { headers: { 'content-type': 'application/x-tar' } });
      }
      return realFetch(input, init);
    };

    // The bundle captures globalThis.fetch when it is first evaluated; it loads while the core downloads.
    globalThis.fetch = shim;
    let runYosys: typeof RunYosys;
    try {
      const bundleUrl = new URL(manifest.bundle, baseUrl);
      // A fresh URL on retries: browsers cache failed module imports per URL.
      if (thisAttempt > 1) bundleUrl.search = `?r=${thisAttempt}`;
      runYosys = ((await import(/* @vite-ignore */ bundleUrl.href)) as { runYosys: typeof RunYosys }).runYosys;
    } catch (e) {
      throw new YosysLoadError(`Could not load Yosys (${(e as Error).message}). ${NETWORK_HINT}`);
    } finally {
      globalThis.fetch = realFetch;
    }
    await modulesReady;
    emit({ stage: 'start', fromCache });
    try {
      // Decompress and compile the core once, so concurrent runs share it.
      // With no arguments the runtime only fetches and compiles its resources.
      await runYosys(undefined, {}, { fetchProgress: () => {} });
    } catch (e) {
      if (e instanceof YosysLoadError) throw e;
      throw new YosysLoadError(
        `This browser could not start Yosys (${(e as Error).message}). Use a current version of Chrome, Edge, Firefox or Safari.`,
      );
    }
    if (cache) void pruneCache(cache, origin, manifest).catch(() => {});
    return runYosys;
  })();
  loaded.catch(() => {
    loaded = undefined;
    lastStatus = undefined;
  });
  return loaded;
}

// Yosys colours its log with ANSI escape sequences.
// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function errorLine(log: string, fallback: string): string {
  const line = log.split('\n').find((l) => /(^|: )ERROR: /.test(l));
  return line?.trim() ?? fallback;
}

class ElaborationError extends Error {
  log: string;
  constructor(message: string, log: string) {
    super(message);
    this.log = log;
  }
}

export interface RunHooks {
  /** Yosys starts on the design (again, for the retry without -sv). */
  onStart?(): void;
  /** Log text as Yosys writes it, so a run that never ends still shows how far it got. */
  onLog?(text: string): void;
}

async function runOnce(runYosys: typeof RunYosys, files: Record<string, string>, opts: ScriptOptions, hooks: RunHooks): Promise<RunResult> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const sink = (bytes: Uint8Array | null) => {
    if (!bytes) return;
    const text = decoder.decode(bytes, { stream: true });
    chunks.push(text);
    hooks.onLog?.(stripAnsi(text));
  };
  hooks.onStart?.();
  let out: Tree;
  try {
    out = (await runYosys(yosysArgs(files, opts), files, {
      stdout: sink,
      stderr: sink,
      decodeASCII: false,
      fetchProgress: () => {},
    })) as Tree;
  } catch (e) {
    const log = stripAnsi(chunks.join(''));
    throw new ElaborationError(errorLine(log, (e as Error).message), log);
  }
  const log = stripAnsi(chunks.join(''));
  const raw = out[JSON_OUT];
  if (raw === undefined) throw new ElaborationError('Yosys produced no JSON output', log);
  const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
  return { json, log };
}

/** Elaborate with a loaded Yosys. */
export async function runDesign(
  runYosys: typeof RunYosys,
  files: Record<string, string>,
  top: string | undefined,
  hooks: RunHooks = {},
): Promise<RunResult> {
  try {
    return await runOnce(runYosys, files, { top }, hooks);
  } catch (e) {
    // Plain Verilog-2005 may use SystemVerilog keywords (bit, byte, logic...) as names: retry without -sv.
    const err = e as ElaborationError;
    const plain = Object.keys(files).some((f) => isSourceFile(f) && !/\.sv$/i.test(f));
    if (plain && /syntax error/i.test(err.message)) {
      try {
        return await runOnce(runYosys, files, { top, svForPlainVerilog: false }, hooks);
      } catch {
        // Report the original (SystemVerilog) error.
      }
    }
    throw err;
  }
}

/** Load Yosys (once) and elaborate: the main-thread path when no worker can start. */
export async function runElaboration(
  baseUrl: string,
  files: Record<string, string>,
  top: string | undefined,
  onStatus?: (s: LoadStatus | { stage: 'run' }) => void,
): Promise<RunResult> {
  let runYosys: typeof RunYosys;
  try {
    runYosys = await loadYosys(baseUrl, onStatus);
  } finally {
    if (statusListener === onStatus) statusListener = undefined;
  }
  return runDesign(runYosys, files, top, { onStart: () => onStatus?.({ stage: 'run' }) });
}
