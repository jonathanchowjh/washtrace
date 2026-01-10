import { BEHIND_BLOCKS, BUDGET_MS, EVERY, type CollectionRow, type Job, type PassRow } from '@washtrace/detect';
import { chainName } from './chains';
import { eta, localTime } from './format';
import { isRunning, progress, storedOnly } from './metrics';
import { FIELDS, type SourcesConfig } from './settings';

/** Everything the status report is made from, read by the route in one go. */
export interface Snapshot {
  passes: readonly PassRow[];
  collections: readonly CollectionRow[];
  funding: readonly { chainId: number; pending: number; done: number; failed: number; truncated: number; doneLastHour: number }[];
  /** From the worker's report (configFromSources), never this process's environment. */
  config: SourcesConfig;
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
  ingest: ['Check the chain RPC in Settings, and Test it there.', '/settings#rpc.1'],
  fund: ['Check the Etherscan key in Settings, and Test it there.', '/settings#etherscan.key'],
  analyze: ['Open the collection and check its rules.'],
};

const JOBS: readonly Job[] = ['ingest', 'fund', 'analyze'];

/**
 * What the system is doing right now, from what the worker recorded in the
 * store. Any replica answers the same, worker or not. `notices` is the
 * report in sentences, each with how serious it is; only `needs-you` ones are
 * faults. Dates in them are said in `zone`, the reader's when it is known.
 */
export function status(s: Snapshot, now: number, zone = 'UTC') {
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
    // While stored data loads, the cursor jumps when it commits: how far behind it is now says nothing.
    const restoring = !paused && c.restoreProgress !== null;
    // No RPC, so nothing reads past the stored data: a limit to lift, not a fault.
    const stored = storedOnly(c, new Set(s.config.chains));
    const storedTurn = !paused && !restoring && stored;
    const backfilling = !paused && !restoring && !stored && behind !== null && behind > BEHIND_BLOCKS;
    if (restoring) notice('working', `Loading stored data for ${label} · ${progress(Math.min(c.restoreProgress!, 0.99))}`);
    // Not a fault: the worker reads the chain from the deploy block instead, which only takes longer.
    if (c.restoreNote) notice('info', `${label}: ${c.restoreNote}`);
    if (storedTurn) {
      const from = localTime(c.storedThroughTime!, 'date', zone);
      if (FIELDS.some((f) => f.key === `rpc.${c.chainId}`)) notice('info', `${label} shows stored data only. Set an RPC to continue from ${from}.`, { label: 'Open Settings', href: `/settings#rpc.${c.chainId}` });
      else notice('info', `${label} shows stored data only. Set WASHTRACE_RPC_${c.chainId} for the worker to continue from ${from}.`);
    }
    if (backfilling) {
      const left = c.readRate ? ` ${eta((behind / c.readRate) * 1000)}.` : '';
      notice('working', `${label}: ${behind.toLocaleString('en')} blocks behind the finalized head.${left}`);
    }
    // The worker clears its "No RPC" once it sees the stored data; until then that error is no fault either.
    const error = stored ? null : c.error;
    if (error && !s.config.chains.includes(c.chainId)) {
      // No RPC for its chain: the fix is a setting, not anything on the collection's page.
      if (FIELDS.some((f) => f.key === `rpc.${c.chainId}`)) needsYou(`${label}: ${error}`, `Open Settings and set an ${chainName(c.chainId)} RPC URL.`, `/settings#rpc.${c.chainId}`);
      else needsYou(`${label}: ${error}`, `Set WASHTRACE_RPC_${c.chainId} in the worker's environment, then restart it.`);
    } else if (error) {
      needsYou(`${label}: ${error}`, `Open ${label} to see what failed.`, `/c/${c.chainId}/${c.address}`);
    }
    return {
      chainId: c.chainId, address: c.address, name: c.name, startBlock: c.startBlock, cursorBlock: c.cursorBlock, headBlock: c.headBlock,
      behind, turn: paused ? 'paused' as const : restoring ? 'restoring' as const : storedTurn ? 'stored-only' as const : backfilling ? 'backfilling' as const : 'keeping-up' as const, transfers: c.transfers, stale: c.stale, analyzedAt: c.latest?.ranAt ?? null, error: c.error,
    };
  });

  // Lanes take turns per collection, so a collection gets its chain's hourly rate split among those still checking.
  const checking = (c: CollectionRow) => c.pausedAt === null && c.fundedWallets < c.wallets;
  if (s.config.funding) {
    for (const c of s.collections.filter(checking)) {
      const rate = (s.funding.find((f) => f.chainId === c.chainId)?.doneLastHour ?? 0) / s.collections.filter((o) => o.chainId === c.chainId && checking(o)).length;
      const left = rate > 0 ? ` · ${eta(((c.wallets - c.fundedWallets) / rate) * 3_600_000)}` : '';
      notice('working', `Checking wallets for ${c.name ?? `${c.chainId}:${c.address}`}: ${c.fundedWallets.toLocaleString('en')} of ${c.wallets.toLocaleString('en')}${left}`);
    }
  }
  if (!s.config.funding) {
    notice('info', 'Funding is off, so Money loops back and Linked wallets are unavailable.', { label: 'Add an Etherscan key in Settings', href: '/settings#etherscan.key' });
  }
  for (const f of s.funding) {
    if (f.failed > 0) needsYou(`${chainName(f.chainId)}: ${f.failed} wallets could not be funded.`, 'They retry on their own after an hour; if they keep failing, check the Etherscan key in Settings.', '/settings#etherscan.key');
  }
  notices.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));

  return {
    jobs,
    collections,
    // The wait is what is pending at the rate of the last hour; unknown until the worker has done some.
    funding: s.funding.map((f) => ({ ...f, etaMs: f.pending > 0 && f.doneLastHour > 0 ? (f.pending / f.doneLastHour) * 3_600_000 : null })),
    // Chain ids only: a provider URL usually carries its key.
    config: { chains: s.config.chains, funding: s.config.funding },
    notices,
  };
}
