import { EVERY, ZERO, type FlaggedTransfer, type Flow } from '@washtrace/detect';
import { rpcUrls, workerConfig } from './config';
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

export async function workerView() {
  const s = store();
  const [passes, backlog, collections] = await Promise.all([s.passes(), s.fundingBacklog(), s.collections()]);
  const config = workerConfig(process.env);
  // The same reading of the passes as /api/status, so the page and the route never disagree about a job.
  const report = status({ passes, collections, funding: backlog, config }, Date.now());
  return {
    every: EVERY,
    rpcChains: [...rpcUrls(process.env).keys()].sort((a, b) => a - b),
    funding: config.etherscanKey === null ? null : { source: 'etherscan-v2', perSecond: config.etherscanPerSecond },
    followHops: config.followHops,
    passes,
    jobs: report.jobs,
    notices: report.notices,
    backlog,
    collections: collections.map((c) => ({
      chainId: c.chainId, address: c.address, name: c.name, startBlock: c.startBlock, cursorBlock: c.cursorBlock,
      headBlock: c.headBlock, ingestedAt: c.ingestedAt, error: c.error, errorAt: c.errorAt, stale: c.stale,
      analyzedAt: c.latest?.ranAt ?? null, analysisMs: c.latest?.tookMs ?? null,
    })),
  };
}
