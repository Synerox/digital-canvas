import { describe, expect, it } from 'vitest';
import { type LoadStatus, type YosysManifest, YosysLoadError, cacheKey, fetchModules, gunzip, pruneCache } from './runner';

const BASE = 'https://synerox.github.io/digital-canvas/preview/x/yosys/';
const ORIGIN = 'https://synerox.github.io';

/** Cache Storage as far as the loader uses it. */
class FakeCache {
  entries = new Map<string, Uint8Array>();
  async match(req: RequestInfo | URL) {
    const b = this.entries.get(String(req));
    return b ? new Response(b as BodyInit) : undefined;
  }
  async put(req: RequestInfo | URL, res: Response) {
    this.entries.set(String(req), new Uint8Array(await res.arrayBuffer()));
  }
  async delete(req: RequestInfo | URL) {
    return this.entries.delete(typeof req === 'object' && 'url' in req ? req.url : String(req));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }) as Request);
  }
}

async function sha256(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function gzip(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fixture() {
  const raw = new Uint8Array(200_000).map((_, i) => (i * 7919) % 251);
  const gz = await gzip(raw);
  const sha = new Map([
    [gz, await sha256(gz)],
    [gz.subarray(0, 10), await sha256(gz.subarray(0, 10))],
  ]);
  const shaOf = (b: Uint8Array) => [...sha].find(([k]) => k.length === b.length)![1];
  const half = Math.floor(gz.length / 2);
  const files: Record<string, Uint8Array> = { 'core.0.bin': gz.subarray(0, half), 'core.1.bin': gz.subarray(half), 'small.0.bin': gz.subarray(0, 10) };
  const manifest: YosysManifest = {
    bundle: 'bundle.js',
    version: 'test',
    modules: {
      'core.wasm': { chunks: ['core.0.bin', 'core.1.bin'], gzip: true, size: gz.length, sha256: shaOf(gz) },
      'small.wasm': { chunks: ['small.0.bin'], gzip: false, size: 10, sha256: shaOf(gz.subarray(0, 10)) },
    },
  };
  const requests: { file: string; cache?: RequestCache }[] = [];
  let serve = (file: string): Response => (files[file] ? new Response(files[file] as BodyInit) : new Response('missing', { status: 404 }));
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const file = String(input).split('/').pop()!;
    requests.push({ file, cache: init?.cache });
    return serve(file);
  }) as typeof fetch;
  return { raw, gz, files, manifest, requests, fetchFn, shaOf, setServe: (f: typeof serve) => (serve = f) };
}

describe('fetchModules', () => {
  it('downloads every module with progress, checks it, and keeps it in the cache for next time', async () => {
    const f = await fixture();
    const cache = new FakeCache();
    const statuses: LoadStatus[] = [];
    const got = await fetchModules(f.manifest, BASE, { fetch: f.fetchFn, cache: cache as unknown as Cache, origin: ORIGIN, onStatus: (s) => statuses.push(s) });
    expect(await gunzip(got.get('core.wasm')!)).toEqual(f.raw);
    expect(got.get('small.wasm')).toEqual(f.gz.subarray(0, 10));
    expect(f.requests.map((r) => r.file).sort()).toEqual(['core.0.bin', 'core.1.bin', 'small.0.bin']);
    const total = f.gz.length + 10;
    expect(statuses[0]).toEqual({ stage: 'download', loaded: 0, total });
    expect(statuses.at(-1)).toEqual({ stage: 'download', loaded: total, total });
    // The saved copy does not depend on the page's folder: the site and its previews share it.
    await new Promise((r) => setTimeout(r, 0));
    expect([...cache.entries.keys()].sort()).toEqual(
      [cacheKey(ORIGIN, 'core.wasm', f.shaOf(f.gz)), cacheKey(ORIGIN, 'small.wasm', f.shaOf(f.gz.subarray(0, 10)))].sort(),
    );
    expect(cacheKey(ORIGIN, 'core.wasm', 'abc')).toBe('https://synerox.github.io/__digital-canvas-yosys/abc/core.wasm');

    // The next visit reads the cache only.
    f.requests.length = 0;
    const again: LoadStatus[] = [];
    const cached = await fetchModules(f.manifest, BASE, { fetch: f.fetchFn, cache: cache as unknown as Cache, origin: ORIGIN, onStatus: (s) => again.push(s) });
    expect(f.requests).toEqual([]);
    expect(again).toEqual([]);
    expect(await gunzip(cached.get('core.wasm')!)).toEqual(f.raw);
  });

  it('downloads a damaged saved copy again', async () => {
    const f = await fixture();
    const cache = new FakeCache();
    const key = cacheKey(ORIGIN, 'core.wasm', f.manifest.modules['core.wasm'].sha256!);
    cache.entries.set(key, new Uint8Array(f.gz.length));
    await cache.put(cacheKey(ORIGIN, 'small.wasm', f.manifest.modules['small.wasm'].sha256!), new Response(f.gz.subarray(0, 10) as BodyInit));
    const got = await fetchModules(f.manifest, BASE, { fetch: f.fetchFn, cache: cache as unknown as Cache, origin: ORIGIN, onStatus: () => {} });
    expect(await gunzip(got.get('core.wasm')!)).toEqual(f.raw);
    expect(f.requests.map((r) => r.file).sort()).toEqual(['core.0.bin', 'core.1.bin']);
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.entries.get(key)).toEqual(f.gz);
  });

  it('downloads past the HTTP cache once when a chunk does not match, and reports a file that stays damaged', async () => {
    const f = await fixture();
    // The HTTP cache still holds the chunk of an earlier Yosys.
    f.setServe((file) => new Response((file === 'core.1.bin' && f.requests.at(-1)!.cache !== 'reload' ? new Uint8Array(5) : f.files[file]) as BodyInit));
    const got = await fetchModules(f.manifest, BASE, { fetch: f.fetchFn, origin: ORIGIN, onStatus: () => {} });
    expect(await gunzip(got.get('core.wasm')!)).toEqual(f.raw);
    expect(f.requests.filter((r) => r.cache === 'reload').map((r) => r.file).sort()).toEqual(['core.0.bin', 'core.1.bin']);

    const g = await fixture();
    g.setServe((file) => new Response((file === 'core.1.bin' ? new Uint8Array(5) : g.files[file]) as BodyInit));
    await expect(fetchModules(g.manifest, BASE, { fetch: g.fetchFn, origin: ORIGIN, onStatus: () => {} })).rejects.toThrow(
      /The downloaded Yosys file core\.wasm is damaged/,
    );
  });

  it('says what went wrong when the server or the network fails', async () => {
    const f = await fixture();
    f.setServe(() => new Response('', { status: 404 }));
    const err = await fetchModules(f.manifest, BASE, { fetch: f.fetchFn, origin: ORIGIN, onStatus: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(YosysLoadError);
    expect(err.message).toMatch(/answered HTTP 404/);

    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const err2 = await fetchModules(f.manifest, BASE, { fetch: offline, origin: ORIGIN, onStatus: () => {} }).catch((e) => e);
    expect(err2).toBeInstanceOf(YosysLoadError);
    expect(err2.message).toBe('Could not download Yosys (Failed to fetch). Check the internet connection, then reload the page.');
  });

  it('keeps working when the cache refuses to store', async () => {
    const f = await fixture();
    const cache = new FakeCache();
    cache.put = async () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    const got = await fetchModules(f.manifest, BASE, { fetch: f.fetchFn, cache: cache as unknown as Cache, origin: ORIGIN, onStatus: () => {} });
    expect(await gunzip(got.get('core.wasm')!)).toEqual(f.raw);
  });
});

describe('pruneCache', () => {
  it('drops saved copies of other Yosys versions only', async () => {
    const f = await fixture();
    const cache = new FakeCache();
    const keep = cacheKey(ORIGIN, 'core.wasm', f.manifest.modules['core.wasm'].sha256!);
    cache.entries.set(keep, new Uint8Array(1));
    cache.entries.set(cacheKey(ORIGIN, 'core.wasm', 'old'), new Uint8Array(1));
    await pruneCache(cache as unknown as Cache, ORIGIN, f.manifest);
    expect([...cache.entries.keys()]).toEqual([keep]);
  });
});
