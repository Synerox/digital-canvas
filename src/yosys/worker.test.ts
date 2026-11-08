import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from './worker';

// Runs the real worker and loader against test-fixtures/stub-bundle.js, which behaves like the
// @yowasp/yosys bundle: it keeps the fetch it finds when evaluated and fetches its core from it.

const BASE = new URL('./test-fixtures/', import.meta.url).href;

async function gzip(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

const CORE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 42]);
let testCase = 0;

interface Harness {
  posted: WorkerResponse[];
  requests: string[];
  send(m: WorkerRequest): void;
  /** The messages of one run, once it has finished. */
  finished(id: number): Promise<WorkerResponse[]>;
  /** Make the core download fail this many times. */
  failDownloads(n: number): void;
}

async function startWorker(): Promise<Harness> {
  const gz = await gzip(CORE);
  // A bundle URL of its own per test: the stub keeps its core and fetch once evaluated.
  const manifest = {
    bundle: `stub-bundle.js?case=${++testCase}`,
    version: 'test',
    modules: { 'yosys.core.wasm': { chunks: ['core.0.bin'], gzip: true, size: gz.length, sha256: await sha256(gz) } },
  };
  const posted: WorkerResponse[] = [];
  const requests: string[] = [];
  let failures = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url.slice(BASE.length));
    if (/manifest\.json/.test(url)) return new Response(JSON.stringify(manifest));
    if (/core\.0\.bin/.test(url)) {
      if (failures > 0) {
        failures--;
        throw new TypeError('Failed to fetch');
      }
      return new Response(gz as BodyInit);
    }
    return new Response('', { status: 404 });
  });
  const self = { postMessage: (m: WorkerResponse) => posted.push(m), onmessage: undefined as unknown };
  vi.stubGlobal('self', self);
  await import('./worker');
  const handler = self.onmessage as (ev: { data: WorkerRequest }) => void;
  const ofRun = (id: number) => posted.filter((m) => 'id' in m && m.id === id);
  return {
    posted,
    requests,
    send: (m) => handler({ data: m }),
    failDownloads: (n) => (failures = n),
    async finished(id) {
      await vi.waitFor(() => expect(ofRun(id).some((m) => m.type === 'done' || m.type === 'error')).toBe(true), { timeout: 5000 });
      return ofRun(id);
    },
  };
}

const run = (id: number, files: Record<string, string> = { 'a.v': 'module a; endmodule' }): WorkerRequest => ({ type: 'run', id, baseUrl: BASE, files });
const loads = (posted: WorkerResponse[]) => posted.filter((m) => m.type === 'load').map((m) => (m.type === 'load' ? m.status.stage : ''));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { __yosysStub?: unknown }).__yosysStub;
});

describe('Yosys worker', () => {
  it('loads Yosys once with progress, then runs designs with no loading reported again', async () => {
    const w = await startWorker();
    w.send({ type: 'load', baseUrl: BASE });
    w.send(run(1));
    const first = await w.finished(1);
    expect(loads(w.posted)).toEqual(['load', 'download', 'download', 'start', 'ready']);
    expect(first.map((m) => m.type)).toEqual(['started', 'log', 'done']);
    // The bundle got the decompressed core through the fetch it kept when it was evaluated.
    const done = first.at(-1) as Extract<WorkerResponse, { type: 'done' }>;
    expect(JSON.parse(done.json).core).toEqual(Array.from(CORE));
    expect(done.log).toBe('read a.v\n');

    const before = w.posted.length;
    w.send(run(2));
    const second = await w.finished(2);
    expect(second.map((m) => m.type)).toEqual(['started', 'log', 'done']);
    expect(loads(w.posted.slice(before))).toEqual([]);
    expect(w.requests.filter((r) => r.startsWith('core'))).toEqual(['core.0.bin']);
  });

  it('reports a failed download as a load error and loads again, at fresh URLs, for the next run', async () => {
    const w = await startWorker();
    w.failDownloads(1);
    w.send(run(1));
    const failed = await w.finished(1);
    expect(failed).toEqual([
      { id: 1, type: 'error', kind: 'load', message: 'Could not download Yosys (Failed to fetch). Check the internet connection and try again.' },
    ]);
    w.send(run(2));
    expect((await w.finished(2)).at(-1)!.type).toBe('done');
    expect(w.requests.filter((r) => r.startsWith('manifest'))).toEqual(['manifest.json', 'manifest.json?r=2']);
    expect(loads(w.posted).filter((s) => s === 'ready')).toHaveLength(1);
  });

  it('reports a Yosys this browser cannot start as a load error, not a design error', async () => {
    (globalThis as { __yosysStub?: unknown }).__yosysStub = { failStart: 'LinkError: import mismatch' };
    const w = await startWorker();
    w.send(run(1));
    expect(await w.finished(1)).toEqual([
      {
        id: 1,
        type: 'error',
        kind: 'load',
        message: 'This browser could not start Yosys (LinkError: import mismatch). Use a current version of Chrome, Edge, Firefox or Safari.',
      },
    ]);
  });

  it('reports design errors with their log, and skips runs cancelled before their turn', async () => {
    (globalThis as { __yosysStub?: unknown }).__yosysStub = { designError: 'syntax error, unexpected endmodule' };
    const w = await startWorker();
    w.send(run(1, { 'a.sv': 'module a' }));
    w.send(run(2));
    w.send({ type: 'cancel', id: 2 });
    w.send(run(3, { 'b.sv': 'module b' }));
    const failed = await w.finished(1);
    expect(failed.at(-1)).toMatchObject({ type: 'error', kind: 'design', message: 'ERROR: syntax error, unexpected endmodule' });
    expect((failed.at(-1) as { log?: string }).log).toContain('read a.sv');
    await w.finished(3);
    expect(w.posted.filter((m) => 'id' in m && m.id === 2)).toEqual([]);
  });
});
