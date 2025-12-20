import pg from 'pg';
import { analyzeInThread, type Analysed, type AnalysisRequest } from './analysis-thread.js';
import { Chain } from './chain.js';
import { Etherscan } from './etherscan.js';
import { ZERO } from './graph.js';
import { CUSTODIANS, contractsFor, moneyFor } from './marketplaces.js';
import { CHECKS_CHANNEL, type CheckKind, type CollectionRow, type FundingLane, type SettingSource, type StaleRow, type Store } from './store.js';

/** What the worker reads from the environment and the console's settings on every pass, so a changed setting needs no restart. */
export interface WorkerConfig {
  /** RPC URL per chain id. A collection on a chain with none reports so, and waits. */
  rpc: ReadonlyMap<number, string>;
  etherscanKey: string | null;
  etherscanPerSecond: number;
  etherscanUrl: string;
  /** Hops of money to follow out of a trader for SCC AU. 0 reads traders only, as the paper did. */
  followHops: number;
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
 * rest share the budget in equal slices, those never served first and then
 * the longest waiting, so a big backfill cannot take every pass. With more
 * backfills than slices of MIN_SLICE_MS, the last wait for the next pass.
 */
export function ingestTurns(
  cs: readonly CollectionRow[],
  budgetMs: number,
): { keepUp: CollectionRow[]; backfill: { c: CollectionRow; sliceMs: number }[] } {
  const atHead = (c: CollectionRow) => c.startBlock !== null && c.cursorBlock !== null && c.headBlock !== null && c.headBlock - c.cursorBlock <= BEHIND_BLOCKS;
  const live = cs.filter((c) => c.pausedAt === null);
  const keepUp = live.filter(atHead);
  const rest = live.filter((c) => !atHead(c)).sort((a, b) => (a.servedAt ?? -1) - (b.servedAt ?? -1));
  const n = Math.max(0, Math.min(rest.length, Math.floor(budgetMs / MIN_SLICE_MS)));
  return { keepUp, backfill: rest.slice(0, n).map((c) => ({ c, sliceMs: budgetMs / n })) };
}

/**
 * The order to check wallets in: one from each lane in turn, so no collection
 * waits behind another's backlog. A wallet in two lanes is taken once; a lane
 * that meets one already taken moves on to its next. The prioritised
 * collection takes every other turn, and when it runs dry the rest go on.
 */
export function interleave(lanes: readonly FundingLane[], priorityId: number | null): string[] {
  const priority = lanes.find((l) => priorityId !== null && l.collectionId === priorityId);
  const others = lanes.filter((l) => l !== priority);
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
  let first = priority;
  const live = [...others];
  for (let turn = 0; first !== undefined || live.length > 0; turn++) {
    if (first !== undefined && (turn % 2 === 0 || live.length === 0)) {
      if (!take(first)) first = undefined;
    } else {
      const lane = live.shift()!;
      if (take(lane)) live.push(lane);
    }
  }
  return order;
}

/** A collection is not analysed again sooner than this after its last analysis. */
export const ANALYZE_GAP_MS = 5 * 60_000;

/**
 * Which stale collection to analyse next, or null when none is due. Never
 * analysed comes first, by id. Then one whose rules were edited since its
 * last analysis, oldest edit first: someone is waiting to see the flags the
 * new rules give. Otherwise a collection waits five minutes from its last
 * analysis, or twice that analysis's length if longer: one that changes
 * every minute and takes seventeen to analyse would otherwise keep the
 * analysis thread busy for it alone. Of those due, the one waiting longest goes.
 */
export function nextAnalysis(stale: readonly StaleRow[], now: number): StaleRow | null {
  const fresh = stale.filter((s) => s.ranAt === null).sort((a, b) => a.id - b.id);
  if (fresh.length > 0) return fresh[0]!;
  const edited = stale.filter((s) => s.rulesAt !== null && s.rulesAt > s.ranAt!).sort((a, b) => a.rulesAt! - b.rulesAt!);
  if (edited.length > 0) return edited[0]!;
  const due = stale.filter((s) => now - s.ranAt! >= Math.max(ANALYZE_GAP_MS, 2 * (s.tookMs ?? 0)));
  return due.sort((a, b) => a.ranAt! - b.ranAt!)[0] ?? null;
}

/** Each job's advisory lock key. Only one replica runs a job at a time. */
const LOCK: Readonly<Record<Job, number>> = { ingest: 1, fund: 2, analyze: 3 };

/** The checks' advisory lock key: every replica hears a request, and one runs it. */
const CHECKS_LOCK = 4;

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
  /** The last settings read and sources report errors logged, so an outage is one line and not one a pass. */
  private readFailed = '';
  private reportFailed = '';
  /** The connection that hears check requests, while listening. It holds no pool slot and is never shared. */
  private listener: pg.Client | null = null;
  private listening = false;
  private relisten: ReturnType<typeof setTimeout> | null = null;
  private listenFailures = 0;
  /** The checks run in flight, and whether a request came during it: runs never overlap, and none is missed. */
  private checking: Promise<void> | null = null;
  private checkAgain = false;
  private checksFailed = '';

  /**
   * `storeUrl` is the store's own, for the analysis thread to open a
   * connection of its own with. It carries the password: never logged.
   * `config` merges the environment with the console's settings it is given.
   */
  constructor(
    private readonly store: Store,
    private readonly config: (settings: ReadonlyMap<string, string>) => WorkerConfig,
    private readonly storeUrl: string,
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

  /** Stops the timers and the listener, so nothing of the worker's keeps the process alive. */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
    this.listening = false;
    if (this.relisten !== null) clearTimeout(this.relisten);
    this.relisten = null;
    const listener = this.listener;
    this.listener = null;
    listener?.end().catch(() => {});
  }

  /** The jobs with a pass in flight in this process. */
  get busy(): Job[] {
    return [...this.running];
  }

  /**
   * Resolves once no pass or check run is in flight, or after `ms`. For
   * shutdown: a pass stopped mid-span would roll its transaction back and redo
   * the span, which is safe but wasted, so it is given the time to commit.
   */
  async drain(ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    while ((this.running.size > 0 || this.checking !== null) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
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
        await this.store.passStarted(job);
        try {
          const detail = await this[job]();
          await this.store.passFinished(job, Date.now() - started, 'ok', detail);
        } catch (err) {
          await this.store.passFinished(job, Date.now() - started, 'failed', messageOf(err));
          throw err;
        }
      });
      return outcome === 'skipped' ? 'skipped' : 'ran';
    } catch (err) {
      console.error('[washtrace] %s pass failed: %s', job, messageOf(err));
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
   */
  async ingest(): Promise<string> {
    const { rpc } = this.config(this.settings);
    const passEnd = Date.now() + BUDGET_MS;
    const collections = await this.store.collections();
    const total = { spans: 0, read: 0, blocks: 0 };
    const serve = async (c: CollectionRow, deadline: number) => {
      if (Date.now() >= deadline) return;
      const started = Date.now();
      const url = rpc.get(c.chainId);
      if (url === undefined) {
        // The console offers an RPC field for Ethereum only (FIELDS in the web app); other chains are set in the environment.
        const where = c.chainId === 1 ? 'Set it in Settings, or WASHTRACE_RPC_1 for the worker.' : `Set WASHTRACE_RPC_${c.chainId} for the worker.`;
        await this.fail(c.id, `No RPC is configured for chain ${c.chainId}. ${where}`);
        return;
      }
      const got = { spans: 0, read: 0, blocks: 0 };
      try {
        await this.readSpans(c, this.chain(c.chainId, url), deadline, got);
        this.logged.delete(c.id);
      } catch (err) {
        await this.fail(c.id, messageOf(err));
      } finally {
        // Even a collection that failed was given a turn: it must not stay the oldest served.
        total.spans += got.spans;
        total.read += got.read;
        await this.store.served(c.id, got.blocks, Date.now() - started);
      }
    };
    const { keepUp, backfill } = ingestTurns(collections, BUDGET_MS);
    for (const c of keepUp) await serve(c, passEnd);
    // Slices come from what keep-up left, and no turn runs past the pass.
    const rest = ingestTurns(backfill.map((b) => b.c), passEnd - Date.now()).backfill;
    for (const { c, sliceMs } of rest) await serve(c, Math.min(Date.now() + sliceMs, passEnd));
    return `${total.read} transfers in ${total.spans} spans across ${collections.length} collections`;
  }

  /** Read one collection's spans until it reaches the head or `deadline`, counting into `got` so a throw keeps what was read. `blocks` is how far the cursor moved. */
  private async readSpans(c: CollectionRow, chain: Chain, deadline: number, got: { spans: number; read: number; blocks: number }): Promise<void> {
    const contracts = contractsFor(c.chainId);
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
        .catch((err) => console.warn('[washtrace] %d/%s not described yet: %s', c.chainId, c.address, messageOf(err)));
    }
    const from = cursor!;
    while (cursor! < head && Date.now() < deadline) {
      await this.beat('ingest', `Reading ${c.name ?? c.address}, blocks ${cursor! + 1}–${head}`, c.id);
      const { transfers, through } = await chain.transfers(c.address, cursor! + 1, head);
      const queue = transfers.flatMap((t) => [t.from, t.to]).filter((a) => a !== ZERO && !contracts.has(a));
      await this.store.ingest(c.id, c.chainId, transfers, through, queue);
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
  etherscanClient(config: WorkerConfig = this.config(this.settings)): Etherscan | null {
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
    const { followHops } = this.config(this.settings);
    const etherscan = this.etherscanClient();
    if (etherscan === null) return 'no funding source configured';
    const deadline = Date.now() + BUDGET_MS;
    const collections = await this.store.collections();
    const priority = collections.find((c) => c.priority)?.id ?? null;
    let done = 0;
    let failed = 0;
    for (const chainId of new Set(collections.map((c) => c.chainId))) {
      const { lanes } = await this.store.fundingLanes(chainId, 20);
      const whose = (wallet: string) => {
        const lane = lanes.find((l) => l.wallets.includes(wallet))!;
        const c = collections.find((c) => c.id === lane.collectionId);
        return c === undefined ? 'followed wallets' : c.name ?? c.address;
      };
      for (const wallet of interleave(lanes, priority)) {
        if (Date.now() > deadline) return `${done} wallets read, ${failed} failed`;
        await this.beat('fund', `Checking wallets for ${whose(wallet)}`, null);
        try {
          const { flows, truncated } = await etherscan.flows(chainId, wallet);
          const follow = followHops > 0 ? { hops: followHops, fanout: FOLLOW_FANOUT, exclude: [...contractsFor(chainId), ZERO] } : undefined;
          await this.store.fund(chainId, wallet, flows, truncated, follow);
          done += 1;
        } catch (err) {
          await this.store.fundingFailed(chainId, wallet, messageOf(err));
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
   */
  async analyze(): Promise<string> {
    const { etherscanKey } = this.config(this.settings);
    const c = nextAnalysis(await this.store.stale(), Date.now());
    if (c === null) return 'nothing due';
    const name = c.name ?? `collection ${c.id}`;
    await this.beat('analyze', `Analyzing ${name}`, c.id);
    const started = Date.now();
    const { analysis, through } = await this.analyzeOff({
      storeUrl: this.storeUrl,
      id: c.id,
      chainId: c.chainId,
      rules: c.rules,
      fundingAvailable: etherscanKey !== null,
      custodians: new Set(CUSTODIANS),
      contracts: contractsFor(c.chainId),
      money: moneyFor(c.chainId),
    });
    await this.store.saveAnalysis(c.id, c.version, analysis, Date.now() - started, through);
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
   * time it fails in a row, up to a minute. Never rejects; `stop` ends it.
   */
  async listen(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    await this.connectListener();
  }

  private async connectListener(): Promise<void> {
    this.relisten = null;
    if (!this.listening) return;
    const client = new pg.Client({ connectionString: this.storeUrl, application_name: 'washtrace-checks' });
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
        console.warn('[washtrace] check requests not heard (%s); listening again in %ds', redact(messageOf(err), urlSecrets(this.storeUrl)), wait / 1000);
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
            const message = redact(messageOf(err), urlSecrets(this.storeUrl));
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
      const config = this.config(settings);
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
      return fail(redact(briefOf(err), configSecrets(config)));
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
      if (this.readFailed !== messageOf(err)) console.warn('[washtrace] settings not read: %s', messageOf(err));
      this.readFailed = messageOf(err);
    }
    try {
      await this.store.reportSources(this.config(this.settings).sources);
    } catch (err) {
      if (this.reportFailed !== messageOf(err)) console.warn('[washtrace] settings sources not reported: %s', messageOf(err));
      this.reportFailed = messageOf(err);
    }
  }

  /** Record what `job` is doing and tell the store. Fail-soft: a heartbeat must never fail a pass. */
  private async beat(job: Job, doing: string | null, subjectId: number | null): Promise<void> {
    this.current.set(job, { doing, subjectId });
    try {
      await this.store.heartbeat(job, doing, subjectId);
    } catch (err) {
      if (this.beatFailed !== messageOf(err)) console.warn('[washtrace] %s heartbeat not written: %s', job, messageOf(err));
      this.beatFailed = messageOf(err);
    }
  }

  /** The client for `chainId` at `url`, one per URL so its span is learned once. Tests override it on the instance. */
  chain(chainId: number, url: string): Chain {
    const key = `${chainId} ${url}`;
    let chain = this.chains.get(key);
    if (!chain) this.chains.set(key, (chain = new Chain(chainId, url)));
    return chain;
  }

  private async fail(id: number, message: string): Promise<void> {
    if (this.logged.get(id) !== message) console.error('[washtrace] collection %d: %s', id, message);
    this.logged.set(id, message);
    await this.store.setError(id, message);
  }
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
  for (const s of [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join('[hidden]');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 300 ? `${out.slice(0, 299)}…` : out;
}

/**
 * The URL and its parts, as secrets. A provider's key is a path segment, a
 * query value or a subdomain, and a provider may echo it on its own, in the
 * URL without its scheme, or decoded, so each part is kept both as written
 * and decoded.
 */
function urlSecrets(url: string): string[] {
  const bare = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const parts = [url, bare, bare.replace(/\/+$/, '')];
  try {
    const u = new URL(url);
    parts.push(u.host, u.hostname, ...u.hostname.split('.').filter((l) => l.length >= 6));
    parts.push(u.username, u.password);
    // The Authorization header the transport sends for them, which a proxy may echo.
    if (u.username !== '' || u.password !== '') {
      parts.push(Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64'));
    }
    parts.push(...u.pathname.split('/').filter((p) => p.length >= 6));
    parts.push(...u.search.slice(1).split('&').map((kv) => kv.slice(kv.indexOf('=') + 1)).filter((v) => v.length >= 6));
  } catch {
    // Not a URL: every run of six or more between separators.
    parts.push(...url.split(/[/?&=:@#]/).filter((p) => p.length >= 6));
  }
  // A query value encodes a space as '+', which decodeURIComponent leaves.
  return parts.flatMap((p) => {
    try { return [p, decodeURIComponent(p), decodeURIComponent(p.replace(/\+/g, ' '))]; } catch { return [p]; }
  });
}

/** Every secret in a config: the RPC URLs, the Etherscan URL (its query may carry a key) and the key. */
function configSecrets(config: WorkerConfig): string[] {
  return [...[...config.rpc.values(), config.etherscanUrl].flatMap(urlSecrets), config.etherscanKey ?? ''];
}
