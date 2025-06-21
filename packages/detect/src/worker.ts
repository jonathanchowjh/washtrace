import { analyzeInThread, type Analysed, type AnalysisRequest } from './analysis-thread.js';
import { Chain } from './chain.js';
import { Etherscan } from './etherscan.js';
import { ZERO } from './graph.js';
import { CUSTODIANS, contractsFor, moneyFor } from './marketplaces.js';
import type { CollectionRow, FundingLane, StaleRow, Store } from './store.js';

/** What the worker reads from the environment on every pass, so a changed setting needs no restart. */
export interface WorkerConfig {
  /** RPC URL per chain id. A collection on a chain with none reports so, and waits. */
  rpc: ReadonlyMap<number, string>;
  etherscanKey: string | null;
  etherscanPerSecond: number;
  etherscanUrl: string;
  /** Hops of money to follow out of a trader for SCC AU. 0 reads traders only, as the paper did. */
  followHops: number;
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
  const keepUp = cs.filter(atHead);
  const rest = cs.filter((c) => !atHead(c)).sort((a, b) => (a.servedAt ?? -1) - (b.servedAt ?? -1));
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
  /** The last heartbeat error logged, so an outage is one line and not one every 30 seconds. */
  private beatFailed = '';
  private readonly current = new Map<Job, { doing: string | null; subjectId: number | null }>();

  /**
   * `storeUrl` is the store's own, for the analysis thread to open a
   * connection of its own with. It carries the password: never logged.
   */
  constructor(private readonly store: Store, private readonly config: () => WorkerConfig, private readonly storeUrl: string) {}

  start(): void {
    if (this.timers.length > 0) return;
    for (const job of ['ingest', 'fund', 'analyze'] as const) {
      const timer = setInterval(() => { void this.run(job); }, EVERY[job]);
      timer.unref?.();
      this.timers.push(timer);
      void this.run(job);
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  /** The jobs with a pass in flight in this process. */
  get busy(): Job[] {
    return [...this.running];
  }

  /**
   * Resolves once no pass is in flight, or after `ms`. For shutdown: a pass
   * stopped mid-span would roll its transaction back and redo the span, which
   * is safe but wasted, so it is given the time to commit.
   */
  async drain(ms = 30_000): Promise<void> {
    const until = Date.now() + ms;
    while (this.running.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
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
    const { rpc } = this.config();
    const passEnd = Date.now() + BUDGET_MS;
    const collections = await this.store.collections();
    const total = { spans: 0, read: 0, blocks: 0 };
    const serve = async (c: CollectionRow, deadline: number) => {
      if (Date.now() >= deadline) return;
      const started = Date.now();
      const url = rpc.get(c.chainId);
      if (url === undefined) {
        await this.fail(c.id, `No RPC is configured for chain ${c.chainId}. Set WASHTRACE_RPC_${c.chainId}.`);
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

  /** The Etherscan client for the current settings, or null when no key is set. */
  etherscanClient(): Etherscan | null {
    const { etherscanKey, etherscanPerSecond, etherscanUrl } = this.config();
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
    const { followHops } = this.config();
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
    const { etherscanKey } = this.config();
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

  private chain(chainId: number, url: string): Chain {
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
