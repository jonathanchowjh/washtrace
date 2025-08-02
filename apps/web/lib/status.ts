import { BEHIND_BLOCKS, BUDGET_MS, EVERY, type CollectionRow, type Job, type PassRow, type WorkerConfig } from '@washtrace/detect';
import { chainName } from './chains';
import { eta } from './format';
import { isRunning } from './metrics';

/** Everything the status report is made from, read by the route in one go. */
export interface Snapshot {
  passes: readonly PassRow[];
  collections: readonly CollectionRow[];
  funding: readonly { chainId: number; pending: number; done: number; failed: number; truncated: number; doneLastHour: number }[];
  config: WorkerConfig;
}

/** needs-you: broken and a person can fix it. working: normal progress that takes time. info: a choice or a limit, nothing to fix. */
export type Severity = 'needs-you' | 'working' | 'info';

/** A needs-you notice always says what to do (`doThis`, with an optional place to do it); the others may offer a link. */
export type Notice =
  | { severity: 'needs-you'; text: string; doThis: string; href?: string }
  | { severity: 'working' | 'info'; text: string; action?: { label: string; href: string } };

const SEVERITIES: readonly Severity[] = ['needs-you', 'working', 'info'];

export type JobState = 'never' | 'running' | 'ok' | 'failed' | 'stalled';

/** A running pass that has said nothing for this long is stalled. The worker beats every 30 seconds. */
const SILENT_MS = 2 * 60_000;

const WORKER_DOWN = 'Check the worker process is running: docker compose ps worker';

/** What to do when a job reports a failure, and where to do it. */
const FAILED: Record<Job, [string, string?]> = {
  ingest: ['Check the chain RPC under What it reads from.', '/worker#sources'],
  fund: ['Check the Etherscan key under What it reads from.', '/worker#sources'],
  analyze: ['Open the collection and check its rules.'],
};

const JOBS: readonly Job[] = ['ingest', 'fund', 'analyze'];

/**
 * What the system is doing right now, from what the worker recorded in the
 * store. Any replica answers the same, worker or not. `notices` is the
 * report in sentences, each with how serious it is; only `needs-you` ones are
 * faults.
 */
export function status(s: Snapshot, now: number) {
  const notices: Notice[] = [];
  const notice = (severity: 'working' | 'info', text: string, action?: { label: string; href: string }) => notices.push({ severity, text, ...(action ? { action } : {}) });
  const needsYou = (text: string, doThis: string, href?: string) => notices.push({ severity: 'needs-you', text, doThis, ...(href ? { href } : {}) });
  const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min`;

  const jobs = JOBS.map((job) => {
    const p = s.passes.find((r) => r.job === job);
    let state: JobState;
    if (!p) {
      state = 'never';
      needsYou(`${job} has never run.`, WORKER_DOWN);
    } else if (isRunning(p)) {
      const lastSign = p.heartbeatAt ?? p.startedAt;
      state = now - lastSign > SILENT_MS ? 'stalled' : 'running';
      if (state === 'stalled') needsYou(`${job} has been silent for ${minutes(now - lastSign)}.`, WORKER_DOWN);
    } else if (now - p.startedAt > 3 * EVERY[job] + BUDGET_MS) {
      state = 'stalled';
      needsYou(`${job} has not run for ${minutes(now - p.startedAt)}.`, WORKER_DOWN);
    } else if (p.outcome === 'failed') {
      state = 'failed';
      needsYou(`${job} failed: ${p.detail}`, ...FAILED[job]);
    } else {
      state = 'ok';
    }
    return { job, state, startedAt: p?.startedAt ?? null, finishedAt: p?.finishedAt ?? null, tookMs: p?.tookMs ?? null, detail: p?.detail ?? null };
  });

  const collections = s.collections.map((c) => {
    const label = c.name ?? `${c.chainId}:${c.address}`;
    const behind = c.headBlock === null || c.cursorBlock === null ? null : Math.max(0, c.headBlock - c.cursorBlock);
    const paused = c.pausedAt !== null;
    const backfilling = !paused && behind !== null && behind > BEHIND_BLOCKS;
    if (backfilling) {
      const left = c.readRate ? ` ${eta((behind / c.readRate) * 1000)}.` : '';
      notice('working', `${label}: ${behind.toLocaleString('en')} blocks behind the finalized head.${left}`);
    }
    if (c.error) needsYou(`${label}: ${c.error}`, `Open ${label} to see what failed.`, `/c/${c.chainId}/${c.address}`);
    return {
      chainId: c.chainId, address: c.address, name: c.name, startBlock: c.startBlock, cursorBlock: c.cursorBlock, headBlock: c.headBlock,
      behind, turn: paused ? 'paused' as const : backfilling ? 'backfilling' as const : 'keeping-up' as const, transfers: c.transfers, stale: c.stale, analyzedAt: c.latest?.ranAt ?? null, error: c.error,
    };
  });

  // Lanes take turns per collection, so a collection gets its chain's hourly rate split among those still checking.
  const checking = (c: CollectionRow) => c.pausedAt === null && c.fundedWallets < c.wallets;
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
    if (f.failed > 0) needsYou(`${chainName(f.chainId)}: ${f.failed} wallets could not be funded.`, 'They retry on their own after an hour; if they keep failing, check the Etherscan key under What it reads from.', '/worker#sources');
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
