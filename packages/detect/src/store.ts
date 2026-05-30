import pg from 'pg';
import { ZERO } from './graph.js';
import { traders } from './marketplaces.js';
import { MIGRATIONS } from './migrations.js';
import type { Rules } from './methods.js';
import { StoredDataError, type StoredDataFault, type StoredEntry, type WalletRow } from './stored.js';
import type { Analysis, Flag, Flow, Method, MethodTotals, Transfer, Witness } from './types.js';

/** pg_advisory_lock's first key: this product's namespace. The second is the job. */
const LOCK_NS = 0x77617368; // "wash"
const MIGRATE_JOB = 0;
/** Postgres's code for a row whose parent is gone. */
const FOREIGN_KEY_VIOLATION = '23503';
/** A batch of flags is cut at this many rows or this many characters of witness, whichever comes first. */
const FLAG_BATCH_ROWS = 10_000;
const FLAG_BATCH_CHARS = 16 * 2 ** 20;
/** Rows a cursor fetches at a time when stored data is cut. */
const CURSOR_PAGE = 10_000;
/** A load of stored data looks up from its work at most this often: Terraforms is a thousand batches. */
const RESTORE_CHECK_MS = 1_000;
/** Wallets a load queues per statement, in address order. */
const QUEUE_BATCH = 10_000;
/**
 * Why stored data could not be loaded, in the words the console shows. Only
 * why: what follows (the chain read instead, when the load is tried again)
 * depends on the chain's RPC, which the console knows. The full error goes to
 * the log.
 */
const RESTORE_NOTES: Readonly<Record<StoredDataFault | 'failed', string>> = {
  missing: 'Stored data could not be loaded: its file is missing.',
  mismatch: 'Stored data could not be loaded: its file does not match the manifest.',
  unreadable: 'Stored data could not be loaded: its file could not be read.',
  failed: 'Stored data could not be loaded.',
};
/** Thrown inside a load to stop it quietly: its collection was paused or deleted under it. */
const STOPPED = Symbol('restore stopped');

export interface CollectionRow {
  id: number;
  chainId: number;
  address: string;
  name: string | null;
  startBlock: number | null;
  cursorBlock: number | null;
  headBlock: number | null;
  addedAt: number;
  ingestedAt: number | null;
  error: string | null;
  errorAt: number | null;
  transfers: number;
  wallets: number;
  fundedWallets: number;
  /** True when something was written since the latest analysis. */
  stale: boolean;
  latest: AnalysisRow | null;
  /** When the worker last gave this collection a turn. Null until it has. */
  servedAt: number | null;
  /** Blocks a second the worker read here, smoothed. Null until it has read any. */
  readRate: number | null;
  /** Someone asked for this collection to be served first. */
  priority: boolean;
  /** When it was paused: the worker leaves it alone, its data kept. Null while it is watched. */
  pausedAt: number | null;
  /** How far a load of stored data has got, 0 to 1, while one runs. Null otherwise. */
  restoreProgress: number | null;
  /** Why stored data could not be loaded. Meanwhile the collection is read from the chain, if it has an RPC, and analysed on what it has. */
  restoreNote: string | null;
  /** What a load the data failed was about (storedKey). It is tried again once that changes. Null for any other failure. */
  restoreNoteKey: string | null;
  /** When a load the store failed is tried again, in ms. Null when none is waiting. */
  restoreRetryAt: number | null;
  /** Why its last analysis failed, kept until one is saved: meanwhile `latest` is the last that was. Null when none failed since. */
  analysisError: string | null;
  /** When an analysis that failed is tried again, in ms. Null when none failed. */
  analysisRetryAt: number | null;
  /** When the stored data it loaded stops, in ms. Null when none was loaded. */
  storedThroughTime: number | null;
  /** The block the stored data it loaded stops at. Null when none was loaded. */
  storedThroughBlock: number | null;
  /** The sha256 of the money trail loaded from stored data for it. Null when none was. */
  trailImportedSha: string | null;
  /** Why a money trail on disk was not loaded. It is not tried again until the file changes. */
  trailNote: string | null;
  /** This collection's overrides of RULES. Keys absent here follow the defaults. */
  rules: Partial<Rules>;
  /** What the contract says of itself. Null until the worker has read it. */
  contract: { name: string | null; symbol: string | null; creator: string | null; creationTx: string | null } | null;
}

/** A collection as its transfers so far describe it: what exists, who holds it, and when and where it traded. */
export interface CollectionProfile {
  /** Tokens minted and not burned. */
  supply: number;
  /** Wallets holding at least one of them. */
  holders: number;
  firstMint: number | null;
  firstSale: number | null;
  lastSale: number | null;
  /** Sales per marketplace, busiest first. */
  marketplaces: { name: string; sales: number }[];
}

/** A change to a collection's settings. An absent key is left alone; a null rule goes back to its default. */
export interface Configure {
  name?: string | null;
  /** Serve this collection first. Changes no flag, so it queues no analysis. */
  priority?: boolean;
  rules?: { [K in keyof Rules]?: number | null };
}

export type Bucket = 'hour' | 'day' | 'week' | 'month';

/** One bucket of a collection's history. `at` is the bucket's start, in ms. */
export interface TimelinePoint {
  at: number;
  transfers: number;
  sales: number;
  /** Sales each method flags. A method that did not run flags none, so read it with the analysis's `available`. */
  flaggedSales: Record<Method, number>;
}

export interface AnalysisRow {
  ranAt: number;
  tookMs: number;
  throughBlock: number | null;
  totals: Record<Method, MethodTotals>;
  missingData: number;
  fundedWallets: number;
  wallets: number;
  truncatedSearches: number;
}

export interface FlaggedTransfer extends Transfer {
  flags: Partial<Record<Method, Witness>>;
  /** Present on reads that span collections. */
  collection?: { chainId: number; address: string; name: string | null };
}

/** The wallets one collection (or, with a null id, the followed wallets) wants checked, best first. */
export interface FundingLane {
  collectionId: number | null;
  wallets: string[];
}

/**
 * Following money out of a wallet, for SCC AU. Funding is otherwise read only
 * for wallets that traded a collection, as the paper's dataset 3 was, so a
 * payment routed back through two outside wallets was never seen.
 */
export interface Follow {
  /** How many hops out from a trader to read. */
  hops: number;
  /** A wallet that paid more than this many wallets is a business or a bot; it is not followed. */
  fanout: number;
  /** Contracts never followed into: marketplaces, wrapped native tokens, the zero address. */
  exclude: readonly string[];
}

export interface PassRow {
  job: string;
  startedAt: number;
  finishedAt: number | null;
  tookMs: number | null;
  outcome: string | null;
  detail: string | null;
  /** When the pass last proved it was alive. Null until its first heartbeat. */
  heartbeatAt: number | null;
  /** What it is doing right now, in words. Null between turns. */
  doing: string | null;
  /** The collection it is on, or null. */
  subjectId: number | null;
}

/**
 * The settings that hold a secret: an RPC URL carries its provider's key.
 * Their values are kept in `settings`, which the worker needs, but never in
 * `setting_sources`, which the API reads, nor in anything the API returns.
 */
export const SECRET_KEYS = (key: string): boolean => key.startsWith('rpc.') || key === 'etherscan.key';

/** Where the worker found one setting. `value` is null for a secret. */
export interface SettingSource {
  source: 'env' | 'console';
  value: string | null;
}

/** A Test the console asked the worker to run. */
export type CheckKind = 'rpc' | 'etherscan';

/** The channel `requestCheck` notifies, so a listening worker runs the check at once rather than next pass. */
export const CHECKS_CHANNEL = 'washtrace_checks';

/** A collection waiting for analysis, as `Store.stale` reads it. */
export type StaleRow = Awaited<ReturnType<Store['stale']>>[number];

/**
 * Every read and write of the `washtrace` schema. A class because every one
 * of them needs the pool, and nothing else.
 */
export class Store {
  constructor(readonly pool: pg.Pool) {}

  static connect(url: string): Store {
    // Keep-alive probes find a connection that died without a word (a NAT's idle timeout, a host gone), so a
    // query on it errors instead of waiting forever. Probed after 30 seconds idle, not the OS's two hours.
    const pool = new pg.Pool({ connectionString: url, max: 10, application_name: 'washtrace', keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
    // An idle client's dropped connection is reported here; unheard, it ends the process.
    pool.on('error', (err) => console.error('[washtrace] store connection lost: %s', err.message));
    return new Store(pool);
  }

  /** Applies every migration the store lacks, under a lock so replicas starting together migrate once. */
  async migrate(): Promise<number> {
    return this.locked(MIGRATE_JOB, true, async (c) => {
      await c.query('CREATE SCHEMA IF NOT EXISTS washtrace');
      await c.query('CREATE TABLE IF NOT EXISTS washtrace.schema_version (version int NOT NULL, singleton bool NOT NULL DEFAULT true UNIQUE CHECK (singleton))');
      const { rows } = await c.query<{ version: number }>('SELECT version FROM washtrace.schema_version');
      const at = rows[0]?.version ?? 0;
      for (let v = at; v < MIGRATIONS.length; v++) {
        await c.query('BEGIN');
        try {
          await c.query(MIGRATIONS[v]!);
          await c.query(
            'INSERT INTO washtrace.schema_version (version) VALUES ($1) ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version',
            [v + 1],
          );
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      }
      return MIGRATIONS.length;
    }) as Promise<number>;
  }

  /**
   * Run `fn` holding job `job`'s advisory lock, or return `skipped` at once
   * when another replica holds it. This is what lets the same image run as
   * many API replicas while each worker pass runs in exactly one of them.
   */
  async locked<T>(job: number, wait: boolean, fn: (c: pg.PoolClient) => Promise<T>): Promise<T | 'skipped'> {
    const c = await this.pool.connect();
    try {
      if (wait) {
        await c.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NS, job]);
      } else {
        const { rows } = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_NS, job]);
        if (!rows[0]!.ok) return 'skipped';
      }
      try {
        return await fn(c);
      } finally {
        await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NS, job]).catch(() => {});
      }
    } finally {
      c.release();
    }
  }

  // ---- collections ---------------------------------------------------------

  async addCollection(chainId: number, address: string, name: string | null, startBlock: number | null): Promise<{ id: number; created: boolean }> {
    const { rows } = await this.pool.query<{ id: number; created: boolean }>(
      `INSERT INTO washtrace.collections (chain_id, address, name, start_block, cursor_block)
       VALUES ($1, $2, $3, $4::bigint, $4::bigint - 1)
       ON CONFLICT (chain_id, address) DO UPDATE SET name = COALESCE(EXCLUDED.name, washtrace.collections.name), paused_at = NULL
       RETURNING id, (xmax = 0) AS created`,
      [chainId, address, name, startBlock],
    );
    return rows[0]!;
  }

  /**
   * Delete a collection and, by cascade, its data, but only while it is paused:
   * the condition is in the SQL, so a resume racing the caller's own check can
   * never lead to a live collection being wiped. False when it is not there or
   * not paused; look it up to tell which.
   */
  async removeCollection(chainId: number, address: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM washtrace.collections WHERE chain_id = $1 AND address = $2 AND paused_at IS NOT NULL', [chainId, address]);
    return (rowCount ?? 0) > 0;
  }

  /** Stop the worker serving a collection, keeping its data. False when it is not there or already paused. */
  async pause(chainId: number, address: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE washtrace.collections SET paused_at = now() WHERE chain_id = $1 AND address = $2 AND paused_at IS NULL', [chainId, address]);
    return (rowCount ?? 0) > 0;
  }

  /** Let the worker serve a paused collection again. False when it is not there or not paused. */
  async resume(chainId: number, address: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE washtrace.collections SET paused_at = NULL WHERE chain_id = $1 AND address = $2 AND paused_at IS NOT NULL', [chainId, address]);
    return (rowCount ?? 0) > 0;
  }

  async collections(): Promise<CollectionRow[]> {
    const { rows } = await this.pool.query(`${COLLECTION_SELECT} ORDER BY c.added_at`);
    return rows.map(toCollection);
  }

  async collection(chainId: number, address: string): Promise<CollectionRow | null> {
    const { rows } = await this.pool.query(`${COLLECTION_SELECT} WHERE c.chain_id = $1 AND c.address = $2`, [chainId, address]);
    return rows[0] ? toCollection(rows[0]) : null;
  }

  /**
   * Apply `change` in one statement, so two edits at once both land. `||`
   * merges the rules and `jsonb_strip_nulls` drops the ones set to null. The
   * version moves only when the rules did: a rename or a priority changes no flag.
   * A rule change also ends the wait of an analysis that failed, which it may
   * fix: tried on the next pass, the failure still said until a run succeeds.
   */
  async configure(chainId: number, address: string, change: Configure): Promise<CollectionRow | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE washtrace.collections
       SET name = CASE WHEN $3 THEN $4 ELSE name END,
           priority = CASE WHEN $6::boolean IS NULL THEN priority ELSE $6 END,
           rules = jsonb_strip_nulls(rules || $5::jsonb),
           version = version + CASE WHEN jsonb_strip_nulls(rules || $5::jsonb) = rules THEN 0 ELSE 1 END,
           rules_at = CASE WHEN jsonb_strip_nulls(rules || $5::jsonb) = rules THEN rules_at ELSE now() END,
           analysis_retry_at = CASE WHEN jsonb_strip_nulls(rules || $5::jsonb) = rules THEN analysis_retry_at ELSE NULL END
       WHERE chain_id = $1 AND address = $2`,
      [chainId, address, change.name !== undefined, change.name ?? null, JSON.stringify(change.rules ?? {}), change.priority ?? null],
    );
    return rowCount === 0 ? null : this.collection(chainId, address);
  }

  /**
   * The worker gave this collection a turn that read `blocks` in `ms`. The
   * rate is smoothed (0.3 new, 0.7 old) so one slow turn does not resize the
   * next; the first reading stands alone. A turn with no usable duration or
   * a count of zero or less only marks the collection served.
   */
  async served(id: number, blocks: number, ms: number): Promise<void> {
    if (ms <= 0 || blocks <= 0) {
      await this.pool.query('UPDATE washtrace.collections SET served_at = now() WHERE id = $1', [id]);
      return;
    }
    const rate = blocks / (ms / 1000);
    await this.pool.query(
      'UPDATE washtrace.collections SET served_at = now(), read_rate = 0.3 * $2::float8 + 0.7 * coalesce(read_rate, $2::float8) WHERE id = $1',
      [id, rate],
    );
  }

  async setStart(id: number, block: number): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET start_block = $2::bigint, cursor_block = $2::bigint - 1 WHERE id = $1 AND start_block IS NULL', [id, block]);
  }

  /**
   * Keep what the contract says of itself. Read once: a contract's name,
   * symbol and deployer do not change. A collection watched without a name
   * takes the contract's; one given later replaces it.
   */
  async describe(id: number, facts: { name: string | null; symbol: string | null; creator: string | null; creationTx: string | null }): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.collections SET name = coalesce(name, $2), contract_name = $2, symbol = $3, creator = $4, creation_tx = $5, described_at = now()
       WHERE id = $1`,
      [id, facts.name, facts.symbol, facts.creator, facts.creationTx],
    );
  }

  /** The collection as its transfers so far describe it. A token's holder is the receiver of its latest transfer. */
  async profile(id: number): Promise<CollectionProfile> {
    const [{ rows: [r] }, { rows: markets }] = await Promise.all([
      this.pool.query(`
        WITH latest AS (
          SELECT DISTINCT ON (token_id) to_address FROM washtrace.transfers
          WHERE collection_id = $1 ORDER BY token_id, block_number DESC, log_index DESC
        )
        SELECT (SELECT count(*)::int FROM latest WHERE to_address <> $2) AS supply,
               (SELECT count(DISTINCT to_address)::int FROM latest WHERE to_address <> $2) AS holders,
               extract(epoch FROM min(block_time) FILTER (WHERE from_address = $2))::float8 AS first_mint,
               extract(epoch FROM min(block_time) FILTER (WHERE marketplace IS NOT NULL))::float8 AS first_sale,
               extract(epoch FROM max(block_time) FILTER (WHERE marketplace IS NOT NULL))::float8 AS last_sale
        FROM washtrace.transfers WHERE collection_id = $1`, [id, ZERO]),
      this.pool.query(`
        SELECT marketplace AS name, count(*)::int AS sales FROM washtrace.transfers
        WHERE collection_id = $1 AND marketplace IS NOT NULL GROUP BY marketplace ORDER BY sales DESC, marketplace`, [id]),
    ]);
    const ms = (v: number | null) => (v === null ? null : v * 1000);
    return { supply: r.supply, holders: r.holders, firstMint: ms(r.first_mint), firstSale: ms(r.first_sale), lastSale: ms(r.last_sale), marketplaces: markets };
  }

  async setHead(id: number, head: number): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET head_block = $2 WHERE id = $1', [id, head]);
  }

  async setError(id: number, message: string | null): Promise<void> {
    await this.pool.query(
      'UPDATE washtrace.collections SET error = $2, error_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1',
      [id, message],
    );
  }

  /**
   * Store one span's transfers and move the cursor past it, together: a crash
   * between the two would otherwise skip the span or read it twice. Wallets
   * enter the funding queue here, weighted by how often they traded.
   */
  async ingest(id: number, chainId: number, transfers: readonly Transfer[], through: number, queue: readonly string[]): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await insertTransfers(c, id, transfers);
      await queueWallets(c, chainId, tally(queue));
      await c.query(
        `UPDATE washtrace.collections SET cursor_block = $2, ingested_at = now(), error = NULL, error_at = NULL,
           version = version + CASE WHEN $3 THEN 1 ELSE 0 END WHERE id = $1`,
        [id, through, transfers.length > 0],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * Load a collection's stored data: every transfer in `batches`, then its
   * wallets queued and the cursor moved to where the data stops, all in one
   * transaction, so nothing (analysis included) ever sees half a load. A
   * transfer already read is kept, and only the ones new here count toward
   * their wallets, as ingest counts them. One batch is held at a time: a big
   * collection is millions of rows.
   *
   * Wallets are queued once, at the end, in address order: queued per batch,
   * their rows stayed locked for the whole load, and funding, which writes
   * them, waited minutes or deadlocked with it. Their counts are tallied
   * meanwhile: far fewer traders than transfers.
   *
   * About once a second, from a connection of its own (the transaction's
   * writes are invisible until it commits), the load writes its progress and
   * looks whether its collection was paused or deleted. Either stops it
   * quietly, as saveAnalysis drops an analysis whose collection went: so a
   * Delete, allowed only once paused, waits at most that second, not the
   * whole load. Neither look ever waits on a lock.
   *
   * On failure nothing is kept and the progress is cleared, and a note says
   * so. Bad stored data (a StoredDataError) is noted with `key`, what the
   * load was about (storedKey), and is not tried again until that changes.
   * Any other error (a full disk, a lost connection) waits as a failed
   * analysis does: five minutes, doubling with each failure in a row, up to
   * an hour. Either way it is thrown on. A load that goes through clears all
   * of it.
   */
  async restore(id: number, chainId: number, entry: StoredEntry, batches: AsyncIterable<Transfer[]>, key: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      // Shown at once: the whole file is checked against its sha256 before the first batch.
      await this.pool.query('UPDATE washtrace.collections SET restore_progress = 0 WHERE id = $1', [id]);
      let checked = Date.now();
      let loaded = 0;
      const counts = new Map<string, number>();
      await c.query('BEGIN');
      for await (const batch of batches) {
        if (Date.now() - checked >= RESTORE_CHECK_MS) {
          if (!(await this.restoreGoesOn(id, Math.min(1, loaded / Math.max(1, entry.transfers.rows))))) throw STOPPED;
          checked = Date.now();
        }
        const added = await insertTransfers(c, id, batch).catch((err) => { throw asDataFault(err); });
        for (const a of traders(chainId, added)) counts.set(a, (counts.get(a) ?? 0) + 1);
        loaded += batch.length;
      }
      // Once more before the wallets and the cursor are written: a pause in the last second still stops it.
      if (!(await this.restoreGoesOn(id, null))) throw STOPPED;
      await queueWallets(c, chainId, counts);
      // LEAST and GREATEST skip a null, so a collection with no start yet takes the stored one.
      await c.query(
        `UPDATE washtrace.collections SET start_block = LEAST(start_block, $2::bigint), cursor_block = GREATEST(cursor_block, $3::bigint),
           stored_through_time = to_timestamp($4::float8 / 1000), stored_through_block = $3::bigint, restore_progress = NULL,
           restore_note = NULL, restore_note_key = NULL, restore_failures = 0, restore_retry_at = NULL, version = version + 1
         WHERE id = $1`,
        [id, entry.startBlock, entry.throughBlock, entry.throughTime],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      // After the rollback, so a Delete waiting on the load has gone through and this finds nothing to wait on.
      // A load stopped by a pause or a Delete is no failure: only its progress goes.
      const stopped = err === STOPPED || (err as { code?: string }).code === FOREIGN_KEY_VIOLATION;
      const write = stopped
        ? this.pool.query('UPDATE washtrace.collections SET restore_progress = NULL WHERE id = $1', [id])
        : err instanceof StoredDataError
          ? this.pool.query(
            `UPDATE washtrace.collections SET restore_progress = NULL, restore_note = $2, restore_note_key = $3, restore_failures = 0, restore_retry_at = NULL
             WHERE id = $1`,
            [id, RESTORE_NOTES[err.kind], key],
          )
          // The old count on the right: the first failure waits five minutes. The power is capped so it never overflows.
          : this.pool.query(
            `UPDATE washtrace.collections SET restore_progress = NULL, restore_note = $2, restore_note_key = NULL, restore_failures = restore_failures + 1,
               restore_retry_at = now() + make_interval(secs => LEAST(3600, 300 * power(2, LEAST(restore_failures, 4))))
             WHERE id = $1`,
            [id, RESTORE_NOTES.failed],
          );
      await write.catch(() => {});
      if (stopped) return;
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * Whether a load may go on: its collection is still there and not paused.
   * Writes `progress` too, unless null. A plain read never waits, and the
   * write skips a row it would have to wait for (a Delete queued on the
   * load), so the load is never stuck behind something waiting on it.
   */
  private async restoreGoesOn(id: number, progress: number | null): Promise<boolean> {
    const { rows } = await this.pool.query<{ paused: boolean }>('SELECT paused_at IS NOT NULL AS paused FROM washtrace.collections WHERE id = $1', [id]);
    if (rows.length === 0 || rows[0]!.paused) return false;
    if (progress !== null) {
      await this.pool.query(
        `UPDATE washtrace.collections SET restore_progress = $2
         WHERE id = (SELECT id FROM washtrace.collections WHERE id = $1 FOR NO KEY UPDATE SKIP LOCKED)`,
        [id, progress],
      );
    }
    return true;
  }

  /**
   * Forget why a collection's stored data was not loaded, and any wait: the
   * worker found the stored data no longer applies (gone from the manifest,
   * or read past), so nothing about it is true any more.
   */
  async clearRestoreNote(id: number): Promise<void> {
    await this.pool.query(
      'UPDATE washtrace.collections SET restore_note = NULL, restore_note_key = NULL, restore_failures = 0, restore_retry_at = NULL WHERE id = $1',
      [id],
    );
  }

  /**
   * Forget every load's progress. For a worker starting: a load that was
   * running when the last one died rolled back, but its progress, written
   * outside the load, would otherwise say "Loading stored data" for ever.
   */
  async clearRestoreProgress(): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET restore_progress = NULL WHERE restore_progress IS NOT NULL');
  }

  /**
   * Load a money trail another store cut (see trail): its flows, then its
   * wallets, then the mark that this collection has it. `open` reads the
   * trail from its start, wallets first, as readTrail does; it is read twice.
   *
   * Every flow goes in before any wallet is marked done. A done wallet is
   * never read again, so one marked done before its flows were in, with the
   * load cut off between the two, would be a gap for good. Flows alone claim
   * nothing, so each batch commits on its own.
   *
   * Then the wallets, one short statement a batch, in address order as
   * queueWallets writes them: held for a whole load, their rows kept funding
   * waiting and deadlocked with it, as a load of stored data once did. A
   * wallet this store already checked keeps its own check. One still to
   * check here takes the trail's check, if it has one. Either way it keeps
   * its own transfer count (the trail's counts the other store's
   * collections) and takes the nearer of the two depths. A wallet new here
   * comes in done or still to check, as the trail has it, with no transfer
   * counted: this store counts its own as it reads them.
   *
   * Only then is the trail's sha recorded and every collection on the chain
   * queued for analysis, in one statement. A load cut off anywhere is safe
   * to run again from the start, and ends as one clean run does. Returns
   * how many wallets and flows the trail held.
   */
  async importTrail(id: number, chainId: number, sha256: string, open: () => AsyncIterable<{ wallets: WalletRow[]; flows: Flow[] }>): Promise<{ wallets: number; flows: number }> {
    let flows = 0;
    for await (const batch of open()) {
      await insertFlows(this.pool, chainId, batch.flows).catch((err) => { throw asDataFault(err); });
      flows += batch.flows.length;
    }
    let wallets = 0;
    for await (const batch of open()) {
      // The wallets come first; past them are only flows, all in already.
      if (batch.wallets.length === 0) break;
      const rows = [...batch.wallets].sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
      const done = rows.map((r) => r.status === 'done');
      // Funding locks a wallet and then collections, so this can still deadlock with it, rarely: Postgres ends one, and it is retried.
      await this.pool.query(
        `INSERT INTO washtrace.wallets (chain_id, address, transfers, status, truncated, fetched_at, depth)
         SELECT $1, a, 0, s, tr, to_timestamp(fa / 1000), d FROM unnest($2::text[], $3::text[], $4::bool[], $5::float8[], $6::int[]) AS u(a, s, tr, fa, d)
         ORDER BY a
         ON CONFLICT (chain_id, address) DO UPDATE SET
           status = CASE WHEN washtrace.wallets.status <> 'done' AND EXCLUDED.status = 'done' THEN 'done' ELSE washtrace.wallets.status END,
           truncated = CASE WHEN washtrace.wallets.status <> 'done' AND EXCLUDED.status = 'done' THEN EXCLUDED.truncated ELSE washtrace.wallets.truncated END,
           fetched_at = CASE WHEN washtrace.wallets.status <> 'done' AND EXCLUDED.status = 'done' THEN EXCLUDED.fetched_at ELSE washtrace.wallets.fetched_at END,
           error = CASE WHEN washtrace.wallets.status <> 'done' AND EXCLUDED.status = 'done' THEN NULL ELSE washtrace.wallets.error END,
           depth = LEAST(washtrace.wallets.depth, EXCLUDED.depth)`,
        [
          // A wallet the trail has failed is one to check here: 'failed' says this store tried.
          chainId, rows.map((r) => r.address), done.map((d) => (d ? 'done' : 'pending')), rows.map((r, i) => done[i] && r.truncated),
          rows.map((r, i) => (done[i] ? r.fetchedAt : null)), rows.map((r) => r.depth),
        ],
      ).catch((err) => { throw asDataFault(err); });
      wallets += rows.length;
    }
    // Locked in id order, so two writers of the chain's collections never wait on each other in a circle.
    await this.pool.query(
      `UPDATE washtrace.collections SET version = version + 1,
         trail_imported_sha = CASE WHEN id = $2 THEN $3 ELSE trail_imported_sha END,
         trail_note = CASE WHEN id = $2 THEN NULL ELSE trail_note END
       WHERE id IN (SELECT id FROM washtrace.collections WHERE chain_id = $1 ORDER BY id FOR NO KEY UPDATE)`,
      [chainId, id, sha256],
    );
    return { wallets, flows };
  }

  /** Say why a money trail on disk was not loaded, or with null that nothing is wrong. */
  async setTrailNote(id: number, note: string | null): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET trail_note = $2 WHERE id = $1', [id, note]);
  }

  /**
   * Whether a collection's money lenses have funding to run on with no key:
   * it loaded a money trail of its own, and some wallet on its chain is
   * checked. Another collection's trail is not enough: its lenses would read
   * as floors over a check that, with no key, never moves.
   */
  async importedFunding(id: number): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM washtrace.wallets w WHERE w.chain_id = c.chain_id AND w.status = 'done') AS ok
       FROM washtrace.collections c WHERE c.id = $1 AND c.trail_imported_sha IS NOT NULL`,
      [id],
    );
    return rows[0]?.ok ?? false;
  }

  // ---- funding -------------------------------------------------------------

  /**
   * The wallets to read funding for next, in lanes so one big collection cannot
   * crowd out the rest: one lane per collection on the chain that is not paused (its traders),
   * and a last lane for followed wallets (depth > 0), which trade in no collection,
   * there only while some collection is in sync to read them for.
   * Each lane is at most `perLane` long: failed wallets last (they retry after
   * an hour), then the shallowest, then the busiest. A trader of two
   * collections is in both lanes; `interleave` checks it once. Which wallets
   * a lane can hold is SERVED_*'s: fundingBacklog counts with them too.
   */
  async fundingLanes(chainId: number, perLane: number): Promise<{ lanes: FundingLane[] }> {
    const unchecked = `w.chain_id = $1 AND (w.status = 'pending' OR (w.status = 'failed' AND w.fetched_at < now() - interval '1 hour'))`;
    const order = `ORDER BY w.status = 'failed', w.depth, w.transfers DESC`; // followed lane only
    // Start from the unchecked traders (few, and none in steady state), then probe
    // each collection's transfers by index for whether it names them. Followed
    // wallets (depth > 0) trade in no collection: their own lane, never a probe.
    const { rows } = await this.pool.query<{ id: number; address: string | null }>(
      `WITH todo AS MATERIALIZED (
         SELECT w.address, w.status, w.depth, w.transfers FROM washtrace.wallets w WHERE ${unchecked} AND w.depth = 0
       )
       SELECT c.id, l.address FROM washtrace.collections c
       LEFT JOIN LATERAL (
         SELECT address, rn FROM (
           SELECT w.address, row_number() OVER (ORDER BY w.status = 'failed', w.depth, w.transfers DESC) AS rn FROM todo w
           WHERE ${SERVED_NAMES}
         ) ranked WHERE rn <= $2
       ) l ON true
       WHERE c.chain_id = $1 AND ${SERVED_LIVE} ORDER BY c.id, l.rn`,
      [chainId, perLane],
    );
    const lanes: FundingLane[] = [];
    for (const r of rows) {
      let lane = lanes.at(-1);
      if (lane?.collectionId !== r.id) lanes.push((lane = { collectionId: r.id, wallets: [] }));
      if (r.address !== null) lane.wallets.push(r.address);
    }
    // Some collection on the chain is live: SERVED_WALLET's test for a followed wallet.
    if (lanes.length > 0) {
      const followed = await this.pool.query<{ address: string }>(
        `SELECT w.address FROM washtrace.wallets w WHERE ${unchecked} AND w.depth > 0 ${order} LIMIT $2`,
        [chainId, perLane],
      );
      if (followed.rows.length > 0) lanes.push({ collectionId: null, wallets: followed.rows.map((r) => r.address) });
    }
    return { lanes };
  }

  /**
   * Store a wallet's flows and take it off the queue. With `follow`, queue
   * the wallets it sent money to, one hop further out: see Follow.
   */
  async fund(chainId: number, wallet: string, flows: readonly Flow[], truncated: boolean, follow?: Follow): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await insertFlows(c, chainId, flows);
      await c.query(
        `UPDATE washtrace.wallets SET status = 'done', truncated = $3, fetched_at = now(), error = NULL WHERE chain_id = $1 AND address = $2`,
        [chainId, wallet, truncated],
      );
      if (follow && !truncated) {
        const skip = new Set(follow.exclude);
        const sent = [...new Set(flows.filter((f) => f.from === wallet && f.to !== wallet && !skip.has(f.to)).map((f) => f.to))];
        if (sent.length > 0 && sent.length <= follow.fanout) {
          await c.query(
            `INSERT INTO washtrace.wallets (chain_id, address, depth)
             SELECT $1, a, w.depth + 1 FROM unnest($2::text[]) AS a, washtrace.wallets w
             WHERE w.chain_id = $1 AND w.address = $3 AND w.depth < $4
             ON CONFLICT (chain_id, address) DO NOTHING`,
            [chainId, sent, wallet, follow.hops],
          );
        }
      }
      // Every collection this wallet or any counterparty traded in reads it
      // again: a followed wallet's flows can close a path to a trader.
      const touched = [...new Set([wallet, ...flows.flatMap((f) => [f.from, f.to])])];
      // Locked in id order, as a loaded trail's bump locks them, so two writers never wait on each other in a circle.
      await c.query(
        `UPDATE washtrace.collections SET version = version + 1
         WHERE id IN (
           SELECT id FROM washtrace.collections
           WHERE id IN (SELECT DISTINCT collection_id FROM washtrace.transfers WHERE from_address = ANY($2) OR to_address = ANY($2))
             AND chain_id = $1
           ORDER BY id FOR NO KEY UPDATE)`,
        [chainId, touched],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async fundingFailed(chainId: number, wallet: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.wallets SET status = 'failed', fetched_at = now(), error = $3 WHERE chain_id = $1 AND address = $2`,
      [chainId, wallet, message],
    );
  }

  /**
   * Each chain's wallets by funding state. `pending` and `failed` are the
   * ones a lane will serve (SERVED_WALLET, from what fundingLanes builds on),
   * so the wait drains to nothing; `stranded` are the unchecked rest, held
   * back while every collection that names them is paused or removed, and no
   * lane takes them. The status route and the Worker page read this every
   * few seconds.
   */
  async fundingBacklog(): Promise<{ chainId: number; pending: number; done: number; failed: number; stranded: number; truncated: number; followed: number; doneLastHour: number }[]> {
    // Only the unchecked wallets are probed, each once (MATERIALIZED, so the
    // probe is not repeated in every count that reads it). Stranded ones
    // dominate the cost and are permanent: deleting a collection keeps its
    // wallets, and no lane ever checks them. The planner's estimate for the
    // probes is far above JIT's threshold, and compiling cost twice the query
    // itself (430 ms against 150 at 26k stranded wallets), so JIT is off.
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL jit = off');
      const { rows } = await c.query(
        `WITH waiting AS MATERIALIZED (
           SELECT w.chain_id, w.status, ${SERVED_WALLET} AS served FROM washtrace.wallets w WHERE w.status IN ('pending', 'failed')
         ), unchecked AS (
           SELECT chain_id, count(*) FILTER (WHERE status = 'pending' AND served)::int AS pending,
                  count(*) FILTER (WHERE status = 'failed' AND served)::int AS failed, count(*) FILTER (WHERE NOT served)::int AS stranded
           FROM waiting GROUP BY chain_id
         )
         SELECT w.chain_id, coalesce(u.pending, 0) AS pending, coalesce(u.failed, 0) AS failed, coalesce(u.stranded, 0) AS stranded,
                count(*) FILTER (WHERE w.status = 'done')::int AS done,
                count(*) FILTER (WHERE w.status = 'done' AND w.fetched_at > now() - interval '1 hour')::int AS done_last_hour,
                count(*) FILTER (WHERE w.truncated)::int AS truncated, count(*) FILTER (WHERE w.depth > 0)::int AS followed
         FROM washtrace.wallets w LEFT JOIN unchecked u ON u.chain_id = w.chain_id
         GROUP BY w.chain_id, u.pending, u.failed, u.stranded ORDER BY w.chain_id`,
      );
      await c.query('COMMIT');
      return rows.map((r) => ({
        chainId: r.chain_id, pending: r.pending, done: r.done, failed: r.failed, stranded: r.stranded, truncated: r.truncated, followed: r.followed, doneLastHour: r.done_last_hour,
      }));
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  // ---- analysis ------------------------------------------------------------

  /**
   * Collections written to since their latest analysis, with the version each
   * analysis will record and the rules it runs under, read together: a rule
   * changed mid-analysis moves the version, so the collection runs again.
   * When the latest analysis ran and how long it took come along, so the
   * worker can space out the reruns of a collection that is always changing,
   * and when its rules last changed, so a rule edit is not made to wait.
   * `retryAt` is when one whose analysis failed may be tried again (see
   * analysisFailed): null when none failed.
   */
  async stale(): Promise<{
    id: number; chainId: number; version: number; rules: Partial<Rules>; name: string | null;
    ranAt: number | null; tookMs: number | null; rulesAt: number | null; retryAt: number | null;
  }[]> {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.chain_id, c.version, c.rules, c.name, a.took_ms, extract(epoch FROM a.ran_at)::float8 AS ran,
              extract(epoch FROM c.rules_at)::float8 AS rules_changed, extract(epoch FROM c.analysis_retry_at)::float8 AS retry
       FROM washtrace.collections c
       LEFT JOIN LATERAL (SELECT ran_at, took_ms FROM washtrace.analyses x WHERE x.collection_id = c.id ORDER BY x.ran_at DESC LIMIT 1) a ON true
       WHERE c.version > c.analyzed_version AND c.paused_at IS NULL ORDER BY c.id`,
    );
    return rows.map((r) => ({
      id: r.id, chainId: r.chain_id, version: Number(r.version), rules: r.rules, name: r.name,
      ranAt: r.ran === null ? null : r.ran * 1000, tookMs: r.took_ms, rulesAt: r.rules_changed === null ? null : r.rules_changed * 1000,
      retryAt: r.retry === null ? null : r.retry * 1000,
    }));
  }

  /** What `analyze` reads for one collection: its transfers, and the flows and funding state of its wallets. */
  async analysisInput(id: number, chainId: number): Promise<{
    transfers: Transfer[]; flows: Flow[]; funded: Set<string>; truncated: Set<string>; through: number | null;
  }> {
    const transfers = (await this.pool.query(`${TRANSFER_SELECT} WHERE t.collection_id = $1`, [id])).rows.map(toTransfer);
    // The collection's wallets go in as an array, not as a subquery. As an
    // IN subquery, thousands of them were too many to hash in work_mem, and
    // Postgres walked the whole list once per flow on the chain: 56 minutes
    // for Terraforms. An array it hashes, or probes the flows indexes with.
    const wallets = [...new Set(transfers.flatMap((t) => [t.from, t.to]))];
    const followed = (await this.pool.query<{ address: string }>(
      `SELECT address FROM washtrace.wallets WHERE chain_id = $1 AND depth > 0 AND status = 'done'`,
      [chainId],
    )).rows.map((r) => r.address);
    const flows = (await this.pool.query(
      // The columns toFlow reads and no more: millions of rows, and a timestamptz parsed into a Date for each was seconds.
      `SELECT f.tx_hash, f.kind, f.from_address, f.to_address, f.value_wei, f.token, f.block_number,
              extract(epoch FROM f.block_time)::float8 AS bt FROM washtrace.flows f
       WHERE f.chain_id = $1 AND (f.from_address = ANY($2::text[]) OR f.to_address = ANY($2::text[])
         -- Followed wallets' payments onward: the middle of a path SCC AU follows back.
         OR f.from_address = ANY($3::text[]))`,
      [chainId, wallets, followed],
    )).rows.map(toFlow);
    const state = (await this.pool.query<{ address: string; truncated: boolean }>(
      `SELECT address, truncated FROM washtrace.wallets WHERE chain_id = $1 AND status = 'done' AND (address = ANY($2::text[]) OR depth > 0)`,
      [chainId, wallets],
    )).rows;
    const { rows } = await this.pool.query<{ cursor_block: string | null }>('SELECT cursor_block FROM washtrace.collections WHERE id = $1', [id]);
    return {
      transfers,
      flows,
      funded: new Set(state.map((s) => s.address)),
      truncated: new Set(state.filter((s) => s.truncated).map((s) => s.address)),
      through: rows[0]?.cursor_block == null ? null : Number(rows[0].cursor_block),
    };
  }

  /**
   * Record an analysis and replace the collection's flags with its own, and
   * forget any analysis that failed before it. A collection removed while
   * its analysis ran has nowhere to keep it, so the analysis is dropped
   * quietly: the removal was asked for, not a failure.
   */
  async saveAnalysis(id: number, version: number, analysis: Analysis, tookMs: number, through: number | null): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO washtrace.analyses (collection_id, took_ms, through_block, totals, missing_data, funded_wallets, wallets, truncated_searches)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, tookMs, through, JSON.stringify(analysis.totals), analysis.missingData, analysis.fundedWallets, analysis.wallets, analysis.truncatedSearches],
      );
      await c.query('DELETE FROM washtrace.flags WHERE collection_id = $1', [id]);
      // A component's flags share one witness, and the three methods share
      // an SCC's: each is written out once. The flags go in batches, so no
      // one parameter holds every witness: at two million flags that one
      // string was past what the heap would hold.
      const json = new Map<Witness, string>();
      const witness = (w: Witness) => {
        let s = json.get(w);
        if (s === undefined) json.set(w, (s = JSON.stringify(w)));
        return s;
      };
      const f: readonly Flag[] = analysis.flags;
      for (let at = 0; at < f.length;) {
        const batch: Flag[] = [];
        const ws: string[] = [];
        for (let size = 0; at < f.length && batch.length < FLAG_BATCH_ROWS && size < FLAG_BATCH_CHARS; at++) {
          batch.push(f[at]!);
          ws.push(witness(f[at]!.witness));
          size += ws.at(-1)!.length;
        }
        await c.query(
          `INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness)
           SELECT $1, m, tx, li, w FROM unnest($2::text[], $3::text[], $4::int[], $5::jsonb[]) AS u(m, tx, li, w)`,
          [id, batch.map((x) => x.method), batch.map((x) => x.txHash), batch.map((x) => x.logIndex), ws],
        );
      }
      await c.query(
        `UPDATE washtrace.collections SET analyzed_version = GREATEST(analyzed_version, $2), analysis_failures = 0, analysis_error = NULL, analysis_retry_at = NULL
         WHERE id = $1`,
        [id, version],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) return;
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * Note on a collection that its analysis failed, and why (`error`, already
   * scrubbed: it reaches the API), so the console says so until one is
   * saved, and set when it is tried again: five minutes, doubling with each
   * failure in a row, up to an hour. Meanwhile the others are analysed: a
   * failure writes nothing else, so without the wait the same collection
   * would stay first and be tried every pass. Here, not in the worker's
   * memory, so a restarted worker waits too.
   */
  async analysisFailed(id: number, error: string): Promise<void> {
    // The old count on the right: the first failure waits five minutes. The power is capped so it never overflows.
    await this.pool.query(
      `UPDATE washtrace.collections SET analysis_error = $2, analysis_failures = analysis_failures + 1,
         analysis_retry_at = now() + make_interval(secs => LEAST(3600, 300 * power(2, LEAST(analysis_failures, 4))))
       WHERE id = $1`,
      [id, error],
    );
  }

  async history(id: number, limit = 100): Promise<AnalysisRow[]> {
    const { rows } = await this.pool.query(
      `SELECT *, extract(epoch FROM ran_at)::float8 AS ran FROM washtrace.analyses WHERE collection_id = $1 ORDER BY ran_at DESC LIMIT $2`,
      [id, limit],
    );
    return rows.map(toAnalysis).reverse();
  }

  // ---- stored data --------------------------------------------------------

  /**
   * What a stored-data cut of a collection starts from: where its data
   * begins and ends. The snapshot stops at the cursor, and its time is that
   * of the latest transfer at or below it. Null when it is not watched; the
   * blocks and time are null until it has read some.
   */
  async storedHeader(chainId: number, address: string): Promise<{
    id: number; name: string; startBlock: number | null; throughBlock: number | null; throughTime: number | null;
  } | null> {
    const { rows } = await this.pool.query(
      `SELECT c.id, COALESCE(c.name, c.contract_name, c.address) AS name, c.start_block, c.cursor_block,
              (SELECT extract(epoch FROM max(t.block_time))::float8 FROM washtrace.transfers t
               WHERE t.collection_id = c.id AND t.block_number <= c.cursor_block) AS through
       FROM washtrace.collections c WHERE c.chain_id = $1 AND c.address = lower($2)`,
      [chainId, address],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, name: r.name, startBlock: r.start_block === null ? null : Number(r.start_block),
      throughBlock: r.cursor_block === null ? null : Number(r.cursor_block), throughTime: r.through === null ? null : r.through * 1000,
    };
  }

  /** A collection's transfers up to block `through`, in chain order, streamed for writing to a file. */
  storedTransfers(id: number, through: number): AsyncGenerator<Transfer> {
    return this.cursor(
      `${TRANSFER_COLUMNS} FROM washtrace.transfers t WHERE t.collection_id = $1 AND t.block_number <= $2 ORDER BY t.block_number, t.log_index`,
      [id, through], toTransfer,
    );
  }

  /**
   * A collection's money trail: the wallets checked so far and the flows they
   * found. The same wallets and flows `analysisInput` reads, so a store that
   * imports the trail analyses the collection as this one does: its traders,
   * and every followed wallet on the chain. `checked` of `of` is how many of
   * its traders have been read. The rows stream; nothing is read until they
   * are iterated, wallets before flows.
   *
   * An importing install never reads a done wallet again, so every done
   * wallet in the file carries all of its flows, in and out. The followed
   * wallets are fixed when the trail is begun, and both streams use that
   * list: one checked later is left out, not written done without the flows
   * nobody looked for. Traders need no such care, since flows to or from
   * them are all read, and only grow between the two streams.
   *
   * The followed wallets not yet checked (pending, or failed here) go in
   * too, as pending: the frontier this store would have read next. An
   * importing install with a key follows on from there, rather than from
   * the traders alone. Wallets are in address order, as importTrail writes them.
   */
  async trail(id: number, chainId: number): Promise<{ checked: number; of: number; wallets: AsyncGenerator<WalletRow>; flows: AsyncGenerator<Flow> }> {
    // Arrays, not subqueries, for the reason analysisInput gives.
    const traders = (await this.pool.query<{ address: string }>(
      `SELECT from_address AS address FROM washtrace.transfers WHERE collection_id = $1
       UNION SELECT to_address FROM washtrace.transfers WHERE collection_id = $1`,
      [id],
    )).rows.map((r) => r.address);
    const followed = (await this.pool.query<{ address: string }>(
      `SELECT address FROM washtrace.wallets WHERE chain_id = $1 AND depth > 0 AND status = 'done'`,
      [chainId],
    )).rows.map((r) => r.address);
    // A followed wallet still to check: written as pending, whether it is pending or failed here.
    const frontier = `(depth > 0 AND status <> 'done')`;
    const { rows } = await this.pool.query<{ checked: number; of: number }>(
      `SELECT count(*) FILTER (WHERE status = 'done')::int AS checked, count(*)::int AS of
       FROM washtrace.wallets WHERE chain_id = $1 AND address = ANY($2::text[])`,
      [chainId, traders],
    );
    return {
      checked: rows[0]!.checked,
      of: rows[0]!.of,
      wallets: this.cursor(
        `SELECT address, transfers, CASE WHEN ${frontier} THEN 'pending' ELSE status END AS status,
                truncated AND NOT ${frontier} AS truncated, CASE WHEN ${frontier} THEN NULL ELSE extract(epoch FROM fetched_at)::float8 END AS fetched, depth
         FROM washtrace.wallets
         WHERE chain_id = $1 AND ((status <> 'pending' AND (address = ANY($2::text[]) OR address = ANY($3::text[]))) OR ${frontier})
         ORDER BY address`,
        [chainId, traders, followed],
        (r): WalletRow => ({
          address: r.address, transfers: r.transfers, status: r.status, truncated: r.truncated, depth: r.depth,
          fetchedAt: r.fetched === null ? null : r.fetched * 1000,
        }),
      ),
      flows: this.cursor(
        `SELECT f.tx_hash, f.kind, f.from_address, f.to_address, f.value_wei, f.token, f.block_number,
                extract(epoch FROM f.block_time)::float8 AS bt FROM washtrace.flows f
         WHERE f.chain_id = $1 AND (f.from_address = ANY($2::text[]) OR f.to_address = ANY($2::text[])
           OR f.from_address = ANY($3::text[]) OR f.to_address = ANY($3::text[]))
         -- A total order: the same flows cut again give the same file, and the same sha256.
         ORDER BY f.block_number, f.tx_hash, f.kind, f.from_address, f.to_address, f.token, f.value_wei`,
        [chainId, traders, followed], toFlow,
      ),
    };
  }

  /**
   * The rows of `sql`, a page at a time through a server-side cursor, so
   * millions of them stream rather than land in memory. One read-only
   * transaction, so the rows are one snapshot. Leaving the loop early (a
   * failed write) closes the cursor and gives the connection back.
   */
  private async *cursor<T>(sql: string, params: unknown[], map: (r: any) => T): AsyncGenerator<T> {
    const c = await this.pool.connect();
    let finished = false;
    try {
      await c.query('BEGIN READ ONLY');
      await c.query(`DECLARE stored NO SCROLL CURSOR FOR ${sql}`, params);
      for (;;) {
        const { rows } = await c.query(`FETCH ${CURSOR_PAGE} FROM stored`);
        for (const r of rows) yield map(r);
        if (rows.length < CURSOR_PAGE) break;
      }
      await c.query('COMMIT');
      finished = true;
    } finally {
      if (!finished) await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  // ---- reads for the console and the API ----------------------------------

  /** Tokens ranked by flagged transfers under `method`, a page at a time. */
  async topTokens(id: number, method: Method, limit = 50, offset = 0): Promise<{ tokenId: string; transfers: number; flagged: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT t.token_id::text AS token_id, count(*)::int AS transfers, count(f.tx_hash)::int AS flagged
       FROM washtrace.transfers t
       LEFT JOIN washtrace.flags f ON f.collection_id = t.collection_id AND f.method = $2 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index
       WHERE t.collection_id = $1 GROUP BY t.token_id HAVING count(f.tx_hash) > 0
       ORDER BY flagged DESC, transfers DESC, t.token_id LIMIT $3 OFFSET $4`,
      [id, method, limit, offset],
    );
    return rows.map((r) => ({ tokenId: r.token_id, transfers: r.transfers, flagged: r.flagged }));
  }

  /** Wallets ranked by flagged transfers they sent or received under `method`, a page at a time. */
  async topWallets(id: number, method: Method, limit = 50, offset = 0): Promise<{ address: string; flagged: number; transfers: number }[]> {
    const { rows } = await this.pool.query(
      `WITH sides AS (
         SELECT t.from_address AS a, f.tx_hash IS NOT NULL AS hit FROM washtrace.transfers t
         LEFT JOIN washtrace.flags f ON f.collection_id = t.collection_id AND f.method = $2 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index
         WHERE t.collection_id = $1
         UNION ALL
         SELECT t.to_address, f.tx_hash IS NOT NULL FROM washtrace.transfers t
         LEFT JOIN washtrace.flags f ON f.collection_id = t.collection_id AND f.method = $2 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index
         WHERE t.collection_id = $1)
       SELECT a, count(*) FILTER (WHERE hit)::int AS flagged, count(*)::int AS transfers FROM sides
       GROUP BY a HAVING count(*) FILTER (WHERE hit) > 0 ORDER BY flagged DESC, transfers DESC, a LIMIT $3 OFFSET $4`,
      [id, method, limit, offset],
    );
    return rows.map((r) => ({ address: r.a, flagged: r.flagged, transfers: r.transfers }));
  }

  /**
   * The collection's own history: its sales bucketed by when they happened,
   * with how many each method flags. The bucket fits the span read so far,
   * so a young collection is drawn by the day and an old one by the month.
   * Buckets are calendar periods in `zone`, the reader's, whatever the
   * server's own TimeZone: a day is the reader's day, and a month the
   * reader's month. A sale here is any transfer
   * with a marketplace fill; the analysis also drops custody round trips,
   * so a period's share can sit a little under the headline's. A transfer
   * whose block time the RPC did not return is left out, and counted in
   * `untimed` so the gap is said rather than hidden.
   */
  async timeline(id: number, zone = 'UTC'): Promise<{ bucket: Bucket; untimed: number; readThrough: number | null; points: TimelinePoint[] }> {
    const span = await this.pool.query(
      `SELECT extract(epoch FROM max(block_time) - min(block_time))::float8 AS seconds, extract(epoch FROM max(block_time))::float8 * 1000 AS last,
              count(*) FILTER (WHERE block_time IS NULL)::int AS untimed
       FROM washtrace.transfers WHERE collection_id = $1`,
      [id],
    );
    const seconds: number = span.rows[0]?.seconds ?? 0;
    const day = 86_400;
    const bucket: Bucket = seconds > 730 * day ? 'month' : seconds > 120 * day ? 'week' : seconds > 4 * day ? 'day' : 'hour';
    const { rows } = await this.pool.query(
      `WITH f AS (
         SELECT tx_hash, log_index, bool_or(method = 'A') AS a, bool_or(method = 'AU') AS au, bool_or(method = 'AC') AS ac
         FROM washtrace.flags WHERE collection_id = $1 GROUP BY tx_hash, log_index)
       SELECT extract(epoch FROM date_trunc($2, t.block_time, $3))::float8 * 1000 AS at, count(*)::int AS transfers,
              count(*) FILTER (WHERE t.marketplace IS NOT NULL)::int AS sales,
              count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.a)::int AS a,
              count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.au)::int AS au,
              count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.ac)::int AS ac
       FROM washtrace.transfers t LEFT JOIN f ON f.tx_hash = t.tx_hash AND f.log_index = t.log_index
       WHERE t.collection_id = $1 AND t.block_time IS NOT NULL
       GROUP BY 1 ORDER BY 1`,
      [id, bucket, zone],
    );
    return {
      bucket,
      untimed: span.rows[0]?.untimed ?? 0,
      // The newest trade read. Past it the chain may be unread or merely quiet; the caller knows which.
      readThrough: span.rows[0]?.last ?? null,
      points: rows.map((r) => ({ at: r.at, transfers: r.transfers, sales: r.sales, flaggedSales: { A: r.a, AU: r.au, AC: r.ac } })),
    };
  }

  /** One token's transfers in chain order, each with the methods that flagged it. */
  async token(id: number, tokenId: string): Promise<FlaggedTransfer[]> {
    const { rows } = await this.pool.query(
      `${TRANSFER_COLUMNS}, ${FLAGS_AGG} ${TRANSFERS} WHERE t.collection_id = $1 AND t.token_id = $2::numeric ORDER BY t.block_number, t.log_index`,
      [id, tokenId],
    );
    return rows.map(toFlagged);
  }

  /** Flows between any two of `wallets`, for drawing the money edges beside a token's graph. */
  async flowsAmong(chainId: number, wallets: readonly string[], limit = 500): Promise<Flow[]> {
    const { rows } = await this.pool.query(
      `SELECT f.*, extract(epoch FROM f.block_time)::float8 AS bt FROM washtrace.flows f
       WHERE f.chain_id = $1 AND f.from_address = ANY($2) AND f.to_address = ANY($2) AND f.from_address <> f.to_address
       ORDER BY f.block_number LIMIT $3`,
      [chainId, wallets, limit],
    );
    return rows.map(toFlow);
  }

  /** A wallet's transfers across every watched collection on its chain, newest first. */
  async walletTransfers(chainId: number, address: string, limit = 500): Promise<FlaggedTransfer[]> {
    const { rows } = await this.pool.query(
      `${TRANSFER_COLUMNS}, ${FLAGS_AGG}, c.chain_id, c.address AS collection_address, c.name AS collection_name ${TRANSFERS}
       WHERE c.chain_id = $1 AND (t.from_address = $2 OR t.to_address = $2)
       ORDER BY t.block_number DESC, t.log_index DESC LIMIT $3`,
      [chainId, address, limit],
    );
    return rows.map(toFlagged);
  }

  /** Who a wallet moved money with, largest count first. */
  async counterparties(chainId: number, address: string, limit = 50): Promise<{ address: string; flows: number; sent: number; received: number; watched: boolean }[]> {
    const { rows } = await this.pool.query(
      `SELECT other, count(*)::int AS flows, count(*) FILTER (WHERE dir = 'out')::int AS sent, count(*) FILTER (WHERE dir = 'in')::int AS received,
              EXISTS (SELECT 1 FROM washtrace.wallets w WHERE w.chain_id = $1 AND w.address = other) AS watched
       FROM (SELECT to_address AS other, 'out' AS dir FROM washtrace.flows WHERE chain_id = $1 AND from_address = $2
             UNION ALL SELECT from_address, 'in' FROM washtrace.flows WHERE chain_id = $1 AND to_address = $2) x
       WHERE other <> $2 GROUP BY other ORDER BY flows DESC LIMIT $3`,
      [chainId, address, limit],
    );
    return rows.map((r) => ({ address: r.other, flows: r.flows, sent: r.sent, received: r.received, watched: r.watched }));
  }

  async wallet(chainId: number, address: string): Promise<{ status: string; truncated: boolean; fetchedAt: number | null; transfers: number; error: string | null } | null> {
    const { rows } = await this.pool.query(
      `SELECT status, truncated, extract(epoch FROM fetched_at)::float8 AS fetched, transfers, error FROM washtrace.wallets WHERE chain_id = $1 AND address = $2`,
      [chainId, address],
    );
    const r = rows[0];
    return r ? { status: r.status, truncated: r.truncated, fetchedAt: r.fetched === null ? null : r.fetched * 1000, transfers: r.transfers, error: r.error } : null;
  }

  /** Every watched transfer in one transaction, flagged or not: the API's "is this sale a wash trade?". */
  async transaction(chainId: number, txHash: string): Promise<FlaggedTransfer[]> {
    const { rows } = await this.pool.query(
      `${TRANSFER_COLUMNS}, ${FLAGS_AGG}, c.chain_id, c.address AS collection_address, c.name AS collection_name ${TRANSFERS}
       WHERE c.chain_id = $1 AND t.tx_hash = $2 ORDER BY t.log_index`,
      [chainId, txHash],
    );
    return rows.map(toFlagged);
  }

  // ---- worker passes ------------------------------------------------------

  async passStarted(job: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO washtrace.passes (job, started_at, heartbeat_at) VALUES ($1, now(), now())
       ON CONFLICT (job) DO UPDATE SET started_at = now(), heartbeat_at = now(), doing = NULL, subject_id = NULL`,
      [job],
    );
  }

  async passFinished(job: string, tookMs: number, outcome: 'ok' | 'failed', detail: string): Promise<void> {
    await this.pool.query(
      'UPDATE washtrace.passes SET finished_at = now(), took_ms = $2, outcome = $3, detail = $4 WHERE job = $1',
      [job, tookMs, outcome, detail],
    );
  }

  /** A pass says it is alive, what it is doing, and which collection that is. */
  async heartbeat(job: string, doing: string | null, subjectId: number | null): Promise<void> {
    await this.pool.query('UPDATE washtrace.passes SET heartbeat_at = now(), doing = $2, subject_id = $3 WHERE job = $1', [job, doing, subjectId]);
  }

  async passes(): Promise<PassRow[]> {
    const { rows } = await this.pool.query(
      `SELECT job, extract(epoch FROM started_at)::float8 AS s, extract(epoch FROM finished_at)::float8 AS f, took_ms, outcome, detail,
              extract(epoch FROM heartbeat_at)::float8 AS h, doing, subject_id
       FROM washtrace.passes ORDER BY job`,
    );
    return rows.map((r) => ({ job: r.job, startedAt: r.s * 1000, finishedAt: r.f === null ? null : r.f * 1000, tookMs: r.took_ms, outcome: r.outcome, detail: r.detail, heartbeatAt: r.h === null ? null : r.h * 1000, doing: r.doing, subjectId: r.subject_id }));
  }

  // ---- settings and checks ------------------------------------------------

  /**
   * Every setting saved from the console, secrets included. The worker reads
   * it to run; the settings API reads it to show what is set and a secret's
   * last 4, and never returns a secret's value.
   */
  async settings(): Promise<Map<string, string>> {
    const { rows } = await this.pool.query<{ key: string; value: string }>('SELECT key, value FROM washtrace.settings ORDER BY key');
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  /** Save a setting, or with null delete it so the default applies again. `actor` is who saved it. */
  async setSetting(key: string, value: string | null, actor: string): Promise<void> {
    if (value === null) {
      await this.pool.query('DELETE FROM washtrace.settings WHERE key = $1', [key]);
      return;
    }
    await this.pool.query(
      `INSERT INTO washtrace.settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, value, actor],
    );
  }

  /**
   * The worker says where each setting it uses came from, replacing what it
   * said last: a setting it no longer uses is gone from the report. A secret's
   * value is blanked here too, whatever the caller passed, so it never
   * reaches a table the API reads. Reports are taken one at a time: the
   * worker's three jobs start together and each reports, and two
   * delete-then-insert transactions at once collide on the key. EXCLUSIVE
   * still lets the API read the table meanwhile.
   */
  async reportSources(s: Record<string, SettingSource>): Promise<void> {
    const keys = Object.keys(s);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE washtrace.setting_sources IN EXCLUSIVE MODE');
      await c.query('DELETE FROM washtrace.setting_sources');
      if (keys.length > 0) {
        await c.query(
          `INSERT INTO washtrace.setting_sources (key, source, value, reported_at)
           SELECT k, src, v, now() FROM unnest($1::text[], $2::text[], $3::text[]) AS u(k, src, v)`,
          [keys, keys.map((k) => s[k]!.source), keys.map((k) => (SECRET_KEYS(k) ? null : s[k]!.value))],
        );
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** Where the worker last said each setting came from. Never a secret's value. */
  async sources(): Promise<Record<string, SettingSource & { reportedAt: number }>> {
    const { rows } = await this.pool.query(
      'SELECT key, source, value, extract(epoch FROM reported_at)::float8 AS reported FROM washtrace.setting_sources ORDER BY key',
    );
    return Object.fromEntries(rows.map((r) => [r.key, { source: r.source, value: r.value, reportedAt: r.reported * 1000 }]));
  }

  /**
   * Ask the worker to run a Test, and tell it at once. The insert and the
   * notify are one statement, so the notify goes out when the row is
   * committed and a woken worker always finds it. Returns the check's id,
   * which the console polls.
   */
  async requestCheck(kind: CheckKind, chainId: number | null): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `WITH i AS (INSERT INTO washtrace.checks (kind, chain_id) VALUES ($1, $2) RETURNING id)
       SELECT id, pg_notify($3, id::text) FROM i`,
      [kind, chainId, CHECKS_CHANNEL],
    );
    return Number(rows[0]!.id);
  }

  /** Checks requested and not yet finished, oldest first, each with how long ago it was asked for by the store's clock. */
  async pendingChecks(): Promise<{ id: number; kind: CheckKind; chainId: number | null; ageMs: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT id, kind, chain_id, extract(epoch FROM now() - requested_at)::float8 * 1000 AS age_ms
       FROM washtrace.checks WHERE finished_at IS NULL ORDER BY id`,
    );
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind, chainId: r.chain_id, ageMs: Number(r.age_ms) }));
  }

  /**
   * Finish, unrun, every check asked for more than `olderThanMs` ago, with
   * `{ error: 'expired' }`. Its page stopped polling long since, and a URL
   * tested now may not be the one it asked about. Aged by the store's clock,
   * not the worker's. Returns how many.
   */
  async expireChecks(olderThanMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE washtrace.checks SET finished_at = now(), ok = false, detail = '{"error":"expired"}'
       WHERE finished_at IS NULL AND requested_at < now() - make_interval(secs => $1::float8 / 1000)`,
      [olderThanMs],
    );
    return rowCount ?? 0;
  }

  /** Record a check's result. `detail` is shown in the console, so it must never hold a URL or a key. */
  async finishCheck(id: number, ok: boolean, detail: Record<string, unknown>): Promise<void> {
    await this.pool.query('UPDATE washtrace.checks SET finished_at = now(), ok = $2, detail = $3 WHERE id = $1', [id, ok, JSON.stringify(detail)]);
  }

  /** One check as the console polls it, or null when there is no such check. */
  async check(id: number): Promise<{ finished: boolean; ok: boolean | null; detail: Record<string, unknown> | null } | null> {
    const { rows } = await this.pool.query('SELECT finished_at IS NOT NULL AS finished, ok, detail FROM washtrace.checks WHERE id = $1', [id]);
    const r = rows[0];
    return r ? { finished: r.finished, ok: r.ok, detail: r.detail } : null;
  }
}

const COLLECTION_SELECT = `
SELECT c.*, extract(epoch FROM c.added_at)::float8 AS added, extract(epoch FROM c.ingested_at)::float8 AS ingested,
       extract(epoch FROM c.error_at)::float8 AS errored, extract(epoch FROM c.served_at)::float8 AS served, extract(epoch FROM c.paused_at)::float8 AS paused,
       extract(epoch FROM c.stored_through_time)::float8 AS stored_through, extract(epoch FROM c.restore_retry_at)::float8 AS restore_retry,
       extract(epoch FROM c.analysis_retry_at)::float8 AS analysis_retry,
       (SELECT count(*)::int FROM washtrace.transfers t WHERE t.collection_id = c.id) AS transfer_count,
       a.id AS analysis_id, a.took_ms, a.through_block, a.totals, a.missing_data, a.funded_wallets, a.wallets, a.truncated_searches,
       extract(epoch FROM a.ran_at)::float8 AS ran
FROM washtrace.collections c
LEFT JOIN LATERAL (SELECT * FROM washtrace.analyses x WHERE x.collection_id = c.id ORDER BY x.ran_at DESC LIMIT 1) a ON true`;

/**
 * Which wallets funding serves, for fundingLanes and fundingBacklog alike, so
 * what is counted waiting is what gets checked. SERVED_LIVE: collection c is
 * not paused. SERVED_NAMES: c's transfers name wallet w, probed by index each
 * way, for a lane of one collection. SERVED_WALLET: the same question per
 * wallet, for the count: w is a trader some live collection on its chain
 * names, or a followed wallet (depth > 0) on a chain where some collection
 * is live, as fundingLanes gives followed wallets a lane only then.
 */
const SERVED_LIVE = 'c.paused_at IS NULL';
const SERVED_NAMES = `(EXISTS (SELECT 1 FROM washtrace.transfers x WHERE x.collection_id = c.id AND x.from_address = w.address)
  OR EXISTS (SELECT 1 FROM washtrace.transfers x WHERE x.collection_id = c.id AND x.to_address = w.address))`;
// By the wallet's own address, one probe each way, and only then whose
// transfers they are. Left to itself Postgres probes each live collection's
// index in turn, one probe per collection each way for a wallet none of them
// names: OFFSET 0 keeps it from folding the address lookup into that.
const namedLive = (side: 'from_address' | 'to_address') =>
  `EXISTS (SELECT 1 FROM (SELECT x.collection_id FROM washtrace.transfers x WHERE x.${side} = w.address OFFSET 0) x
     JOIN washtrace.collections c ON c.id = x.collection_id WHERE c.chain_id = w.chain_id AND ${SERVED_LIVE})`;
const SERVED_WALLET = `CASE WHEN w.depth > 0 THEN EXISTS (SELECT 1 FROM washtrace.collections c WHERE c.chain_id = w.chain_id AND ${SERVED_LIVE})
  ELSE ${namedLive('from_address')} OR ${namedLive('to_address')} END`;

const TRANSFER_COLUMNS = `
SELECT t.tx_hash, t.log_index, t.block_number, extract(epoch FROM t.block_time)::float8 AS bt, t.token_id::text AS token_id,
       t.from_address, t.to_address, t.marketplace, t.price_wei::text AS price_wei, t.currency`;
const TRANSFERS = 'FROM washtrace.transfers t JOIN washtrace.collections c ON c.id = t.collection_id';
const TRANSFER_SELECT = `${TRANSFER_COLUMNS} ${TRANSFERS}`;

const FLAGS_AGG = `(SELECT jsonb_object_agg(f.method, f.witness) FROM washtrace.flags f
  WHERE f.collection_id = t.collection_id AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index) AS flags`;

// bigint and numeric columns arrive as strings; each is converted where it is read.
function toTransfer(r: any): Transfer {
  return {
    txHash: r.tx_hash, logIndex: r.log_index, blockNumber: Number(r.block_number), blockTime: r.bt,
    tokenId: r.token_id, from: r.from_address, to: r.to_address, marketplace: r.marketplace, priceWei: r.price_wei, currency: r.currency,
  };
}

function toFlagged(r: any): FlaggedTransfer {
  const t: FlaggedTransfer = { ...toTransfer(r), flags: r.flags ?? {} };
  if (r.collection_address !== undefined) t.collection = { chainId: r.chain_id, address: r.collection_address, name: r.collection_name };
  return t;
}

function toFlow(r: any): Flow {
  return {
    txHash: r.tx_hash, kind: r.kind, from: r.from_address, to: r.to_address, valueWei: String(r.value_wei),
    token: r.token, blockNumber: Number(r.block_number), blockTime: r.bt,
  };
}

function toAnalysis(r: any): AnalysisRow {
  return {
    ranAt: r.ran * 1000, tookMs: r.took_ms, throughBlock: r.through_block === null ? null : Number(r.through_block),
    totals: r.totals, missingData: r.missing_data, fundedWallets: r.funded_wallets, wallets: r.wallets, truncatedSearches: r.truncated_searches,
  };
}

function toCollection(r: any): CollectionRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: r.id, chainId: r.chain_id, address: r.address, name: r.name,
    startBlock: num(r.start_block), cursorBlock: num(r.cursor_block), headBlock: num(r.head_block),
    addedAt: r.added * 1000, ingestedAt: r.ingested === null ? null : r.ingested * 1000,
    error: r.error, errorAt: r.errored === null ? null : r.errored * 1000,
    transfers: r.transfer_count,
    wallets: r.wallets ?? 0, fundedWallets: r.funded_wallets ?? 0,
    stale: Number(r.version) > Number(r.analyzed_version),
    latest: r.analysis_id === null ? null : toAnalysis(r),
    servedAt: r.served === null ? null : r.served * 1000, readRate: num(r.read_rate), priority: r.priority,
    pausedAt: r.paused === null ? null : r.paused * 1000,
    restoreProgress: num(r.restore_progress), restoreNote: r.restore_note, restoreNoteKey: r.restore_note_key,
    restoreRetryAt: r.restore_retry === null ? null : r.restore_retry * 1000,
    analysisError: r.analysis_error, analysisRetryAt: r.analysis_retry === null ? null : r.analysis_retry * 1000,
    storedThroughTime: r.stored_through === null ? null : r.stored_through * 1000,
    storedThroughBlock: r.stored_through_block === null ? null : Number(r.stored_through_block),
    trailImportedSha: r.trail_imported_sha, trailNote: r.trail_note,
    rules: r.rules ?? {},
    contract: r.described_at === null ? null : { name: r.contract_name, symbol: r.symbol, creator: r.creator, creationTx: r.creation_tx },
  };
}

/**
 * Insert transfers, keeping any already stored, and return the senders and
 * receivers of the ones that were new. Ingest and a load of stored data
 * share it.
 */
async function insertTransfers(c: pg.PoolClient, id: number, transfers: readonly Transfer[]): Promise<{ from: string; to: string }[]> {
  if (transfers.length === 0) return [];
  const { rows } = await c.query<{ from: string; to: string }>(
    `INSERT INTO washtrace.transfers
       (collection_id, tx_hash, log_index, block_number, block_time, token_id, from_address, to_address, marketplace, price_wei, currency)
     SELECT $1, tx, li, bn, to_timestamp(bt), tok, fr, too, mk, pr, cur
     FROM unnest($2::text[], $3::int[], $4::bigint[], $5::float8[], $6::numeric[], $7::text[], $8::text[], $9::text[], $10::numeric[], $11::text[])
       AS u(tx, li, bn, bt, tok, fr, too, mk, pr, cur)
     ON CONFLICT DO NOTHING
     RETURNING from_address AS "from", to_address AS "to"`,
    [
      id,
      transfers.map((t) => t.txHash), transfers.map((t) => t.logIndex), transfers.map((t) => t.blockNumber),
      transfers.map((t) => t.blockTime), transfers.map((t) => t.tokenId), transfers.map((t) => t.from),
      transfers.map((t) => t.to), transfers.map((t) => t.marketplace), transfers.map((t) => t.priceWei),
      transfers.map((t) => t.currency),
    ],
  );
  return rows;
}

/**
 * Insert flows, keeping any already stored: a flow between two checked
 * wallets is read from both sides, and is one edge. Funding and a loaded
 * money trail share it.
 */
async function insertFlows(c: pg.Pool | pg.PoolClient, chainId: number, flows: readonly Flow[]): Promise<void> {
  if (flows.length === 0) return;
  await c.query(
    `INSERT INTO washtrace.flows (chain_id, tx_hash, kind, from_address, to_address, value_wei, token, block_number, block_time)
     SELECT $1, tx, k, fr, too, v, tok, bn, to_timestamp(bt)
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[], $8::bigint[], $9::float8[])
       AS u(tx, k, fr, too, v, tok, bn, bt)
     ON CONFLICT DO NOTHING`,
    [
      chainId, flows.map((f) => f.txHash), flows.map((f) => f.kind), flows.map((f) => f.from), flows.map((f) => f.to),
      flows.map((f) => f.valueWei), flows.map((f) => f.token), flows.map((f) => f.blockNumber), flows.map((f) => f.blockTime),
    ],
  );
}

/**
 * A store error the data caused (class 22, a value it refuses; 23, a broken
 * constraint) as bad stored data, so a file whose sha256 matched but holds
 * such a value is noted once, not loaded and hashed again every pass. A row
 * whose collection went (a foreign key) is not the data's fault.
 */
function asDataFault(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || code === FOREIGN_KEY_VIOLATION || !(code.startsWith('22') || code.startsWith('23'))) return err;
  return new StoredDataError(`stored data holds a value the store refuses: ${(err as Error).message}`, 'unreadable');
}

/** How many times each address appears. */
function tally(addresses: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of addresses) counts.set(a, (counts.get(a) ?? 0) + 1);
  return counts;
}

/**
 * Queue wallets for a funding check, weighted by how often they traded. A
 * wallet a collection traded is a trader, depth 0, even if it was first met
 * as a followed one. In address order, so two writers lock wallets in the
 * same order. Ingest and a load of stored data share it.
 */
async function queueWallets(c: pg.PoolClient, chainId: number, counts: ReadonlyMap<string, number>): Promise<void> {
  const sorted = [...counts.keys()].sort();
  for (let at = 0; at < sorted.length; at += QUEUE_BATCH) {
    const addresses = sorted.slice(at, at + QUEUE_BATCH);
    await c.query(
      `INSERT INTO washtrace.wallets (chain_id, address, transfers)
       SELECT $1, a, n FROM unnest($2::text[], $3::int[]) AS u(a, n) ORDER BY a
       ON CONFLICT (chain_id, address) DO UPDATE SET transfers = washtrace.wallets.transfers + EXCLUDED.transfers, depth = 0`,
      [chainId, addresses, addresses.map((a) => counts.get(a)!)],
    );
  }
}
