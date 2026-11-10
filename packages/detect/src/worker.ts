import { ANALYZE_TIMEOUT_MS, analyzeInThread, type Analysed, type AnalysisRequest } from './analysis-thread.js';
import { SpotCheck } from './spot.js';
import { Chain } from './chain.js';
import { Checks } from './checks.js';
import { Etherscan, WALLET_MS, isServiceFailure } from './etherscan.js';
import { LENS_TIMEOUT_MS, runLensInThread, runPreviewInThread, type LensRequest, type Lensed, type PreviewRequest } from './lens-thread.js';
import { CUSTODIANS, contractsFor, moneyFor, traders } from './marketplaces.js';
import { briefOf, configSecrets, redact, urlSecrets, type WorkerConfig } from './env.js';
import { LockedRun } from './locked-run.js';
import { followOf } from './reach.js';
import { ANALYZE_GAP_MS, COUNT_TIMEOUT_MS, LOCKS, retryMs, type CollectionRow, type DueRun, type MoneyLane, type PreviewResult, type StaleRow, type Store } from './store.js';
import { entryFor, storedDir } from './stored.js';
import { StoredSync } from './stored-sync.js';

export type Job = 'ingest' | 'fund' | 'analyze' | 'lens';

/**
 * How often each job runs. Ingest at a minute: finalized blocks advance
 * every 12 seconds, so a minute's wait costs nothing against the 13-minute
 * finality lag already accepted. Funding runs back to back because it is
 * the long pole: four Etherscan calls a wallet at four calls a second.
 * `lens` is no timer: lens work runs in analyze's passes (start), and its
 * period is only what status.ts allows the lens row before it reads overdue.
 */
export const EVERY: Readonly<Record<Job, number>> = { ingest: 60_000, fund: 5_000, analyze: 60_000, lens: 60_000 };

/**
 * How long a due lens run gives way to due analyses before it runs
 * anyway, counted from when it became due (Store.nextLensRun's `dueAt`). On a
 * busy install some analysis is always due, and a lens that always gave way
 * would never run. Past this an analysis waits one lens run, minutes, behind
 * a lens that has waited ten.
 */
export const LENS_WAIT_MS = 10 * 60_000;

/** What one analyze pass does: run a preview, an analysis or a lens run, or nothing. */
export type Work = 'preview' | 'analysis' | 'run' | 'nothing';

/**
 * What an analyze pass runs, given what it ran last. A preview goes before a
 * lens run and a due analysis: someone is at the editor waiting on it, and it
 * judges a sample of 2,000 sales, not the collection. But not two in a row
 * while an analysis is due: every page reads the latest analysis, so one held
 * off while someone tunes a lens leaves every number older. A lens run gives
 * way to a due analysis until it has waited LENS_WAIT_MS, and past that runs,
 * unless the last pass ran one: with a backlog of runs that have all waited,
 * the analysis then waits one run, not all of them.
 */
export function pickWork(s: { last: Work | null; preview: boolean; run: { dueAt: number } | null; analysisDue: boolean; now: number }): Work {
  if (s.last === 'preview' && s.analysisDue) return 'analysis';
  if (s.preview) return 'preview';
  if (s.run !== null && s.now - s.run.dueAt >= LENS_WAIT_MS && s.last !== 'run') return 'run';
  if (s.analysisDue) return 'analysis';
  if (s.run !== null) return 'run';
  return 'nothing';
}

/** How long drain gives the write that queues a stopped lens run again; main's exit budget is the drain, this, and one second for the pool. */
const REQUEUE_MS = 500;

/** How often a running pass says it is alive, so a step that takes minutes is not mistaken for a stall. */
const HEARTBEAT_MS = 30_000;

/** A pass stops starting new work after this long, so one collection's backfill cannot starve the rest. */
export const BUDGET_MS = 45_000;

/**
 * What of a fund pass finding the wallets past the hop limit in the money
 * already read may take on each chain (Store.seedReach), so the checking
 * still runs: a walk of a big collection is minutes cold, and goes on from
 * its rows next pass. Each chain has its own, so a long one on the first
 * leaves the next its turn. SEED_CHUNK wallets stepped from a call, a
 * second or so cold.
 */
export const SEED_MS = 10_000;
const SEED_CHUNK = 2_000;

/**
 * What of a fund pass reading other tokens may take on each chain before the
 * money check, so an explicit Start reading makes progress within one pass.
 * The money check is not starved by it: what checking leaves unused of the
 * pass is read on afterwards, and the two share the one Etherscan quota.
 */
export const TOKENS_MS = 10_000;

/**
 * The fund pass's reserve for Store.countTokens, every chain's in all:
 * kept back from the checking, and spent after every chain has
 * been checked, each chain in an equal share of what is left,
 * so a count of a big set is cut short there rather than eat the checking
 * or the estimate's count; a stopped count keeps the counts it would have
 * replaced.
 */
export const TOKEN_COUNT_MS = 5_000;

/**
 * A pass still running after this long is stuck, however fresh its heartbeat:
 * the keep-alive beats while a step goes on, whether or not the step moves.
 * Analyze sits above the thread's own ceiling (ANALYZE_TIMEOUT_MS), so a
 * stopped analysis is said as its failure first. Ingest can load stored data,
 * which takes minutes; a money trail imports outside it (see
 * StoredSync.startTrailImport); a funding pass keeps to its budget.
 */
export const STUCK_MS: Readonly<Record<Job, number>> = { ingest: 30 * 60_000, fund: 10 * 60_000, analyze: ANALYZE_TIMEOUT_MS + 10 * 60_000, lens: LENS_TIMEOUT_MS + 10 * 60_000 };

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
  const longestWaitingFirst = (a: CollectionRow, b: CollectionRow) => (a.servedAt ?? -1) - (b.servedAt ?? -1);
  const live = cs.filter((c) => c.pausedAt === null);
  const keepUp = live.filter(atHead).sort(longestWaitingFirst);
  const rest = live.filter((c) => !atHead(c)).sort(longestWaitingFirst);
  const n = Math.max(0, Math.min(rest.length, Math.floor(budgetMs / MIN_SLICE_MS)));
  return { keepUp, backfill: rest.slice(0, n).map((c) => ({ c, sliceMs: budgetMs / n })) };
}

/**
 * The order to check wallets in: one from each lane in turn, so no collection
 * waits behind another's backlog. A wallet in two lanes is taken once; a lane
 * that meets one already taken moves on to its next. The lanes of the
 * prioritised collections (`priorityIds`, as many as are flagged) take every
 * other turn, sharing those turns among themselves in turn; when they all
 * run dry the rest go on. A lane that has run dry gives its turn to the next.
 */
export function interleave(lanes: readonly MoneyLane[], priorityIds: ReadonlySet<number>): string[] {
  const priority = lanes.filter((l) => l.collectionId !== null && priorityIds.has(l.collectionId));
  const others = lanes.filter((l) => !priority.includes(l));
  const next = new Map<MoneyLane, number>(lanes.map((l) => [l, 0]));
  const taken = new Set<string>();
  const order: string[] = [];
  const take = (lane: MoneyLane): boolean => {
    let i = next.get(lane)!;
    while (i < lane.wallets.length && taken.has(lane.wallets[i]!)) i += 1;
    next.set(lane, i + 1);
    if (i >= lane.wallets.length) return false;
    taken.add(lane.wallets[i]!);
    order.push(lane.wallets[i]!);
    return true;
  };
  // One wallet from the first lane of `queue` that still has one; that lane goes to the back, a dry one goes.
  const turn = (queue: MoneyLane[]): void => {
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

/** A lens run's or a preview's progress is written at most this often. */
const LENS_PROGRESS_MS = 2_000;

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
 * The polling half of the service. Four jobs: ingest reads new finalized
 * transfers per collection, fund reads the money of each wallet those
 * transfers named, analyze reruns the paper's methods over any collection
 * that changed, and lens runs each lens of yours on its collections and the
 * editor's previews. Analyze and lens share one timer and one lock: each pass
 * of the analyze timer runs one analysis, preview or lens run, as pickWork
 * picks, and records itself under that job's row. Beside them it hears the
 * console's Test requests (Checks.listen) and runs them at once. Ingest also
 * drives the stored data (`sync`, see StoredSync) before it reads any chain,
 * and an analysis leaves out a collection whose stored data is still to load.
 *
 * A pass that is due while the last is still running is skipped, not queued.
 * Across replicas, each pass takes its job's advisory lock without waiting,
 * so N replicas of one image do one worker's work.
 *
 * A class because the store, the config, the chain clients and the timers
 * are shared by every pass.
 */
export class Worker {
  /** The stored data: the Hub's manifest, loads, trail imports and downloads. */
  readonly sync: StoredSync;
  /** The console's Test requests: the listener and the checks runs. */
  readonly checks: Checks;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  /** The timers' jobs with a pass in flight here: ingest, fund and analyze. */
  private readonly running = new Set<Job>();
  /** Set by stop(): only a worker that was told to stop hands its lens run back; a drain alone does not. */
  private stopped = false;
  /** The lens run, preview or analysis this worker has marked as going, for drain to queue again if a stop outlasts it. One at a time: the analysis lock. */
  private inFlight: { run: { lensId: number; collectionId: number } } | { preview: number } | { analysis: number } | null = null;
  private readonly chains = new Map<string, Chain>();
  private etherscan: Etherscan | null = null;
  private etherscanSettings = '';
  /** The last error logged per collection, so an outage is one line and not one a minute. */
  private readonly logged = new Map<number, string>();
  /** What each running job is doing now, so the keep-alive can say it again while a long step goes on. */
  private readonly current = new Map<Job, { doing: string | null; subjectId: number | null }>();
  /** The last failure logged per job, so a pass that fails the same way every few seconds is one line until it next succeeds. */
  private readonly passFailed = new Map<Job, string>();
  /** The last heartbeat error logged, so an outage is one line and not one every 30 seconds. */
  private beatFailed = '';
  /** Why this fund pass stopped on Etherscan's key or service, or '' while it has not. */
  private outage = '';
  /** The console's settings as last read, kept when a read fails so a store hiccup changes no setting. */
  settings: ReadonlyMap<string, string> = new Map();
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
  /** Analyses that failed, by collection, timed as Store.analysisFailed times them: kept here too, as StoredSync's downloadsFailed is, since the write that records the wait can fail with the analysis. */
  private readonly analysesFailed = new Map<number, { failures: number; retryAt: number }>();
  /** What the last analyze pass here ran, for pickWork. In memory only: a restart forgets it, and the first pass picks as if nothing ran. */
  private last: Work | null = null;
  // Collections whose rings failed to fill: passed over until the worker restarts, so one holds up none after it. Their next analysis fills them.
  private ringsFailed = new Set<number>();
  /**
   * A preview was asked for while an analyze pass was in flight here: that
   * pass may have looked for one before it was queued, so one more runs after
   * it. Once, however many were heard: a pass takes one preview.
   */
  private again = false;
  /** The watch on the connection holding the lock of each pass in flight here, by the rows the pass records under (see run). */
  private readonly locks = new Map<Job, { watch: LockedRun; abort: AbortController }>();

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
    stored: string = storedDir(process.env),
  ) {
    this.sync = new StoredSync(this, store, stored);
    this.checks = new Checks(this, store, storeUrl);
  }

  /** Starts the timers of ingest, fund and analyze, each job's first pass now. Lens work runs in analyze's passes. */
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
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.sync.stop();
    this.checks.stop();
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
   *
   * After a stop, a lens run or preview still going when the time is up is
   * queued again, its failures as they were: a deploy is not a failure, and
   * three of them in a row would park the run. The write is given
   * REQUEUE_MS and its failure is only logged, so it never holds the exit
   * past the drain and half a second. A real crash never gets here, so the next
   * worker still counts the `running` row it leaves as a failure.
   */
  async drain(ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    const busy = () => this.running.size > 0 || this.checks.checking !== null || this.sync.inFlight;
    while (busy() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    const left = this.inFlight;
    if (!this.stopped || left === null) return;
    const write = 'run' in left ? this.store.requeueLensRun(left.run.lensId, left.run.collectionId)
      : 'analysis' in left ? this.store.analysisRequeued(left.analysis)
      : this.store.requeuePreview(left.preview);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      write.catch((err) => console.error(`[washtrace] stop: ${'analysis' in left ? 'analysis' : 'lens work'} not queued again: %s`, this.scrubbed(err))),
      new Promise((r) => { timer = setTimeout(r, REQUEUE_MS); }),
    ]);
    clearTimeout(timer);
  }

  /**
   * One pass of `job`, unless one is in flight here or in another replica.
   * An analyze pass is a `turn`. Never rejects: a timer has no caller.
   *
   * The connection holding the lock is watched for the pass's length, as a
   * download's is (LockedRun): lost, or found dead by a look once a minute,
   * it has let the lock go, and another replica may start the same work. The
   * pass then stops as at its deadline, saves nothing more, and fails with
   * why (see lockLost).
   */
  async run(job: Exclude<Job, 'lens'>): Promise<'ran' | 'skipped'> {
    if (this.running.has(job)) return 'skipped';
    this.running.add(job);
    const started = Date.now();
    // The rows this pass may record under: an analyze pass records an analysis on analyze's, lens work on lens's.
    const rows: Job[] = job === 'analyze' ? ['analyze', 'lens'] : [job];
    const alive = setInterval(() => {
      for (const row of rows) {
        const now = this.current.get(row);
        if (now !== undefined) void this.beat(row, now.doing, now.subjectId);
      }
    }, HEARTBEAT_MS);
    alive.unref?.();
    try {
      const outcome = await this.store.locked(LOCKS[job], false, async (client) => {
        const abort = new AbortController();
        // Its progress is the pass's own rows', so it says none; nothing it writes can fail.
        const watch = new LockedRun(client, abort, async () => true, (err) => this.logFailed(job, this.scrubbed(err)));
        for (const row of rows) this.locks.set(row, { watch, abort });
        try {
          await this.loadSettings();
          if (job === 'analyze') await this.turn(started);
          else await this.recorded(job, started, () => this[job]());
        } finally {
          watch.close();
          for (const row of rows) this.locks.delete(row);
        }
      });
      return outcome === 'skipped' ? 'skipped' : 'ran';
    } catch (err) {
      this.logFailed(job, this.scrubbed(err));
      return 'ran';
    } finally {
      clearInterval(alive);
      for (const row of rows) this.current.delete(row);
      this.running.delete(job);
      if (job === 'analyze' && this.again) {
        this.again = false;
        if (!this.stopped) void this.run('analyze');
      }
    }
  }

  /**
   * Run `work` as a pass of `job`: started, then finished with its detail, or
   * failed with its error, which is rethrown. A start that cannot be recorded
   * runs nothing and finishes nothing; its error is rethrown. A pass that lost
   * its lock fails with that, whatever its work said.
   */
  private async recorded(job: Job, started: number, work: () => Promise<string>): Promise<void> {
    // passStarted is the first beat; with `current` set the keep-alive beats on, though the work's first call is slow.
    await this.store.passStarted(job);
    this.current.set(job, { doing: null, subjectId: null });
    try {
      const detail = await work();
      const lost = this.lockLost(job);
      if (lost !== null) throw lost;
      await this.store.passFinished(job, Date.now() - started, 'ok', detail);
      this.passFailed.delete(job);
    } catch (err) {
      const why = this.lockLost(job) ?? err;
      await this.store.passFinished(job, Date.now() - started, 'failed', this.scrubbed(why));
      throw why;
    }
  }

  /**
   * The error the pass recording under `job` here fails with once the
   * connection holding its lock is lost, or null while it holds (and outside
   * a pass). Another replica may take the lock and run the same work, so a
   * pass that lost it counts its deadline passed and saves nothing more.
   */
  private lockLost(job: Job): Error | null {
    const held = this.locks.get(job);
    if (held === undefined || !held.abort.signal.aborted) return null;
    return new Error(`the connection holding its lock was lost (${this.scrubbed(held.watch.lost)})`);
  }

  /** Record a pass of `job` that ran no work: started and finished at once, so its row says when it last looked. */
  private async noted(job: Job, started: number, outcome: 'ok' | 'failed', detail: string): Promise<void> {
    await this.store.passStarted(job);
    await this.store.passFinished(job, Date.now() - started, outcome, detail);
    if (outcome === 'ok') this.passFailed.delete(job);
    else this.logFailed(job, detail);
  }

  /** Log a failed pass of `job`, once until it next succeeds: a pass that fails the same way every minute is one line. */
  private logFailed(job: Job, message: string): void {
    if (this.passFailed.get(job) !== message) console.error('[washtrace] %s pass failed: %s', job, message);
    this.passFailed.set(job, message);
  }

  /**
   * One analyze pass, under the analysis lock `run` holds: sweep previews
   * past PREVIEW_KEEP_MS, see what is waiting, let pickWork choose, and run
   * it, recorded on its job's row. The other row is written as it is picked,
   * with why it ran nothing, so neither goes overdue on the console while the
   * other's work runs pass after pass. Nothing to do is `nothing due` on both.
   * That note shares no fate with the work: one that cannot be written is
   * logged under its row, and the work still runs.
   *
   * Each side's reads fail alone: a throw sweeping or reading the lens queues
   * fails the lens row and leaves that side empty this pass; one finding the
   * due analysis fails the analyze row and leaves none due. The other side's
   * work still runs.
   *
   * `nextPreview` marks the preview it returns `running`, so a queue is
   * asked only when pickWork could pick from it: after a preview while an
   * analysis is due (its first rule, the one above a queued preview's)
   * neither is, and with a preview in hand no lens run is. That rule hands
   * the turn to the analysis, so it asks for one more pass straight after,
   * for the preview it skipped. A preview taken is in flight from then: a
   * stop hands it back, and a write that fails before it runs fails it with
   * that write's error, not as one a stopped worker left.
   *
   * One thread of the lens's or the analysis's size at a time keeps the
   * memory budget, and `nextPreview` and `nextLensRun` take a `running` row as
   * one a stopped worker left, which is safe only because nothing else can be
   * running one: both hold because everything here runs under the one lock.
   */
  private async turn(started: number): Promise<void> {
    const now = Date.now();
    const failed = new Map<Job, unknown>();
    const swept = await this.store.sweepPreviews(now).then(() => true, (err) => { failed.set('lens', err); return false; });
    // Rings for an analysis saved before they were (Store.fillRings): one collection a turn, under the lock saveAnalysis is under.
    // A failure is the analyze row's, and is logged: an analysis that runs after it would otherwise write over it with ok.
    await this.store.fillRings([...this.ringsFailed]).catch((err) => {
      const id = (err as { collectionId?: unknown }).collectionId;
      if (typeof id === 'number') this.ringsFailed.add(id);
      failed.set('analyze', err);
      this.logFailed('analyze', this.scrubbed(err));
    });
    const due = await this.dueAnalysis(now).catch((err) => { failed.set('analyze', err); return null; });
    const analysisFirst = this.last === 'preview' && due !== null;
    let preview: Awaited<ReturnType<Store['nextPreview']>> = null;
    let run: DueRun | null = null;
    if (swept && !analysisFirst) {
      try {
        preview = await this.store.nextPreview();
        if (preview !== null) this.inFlight = { preview: preview.id };
        else run = await this.store.nextLensRun(now);
      } catch (err) {
        failed.set('lens', err);
      }
    }
    const work = pickWork({ last: this.last, preview: preview !== null, run, analysisDue: due !== null, now });
    if (analysisFirst) this.again = true;
    // Set before it runs: work that fails has cost the others their turn too.
    this.last = work;
    const ran: Job | null = work === 'analysis' ? 'analyze' : work === 'nothing' ? null : 'lens';
    // Why the row that runs nothing did so. A lens side picked runs, so its row is idle only behind an analysis or with nothing to do.
    const idle = (job: 'analyze' | 'lens'): string => job === 'analyze'
      ? (due === null ? 'nothing due' : work === 'preview' ? 'a preview is due first' : 'a lens run is due first')
      : (run !== null || analysisFirst ? 'an analysis is due first' : work === 'nothing' ? 'nothing due' : 'nothing to run');
    for (const job of ['analyze', 'lens'] as const) {
      if (job === ran) continue;
      const note = failed.has(job) ? this.noted(job, started, 'failed', this.scrubbed(failed.get(job))) : this.noted(job, started, 'ok', idle(job));
      await note.catch((err) => this.logFailed(job, this.scrubbed(err)));
    }
    try {
      if (work === 'analysis') await this.recorded('analyze', started, () => this.analyzeOne(due!));
      else if (work === 'preview') await this.recorded('lens', started, () => this.preview(preview!));
      else if (work === 'run') await this.recorded('lens', started, () => this.lensRun(run!));
    } catch (err) {
      await this.giveBack(err);
      this.logFailed(ran ?? 'analyze', this.scrubbed(err));
    }
  }

  /**
   * Fail the preview this pass took, if its run never started (a pass write
   * failed first), with that error: left `running`, the next pass would fail
   * it as one a stopped worker left. One that ran has noted its own end.
   */
  private async giveBack(err: unknown): Promise<void> {
    const left = this.inFlight;
    if (left === null || !('preview' in left)) return;
    this.inFlight = null;
    await this.store.previewFailed(left.preview, this.scrubbed(err))
      .catch((e) => console.error('[washtrace] preview %d: failure not noted: %s', left.preview, this.scrubbed(e)));
  }

  /**
   * Read each collection's next spans of finalized transfers. Collections at
   * the head first, then each backfill within its own slice of the budget.
   * Before any of that, and outside the budget, load the stored data of one
   * collection it reaches further for (see StoredSync.restore): it needs no RPC, and is
   * the head start the chain is then read on from. A collection whose load
   * waits for a later pass is not read meanwhile. Stored data not on disk yet is
   * downloaded in the background, and a collection waiting for its
   * transfers is not read meanwhile (see StoredSync.downloads). A money trail on disk
   * imports in the background too, and holds nothing (see StoredSync.trails).
   */
  async ingest(): Promise<string> {
    const { rpc, storedRepo } = this.resolved();
    let collections = await this.store.collections();
    await this.sync.askHub(collections, storedRepo);
    const manifest = await this.sync.storedManifest();
    const { loaded: restored, deferred } = manifest === null ? { loaded: 0, deferred: new Set<number>() } : await this.sync.restore(collections, manifest);
    // Read again: a load moved the cursors, and serving the old ones would read what it loaded.
    if (restored > 0) collections = await this.store.collections();
    // After every load of stored data, so a trail waits for its collection's transfers.
    if (manifest !== null) await this.sync.trails(collections, manifest);
    // After the loads, so a file just loaded is not downloaded.
    const held = manifest === null ? new Set<number>() : await this.sync.downloads(collections, manifest, storedRepo);
    // A chain with no RPC has nothing to read, so its collections are settled here and hold no slice of the budget.
    const readable: CollectionRow[] = [];
    for (const c of collections) {
      // Its load is next pass's: read now, it would be read from its deploy block for nothing.
      if (deferred.has(c.id)) continue;
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
      if (Date.now() >= deadline || this.lockLost('ingest')) return;
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
    while (cursor! < head && Date.now() < deadline && !this.lockLost('ingest')) {
      await this.beat('ingest', `Reading ${c.name ?? c.address}, blocks ${cursor! + 1}–${head}`, c.id);
      const { transfers, through } = await chain.transfers(c.address, cursor! + 1, head);
      await this.store.ingest(c.id, c.chainId, transfers, through, traders(c.chainId, transfers), this.resolved().followReread ?? 0);
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

  /**
   * Read the funding of wallets not yet read, collections taking turns, within
   * the budget. The reserves come off the end first: COUNT_TIMEOUT_MS (Store.countNext's own cap) for
   * a stale estimate's count, and, with any collection reading tokens,
   * TOKEN_COUNT_MS for their counts. Each chain then walks its reaches (within
   * SEED_MS), reads its started collections' tokens (within TOKENS_MS) and
   * checks its wallets, up to what the reserves leave. After every chain has
   * had its turn, what checking left unused reads more tokens, chain by chain,
   * and the chains' token counts follow, each chain with a started
   * collection, the ones checking never reached too, each in an equal share
   * of the time left. The estimate is counted last, in what is
   * left of the pass. On an Etherscan key or quota refusal the pass ends at once,
   * so its remaining store-only steps (seedReach for later chains, countTokens,
   * countNext) wait for the next pass that gets through, as with no key.
   */
  async fund(): Promise<string> {
    const { followHops: globalHops } = this.resolved();
    const etherscan = this.etherscanClient();
    const started = Date.now();
    this.outage = '';
    const deadline = started + BUDGET_MS;
    // Spot checks first, inside the pass's budget: someone is waiting on each. Without a key they still run Round trips.
    let spotted = await this.spots(etherscan, deadline);
    if (etherscan === null) return 'no funding source configured';
    const collections = await this.store.collections();
    const counting = await this.store.nextCount(globalHops);
    const countUntil = deadline - (counting === null ? 0 : COUNT_TIMEOUT_MS);
    const tokenChains = new Set(collections.filter((c) => c.readTokens).map((c) => c.chainId));
    const checkUntil = tokenChains.size > 0 ? countUntil - TOKEN_COUNT_MS : countUntil;
    // Every collection flagged on a chain. A paused one has no lane (the store leaves it out), so it takes no priority turn.
    const priorityOn = (chainId: number) => new Set(collections.filter((c) => c.chainId === chainId && c.priority && c.pausedAt === null).map((c) => c.id));
    let done = 0;
    let failed = 0;
    chains: for (const chainId of new Set(collections.map((c) => c.chainId))) {
      const seedUntil = Math.min(Date.now() + SEED_MS, checkUntil);
      while (Date.now() < seedUntil && !this.lockLost('fund') && await this.store.seedReach(chainId, globalHops, SEED_CHUNK) > 0) {
        await this.beat('fund', "Finding watched collections' wallets from the money already read", null);
      }
      const priority = priorityOn(chainId);
      if (tokenChains.has(chainId)) {
        await this.readTokens(etherscan, chainId, collections, priority, Math.min(Date.now() + TOKENS_MS, checkUntil));
        if (this.outage !== '') throw this.outageError();
      }
      const { lanes } = await this.store.moneyLanes(chainId, 20, globalHops);
      const whose = (wallet: string) => {
        const lane = lanes.find((l) => l.wallets.includes(wallet))!;
        const c = collections.find((c) => c.id === lane.collectionId);
        return c === undefined ? 'followed wallets' : c.name ?? c.address;
      };
      for (const wallet of interleave(lanes, priority)) {
        if (Date.now() > checkUntil || this.lockLost('fund')) break chains;
        // One asked for mid-pass waits a wallet, not the rest of the pass.
        spotted += await this.spots(etherscan, checkUntil);
        await this.beat('fund', `Checking wallets for ${whose(wallet)}`, null);
        try {
          // A wallet due a re-read is read from a day of blocks before where the last read ended, and a first read in full.
          const from = await this.store.rereadFrom(chainId, wallet, 'money');
          const { flows, truncated, through } = await etherscan.flows(chainId, wallet, WALLET_MS, from ?? undefined);
          const follow = globalHops > 0 ? followOf(chainId, globalHops) : undefined;
          await this.store.saveMoney(chainId, wallet, flows, truncated, follow, through, from !== null);
          done += 1;
        } catch (err) {
          if (this.noteOutage(err)) throw this.outageError();
          await this.store.moneyFailed(chainId, wallet, this.scrubbed(err));
          failed += 1;
        }
      }
    }
    // After every chain has been checked: the time checking left reads more tokens, then every chain's counts, shared within countUntil.
    for (const chainId of tokenChains) {
      await this.readTokens(etherscan, chainId, collections, priorityOn(chainId), checkUntil);
      if (this.outage !== '') throw this.outageError();
    }
    // Each chain an equal share of what is left, worked out again after each, so a chain whose count always runs out cannot
    // starve the chains after it, and one that finishes early leaves its time to them.
    const toCount = [...tokenChains];
    for (const [i, chainId] of toCount.entries()) {
      if (this.lockLost('fund')) break;
      await this.countTokens(chainId, Date.now() + Math.floor((countUntil - Date.now()) / (toCount.length - i)));
    }
    if (counting !== null && Date.now() < deadline && !this.lockLost('fund')) {
      const c = collections.find((c) => c.id === counting);
      await this.beat('fund', `Counting the next wallets out for ${c?.name ?? c?.address ?? `collection ${counting}`}`, counting);
      // A count that fails or runs out of time fails no checking. It was noted as tried, so the next pass counts another.
      await this.store.countNext(counting, globalHops, Math.min(COUNT_TIMEOUT_MS, deadline - Date.now()))
        .catch((err) => console.error('[washtrace] collection %d: next hop not counted: %s', counting, this.scrubbed(err)));
    }
    return `${done} wallets read, ${failed} failed${spotted > 0 ? `, ${spotted} transactions checked` : ''}`;
  }

  /**
   * Run queued spot checks, one after another, until none is left or `until`
   * passes; returns how many ran. Under the fund lock, so one at a time, and
   * with the pass's Etherscan client, so its pacing holds across both. A
   * check that fails is saved failed with its sentence, and the next goes on.
   */
  async spots(etherscan: Etherscan | null, until: number): Promise<number> {
    let ran = 0;
    while (Date.now() < until && !this.lockLost('fund')) {
      const next = await this.store.nextSpot();
      if (next === null) break;
      ran += 1;
      const url = this.resolved().rpc.get(next.chainId);
      if (url === undefined) {
        await this.store.spotFailed(next.id, `No RPC is configured for chain ${next.chainId}. Set WASHTRACE_RPC_${next.chainId}.`);
        continue;
      }
      await this.beat('fund', `Checking transaction ${next.tx.slice(0, 10)}…`, null);
      try {
        await this.store.saveSpot(next.id, await this.spotCheck(next.chainId, url, etherscan).run(next.tx, next.lens));
      } catch (err) {
        await this.store.spotFailed(next.id, this.scrubbed(err));
      }
    }
    return ran;
  }

  /** The check for one spot check on `chainId`. Tests override it on the instance. */
  spotCheck(chainId: number, url: string, etherscan: Etherscan | null): SpotCheck {
    return new SpotCheck(this.store, this.chain(chainId, url), etherscan, chainId);
  }

  /**
   * If `err` is about Etherscan's key or quota, remember it (scrubbed) as why
   * the pass stops, and say so. The wallet in hand is not marked: it did
   * nothing wrong, and a mark would hold it back an hour after the key is fixed.
   */
  private noteOutage(err: unknown): boolean {
    if (!isServiceFailure(err)) return false;
    this.outage = this.scrubbed(err);
    return true;
  }

  /** Ends the pass as failed, so the console shows it as a problem; `run` logs it. */
  private outageError(): Error {
    return new Error(`Etherscan key or quota: ${this.outage}`);
  }

  /**
   * Read the other tokens of the wallets the started collections on a chain
   * still need read, collections taking turns, until `until`, and return how
   * many were tried. The lanes are asked for again each time they run dry,
   * and every wallet tried leaves them (read, or failed for an hour), so the
   * loop ends. A read that fails is noted and fails nothing else. A lane
   * query that throws ends this slice for the pass, logged; the money check
   * goes on without tokens.
   */
  private async readTokens(etherscan: Etherscan, chainId: number, collections: readonly CollectionRow[], priority: ReadonlySet<number>, until: number): Promise<number> {
    const { followHops: globalHops, tokensPayees } = this.resolved();
    let tried = 0;
    try {
      while (Date.now() < until && !this.lockLost('fund')) {
        const { lanes } = await this.store.tokenLanes(chainId, 20, globalHops, tokensPayees, until);
        const order = interleave(lanes, priority);
        if (order.length === 0) break;
        for (const wallet of order) {
          if (Date.now() >= until || this.lockLost('fund')) return tried;
          const owner = collections.find((c) => c.id === lanes.find((l) => l.wallets.includes(wallet))?.collectionId);
          await this.beat('fund', `Reading other tokens for ${owner?.name ?? owner?.address ?? 'followed wallets'}`, null);
          tried += 1;
          try {
            const from = await this.store.rereadFrom(chainId, wallet, 'tokens');
            const { flows, truncated, through } = await etherscan.tokenFlows(chainId, wallet, WALLET_MS, from ?? undefined);
            await this.store.saveTokens(chainId, wallet, flows, truncated, through, from !== null);
          } catch (err) {
            if (this.noteOutage(err)) return tried;
            await this.store.tokensFailed(chainId, wallet, this.scrubbed(err));
          }
        }
      }
    } catch (err) {
      console.error('[washtrace] chain %d: other tokens not read: %s', chainId, this.scrubbed(err));
    }
    return tried;
  }

  /** Store how far the chain's started collections have their tokens read. A count that fails fails no checking. */
  private async countTokens(chainId: number, until: number): Promise<void> {
    const { followHops: globalHops, tokensPayees } = this.resolved();
    await this.store.countTokens(chainId, globalHops, tokensPayees, until)
      .catch((err) => console.error('[washtrace] chain %d: tokens not counted: %s', chainId, this.scrubbed(err)));
  }

  /**
   * Rerun the three methods over `c`, the collection dueAnalysis gave: one
   * written to since its last analysis. One a pass, so a pass is never
   * longer than one analysis, and the next pass sees what changed meanwhile.
   */
  private async analyzeOne(c: StaleRow): Promise<string> {
    const { etherscanKey, followHops: globalHops } = this.resolved();
    // A loaded money trail is funding too: the money lenses run on it with no key.
    const fundingAvailable = etherscanKey !== null || await this.store.importedMoney(c.id);
    const name = c.name ?? `collection ${c.id}`;
    await this.beat('analyze', `Analyzing ${name}`, c.id);
    const started = Date.now();
    try {
      // Marked first: a worker killed from here on leaves it, and dueAnalysis counts that as a failed try.
      await this.store.analysisStarted(c.id);
      this.inFlight = { analysis: c.id };
      const money = moneyFor(c.chainId);
      const { analysis, through } = await this.analyzeOff({
        storeUrl: this.storeUrl,
        id: c.id,
        chainId: c.chainId,
        followHops: globalHops,
        rules: c.rules,
        fundingAvailable,
        custodians: new Set(CUSTODIANS),
        contracts: contractsFor(c.chainId),
        money,
      }, this.locks.get('analyze')?.abort.signal);
      const lost = this.lockLost('analyze');
      if (lost !== null) throw lost;
      await this.store.saveAnalysis(c.id, c.version, analysis, Date.now() - started, through, money);
      this.analysesFailed.delete(c.id);
    } catch (err) {
      // Not the analysis's failure: the mark goes, uncounted, and the next pass, here or on any replica, takes it.
      if (this.lockLost('analyze')) {
        await this.store.analysisRequeued(c.id)
          .catch((e) => console.error('[washtrace] collection %d: analysis not queued again: %s', c.id, this.scrubbed(e)));
        throw err;
      }
      // The pass fails as before, and says so; the collection says why until one is saved, and waits, so the others go first.
      const failures = (this.analysesFailed.get(c.id)?.failures ?? 0) + 1;
      this.analysesFailed.set(c.id, { failures, retryAt: Date.now() + retryMs(failures) });
      await this.store.analysisFailed(c.id, this.scrubbed(err))
        .catch((e) => console.error('[washtrace] collection %d: failed analysis not noted: %s', c.id, this.scrubbed(e)));
      throw err;
    } finally {
      this.inFlight = null;
    }
    return `${name} analyzed`;
  }

  /**
   * The collection an analysis would take now, by `nextAnalysis`, or null.
   * Left out: one whose stored data is still to load (it is analysed once
   * loaded, not twice), and one waiting out a failure. One whose load failed
   * and is not due again is analysed on what it has. Tests override it on
   * the instance.
   *
   * One still marked as started was begun by a worker that died during it
   * (a stop or a lost lock clears the mark): this runs under the analyze
   * lock, so nothing else can be analysing. That try is failed here and the
   * collection waits, so it is not picked first after every restart.
   */
  async dueAnalysis(now: number): Promise<StaleRow | null> {
    const manifest = await this.sync.storedManifest();
    const loading = new Set<number>();
    if (manifest !== null) {
      for (const r of await this.store.collections()) {
        const entry = entryFor(manifest, r.chainId, r.address);
        // A download that failed and waits holds nothing: analysed on what it has, as a load that failed is.
        if (this.sync.restoreDue(r, entry, await this.sync.noteKey(r, entry), now) && !this.sync.downloadWaits(r, now)) loading.add(r.id);
      }
    }
    const stale = await this.store.stale();
    for (const s of stale) {
      if (s.startedAt !== null) {
        await this.store.analysisFailed(s.id, 'The worker stopped during this analysis.')
          .catch((e) => console.error('[washtrace] collection %d: dead analysis not noted: %s', s.id, this.scrubbed(e)));
      }
    }
    const due = stale
      .filter((s) => s.startedAt === null && !loading.has(s.id) && (s.retryAt ?? 0) <= now && (this.analysesFailed.get(s.id)?.retryAt ?? 0) <= now);
    return nextAnalysis(due, now);
  }

  /**
   * Read the input and run `analyze` off the main thread, so ingest, funding
   * and /health go on meanwhile, and the flows are never held here. Tests
   * override it on the instance.
   */
  analyzeOff(request: AnalysisRequest, signal?: AbortSignal): Promise<Analysed> {
    return analyzeInThread(request, signal);
  }

  /**
   * Run `next`, the lens run nextLensRun gave, in the lens thread, and save
   * what it found. A failure is noted on the run, scrubbed, and rethrown, so
   * the pass fails as an analysis does.
   */
  private async lensRun(next: DueRun): Promise<string> {
    const { lens, collectionId, chainId, name, analysisId, through } = next;
    const where = `${lens.name} on ${name}`;
    const started = Date.now();
    await this.store.lensRunStarted(lens.id, collectionId);
    this.inFlight = { run: { lensId: lens.id, collectionId } };
    await this.beat('lens', `Running ${where}`, collectionId);
    const { progress, written } = this.progressWriter(`Running ${where}`, collectionId, (share) => this.store.lensRunProgress(lens.id, collectionId, share));
    try {
      const { followHops: globalHops, tokensPayees } = this.resolved();
      const { totals, flags, tokensRead } = await this.lensOff({ storeUrl: this.storeUrl, lensId: lens.id, collectionId, chainId, rule: lens.rule, through, followHops: globalHops, payees: tokensPayees }, progress, this.locks.get('lens')?.abort.signal);
      await written();
      const lost = this.lockLost('lens');
      if (lost !== null) throw lost;
      const saved = await this.store.saveLensRun(lens.id, collectionId, lens.version, analysisId, through, totals, flags, Date.now() - started, tokensRead);
      if (saved === 'stale') return `${lens.name} changed while it ran: queued again`;
      if (saved === 'gone') return `${lens.name} or ${name} was removed while it ran: nothing saved`;
      return `Ran ${where}`;
    } catch (err) {
      if (this.lockLost('lens')) {
        // Not the run's failure: queued again, its failures as they were, as a stop's is, for the next pass on any replica.
        await this.store.requeueLensRun(lens.id, collectionId)
          .catch((e) => console.error('[washtrace] lens %d: run not queued again: %s', lens.id, this.scrubbed(e)));
        throw err;
      }
      await this.store.lensRunFailed(lens.id, collectionId, this.scrubbed(err))
        .catch((e) => console.error('[washtrace] lens %d: failed run not noted: %s', lens.id, this.scrubbed(e)));
      throw err;
    } finally {
      this.inFlight = null;
    }
  }

  /** Run the preview `nextPreview` took, in the lens thread, and save what it found; a failure is noted scrubbed, as a run's is. */
  private async preview(p: NonNullable<Awaited<ReturnType<Store['nextPreview']>>>): Promise<string> {
    const where = `a lens on ${p.name}`;
    this.inFlight = { preview: p.id };
    const { progress, written } = this.progressWriter(`Previewing ${where}`, p.collectionId, (share) => this.store.previewProgress(p.id, share));
    try {
      // Inside the try: a throw here fails this preview with its own error, not as a swept "worker stopped".
      await this.beat('lens', `Previewing ${where}`, p.collectionId);
      const { followHops: globalHops, tokensPayees } = this.resolved();
      const result = await this.previewOff({ storeUrl: this.storeUrl, previewId: p.id, collectionId: p.collectionId, chainId: p.chainId, rule: p.rule, through: p.through, followHops: globalHops, payees: tokensPayees }, progress, this.locks.get('lens')?.abort.signal);
      await written();
      const lost = this.lockLost('lens');
      if (lost !== null) throw lost;
      await this.store.savePreview(p.id, result);
      return `Previewed ${where}`;
    } catch (err) {
      if (this.lockLost('lens')) {
        // Not the preview's failure: queued again, as a stop's is, for the next pass on any replica.
        await this.store.requeuePreview(p.id)
          .catch((e) => console.error('[washtrace] preview %d: not queued again: %s', p.id, this.scrubbed(e)));
        throw err;
      }
      await this.store.previewFailed(p.id, this.scrubbed(err))
        .catch((e) => console.error('[washtrace] preview %d: failure not noted: %s', p.id, this.scrubbed(e)));
      throw err;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * A progress callback for the lens thread that writes with `write` and says
   * `doing` with the share in the heartbeat, at most every LENS_PROGRESS_MS,
   * in order, and never failing the run. `written` waits for the last write.
   */
  private progressWriter(doing: string, subjectId: number, write: (share: number) => Promise<void>): { progress: (share: number) => void; written: () => Promise<void> } {
    let wrote = -Infinity;
    let writes = Promise.resolve();
    const progress = (share: number) => {
      if (Date.now() - wrote < LENS_PROGRESS_MS) return;
      wrote = Date.now();
      writes = writes.then(async () => {
        await write(share);
        await this.beat('lens', `${doing}: ${Math.floor(share * 100)}%`, subjectId);
      }).catch((err) => console.warn('[washtrace] lens progress not written: %s', this.scrubbed(err)));
    };
    return { progress, written: () => writes };
  }

  /** Run the lens off the main thread, as `analyzeOff` does the analysis. Tests override it on the instance. */
  lensOff(request: LensRequest, onProgress: (share: number) => void, signal?: AbortSignal): Promise<Lensed> {
    return runLensInThread(request, onProgress, signal);
  }

  /** Run a preview off the main thread, on the lens thread. Tests override it on the instance, as `lensOff`. */
  previewOff(request: PreviewRequest, onProgress: (share: number) => void, signal?: AbortSignal): Promise<PreviewResult> {
    return runPreviewInThread(request, onProgress, signal);
  }

  /**
   * A preview was asked for: an analyze pass now, or once more after the pass
   * in flight here. Without this it would wait up to a period for the timer
   * while someone watches the editor.
   */
  soon(): void {
    if (this.running.has('analyze')) this.again = true;
    else void this.run('analyze');
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
  async beat(job: Job, doing: string | null, subjectId: number | null): Promise<void> {
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
  resolved(settings: ReadonlyMap<string, string> = this.settings): WorkerConfig {
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
  scrubbed(err: unknown): string {
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
