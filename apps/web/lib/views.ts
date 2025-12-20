import { EVERY, ZERO, type FlaggedTransfer, type Flow } from '@washtrace/detect';
import { authConfigured } from './auth';
import { configFromSources, view } from './settings';
import { status } from './status';
import { store } from './store';

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
}

export async function tokenView(chainId: number, address: string, tokenId: string): Promise<TokenView | null> {
  const s = store();
  const c = await s.collection(chainId, address);
  if (!c) return null;
  const transfers = await s.token(c.id, tokenId);
  const middles = [...new Set(transfers.flatMap((t) => {
    const w = t.flags.AC;
    return w?.kind === 'pair' && w.middle !== null ? [w.middle] : [];
  }))];
  const holders = [...new Set(transfers.flatMap((t) => [t.from, t.to]))].filter((a) => a !== ZERO);
  const flows = holders.length === 0 ? [] : await s.flowsAmong(chainId, [...holders, ...middles]);
  return { collection: { id: c.id, chainId, address, name: c.name }, tokenId, transfers, middles, flows };
}

/** /api/settings and the Settings page: every field, where its value came from, and whether this console may change them. */
export async function settingsView() {
  const s = store();
  const writable = authConfigured(process.env);
  const [settings, sources] = await Promise.all([s.settings(), s.sources()]);
  return { writable, fields: view(settings, sources, writable) };
}

export async function workerView() {
  const s = store();
  const [passes, backlog, collections, sources, settings] = await Promise.all([s.passes(), s.fundingBacklog(), s.collections(), s.sources(), s.settings()]);
  // What the worker reported, not this process's environment: only the worker reads the chain.
  const config = configFromSources(sources, settings);
  // The same reading of the passes as /api/status, so the page and the route never disagree about a job.
  const report = status({ passes, collections, funding: backlog, config }, Date.now());
  return {
    every: EVERY,
    rpcChains: config.chains,
    // null numbers are the worker's defaults; the page says them from FIELDS.
    funding: config.funding ? { source: 'etherscan-v2', perSecond: config.perSecond } : null,
    followHops: config.followHops,
    passes,
    jobs: report.jobs,
    notices: report.notices,
    backlog: backlog.map((b) => ({ ...b, etaMs: report.funding.find((f) => f.chainId === b.chainId)?.etaMs ?? null })),
    collections: collections.map((c) => ({
      chainId: c.chainId, address: c.address, name: c.name, startBlock: c.startBlock, cursorBlock: c.cursorBlock,
      headBlock: c.headBlock, ingestedAt: c.ingestedAt, error: c.error, errorAt: c.errorAt, stale: c.stale,
      analyzedAt: c.latest?.ranAt ?? null, analysisMs: c.latest?.tookMs ?? null,
      turn: report.collections.find((r) => r.chainId === c.chainId && r.address === c.address)?.turn ?? 'keeping-up',
      backfillEtaMs: c.readRate && c.headBlock !== null && c.cursorBlock !== null ? (Math.max(0, c.headBlock - c.cursorBlock) / c.readRate) * 1000 : null,
    })),
  };
}
