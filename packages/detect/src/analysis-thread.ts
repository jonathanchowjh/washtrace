import { isMainThread, parentPort, Worker as Thread, workerData } from 'node:worker_threads';
import { analyze, type Input } from './methods.js';
import type { Analysis } from './types.js';

/**
 * Where the input rides in `workerData`. A thread started by anything else
 * (a test runner's pool, a framework's build workers) that merely imports
 * this module finds no such key, and the module stays a plain import.
 */
const INPUT = 'washtraceAnalysisInput';

/**
 * Run `analyze` on a thread of its own and resolve with its result.
 *
 * `analyze` is synchronous and can run for many minutes on a big
 * collection; on the main thread that froze ingest, funding and the health
 * check for as long. A fresh thread per analysis costs a few milliseconds
 * against that, and its memory is all returned when it exits.
 *
 * Input and Analysis are plain data (arrays, plain objects, Sets), so
 * structured clone carries them across unchanged both ways.
 *
 * The thread runs this same file from `dist`, so it only works compiled: in
 * tests, `Worker.analyzeOff` is overridden instead. A throw or a crash in the
 * thread rejects, and the thread is ended either way.
 */
export function analyzeInThread(input: Input): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const thread = new Thread(new URL('./analysis-thread.js', import.meta.url), { workerData: { [INPUT]: input } });
    thread.once('message', (analysis: Analysis) => {
      resolve(analysis);
      void thread.terminate();
    });
    thread.once('error', (err) => {
      reject(err);
      void thread.terminate();
    });
    // After an answer this is a no-op; before one, the thread died without saying why.
    thread.once('exit', (code) => reject(new Error(`The analysis thread exited with code ${code} before it answered.`)));
  });
}

if (!isMainThread && parentPort !== null && workerData?.[INPUT] !== undefined) {
  parentPort.postMessage(analyze(workerData[INPUT] as Input));
}
