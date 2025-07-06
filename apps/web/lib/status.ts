import { BEHIND_BLOCKS, BUDGET_MS, EVERY, type CollectionRow, type Job, type PassRow, type WorkerConfig } from '@washtrace/detect';
import { chainName } from './chains';
import { eta } from './format';

/** Everything the status report is made from, read by the route in one go. */
export interface Snapshot {
  passes: readonly PassRow[];
  collections: readonly CollectionRow[];
  funding: readonly { chainId: number; pending: number; done: number; failed: number; truncated: number; doneLastHour: number }[];
  config: WorkerConfig;
}

/** needs-you: broken and a person can fix it. working: normal progress that takes time. info: a choice or a limit, nothing to fix. */
export type Severity = 'needs-you' | 'working' | 'info';

export interface Notice { severity: Severity; text: string; action?: { label: string; href: string } }

const SEVERITIES: readonly Severity[] = ['needs-you', 'working', 'info'];

export type JobState = 'never' | 'running' | 'ok' | 'failed' | 'stalled';

/** A running pass that has said nothing for this long is stalled. The worker beats every 30 seconds. */
const SILENT_MS = 2 * 60_000;

const JOBS: readonly Job[] = ['ingest', 'fund', 'analyze'];

/**
 * What the system is doing right now, from what the worker recorded in the
 * store. Any replica answers the same, worker or not. `notices` is the
 * report in sentences, each with how serious it is; only `needs-you` ones are
 * faults.
 */
export function status(s: Snapshot, now: number) {
  const notices: Notice[] = [];
  const notice = (severity: Severity, text: string, action?: Notice['action']) => notices.push({ severity, text, ...(action ? { action } : {}) });
  const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min`;

  const jobs = JOBS.map((job) => {
    const p = s.passes.find((r) => r.job === job);
    let state: JobState;
    if (!p) {
      state = 'never';
      notice('needs-you', `${job} has never run.`);
    } else if (p.finishedAt === null || p.finishedAt < p.startedAt) {
      const lastSign = p.heartbeatAt ?? p.startedAt;
      state = now - lastSign > SILENT_MS ? 'stalled' : 'running';
      if (state === 'stalled') notice('needs-you', `${job} has been silent for ${minutes(now - lastSign)}.`);
    } else if (now - p.startedAt > 3 * EVERY[job] + BUDGET_MS) {
      state = 'stalled';
      notice('needs-you', `${job} has not run for ${minutes(now - p.startedAt)}.`);
    } else if (p.outcome === 'failed') {
      state = 'failed';
      notice('needs-you', `${job} failed: ${p.detail}`);
    } else {
      state = 'ok';
    }
    return { job, state, startedAt: p?.startedAt ?? null, finishedAt: p?.finishedAt ?? null, tookMs: p?.tookMs ?? null, detail: p?.detail ?? null };
  });

  const collections = s.collections.map((c) => {
    const label = c.name ?? `${c.chainId}:${c.address}`;
    const behind = c.headBlock === null || c.cursorBlock === null ? null : Math.max(0, c.headBlock - c.cursorBlock);
    const backfilling = behind !== null && behind > BEHIND_BLOCKS;
    if (backfilling) {
      const left = c.readRate ? ` ${eta((behind / c.readRate) * 1000)}.` : '';
      notice('working', `${label}: ${behind.toLocaleString('en')} blocks behind the finalized head.${left}`);
    }
    if (c.error) notice('needs-you', `${label}: ${c.error}`);
    return {
      chainId: c.chainId, address: c.address, name: c.name, startBlock: c.startBlock, cursorBlock: c.cursorBlock, headBlock: c.headBlock,
      behind, turn: backfilling ? 'backfilling' as const : 'keeping-up' as const, transfers: c.transfers, stale: c.stale, analyzedAt: c.latest?.ranAt ?? null, error: c.error,
    };
  });

  // Lanes take turns per collection, so a collection gets its chain's hourly rate split among those still checking.
  const checking = (c: CollectionRow) => c.fundedWallets < c.wallets;
  if (s.config.etherscanKey !== null) {
    for (const c of s.collections.filter(checking)) {
      const rate = (s.funding.find((f) => f.chainId === c.chainId)?.doneLastHour ?? 0) / s.collections.filter((o) => o.chainId === c.chainId && checking(o)).length;
      const left = rate > 0 ? ` · ${eta(((c.wallets - c.fundedWallets) / rate) * 3_600_000)}` : '';
      notice('working', `Checking wallets for ${c.name ?? `${c.chainId}:${c.address}`}: ${c.fundedWallets.toLocaleString('en')} of ${c.wallets.toLocaleString('en')}${left}`);
    }
  }
  if (s.config.etherscanKey === null) {
    notice('info', 'Funding is off, so Money loops back and Linked wallets are unavailable.', { label: 'How to turn it on', href: '/worker#sources' });
  }
  for (const f of s.funding) {
    if (f.failed > 0) notice('needs-you', `${chainName(f.chainId)}: ${f.failed} wallets could not be funded.`);
  }
  notices.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

  return {
    jobs,
    collections,
    // The wait is what is pending at the rate of the last hour; unknown until the worker has done some.
    funding: s.funding.map((f) => ({ ...f, etaMs: f.pending > 0 && f.doneLastHour > 0 ? (f.pending / f.doneLastHour) * 3_600_000 : null })),
    // Chain ids only: a provider URL usually carries its key.
    config: { chains: [...s.config.rpc.keys()].sort((a, b) => a - b), funding: s.config.etherscanKey !== null },
    notices,
  };
}
