import pg from 'pg';
import { ANALYZE_TIMEOUT_MS, analyzeInThread, type Analysed, type AnalysisRequest } from './analysis-thread.js';
import { Chain } from './chain.js';
import { Etherscan, WALLET_MS } from './etherscan.js';
import { LENS_TIMEOUT_MS, runLensInThread, runPreviewInThread, type LensRequest, type Lensed, type PreviewRequest } from './lens-thread.js';
import { CUSTODIANS, contractsFor, moneyFor, traders } from './marketplaces.js';
import { briefOf, configSecrets, redact, urlSecrets, type WorkerConfig } from './env.js';
import { ANALYZE_GAP_MS, CHECKS_CHANNEL, COUNT_TIMEOUT_MS, followOf, LOCKS, PREVIEWS_CHANNEL, retryMs, type CheckKind, type CollectionRow, type FundingLane, type PreviewResult, type StaleRow, type Store } from './store.js';
import { entryFor, storedDir } from './stored.js';
import { StoredSync } from './stored-sync.js';

export type Job = 'ingest' | 'fund' | 'analyze' | 'lens';

/**
 * How often each job runs. Ingest at a minute: finalized blocks advance
 * every 12 seconds, so a minute's wait costs nothing against the 13-minute
 * finality lag already accepted. Funding runs back to back because it is
 * the long pole: four Etherscan calls a wallet at four calls a second.
 */
export const EVERY: Readonly<Record<Job, number>> = { ingest: 60_000, fund: 5_000, analyze: 60_000, lens: 60_000 };

/**
 * Ruling KK: how long a due lens run gives way to due analyses before it runs
 * anyway, counted from when it became due (Store.nextLensRun's `dueAt`). On a
 * busy install some analysis is always due, and a lens that always gave way
 * would never run. Past this an analysis waits one lens run, minutes, behind
 * a lens that has waited ten.
 */
export const LENS_WAIT_MS = 10 * 60_000;

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
 * What of a fund pass is kept, at its end, for counting one collection's
 * next hop (Ruling S21) when one is due: COUNT_TIMEOUT_MS, the longest the
 * count (capped at WALK_CAP) runs before it is stopped.
 */
export const COUNT_MS = COUNT_TIMEOUT_MS;

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
  const waiting = (a: CollectionRow, b: CollectionRow) => (a.servedAt ?? -1) - (b.servedAt ?? -1);
  const live = cs.filter((c) => c.pausedAt === null);
  const keepUp = live.filter(atHead).sort(waiting);
  const rest = live.filter((c) => !atHead(c)).sort(waiting);
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
 * A check asked for longer ago than this is finished as expired, not run.
 * The page that asked stopped polling after 20 seconds, and a URL tested now
 * may no longer be the one it asked about.
 */
const CHECK_EXPIRY_MS = 5 * 60_000;

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
 * collection that changed. Beside them it hears the console's Test requests
 * (listen) and runs them at once. Ingest also drives the stored data
 * (`sync`, see StoredSync) before it reads any chain, and analyze leaves out
 * a collection whose stored data is still to load.
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
  /** Analyses that failed, by collection, timed as Store.analysisFailed times them: kept here too, as StoredSync's downloadsFailed is, since the write that records the wait can fail with the analysis. */
  private readonly analysesFailed = new Map<number, { failures: number; retryAt: number }>();
  /**
   * Ruling RR: whether the last lens pass ran a run; cleared by one that gave
   * way or found nothing. The next pass then gives way to a due analysis
   * whatever its run's wait. Passes only try the lock, on fixed timers, so
   * with a backlog of runs past LENS_WAIT_MS lens passes took it back to back
   * and an analysis waited many runs; alternating keeps KK's cost at one run.
   */
  private lensRanLast = false;
  /**
   * Ruling S12: whether the last lens pass ran a preview. The next pass then
   * gives way to a due analysis, once, and sets `handOver` so the lock goes
   * to it (see lens).
   */
  private previewRanLast = false;
  private handOver = false;
  /**
   * A preview was asked for while a lens pass was in flight here: that pass
   * may have looked for one before it was queued, so one more runs after it
   * (P5). Once, however many were heard: a pass takes one preview.
   */
  private lensAgain = false;

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
  }

  /**
   * Starts every job's timer, each job's first pass now. The lens job starts
   * half a period after analyze's (C1): the two take one lock (R8), and Node
   * fires timers of one length in the order made, so on the same beat analyze
   * asked first every minute and a lens pass never got the lock.
   */
  start(): void {
    if (this.timers.length > 0) return;
    const every = (job: Job) => {
      const timer = setInterval(() => { void this.run(job); }, EVERY[job]);
      timer.unref?.();
      this.timers.push(timer);
      void this.run(job);
    };
    for (const job of ['ingest', 'fund', 'analyze'] as const) every(job);
    const offset = setTimeout(() => every('lens'), EVERY.lens / 2);
    offset.unref?.();
    this.timers.push(offset);
  }

  /**
   * Stops the timers, the listener, any download (its part is kept, for the
   * next worker to resume) and any trail import (loading it again is safe),
   * so nothing of the worker's keeps the process alive.
   */
  stop(): void {
    // clearInterval clears the lens job's starting timeout too: Node's timers are one kind.
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.sync.stop();
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
    const busy = () => this.running.size > 0 || this.checking !== null || this.sync.inFlight;
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
      // R8: a lens run and an analysis never overlap, so the lens pass holds the analysis lock.
      const outcome = await this.store.locked(LOCKS[job === 'lens' ? 'analyze' : job], false, async () => {
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
      if (job === 'lens' && this.handOver) {
        // Ruling S12: the analysis takes the lock now, then a lens pass for the preview that waited; it stands in for the lensAgain re-run.
        this.handOver = false;
        this.lensAgain = false;
        // A stopped worker starts nothing: its timers are cleared and it hears no more.
        const on = () => this.listening || this.timers.length > 0;
        if (on()) void this.run('analyze').then(() => { if (on()) void this.run('lens'); });
      } else if (job === 'lens' && this.lensAgain) {
        this.lensAgain = false;
        if (this.listening) void this.run('lens');
      }
    }
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
    const { loaded: restored, waiting } = manifest === null ? { loaded: 0, waiting: new Set<number>() } : await this.sync.restore(collections, manifest);
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
      if (waiting.has(c.id)) continue;
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

  /**
   * Read the funding of wallets not yet read, collections taking turns, within
   * the budget. Each chain's reaches are walked first, within SEED_MS of it,
   * so the wallets they find are checked this pass; a stale estimate is
   * counted last, in the COUNT_MS kept for it or what is left of the pass,
   * whichever is less.
   */
  async fund(): Promise<string> {
    const { followHops } = this.resolved();
    const etherscan = this.etherscanClient();
    if (etherscan === null) return 'no funding source configured';
    const started = Date.now();
    const deadline = started + BUDGET_MS;
    const collections = await this.store.collections();
    const counting = await this.store.nextCount(followHops);
    const checkUntil = counting === null ? deadline : deadline - COUNT_MS;
    let done = 0;
    let failed = 0;
    chains: for (const chainId of new Set(collections.map((c) => c.chainId))) {
      const seedUntil = Math.min(Date.now() + SEED_MS, checkUntil);
      while (Date.now() < seedUntil && await this.store.seedReach(chainId, followHops, SEED_CHUNK) > 0) {
        await this.beat('fund', 'Finding the wallets past the hop limit from the money already read', null);
      }
      const { lanes } = await this.store.fundingLanes(chainId, 20, followHops);
      // Every collection flagged on this chain. A paused one has no lane (the store leaves it out), so it takes no priority turn.
      const priority = new Set(collections.filter((c) => c.chainId === chainId && c.priority && c.pausedAt === null).map((c) => c.id));
      const whose = (wallet: string) => {
        const lane = lanes.find((l) => l.wallets.includes(wallet))!;
        const c = collections.find((c) => c.id === lane.collectionId);
        return c === undefined ? 'followed wallets' : c.name ?? c.address;
      };
      for (const wallet of interleave(lanes, priority)) {
        if (Date.now() > checkUntil) break chains;
        await this.beat('fund', `Checking wallets for ${whose(wallet)}`, null);
        try {
          const { flows, truncated } = await etherscan.flows(chainId, wallet, WALLET_MS);
          const follow = followHops > 0 ? followOf(chainId, followHops) : undefined;
          await this.store.fund(chainId, wallet, flows, truncated, follow);
          done += 1;
        } catch (err) {
          await this.store.fundingFailed(chainId, wallet, this.scrubbed(err));
          failed += 1;
        }
      }
    }
    if (counting !== null && Date.now() < deadline) {
      const c = collections.find((c) => c.id === counting);
      await this.beat('fund', `Counting the wallets one hop further out for ${c?.name ?? c?.address ?? `collection ${counting}`}`, counting);
      // A count that fails or runs out of time fails no checking. It was noted as tried, so the next pass counts another (S26).
      await this.store.countNext(counting, followHops, Math.min(COUNT_MS, deadline - Date.now()))
        .catch((err) => console.error('[washtrace] collection %d: next hop not counted: %s', counting, this.scrubbed(err)));
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
    const { etherscanKey, followHops } = this.resolved();
    const c = await this.dueAnalysis(Date.now());
    if (c === null) return 'nothing due';
    // A loaded money trail is funding too: the money lenses run on it with no key.
    const fundingAvailable = etherscanKey !== null || await this.store.importedFunding(c.id);
    const name = c.name ?? `collection ${c.id}`;
    await this.beat('analyze', `Analyzing ${name}`, c.id);
    const started = Date.now();
    try {
      const money = moneyFor(c.chainId);
      const { analysis, through } = await this.analyzeOff({
        storeUrl: this.storeUrl,
        id: c.id,
        chainId: c.chainId,
        followHops,
        rules: c.rules,
        fundingAvailable,
        custodians: new Set(CUSTODIANS),
        contracts: contractsFor(c.chainId),
        money,
      });
      await this.store.saveAnalysis(c.id, c.version, analysis, Date.now() - started, through, money);
      this.analysesFailed.delete(c.id);
    } catch (err) {
      // The pass fails as before, and says so; the collection says why until one is saved, and waits, so the others go first.
      const failures = (this.analysesFailed.get(c.id)?.failures ?? 0) + 1;
      this.analysesFailed.set(c.id, { failures, retryAt: Date.now() + retryMs(failures) });
      await this.store.analysisFailed(c.id, this.scrubbed(err))
        .catch((e) => console.error('[washtrace] collection %d: failed analysis not noted: %s', c.id, this.scrubbed(e)));
      throw err;
    }
    return `${name} analyzed`;
  }

  /**
   * The collection an analyze pass would take now, by `nextAnalysis`, or null.
   * Left out: one whose stored data is still to load and one waiting out a
   * failure. The lens pass asks too, and gives way to one (until LENS_WAIT_MS,
   * and once after a preview). Tests override it on the instance.
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
    const due = (await this.store.stale())
      .filter((s) => !loading.has(s.id) && (s.retryAt ?? 0) <= now && (this.analysesFailed.get(s.id)?.retryAt ?? 0) <= now);
    return nextAnalysis(due, now);
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
   * Sweep previews past PREVIEW_KEEP_MS, then run one thing: a queued preview
   * if there is one, else the next due lens run. A preview goes before any
   * lens run, and before a due analysis (P2): someone is at the editor
   * waiting on it, and it judges a sample of 2,000 sales, not the collection.
   * But not two in a row while an analysis is due (Ruling S12): every page
   * reads the latest analysis, so one held off while someone tunes a lens
   * leaves every number older. After a pass that ran a preview, this one
   * gives way to a due analysis, once, whether a preview or a run is next.
   * Neither the preview nor that giving way touches `lensRanLast`: whether a
   * lens run gives way is the lens runs' own business (Ruling RR).
   *
   * Giving way alone did not get the analysis the lock: passes only try it,
   * and while previews are asked for, the lensAgain re-run and every notify
   * ask the moment it is free, while analyze asks once a minute on its timer.
   * So this pass hands over: `run` starts the analyze pass as it lets the
   * lock go, in place of the lensAgain re-run, and a lens pass after it for
   * the preview that waited. Skipping the re-run instead would leave the
   * analysis to its timer and the preview a minute and an analysis later.
   *
   * A lens run, one a pass: while it has waited less than LENS_WAIT_MS it
   * gives way to a due analysis (Ruling AA); past that it runs (Ruling KK),
   * unless the last lens pass ran one (Ruling RR). Picking, starting, running
   * and saving a preview or a run all happen under the analysis lock `run`
   * holds (R8): one thread of the lens's size at a time keeps the memory
   * budget, and `nextPreview` and `nextLensRun` take a `running` row as one a
   * stopped worker left, which is safe only because nothing else can be
   * running one. A failure is noted on the preview or the run and rethrown,
   * so the pass fails as an analysis does.
   */
  async lens(): Promise<string> {
    const now = Date.now();
    await this.store.sweepPreviews(now);
    if (this.previewRanLast && await this.dueAnalysis(now) !== null) {
      this.previewRanLast = false;
      this.handOver = true;
      return 'an analysis is due first';
    }
    const preview = await this.store.nextPreview();
    // Set before it runs: a preview that fails has cost the analysis its wait too.
    this.previewRanLast = preview !== null;
    if (preview !== null) return this.preview(preview);
    const next = await this.store.nextLensRun(now);
    if (next === null) {
      this.lensRanLast = false;
      return 'nothing to run';
    }
    if ((this.lensRanLast || now - next.dueAt < LENS_WAIT_MS) && await this.dueAnalysis(now) !== null) {
      this.lensRanLast = false;
      return 'an analysis is due first';
    }
    this.lensRanLast = true;
    const { lens, collectionId, chainId, name, analysisId, through } = next;
    const where = `${lens.name} on ${name}`;
    const started = Date.now();
    await this.store.lensRunStarted(lens.id, collectionId);
    await this.beat('lens', `Running ${where}`, collectionId);
    const { progress, written } = this.progressWriter(`Running ${where}`, collectionId, (share) => this.store.lensRunProgress(lens.id, collectionId, share));
    try {
      const { totals, flags } = await this.lensOff({ storeUrl: this.storeUrl, lensId: lens.id, collectionId, chainId, rule: lens.rule, through, followHops: this.resolved().followHops }, progress);
      await written();
      const saved = await this.store.saveLensRun(lens.id, collectionId, lens.version, analysisId, through, totals, flags, Date.now() - started);
      if (saved === 'stale') return `${lens.name} changed while it ran: queued again`;
      if (saved === 'gone') return `${lens.name} or ${name} was removed while it ran: nothing saved`;
      return `Ran ${where}`;
    } catch (err) {
      await this.store.lensRunFailed(lens.id, collectionId, this.scrubbed(err))
        .catch((e) => console.error('[washtrace] lens %d: failed run not noted: %s', lens.id, this.scrubbed(e)));
      throw err;
    }
  }

  /** Run the preview `nextPreview` took, in the lens thread, and save what it found; a failure is noted scrubbed, as a run's is. */
  private async preview(p: NonNullable<Awaited<ReturnType<Store['nextPreview']>>>): Promise<string> {
    const where = `a lens on ${p.name}`;
    const { progress, written } = this.progressWriter(`Previewing ${where}`, p.collectionId, (share) => this.store.previewProgress(p.id, share));
    try {
      // Inside the try: a throw here fails this preview with its own error, not as a swept "worker stopped".
      await this.beat('lens', `Previewing ${where}`, p.collectionId);
      const result = await this.previewOff({ storeUrl: this.storeUrl, previewId: p.id, collectionId: p.collectionId, chainId: p.chainId, rule: p.rule, through: p.through, followHops: this.resolved().followHops }, progress);
      await written();
      await this.store.savePreview(p.id, result);
      return `Previewed ${where}`;
    } catch (err) {
      await this.store.previewFailed(p.id, this.scrubbed(err))
        .catch((e) => console.error('[washtrace] preview %d: failure not noted: %s', p.id, this.scrubbed(e)));
      throw err;
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
  lensOff(request: LensRequest, onProgress: (share: number) => void): Promise<Lensed> {
    return runLensInThread(request, onProgress);
  }

  /** Run a preview off the main thread, on the lens thread. Tests override it on the instance, as `lensOff`. */
  previewOff(request: PreviewRequest, onProgress: (share: number) => void): Promise<PreviewResult> {
    return runPreviewInThread(request, onProgress);
  }

  /**
   * Hear the console's Test requests on a connection of its own and run them
   * at once, not next pass: the page polls for about 20 seconds. Runs the
   * checks on connecting too, for any asked while no worker listened. A lost
   * connection is a log line and a retry, 5 seconds later and longer each
   * time it fails in a row, up to a minute. The checks also run every
   * SWEEP_MS, for a request not heard. On the same connection it hears the
   * editor's Preview requests, and runs a lens pass for each (P5); one not
   * heard waits for the lens timer. Never rejects; `stop` ends it.
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
    client.on('notification', (n) => {
      if (n.channel === PREVIEWS_CHANNEL) this.lensSoon();
      else void this.checksSoon();
    });
    try {
      await client.connect();
      // One round trip for both: the checks', and the previews' (P5).
      await client.query(`LISTEN ${CHECKS_CHANNEL}; LISTEN ${PREVIEWS_CHANNEL}`);
    } catch (err) {
      lose(err);
      return;
    }
    if (this.listener !== client) return;
    this.listenFailures = 0;
    void this.checksSoon();
  }

  /**
   * A preview was asked for: a lens pass now, which takes it first (P5), or
   * once more after the pass in flight here. Without this it would wait up to
   * a lens period for the timer while someone watches the editor.
   */
  private lensSoon(): void {
    if (this.running.has('lens')) this.lensAgain = true;
    else void this.run('lens');
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
    const finished = await this.store.locked(LOCKS.checks, false, async () => {
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
