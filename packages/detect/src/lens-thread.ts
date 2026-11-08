import { isMainThread, parentPort, Worker as Thread, workerData } from 'node:worker_threads';
import { runLens } from './lens.js';
import type { LensRule } from './lens-rule.js';
import { Store, type LensFlag, type LensTotals, type PreviewResult } from './store.js';
import { VENUES, venueOf } from './trades.js';

/** Where each request rides in `workerData`; see analysis-thread.ts for why a bare import must find no such key. */
const REQUEST = 'washtraceLensRequest';
const PREVIEW = 'washtracePreviewRequest';

/**
 * What the lens thread is given: where the store is, which run, and the rule.
 * Never the input: the thread reads its own, over a connection of its own.
 */
export interface LensRequest {
  /** Carries the store's password: never logged. */
  storeUrl: string;
  lensId: number;
  collectionId: number;
  chainId: number;
  rule: LensRule;
  through: number | null;
  /** follow.hops: which followed wallets the run reads (Store.followedFor). */
  followHops: number;
}

/** What a preview is given, as a run is: the preview's id is its sample's seed (P4). */
export interface PreviewRequest {
  /** Carries the store's password: never logged. */
  storeUrl: string;
  previewId: number;
  collectionId: number;
  chainId: number;
  rule: LensRule;
  through: number | null;
  /** follow.hops: which followed wallets the run reads (Store.followedFor). */
  followHops: number;
}

/** What a lens run gives: its totals, and its flags with every money edge's hash and amount filled in. */
export interface Lensed { totals: LensTotals; flags: LensFlag[] }

/** The thread's messages: any number of progress shares, then one result. */
type Message = { progress: number } | { result: Lensed | PreviewResult };

/**
 * A lens run still going after this long is stopped. The search is bounded per
 * trade (SEARCH_CAP), so one past an hour is stuck on a dead connection, and
 * would hold the analysis lock it runs under (R8) until the worker restarts.
 * A preview loads what a run loads (P3), so it is given as long.
 */
export const LENS_TIMEOUT_MS = 60 * 60_000;

/**
 * Read the run's input from `store`, run the lens, and fill each found money
 * edge's hash and exact amount (the engine holds neither: see MoneyEdge). The
 * thread's whole body; tests call it in-process.
 */
export async function lensStored(store: Store, request: LensRequest, onProgress: (share: number) => void = () => {}): Promise<Lensed> {
  // Passed straight in, so nothing here holds the transfers and Moves once the search is done: they can be freed during the fill below.
  const { totals, flags, moneyEdges } = runLens(request.rule, await store.lensInput(request.collectionId, request.chainId, request.rule, request.through, request.followHops), onProgress);
  const found = await store.moveTxs(request, moneyEdges);
  moneyEdges.forEach((m, i) => {
    const edge = flags[m.flag]!.path[m.edge]!;
    edge.tx = found[i]?.tx ?? null;
    edge.amountWei = found[i]?.amountWei ?? null;
  });
  return { totals, flags };
}

/**
 * A preview's body: the run's full input, as a lens run loads it (P3), then
 * the lens judged on the preview's seeded sample only, and Round trips'
 * catch of the same sample read from its flags. `judged` is how many sampled
 * sales the lens actually judged: a sale the token graph folds away (into a
 * custodian, a repaid loan) or the rule skips is sampled but never judged.
 * `hops` is the sampled sales that have a hop: Round trips, which has no
 * window, judges all of them, and only a sale with a hop can be flagged by
 * it. `atLeast` is only for a search cut short: an untimed sale is out of
 * `judged`, so it is no floor on a share of it, as the line Preview shows
 * reads. Its flags are counted, never kept, so no money edge's hash is looked
 * up (no `moveTxs`), and nothing is saved here: the worker saves the
 * result. Tests call it in-process.
 */
export async function previewStored(store: Store, request: PreviewRequest, onProgress: (share: number) => void = () => {}): Promise<PreviewResult> {
  const started = Date.now();
  const { collectionId, chainId, rule, through, followHops } = request;
  const sample = new Set(await store.previewSample(collectionId, request.previewId, through));
  const input = await store.lensInput(collectionId, chainId, rule, through, followHops);
  // The sales there are to sample from, and each sampled sale's market, read before the search so no key is held per transfer.
  let ofSales = 0;
  const marketOf = new Map<string, string>();
  for (const t of input.transfers) {
    if (t.marketplace === null) continue;
    ofSales += 1;
    const key = `${t.txHash}:${t.logIndex}`;
    if (sample.has(key)) marketOf.set(key, VENUES[venueOf(t.marketplace)]?.name ?? t.marketplace);
  }
  const { totals, flags, judged, hops } = runLens(rule, input, onProgress, sample);
  const byMarket = new Map<string, number>();
  for (const f of flags) {
    const market = marketOf.get(`${f.txHash}:${f.logIndex}`);
    if (market !== undefined) byMarket.set(market, (byMarket.get(market) ?? 0) + 1);
  }
  // The most caught, and of a tie the first by name, so one preview reads the same each time.
  const top = [...byMarket].sort(([p, m], [q, n]) => n - m || p.localeCompare(q))[0];
  const roundTrips = await store.roundTripsCaught(collectionId, [...sample]);
  return {
    sampled: sample.size, judged, hops, ofSales, caught: totals.flaggedSales, atLeast: totals.truncated > 0,
    roundTrips: roundTrips === null ? null : { caught: roundTrips },
    topMarket: top === undefined ? null : { name: top[0], caught: top[1] },
    truncated: totals.truncated, untimed: totals.untimed, tookMs: Date.now() - started,
  };
}

/**
 * Run `lensStored` on a thread of its own, as `analyzeInThread` runs an
 * analysis, and resolve with its result. The thread posts `{ progress }` as it
 * goes and one `{ result }` at the end; only the result resolves, so a thread
 * that dies after some progress still rejects. It runs this file from `dist`,
 * so it only works compiled: in tests `Worker.lensOff` is overridden instead.
 */
export function runLensInThread(request: LensRequest, onProgress: (share: number) => void): Promise<Lensed> {
  return inThread({ [REQUEST]: request }, 'The lens run', onProgress) as Promise<Lensed>;
}

/** Run `previewStored` on the lens thread, as `runLensInThread` runs a lens. In tests `Worker.previewOff` is overridden instead. */
export function runPreviewInThread(request: PreviewRequest, onProgress: (share: number) => void): Promise<PreviewResult> {
  return inThread({ [PREVIEW]: request }, 'The preview', onProgress) as Promise<PreviewResult>;
}

/** This file on a thread of its own with `data`, stopped after LENS_TIMEOUT_MS; `what` names it in the errors. */
function inThread(data: Record<string, unknown>, what: string, onProgress: (share: number) => void): Promise<Lensed | PreviewResult> {
  return new Promise((resolve, reject) => {
    const thread = new Thread(new URL('./lens-thread.js', import.meta.url), { workerData: data });
    const ceiling = setTimeout(() => {
      reject(new Error(`${what} took longer than ${LENS_TIMEOUT_MS / 60_000} min and was stopped.`));
      void thread.terminate();
    }, LENS_TIMEOUT_MS);
    ceiling.unref?.();
    thread.on('message', (m: Message) => {
      if ('progress' in m) {
        onProgress(m.progress);
        return;
      }
      resolve(m.result);
      void thread.terminate();
    });
    thread.once('error', (err) => {
      reject(err);
      void thread.terminate();
    });
    // After an answer this is a no-op; before one, the thread died without saying why.
    thread.once('exit', (code) => {
      clearTimeout(ceiling);
      reject(new Error(`The lens thread exited with code ${code} before it answered.`));
    });
  });
}

if (!isMainThread && parentPort !== null && (workerData?.[REQUEST] !== undefined || workerData?.[PREVIEW] !== undefined)) {
  const port = parentPort;
  const run = workerData[REQUEST] as LensRequest | undefined;
  const preview = workerData[PREVIEW] as PreviewRequest | undefined;
  const store = Store.connect((run ?? preview)!.storeUrl);
  // The search reports often; one message per whole percent is plenty.
  let said = -1;
  const progress = (share: number) => {
    const percent = Math.floor(share * 100);
    if (percent === said) return;
    said = percent;
    port.postMessage({ progress: share } satisfies Message);
  };
  let result: Lensed | PreviewResult;
  try {
    result = run !== undefined ? await lensStored(store, run, progress) : await previewStored(store, preview!, progress);
  } finally {
    await store.pool.end();
  }
  port.postMessage({ result } satisfies Message);
}
