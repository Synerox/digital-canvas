/// <reference lib="webworker" />
import { runElaboration } from './runner';

export type WorkerRequest = { id: number; baseUrl: string; files: Record<string, string>; top?: string };
export type WorkerResponse =
  | { id: number; type: 'progress'; loaded: number; total: number }
  | { id: number; type: 'done'; json: string; log: string }
  | { id: number; type: 'error'; message: string; log?: string };

const post = (m: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, baseUrl, files, top } = ev.data;
  try {
    const r = await runElaboration(baseUrl, files, top, (loaded, total) => post({ id, type: 'progress', loaded, total }));
    post({ id, type: 'done', json: r.json, log: r.log });
  } catch (e) {
    post({ id, type: 'error', message: (e as Error).message, log: (e as Error & { log?: string }).log });
  }
};
