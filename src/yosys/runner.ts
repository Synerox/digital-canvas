/**
 * Loads @yowasp/yosys from the app's own files and runs elaboration.
 * Works both inside a Web Worker and on the main thread.
 *
 * The 68 MB Yosys core is shipped gzip-compressed (about 16 MB) and inflated
 * in the browser. Yosys' share/ resources (techmap libraries) are not needed
 * for elaboration, so an empty archive is served instead of the 10 MB tar.
 */
import type { runYosys as RunYosys, Tree } from '@yowasp/yosys';
import { JSON_OUT, type ScriptOptions, isSourceFile, yosysArgs } from './script';

export interface YosysManifest {
  /** Files relative to the yosys/ folder. */
  bundle: string;
  /** Core module name (as the bundle requests it) -> list of chunk files, concatenated in order. */
  modules: Record<string, { chunks: string[]; gzip: boolean; size: number }>;
}

export interface RunResult {
  json: string;
  log: string;
}

export type Progress = (loaded: number, total: number) => void;

const GZIP_MAGIC = [0x1f, 0x8b];

async function readWithProgress(res: Response, onChunk: (n: number) => void): Promise<Uint8Array> {
  if (!res.ok) throw new Error(`Failed to load ${res.url}: HTTP ${res.status}`);
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  // Some servers already decode .gz transparently; only inflate real gzip data.
  if (data[0] !== GZIP_MAGIC[0] || data[1] !== GZIP_MAGIC[1]) return data;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let loaded: Promise<typeof RunYosys> | undefined;
let attempt = 0;
/** Progress listener of whichever run is currently waiting for the download. */
let currentProgress: Progress | undefined;

export function isYosysLoaded(): boolean {
  return loaded !== undefined;
}

/** Import the Yosys bundle with a fetch shim that serves our compressed files, then fetch its resources once. */
function loadYosys(baseUrl: string): Promise<typeof RunYosys> {
  if (loaded) return loaded;
  const thisAttempt = ++attempt;
  loaded = (async () => {
    const manifestUrl = new URL('manifest.json', baseUrl);
    if (thisAttempt > 1) manifestUrl.search = `?r=${thisAttempt}`;
    const manifest: YosysManifest = await (await fetch(manifestUrl)).json();
    const total = Object.values(manifest.modules).reduce((s, m) => s + m.size, 0);
    let done = 0;
    const tick = (n: number) => {
      done += n;
      currentProgress?.(done, total);
    };

    const realFetch = globalThis.fetch.bind(globalThis);
    const shim: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const file = url.split('/').pop()!.split('?')[0];
      const mod = manifest.modules[file];
      if (mod) {
        const parts = await Promise.all(
          mod.chunks.map(async (c) => readWithProgress(await realFetch(new URL(c, baseUrl)), tick)),
        );
        let bytes: Uint8Array =
          parts.length === 1 ? parts[0] : new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
        if (mod.gzip) bytes = await gunzip(bytes);
        return new Response(bytes as BodyInit, { headers: { 'content-type': 'application/wasm' } });
      }
      if (/-resources\.\d+\.tar$/.test(file)) {
        // Empty tar archive: two zero blocks.
        return new Response(new Uint8Array(1024), { headers: { 'content-type': 'application/x-tar' } });
      }
      return realFetch(input, init);
    };

    // The bundle captures globalThis.fetch when it is first evaluated.
    globalThis.fetch = shim;
    let runYosys: typeof RunYosys;
    try {
      const bundleUrl = new URL(manifest.bundle, baseUrl);
      // A fresh URL on retries: browsers cache failed module imports per URL.
      if (thisAttempt > 1) bundleUrl.search = `?r=${thisAttempt}`;
      runYosys = ((await import(/* @vite-ignore */ bundleUrl.href)) as { runYosys: typeof RunYosys }).runYosys;
    } finally {
      globalThis.fetch = realFetch;
    }
    // Fetch and compile the core once, so concurrent runs share a single download.
    // With no arguments the runtime only fetches and compiles its resources.
    await runYosys(undefined, {}, { fetchProgress: () => {} });
    return runYosys;
  })();
  loaded.catch(() => (loaded = undefined));
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

async function runOnce(runYosys: typeof RunYosys, files: Record<string, string>, opts: ScriptOptions): Promise<RunResult> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const sink = (bytes: Uint8Array | null) => {
    if (bytes) chunks.push(decoder.decode(bytes, { stream: true }));
  };
  let out: Tree;
  try {
    out = (await runYosys(yosysArgs(files, opts), files, {
      stdout: sink,
      stderr: sink,
      decodeASCII: false,
      fetchProgress: () => {},
    })) as Tree;
  } catch (e) {
    const log = chunks.join('').replace(ANSI, '');
    throw new ElaborationError(errorLine(log, (e as Error).message), log);
  }
  const log = chunks.join('').replace(ANSI, '');
  const raw = out[JSON_OUT];
  if (raw === undefined) throw new ElaborationError('Yosys produced no JSON output', log);
  const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
  return { json, log };
}

export async function runElaboration(
  baseUrl: string,
  files: Record<string, string>,
  top: string | undefined,
  onProgress?: Progress,
): Promise<RunResult> {
  currentProgress = onProgress;
  let runYosys: typeof RunYosys;
  try {
    runYosys = await loadYosys(baseUrl);
  } finally {
    if (currentProgress === onProgress) currentProgress = undefined;
  }
  try {
    return await runOnce(runYosys, files, { top });
  } catch (e) {
    // Plain Verilog-2005 may use SystemVerilog keywords (bit, byte, logic...) as names: retry without -sv.
    const err = e as ElaborationError;
    const plain = Object.keys(files).some((f) => isSourceFile(f) && !/\.sv$/i.test(f));
    if (plain && /syntax error/i.test(err.message)) {
      try {
        return await runOnce(runYosys, files, { top, svForPlainVerilog: false });
      } catch {
        // Report the original (SystemVerilog) error.
      }
    }
    throw err;
  }
}
