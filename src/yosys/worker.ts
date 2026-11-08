/// <reference lib="webworker" />
import { type LoadStatus, YosysLoadError, isYosysLoaded, loadYosys, runDesign } from './runner';

export type WorkerRequest =
  /** Start loading Yosys now, before any design needs it. */
  | { type: 'load'; baseUrl: string }
  | { type: 'run'; id: number; baseUrl: string; files: Record<string, string>; top?: string }
  /** The page no longer wants this run: skip it when its turn comes. */
  | { type: 'cancel'; id: number };

export type WorkerResponse =
  /** Loading progress, for every run still waiting on it; 'ready' once Yosys has loaded. */
  | { type: 'load'; status: LoadStatus | { stage: 'ready' } }
  /** Yosys starts on this run's design (again for the retry without -sv): only from here on can a design keep it busy forever. */
  | { id: number; type: 'started' }
  | { id: number; type: 'log'; text: string }
  | { id: number; type: 'done'; json: string; log: string }
  | { id: number; type: 'error'; kind: 'load' | 'design'; message: string; log?: string };

const post = (m: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

const reportLoad = (status: LoadStatus) => post({ type: 'load', status });

function load(baseUrl: string) {
  // Loaded already: nothing to report.
  if (isYosysLoaded()) return loadYosys(baseUrl);
  const p = loadYosys(baseUrl, reportLoad);
  p.then(
    () => {
      if (readyPosted) return;
      readyPosted = true;
      post({ type: 'load', status: { stage: 'ready' } });
    },
    () => {},
  );
  return p;
}
let readyPosted = false;
const cancelled = new Set<number>();

async function run(m: Extract<WorkerRequest, { type: 'run' }>) {
  const { id, baseUrl, files, top } = m;
  if (cancelled.delete(id)) return;
  let runYosys: Awaited<ReturnType<typeof loadYosys>>;
  try {
    runYosys = await load(baseUrl);
  } catch (e) {
    if (!cancelled.delete(id)) post({ id, type: 'error', kind: 'load', message: (e as Error).message });
    return;
  }
  // Cancelled while Yosys loaded.
  if (cancelled.delete(id)) return;
  try {
    const r = await runDesign(runYosys, files, top, {
      onStart: () => post({ id, type: 'started' }),
      onLog: (text) => post({ id, type: 'log', text }),
    });
    post({ id, type: 'done', json: r.json, log: r.log });
  } catch (e) {
    const kind = e instanceof YosysLoadError ? 'load' : 'design';
    post({ id, type: 'error', kind, message: (e as Error).message, log: (e as Error & { log?: string }).log });
  }
}

// One design at a time, in order: a run's time limit starts when its own turn comes, not while it waits.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const m = ev.data;
  if (m.type === 'load') {
    load(m.baseUrl).catch(() => {});
    return;
  }
  if (m.type === 'cancel') {
    cancelled.add(m.id);
    return;
  }
  queue = queue.then(() => run(m));
};
