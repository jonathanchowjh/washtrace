import { HEADLINE, METHODS, type Method, type Transfer, type Witness } from './types.js';
import { AGE_BANDS, FLOOR_BANDS, HELD_BANDS, VENUES, findOf, type TradeContext, type TradeGroupBy, type TradeQuery } from './trades.js';

/**
 * One row of a Trades list: the transfer, the lenses that ran and flag it, and
 * its facts. One no analysis has covered yet is not judged: it has no facts and
 * no lenses, which is not the same as clean.
 */
export interface TradeRow extends Transfer { lenses: Method[]; judged: boolean; heldS: number | null; buyerAgeS: number | null; floorRatio: number | null }

/** One Group by row: its key ('-' for unknown), its trades, and how many each lens that ran caught. */
export interface TradeGroup { key: string; trades: number; caught: Partial<Record<Method, number>> }

export type TokenSort = 'caught' | 'share' | 'volume' | 'newest';
export type WalletSort = 'caught' | 'share' | 'volume' | 'first';
/**
 * One row of a lens's token list. `trades` are the token's counted changes of
 * owner (no mints, no custody moves) and `caught` those the lens flags. The
 * rest is over the loops its caught trades point at: `loops` the round trips
 * (`closedByMoney` of them closed by a payment, `laps` their cycles summed),
 * `pairs` the linked pairs (`middles` of them through a third wallet), and
 * `wallets` every wallet in any of them. `volumeWei` is its caught sales priced
 * in money; `lastAt` its newest counted trade.
 */
export interface TokenLine { tokenId: string; caught: number; trades: number; volumeWei: string; lastAt: number | null; loops: number; pairs: number; wallets: number; closedByMoney: number; laps: number; middles: number }
/**
 * One row of a lens's wallet list, counted as a token's are; `partners` are the other wallets in its loops.
 * `firstAt` is its first *counted* trade, of the trades `trades` counts: a mint into it is not one.
 */
export interface WalletLine { address: string; caught: number; trades: number; volumeWei: string; firstAt: number | null; loops: number; pairs: number; partners: number }
/** A lens list's order, its Find box's text (read by findOf), and its page. */
export interface ListOpts<S> { sort: S; find: string | null; limit: number; offset: number }
/**
 * What a wallet's trades are narrowed to: one collection (its address), those
 * counted flagged, a Find read by findOf, and those with one other wallet on
 * the other side.
 */
export interface WalletFilter { collection?: string; flaggedOnly?: boolean; find?: string; with?: string }
/** A wallet's money partners' orders: most payments, most it sent, most it received, those trading a watched collection first. */
export type PartnerSort = 'flows' | 'sent' | 'received' | 'watched';
/** Which payments between two wallets: the first's to the second, back, or both. */
export type FlowDir = 'sent' | 'received' | 'both';

/** The columns of a transfer `t`, as toTransfer reads them: the start of a SELECT, to which a FROM follows. */
export const SELECT_TRANSFER = `
SELECT t.tx_hash, t.log_index, t.block_number, extract(epoch FROM t.block_time)::float8 AS bt, t.token_id::text AS token_id,
       t.from_address, t.to_address, t.marketplace, t.price_wei::text AS price_wei, t.currency`;

/** A transfer with the lenses that flagged it and why. Where a read spans collections, the collection each belongs to. */
export interface FlaggedTransfer extends Transfer {
  flags: Partial<Record<Method, Witness>>;
  /** Present on reads that span collections. */
  collection?: { chainId: number; address: string; name: string | null };
}

/** A transfer's table `t` with its collection `c`: what the console's reads select from. */
export const TRANSFERS = 'FROM washtrace.transfers t JOIN washtrace.collections c ON c.id = t.collection_id';

/** The flags on transfer `t`, by method, as one json column. */
export const FLAGS_AGG = `(SELECT jsonb_object_agg(f.method, f.witness) FROM washtrace.flags f
  WHERE f.collection_id = t.collection_id AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index) AS flags`;

// bigint and numeric columns arrive as strings; each is converted where it is read.
export function toTransfer(r: any): Transfer {
  return {
    txHash: r.tx_hash, logIndex: r.log_index, blockNumber: Number(r.block_number), blockTime: r.bt,
    tokenId: r.token_id, from: r.from_address, to: r.to_address, marketplace: r.marketplace, priceWei: r.price_wei, currency: r.currency,
  };
}

export function toFlagged(r: any): FlaggedTransfer {
  const t: FlaggedTransfer = { ...toTransfer(r), flags: r.flags ?? {} };
  if (r.collection_address !== undefined) t.collection = { chainId: r.chain_id, address: r.collection_address, name: r.collection_name };
  return t;
}

export function toTrade(r: any): TradeRow {
  const num = (v: unknown) => (v === null ? null : Number(v));
  return {
    ...toTransfer(r), lenses: METHODS.filter((m) => r.lenses.includes(m)), judged: r.judged,
    heldS: num(r.held_s), buyerAgeS: num(r.buyer_age_s), floorRatio: r.floor_ratio,
  };
}

/** A Trades list's rows: each transfer `t`, and its facts `x` when an analysis has judged it. */
export const TRADES_FROM = `FROM washtrace.transfers t
  LEFT JOIN washtrace.trade_facts x ON x.collection_id = t.collection_id AND x.tx_hash = t.tx_hash AND x.log_index = t.log_index`;

/**
 * Which of a wallet's transfers `filter` holds: those on chain `chainId` it
 * sent or received, through the per-address indexes. Flagged only is what the
 * console calls flagged (counted in apps/web/lib/metrics.ts): a HEADLINE lens
 * flags it and ran in its own collection's latest analysis. The engine copies
 * Round trips' flags into the money lenses when no funding ran, so a Linked
 * wallets flag where it did not run is no flag. A Find is read by findOf: a
 * token number, or the other side of the trade by its address or the start of
 * it; anything else matches nothing.
 */
export function walletWhere(chainId: number, address: string, filter: WalletFilter, params: unknown[]): string {
  const p = binder(params);
  const chain = p(chainId), self = p(address);
  const where = [`c.chain_id = ${chain}`, `(t.from_address = ${self} OR t.to_address = ${self})`];
  if (filter.collection !== undefined) where.push(`c.address = ${p(filter.collection.toLowerCase())}`);
  if (filter.flaggedOnly) {
    where.push(`EXISTS (SELECT 1 FROM washtrace.flags f
      WHERE f.collection_id = t.collection_id AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index AND f.method = ANY(${p(HEADLINE)}::text[])
        AND (SELECT a.totals FROM washtrace.analyses a WHERE a.collection_id = t.collection_id ORDER BY a.ran_at DESC LIMIT 1) -> f.method ->> 'available' = 'true')`);
  }
  // The other side: the buyer of what it sold, the seller of what it bought.
  const other = (op: '=' | 'LIKE', v: string) => {
    const o = p(v);
    where.push(`((t.from_address = ${self} AND t.to_address ${op} ${o}) OR (t.to_address = ${self} AND t.from_address ${op} ${o}))`);
  };
  if (filter.with !== undefined) other('=', filter.with.toLowerCase());
  if (filter.find !== undefined) {
    const f = findOf(filter.find);
    if (f.kind === 'token') where.push(`t.token_id = ${p(f.tokenId)}::numeric`);
    else if (f.kind === 'address') other('=', f.address);
    // Hex only, so the pattern holds no wildcard but its own.
    else if (f.kind === 'prefix') other('LIKE', `${f.prefix}%`);
    else where.push('false');
  }
  return where.join(' AND ');
}

/** A wallet's money partners: each flow it sent ('out') or received ('in'), as `other` and `dir`. Wallet `$2` on chain `$1`. */
export const PARTNERS_FROM = `FROM (SELECT to_address AS other, 'out' AS dir FROM washtrace.flows WHERE chain_id = $1 AND from_address = $2
  UNION ALL SELECT from_address, 'in' FROM washtrace.flows WHERE chain_id = $1 AND to_address = $2) x WHERE other <> $2`;
/** The partner orders, over the rows `p`; counterparties adds the address last. */
export const PARTNER_ORDER: Readonly<Record<PartnerSort, string>> = {
  flows: 'p.flows DESC',
  sent: 'p.sent DESC, p.flows DESC',
  received: 'p.received DESC, p.flows DESC',
  watched: 'p.watched DESC, p.flows DESC',
};
/** The payments from `$2` to `$3` on chain `$1`, or back, or both. */
export function betweenWhere(dir: FlowDir): string {
  const sent = 'f.from_address = $2 AND f.to_address = $3', received = 'f.from_address = $3 AND f.to_address = $2';
  return `f.chain_id = $1 AND ${dir === 'sent' ? sent : dir === 'received' ? received : `((${sent}) OR (${received}))`}`;
}

/** Binds `v` into `params` and gives its placeholder. */
export const binder = (params: unknown[]) => (v: unknown): string => {
  params.push(v);
  return `$${params.length}`;
};

/** Whether lens `m` flags transfer `t`. Only ever asked of a lens in `ctx.ran`. */
const flaggedBy = (m: Method, p: (v: unknown) => string) =>
  `EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = t.collection_id AND f.method = ${p(m)} AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index)`;

/** A whole number as Postgres numeric takes it: a wei amount or a token id. */
const WHOLE = /^\d{1,78}$/;

/** A lens's caught trades: its flags `f` (lens `$2`) on the counted transfers `t` of collection `$1`, with their facts `x`. */
export const CAUGHT_FROM = `FROM washtrace.flags f
  JOIN washtrace.transfers t ON t.collection_id = f.collection_id AND t.tx_hash = f.tx_hash AND t.log_index = f.log_index
  JOIN washtrace.trade_facts x ON x.collection_id = f.collection_id AND x.tx_hash = f.tx_hash AND x.log_index = f.log_index`;
export const CAUGHT_WHERE = 'f.collection_id = $1 AND f.method = $2 AND x.counted';
/** Transfer `t`'s facts, when the analysis counted it. */
export const COUNTED_JOIN = 'JOIN washtrace.trade_facts x ON x.collection_id = t.collection_id AND x.tx_hash = t.tx_hash AND x.log_index = t.log_index AND x.counted';
/** Transfer `t` once for each wallet in it, as `s.address`: a wallet that sold to itself is in it once. */
export const SIDES = 'CROSS JOIN LATERAL unnest(CASE WHEN t.to_address = t.from_address THEN ARRAY[t.from_address] ELSE ARRAY[t.from_address, t.to_address] END) s(address)';
/**
 * What a lens list row's caught trades add up to: how many, their volume (sales
 * priced in money, `$3`), and the loops they point at, repeats and all; a read
 * by `= ANY` takes each loop once.
 */
export const CAUGHT_COLUMNS = `count(*)::int AS caught,
  COALESCE(sum(CASE WHEN t.marketplace IS NOT NULL AND t.currency = ANY($3::text[]) THEN t.price_wei END), 0) AS volume,
  array_agg(f.witness_id) AS ids`;
/** A lens list's orders, over its rows `c`; each caller adds its own key last, so ties keep one order. */
export const LIST_ORDER = {
  caught: 'c.caught DESC',
  share: 'c.caught::float8 / c.trades DESC, c.caught DESC',
  volume: 'c.volume DESC',
  at: 'c.at DESC NULLS LAST',
} as const;

/**
 * A lens list row `c`'s loops: the witnesses in its `ids`, counted by kind, and
 * the wallets in any of them other than `self`. Distinct by hashing rather than
 * count(DISTINCT), which sorts: a ring wallet's loops can hold 75,000 wallets.
 */
export function loopsOf(self: string | null): string {
  return `CROSS JOIN LATERAL (SELECT
      count(*) FILTER (WHERE w.kind IN ('scc', 'scc+flow'))::int AS loops,
      count(*) FILTER (WHERE w.kind = 'scc+flow')::int AS closed,
      COALESCE(sum(w.cycles) FILTER (WHERE w.kind IN ('scc', 'scc+flow')), 0)::int AS laps,
      count(*) FILTER (WHERE w.kind = 'pair')::int AS pairs,
      count(*) FILTER (WHERE w.kind = 'pair' AND w.middle IS NOT NULL)::int AS middles,
      (SELECT count(*)::int FROM (SELECT DISTINCT a FROM washtrace.witnesses v CROSS JOIN unnest(v.wallets) a
       WHERE v.collection_id = $1 AND v.id = ANY(c.ids)${self === null ? '' : ` AND a <> ${self}`}) d) AS wallets
    FROM washtrace.witnesses w WHERE w.collection_id = $1 AND w.id = ANY(c.ids)) s`;
}

/**
 * The one place a Trades list's filters become SQL. The page, its count, its
 * groups and its stream all read through it, so they always hold the same
 * trades. Every value is bound into `params`. Flags are read only for lenses
 * in `ctx.ran`: when funding did not run, the engine copies every Round trips
 * flag into the money lenses, and those copies caught nothing.
 */
export function tradeWhere(id: number, q: TradeQuery, ctx: TradeContext, params: unknown[]): string {
  const p = binder(params);
  const ran = (m: Method) => ctx.ran.includes(m);
  const c = p(id);
  // Counted, or not judged yet. A transfer the analysis did not count (a mint, a custody move) is no trade.
  const where = [`t.collection_id = ${c}`, '(x.counted OR x.tx_hash IS NULL)'];
  const none = () => where.push('false');
  if (q.kind === 'sales') where.push('t.marketplace IS NOT NULL');
  if (q.caught.some((m) => !ran(m))) none();
  for (const m of q.caught.filter(ran)) where.push(flaggedBy(m, p));
  // Not caught is judged and clean. A lens that did not run is ignored here, and the page says so.
  const clean = q.notCaught.filter(ran);
  if (clean.length) where.push('x.tx_hash IS NOT NULL', ...clean.map((m) => `NOT ${flaggedBy(m, p)}`));
  if (q.venues.length) where.push(`t.marketplace = ANY(${p(q.venues.flatMap((v) => VENUES[v]?.raw ?? [v]))}::text[])`);
  if (q.priceMinWei !== null || q.priceMaxWei !== null) {
    // A price in anything but money says nothing of a bound in ETH, and an unpriced sale none at all.
    where.push(`t.price_wei IS NOT NULL AND t.currency = ANY(${p([...ctx.money])}::text[])`);
    for (const [bound, op] of [[q.priceMinWei, '>='], [q.priceMaxWei, '<=']] as const) {
      if (bound === null) continue;
      if (WHOLE.test(bound)) where.push(`t.price_wei ${op} ${p(bound)}::numeric`);
      else none();
    }
  }
  const span = (col: string, over: number | null, under: number | null) => {
    if (over !== null) where.push(`${col} >= ${p(over)}::float8`);
    if (under !== null) where.push(`${col} < ${p(under)}::float8`);
  };
  span('x.held_s', q.heldOverS, q.heldUnderS);
  span('x.buyer_age_s', q.buyerAgeOverS, q.buyerAgeUnderS);
  span('x.floor_ratio', q.floorMin, q.floorMax);
  if (q.fromMs !== null) where.push(`t.block_time >= to_timestamp(${p(q.fromMs / 1000)}::float8)`);
  if (q.toMs !== null) where.push(`t.block_time < to_timestamp(${p(q.toMs / 1000)}::float8)`);
  const either = (address: string) => {
    const a = p(address);
    where.push(`(t.from_address = ${a} OR t.to_address = ${a})`);
  };
  if (q.wallet !== null) either(q.wallet.toLowerCase());
  if (q.token !== null) {
    if (WHOLE.test(q.token)) where.push(`t.token_id = ${p(q.token)}::numeric`);
    else none();
  }
  if (q.group !== null) {
    const g = q.group;
    if (!ran(g.method)) none();
    else {
      const m = p(g.method);
      // The loops: those the lens flags on the token, or those holding the wallet, found through the GIN index.
      const loops = 'token' in g
        ? WHOLE.test(g.token)
          ? `w.id IN (SELECT f.witness_id FROM washtrace.flags f
               JOIN washtrace.transfers ft ON ft.collection_id = f.collection_id AND ft.tx_hash = f.tx_hash AND ft.log_index = f.log_index
               WHERE f.collection_id = ${c} AND f.method = ${m} AND ft.token_id = ${p(g.token)}::numeric)`
          : 'false'
        : `w.wallets @> ARRAY[${p(g.wallet.toLowerCase())}]::text[]
           AND EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = w.collection_id AND f.method = ${m} AND f.witness_id = w.id)`;
      const set = `ARRAY(SELECT DISTINCT unnest(w.wallets) FROM washtrace.witnesses w WHERE w.collection_id = ${c} AND ${loops})`;
      where.push(`t.from_address = ANY(${set}) AND t.to_address = ANY(${set})`);
    }
  }
  if (q.find !== null) {
    const f = findOf(q.find);
    if (f.kind === 'token') where.push(`t.token_id = ${p(f.tokenId)}::numeric`);
    else if (f.kind === 'tx') where.push(`t.tx_hash = ${p(f.tx)}`);
    else if (f.kind === 'address') either(f.address);
    else if (f.kind === 'prefix') {
      // Hex only, so the pattern holds no wildcard but its own; the text_pattern_ops indexes serve it.
      const a = p(`${f.prefix}%`);
      where.push(`(t.from_address LIKE ${a} OR t.to_address LIKE ${a})`);
    } else none();
  }
  return where.join(' AND ');
}

/** A transfer's VENUES key, as venueOf gives it, in SQL; null when it is no sale. The raw strings are bound. */
function venueCase(p: (v: unknown) => string): string {
  const arms = Object.entries(VENUES).map(([key, v]) => `WHEN t.marketplace = ANY(${p(v.raw)}::text[]) THEN ${p(key)}::text`);
  return `CASE ${arms.join(' ')} ELSE t.marketplace END`;
}

/** A Trades list's order. Ties, and every key with no value, go newest first after the rest. */
export function tradeOrder(q: TradeQuery, ctx: TradeContext, params: unknown[]): string {
  const p = binder(params);
  const newest = 't.block_time DESC NULLS LAST, t.block_number DESC, t.log_index DESC, t.tx_hash DESC';
  if (q.sort === 'date') return q.dir === 'asc' ? 't.block_time ASC NULLS LAST, t.block_number, t.log_index, t.tx_hash' : newest;
  const lens = q.sort.startsWith('lens-') ? (q.sort.slice(5) as Method) : null;
  const key = lens !== null ? (ctx.ran.includes(lens) ? flaggedBy(lens, p) : null)
    // A price in anything but money is not comparable, so it sorts with the unpriced.
    : q.sort === 'price' ? `CASE WHEN t.currency = ANY(${p([...ctx.money])}::text[]) THEN t.price_wei END`
    : q.sort === 'held' ? 'x.held_s'
    : q.sort === 'buyerAge' ? 'x.buyer_age_s'
    : q.sort === 'floor' ? 'x.floor_ratio'
    : q.sort === 'token' ? 't.token_id'
    : q.sort === 'marketplace' ? venueCase(p)
    : q.sort === 'seller' ? 't.from_address'
    : null;
  return key === null ? newest : `${key} ${q.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, ${newest}`;
}

/** The rows of a Trades list, sorted, for a page to cut or a cursor to stream. */
export function tradeSelect(id: number, q: TradeQuery, ctx: TradeContext, params: unknown[]): string {
  const ran = binder(params)([...ctx.ran]);
  return `${SELECT_TRANSFER}, x.tx_hash IS NOT NULL AS judged, x.held_s, x.buyer_age_s, x.floor_ratio,
    ARRAY(SELECT f.method FROM washtrace.flags f
          WHERE f.collection_id = t.collection_id AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index AND f.method = ANY(${ran}::text[])) AS lenses
    ${TRADES_FROM} WHERE ${tradeWhere(id, q, ctx, params)} ORDER BY ${tradeOrder(q, ctx, params)}`;
}

/** What a trade is grouped by: a band's index, a month in the reader's zone, or a venue; '-' when unknown. */
export function groupKey(by: TradeGroupBy, ctx: TradeContext, params: unknown[]): string {
  const p = binder(params);
  const bandOf = (col: string, edges: readonly number[]) =>
    `CASE WHEN ${col} IS NULL THEN '-' ELSE (${edges.map((e) => `(${col} >= ${p(e)}::float8)::int`).join(' + ')})::text END`;
  if (by === 'held') return bandOf('x.held_s', HELD_BANDS);
  if (by === 'buyerAge') return bandOf('x.buyer_age_s', AGE_BANDS);
  if (by === 'floor') return bandOf('x.floor_ratio', FLOOR_BANDS);
  // The wall-clock time in the zone, formatted: to_char of a timestamptz would format in the session's zone.
  if (by === 'month') return `COALESCE(to_char(t.block_time AT TIME ZONE ${p(ctx.zone)}::text, 'YYYY-MM'), '-')`;
  return `COALESCE(${venueCase(p)}, '-')`;
}
