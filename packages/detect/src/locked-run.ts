import type pg from 'pg';
import type { Halt } from './stored-sync.js';

/**
 * How often a download, a trail import or a worker pass looks that the
 * connection holding its lock is alive. A session that died without a word
 * frees the lock, and another replica could start the same part file or pass.
 */
const LOCK_CHECK_MS = 60_000;

/**
 * What a download and a trail import share while they run under their lock
 * (StoredSync.fetchStored, StoredSync.importTrail); a worker pass watches its
 * lock with it too, saying no progress (Worker.run). The client holding the
 * lock is idle for hours, out of the pool: no one hears its errors but this,
 * and an error unheard ends the process. Lost, or found dead by a look once a
 * minute, it stops the run as `lost`, since the lock went with it. The run's
 * progress is said on its collection at most once per 1%, in order,
 * fail-soft, and a write that finds the collection paused or deleted stops
 * the run, as the next pass would.
 *
 * A class because the client, the abort, what lost the lock, the chain of
 * writes and the last percent said are shared by everything the run does.
 */
export class LockedRun {
  /** What lost the connection holding the lock, once it is lost: the first error heard. */
  lost: unknown = null;
  /** The progress writes, in order, so a late write never overwrites the clear at the end. */
  writes = Promise.resolve();
  private writeFailed = false;
  private percent = 0;
  private readonly alive: ReturnType<typeof setInterval>;
  private readonly lose = (err: unknown): void => {
    this.lost ??= err;
    this.abort.abort('lost' satisfies Halt);
  };

  /**
   * Watches `client` from now until close, and says 0 at once. `write` says
   * a share done on the collection, false when it is paused or gone, which
   * stops the run through `abort`; `warn` says that a write failed, for the
   * first failure only.
   */
  constructor(
    private readonly client: pg.PoolClient,
    private readonly abort: AbortController,
    private readonly write: (share: number) => Promise<boolean>,
    private readonly warn: (err: unknown) => void,
  ) {
    client.on('error', this.lose);
    this.alive = setInterval(() => { client.query('SELECT 1').catch(this.lose); }, LOCK_CHECK_MS);
    this.alive.unref?.();
    this.say(0);
  }

  /** Say `share` done, once it is a whole percent past the last said. */
  progress(share: number): void {
    if (Math.floor(share * 100) <= this.percent) return;
    this.percent = Math.floor(share * 100);
    this.say(share);
  }

  /** Stop watching the client: the run is over, whatever its outcome. */
  close(): void {
    clearInterval(this.alive);
    this.client.removeListener('error', this.lose);
  }

  private say(share: number): void {
    this.writes = this.writes.then(async () => {
      try {
        if (!(await this.write(share))) this.abort.abort('stopped' satisfies Halt);
      } catch (err) {
        if (!this.writeFailed) this.warn(err);
        this.writeFailed = true;
      }
    });
  }
}
