import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from './worker';

// The main-thread path, used only when no worker can start.
const runElaboration = vi.fn();
vi.mock('./runner', () => ({ runElaboration: (...a: unknown[]) => runElaboration(...a) }));

/** Stands in for the Yosys worker: the test plays its side of the messages. */
class FakeWorker {
  static all: FakeWorker[] = [];
  static failToStart = false;
  received: WorkerRequest[] = [];
  terminated = false;
  private listeners: Record<string, ((ev: unknown) => void)[]> = {};
  constructor() {
    if (FakeWorker.failToStart) throw new Error('no workers here');
    FakeWorker.all.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  postMessage(m: WorkerRequest) {
    this.received.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  send(m: WorkerResponse) {
    if (this.terminated) return;
    for (const fn of this.listeners.message ?? []) fn({ data: m });
  }
  crash(message: string) {
    for (const fn of this.listeners.error ?? []) fn({ message, preventDefault() {} });
  }
  runs() {
    return this.received.filter((m): m is Extract<WorkerRequest, { type: 'run' }> => m.type === 'run');
  }
}

type Client = typeof import('./client');
let client: Client;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeWorker.all = [];
  FakeWorker.failToStart = false;
  runElaboration.mockReset();
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('document', { baseURI: 'https://synerox.github.io/digital-canvas/' });
  client = await import('./client');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const FILES = { 'a.v': 'module a; endmodule' };

describe('elaborate', () => {
  it('waits for a slow download as long as data keeps arriving, then gives the design its own time limit', async () => {
    const statuses: string[] = [];
    const run = client.elaborate(FILES, undefined, (s) => statuses.push(s.stage === 'download' ? `download ${s.loaded}` : s.stage));
    let settled = false;
    void run.finally(() => (settled = true));
    const w = FakeWorker.all[0];
    expect(w.received[0]).toEqual({ type: 'load', baseUrl: 'https://synerox.github.io/digital-canvas/yosys/' });
    expect(w.runs()).toHaveLength(1);
    // Four minutes of slow download: far past both limits, but data keeps coming.
    for (let t = 1; t <= 24; t++) {
      await vi.advanceTimersByTimeAsync(10_000);
      w.send({ type: 'load', status: { stage: 'download', loaded: t, total: 24 } });
    }
    w.send({ type: 'load', status: { stage: 'start', fromCache: false } });
    await vi.advanceTimersByTimeAsync(20_000);
    w.send({ type: 'load', status: { stage: 'ready' } });
    w.send({ id: w.runs()[0].id, type: 'started' });
    await vi.advanceTimersByTimeAsync(client.RUN_TIMEOUT_MS - 1000);
    expect(settled).toBe(false);
    w.send({ id: w.runs()[0].id, type: 'done', json: '{}', log: 'ok' });
    await expect(run).resolves.toEqual({ json: '{}', log: 'ok' });
    expect(w.terminated).toBe(false);
    expect(statuses[0]).toBe('load');
    expect(statuses).toContain('download 24');
    expect(statuses.slice(-2)).toEqual(['start', 'run']);
  });

  it('stops a design that keeps Yosys busy, keeps the log so far, and runs the next design on a fresh worker', async () => {
    const first = client.elaborate(FILES);
    const second = client.elaborate({ 'b.v': 'module b; endmodule' }, 'b');
    const w = FakeWorker.all[0];
    w.send({ type: 'load', status: { stage: 'ready' } });
    const [r1, r2] = w.runs();
    w.send({ id: r1.id, type: 'started' });
    w.send({ id: r1.id, type: 'log', text: 'Generating RTLIL representation for module `\\top\'.\n' });
    const err = first.catch((e) => e);
    await vi.advanceTimersByTimeAsync(client.RUN_TIMEOUT_MS);
    const e = await err;
    expect(e).toBeInstanceOf(client.YosysError);
    expect(e.kind).toBe('timeout');
    expect(e.message).toMatch(/^Yosys worked on the design for 60 s without finishing/);
    expect(e.log).toContain('Generating RTLIL representation');
    expect(w.terminated).toBe(true);
    // The design waiting behind it runs on a new worker, with a time limit of its own.
    const w2 = FakeWorker.all[1];
    expect(w2.runs()).toEqual([{ ...r2 }]);
    w2.send({ type: 'load', status: { stage: 'ready' } });
    await vi.advanceTimersByTimeAsync(client.RUN_TIMEOUT_MS * 2);
    w2.send({ id: r2.id, type: 'started' });
    w2.send({ id: r2.id, type: 'done', json: '{"b":1}', log: '' });
    await expect(second).resolves.toEqual({ json: '{"b":1}', log: '' });
  });

  it('reports a download that stalls as a loading problem, not a design problem', async () => {
    const run = client.elaborate(FILES).catch((e) => e);
    const w = FakeWorker.all[0];
    w.send({ type: 'load', status: { stage: 'download', loaded: 5, total: 100 } });
    await vi.advanceTimersByTimeAsync(client.STALL_MS + 1000);
    const e = await run;
    expect(e.kind).toBe('load');
    expect(e.message).toBe('Yosys stopped downloading: no data arrived for 60 s. Check the internet connection, then reload the page.');
    expect(w.terminated).toBe(true);
    // Trying again starts a new download.
    void client.elaborate(FILES);
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('passes on load and design errors from the worker with their kind, and loads again for the next run', async () => {
    const statuses: string[] = [];
    const run = client.elaborate(FILES).catch((e) => e);
    const w = FakeWorker.all[0];
    w.send({ id: w.runs()[0].id, type: 'error', kind: 'load', message: 'Could not download Yosys (Failed to fetch).' });
    const e = await run;
    expect([e.kind, e.message]).toEqual(['load', 'Could not download Yosys (Failed to fetch).']);
    // The same worker tries again, and the run shows that Yosys is loading.
    const again = client.elaborate(FILES, undefined, (s) => statuses.push(s.stage)).catch((x) => x);
    expect(FakeWorker.all).toHaveLength(1);
    expect(statuses).toEqual(['load']);
    w.send({ type: 'load', status: { stage: 'ready' } });
    const id = w.runs()[1].id;
    w.send({ id, type: 'started' });
    w.send({ id, type: 'error', kind: 'design', message: 'ERROR: syntax error', log: 'log text' });
    const e2 = await again;
    expect([e2.kind, e2.message, e2.log]).toEqual(['design', 'ERROR: syntax error', 'log text']);
  });

  it('starts loading Yosys in the background before any design needs it', async () => {
    client.preloadYosys();
    client.preloadYosys();
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0].received).toEqual([{ type: 'load', baseUrl: 'https://synerox.github.io/digital-canvas/yosys/' }]);
    // A design asked for later reports where the loading is.
    FakeWorker.all[0].send({ type: 'load', status: { stage: 'download', loaded: 3, total: 9 } });
    const statuses: unknown[] = [];
    void client.elaborate(FILES, undefined, (s) => statuses.push(s));
    expect(statuses).toEqual([{ stage: 'download', loaded: 3, total: 9 }]);
  });

  it('runs on the main thread when the worker cannot start or crashes', async () => {
    runElaboration.mockResolvedValue({ json: '{}', log: 'main' });
    const run = client.elaborate(FILES);
    FakeWorker.all[0].crash('worker script missing');
    await expect(run).resolves.toEqual({ json: '{}', log: 'main' });
    expect(runElaboration).toHaveBeenCalledWith('https://synerox.github.io/digital-canvas/yosys/', FILES, undefined, undefined);
    // Later runs go straight to the main thread, and its load errors keep their kind.
    runElaboration.mockRejectedValue(Object.assign(new Error('Could not download Yosys'), { loadFailure: true }));
    const e = await client.elaborate(FILES).catch((x) => x);
    expect([e.kind, e.message]).toEqual(['load', 'Could not download Yosys']);
    expect(FakeWorker.all).toHaveLength(1);
  });
});
