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

function yosysBaseUrl(): string {
  return new URL('yosys/', document.baseURI).href;
}

let worker: Worker | undefined;
let workerBroken = false;
let nextId = 1;

function getWorker(): Worker | undefined {
  if (workerBroken) return undefined;
  if (!worker) {
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch {
      workerBroken = true;
      return undefined;
    }
  }
  return worker;
}

function runInWorker(w: Worker, files: Record<string, string>, top: string | undefined, onProgress?: Progress): Promise<RunResult> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onProgress?.(m.loaded, m.total);
      else {
        cleanup();
        if (m.type === 'done') resolve({ json: m.json, log: m.log });
        else reject(new YosysError(m.message, m.log));
      }
    };
    const onError = (ev: ErrorEvent) => {
      cleanup();
      reject(Object.assign(new Error(ev.message || 'worker failed'), { workerFailure: true }));
    };
    const cleanup = () => {
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
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
      // Worker could not load (e.g. blocked by the host page); use the main thread instead.
      workerBroken = true;
      worker?.terminate();
      worker = undefined;
    }
  }
  try {
    return await runElaboration(yosysBaseUrl(), files, top, onProgress);
  } catch (e) {
    throw new YosysError((e as Error).message, (e as Error & { log?: string }).log);
  }
}
