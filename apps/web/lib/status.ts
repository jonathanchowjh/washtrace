import { BEHIND_BLOCKS, BUDGET_MS, EVERY, STUCK_MS, entryFor, type CollectionRow, type Job, type Manifest, type PassRow } from '@washtrace/detect';
import { chainName } from './chains';
import { eta, formatBytes, localTime } from './format';
import { analysisRetry, downloaded, isRunning, progress, restoreText, storedOnly } from './metrics';
import { FIELDS, type SourcesConfig } from './settings';

/** Everything the status report is made from, read by the route in one go. */
export interface Snapshot {
  passes: readonly PassRow[];
  collections: readonly CollectionRow[];
  /** pending and failed are what the worker will check; stranded is held back with paused or removed collections, or followed further out than the hops set (fundingBacklog). */
  funding: readonly { chainId: number; pending: number; done: number; failed: number; stranded: number; truncated: number; doneLastHour: number }[];
  /** From the worker's report (configFromSources), never this process's environment. */
  config: SourcesConfig;
  /** Whether some collection's loaded money trail feeds its money lenses (trailFunded in views), as the worker page and Settings say it. */
  trailFunded: boolean;
  /** The cached stored-data manifest (storedManifest), for the sizes of a download; absent or null says none. */
  manifest?: Manifest | null;
}

/** needs-you: broken and a person can fix it. working: normal progress that takes time. info: a choice or a limit, nothing to fix. */
export type Severity = 'needs-you' | 'working' | 'info';

/** A needs-you notice always says what to do (`doThis`, with an optional place to do it); the others may offer a link. */
export type Notice =
  | { severity: 'needs-you'; text: string; doThis: string; href?: string }
  | { severity: 'working' | 'info'; text: string; action?: { label: string; href: string } };

const SEVERITIES: readonly Severity[] = ['needs-you', 'working', 'info'];

export type JobState = 'never' | 'running' | 'ok' | 'failed' | 'stalled';

/** A running pass that has said nothing for this long is stalled. The worker beats every 30 seconds from the pass's start. */
const SILENT_MS = 2 * 60_000;

const WORKER_DOWN = 'Check the worker process is running: docker compose ps worker';

/** A pass past its job's STUCK_MS ends with the process: a restart lets go of its lock, and the next pass starts fresh. */
const RESTART = 'Restart the worker: docker compose restart worker';

/** What to do when a job reports a failure, and where to do it. */
const FAILED: Record<Job, [string, string?]> = {
  ingest: ['Check the chain RPC in Settings, and Test it there.', '/settings#rpc.1'],
  fund: ['Check the Etherscan key in Settings, and Test it there.', '/settings#etherscan.key'],
  // One collection's failed analysis is said on it (analysisError); this is a pass that failed outside one.
  analyze: ["Check the worker's log: docker compose logs worker"],
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
      // Silent: the worker stopped beating. Past its ceiling with a fresh beat: the worker is up, and this pass is stuck.
      const lastSign = p.heartbeatAt ?? p.startedAt;
      if (now - lastSign > SILENT_MS) {
        state = 'stalled';
        needsYou(`${job} has been silent for ${minutes(now - lastSign)}.`, WORKER_DOWN);
      } else if (now - p.startedAt > STUCK_MS[job]) {
        state = 'stalled';
        needsYou(`${job} has been running for ${minutes(now - p.startedAt)}.`, RESTART);
      } else {
        state = 'running';
      }
    } else {
      // From when it finished, so a long pass is not overdue the moment it ends. A failure is said either way.
      const overdue = now - p.finishedAt! > 3 * EVERY[job] + BUDGET_MS;
      if (p.outcome === 'failed') {
        // An analysis that failed on a collection is said on it, below, until one succeeds. Said here only when it is not:
        // the pass failed before it took one, the collection is gone, or the failure could not be written to it.
        const on = job === 'analyze' && p.subjectId !== null ? s.collections.find((c) => c.id === p.subjectId) : undefined;
        if (!on?.analysisError) needsYou(`${job} failed: ${p.detail}`, ...FAILED[job]);
      }
      if (overdue) needsYou(`${job} has not run for ${minutes(now - p.finishedAt!)}.`, WORKER_DOWN);
      state = overdue ? 'stalled' : p.outcome === 'failed' ? 'failed' : 'ok';
    }
    return { job, state, startedAt: p?.startedAt ?? null, finishedAt: p?.finishedAt ?? null, tookMs: p?.tookMs ?? null, outcome: p?.outcome ?? null, detail: p?.detail ?? null };
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
    // A trail download is a working notice too: the transfers are there, the money trail is on its way.
    if (!paused && c.downloadFile !== null && c.downloadProgress !== null) {
      const e = s.manifest ? entryFor(s.manifest, c.chainId, c.address) : null;
      const bytes = c.downloadFile === 'trail' ? e?.trail?.bytes : e?.transfers.bytes;
      const what = c.downloadFile === 'trail' ? 'the money trail' : 'stored data';
      notice('working', `Downloading ${what} for ${label} · ${downloaded(c.downloadProgress)}${bytes === undefined ? '' : ` of ${formatBytes(bytes)}`}`);
    }
    // The downloaded trail goes into the database after the download; the lenses run again once it is in.
    if (!paused && c.trailProgress !== null) notice('working', `Loading the money trail for ${label} · ${downloaded(c.trailProgress)}`);
    // Not a fault: its chain is read instead where there is an RPC, and the note says it is tried again. A paused collection tries nothing.
    if (!paused && c.downloadNote) notice('info', `${label}: ${c.downloadNote}`);
    if (restoring) notice('working', `Loading stored data for ${label} · ${progress(Math.min(c.restoreProgress!, 0.99))}`);
    // Not a fault: the chain is read instead where there is an RPC, and the note says when the stored data is tried again.
    const restore = restoreText(c, new Set(s.config.chains), zone);
    if (restore !== null) notice('info', `${label}: ${restore}`);
    if (storedTurn) {
      // Past the stored data (read on while an RPC was set), it stops at its cursor, whose date is not known. Text, so the locale is pinned.
      const past = c.storedThroughBlock !== null && c.cursorBlock! > c.storedThroughBlock;
      const block = `block ${c.cursorBlock!.toLocaleString('en')}`;
      const said = past ? `${label} is read to ${block} and its chain has no RPC.` : `${label} shows stored data only.`;
      const from = past ? block : localTime(c.storedThroughTime!, 'date', zone, 'en-GB');
      if (FIELDS.some((f) => f.key === `rpc.${c.chainId}`)) notice('info', `${said} Set an RPC to continue from ${from}.`, { label: 'Open Settings', href: `/settings#rpc.${c.chainId}` });
      else notice('info', `${said} Set WASHTRACE_RPC_${c.chainId} for the worker to continue from ${from}.`);
    }
    if (backfilling) {
      const left = c.readRate ? ` ${eta((behind / c.readRate) * 1000)}.` : '';
      notice('working', `${label}: ${behind.toLocaleString('en')} blocks behind the finalized head.${left}`);
    }
    // The worker clears its "No RPC" once it sees the stored data; until then that error is no fault either.
    const error = stored ? null : c.error;
    if (error && paused) {
      // The worker does not touch a paused collection, so its error stays from before the pause: nothing is failing now.
      notice('info', `${label}: Paused · last error before the pause: ${error}`);
    } else if (error && !s.config.chains.includes(c.chainId)) {
      // No RPC for its chain: the fix is a setting, not anything on the collection's page.
      if (FIELDS.some((f) => f.key === `rpc.${c.chainId}`)) needsYou(`${label}: ${error}`, `Open Settings and set an ${chainName(c.chainId)} RPC URL.`, `/settings#rpc.${c.chainId}`);
      else needsYou(`${label}: ${error}`, `Set WASHTRACE_RPC_${c.chainId} in the worker's environment, then restart it.`);
    } else if (error) {
      needsYou(`${label}: ${error}`, `Open ${label} to see what failed.`, `/c/${c.chainId}/${c.address}`);
    }
    // Kept on the collection until an analysis succeeds, so it is said between passes too. Paused, nothing tries it again.
    if (c.analysisError && paused) notice('info', `${label}: Paused · its last analysis before the pause failed: ${c.analysisError}`);
    else if (c.analysisError) {
      needsYou(
        `Analysis of ${label} failed: ${c.analysisError}`,
        `Wait: ${analysisRetry(c, now, zone)}, while the other collections are analysed. If it keeps failing, check the worker's log: docker compose logs worker`,
        `/c/${c.chainId}/${c.address}`,
      );
    }
    return {
      chainId: c.chainId, address: c.address, name: c.name, startBlock: c.startBlock, cursorBlock: c.cursorBlock, headBlock: c.headBlock,
      behind, turn: paused ? 'paused' as const : restoring ? 'restoring' as const : storedTurn ? 'stored-only' as const : backfilling ? 'backfilling' as const : 'keeping-up' as const, transfers: c.transfers, stale: c.stale, analyzedAt: c.latest?.ranAt ?? null, error: c.error,
      analysisError: c.analysisError, analysisRetryAt: c.analysisRetryAt,
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
    // A money trail loaded from stored data is funding the worker does not have to fetch.
    notice('info', s.trailFunded
      ? 'Funding is off: Money loops back and Linked wallets run on stored money trails only, and newer wallets go unchecked.'
      : 'Funding is off, so Money loops back and Linked wallets are unavailable.', { label: 'Add an Etherscan key in Settings', href: '/settings#etherscan.key' });
  }
  // With funding off nothing retries failed wallets, and the notice above says why.
  for (const f of s.config.funding ? s.funding : []) {
    // No lane takes these, so they neither wait nor fail: resuming a collection brings its own back.
    if (f.stranded > 0) notice('info', `${chainName(f.chainId)}: ${f.stranded.toLocaleString('en')} wallets are not checked while their collections are paused or removed, or they are further out than the hops followed.`);
    // Only wallets the worker will check count as failed, so one held back never blames the key.
    if (f.failed === 0) continue;
    // Some wallets failing while others are checked is a rate limit or a timeout: they retry on their own.
    // None checked in an hour while some fail is the key or the URL, and a person must look.
    if (f.doneLastHour === 0) {
      needsYou(`${chainName(f.chainId)}: ${f.failed} wallets could not be checked for money, and none was checked in the last hour.`, 'Check the Etherscan key in Settings, and Test it there.', '/settings#etherscan.key');
    } else {
      notice('working', `${chainName(f.chainId)}: ${f.failed} wallets could not be checked for money; they retry on their own after an hour.`);
    }
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
