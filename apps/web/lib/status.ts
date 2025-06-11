import { BEHIND_BLOCKS, BUDGET_MS, EVERY, type CollectionRow, type Job, type PassRow, type WorkerConfig } from '@washtrace/detect';
import { chainName } from './chains';

/** Everything the status report is made from, read by the route in one go. */
export interface Snapshot {
  passes: readonly PassRow[];
  collections: readonly CollectionRow[];
  funding: readonly { chainId: number; pending: number; done: number; failed: number; truncated: number }[];
  config: WorkerConfig;
}

export type JobState = 'never' | 'running' | 'ok' | 'failed' | 'stalled';

/** A running pass that has said nothing for this long is stalled. The worker beats every 30 seconds. */
const SILENT_MS = 2 * 60_000;

const JOBS: readonly Job[] = ['ingest', 'fund', 'analyze'];

/**
 * What the system is doing right now, from what the worker recorded in the
 * store. Any replica answers the same, worker or not. `problems` is the
 * report in sentences; empty means nothing needs a person.
 */
export function status(s: Snapshot, now: number) {
  const problems: string[] = [];
  const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min`;

  const jobs = JOBS.map((job) => {
    const p = s.passes.find((r) => r.job === job);
    let state: JobState;
    if (!p) {
      state = 'never';
      problems.push(`${job} has never run.`);
    } else if (p.finishedAt === null || p.finishedAt < p.startedAt) {
      const lastSign = p.heartbeatAt ?? p.startedAt;
      state = now - lastSign > SILENT_MS ? 'stalled' : 'running';
      if (state === 'stalled') problems.push(`${job} has been silent for ${minutes(now - lastSign)}.`);
    } else if (now - p.startedAt > 3 * EVERY[job] + BUDGET_MS) {
      state = 'stalled';
      problems.push(`${job} has not run for ${minutes(now - p.startedAt)}.`);
    } else if (p.outcome === 'failed') {
      state = 'failed';
      problems.push(`${job} failed: ${p.detail}`);
    } else {
      state = 'ok';
    }
    return { job, state, startedAt: p?.startedAt ?? null, finishedAt: p?.finishedAt ?? null, tookMs: p?.tookMs ?? null, detail: p?.detail ?? null };
  });

  const collections = s.collections.map((c) => {
    const label = c.name ?? `${c.chainId}:${c.address}`;
    const behind = c.headBlock === null || c.cursorBlock === null ? null : Math.max(0, c.headBlock - c.cursorBlock);
    if (behind !== null && behind > BEHIND_BLOCKS) problems.push(`${label}: ${behind.toLocaleString('en')} blocks behind the finalized head.`);
    if (c.error) problems.push(`${label}: ${c.error}`);
    return {
      chainId: c.chainId, address: c.address, name: c.name, startBlock: c.startBlock, cursorBlock: c.cursorBlock, headBlock: c.headBlock,
      behind, transfers: c.transfers, stale: c.stale, analyzedAt: c.latest?.ranAt ?? null, error: c.error,
    };
  });

  if (s.config.etherscanKey === null) problems.push('Funding is off: set WASHTRACE_ETHERSCAN_KEY. Money loops back and Linked wallets are unavailable.');
  for (const f of s.funding) {
    if (f.failed > 0) problems.push(`${chainName(f.chainId)}: ${f.failed} wallets could not be funded.`);
  }

  return {
    jobs,
    collections,
    funding: s.funding,
    // Chain ids only: a provider URL usually carries its key.
    config: { chains: [...s.config.rpc.keys()].sort((a, b) => a - b), funding: s.config.etherscanKey !== null },
    problems,
  };
}
