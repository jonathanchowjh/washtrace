// The reach walk and the SQL that serves wallets by it: apart from store.ts because it is plain
// functions and fragments over the stored flows, not the Store's connection and locks.
import pg from 'pg';
import { ZERO } from './graph.js';
import { FOLLOW_FANOUT } from './lens-rule.js';
import { contractsFor } from './marketplaces.js';

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

/**
 * How money is followed on `chainId`, `hops` out: what the fund job hands
 * `fund`, and what walkOut walks the stored flows by, so a collection's
 * count of wallets further out is of the ones `fund` would queue.
 */
export function followOf(chainId: number, globalHops: number): Follow {
  return { hops: globalHops, fanout: FOLLOW_FANOUT, exclude: [...contractsFor(chainId), ZERO] };
}

/**
 * A followed wallet everyone's runs read: within `globalHops` (a query parameter)
 * out on the chain (Store.followedFor). Depth 1 at least: a
 * money trail's import writes its followed wallets at depth 1, and an install
 * running on one with follow.hops 0 read them before reach decided this.
 */
export const FOLLOWED_NEAR = (globalHops: string) => `depth > 0 AND depth <= greatest(${globalHops}, 1)`;

/**
 * A collection's effective hop limit L: the larger of follow.hops
 * (`globalHops`, a query parameter) and its own follow_hops, null-safe, as a
 * lower own limit frees nothing. Its walk (seedReach), the walk's marks, its
 * reach_hops, its money read and its token set all go by this one limit, so
 * no two of them read a different one. `c` is the collections row's alias.
 */
export const REACH_LIMIT = (globalHops: string, c = '') => `greatest(${globalHops}, coalesce(${c}follow_hops, 0))`;

/**
 * The assignment that leaves a walked collection's reach unseeded when
 * `added` (an SQL boolean) says transfers were added, for the
 * collections write an ingest or a load already makes: no statement or lock
 * of its own. Its next seedReach turn then adds its new traders (addTraders)
 * at once, not at the daily refresh, so its token set never reads settled
 * with a trader missing. Walked: following its own limit, or reading tokens;
 * the global limit is not known here, so a follow_hops within it counts too,
 * and its reach_seeded_at is read by no one until it is walked again.
 * traders_at is stamped with the clock as the write runs, so each write
 * gives it a new value, and a turn under way sees that a write came after it
 * read the traders (Store.tradersFrom).
 */
export const UNSEEDED = (added: string) =>
  `reach_seeded_at = CASE WHEN ${added} AND (follow_hops IS NOT NULL OR read_tokens_at IS NOT NULL) THEN NULL ELSE reach_seeded_at END,
   traders_at = CASE WHEN ${added} THEN clock_timestamp() ELSE traders_at END`;

/**
 * A collection's token set (Start reading), as a query of (address, rank):
 * the wallets other tokens are read for, and the senders a lens run takes
 * token edges from. One definition, so the lanes that read the set
 * (tokenLanes), its counts (countTokens) and a run's senders (lensInput)
 * cannot disagree. `collection` and `limit` are SQL expressions: a column or
 * a bound parameter, the collection's id and its limit L (REACH_LIMIT).
 *
 * The set is the collection's walk (reach) out to L, ranked by depth: its
 * own, as wallets.depth is the chain's from any collection. With `payees`
 * (tokens.payees) it also holds every wallet one of its traders (depth
 * 0) paid in listed tokens, ranked after the walk's: from a trader whose own
 * read was done to the end within FOLLOW_FANOUT, as token_payees holds
 * only those, checked against its read again here. Not their payees: one
 * middle is all a one-middle loop needs. Each address once, at its least rank.
 */
export function tokenSetSql(collection: string, limit: string, payees: boolean): string {
  const walk = `SELECT r.address, r.depth::int AS rank FROM washtrace.reach r WHERE r.collection_id = ${collection} AND r.depth <= ${limit}`;
  if (!payees) return walk;
  return `SELECT address, min(rank) AS rank FROM (
    ${walk}
    UNION ALL
    SELECT p.payee, (${limit})::int + 1 FROM washtrace.reach t
    JOIN washtrace.token_reads tr ON tr.chain_id = t.chain_id AND tr.address = t.address
      AND tr.status = 'done' AND NOT tr.truncated AND tr.fanout <= ${FOLLOW_FANOUT}
    JOIN washtrace.token_payees p ON p.chain_id = t.chain_id AND p.payer = t.address
    WHERE t.collection_id = ${collection} AND t.depth = 0
  ) s GROUP BY address`;
}

/**
 * Which wallets funding serves, for moneyLanes and moneyBacklog alike, so
 * what is counted waiting is what gets checked. SERVED_LIVE: collection c is
 * not paused. SERVED_NAMES: c's transfers name wallet w, probed by index each
 * way, for a lane of one collection. servedWallet: the same question per
 * wallet, for the count: w is a trader some live collection on its chain
 * names, or a followed wallet (depth > 0) within `globalHops` (a query parameter)
 * on a chain where some collection is live, as moneyLanes gives followed
 * wallets a lane only then, or a wallet in the reach of a live collection
 * following past `globalHops` that those leave. SERVED_REACH: reach row r is
 * past `globalHops` out from its collection; at or within it, its wallet is the
 * followed lane's, so raising follow.hops hands it back, never checked
 * twice. That holds because stepReach lowers wallets.depth to what its walk
 * finds, so no wallet within `globalHops` of a collection sits deeper on the chain.
 */
export const SERVED_LIVE = 'c.paused_at IS NULL';
export const SERVED_REACH = (globalHops: string) => `r.depth > ${globalHops}`;
export const SERVED_NAMES = `(EXISTS (SELECT 1 FROM washtrace.transfers x WHERE x.collection_id = c.id AND x.from_address = w.address)
  OR EXISTS (SELECT 1 FROM washtrace.transfers x WHERE x.collection_id = c.id AND x.to_address = w.address))`;
// By the wallet's own address, one probe each way, and only then whose
// transfers they are. Left to itself Postgres probes each live collection's
// index in turn, one probe per collection each way for a wallet none of them
// names: OFFSET 0 keeps it from folding the address lookup into that.
const namedLive = (side: 'from_address' | 'to_address') =>
  `EXISTS (SELECT 1 FROM (SELECT x.collection_id FROM washtrace.transfers x WHERE x.${side} = w.address OFFSET 0) x
     JOIN washtrace.collections c ON c.id = x.collection_id WHERE c.chain_id = w.chain_id AND ${SERVED_LIVE})`;
export const servedWallet = (globalHops: string) =>
  `(CASE WHEN w.depth > 0 THEN w.depth <= ${globalHops} AND EXISTS (SELECT 1 FROM washtrace.collections c WHERE c.chain_id = w.chain_id AND ${SERVED_LIVE})
  ELSE ${namedLive('from_address')} OR ${namedLive('to_address')} END
  OR EXISTS (SELECT 1 FROM washtrace.reach r JOIN washtrace.collections c ON c.id = r.collection_id
             WHERE r.chain_id = w.chain_id AND r.address = w.address AND NOT r.stepped AND ${SERVED_LIVE} AND c.follow_hops > ${globalHops} AND ${SERVED_REACH(globalHops)}))`;

/**
 * The wallets `k.address` sent money to on chain `chain`, as `fund` queues
 * them: one row each, `p.address`, but itself and `exclude`, and none at all
 * when it paid more than `fanout`. Read by flows_moves_idx in payee order,
 * no further than one past the fanout, so a wallet paying thousands costs
 * what one paying 26 does. The one rule walkOut and seedReach step by.
 */
const paidBy = (chain: string, exclude: string, fanout: string) => `
  CROSS JOIN LATERAL (
    SELECT array_agg(s.to_address) AS paid FROM (
      SELECT DISTINCT f.to_address FROM washtrace.flows f
      WHERE f.chain_id = ${chain} AND f.from_address = k.address AND f.to_address <> k.address AND f.to_address <> ALL (${exclude}::text[])
      LIMIT ${fanout}::int + 1
    ) s
  ) s
  CROSS JOIN LATERAL unnest(CASE WHEN cardinality(s.paid) <= ${fanout} THEN s.paid END) AS p(address)`;

/**
 * Walk out from collection `id`'s traders over the stored flows, `depth`
 * sent-to steps, into the temporary table `walked` (address, depth): every
 * wallet reached, at its shallowest depth out from these traders. That is
 * this collection's depth, not wallets.depth, the chain's shallowest from
 * any collection's, so a wallet at chain depth 2 can be at 3 here. A step
 * takes a wallet's payees as `fund` would have queued them: only from one
 * checked to the end (done, not truncated), and only when it paid at least
 * one and at most `follow.fanout` wallets but itself and `follow.exclude`.
 * Depth 0 is the collection's transfer parties but `follow.exclude`, as
 * `traders` queues them. The walk a collection's next hop is counted by;
 * seedReach walks by the same step (paidBy), a chunk at a time, into reach.
 *
 * A level a statement, so no wallet comes to Node; each wallet's payees are
 * paidBy's. The cost is per wallet stepped from, so at most `cap` are, in
 * all: each level may take its share of what is left, split over the levels
 * still to walk, so a collection with more traders than the cap still walks
 * every level. A level with more wallets than that takes a sample of them,
 * and what it reaches is scaled up by its wallets over those it took
 * (`scale`, the product over every level cut; `cut` when any was). Infinity
 * walks them all.
 *
 * Runs in the caller's transaction, once: its end drops the table. It stops
 * by `until` (epoch ms; see timeLeft), failing the transaction. Gives
 * about how many wallets each depth holds, scaled as it was cut, depth 0 the
 * traders.
 */
export async function walkOut(
  c: pg.PoolClient, id: number, chainId: number, depth: number, follow: Pick<Follow, 'fanout' | 'exclude'>, cap: number, until: number,
): Promise<{ counts: number[]; scale: number; cut: boolean }> {
  await c.query('CREATE TEMP TABLE walked (address text PRIMARY KEY, depth int NOT NULL) ON COMMIT DROP');
  await timeLeft(c, until);
  const traders = await c.query(
    `INSERT INTO walked (address, depth)
     SELECT a, 0 FROM (SELECT from_address AS a FROM washtrace.transfers WHERE collection_id = $1
                       UNION SELECT to_address FROM washtrace.transfers WHERE collection_id = $1) t
     WHERE a <> ALL ($2::text[])`,
    [id, follow.exclude],
  );
  const counts = [traders.rowCount ?? 0];
  // The wallets at depth $2 a step can follow out from.
  const steppable = `walked k JOIN washtrace.wallets w ON w.chain_id = $1 AND w.address = k.address AND w.status = 'done' AND NOT w.truncated
    WHERE k.depth = $2`;
  let scale = 1, cut = false, stepped = 0;
  for (let d = 0; d < depth; d++) {
    await timeLeft(c, until);
    const frontier = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${steppable}`, [chainId, d])).rows[0]!.n;
    const take = Math.min(frontier, Math.max(1, Math.floor((cap - stepped) / (depth - d))));
    const sampled = take < frontier;
    // A level not cut has no LIMIT (NULL): outside a snapshot a wallet checked
    // since the count would push one past it, dropped unsaid with nothing cut.
    // A cut one samples by md5, not address order: the lowest addresses are
    // vanity, bot and contract wallets, unlike the rest, and would skew the scale.
    // A payee already walked is nearer, or as near: ON CONFLICT keeps its depth.
    await timeLeft(c, until);
    const step = take === 0 ? null : await c.query(
      `INSERT INTO walked (address, depth)
       SELECT p.address, $2::int + 1 FROM (SELECT k.address FROM ${steppable} ${sampled ? 'ORDER BY md5(k.address)' : ''} LIMIT $5) k
       ${paidBy('$1', '$3', '$4')}
       ON CONFLICT (address) DO NOTHING`,
      [chainId, d, follow.exclude, follow.fanout, sampled ? take : null],
    );
    stepped += take;
    if (sampled) {
      scale *= frontier / take;
      cut = true;
    }
    counts.push((step?.rowCount ?? 0) * scale);
  }
  return { counts, scale, cut };
}

/**
 * Catch collection `id`'s walk up with its limit L (REACH_LIMIT), at the start of each seedReach turn: whichever limit
 * rose, its own (Fetch them) or follow.hops. Past the reach_hops it was
 * last walked to, the wallets marked stepped at the old limit without being
 * followed (stepReach) are unmarked, so the walk goes on from them, and
 * reach_hops is written L, both in this one transaction: the next turn finds
 * the two equal and unmarks nothing, so no turn undoes the steps the one
 * before took. reach_hops is written nowhere else. A lowered L is only
 * recorded, so a later raise unmarks from where the walk last stopped. A
 * raised walk is not seeded until a turn finds nothing more to do again.
 *
 * In reachStatement's transaction, under its KEY SHARE, so a press's FOR
 * UPDATE waits for it, or it for the press. It writes the
 * collection's row after its reach, and touches no wallet: fund takes the
 * row after a wallet, and every other writer of reach takes the row first,
 * so nothing it waits on waits on it. True when it raised.
 */
export async function raiseReach(c: pg.PoolClient, id: number, globalHops: number): Promise<boolean> {
  const own = (await c.query<{ l: number; walked: number | null }>(
    `SELECT ${REACH_LIMIT('$2')} AS l, reach_hops AS walked FROM washtrace.collections WHERE id = $1`, [id, globalHops],
  )).rows[0]!;
  if (own.l === own.walked) return false;
  const raised = own.l > (own.walked ?? 0);
  if (raised) await c.query('UPDATE washtrace.reach SET stepped = false WHERE collection_id = $1 AND depth >= $2 AND stepped', [id, own.walked ?? 0]);
  await c.query(
    'UPDATE washtrace.collections SET reach_hops = $2, reach_seeded_at = CASE WHEN $3 THEN NULL ELSE reach_seeded_at END WHERE id = $1',
    [id, own.l, raised],
  );
  return raised;
}

/**
 * Step from at most `limit` of collection `id`'s reach wallets checked since
 * they were added, shallowest first, out to its limit L (see seedReach). One
 * at L is marked stepped and not followed, so it leaves reach_unstepped_idx;
 * raiseReach unmarks those when L next rises past the reach_hops it records,
 * and a press while this step runs leaves them unmarked, as the mark reads L
 * afresh. Stepped is marked only where the depth is still the one stepped
 * from: one moved nearer in the same step is stepped from again.
 *
 * A payee goes into wallets at the nearer of its sender's chain depth and
 * this walk's, plus one, and a wallet already there deeper is moved in to
 * it: wallets.depth is the shallowest depth out from any
 * collection's traders, and a reach depth is one of those, so a wallet
 * within follow.hops for this collection is the followed lane's to check,
 * never left deeper where no lane serves it.
 *
 * Gives how many it stepped from, and `doneFar`: how many reach rows it
 * added, or moved nearer, past `globalHops` whose wallet is checked already,
 * for seedReach to bump the version by.
 */
export async function stepReach(c: pg.PoolClient, id: number, chainId: number, limit: number, globalHops: number): Promise<{ stepped: number; doneFar: number }> {
  const ownHops = (await c.query<{ l: number }>(`SELECT ${REACH_LIMIT('$2')} AS l FROM washtrace.collections WHERE id = $1`, [id, globalHops])).rows[0]!.l;
  // To Node, at most `limit` rows: a call with nothing to step makes no temporary table.
  const { rows: k } = await c.query<{ address: string; depth: number; chain_depth: number; truncated: boolean }>(
    `SELECT r.address, r.depth, w.depth AS chain_depth, w.truncated FROM washtrace.reach r
     JOIN washtrace.wallets w ON w.chain_id = $2 AND w.address = r.address AND w.status = 'done'
     WHERE r.collection_id = $1 AND NOT r.stepped AND r.depth <= $3
     ORDER BY r.depth LIMIT $4`,
    [id, chainId, ownHops, limit],
  );
  if (k.length === 0) return { stepped: 0, doneFar: 0 };
  // A truncated wallet's money is not all read, so it is not followed (as `fund`), only marked.
  const from = k.filter((x) => !x.truncated && x.depth < ownHops);
  let doneFar = 0;
  if (from.length > 0) {
    const { exclude, fanout } = followOf(chainId, ownHops);
    await c.query(
      `CREATE TEMP TABLE paid ON COMMIT DROP AS
       SELECT p.address, min(k.depth) + 1 AS depth, min(least(k.chain_depth, k.depth)) + 1 AS chain_depth
       FROM unnest($4::text[], $5::int[], $6::int[]) AS k(address, depth, chain_depth) ${paidBy('$1', '$2', '$3')}
       GROUP BY p.address`,
      [chainId, exclude, fanout, from.map((x) => x.address), from.map((x) => x.depth), from.map((x) => x.chain_depth)],
    );
    // In address order, as every writer of wallets writes, so two never wait on each other in a circle. Only the
    // payees new to wallets or nearer than it says: DO UPDATE locks, and so dirties, every row it meets, its WHERE
    // false or not, and most are as near already. The WHERE still holds for one written since.
    await c.query(
      `INSERT INTO washtrace.wallets (chain_id, address, depth)
       SELECT $1, p.address, p.chain_depth FROM paid p
       WHERE NOT EXISTS (SELECT 1 FROM washtrace.wallets w WHERE w.chain_id = $1 AND w.address = p.address AND w.depth <= p.chain_depth)
       ORDER BY p.address
       ON CONFLICT (chain_id, address) DO UPDATE SET depth = EXCLUDED.depth WHERE washtrace.wallets.depth > EXCLUDED.depth`,
      [chainId],
    );
    // The rows it added or moved nearer past the global limit whose wallet is checked already: the wallets
    // read by the statement before, as this one's snapshot is taken after it.
    doneFar = (await c.query<{ n: number }>(
      `WITH added AS (
         INSERT INTO washtrace.reach (collection_id, chain_id, address, depth) SELECT $1, $2, address, depth FROM paid ORDER BY address
         ON CONFLICT (collection_id, address) DO UPDATE SET depth = EXCLUDED.depth, stepped = false WHERE washtrace.reach.depth > EXCLUDED.depth
         RETURNING address, depth
       )
       SELECT count(*)::int AS n FROM added a JOIN washtrace.wallets w ON w.chain_id = $2 AND w.address = a.address
       WHERE a.depth > $3 AND w.status = 'done'`,
      [id, chainId, globalHops],
    )).rows[0]!.n;
  }
  await c.query(
    `UPDATE washtrace.reach r SET stepped = true FROM unnest($2::text[], $3::int[]) AS k(address, depth)
     WHERE r.collection_id = $1 AND r.address = k.address AND r.depth = k.depth
       AND (k.depth < $4 OR k.depth >= (SELECT ${REACH_LIMIT('$5')} FROM washtrace.collections WHERE id = $1))`,
    [id, k.map((x) => x.address), k.map((x) => x.depth), ownHops, globalHops],
  );
  return { stepped: k.length, doneFar };
}

/**
 * Add collection `id`'s traders not in its reach at depth 0 yet, or move one
 * found further out in to it: its transfer parties but the addresses never
 * followed, as walkOut starts. All in one statement, so the walk steps from
 * every trader's depth 0 before any depth 1, and steps from none twice; a
 * collection's traders are tens of thousands, a second or so. Only the
 * traders not at depth 0 already reach the insert, as in stepReach: DO
 * UPDATE locks, and so dirties, every row it meets, its WHERE false or not,
 * and once a day that would be every trader. The WHERE still holds for one
 * written since.
 */
export async function addTraders(c: pg.PoolClient, id: number, chainId: number): Promise<number> {
  const { rowCount } = await c.query(
    `INSERT INTO washtrace.reach (collection_id, chain_id, address, depth)
     SELECT $1, $2, t.a, 0 FROM (SELECT from_address AS a FROM washtrace.transfers WHERE collection_id = $1
                                 UNION SELECT to_address FROM washtrace.transfers WHERE collection_id = $1) t
     WHERE t.a <> ALL ($3::text[])
       AND NOT EXISTS (SELECT 1 FROM washtrace.reach r WHERE r.collection_id = $1 AND r.address = t.a AND r.depth = 0)
     ORDER BY t.a
     ON CONFLICT (collection_id, address) DO UPDATE SET depth = 0, stepped = false WHERE washtrace.reach.depth > 0`,
    [id, chainId, followOf(chainId, 0).exclude],
  );
  return rowCount ?? 0;
}

/**
 * Give the transaction's next statement what is left until `until` (epoch
 * ms), so a run of statements stops by then in all: statement_timeout is
 * each statement's own. Past it, the next is given a millisecond, and fails.
 */
export async function timeLeft(c: pg.PoolClient, until: number): Promise<void> {
  await c.query("SELECT set_config('statement_timeout', $1, true)", [`${Math.max(1, until - Date.now())}ms`]);
}
