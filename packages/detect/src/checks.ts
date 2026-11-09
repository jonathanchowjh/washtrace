import pg from 'pg';
import type { WorkerConfig } from './env.js';
import { CHECKS_CHANNEL, LOCKS, PREVIEWS_CHANNEL, type CheckKind, type Store } from './store.js';
import type { Worker } from './worker.js';

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
 * The console's Test requests: heard on a connection of its own, run at once,
 * and swept on a timer for one whose notification was lost. Split from Worker
 * because the listener, its retries and the run in flight are state no pass
 * reads (Worker.drain reads the run in flight, and run's shutdown check whether it is listening); the settings, chain clients and scrubbing it borrows from the worker.
 */
export class Checks {
  constructor(
    private readonly worker: Worker,
    private readonly store: Store,
    private readonly storeUrl: string,
  ) {}

  /** The connection that hears check requests, while listening. It holds no pool slot and is never shared. */
  private listener: pg.Client | null = null;
  listening = false;
  private relisten: ReturnType<typeof setTimeout> | null = null;
  private listenFailures = 0;
  /** Runs the checks every SWEEP_MS while listening, for a request whose notification was lost. */
  private sweep: ReturnType<typeof setInterval> | null = null;
  /** The checks run in flight, and whether a request came during it: runs never overlap, and none is missed. */
  checking: Promise<void> | null = null;
  private checkAgain = false;
  private checksFailed = '';
  /** Whether the last checks run found another replica holding them: a check left pending is then theirs, not unheard. */
  private checksSkipped = false;

  /** Stops hearing: the timers and the listener. A run in flight finishes (see Worker.drain). */
  stop(): void {
    this.listening = false;
    if (this.relisten !== null) clearTimeout(this.relisten);
    this.relisten = null;
    if (this.sweep !== null) clearInterval(this.sweep);
    this.sweep = null;
    const listener = this.listener;
    this.listener = null;
    listener?.end().catch(() => {});
  }

  /**
   * Hear the console's Test requests on a connection of its own and run them
   * at once, not next pass: the page polls for about 20 seconds. Runs the
   * checks on connecting too, for any asked while no worker listened. A lost
   * connection is a log line and a retry, 5 seconds later and longer each
   * time it fails in a row, up to a minute. The checks also run every
   * SWEEP_MS, for a request not heard. On the same connection it hears the
   * editor's Preview requests, and runs an analyze pass for each (see
   * Worker.soon); one not heard waits for the timer. Never rejects; `stop` ends it.
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
        console.warn('[washtrace] check requests not heard (%s); listening again in %ds', this.worker.scrubbed(err), wait / 1000);
      }
      this.relisten = setTimeout(() => { void this.connectListener(); }, wait);
      this.relisten.unref?.();
    };
    client.on('error', lose);
    client.on('end', () => lose(new Error('connection ended')));
    client.on('notification', (n) => {
      if (n.channel === PREVIEWS_CHANNEL) this.worker.soon();
      else void this.checksSoon();
    });
    try {
      await client.connect();
      // One round trip for both: the checks', and the previews'.
      await client.query(`LISTEN ${CHECKS_CHANNEL}; LISTEN ${PREVIEWS_CHANNEL}`);
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
            const message = this.worker.scrubbed(err);
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
      const settings = await this.store.settings().catch(() => this.worker.settings);
      const config = this.worker.resolved(settings);
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
        const etherscan = this.worker.etherscanClient(config);
        if (etherscan === null) return fail('No Etherscan key is set');
        // One key serves every chain; Ethereum when the console named none.
        await etherscan.ping(c.chainId ?? 1);
        return { ok: true, detail: {} };
      }
      if (c.kind !== 'rpc') return fail(`Unknown check: ${String(c.kind).slice(0, 40)}`);
      if (c.chainId === null) return fail('An RPC check needs a chain');
      const url = config.rpc.get(c.chainId);
      if (url === undefined) return fail(`No RPC is set for chain ${c.chainId}`);
      return { ok: true, detail: await this.worker.chain(c.chainId, url).check() };
    } catch (err) {
      // Every secret seen, not only this config's: `config` was built by resolved, so its own are among them.
      return fail(this.worker.scrubbed(err));
    }
  }
}
