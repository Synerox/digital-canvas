/**
 * Loads @yowasp/yosys from the app's own files and runs elaboration.
 * Works both inside a Web Worker and on the main thread.
 *
 * The 68 MB Yosys core is shipped gzip-compressed (about 15 MB) and inflated
 * in the browser. Yosys' share/ resources (techmap libraries) are not needed
 * for elaboration, so an empty archive is served instead of the 10 MB tar.
 */
import type { runYosys as RunYosys, Tree } from '@yowasp/yosys';
import { JSON_OUT, yosysArgs } from './script';

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

/** Import the Yosys bundle with a fetch shim that serves our compressed files. */
function loadYosys(baseUrl: string, onProgress?: Progress): Promise<typeof RunYosys> {
  if (loaded) return loaded;
  loaded = (async () => {
    const manifestUrl = new URL('manifest.json', baseUrl);
    const manifest: YosysManifest = await (await fetch(manifestUrl)).json();
    const total = Object.values(manifest.modules).reduce((s, m) => s + m.size, 0);
    let done = 0;
    const tick = (n: number) => {
      done += n;
      onProgress?.(done, total);
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
        let bytes: Uint8Array = parts.length === 1 ? parts[0] : new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
        if (mod.gzip) bytes = await gunzip(bytes);
        return new Response(bytes as BodyInit, { headers: { 'content-type': 'application/wasm' } });
      }
      if (file.endsWith('-resources.0.tar') || /-resources\.\d+\.tar$/.test(file)) {
        // Empty tar archive: two zero blocks.
        return new Response(new Uint8Array(1024), { headers: { 'content-type': 'application/x-tar' } });
      }
      return realFetch(input, init);
    };

    // The bundle captures globalThis.fetch when it is first evaluated.
    globalThis.fetch = shim;
    try {
      const mod = (await import(/* @vite-ignore */ new URL(manifest.bundle, baseUrl).href)) as {
        runYosys: typeof RunYosys;
      };
      return mod.runYosys;
    } finally {
      globalThis.fetch = realFetch;
    }
  })();
  loaded.catch(() => (loaded = undefined));
  return loaded;
}

export async function runElaboration(
  baseUrl: string,
  files: Record<string, string>,
  top: string | undefined,
  onProgress?: Progress,
): Promise<RunResult> {
  const runYosys = await loadYosys(baseUrl, onProgress);
  const log: string[] = [];
  const decoder = new TextDecoder();
  const sink = (bytes: Uint8Array | null) => {
    if (bytes) log.push(decoder.decode(bytes));
  };
  let out: Tree;
  try {
    out = (await runYosys(yosysArgs(Object.keys(files), top), files, {
      stdout: sink,
      stderr: sink,
      decodeASCII: true,
      fetchProgress: () => {},
    })) as Tree;
  } catch (e) {
    const text = log.join('');
    const errLine = text.split('\n').find((l) => l.startsWith('ERROR')) ?? (e as Error).message;
    const err = new Error(errLine);
    (err as Error & { log?: string }).log = text;
    throw err;
  }
  const raw = out[JSON_OUT];
  const json = typeof raw === 'string' ? raw : decoder.decode(raw as Uint8Array);
  return { json, log: log.join('') };
}
