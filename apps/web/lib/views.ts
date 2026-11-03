import { EVERY, ZERO, entryFor, type AnalysisRow, type CollectionRow, type FlaggedTransfer, type Flow, type Store } from '@washtrace/detect';
import { authConfigured, mayWrite } from './auth';
import { analyzingOn, ranFlags, storedOnly, verdict, type Verdict } from './metrics';
import { configFromSources, hopsFollowed, view } from './settings';
import { pipeline } from './pipeline';
import { status } from './status';
import { store, storedManifest } from './store';

/**
 * Reads a page and its API route both serve, in one place, so the console
 * never shows what the API would not say.
 */

export interface TokenView {
  collection: { id: number; chainId: number; address: string; name: string | null };
  tokenId: string;
  transfers: FlaggedTransfer[];
  /** Wallets that joined two holders by money without holding the token: AC's middles. */
  middles: string[];
  flows: Flow[];
  /** Its collection's latest analysis: the transfers newer than it are not judged. */
  latest: AnalysisRow | null;
}

export async function tokenView(chainId: number, address: string, tokenId: string): Promise<TokenView | null> {
  const s = store();
  const c = await s.collection(chainId, address);
  if (!c) return null;
  const transfers = await s.token(c.id, tokenId);
  if (transfers.length === 0) return null;
  const middles = [...new Set(transfers.flatMap((t) => {
    const w = t.flags.AC;
    return w?.kind === 'pair' && w.middle !== null ? [w.middle] : [];
  }))];
  const holders = [...new Set(transfers.flatMap((t) => [t.from, t.to]))].filter((a) => a !== ZERO);
  const flows = holders.length === 0 ? [] : await s.flowsAmong(chainId, [...holders, ...middles]);
  return { collection: { id: c.id, chainId, address, name: c.name }, tokenId, transfers, middles, flows, latest: c.latest };
}

/** A transaction's transfers and the one verdict the page and the route both give, from each collection's latest analysis. */
export async function txView(chainId: number, tx: string): Promise<{ transfers: FlaggedTransfer[] } & Verdict> {
  const s = store();
  const transfers = await s.transaction(chainId, tx);
  const addresses = [...new Set(transfers.map((t) => t.collection?.address ?? ''))];
  const latest = new Map(await Promise.all(addresses.map(async (a) => [a, (await s.collection(chainId, a))?.latest ?? null] as const)));
  const rows = transfers.map((t) => ({ t, latest: latest.get(t.collection?.address ?? '') ?? null }));
  // Rows carry only the lenses that ran, so the API and the page never name one that did not.
  return { ...verdict(rows), transfers: rows.map((r) => ranFlags(r.t, r.latest)) };
}

/**
 * Whether some collection's loaded money trail feeds its money lenses (see
 * Store.importedFunding), so having no Etherscan key does not turn them off.
 * The one answer the worker page, Settings and /api/status all give.
 */
export async function trailFunded(s: Store, collections: readonly CollectionRow[]): Promise<boolean> {
  const trailed = collections.filter((c) => c.trailImportedSha !== null);
  return (await Promise.all(trailed.map((c) => s.importedFunding(c.id)))).some(Boolean);
}

/**
 * /api/settings and the Settings page: every field, where its value came
 * from, whether this console may change them, and whether a loaded money
 * trail feeds the money lenses without a key.
 */
export async function settingsView(headers: Headers) {
  const s = store();
  const writable = mayWrite(process.env, headers);
  const [settings, sources, collections] = await Promise.all([s.settings(), s.sources(), s.collections()]);
  return { writable, open: writable && !authConfigured(process.env), fields: view(settings, sources, writable), trailFunded: await trailFunded(s, collections) };
}

/** The worker page and /api/worker. `zone` is the reader's, for the dates in the notices. */
export async function workerView(zone = 'UTC') {
  const s = store();
  const [passes, collections, sources, settings] = await Promise.all([s.passes(), s.collections(), s.sources(), s.settings()]);
  // What the worker reported, not this process's environment: only the worker reads the chain.
  const config = configFromSources(sources, settings);
  const backlog = await s.fundingBacklog(hopsFollowed(config));
  // With no key, whether a loaded money trail still feeds the money lenses.
  const fed = config.funding ? false : await trailFunded(s, collections);
  // The same reading of the passes as /api/status, so the page and the route never disagree about a job.
  const manifest = await storedManifest();
  const report = status({ passes, collections, funding: backlog, config, trailFunded: fed, manifest }, Date.now(), zone);
  return {
    every: EVERY,
    rpcChains: config.chains,
    // null numbers are the worker's defaults; the page says them from FIELDS.
    funding: config.funding ? { source: 'etherscan-v2', perSecond: config.perSecond } : null,
    followHops: config.followHops,
    trailFunded: fed,
    passes,
    jobs: report.jobs,
    notices: report.notices,
    backlog: backlog.map((b) => ({ ...b, etaMs: report.funding.find((f) => f.chainId === b.chainId)?.etaMs ?? null })),
    collections: collections.map((c) => ({
      chainId: c.chainId, address: c.address, name: c.name, startBlock: c.startBlock, cursorBlock: c.cursorBlock,
      headBlock: c.headBlock, ingestedAt: c.ingestedAt, error: c.error, errorAt: c.errorAt, stale: c.stale,
      analyzedAt: c.latest?.ranAt ?? null, analysisMs: c.latest?.tookMs ?? null, analysisError: c.analysisError, analysisRetryAt: c.analysisRetryAt,
      turn: report.collections.find((r) => r.chainId === c.chainId && r.address === c.address)?.turn ?? 'keeping-up',
      // Paused or not: its "No RPC" is no fault while its stored data is there.
      storedOnly: storedOnly(c, new Set(config.chains)),
      stages: pipeline({ c, entry: manifest === null ? null : entryFor(manifest, c.chainId, c.address), rpcChains: new Set(config.chains), funding: config.funding, analyzing: analyzingOn(passes, c.id) })
        .map(({ key, n, title, state, share }) => ({ key, n, title, state, share })),
      backfillEtaMs: c.readRate && c.headBlock !== null && c.cursorBlock !== null ? (Math.max(0, c.headBlock - c.cursorBlock) / c.readRate) * 1000 : null,
    })),
  };
}
