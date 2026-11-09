// A collection's trade facts, written in SQL for an analysis's save: apart from store.ts because the facts' key
// and version are a contract of their own.
import pg from 'pg';
import { FLAG_BATCH_ROWS } from './store-rows.js';
import type { Analysis } from './types.js';

/** How many UTC days before a sale its floor looks back over. */
export const FLOOR_DAYS = 7;
/** Bump it whenever a fact's definition changes: an analysis then writes every trade fact again, not only the new ones. */
export const FACTS_VERSION = 1;

/** What a collection's trade facts are worked out with. Facts under another key can't be added to: each must be written again. */
export function factsKey(money: ReadonlySet<string>): string {
  return `${FACTS_VERSION}/${FLOOR_DAYS}/${[...money].sort().join(',')}`;
}

/**
 * Replace a collection's trade facts: for every transfer up to `through`
 * (all of them when null), whether the analysis counted it, how long its
 * token had been still, how old its buyer was to the collection, and its
 * price over the median price of the seven UTC days before. All in SQL: a
 * collection is millions of rows, and none comes to Node. The uncounted keys
 * are the only thing sent in, in batches like the flags.
 *
 * Each ingest brings an analysis, so the facts are not all written each time.
 * When the ones on disk cover exactly the transfers through `prev`, the
 * previous analysis's cursor (null when its facts were worked out
 * otherwise), only the rows whose `counted` changed are written, and the
 * transfers past `prev` added. Otherwise they are all deleted and written
 * again.
 *
 * Change how `held_s`, `buyer_age_s` or `floor_ratio` is worked out here and
 * bump FACTS_VERSION (above factsKey), or old facts keep the old meaning.
 * `counted` needs no bump: it is re-checked every save.
 */
export async function writeFacts(
  c: pg.PoolClient, id: number, uncounted: Analysis['uncounted'], through: number | null, money: ReadonlySet<string>, prev: number | null,
): Promise<void> {
  // Transfers are re-read here, not carried from analysisInput. A stored-data load adding rows below the cursor in between gets them counted = true, or no row at all if they land below `prev` after the count; the load bumps `version`, so the next analysis corrects it.
  // An older fact can stay: its token's last move, its buyer's first, and the week before its day are all older still, as ingest only appends past the cursor and block time rises with the block on every chain we read (Ethereum, Base). A row below `prev` that is new or gone since, as a load or restore leaves, breaks the equal count.
  const since = prev !== null && through !== null && through >= prev && (await c.query<{ covered: boolean }>(
    `SELECT (SELECT count(*) FROM washtrace.trade_facts WHERE collection_id = $1)
          = (SELECT count(*) FROM washtrace.transfers WHERE collection_id = $1 AND block_number <= $2::bigint) AS covered`,
    [id, prev],
  )).rows[0]!.covered ? prev : null;
  if (since === null) await c.query('DELETE FROM washtrace.trade_facts WHERE collection_id = $1', [id]);
  // Keyed, so the counted update probes it per fact when it is too big to hash, not scans it per fact.
  await c.query('CREATE TEMP TABLE uncounted (tx_hash text NOT NULL, log_index int NOT NULL, PRIMARY KEY (tx_hash, log_index)) ON COMMIT DROP');
  for (let at = 0; at < uncounted.length; at += FLAG_BATCH_ROWS) {
    const batch = uncounted.slice(at, at + FLAG_BATCH_ROWS);
    await c.query(
      'INSERT INTO uncounted SELECT * FROM unnest($1::text[], $2::int[])',
      [batch.map((u) => u.txHash), batch.map((u) => u.logIndex)],
    );
  }
  if (since !== null) {
    // A fact is wrong when it is counted and listed uncounted, or neither: only those are written.
    await c.query(
      `UPDATE washtrace.trade_facts x SET counted = NOT x.counted
       WHERE x.collection_id = $1
         AND x.counted = EXISTS (SELECT 1 FROM uncounted u WHERE u.tx_hash = x.tx_hash AND u.log_index = x.log_index)`,
      [id],
    );
  }
  // Every transfer through `through` is read either way: the new ones' last moves, first sightings and floors are in the old.
  // A change to how a fact below is worked out needs FACTS_VERSION bumped.
  await c.query(
    `WITH t AS (
       SELECT tx_hash, log_index, block_number, token_id, to_address, from_address, price_wei, currency, marketplace,
              extract(epoch FROM block_time)::float8 AS bt
       FROM washtrace.transfers WHERE collection_id = $1 AND ($2::bigint IS NULL OR block_number <= $2::bigint)
     ), seen AS (
       SELECT address, min(bt) AS bt FROM (SELECT from_address AS address, bt FROM t UNION ALL SELECT to_address, bt FROM t) x GROUP BY address
     ), sales AS (
       SELECT floor(bt / 86400)::int AS day, price_wei::float8 AS price FROM t
       WHERE marketplace IS NOT NULL AND price_wei IS NOT NULL AND currency = ANY($3::text[]) AND bt IS NOT NULL
     ), floors AS (
       -- A sale on day D sets the floor of days D+1..D+FLOOR_DAYS. Joined on the day, not on a range: a range is a nested loop.
       SELECT s.day + k AS day, percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price) AS floor
       FROM sales s CROSS JOIN generate_series(1, $4::int) k GROUP BY 1
     ), lagged AS (
       SELECT t.*, lag(bt) OVER (PARTITION BY token_id ORDER BY block_number, log_index) AS before FROM t
     )
     INSERT INTO washtrace.trade_facts (collection_id, tx_hash, log_index, counted, held_s, buyer_age_s, floor_ratio)
     SELECT $1, l.tx_hash, l.log_index, u.tx_hash IS NULL, round(l.bt - l.before)::bigint, round(l.bt - s.bt)::bigint,
            CASE WHEN l.price_wei IS NOT NULL AND l.currency = ANY($3::text[]) THEN l.price_wei::float8 / NULLIF(f.floor, 0) END
     FROM lagged l
     LEFT JOIN uncounted u ON u.tx_hash = l.tx_hash AND u.log_index = l.log_index
     LEFT JOIN seen s ON s.address = l.to_address
     LEFT JOIN floors f ON f.day = floor(l.bt / 86400)::int
     WHERE $5::bigint IS NULL OR l.block_number > $5::bigint`,
    [id, through, [...money], FLOOR_DAYS, since],
  );
}
