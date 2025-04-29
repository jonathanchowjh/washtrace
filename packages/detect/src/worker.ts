import { Chain } from './chain.js';
import { Etherscan } from './etherscan.js';
import { ZERO } from './graph.js';
import { CUSTODIANS, contractsFor, moneyFor } from './marketplaces.js';
import { analyze } from './methods.js';
import type { Store } from './store.js';

/** What the worker reads from the environment on every pass, so a changed setting needs no restart. */
export interface WorkerConfig {
  /** RPC URL per chain id. A collection on a chain with none reports so, and waits. */
  rpc: ReadonlyMap<number, string>;
  etherscanKey: string | null;
  etherscanPerSecond: number;
  etherscanUrl: string;
}

export type Job = 'ingest' | 'fund' | 'analyze';

/**
 * How often each job runs. Ingest at a minute: finalized blocks advance
 * every 12 seconds, so a minute's wait costs nothing against the 13-minute
 * finality lag already accepted. Funding runs back to back because it is
 * the long pole: four Etherscan calls a wallet at four calls a second.
 */
export const EVERY: Readonly<Record<Job, number>> = { ingest: 60_000, fund: 5_000, analyze: 60_000 };

/** A pass stops starting new work after this long, so one collection's backfill cannot starve the rest. */
export const BUDGET_MS = 45_000;

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

  constructor(private readonly store: Store, private readonly config: () => WorkerConfig) {}

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

  /** One pass of `job`, unless one is in flight here or in another replica. Never rejects: a timer has no caller. */
  async run(job: Job): Promise<'ran' | 'skipped'> {
    if (this.running.has(job)) return 'skipped';
    this.running.add(job);
    const started = Date.now();
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
      this.running.delete(job);
    }
  }

  /** Read every collection's next spans of finalized transfers, oldest cursor first, within the budget. */
  async ingest(): Promise<string> {
    const deadline = Date.now() + BUDGET_MS;
    const { rpc } = this.config();
    const collections = (await this.store.collections()).sort((a, b) => (a.cursorBlock ?? -1) - (b.cursorBlock ?? -1));
    let spans = 0;
    let read = 0;
    for (const c of collections) {
      if (Date.now() > deadline) break;
      const url = rpc.get(c.chainId);
      if (url === undefined) {
        await this.fail(c.id, `No RPC is configured for chain ${c.chainId}. Set WASHTRACE_RPC_${c.chainId}.`);
        continue;
      }
      const chain = this.chain(c.chainId, url);
      const contracts = contractsFor(c.chainId);
      try {
        const head = await chain.finalized();
        await this.store.setHead(c.id, head);
        let cursor = c.cursorBlock;
        if (c.startBlock === null) {
          const start = await chain.deployBlock(c.address as `0x${string}`, head);
          await this.store.setStart(c.id, start);
          cursor = start - 1;
        }
        while (cursor! < head && Date.now() < deadline) {
          const { transfers, through } = await chain.transfers(c.address, cursor! + 1, head);
          const queue = transfers.flatMap((t) => [t.from, t.to]).filter((a) => a !== ZERO && !contracts.has(a));
          await this.store.ingest(c.id, c.chainId, transfers, through, queue);
          cursor = through;
          spans += 1;
          read += transfers.length;
        }
        this.logged.delete(c.id);
      } catch (err) {
        await this.fail(c.id, messageOf(err));
      }
    }
    return `${read} transfers in ${spans} spans across ${collections.length} collections`;
  }

  /** Read the funding of the busiest wallets not yet read, within the budget. */
  async fund(): Promise<string> {
    const { etherscanKey, etherscanPerSecond, etherscanUrl } = this.config();
    if (etherscanKey === null) return 'no funding source configured';
    const settings = `${etherscanKey} ${etherscanPerSecond} ${etherscanUrl}`;
    if (this.etherscan === null || this.etherscanSettings !== settings) {
      this.etherscan = new Etherscan(etherscanKey, etherscanPerSecond, etherscanUrl);
      this.etherscanSettings = settings;
    }
    const deadline = Date.now() + BUDGET_MS;
    const chains = [...new Set((await this.store.collections()).map((c) => c.chainId))];
    let done = 0;
    let failed = 0;
    for (const chainId of chains) {
      for (const wallet of await this.store.fundingQueue(chainId, 20)) {
        if (Date.now() > deadline) return `${done} wallets read, ${failed} failed`;
        try {
          const { flows, truncated } = await this.etherscan.flows(chainId, wallet);
          await this.store.fund(chainId, wallet, flows, truncated);
          done += 1;
        } catch (err) {
          await this.store.fundingFailed(chainId, wallet, messageOf(err));
          failed += 1;
        }
      }
    }
    return `${done} wallets read, ${failed} failed`;
  }

  /** Rerun the three methods over every collection written to since its last analysis. */
  async analyze(): Promise<string> {
    const { etherscanKey } = this.config();
    const stale = await this.store.stale();
    for (const c of stale) {
      const started = Date.now();
      const input = await this.store.analysisInput(c.id, c.chainId);
      const result = analyze({
        ...input,
        fundingAvailable: etherscanKey !== null,
        custodians: new Set(CUSTODIANS),
        contracts: contractsFor(c.chainId),
        money: moneyFor(c.chainId),
        rules: c.rules,
      });
      await this.store.saveAnalysis(c.id, c.version, result, Date.now() - started, input.through);
    }
    return `${stale.length} collections analyzed`;
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
