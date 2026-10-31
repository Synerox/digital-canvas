/**
 * Runs Yosys in a Web Worker so the page stays responsive.
 * Falls back to the main thread if the worker cannot start.
 */
import type { WorkerRequest, WorkerResponse } from './worker';
import { type Progress, type RunResult, runElaboration } from './runner';

export class YosysError extends Error {
  log?: string;
  constructor(message: string, log?: string) {
    super(message);
    this.log = log;
  }
}

/** Elaboration that runs longer than this is assumed stuck (e.g. a for loop that never ends). */
const TIMEOUT_MS = 60_000;

function yosysBaseUrl(): string {
  return new URL('yosys/', document.baseURI).href;
}

interface Pending {
  resolve(r: RunResult): void;
  reject(e: Error): void;
  onProgress?: Progress;
  timer?: ReturnType<typeof setTimeout>;
}

let worker: Worker | undefined;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(err: Error) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function getWorker(): Worker | undefined {
  if (workerBroken) return undefined;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') {
        p.onProgress?.(m.loaded, m.total);
        return;
      }
      clearTimeout(p.timer);
      pending.delete(m.id);
      if (m.type === 'done') p.resolve({ json: m.json, log: m.log });
      else p.reject(new YosysError(m.message, m.log));
    });
    w.addEventListener('error', (ev) => {
      // The worker script itself failed to load or crashed: fall back to the main thread.
      ev.preventDefault();
      workerBroken = true;
      w.terminate();
      if (worker === w) worker = undefined;
      failAll(Object.assign(new Error(ev.message || 'worker failed'), { workerFailure: true }));
    });
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return undefined;
  }
}

function runInWorker(w: Worker, files: Record<string, string>, top: string | undefined, onProgress?: Progress): Promise<RunResult> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const entry: Pending = { resolve, reject, onProgress };
    entry.timer = setTimeout(() => {
      // Yosys cannot be interrupted: restart the worker. The next run re-imports Yosys from the HTTP cache.
      w.terminate();
      if (worker === w) worker = undefined;
      failAll(
        new YosysError(
          `Yosys did not finish within ${TIMEOUT_MS / 1000} s. Check for a for loop or generate loop that never ends.`,
        ),
      );
    }, TIMEOUT_MS);
    pending.set(id, entry);
    const req: WorkerRequest = { id, baseUrl: yosysBaseUrl(), files, top };
    w.postMessage(req);
  });
}

export async function elaborate(files: Record<string, string>, top?: string, onProgress?: Progress): Promise<RunResult> {
  const w = getWorker();
  if (w) {
    try {
      return await runInWorker(w, files, top, onProgress);
    } catch (e) {
      if (!(e as { workerFailure?: boolean }).workerFailure) throw e;
    }
  }
  try {
    return await runElaboration(yosysBaseUrl(), files, top, onProgress);
  } catch (e) {
    throw new YosysError((e as Error).message, (e as Error & { log?: string }).log);
  }
}
