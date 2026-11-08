/**
 * Runs Yosys in a Web Worker so the page stays responsive.
 * Falls back to the main thread if the worker cannot start.
 *
 * Loading Yosys and running it on a design have separate limits. Loading (a 16 MB download the
 * first time, then this browser's saved copy) may take as long as it needs while data keeps
 * arriving, and is only given up when nothing arrives for STALL_MS. A design gets RUN_TIMEOUT_MS
 * of Yosys' own time, counted from when Yosys starts on it, so a slow download is never
 * reported as a design that hangs.
 */
import type { WorkerRequest, WorkerResponse } from './worker';
import { type LoadStatus, type RunResult, runElaboration } from './runner';

/** design: Yosys rejected the code. timeout: Yosys did not finish the design. load: Yosys itself could not be downloaded or started. */
export type YosysErrorKind = 'design' | 'timeout' | 'load';

export class YosysError extends Error {
  log?: string;
  kind: YosysErrorKind;
  constructor(message: string, log?: string, kind: YosysErrorKind = 'design') {
    super(message);
    this.log = log;
    this.kind = kind;
  }
}

/** What a run waits for: Yosys loading (see LoadStatus), Yosys finishing an earlier run, or Yosys working on the design. */
export type YosysStatus = LoadStatus | { stage: 'queued' } | { stage: 'run' };

/** The status as the page shows it. */
export function describeStatus(y: YosysStatus): string {
  switch (y.stage) {
    case 'download': {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      return `Downloading Yosys (first time only): ${mb(y.loaded)} of ${mb(y.total)} MB…`;
    }
    case 'start':
      return y.fromCache ? 'Starting Yosys from this browser’s copy…' : 'Starting Yosys…';
    case 'queued':
      return 'Waiting for Yosys to finish an earlier run…';
    case 'run':
      return 'Elaborating with Yosys…';
    default:
      return 'Loading Yosys…';
  }
}

/** A design that keeps Yosys busy longer than this is assumed stuck (e.g. a for loop that never ends). */
export const RUN_TIMEOUT_MS = 60_000;
/** A Yosys download that receives no data for this long has stalled. */
export const STALL_MS = 60_000;
/** Decompressing and compiling Yosys takes seconds; this only catches a page that never finishes it. */
export const START_LIMIT_MS = 180_000;
/** A run no longer wanted gets this long to finish before its worker is replaced. */
export const ABORT_GRACE_MS = 3_000;

const NETWORK_HINT = 'Check the internet connection and try again.';

function yosysBaseUrl(): string {
  return new URL('yosys/', document.baseURI).href;
}

interface Job {
  id: number;
  files: Record<string, string>;
  top?: string;
  onStatus?: (s: YosysStatus) => void;
  resolve(r: RunResult): void;
  reject(e: Error): void;
  /** Yosys is working on this design (its time limit runs). */
  started: boolean;
  /** No longer wanted (already rejected), but Yosys is still working on it. */
  aborted?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** What Yosys has written for this run so far. */
  log: string;
}

interface Session {
  worker: Worker;
  jobs: Map<number, Job>;
  state: 'loading' | 'ready' | 'failed';
  /** Latest loading status. */
  loading: LoadStatus;
  /** When loading last made progress. */
  lastActivity: number;
  watchdog?: ReturnType<typeof setInterval>;
}

let session: Session | undefined;
let workerBroken = false;
let nextId = 1;

const now = () => performance.now();

function workerFailure(message: string): Error {
  return Object.assign(new Error(message), { workerFailure: true });
}

function endSession(s: Session) {
  s.worker.terminate();
  clearInterval(s.watchdog);
  if (session === s) session = undefined;
}

function failJobs(s: Session, err: Error) {
  const jobs = [...s.jobs.values()];
  s.jobs.clear();
  for (const j of jobs) {
    clearTimeout(j.timer);
    j.reject(err);
  }
}

function startSession(): Session | undefined {
  if (workerBroken) return undefined;
  if (session) return session;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    workerBroken = true;
    return undefined;
  }
  const s: Session = { worker, jobs: new Map(), state: 'loading', loading: { stage: 'load' }, lastActivity: now() };
  worker.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => onMessage(s, ev.data));
  worker.addEventListener('error', (ev) => {
    // The worker script itself failed to load or crashed: fall back to the main thread.
    ev.preventDefault();
    workerBroken = true;
    endSession(s);
    failJobs(s, workerFailure(ev.message || 'worker failed'));
  });
  watch(s);
  session = s;
  const req: WorkerRequest = { type: 'load', baseUrl: yosysBaseUrl() };
  worker.postMessage(req);
  return s;
}

/** Check on loading every second until Yosys is ready. */
function watch(s: Session) {
  s.watchdog ??= setInterval(() => checkLoading(s), 1000);
}

/** Give up a load that stopped making progress: the worker is replaced on the next run. */
function checkLoading(s: Session) {
  if (s.state !== 'loading') {
    clearInterval(s.watchdog);
    s.watchdog = undefined;
    return;
  }
  const starting = s.loading.stage === 'start';
  if (now() - s.lastActivity < (starting ? START_LIMIT_MS : STALL_MS)) return;
  endSession(s);
  const message = starting
    ? `Yosys did not start within ${START_LIMIT_MS / 60_000} minutes. Try again, or reload the page.`
    : `Yosys stopped downloading: no data arrived for ${STALL_MS / 1000} s. ${NETWORK_HINT}`;
  failJobs(s, new YosysError(message, undefined, 'load'));
}

function onMessage(s: Session, m: WorkerResponse) {
  if (session !== s) return;
  if (m.type === 'load') {
    s.lastActivity = now();
    if (m.status.stage === 'ready') {
      s.state = 'ready';
      // The first run in line starts now; the others wait for it.
      let next = true;
      for (const j of s.jobs.values()) {
        if (j.started) continue;
        if (!next) j.onStatus?.({ stage: 'queued' });
        next = false;
      }
      return;
    }
    s.state = 'loading';
    s.loading = m.status;
    watch(s);
    for (const j of s.jobs.values()) if (!j.started) j.onStatus?.(m.status);
    return;
  }
  const j = s.jobs.get(m.id);
  if (!j) {
    if (m.type === 'started') {
      // Withdrawn just as the worker started it (the cancel came too late): it still holds Yosys,
      // so it gets the grace time of any withdrawn run.
      const late: Job = { id: m.id, files: {}, resolve() {}, reject() {}, started: true, aborted: true, log: '' };
      s.jobs.set(m.id, late);
      late.timer = setTimeout(() => restart(s, late), ABORT_GRACE_MS);
    }
    return;
  }
  switch (m.type) {
    case 'started':
      // A withdrawn run keeps its grace time, also when Yosys starts it again (the retry without -sv).
      if (j.aborted) return;
      j.started = true;
      j.log = '';
      clearTimeout(j.timer);
      j.timer = setTimeout(
        () =>
          restart(
            s,
            j,
            new YosysError(
              `Yosys worked on the design for ${RUN_TIMEOUT_MS / 1000} s without finishing, so it was stopped. ` +
                'Check for a for loop or generate loop that never ends; the log shows how far Yosys got.',
              j.log || undefined,
              'timeout',
            ),
          ),
        RUN_TIMEOUT_MS,
      );
      j.onStatus?.({ stage: 'run' });
      return;
    case 'log':
      j.log += m.text;
      return;
    case 'done':
      clearTimeout(j.timer);
      s.jobs.delete(j.id);
      j.resolve({ json: m.json, log: m.log });
      return;
    case 'error':
      clearTimeout(j.timer);
      s.jobs.delete(j.id);
      // A failed load leaves the worker idle; the next run loads again.
      if (m.kind === 'load') s.state = 'failed';
      j.reject(new YosysError(m.message, m.log, m.kind));
      return;
  }
}

/**
 * Yosys cannot be interrupted: stop the run that holds it by replacing the worker, and give the
 * runs waiting behind it a fresh Yosys (from this browser's cache, in about a second).
 */
function restart(s: Session, j: Job, error?: Error) {
  s.jobs.delete(j.id);
  endSession(s);
  if (error) j.reject(error);
  const waiting = [...s.jobs.values()];
  s.jobs.clear();
  for (const other of waiting) {
    clearTimeout(other.timer);
    dispatch(other);
  }
}

function abortError(): Error {
  return new DOMException('A newer run replaced this one', 'AbortError');
}

/** The caller no longer wants this run. */
function abort(job: Job) {
  const s = session;
  if (!s || s.jobs.get(job.id) !== job || job.aborted) return;
  job.reject(abortError());
  if (!job.started) {
    s.jobs.delete(job.id);
    const req: WorkerRequest = { type: 'cancel', id: job.id };
    s.worker.postMessage(req);
    return;
  }
  // Running: a quick run may finish, but a long one (or one that never ends) must not hold up the runs after it.
  job.aborted = true;
  clearTimeout(job.timer);
  job.timer = setTimeout(() => restart(s, job), ABORT_GRACE_MS);
}

function dispatch(job: Job) {
  const s = startSession();
  if (!s) {
    job.reject(workerFailure('no worker'));
    return;
  }
  job.started = false;
  job.log = '';
  s.jobs.set(job.id, job);
  if (s.state === 'failed') {
    // The worker loads Yosys again for this run.
    s.state = 'loading';
    s.loading = { stage: 'load' };
    s.lastActivity = now();
    watch(s);
  }
  if (s.state === 'loading') job.onStatus?.(s.loading);
  else if (s.jobs.size > 1) job.onStatus?.({ stage: 'queued' });
  const req: WorkerRequest = { type: 'run', id: job.id, baseUrl: yosysBaseUrl(), files: job.files, top: job.top };
  s.worker.postMessage(req);
}

/** Start downloading and compiling Yosys in the background, before any design needs it. */
export function preloadYosys(): void {
  startSession();
}

/**
 * Elaborate the files with Yosys. `signal` withdraws the run (its promise rejects with an AbortError):
 * a run still waiting is skipped, and a running one gets ABORT_GRACE_MS before its worker is replaced.
 */
export async function elaborate(
  files: Record<string, string>,
  top?: string,
  onStatus?: (s: YosysStatus) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  if (signal?.aborted) throw abortError();
  if (startSession()) {
    try {
      return await new Promise<RunResult>((resolve, reject) => {
        const job: Job = { id: nextId++, files, top, onStatus, resolve, reject, started: false, log: '' };
        dispatch(job);
        signal?.addEventListener('abort', () => abort(job), { once: true });
      });
    } catch (e) {
      if (!(e as { workerFailure?: boolean }).workerFailure) throw e;
    }
  }
  try {
    return await runElaboration(yosysBaseUrl(), files, top, onStatus);
  } catch (e) {
    const err = e as Error & { log?: string; loadFailure?: boolean };
    throw new YosysError(err.message, err.log, err.loadFailure ? 'load' : 'design');
  }
}
