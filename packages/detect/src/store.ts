import pg from 'pg';
import { ZERO } from './graph.js';
import { MIGRATIONS } from './migrations.js';
import type { Rules } from './methods.js';
import type { Analysis, Flag, Flow, Method, MethodTotals, Transfer, Witness } from './types.js';

/** pg_advisory_lock's first key: this product's namespace. The second is the job. */
const LOCK_NS = 0x77617368; // "wash"
const MIGRATE_JOB = 0;

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
}

/**
 * Every read and write of the `washtrace` schema. A class because every one
 * of them needs the pool, and nothing else.
 */
export class Store {
  constructor(readonly pool: pg.Pool) {}

  static connect(url: string): Store {
    const pool = new pg.Pool({ connectionString: url, max: 10, application_name: 'washtrace' });
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
       ON CONFLICT (chain_id, address) DO UPDATE SET name = COALESCE(EXCLUDED.name, washtrace.collections.name)
       RETURNING id, (xmax = 0) AS created`,
      [chainId, address, name, startBlock],
    );
    return rows[0]!;
  }

  async removeCollection(chainId: number, address: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM washtrace.collections WHERE chain_id = $1 AND address = $2', [chainId, address]);
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
   * version moves only when the rules did: a rename changes no flag.
   */
  async configure(chainId: number, address: string, change: Configure): Promise<CollectionRow | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE washtrace.collections
       SET name = CASE WHEN $3 THEN $4 ELSE name END,
           rules = jsonb_strip_nulls(rules || $5::jsonb),
           version = version + CASE WHEN jsonb_strip_nulls(rules || $5::jsonb) = rules THEN 0 ELSE 1 END
       WHERE chain_id = $1 AND address = $2`,
      [chainId, address, change.name !== undefined, change.name ?? null, JSON.stringify(change.rules ?? {})],
    );
    return rowCount === 0 ? null : this.collection(chainId, address);
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
      if (transfers.length > 0) {
        await c.query(
          `INSERT INTO washtrace.transfers
             (collection_id, tx_hash, log_index, block_number, block_time, token_id, from_address, to_address, marketplace, price_wei, currency)
           SELECT $1, tx, li, bn, to_timestamp(bt), tok, fr, too, mk, pr, cur
           FROM unnest($2::text[], $3::int[], $4::bigint[], $5::float8[], $6::numeric[], $7::text[], $8::text[], $9::text[], $10::numeric[], $11::text[])
             AS u(tx, li, bn, bt, tok, fr, too, mk, pr, cur)
           ON CONFLICT DO NOTHING`,
          [
            id,
            transfers.map((t) => t.txHash), transfers.map((t) => t.logIndex), transfers.map((t) => t.blockNumber),
            transfers.map((t) => t.blockTime), transfers.map((t) => t.tokenId), transfers.map((t) => t.from),
            transfers.map((t) => t.to), transfers.map((t) => t.marketplace), transfers.map((t) => t.priceWei),
            transfers.map((t) => t.currency),
          ],
        );
      }
      if (queue.length > 0) {
        await c.query(
          `INSERT INTO washtrace.wallets (chain_id, address, transfers)
           SELECT $1, a, count(*) FROM unnest($2::text[]) AS a GROUP BY a
           ON CONFLICT (chain_id, address) DO UPDATE SET transfers = washtrace.wallets.transfers + EXCLUDED.transfers, depth = 0`,
          [chainId, queue],
        );
      }
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

  // ---- funding -------------------------------------------------------------

  /** The next wallets to read funding for, busiest first. Failed wallets retry after an hour. */
  async fundingQueue(chainId: number, limit: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ address: string }>(
      `SELECT address FROM washtrace.wallets
       WHERE chain_id = $1 AND (status = 'pending' OR (status = 'failed' AND fetched_at < now() - interval '1 hour'))
       ORDER BY status = 'failed', depth, transfers DESC LIMIT $2`,
      [chainId, limit],
    );
    return rows.map((r) => r.address);
  }

  /**
   * Store a wallet's flows and take it off the queue. With `follow`, queue
   * the wallets it sent money to, one hop further out: see Follow.
   */
  async fund(chainId: number, wallet: string, flows: readonly Flow[], truncated: boolean, follow?: Follow): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      if (flows.length > 0) {
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
      await c.query(
        `UPDATE washtrace.collections SET version = version + 1
         WHERE id IN (SELECT DISTINCT collection_id FROM washtrace.transfers WHERE from_address = ANY($2) OR to_address = ANY($2))
           AND chain_id = $1`,
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

  async fundingBacklog(): Promise<{ chainId: number; pending: number; done: number; failed: number; truncated: number; followed: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT chain_id, count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'done')::int AS done,
              count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE truncated)::int AS truncated, count(*) FILTER (WHERE depth > 0)::int AS followed
       FROM washtrace.wallets GROUP BY chain_id ORDER BY chain_id`,
    );
    return rows.map((r) => ({ chainId: r.chain_id, pending: r.pending, done: r.done, failed: r.failed, truncated: r.truncated, followed: r.followed }));
  }

  // ---- analysis ------------------------------------------------------------

  /**
   * Collections written to since their latest analysis, with the version each
   * analysis will record and the rules it runs under, read together: a rule
   * changed mid-analysis moves the version, so the collection runs again.
   */
  async stale(): Promise<{ id: number; chainId: number; version: number; rules: Partial<Rules> }[]> {
    const { rows } = await this.pool.query(
      'SELECT id, chain_id, version, rules FROM washtrace.collections WHERE version > analyzed_version ORDER BY id',
    );
    return rows.map((r) => ({ id: r.id, chainId: r.chain_id, version: Number(r.version), rules: r.rules }));
  }

  /** What `analyze` reads for one collection: its transfers, and the flows and funding state of its wallets. */
  async analysisInput(id: number, chainId: number): Promise<{
    transfers: Transfer[]; flows: Flow[]; funded: Set<string>; truncated: Set<string>; through: number | null;
  }> {
    const transfers = (await this.pool.query(`${TRANSFER_SELECT} WHERE t.collection_id = $1`, [id])).rows.map(toTransfer);
    const wallets = `(SELECT from_address AS a FROM washtrace.transfers WHERE collection_id = $1
                      UNION SELECT to_address FROM washtrace.transfers WHERE collection_id = $1)`;
    const flows = (await this.pool.query(
      `SELECT f.* , extract(epoch FROM f.block_time)::float8 AS bt FROM washtrace.flows f
       WHERE f.chain_id = $2 AND (f.from_address IN ${wallets} OR f.to_address IN ${wallets}
         -- Followed wallets' payments onward: the middle of a path SCC AU follows back.
         OR f.from_address IN (SELECT address FROM washtrace.wallets WHERE chain_id = $2 AND depth > 0 AND status = 'done'))`,
      [id, chainId],
    )).rows.map(toFlow);
    const state = (await this.pool.query<{ address: string; truncated: boolean }>(
      `SELECT address, truncated FROM washtrace.wallets WHERE chain_id = $2 AND status = 'done' AND (address IN ${wallets} OR depth > 0)`,
      [id, chainId],
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

  /** Record an analysis and replace the collection's flags with its own. */
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
      const f: readonly Flag[] = analysis.flags;
      if (f.length > 0) {
        await c.query(
          `INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness)
           SELECT $1, m, tx, li, w FROM unnest($2::text[], $3::text[], $4::int[], $5::jsonb[]) AS u(m, tx, li, w)`,
          [id, f.map((x) => x.method), f.map((x) => x.txHash), f.map((x) => x.logIndex), f.map((x) => JSON.stringify(x.witness))],
        );
      }
      await c.query('UPDATE washtrace.collections SET analyzed_version = GREATEST(analyzed_version, $2) WHERE id = $1', [id, version]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async history(id: number, limit = 100): Promise<AnalysisRow[]> {
    const { rows } = await this.pool.query(
      `SELECT *, extract(epoch FROM ran_at)::float8 AS ran FROM washtrace.analyses WHERE collection_id = $1 ORDER BY ran_at DESC LIMIT $2`,
      [id, limit],
    );
    return rows.map(toAnalysis).reverse();
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
      `INSERT INTO washtrace.passes (job, started_at) VALUES ($1, now())
       ON CONFLICT (job) DO UPDATE SET started_at = now()`,
      [job],
    );
  }

  async passFinished(job: string, tookMs: number, outcome: 'ok' | 'failed', detail: string): Promise<void> {
    await this.pool.query(
      'UPDATE washtrace.passes SET finished_at = now(), took_ms = $2, outcome = $3, detail = $4 WHERE job = $1',
      [job, tookMs, outcome, detail],
    );
  }

  async passes(): Promise<PassRow[]> {
    const { rows } = await this.pool.query(
      `SELECT job, extract(epoch FROM started_at)::float8 AS s, extract(epoch FROM finished_at)::float8 AS f, took_ms, outcome, detail
       FROM washtrace.passes ORDER BY job`,
    );
    return rows.map((r) => ({ job: r.job, startedAt: r.s * 1000, finishedAt: r.f === null ? null : r.f * 1000, tookMs: r.took_ms, outcome: r.outcome, detail: r.detail }));
  }
}

const COLLECTION_SELECT = `
SELECT c.*, extract(epoch FROM c.added_at)::float8 AS added, extract(epoch FROM c.ingested_at)::float8 AS ingested,
       extract(epoch FROM c.error_at)::float8 AS errored,
       (SELECT count(*)::int FROM washtrace.transfers t WHERE t.collection_id = c.id) AS transfer_count,
       a.id AS analysis_id, a.took_ms, a.through_block, a.totals, a.missing_data, a.funded_wallets, a.wallets, a.truncated_searches,
       extract(epoch FROM a.ran_at)::float8 AS ran
FROM washtrace.collections c
LEFT JOIN LATERAL (SELECT * FROM washtrace.analyses x WHERE x.collection_id = c.id ORDER BY x.ran_at DESC LIMIT 1) a ON true`;

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
    rules: r.rules ?? {},
    contract: r.described_at === null ? null : { name: r.contract_name, symbol: r.symbol, creator: r.creator, creationTx: r.creation_tx },
  };
}
