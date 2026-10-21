import { isMainThread, parentPort, Worker as Thread, workerData } from 'node:worker_threads';
import { analyze, type Input } from './methods.js';
import { Payments } from './payments.js';
import { Store } from './store.js';
import type { Analysis } from './types.js';

/**
 * Where the request rides in `workerData`. A thread started by anything else
 * (a test runner's pool, a framework's build workers) that merely imports
 * this module finds no such key, and the module stays a plain import.
 */
const REQUEST = 'washtraceAnalysisRequest';

/**
 * What the analysis thread is given: where the store is, which collection,
 * and the small settings `analyze` takes. Never the input itself. Terraforms'
 * is 5.9M flows: held on the main thread and cloned into this one, it was two
 * copies at once and a 10 GB peak, past what a Docker Desktop VM often has.
 */
export interface AnalysisRequest {
  /** Carries the store's password: never logged. */
  storeUrl: string;
  id: number;
  chainId: number;
  rules: Input['rules'];
  fundingAvailable: boolean;
  custodians: ReadonlySet<string>;
  contracts: ReadonlySet<string>;
  money: ReadonlySet<string>;
}

/** An analysis and the block its input was read through, which `saveAnalysis` records. */
export interface Analysed {
  analysis: Analysis;
  through: number | null;
}

/**
 * Read one collection's input from `store` and run the methods over it. The
 * thread's whole body; tests and the profiler call it in-process.
 */
export async function analyzeStored(store: Store, request: AnalysisRequest): Promise<Analysed> {
  const { storeUrl: _, id, chainId, ...settings } = request;
  const input = await read(store, id, chainId);
  return { analysis: analyze({ ...input, ...settings }), through: input.through };
}

/**
 * The store's input with its flows made Payments. A function of its own so
 * the Flow array is garbage once it returns, not held through the analysis.
 */
async function read(store: Store, id: number, chainId: number) {
  const { flows, ...rest } = await store.analysisInput(id, chainId);
  return { ...rest, payments: Payments.from(flows, rest.transfers) };
}

/**
 * An analysis still going after this long is stopped. The biggest collection
 * takes about 17 minutes; one past an hour is stuck (a read waiting on a dead
 * connection), and would hold the analyze job's lock until the worker restarts.
 */
export const ANALYZE_TIMEOUT_MS = 60 * 60_000;

/**
 * Run `analyzeStored` on a thread of its own and resolve with its result.
 *
 * `analyze` is synchronous and can run for many minutes on a big
 * collection; on the main thread that froze ingest, funding and the health
 * check for as long. A fresh thread per analysis costs a few milliseconds
 * against that, and its memory is all returned when it exits.
 *
 * The thread reads its own input over a connection of its own, so the
 * flows only ever exist in the thread. The request and the Analysis are
 * plain data (numbers, strings, plain objects, Sets), so structured clone
 * carries them across unchanged.
 *
 * The thread runs this same file from `dist`, so it only works compiled: in
 * tests, `Worker.analyzeOff` is overridden instead. A throw or a crash in the
 * thread rejects, and so does running past ANALYZE_TIMEOUT_MS; the thread is
 * ended either way.
 */
export function analyzeInThread(request: AnalysisRequest): Promise<Analysed> {
  return new Promise((resolve, reject) => {
    const thread = new Thread(new URL('./analysis-thread.js', import.meta.url), { workerData: { [REQUEST]: request } });
    const ceiling = setTimeout(() => {
      reject(new Error(`Analysis took longer than ${ANALYZE_TIMEOUT_MS / 60_000} min and was stopped.`));
      void thread.terminate();
    }, ANALYZE_TIMEOUT_MS);
    ceiling.unref?.();
    thread.once('message', (analysed: Analysed) => {
      resolve(analysed);
      void thread.terminate();
    });
    thread.once('error', (err) => {
      reject(err);
      void thread.terminate();
    });
    // After an answer this is a no-op; before one, the thread died without saying why.
    thread.once('exit', (code) => {
      clearTimeout(ceiling);
      reject(new Error(`The analysis thread exited with code ${code} before it answered.`));
    });
  });
}

if (!isMainThread && parentPort !== null && workerData?.[REQUEST] !== undefined) {
  const request = workerData[REQUEST] as AnalysisRequest;
  const store = Store.connect(request.storeUrl);
  let analysed: Analysed;
  // The pool ends before the answer goes: the main thread ends this thread
  // on the answer, and a connection cut mid-goodbye is an error in the store's log.
  try {
    analysed = await analyzeStored(store, request);
  } finally {
    await store.pool.end();
  }
  parentPort.postMessage(analysed);
}
