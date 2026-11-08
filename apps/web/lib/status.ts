import { BEHIND_BLOCKS, BUDGET_MS, EVERY, STUCK_MS, entryFor, type CollectionRow, type Job, type Manifest, type PassRow } from '@washtrace/detect';
import { chainName } from './chains';
import { LENSES, eta, formatBytes, localTime, num } from './format';
import { analysisRetry, downloaded, isRunning, progress, restoreText, storedOnly } from './coverage';
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
type Severity = 'needs-you' | 'working' | 'info';

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
  // One lens run's failure is said on its tab; this is a pass that failed outside one.
  lens: ["Check the worker's log: docker compose logs worker"],
};

const JOBS: readonly Job[] = ['ingest', 'fund', 'analyze', 'lens'];

/** Each job by the step the worker page names it, so a notice says which step stopped, never the job's code. */
export const JOB_STEP: Readonly<Record<Job, string>> = {
  ingest: 'Read transfers', fund: 'Check wallets for money', analyze: 'Run the built-in lenses', lens: 'Run your lenses',
};

/** Analyze and lens take the same lock (R8), so while one runs the other's passes are skipped, and a skipped pass records nothing. */
const PARTNER: Partial<Record<Job, Job>> = { analyze: 'lens', lens: 'analyze' };

/** `job`'s partner on the shared lock and its row, for `jobState`. */
export function partnerOf(passes: readonly PassRow[], job: Job): { job: Job; pass: PassRow | undefined } | undefined {
  const partner = PARTNER[job];
  return partner === undefined ? undefined : { job: partner, pass: passes.find((r) => r.job === partner) };
}

/**
 * One job's state from its last pass, and when it is stalled, why. A running
 * pass is stalled when the worker stopped beating (silent) or it ran past its
 * ceiling (stuck); a finished one is stalled when it is long overdue (from
 * when it finished, so a long pass is not overdue the moment it ends), else
 * failed or ok.
 *
 * `partner` (see partnerOf) is the job sharing this one's lock. While it runs
 * and is not stalled, this job's passes are skipped for the lock, not missed,
 * so a finished job is not overdue; and its wait counts from the later of
 * its own and the partner's finish, so a long partner pass that just ended
 * does not make it overdue at once. A stalled partner gives no cover. The
 * later finish is capped at one partner ceiling (STUCK_MS) past its own
 * (Ruling O): short partner passes would otherwise chain, each one renewing
 * the cover, and a job that stopped would read on time for ever.
 */
export function jobState(p: PassRow | undefined, job: Job, now: number, partner?: { job: Job; pass: PassRow | undefined }): { state: JobState; why: 'silent' | 'stuck' | 'overdue' | null } {
  if (!p) return { state: 'never', why: null };
  if (isRunning(p)) {
    if (now - (p.heartbeatAt ?? p.startedAt) > SILENT_MS) return { state: 'stalled', why: 'silent' };
    if (now - p.startedAt > STUCK_MS[job]) return { state: 'stalled', why: 'stuck' };
    return { state: 'running', why: null };
  }
  const lastSign = partner === undefined ? p.finishedAt! : Math.min(Math.max(p.finishedAt!, partner.pass?.finishedAt ?? 0), p.finishedAt! + STUCK_MS[partner.job]);
  if (!partnerHolds(partner, now) && now - lastSign > 3 * EVERY[job] + BUDGET_MS) return { state: 'stalled', why: 'overdue' };
  return { state: p.outcome === 'failed' ? 'failed' : 'ok', why: null };
}

/** Ruling M: the partner is running and not stalled, so it holds the shared lock, and this job's passes are skipped, not missed. */
function partnerHolds(partner: { job: Job; pass: PassRow | undefined } | undefined, now: number): boolean {
  return partner?.pass !== undefined && jobState(partner.pass, partner.job, now).state === 'running';
}

/**
 * Ruling QQ: whether `job`, which has never run, is waiting on its partner
 * rather than on a worker that is down. Covered while the partner holds the
 * lock (a stalled one covers nothing) or once it finished, for the wait a
 * pass of `job`'s own would be allowed: the cover jobState gives a finished
 * job, from the partner's finish. With no finish of its own there is nothing
 * to cap it from (Ruling O), so a dead job reads covered while its partner's
 * passes go on.
 */
function neverCovered(job: Job, now: number, partner: { job: Job; pass: PassRow | undefined } | undefined): boolean {
  const done = partner?.pass?.finishedAt ?? null;
  return partnerHolds(partner, now) || (done !== null && now - done <= 3 * EVERY[job] + BUDGET_MS);
}

/**
 * The worker is silent when every job is stalled or never ran. One job that is
 * running, on time, or failed (a failure is the worker saying so) means it is
 * alive, and a stalled analysis beside a live ingest is that job's fault, said
 * on the worker page. `since` is the last sign of life of any pass, null when
 * none ever ran.
 */
export function workerSilent(passes: readonly PassRow[], now: number): { since: number | null } | null {
  for (const job of JOBS) {
    const { state } = jobState(passes.find((r) => r.job === job), job, now, partnerOf(passes, job));
    if (state !== 'stalled' && state !== 'never') return null;
  }
  const signs = passes.flatMap((p) => [p.heartbeatAt, p.finishedAt, p.startedAt]).filter((t): t is number => t !== null);
  return { since: signs.length === 0 ? null : Math.max(...signs) };
}

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
    const partner = partnerOf(s.passes, job);
    const { state, why } = jobState(p, job, now, partner);
    if (!p) {
      // The job's line still reads never run; only the notice waits on a partner that holds the lock (Ruling QQ).
      if (!neverCovered(job, now, partner)) needsYou(`${JOB_STEP[job]} has never run.`, WORKER_DOWN);
    } else if (isRunning(p)) {
      // Silent: the worker stopped beating. Stuck: past its ceiling with a fresh beat, so the worker is up and this pass is not.
      if (why === 'silent') needsYou(`${JOB_STEP[job]} has been silent for ${minutes(now - (p.heartbeatAt ?? p.startedAt))}.`, WORKER_DOWN);
      else if (why === 'stuck') needsYou(`${JOB_STEP[job]} has been running for ${minutes(now - p.startedAt)}.`, RESTART);
    } else {
      if (p.outcome === 'failed') {
        // An analysis that failed on a collection is said on it, below, until one succeeds. Said here only when it is not:
        // the pass failed before it took one, the collection is gone, or the failure could not be written to it.
        const on = job === 'analyze' && p.subjectId !== null ? s.collections.find((c) => c.id === p.subjectId) : undefined;
        if (!on?.analysisError) needsYou(`${JOB_STEP[job]} failed: ${p.detail}`, ...FAILED[job]);
      }
      if (why === 'overdue') needsYou(`${JOB_STEP[job]} has not run for ${minutes(now - p.finishedAt!)}.`, WORKER_DOWN);
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
    const rpc = s.config.chains.includes(c.chainId);
    const stored = storedOnly(c, new Set(s.config.chains));
    const storedTurn = !paused && !restoring && stored;
    // With no RPC nothing reads the blocks it is behind, so there is no work to announce.
    const backfilling = !paused && !restoring && !stored && rpc && behind !== null && behind > BEHIND_BLOCKS;
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
    const restore = restoreText(c, new Set(s.config.chains), now, zone);
    if (restore !== null) notice('info', `${label}: ${restore}`);
    if (storedTurn) {
      // Past the stored data (read on while an RPC was set), it stops at its cursor, whose date is not known. Text, so the locale is pinned.
      const past = c.storedThroughBlock !== null && c.cursorBlock! > c.storedThroughBlock;
      const block = `block ${num(c.cursorBlock!)}`;
      const said = past ? `${label} is read to ${block} and its chain has no RPC.` : `${label} shows stored data only.`;
      const from = past ? block : localTime(c.storedThroughTime!, 'date', zone, 'en-GB');
      if (FIELDS.some((f) => f.key === `rpc.${c.chainId}`)) notice('info', `${said} Set an RPC to continue from ${from}.`, { label: 'Open Settings', href: `/settings#rpc.${c.chainId}` });
      else notice('info', `${said} Set WASHTRACE_RPC_${c.chainId} for the worker to continue from ${from}.`);
    }
    if (backfilling) {
      const left = c.readRate ? ` ${eta((behind / c.readRate) * 1000)}.` : '';
      notice('working', `${label}: ${num(behind)} blocks behind the finalized head.${left}`);
    }
    // The worker clears its "No RPC" once it sees the stored data; until then that error is no fault either.
    const error = stored ? null : c.error;
    if (error && paused) {
      // The worker does not touch a paused collection, so its error stays from before the pause: nothing is failing now.
      // On a chain with no RPC the error is the old "No RPC", so the limit is said instead.
      notice('info', rpc ? `${label}: Paused · last error before the pause: ${error}` : `${label}: Paused · no RPC is set for ${chainName(c.chainId)}.`);
    } else if (error && !rpc) {
      // No RPC for its chain is a limit to lift, not a fault: the fix is a setting, not anything on the collection's page.
      if (FIELDS.some((f) => f.key === `rpc.${c.chainId}`)) notice('info', `${label}: no RPC is set for ${chainName(c.chainId)}, so nothing is read.`, { label: 'Add an RPC URL in Settings', href: `/settings#rpc.${c.chainId}` });
      else notice('info', `${label}: no RPC is set for ${chainName(c.chainId)}. Set WASHTRACE_RPC_${c.chainId} for the worker to read this chain.`);
    } else if (error) {
      needsYou(`${label}: ${error}`, `Open ${label} to see what failed.`, `/c/${c.chainId}/${c.address}`);
    }
    // Kept on the collection until an analysis succeeds, so it is said between passes too. Paused, nothing tries it again.
    if (c.analysisError && paused) notice('info', `${label}: Paused · its last analysis before the pause failed: ${c.analysisError}`);
    else if (c.analysisError) {
      needsYou(
        `Analysis of ${label} failed: ${c.analysisError}`,
        `Wait: ${analysisRetry(c, now, zone)}, while the other collections are analyzed. If it keeps failing, check the worker's log: docker compose logs worker`,
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
      notice('working', `Checking wallets for ${c.name ?? `${c.chainId}:${c.address}`}: ${num(c.fundedWallets)} of ${num(c.wallets)}${left}`);
    }
  }
  if (!s.config.funding) {
    // A money trail loaded from stored data is funding the worker does not have to fetch.
    notice('info', s.trailFunded
      ? `Needs an Etherscan key: ${LENSES.AU.name} and ${LENSES.AC.name} run on stored money trails only, and newer wallets go unchecked.`
      : `Needs an Etherscan key: ${LENSES.AU.name} and ${LENSES.AC.name} do not run without one.`, { label: 'Add an Etherscan key in Settings', href: '/settings#etherscan.key' });
  }
  // With no key nothing retries failed wallets, and the notice above says why.
  for (const f of s.config.funding ? s.funding : []) {
    // No lane takes these, so they neither wait nor fail: resuming a collection brings its own back.
    if (f.stranded > 0) notice('info', `${chainName(f.chainId)}: ${num(f.stranded)} wallets are not checked while their collections are paused or removed, or they are further out than the hops followed.`);
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
