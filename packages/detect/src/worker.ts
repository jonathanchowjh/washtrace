import { statSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { ANALYZE_TIMEOUT_MS, analyzeInThread, type Analysed, type AnalysisRequest } from './analysis-thread.js';
import { Chain } from './chain.js';
import { Etherscan, WALLET_MS } from './etherscan.js';
import { ZERO } from './graph.js';
import { HUB, download, fetchManifest, hubUrl, partPath } from './hub.js';
import { CUSTODIANS, contractsFor, moneyFor, traders } from './marketplaces.js';
import { CHECKS_CHANNEL, type CheckKind, type CollectionRow, type FundingLane, type SettingSource, type StaleRow, type Store } from './store.js';
import {
  DOWNLOAD_NOTES, StoredDataError, entryFor, readManifest, readTrail, readTransfers, sha256File, storedDir, storedFile, storedKey, trailPath, writeManifest,
  type Manifest, type StoredEntry,
} from './stored.js';
import type { Flow, Transfer } from './types.js';

/** What the worker reads from the environment and the console's settings on every pass, so a changed setting needs no restart. */
export interface WorkerConfig {
  /** RPC URL per chain id. A collection on a chain with none reports so, and waits. */
  rpc: ReadonlyMap<number, string>;
  etherscanKey: string | null;
  etherscanPerSecond: number;
  etherscanUrl: string;
  /** Hops of money to follow out of a trader for SCC AU. 0 reads traders only, as the paper did. */
  followHops: number;
  /** The Hugging Face dataset (owner/name) stored data is downloaded from. */
  storedRepo: string;
  /** Where each set value came from, keyed by setting key. Never a secret's value: the store publishes this. */
  sources: Record<string, SettingSource>;
}

/**
 * A wallet that sent money to more wallets than this is not followed. Mule
 * wallets in a wash ring pay a handful; a wallet paying dozens is a business,
 * a bot or a person with a life, and following it reads half the chain.
 */
export const FOLLOW_FANOUT = 25;

export type Job = 'ingest' | 'fund' | 'analyze';

/**
 * How often each job runs. Ingest at a minute: finalized blocks advance
 * every 12 seconds, so a minute's wait costs nothing against the 13-minute
 * finality lag already accepted. Funding runs back to back because it is
 * the long pole: four Etherscan calls a wallet at four calls a second.
 */
export const EVERY: Readonly<Record<Job, number>> = { ingest: 60_000, fund: 5_000, analyze: 60_000 };

/** How often a running pass says it is alive, so a step that takes minutes is not mistaken for a stall. */
export const HEARTBEAT_MS = 30_000;

/** A pass stops starting new work after this long, so one collection's backfill cannot starve the rest. */
export const BUDGET_MS = 45_000;

/**
 * A pass still running after this long is stuck, however fresh its heartbeat:
 * the keep-alive beats while a step goes on, whether or not the step moves.
 * Analyze sits above the thread's own ceiling (ANALYZE_TIMEOUT_MS), so a
 * stopped analysis is said as its failure first. Ingest can load stored data,
 * which takes minutes; a money trail imports outside it (see
 * startTrailImport); a funding pass keeps to its budget.
 */
export const STUCK_MS: Readonly<Record<Job, number>> = { ingest: 30 * 60_000, fund: 10 * 60_000, analyze: ANALYZE_TIMEOUT_MS + 10 * 60_000 };

/**
 * Finalized blocks advance about five a minute and ingest reads every
 * minute, so a collection that is keeping up trails by a few blocks. A
 * hundred is twenty minutes: a backfill, or ingest falling behind.
 */
export const BEHIND_BLOCKS = 100;

/** A backfill is never given less than this, so a turn is long enough to read a span and not only to start one. */
export const MIN_SLICE_MS = 10_000;

/**
 * Who ingest serves this pass, and for how long. Collections at the head go
 * first and read to it: they cost a few spans and go stale if they wait. The
 * rest share the budget in equal slices, so a big backfill cannot take every
 * pass. With more backfills than slices of MIN_SLICE_MS, the last wait for
 * the next pass. Both go never served first and then the longest waiting: a
 * collection at the head the pass ran out of time for is first the next.
 */
export function ingestTurns(
  cs: readonly CollectionRow[],
  budgetMs: number,
): { keepUp: CollectionRow[]; backfill: { c: CollectionRow; sliceMs: number }[] } {
  const atHead = (c: CollectionRow) => c.startBlock !== null && c.cursorBlock !== null && c.headBlock !== null && c.headBlock - c.cursorBlock <= BEHIND_BLOCKS;
  const waiting = (a: CollectionRow, b: CollectionRow) => (a.servedAt ?? -1) - (b.servedAt ?? -1);
  const live = cs.filter((c) => c.pausedAt === null);
  const keepUp = live.filter(atHead).sort(waiting);
  const rest = live.filter((c) => !atHead(c)).sort(waiting);
  const n = Math.max(0, Math.min(rest.length, Math.floor(budgetMs / MIN_SLICE_MS)));
  return { keepUp, backfill: rest.slice(0, n).map((c) => ({ c, sliceMs: budgetMs / n })) };
}

/**
 * Whether a collection's stored data is still worth loading: it reaches past
 * what was read. That covers a fresh watch and one that started reading from
 * the deploy block before stored data came. Not one whose reading stopped
 * short of where the stored data starts: the cursor would jump the blocks in
 * between, and they would never be read.
 */
function reaches(c: CollectionRow, entry: StoredEntry): boolean {
  return c.cursorBlock === null || (c.cursorBlock >= entry.startBlock - 1 && c.cursorBlock < entry.throughBlock);
}

/**
 * Whether to load a collection's stored data before reading its chain: it is
 * watched, its stored data reaches past what was read, and no earlier load
 * failed in a way that would fail again now. A load the data failed is noted
 * on what it was about, and skipped while `key` (storedKey, now) is the
 * same; a load the store failed waits until its retry time. Meanwhile the
 * collection is read from the chain, if it has an RPC, and analysed on what
 * it has.
 */
export function needsRestore(c: CollectionRow, entry: StoredEntry | null, key: string | null, now = Date.now()): boolean {
  if (c.pausedAt !== null || entry === null || !reaches(c, entry)) return false;
  if (c.restoreRetryAt !== null && now < c.restoreRetryAt) return false;
  return c.restoreNoteKey === null || c.restoreNoteKey !== key;
}

/**
 * Whether to load a collection's money trail from disk: it is watched, the
 * manifest has a trail for it, the file on disk is that trail (`fileSha`, null
 * when there is no file, matches the manifest's), and it is not the trail
 * already loaded. A trail cut again has a new sha, so it loads again. No
 * request is needed: a trail on disk loads as stored data does.
 */
export function needsTrail(c: CollectionRow, e: StoredEntry | null, fileSha: string | null): 'import' | null {
  if (c.pausedAt !== null || e?.trail == null || fileSha === null) return null;
  return fileSha === e.trail.sha256 && c.trailImportedSha !== fileSha ? 'import' : null;
}

/** Why a money trail on disk was not loaded, in the words the console shows. The full error goes to the log. */
export const TRAIL_NOTES = {
  mismatch: 'Money trail on disk does not match the stored data, so it was not loaded.',
  unreadable: 'Money trail on disk could not be read, so it was not loaded.',
  failed: 'The money trail could not be loaded. Tried again later.',
} as const;

/**
 * The order to check wallets in: one from each lane in turn, so no collection
 * waits behind another's backlog. A wallet in two lanes is taken once; a lane
 * that meets one already taken moves on to its next. The lanes of the
 * prioritised collections (`priorityIds`, as many as are flagged) take every
 * other turn, sharing those turns among themselves in turn; when they all
 * run dry the rest go on. A lane that has run dry gives its turn to the next.
 */
export function interleave(lanes: readonly FundingLane[], priorityIds: ReadonlySet<number>): string[] {
  const priority = lanes.filter((l) => l.collectionId !== null && priorityIds.has(l.collectionId));
  const others = lanes.filter((l) => !priority.includes(l));
  const next = new Map<FundingLane, number>(lanes.map((l) => [l, 0]));
  const taken = new Set<string>();
  const order: string[] = [];
  const take = (lane: FundingLane): boolean => {
    let i = next.get(lane)!;
    while (i < lane.wallets.length && taken.has(lane.wallets[i]!)) i += 1;
    next.set(lane, i + 1);
    if (i >= lane.wallets.length) return false;
    taken.add(lane.wallets[i]!);
    order.push(lane.wallets[i]!);
    return true;
  };
  // One wallet from the first lane of `queue` that still has one; that lane goes to the back, a dry one goes.
  const turn = (queue: FundingLane[]): void => {
    while (queue.length > 0) {
      const lane = queue.shift()!;
      if (take(lane)) {
        queue.push(lane);
        return;
      }
    }
  };
  for (let n = 0; priority.length > 0 || others.length > 0; n++) {
    turn(priority.length > 0 && (n % 2 === 0 || others.length === 0) ? priority : others);
  }
  return order;
}

/** A collection is not analysed again sooner than this after its last analysis. */
export const ANALYZE_GAP_MS = 5 * 60_000;

/**
 * Which stale collection to analyse next, or null when none is due. Never
 * analysed comes first, by id. Then one whose rules were edited since its
 * last analysis started, oldest edit first: someone is waiting to see the
 * flags the new rules give. Otherwise a collection waits five minutes from
 * its last analysis, or twice that analysis's length if longer: one that
 * changes every minute and takes seventeen to analyse would otherwise keep
 * the analysis thread busy for it alone. Of those due, the one waiting longest goes.
 */
export function nextAnalysis(stale: readonly StaleRow[], now: number): StaleRow | null {
  const fresh = stale.filter((s) => s.ranAt === null).sort((a, b) => a.id - b.id);
  if (fresh.length > 0) return fresh[0]!;
  // Against when the last run started, not when it was saved: it read the rules it started with.
  const edited = stale.filter((s) => s.rulesAt !== null && s.rulesAt > s.ranAt! - (s.tookMs ?? 0)).sort((a, b) => a.rulesAt! - b.rulesAt!);
  if (edited.length > 0) return edited[0]!;
  const due = stale.filter((s) => now - s.ranAt! >= Math.max(ANALYZE_GAP_MS, 2 * (s.tookMs ?? 0)));
  return due.sort((a, b) => a.ranAt! - b.ranAt!)[0] ?? null;
}

/**
 * How long a load of stored data the store failed waits before it is tried
 * again, as Store.restore times it: five minutes, doubling with each failure
 * in a row, up to an hour. For the worker's own copy of that wait (restoreFailed).
 */
function retryMs(failures: number): number {
  return Math.min(60 * 60_000, 5 * 60_000 * 2 ** (failures - 1));
}

/** Each job's advisory lock key. Only one replica runs a job at a time. */
const LOCK: Readonly<Record<Job, number>> = { ingest: 1, fund: 2, analyze: 3 };

/** The checks' advisory lock key: every replica hears a request, and one runs it. */
const CHECKS_LOCK = 4;

/** The downloads' advisory lock key: one download at a time across every replica, so two never write the same part file. */
const DOWNLOAD_JOB = 5;

/** The trail imports' advisory lock key: one import at a time across every replica, so two never load the same trail at once. */
const TRAIL_JOB = 6;

/**
 * A trail import that committed no batch for this long is given up, and
 * fails. A batch is seconds; this is long enough for a whole file's sha256
 * to be checked before the first. Looked at every STALL_CHECK_MS.
 */
const TRAIL_STALL_MS = 15 * 60_000;

/**
 * How often the Hub is asked for its manifest. A publish is rare, and a
 * newly watched collection asks at once (see askHub).
 */
const HUB_EVERY_MS = 60 * 60_000;

/** An ask of the Hub is given this long: it runs in the ingest pass, under its lock, and a hung one would hold the pass until it is taken for stuck. */
const HUB_TIMEOUT_MS = 30_000;

/** A download whose part file has not grown for this long is given up, and fails. Looked at every STALL_CHECK_MS. */
const STALL_MS = 2 * 60_000;
const STALL_CHECK_MS = 10_000;

/**
 * How often a download looks that the connection holding its lock is alive.
 * A session that died without a word frees the lock, and another replica
 * could start the same part file.
 */
const LOCK_CHECK_MS = 60_000;

/**
 * Why a download or a trail import was stopped: its collection paused or
 * deleted, its trail cut again, or the worker stopping; transfers that go
 * first; a stall; or the connection holding its lock lost. Only the last two
 * are failures.
 */
type Halt = 'stopped' | 'preempted' | 'stalled' | 'lost';

/** A download to start: whose, and which of its files. */
interface Wanted { c: CollectionRow; entry: StoredEntry; file: 'transfers' | 'trail' }

/** A trail import to start: whose, the file on disk, and the sha256 and stat it was found with. */
interface TrailDue { c: CollectionRow; entry: StoredEntry; path: string; file: { key: string; sha: string } }

/**
 * A check asked for longer ago than this is finished as expired, not run.
 * The page that asked stopped polling after 20 seconds, and a URL tested now
 * may no longer be the one it asked about.
 */
export const CHECK_EXPIRY_MS = 5 * 60_000;

/** The listener's wait before connecting again grows by this each failure in a row, up to a minute. */
const RELISTEN_MS = 5_000;
const RELISTEN_MAX_MS = 60_000;

/**
 * How often the checks run with no request heard, and how long a check may
 * wait before the listener is taken for deaf. A connection a NAT dropped can
 * go quiet with no error; a notification arrives in milliseconds.
 */
const SWEEP_MS = 30_000;
const DEAF_MS = 10_000;

/**
 * The polling half of the service. Three jobs on intervals: ingest reads new
 * finalized transfers per collection, fund reads the money of each wallet
 * those transfers named, and analyze reruns the paper's methods over any
 * collection that changed.
 *
 * A pass that is due while the last is still running is skipped, not queued.
 * Across replicas, each pass takes its job's advisory lock without waiting,
 * so N replicas of one image do one worker's work.
 *
 * A class because the store, the config, the chain clients and the timers
 * are shared by every pass.
 */
export class Worker {
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly running = new Set<Job>();
  private readonly chains = new Map<string, Chain>();
  private etherscan: Etherscan | null = null;
  private etherscanSettings = '';
  /** The last error logged per collection, so an outage is one line and not one a minute. */
  private readonly logged = new Map<number, string>();
  /** What each running job is doing now, so the keep-alive can say it again while a long step goes on. */
  private readonly current = new Map<Job, { doing: string | null; subjectId: number | null }>();
  /** The last heartbeat error logged, so an outage is one line and not one every 30 seconds. */
  private beatFailed = '';
  /** The console's settings as last read, kept when a read fails so a store hiccup changes no setting. */
  private settings: ReadonlyMap<string, string> = new Map();
  /**
   * Every secret of every config built in this process (see resolved): an
   * old provider's error can arrive after its URL or key is replaced, and
   * must lose that old secret too. Kept for the process's life, so a replaced
   * RPC's host labels stay hidden too: over-redaction is the accepted cost.
   */
  private readonly seen = new Set<string>();
  /** The last settings read and sources report errors logged, so an outage is one line and not one a pass. */
  private readFailed = '';
  private reportFailed = '';
  /** The connection that hears check requests, while listening. It holds no pool slot and is never shared. */
  private listener: pg.Client | null = null;
  private listening = false;
  private relisten: ReturnType<typeof setTimeout> | null = null;
  private listenFailures = 0;
  /** Runs the checks every SWEEP_MS while listening, for a request whose notification was lost. */
  private sweep: ReturnType<typeof setInterval> | null = null;
  /** The checks run in flight, and whether a request came during it: runs never overlap, and none is missed. */
  private checking: Promise<void> | null = null;
  private checkAgain = false;
  private checksFailed = '';
  /** Whether the last checks run found another replica holding them: a check left pending is then theirs, not unheard. */
  private checksSkipped = false;
  /** The last manifest read error logged, so a broken manifest is one line and not one a pass. */
  private manifestFailed = '';
  /**
   * Each stored file's sha256, by path, kept while its modified time and size
   * stay the same: a file can be gigabytes, and is looked at every pass.
   */
  private readonly shas = new Map<string, { file: string; sha: string }>();
  /** Trail files that could not be read, by path and the same key: not tried again until the file changes. */
  private readonly trailsFailed = new Map<string, string>();
  /**
   * Loads of stored data the store failed, by collection, timed as the store
   * times them: kept here too, since the write that records a back-off can
   * fail with the load (a full disk), and the next pass would load it all
   * again.
   */
  private readonly restoreFailed = new Map<number, { failures: number; retryAt: number }>();
  /**
   * When the Hub was last asked for its manifest, whatever it answered, and
   * which repo. In memory: a restart asks at once. `hubFailing` is that the
   * last ask failed, so an outage is one log line and not one an hour.
   */
  private hubAskedAt = -Infinity;
  private hubRepo = '';
  private hubFailing = false;
  /** The download running in this process, outside every pass (see startDownload). One at a time. */
  private downloading: { id: number; file: 'transfers' | 'trail'; abort: AbortController; done: Promise<void> } | null = null;
  /** Downloads that failed, by collection, timed as the store times them: kept here too, as restoreFailed is, since the write that records the back-off can fail with the download (a full disk). */
  private readonly downloadsFailed = new Map<number, { failures: number; retryAt: number }>();
  /** The trail import running in this process, outside every pass (see startTrailImport). One at a time. */
  private importing: { id: number; sha: string; abort: AbortController; done: Promise<void> } | null = null;
  /** Trail imports the store failed, by collection, timed as a failed load is. In memory only: the note says it failed, and a restart tries again. */
  private readonly trailsBackoff = new Map<number, { failures: number; retryAt: number }>();

  /**
   * `storeUrl` is the store's own, for the analysis thread to open a
   * connection of its own with. It carries the password: never logged.
   * `config` merges the environment with the console's settings it is given.
   * `stored` is the stored-data folder, which holds manifest.json.
   */
  constructor(
    private readonly store: Store,
    private readonly config: (settings: ReadonlyMap<string, string>) => WorkerConfig,
    private readonly storeUrl: string,
    private readonly stored: string = storedDir(process.env),
  ) {}

  start(): void {
    if (this.timers.length > 0) return;
    for (const job of ['ingest', 'fund', 'analyze'] as const) {
      const timer = setInterval(() => { void this.run(job); }, EVERY[job]);
      timer.unref?.();
      this.timers.push(timer);
      void this.run(job);
    }
  }

  /**
   * Stops the timers, the listener, any download (its part is kept, for the
   * next worker to resume) and any trail import (loading it again is safe),
   * so nothing of the worker's keeps the process alive.
   */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.downloading?.abort.abort('stopped' satisfies Halt);
    this.importing?.abort.abort('stopped' satisfies Halt);
    this.listening = false;
    if (this.relisten !== null) clearTimeout(this.relisten);
    this.relisten = null;
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
    const listener = this.listener;
    this.listener = null;
    listener?.end().catch(() => {});
  }

  /** The jobs with a pass in flight in this process. */
  get busy(): Job[] {
    return [...this.running];
  }

  /**
   * Resolves once no pass, check run, download or trail import is in
   * flight, or after `ms`. For shutdown: a pass stopped mid-span would roll
   * its transaction back and redo the span, which is safe but wasted, so it
   * is given the time to commit; a stopped download or import, the time to
   * clear its progress and let its lock go.
   */
  async drain(ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    const busy = () => this.running.size > 0 || this.checking !== null || this.downloading !== null || this.importing !== null;
    while (busy() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }

  /** One pass of `job`, unless one is in flight here or in another replica. Never rejects: a timer has no caller. */
  async run(job: Job): Promise<'ran' | 'skipped'> {
    if (this.running.has(job)) return 'skipped';
    this.running.add(job);
    const started = Date.now();
    const alive = setInterval(() => {
      const now = this.current.get(job);
      if (now !== undefined) void this.beat(job, now.doing, now.subjectId);
    }, HEARTBEAT_MS);
    alive.unref?.();
    try {
      const outcome = await this.store.locked(LOCK[job], false, async () => {
        await this.loadSettings();
        // passStarted is the first beat; with `current` set the keep-alive beats on, though the job's first call is slow.
        await this.store.passStarted(job);
        this.current.set(job, { doing: null, subjectId: null });
        try {
          const detail = await this[job]();
          await this.store.passFinished(job, Date.now() - started, 'ok', detail);
        } catch (err) {
          await this.store.passFinished(job, Date.now() - started, 'failed', this.scrubbed(err));
          throw err;
        }
      });
      return outcome === 'skipped' ? 'skipped' : 'ran';
    } catch (err) {
      console.error('[washtrace] %s pass failed: %s', job, this.scrubbed(err));
      return 'ran';
    } finally {
      clearInterval(alive);
      this.current.delete(job);
      this.running.delete(job);
    }
  }

  /**
   * Read each collection's next spans of finalized transfers. Collections at
   * the head first, then each backfill within its own slice of the budget.
   * Before any of that, and outside the budget, load the stored data of any
   * collection it reaches further for: it needs no RPC, and is the head
   * start the chain is then read on from. Stored data not on disk yet is
   * downloaded in the background, and a collection waiting for its
   * transfers is not read meanwhile (see downloads). A money trail on disk
   * imports in the background too, and holds nothing (see trails).
   */
  async ingest(): Promise<string> {
    const { rpc, storedRepo } = this.resolved();
    let collections = await this.store.collections();
    await this.askHub(collections, storedRepo);
    const manifest = await this.storedManifest();
    const restored = manifest === null ? 0 : await this.restore(collections, manifest);
    // Read again: a load moved the cursors, and serving the old ones would read what it loaded.
    if (restored > 0) collections = await this.store.collections();
    // After every load of stored data, so a trail waits for its collection's transfers.
    if (manifest !== null) await this.trails(collections, manifest);
    // After the loads, so a file just loaded is not downloaded.
    const held = manifest === null ? new Set<number>() : await this.downloads(collections, manifest, storedRepo);
    // A chain with no RPC has nothing to read, so its collections are settled here and hold no slice of the budget.
    const readable: CollectionRow[] = [];
    for (const c of collections) {
      if (held.has(c.id)) {
        // Its stored data is on the way: read from where that stops, not from here. Not a fault meanwhile: clears a "No RPC" left from before.
        this.logged.delete(c.id);
        if (c.error !== null) await this.store.setError(c.id, null);
        continue;
      }
      if (rpc.has(c.chainId)) readable.push(c);
      else if (c.pausedAt !== null) continue;
      else if (c.storedThroughTime !== null) {
        // Stored data and no RPC is a state, not a fault: the console says where the data stops. Clears the "No RPC" left from before it loaded.
        this.logged.delete(c.id);
        if (c.error !== null) await this.store.setError(c.id, null);
      } else {
        // The console offers an RPC field for Ethereum only (FIELDS in the web app); other chains are set in the environment.
        const where = c.chainId === 1 ? 'Set it in Settings, or WASHTRACE_RPC_1 for the worker.' : `Set WASHTRACE_RPC_${c.chainId} for the worker.`;
        await this.fail(c.id, `No RPC is configured for chain ${c.chainId}. ${where}`);
      }
    }
    const passEnd = Date.now() + BUDGET_MS;
    const total = { spans: 0, read: 0, blocks: 0 };
    const serve = async (c: CollectionRow, deadline: number) => {
      if (Date.now() >= deadline) return;
      const started = Date.now();
      const url = rpc.get(c.chainId)!;
      const got = { spans: 0, read: 0, blocks: 0 };
      try {
        await this.readSpans(c, this.chain(c.chainId, url), deadline, got);
        this.logged.delete(c.id);
      } catch (err) {
        await this.fail(c.id, this.scrubbed(err));
      } finally {
        // Even a collection that failed was given a turn: it must not stay the oldest served.
        total.spans += got.spans;
        total.read += got.read;
        await this.store.served(c.id, got.blocks, Date.now() - started);
      }
    };
    const { keepUp, backfill } = ingestTurns(readable, BUDGET_MS);
    for (const c of keepUp) await serve(c, passEnd);
    // Slices come from what keep-up left, and no turn runs past the pass.
    const rest = ingestTurns(backfill.map((b) => b.c), passEnd - Date.now()).backfill;
    for (const { c, sliceMs } of rest) await serve(c, Math.min(Date.now() + sliceMs, passEnd));
    const loaded = restored > 0 ? `stored data loaded for ${restored} collections; ` : '';
    return `${loaded}${total.read} transfers in ${total.spans} spans across ${collections.length} collections`;
  }

  /**
   * The stored-data manifest, or null when it cannot be read: then no
   * collection has stored data, and that is said once. A Hub that said it has
   * none left an empty manifest on disk (askHub), which reads as empty.
   */
  private async storedManifest(): Promise<Manifest | null> {
    try {
      const manifest = await this.manifest();
      this.manifestFailed = '';
      return manifest;
    } catch (err) {
      const message = this.scrubbed(err);
      if (this.manifestFailed !== message) console.warn('[washtrace] stored data not used: %s', message);
      this.manifestFailed = message;
      return null;
    }
  }

  /**
   * Ask the Hub for its manifest and keep it on disk, where every step reads
   * it: once an hour, at once for a newly watched collection or another repo,
   * and next pass after a download that did not match it. A failed ask
   * counts, so a Hub that is down is asked hourly too; meanwhile the manifest
   * on disk, if any, is used, and the outage is one log line. A Hub that says
   * the repo has none means no stored data: the manifest on disk is replaced by
   * an empty one, so no step (and not the console, which reads the same file)
   * goes on quoting stored data that will not be downloaded. Only ingest asks: everything else
   * reads what is on disk.
   */
  private async askHub(collections: readonly CollectionRow[], repo: string): Promise<void> {
    const now = Date.now();
    const watched = collections.some((c) => c.pausedAt === null && c.addedAt > this.hubAskedAt);
    if (now - this.hubAskedAt <= HUB_EVERY_MS && !watched && repo === this.hubRepo) return;
    this.hubAskedAt = now;
    this.hubRepo = repo;
    try {
      const manifest = await this.fetchHubManifest(repo);
      await mkdir(this.stored, { recursive: true });
      await writeManifest(join(this.stored, 'manifest.json'), manifest ?? { version: 2, collections: [] });
      this.hubFailing = false;
    } catch (err) {
      if (!this.hubFailing) console.warn('[washtrace] stored data not fetched from Hugging Face: %s. The manifest on disk is used, if there is one.', this.scrubbed(err));
      this.hubFailing = true;
    }
  }

  /**
   * The Hub's manifest of `repo`, null when it has none. The Hub answers an anonymous read of a dataset
   * that does not exist, or is private, with 401: for the worker, which sends no token, that is no public
   * dataset, so no stored data. Tests override it on the instance.
   */
  async fetchHubManifest(repo: string): Promise<Manifest | null> {
    try {
      return await fetchManifest(repo, HUB, AbortSignal.timeout(HUB_TIMEOUT_MS));
    } catch (err) {
      if ((err as { status?: number }).status === 401) return null;
      throw err;
    }
  }

  /**
   * Load the stored data of every collection that needs it (see
   * needsRestore), one at a time, and say how many loaded. This runs in
   * the ingest pass, under its lock, so no span is read into a collection
   * while it loads. A load that fails has said why on the collection, and
   * its chain is read as if there were no stored data. A note about stored
   * data the collection no longer reaches for says nothing true, and goes.
   */
  private async restore(collections: readonly CollectionRow[], manifest: Manifest): Promise<number> {
    let loaded = 0;
    for (const c of collections) {
      if (c.pausedAt !== null) continue;
      const entry = entryFor(manifest, c.chainId, c.address);
      if (entry === null || !reaches(c, entry)) {
        if (c.restoreNote !== null) {
          await this.store.clearRestoreNote(c.id).catch((err) => console.error('[washtrace] collection %d: stored data note not cleared: %s', c.id, this.scrubbed(err)));
        }
        continue;
      }
      // Its trail is importing: that import stops this pass (see trails), and the load goes next pass, never beside it.
      if (this.importing?.id === c.id) continue;
      const noted = await this.noteKey(c, entry);
      if (!this.restoreDue(c, entry, noted, Date.now())) continue;
      // Not on disk yet, and the Hub has it: it is downloaded first (see downloads). Loaded now, it would only be noted missing.
      if (await this.fetchable(manifest, join(this.stored, entry.transfers.file), entry.transfers.sha256)) continue;
      // Taken before the load, so a file replaced while it runs is tried again.
      const key = noted ?? await this.restoreKey(entry);
      await this.beat('ingest', `Loading stored data for ${c.name ?? entry.name}`, c.id);
      try {
        await this.store.restore(c.id, c.chainId, entry, this.storedTransfers(entry), key);
        this.restoreFailed.delete(c.id);
        loaded += 1;
      } catch (err) {
        console.error('[washtrace] collection %d: stored data not loaded: %s', c.id, this.scrubbed(err));
        // Bad stored data is keyed on the file, not timed.
        if (err instanceof StoredDataError) this.restoreFailed.delete(c.id);
        else {
          const failures = (this.restoreFailed.get(c.id)?.failures ?? 0) + 1;
          this.restoreFailed.set(c.id, { failures, retryAt: Date.now() + retryMs(failures) });
        }
      }
    }
    return loaded;
  }

  /** Whether to load a collection's stored data now: needsRestore, and no back-off held here (restoreFailed) still running. */
  private restoreDue(c: CollectionRow, entry: StoredEntry | null, key: string | null, now: number): boolean {
    return (this.restoreFailed.get(c.id)?.retryAt ?? 0) <= now && needsRestore(c, entry, key, now);
  }

  /** What a collection's stored data is now (storedKey), for one whose last load the data failed; else null, and nothing is read. */
  private async noteKey(c: CollectionRow, entry: StoredEntry | null): Promise<string | null> {
    return c.restoreNoteKey === null || entry === null ? null : this.restoreKey(entry);
  }

  /** What a collection's stored data is now: the manifest's sha256 and its file's stat. Tests override it on the instance. */
  restoreKey(entry: StoredEntry): Promise<string> {
    return storedKey(join(this.stored, entry.transfers.file), entry.transfers.sha256);
  }

  /**
   * Start the import of the next money trail on disk that is due, if none
   * runs in this process, and stop the one running once it is no longer
   * wanted. A trail is due when needsTrail says so, its collection's
   * transfers are not still to load (needsRestore, keyed as restore keys
   * it), and no failure of its own is waiting out its back-off. A file that
   * is not the manifest's trail, or cannot be read, imports nothing and says
   * so on the collection, and is not tried again until it changes. The pass
   * never waits for an import: one of millions of flows takes an hour (see
   * startTrailImport). Meanwhile its collection is read and analysed as any.
   */
  private async trails(collections: readonly CollectionRow[], manifest: Manifest): Promise<void> {
    const now = Date.now();
    const running = this.importing;
    if (running !== null) {
      const c = collections.find((x) => x.id === running.id);
      const entry = c === undefined ? null : entryFor(manifest, c.chainId, c.address);
      // Paused or deleted, cut again, or its transfers to load again: stopped, not failed. Loading it again later is safe.
      if (c === undefined || c.pausedAt !== null || entry?.trail?.sha256 !== running.sha || needsRestore(c, entry, await this.noteKey(c, entry), now)) {
        running.abort.abort('stopped' satisfies Halt);
      }
    }
    let next: TrailDue | null = null;
    for (const c of collections) {
      const entry = entryFor(manifest, c.chainId, c.address);
      if (c.pausedAt !== null) continue;
      if (entry?.trail == null) {
        // No trail in the manifest any more: a note about one says nothing true.
        if (c.trailNote !== null) await this.noteTrail(c.id, null);
        continue;
      }
      const path = trailPath(this.stored, entry);
      let file: { key: string; sha: string } | null;
      try {
        file = await this.shaOnDisk(path);
      } catch (err) {
        console.error('[washtrace] collection %d: money trail not read: %s', c.id, this.scrubbed(err));
        continue;
      }
      // A note about a file that is gone, or that now matches, says nothing true: cleared. A file that could not be read keeps its note.
      if (c.trailNote !== null && (file === null || (file.sha === entry.trail.sha256 && c.trailNote === TRAIL_NOTES.mismatch))) {
        await this.noteTrail(c.id, null);
      }
      if (file !== null && file.sha !== entry.trail.sha256) {
        if (c.trailNote !== TRAIL_NOTES.mismatch) {
          console.warn('[washtrace] collection %d: %s does not match the manifest (sha256 %s, expected %s)', c.id, path, file.sha, entry.trail.sha256);
          await this.noteTrail(c.id, TRAIL_NOTES.mismatch);
        }
        continue;
      }
      if (needsTrail(c, entry, file?.sha ?? null) !== 'import' || this.trailsFailed.get(path) === file!.key) continue;
      // One at a time; the first due goes.
      if (this.importing !== null || next !== null) continue;
      if (now < (this.trailsBackoff.get(c.id)?.retryAt ?? 0)) continue;
      if (needsRestore(c, entry, await this.noteKey(c, entry), now)) continue;
      next = { c, entry, path, file: file! };
    }
    if (next !== null) this.startTrailImport(next);
  }

  /**
   * Run one trail import in the background, outside every pass: an import of
   * an hour holds no job lock and writes no pass or heartbeat, so it is never
   * taken for a stuck ingest. It holds the trail lock for its whole length
   * instead, so two replicas never import at once: one that finds it held
   * starts nothing, the other replica is importing. With the download's,
   * that is at most two of the pool's ten clients (Store.connect) held for
   * hours; the passes and the checks share the rest. Never rejects: it has
   * no caller.
   */
  private startTrailImport(due: TrailDue): void {
    const abort = new AbortController();
    const done = this.store.locked(TRAIL_JOB, false, (client) => this.importTrail(client, due, abort))
      .then(() => {}, (err) => console.error('[washtrace] collection %d: money trail not loaded: %s', due.c.id, this.scrubbed(err)))
      .finally(() => { if (this.importing?.abort === abort) this.importing = null; });
    this.importing = { id: due.c.id, sha: due.file.sha, abort, done };
  }

  /**
   * One trail import, said on the collection as it goes: at most once per
   * 1%, capped at 99% (the manifest's count of rows is a guide), fail-soft,
   * and a write that finds the collection paused or deleted stops it, as the
   * next pass would. The row is read again first, under the lock: another
   * replica, or an earlier pass, may have imported it since the pass read
   * it. No batch committed for TRAIL_STALL_MS stops it too, as a failure. A
   * bad file is noted on the file, as before; any other failure says it
   * failed and waits its back-off. One stopped is no failure: only its
   * progress goes. One that goes through clears its progress and its note in
   * its last statement (Store.importTrail).
   *
   * `client` holds the trail lock, as fetchStored's holds the download's:
   * lost, or found dead by a look once a minute, it fails the import, since
   * the lock went with it.
   */
  private async importTrail(client: pg.PoolClient, { c, entry, path, file }: TrailDue, abort: AbortController): Promise<void> {
    const row = await this.store.collection(c.chainId, c.address);
    if (row === null || row.pausedAt !== null || row.trailImportedSha === file.sha) return;
    // A retry: "could not be loaded" must not show beside the progress. A note about the file is not this one's to clear.
    if (row.trailNote === TRAIL_NOTES.failed) await this.noteTrail(c.id, null);
    let lost: unknown = null;
    const lose = (err: unknown) => {
      lost ??= err;
      abort.abort('lost' satisfies Halt);
    };
    client.on('error', lose);
    const alive = setInterval(() => { client.query('SELECT 1').catch(lose); }, LOCK_CHECK_MS);
    alive.unref?.();
    // In order, so a late write never overwrites the clear at the end.
    let writes = Promise.resolve();
    let writeFailed = false;
    const write = (share: number) => {
      writes = writes.then(async () => {
        try {
          if (!(await this.store.setTrailProgress(c.id, share))) abort.abort('stopped' satisfies Halt);
        } catch (err) {
          if (!writeFailed) console.warn('[washtrace] collection %d: money trail progress not written: %s', c.id, this.scrubbed(err));
          writeFailed = true;
        }
      });
    };
    // 0 while the file's whole sha256 is checked, before the first batch.
    let percent = 0;
    write(0);
    const rows = Math.max(1, entry.trail!.rows);
    const onFlows = (flows: number) => {
      const share = Math.min(0.99, flows / rows);
      if (Math.floor(share * 100) <= percent) return;
      percent = Math.floor(share * 100);
      write(share);
    };
    let movedAt = Date.now();
    const watch = setInterval(() => { if (Date.now() - movedAt >= TRAIL_STALL_MS) abort.abort('stalled' satisfies Halt); }, STALL_CHECK_MS);
    watch.unref?.();
    const read = () => this.storedTrail(path, file.sha)[Symbol.asyncIterator]();
    // The store asks for a batch once the one before it committed: that is the import moving. Each pass ends
    // only once the progress written so far has landed, so none lands after the last statement clears it.
    // A read is raced against the abort, so one that never returns is still given up; no statement runs
    // during a read, so none is left running under the lock. A statement waiting on a lock ends by
    // its own timeout (Store.trailLockTimeout).
    const open = () => (async function* () {
      const batches = read();
      try {
        for (;;) {
          const next = await orAborted(batches.next(), abort.signal);
          if (next.done) return;
          yield next.value;
          movedAt = Date.now();
        }
      } finally {
        await writes;
      }
    })();
    const logged = (what: string) => (err: unknown) => console.error('[washtrace] collection %d: %s: %s', c.id, what, this.scrubbed(err));
    try {
      const { wallets, flows } = await this.store.importTrail(c.id, c.chainId, file.sha, open, { onFlows, signal: abort.signal });
      this.trailsBackoff.delete(c.id);
      console.info('[washtrace] collection %d: money trail loaded, %d wallets and %d flows', c.id, wallets, flows);
    } catch (err) {
      await writes;
      await this.store.setTrailProgress(c.id, null).catch(logged('money trail progress not cleared'));
      const halt: Halt | null = abort.signal.aborted ? abort.signal.reason : null;
      if (halt === 'stopped') return;
      if (halt === null && err instanceof StoredDataError) {
        // Bad stored data is keyed on the file, not timed.
        console.error('[washtrace] collection %d: money trail not loaded: %s', c.id, this.scrubbed(err));
        this.trailsBackoff.delete(c.id);
        this.trailsFailed.set(path, file.key);
        await this.noteTrail(c.id, err.kind === 'mismatch' ? TRAIL_NOTES.mismatch : TRAIL_NOTES.unreadable);
        return;
      }
      const why = halt === 'stalled' ? `nothing was written for ${TRAIL_STALL_MS / 60_000} minutes`
        : halt === 'lost' ? `the connection holding its lock was lost (${this.scrubbed(lost)})` : this.scrubbed(err);
      console.error('[washtrace] collection %d: money trail not loaded: %s', c.id, why);
      const failures = (this.trailsBackoff.get(c.id)?.failures ?? 0) + 1;
      this.trailsBackoff.set(c.id, { failures, retryAt: Date.now() + retryMs(failures) });
      await this.noteTrail(c.id, TRAIL_NOTES.failed);
    } finally {
      clearInterval(watch);
      clearInterval(alive);
      client.removeListener('error', lose);
    }
  }

  /**
   * Forget the progress of a trail import that was running when the last
   * worker died: the console says it imports for ever otherwise. Only while
   * no replica imports: it takes the trail lock, and one held means another
   * replica is importing, and its progress is true. For start-up.
   */
  async clearStaleTrailProgress(): Promise<void> {
    await this.store.locked(TRAIL_JOB, false, () => this.store.clearTrailProgress());
  }

  /** Say on the collection why its trail was not loaded, or with null that nothing is wrong. Fail-soft: the rest of the pass goes on. */
  private async noteTrail(id: number, note: string | null): Promise<void> {
    await this.store.setTrailNote(id, note).catch((err) => console.error('[washtrace] collection %d: money trail note not written: %s', id, this.scrubbed(err)));
  }

  /**
   * The sha256 of the stored file at `path`, and the modified time and size
   * it was taken at; null when there is no file. Hashed again only once the
   * file changes.
   */
  private async shaOnDisk(path: string): Promise<{ key: string; sha: string } | null> {
    let key: string;
    try {
      const s = await stat(path);
      key = `${s.mtimeMs} ${s.size}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const known = this.shas.get(path);
    if (known?.file === key) return { key, sha: known.sha };
    const sha = await this.fileSha(path);
    this.shas.set(path, { file: key, sha });
    return { key, sha };
  }

  /** A file's sha256. Tests override it on the instance. */
  fileSha(path: string): Promise<string> {
    return sha256File(path);
  }

  /** A money trail, checked against `sha256` first, as each read of it is. Tests override it on the instance. */
  storedTrail(path: string, sha256: string): AsyncIterable<{ checked: string[]; flows: Flow[] }> {
    return readTrail(path, sha256);
  }

  /** The stored-data manifest; empty when there is none. Tests override it on the instance. */
  manifest(): Promise<Manifest> {
    return readManifest(join(this.stored, 'manifest.json'));
  }

  /** A collection's stored transfers, checked against the manifest's sha256 first. Tests override it on the instance. */
  storedTransfers(entry: StoredEntry): AsyncIterable<Transfer[]> {
    return readTransfers(join(this.stored, entry.transfers.file), entry.transfers.sha256);
  }

  /**
   * Whether the stored file at `path` is to come from the Hub: the manifest
   * names the commit to fetch it at, and the file on disk is missing or not
   * the one it names. A manifest cut here names none: its files are only
   * ever on disk. A file that cannot be read is left to the step that reads
   * it, which says so.
   */
  private async fetchable(manifest: Manifest, path: string, sha256: string): Promise<boolean> {
    if (manifest.revision === undefined) return false;
    const file = await this.shaOnDisk(path).catch(() => undefined);
    return file === null || (file !== undefined && file.sha !== sha256);
  }

  /**
   * Start the next download of stored data, if one is due and none runs in
   * this process, and say whose chain reading waits for theirs. A file is
   * wanted while the step that loads it would load it and it is not on disk
   * (see fetchable): the transfers while needsRestore, the trail while it is
   * not the one loaded. One at a time, every collection's transfers before
   * any trail, since only transfers hold the chain reading back: a trail
   * download running when transfers come due is stopped, its part kept, and
   * the transfers start next pass. A failed download waits out its back-off
   * and holds nothing meanwhile: the collection is served as it would be
   * with no stored data. A paused or deleted collection's download is stopped.
   */
  private async downloads(collections: readonly CollectionRow[], manifest: Manifest, repo: string): Promise<Set<number>> {
    const running = this.downloading;
    if (running !== null) {
      const c = collections.find((x) => x.id === running.id);
      if (c === undefined || c.pausedAt !== null) running.abort.abort('stopped' satisfies Halt);
    }
    const held = new Set<number>();
    const revision = manifest.revision;
    let started: number | null = null;
    if (revision !== undefined) {
      const now = Date.now();
      let transfers: Wanted | null = null;
      let trail: Wanted | null = null;
      for (const c of collections) {
        const entry = entryFor(manifest, c.chainId, c.address);
        if (c.pausedAt !== null || entry === null) continue;
        const due = !this.downloadWaits(c, now);
        // No key: a note on an earlier load is about the file as it stood, which the download replaces.
        if (needsRestore(c, entry, null, now) && await this.fetchable(manifest, join(this.stored, entry.transfers.file), entry.transfers.sha256)) {
          // Downloading in some replica (the row says so to all of them), or about to here.
          if (due || c.downloadFile === 'transfers') held.add(c.id);
          if (due) transfers ??= { c, entry, file: 'transfers' };
        } else if (due && trail === null && entry.trail !== null && c.trailImportedSha !== entry.trail.sha256 && this.importing?.id !== c.id
          // Not over the file an import is still reading: it stops this pass (see trails), and the download starts the next.
          && await this.fetchable(manifest, trailPath(this.stored, entry), entry.trail.sha256)) {
          trail = { c, entry, file: 'trail' };
        }
      }
      if (running !== null) {
        if (running.file === 'trail' && transfers !== null) running.abort.abort('preempted' satisfies Halt);
      } else {
        const next = transfers ?? trail;
        if (next !== null) {
          started = next.c.id;
          this.startDownload(next, repo, revision);
        }
      }
    }
    await this.tidyDownloads(collections, manifest, held, started);
    return held;
  }

  /**
   * Make what a collection says of its download true again. A failure note
   * (and its back-off) of a download no longer wanted, because the Hub has no
   * stored data, the collection is read past it, or its entry is gone, says
   * nothing true, and goes, as restore does for a load. A collection held for
   * a transfers download that has not started is marked as waiting: its
   * file, no progress. A mark on one no longer held is cleared. Fail-soft: it
   * is said again next pass.
   */
  private async tidyDownloads(collections: readonly CollectionRow[], manifest: Manifest, held: ReadonlySet<number>, started: number | null): Promise<void> {
    const logged = (id: number, what: string) => (err: unknown) => console.error('[washtrace] collection %d: %s: %s', id, what, this.scrubbed(err));
    for (const c of collections) {
      const idle = c.downloadFile === null && this.downloading?.id !== c.id;
      if (c.downloadNote !== null && idle && c.pausedAt === null && !(await this.wantsDownload(c, manifest))) {
        this.downloadsFailed.delete(c.id);
        await this.store.clearDownloadNote(c.id, true).catch(logged(c.id, 'download note not cleared'));
      }
      if (held.has(c.id)) {
        if (idle && c.id !== started) await this.store.setDownload(c.id, 'transfers', null).catch(logged(c.id, 'waiting download not noted'));
      } else if (c.downloadFile === 'transfers' && c.downloadProgress === null && this.downloading?.id !== c.id) {
        await this.store.setDownload(c.id, null, null).catch(logged(c.id, 'waiting download not cleared'));
      }
    }
  }

  /** Whether either of a collection's stored files is to be downloaded, whether or not its turn has come (see downloads). */
  private async wantsDownload(c: CollectionRow, manifest: Manifest): Promise<boolean> {
    const entry = entryFor(manifest, c.chainId, c.address);
    if (entry === null) return false;
    if (needsRestore(c, entry, null, Date.now()) && await this.fetchable(manifest, join(this.stored, entry.transfers.file), entry.transfers.sha256)) return true;
    return entry.trail !== null && c.trailImportedSha !== entry.trail.sha256 && await this.fetchable(manifest, trailPath(this.stored, entry), entry.trail.sha256);
  }

  /** Whether a collection's last download failed and is still waiting out its back-off: the store's, or the one held here. */
  private downloadWaits(c: CollectionRow, now: number): boolean {
    return now < (c.downloadRetryAt ?? 0) || now < (this.downloadsFailed.get(c.id)?.retryAt ?? 0);
  }

  /**
   * Run one download in the background, outside every pass: a download of
   * hours holds no job lock and writes no pass, so it is never taken for a
   * stuck or silent ingest. It holds the download lock for its whole length
   * instead, so two replicas never write one part file: one that finds it
   * held starts nothing, the other replica is downloading. Never rejects:
   * it has no caller.
   */
  private startDownload({ c, entry, file }: Wanted, repo: string, revision: string): void {
    const name = storedFile(entry.chainId, entry.address, file);
    const { sha256, bytes } = file === 'transfers' ? entry.transfers : entry.trail!;
    const abort = new AbortController();
    const done = this.store.locked(DOWNLOAD_JOB, false, async (client) => {
      // A retry: the failure it noted is being tried again, and "could not be downloaded" must not show beside the progress. The back-off count stays.
      if (c.downloadNote !== null) await this.store.clearDownloadNote(c.id, false).catch((err) => console.error('[washtrace] collection %d: download note not cleared: %s', c.id, this.scrubbed(err)));
      return this.fetchStored(client, c.id, file, hubUrl(repo, revision, name), join(this.stored, name), sha256, bytes, abort);
    })
      .then(() => {}, (err) => console.error('[washtrace] collection %d: stored data not downloaded: %s', c.id, this.scrubbed(err)))
      .finally(() => { if (this.downloading?.abort === abort) this.downloading = null; });
    this.downloading = { id: c.id, file, abort, done };
  }

  /**
   * One download, said on the collection as it goes: at most once per 1%,
   * fail-soft, and a write that finds the collection paused or deleted stops
   * it, as the next pass would. A part file that does not grow for STALL_MS
   * stops it too, as a failure. A failure is noted and waits its back-off (a
   * full disk says so); one that did not match its checksum has the
   * manifest asked for again, as a new publish is the likely cause. A
   * download stopped is no failure: only its progress goes, and its part is
   * kept to resume. Once whole, the next ingest pass loads it as it would
   * one put there by hand.
   *
   * `client` holds the download lock, idle for hours. Out of the pool, no
   * one hears its errors but this: an error unheard ends the process. Lost,
   * or found dead by a look once a minute, it fails the download, since the
   * lock went with it.
   */
  private async fetchStored(client: pg.PoolClient, id: number, file: 'transfers' | 'trail', url: string, dest: string, sha256: string, bytes: number, abort: AbortController): Promise<void> {
    let lost: unknown = null;
    const lose = (err: unknown) => {
      lost ??= err;
      abort.abort('lost' satisfies Halt);
    };
    client.on('error', lose);
    const alive = setInterval(() => { client.query('SELECT 1').catch(lose); }, LOCK_CHECK_MS);
    alive.unref?.();
    // In order, so a late write never overwrites the clear at the end.
    let writes = Promise.resolve();
    let writeFailed = false;
    const write = (share: number) => {
      writes = writes.then(async () => {
        try {
          if (!(await this.store.setDownload(id, file, share))) abort.abort('stopped' satisfies Halt);
        } catch (err) {
          if (!writeFailed) console.warn('[washtrace] collection %d: download progress not written: %s', id, this.scrubbed(err));
          writeFailed = true;
        }
      });
    };
    let percent = 0;
    write(0);
    const progress = (share: number) => {
      if (Math.floor(share * 100) <= percent) return;
      percent = Math.floor(share * 100);
      write(share);
    };
    const logged = (what: string) => (err: unknown) => console.error('[washtrace] collection %d: %s: %s', id, what, this.scrubbed(err));
    const watch = watchStall(partPath(dest, sha256), abort);
    try {
      await this.downloadFile(url, dest, sha256, progress, abort.signal, bytes);
      await writes;
      this.downloadsFailed.delete(id);
      await this.store.downloadDone(id).catch(logged('finished download not noted'));
      console.info('[washtrace] collection %d: stored %s downloaded', id, file);
    } catch (err) {
      await writes;
      const halt: Halt | null = abort.signal.aborted ? abort.signal.reason : null;
      if (halt === 'stopped' || halt === 'preempted') {
        await this.store.setDownload(id, null, null).catch(logged('stopped download not cleared'));
        return;
      }
      const why = halt === 'stalled' ? `nothing came for ${STALL_MS / 60_000} minutes`
        : halt === 'lost' ? `the connection holding its lock was lost (${this.scrubbed(lost)})` : this.scrubbed(err);
      console.error('[washtrace] collection %d: stored %s not downloaded: %s', id, file, why);
      if (err instanceof StoredDataError && err.kind === 'mismatch') this.hubAskedAt = -Infinity;
      const failures = (this.downloadsFailed.get(id)?.failures ?? 0) + 1;
      this.downloadsFailed.set(id, { failures, retryAt: Date.now() + retryMs(failures) });
      const note = err instanceof StoredDataError && err.kind === 'disk' ? DOWNLOAD_NOTES.disk : DOWNLOAD_NOTES.failed;
      await this.store.downloadFailed(id, note).catch(logged('failed download not noted'));
    } finally {
      clearInterval(watch);
      clearInterval(alive);
      client.removeListener('error', lose);
    }
  }

  /** Download `url` to `dest`, resumable and checked against `sha256`, whose size is `bytes` (see hub.ts). Tests override it on the instance. */
  downloadFile(url: string, dest: string, sha256: string, onProgress: (share: number) => void, signal: AbortSignal, bytes?: number): Promise<void> {
    return download(url, dest, sha256, onProgress, signal, bytes);
  }

  /** Read one collection's spans until it reaches the head or `deadline`, counting into `got` so a throw keeps what was read. `blocks` is how far the cursor moved. */
  private async readSpans(c: CollectionRow, chain: Chain, deadline: number, got: { spans: number; read: number; blocks: number }): Promise<void> {
    const head = await chain.finalized();
    await this.store.setHead(c.id, head);
    let cursor = c.cursorBlock;
    if (c.startBlock === null) {
      const start = await chain.deployBlock(c.address as `0x${string}`, head);
      await this.store.setStart(c.id, start);
      cursor = start - 1;
    }
    if (c.contract === null) {
      await this.describe(c.id, c.chainId, c.address, chain)
        .catch((err) => console.warn('[washtrace] %d/%s not described yet: %s', c.chainId, c.address, this.scrubbed(err)));
    }
    const from = cursor!;
    while (cursor! < head && Date.now() < deadline) {
      await this.beat('ingest', `Reading ${c.name ?? c.address}, blocks ${cursor! + 1}–${head}`, c.id);
      const { transfers, through } = await chain.transfers(c.address, cursor! + 1, head);
      await this.store.ingest(c.id, c.chainId, transfers, through, traders(c.chainId, transfers));
      cursor = through;
      got.spans += 1;
      got.read += transfers.length;
      got.blocks = cursor! - from;
    }
  }

  /**
   * Read what the contract says of itself, once. Its deployer is from
   * Etherscan: unknown where Etherscan does not know or no key is set. A
   * lookup that fails throws, so nothing is kept and the next pass tries again.
   */
  async describe(id: number, chainId: number, address: string, chain: Chain): Promise<void> {
    const { name, symbol } = await chain.describe(address as `0x${string}`);
    const etherscan = this.etherscanClient();
    const created = etherscan === null ? null : await etherscan.creation(chainId, address);
    await this.store.describe(id, { name, symbol, creator: created?.creator ?? null, creationTx: created?.txHash ?? null });
  }

  /**
   * The Etherscan client for `config`, by default the settings read this
   * pass, or null when no key is set. One instance while the settings stay
   * the same, so every caller shares its pacing. Tests override it on the instance.
   */
  etherscanClient(config: WorkerConfig = this.resolved()): Etherscan | null {
    const { etherscanKey, etherscanPerSecond, etherscanUrl } = config;
    if (etherscanKey === null) return null;
    const settings = `${etherscanKey} ${etherscanPerSecond} ${etherscanUrl}`;
    if (this.etherscan === null || this.etherscanSettings !== settings) {
      this.etherscan = new Etherscan(etherscanKey, etherscanPerSecond, etherscanUrl);
      this.etherscanSettings = settings;
    }
    return this.etherscan;
  }

  /** Read the funding of wallets not yet read, collections taking turns, within the budget. */
  async fund(): Promise<string> {
    const { followHops } = this.resolved();
    const etherscan = this.etherscanClient();
    if (etherscan === null) return 'no funding source configured';
    const deadline = Date.now() + BUDGET_MS;
    const collections = await this.store.collections();
    let done = 0;
    let failed = 0;
    for (const chainId of new Set(collections.map((c) => c.chainId))) {
      const { lanes } = await this.store.fundingLanes(chainId, 20, followHops);
      // Every collection flagged on this chain. A paused one has no lane (the store leaves it out), so it takes no priority turn.
      const priority = new Set(collections.filter((c) => c.chainId === chainId && c.priority && c.pausedAt === null).map((c) => c.id));
      const whose = (wallet: string) => {
        const lane = lanes.find((l) => l.wallets.includes(wallet))!;
        const c = collections.find((c) => c.id === lane.collectionId);
        return c === undefined ? 'followed wallets' : c.name ?? c.address;
      };
      for (const wallet of interleave(lanes, priority)) {
        if (Date.now() > deadline) return `${done} wallets read, ${failed} failed`;
        await this.beat('fund', `Checking wallets for ${whose(wallet)}`, null);
        try {
          const { flows, truncated } = await etherscan.flows(chainId, wallet, WALLET_MS);
          const follow = followHops > 0 ? { hops: followHops, fanout: FOLLOW_FANOUT, exclude: [...contractsFor(chainId), ZERO] } : undefined;
          await this.store.fund(chainId, wallet, flows, truncated, follow);
          done += 1;
        } catch (err) {
          await this.store.fundingFailed(chainId, wallet, this.scrubbed(err));
          failed += 1;
        }
      }
    }
    return `${done} wallets read, ${failed} failed`;
  }

  /**
   * Rerun the three methods over one collection written to since its last
   * analysis, the one `nextAnalysis` picks. One a pass, so a pass is never
   * longer than one analysis, and the next pass sees what changed meanwhile.
   * Left out: a collection whose stored data is still to load (it is
   * analysed once loaded, not twice), and one waiting out a failure. One
   * whose load failed and is not due again is analysed on what it has.
   */
  async analyze(): Promise<string> {
    const { etherscanKey } = this.resolved();
    const now = Date.now();
    const manifest = await this.storedManifest();
    const loading = new Set<number>();
    if (manifest !== null) {
      for (const r of await this.store.collections()) {
        const entry = entryFor(manifest, r.chainId, r.address);
        // A download that failed and waits holds nothing: analysed on what it has, as a load that failed is.
        if (this.restoreDue(r, entry, await this.noteKey(r, entry), now) && !this.downloadWaits(r, now)) loading.add(r.id);
      }
    }
    const due = (await this.store.stale()).filter((s) => !loading.has(s.id) && (s.retryAt ?? 0) <= now);
    const c = nextAnalysis(due, now);
    if (c === null) return 'nothing due';
    // A loaded money trail is funding too: the money lenses run on it with no key.
    const fundingAvailable = etherscanKey !== null || await this.store.importedFunding(c.id);
    const name = c.name ?? `collection ${c.id}`;
    await this.beat('analyze', `Analyzing ${name}`, c.id);
    const started = Date.now();
    try {
      const { analysis, through } = await this.analyzeOff({
        storeUrl: this.storeUrl,
        id: c.id,
        chainId: c.chainId,
        rules: c.rules,
        fundingAvailable,
        custodians: new Set(CUSTODIANS),
        contracts: contractsFor(c.chainId),
        money: moneyFor(c.chainId),
      });
      await this.store.saveAnalysis(c.id, c.version, analysis, Date.now() - started, through);
    } catch (err) {
      // The pass fails as before, and says so; the collection says why until one is saved, and waits, so the others go first.
      await this.store.analysisFailed(c.id, this.scrubbed(err))
        .catch((e) => console.error('[washtrace] collection %d: failed analysis not noted: %s', c.id, this.scrubbed(e)));
      throw err;
    }
    return `${name} analyzed`;
  }

  /**
   * Read the input and run `analyze` off the main thread, so ingest, funding
   * and /health go on meanwhile, and the flows are never held here. Tests
   * override it on the instance.
   */
  analyzeOff(request: AnalysisRequest): Promise<Analysed> {
    return analyzeInThread(request);
  }

  /**
   * Hear the console's Test requests on a connection of its own and run them
   * at once, not next pass: the page polls for about 20 seconds. Runs the
   * checks on connecting too, for any asked while no worker listened. A lost
   * connection is a log line and a retry, 5 seconds later and longer each
   * time it fails in a row, up to a minute. The checks also run every
   * SWEEP_MS, for a request not heard. Never rejects; `stop` ends it.
   */
  async listen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.sweep = setInterval(() => { void this.sweepChecks(); }, SWEEP_MS);
    this.sweep.unref?.();
    await this.connectListener();
  }

  /**
   * The timer's run of the checks, which answers and expires them though no
   * notification came. A check waiting longer than DEAF_MS while no run is
   * in flight, and the last run went through here, was not heard: the
   * listener is connected again. Never rejects, and runs nothing once stopped.
   */
  private async sweepChecks(): Promise<void> {
    const deaf = this.listener;
    if (this.checking === null && this.checksFailed === '' && !this.checksSkipped && deaf !== null) {
      const pending = await this.store.pendingChecks().catch(() => []);
      if (this.listener === deaf && this.listening && pending.some((c) => c.ageMs > DEAF_MS)) {
        console.warn('[washtrace] a Test request went unheard; listening again');
        this.listener = null;
        deaf.end().catch(() => {});
        void this.connectListener();
      }
    }
    // Stopped while it looked: the pool may be ending.
    if (!this.listening) return;
    await this.checksSoon();
  }

  private async connectListener(): Promise<void> {
    this.relisten = null;
    if (!this.listening) return;
    // Kept alive as the store's pool is (Store.connect): an idle listener is what a NAT drops first.
    const client = new pg.Client({ connectionString: this.storeUrl, application_name: 'washtrace-checks', keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
    this.listener = client;
    const lose = (err: unknown) => {
      // Only the current listener retries: one ended by `stop`, or already lost, does not.
      if (this.listener !== client) return;
      this.listener = null;
      client.end().catch(() => {});
      if (!this.listening) return;
      this.listenFailures += 1;
      const wait = Math.min(RELISTEN_MAX_MS, RELISTEN_MS * this.listenFailures);
      // A long outage is a line at its start and one every tenth retry, as for the store at startup.
      if (this.listenFailures % 10 === 1) {
        console.warn('[washtrace] check requests not heard (%s); listening again in %ds', this.scrubbed(err), wait / 1000);
      }
      this.relisten = setTimeout(() => { void this.connectListener(); }, wait);
      this.relisten.unref?.();
    };
    client.on('error', lose);
    client.on('end', () => lose(new Error('connection ended')));
    client.on('notification', () => { void this.checksSoon(); });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHECKS_CHANNEL}`);
    } catch (err) {
      lose(err);
      return;
    }
    if (this.listener !== client) return;
    this.listenFailures = 0;
    void this.checksSoon();
  }

  /** Run the checks now, or once more after the run in flight. Never two runs at once, and never rejects. */
  private checksSoon(): Promise<void> {
    if (this.checking !== null) {
      this.checkAgain = true;
      return this.checking;
    }
    this.checking = (async () => {
      try {
        do {
          this.checkAgain = false;
          try {
            await this.runChecks();
            this.checksFailed = '';
          } catch (err) {
            const message = this.scrubbed(err);
            if (this.checksFailed !== message) console.error('[washtrace] checks not run: %s', message);
            this.checksFailed = message;
          }
        } while (this.checkAgain && this.listening);
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  /**
   * Finish every check the console asked for, with the settings as saved
   * this moment, so a URL saved a second ago is the one tested; the settings
   * read last when the store cannot say. A check older than CHECK_EXPIRY_MS
   * is finished as expired instead. One replica runs checks at a time; one
   * that heard the same request skips. Returns how many it finished.
   */
  async runChecks(): Promise<number> {
    const finished = await this.store.locked(CHECKS_LOCK, false, async () => {
      const settings = await this.store.settings().catch(() => this.settings);
      const config = this.resolved(settings);
      const n = await this.store.expireChecks(CHECK_EXPIRY_MS);
      // At once, so several Tests asked together do not add up their waits.
      // All settle before the lock goes: one that cannot be saved does not end the run under the rest.
      const pending = await this.store.pendingChecks();
      const settled = await Promise.allSettled(pending.map(async (c) => {
        const { ok, detail } = await this.runCheck(c, config);
        await this.store.finishCheck(c.id, ok, detail);
      }));
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
      return n + pending.length;
    });
    this.checksSkipped = finished === 'skipped';
    return finished === 'skipped' ? 0 : finished;
  }

  /**
   * One check's result: the chain's three answers, Etherscan answering, or
   * `{ error }`. Never throws, so one bad check cannot hold up the rest. The
   * console shows the detail, so every URL and key is taken out of an error.
   */
  private async runCheck(c: { kind: CheckKind; chainId: number | null }, config: WorkerConfig): Promise<{ ok: boolean; detail: Record<string, unknown> }> {
    const fail = (error: string) => ({ ok: false, detail: { error } });
    try {
      if (c.kind === 'etherscan') {
        const etherscan = this.etherscanClient(config);
        if (etherscan === null) return fail('No Etherscan key is set');
        // One key serves every chain; Ethereum when the console named none.
        await etherscan.ping(c.chainId ?? 1);
        return { ok: true, detail: {} };
      }
      if (c.kind !== 'rpc') return fail(`Unknown check: ${String(c.kind).slice(0, 40)}`);
      if (c.chainId === null) return fail('An RPC check needs a chain');
      const url = config.rpc.get(c.chainId);
      if (url === undefined) return fail(`No RPC is set for chain ${c.chainId}`);
      return { ok: true, detail: await this.chain(c.chainId, url).check() };
    } catch (err) {
      // Every secret seen, not only this config's: `config` was built by resolved, so its own are among them.
      return fail(this.scrubbed(err));
    }
  }

  /**
   * Read the console's settings and publish where each value came from, once
   * a pass. Either failing lets the pass go on, a failed read on the settings
   * read last: the store being briefly away must not stop a pass that may not
   * need it.
   */
  private async loadSettings(): Promise<void> {
    try {
      this.settings = await this.store.settings();
    } catch (err) {
      const message = this.scrubbed(err);
      if (this.readFailed !== message) console.warn('[washtrace] settings not read: %s', message);
      this.readFailed = message;
    }
    try {
      await this.store.reportSources(this.resolved().sources);
    } catch (err) {
      const message = this.scrubbed(err);
      if (this.reportFailed !== message) console.warn('[washtrace] settings sources not reported: %s', message);
      this.reportFailed = message;
    }
  }

  /** Record what `job` is doing and tell the store. Fail-soft: a heartbeat must never fail a pass. */
  private async beat(job: Job, doing: string | null, subjectId: number | null): Promise<void> {
    this.current.set(job, { doing, subjectId });
    try {
      await this.store.heartbeat(job, doing, subjectId);
    } catch (err) {
      const message = this.scrubbed(err);
      if (this.beatFailed !== message) console.warn('[washtrace] %s heartbeat not written: %s', job, message);
      this.beatFailed = message;
    }
  }

  /** The client for `chainId` at `url`, one per URL so its span is learned once. Tests override it on the instance. */
  chain(chainId: number, url: string): Chain {
    const key = `${chainId} ${url}`;
    let chain = this.chains.get(key);
    if (!chain) this.chains.set(key, (chain = new Chain(chainId, url)));
    return chain;
  }

  /** The config for `settings`, by default the settings read this pass, its secrets remembered for scrubbed. */
  private resolved(settings: ReadonlyMap<string, string> = this.settings): WorkerConfig {
    const config = this.config(settings);
    for (const secret of configSecrets(config)) this.seen.add(secret);
    return config;
  }

  /**
   * An error as the console and the log may show it: brief, with every URL
   * and every secret the worker has known in this process (each RPC URL, the
   * Etherscan key and URL, the store's URL) taken out. viem puts the RPC URL
   * in its messages, and a collection's error reaches every visitor through
   * the API.
   */
  private scrubbed(err: unknown): string {
    try {
      this.resolved();
    } catch {
      // A config that cannot be read names no secret to add; every URL and every secret seen still go.
    }
    return redact(briefOf(err), [...urlSecrets(this.storeUrl), ...this.seen]);
  }

  /** Say on the collection what went wrong, and log it once. `message` is already scrubbed: it reaches the API. */
  private async fail(id: number, message: string): Promise<void> {
    if (this.logged.get(id) !== message) console.error('[washtrace] collection %d: %s', id, message);
    this.logged.set(id, message);
    await this.store.setError(id, message);
  }
}

/**
 * Stop a download as stalled once its part file has not grown for STALL_MS.
 * The part's size, not the progress, is the measure: progress comes once per
 * 1%, which for gigabytes on a slow line can be minutes apart. A stat every
 * STALL_CHECK_MS, not a wait, so it costs nothing.
 */
function watchStall(part: string, abort: AbortController): ReturnType<typeof setInterval> {
  let size = -1;
  let grewAt = Date.now();
  const timer = setInterval(() => {
    let now = -1;
    try {
      now = statSync(part, { throwIfNoEntry: false })?.size ?? -1;
    } catch {
      // Not readable: as good as no bytes.
    }
    if (now !== size) {
      size = now;
      grewAt = Date.now();
    } else if (Date.now() - grewAt >= STALL_MS) abort.abort('stalled' satisfies Halt);
  }, STALL_CHECK_MS);
  timer.unref?.();
  return timer;
}

/** `p`, or a rejection with `signal`'s reason once it aborts first: for a read that may never return. */
function orAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An error in a line: viem's short message and details, not its full
 * message, which adds the request body and the version. Other errors as
 * they are.
 */
function briefOf(err: unknown): string {
  const e = err as { shortMessage?: unknown; details?: unknown } | null;
  if (typeof e?.shortMessage !== 'string') return messageOf(err);
  return typeof e.details === 'string' && e.details !== '' ? `${e.shortMessage} ${e.details}` : e.shortMessage;
}

/**
 * `text` with every secret and every URL taken out, cut to one short line.
 * RPC and HTTP clients put the request URL in their errors, and an RPC
 * URL is often its own key, so a URL is never kept even when not configured.
 */
function redact(text: string, secrets: readonly string[]): string {
  // URLs first, whole: hiding a secret inside one first would leave the rest of it.
  let out = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
  // Ignoring case: a URL's host is lowercased once parsed, and a provider may echo it as it was written.
  for (const s of [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[hidden]');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 300 ? `${out.slice(0, 299)}…` : out;
}

/**
 * The URL and its parts, as secrets. A provider's key is a path segment, a
 * query value or a subdomain, and a provider may echo it on its own, in the
 * URL without its scheme, or decoded, so each part is kept both as written
 * and decoded. With `credentialsOnly`, only the parts that can carry a key in
 * a public API's URL: its userinfo and query values. Its host and path are
 * public ("etherscan" among them), and hiding them would hide whose error it is.
 */
function urlSecrets(url: string, credentialsOnly = false): string[] {
  const bare = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const parts = credentialsOnly ? [] : [url, bare, bare.replace(/\/+$/, '')];
  try {
    const u = new URL(url);
    if (!credentialsOnly) parts.push(u.host, u.hostname, ...u.hostname.split('.').filter((l) => l.length >= 6), ...u.pathname.split('/').filter((p) => p.length >= 6));
    parts.push(u.username, u.password);
    // The Authorization header the transport sends for them, which a proxy may echo.
    if (u.username !== '' || u.password !== '') {
      parts.push(Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64'));
    }
    parts.push(...u.search.slice(1).split('&').map((kv) => kv.slice(kv.indexOf('=') + 1)).filter((v) => v.length >= 6));
  } catch {
    // Not a URL: every run of six or more between separators.
    if (!credentialsOnly) parts.push(...url.split(/[/?&=:@#]/).filter((p) => p.length >= 6));
  }
  // A query value encodes a space as '+', which decodeURIComponent leaves.
  return parts.flatMap((p) => {
    try { return [p, decodeURIComponent(p), decodeURIComponent(p.replace(/\+/g, ' '))]; } catch { return [p]; }
  });
}

/**
 * Every secret in a config: the RPC URLs whole (an RPC URL is often its own
 * key), the credentials in the Etherscan URL (a compatible API may take a key
 * in its query), and the key.
 */
function configSecrets(config: WorkerConfig): string[] {
  return [...[...config.rpc.values()].flatMap((u) => urlSecrets(u)), ...urlSecrets(config.etherscanUrl, true), config.etherscanKey ?? ''];
}
