import { describe, expect, it } from 'vitest';
import { caughtOf, flagSource, tradeOrder, tradeSelect, tradeWhere, walletWhere, betweenWhere } from '../src/trade-sql.js';
import { NO_FILTER, isLensKey, isOwnKey, lensIdOf, type TradeContext, type TradeQuery } from '../src/trades.js';

const ctx: TradeContext = { money: new Set(['ETH', 'WETH']), ran: ['A', 'AU'], zone: 'Europe/Paris' };
const rich: TradeQuery = {
  ...NO_FILTER, kind: 'sales', caught: ['A'], notCaught: ['AU', 'AC'], venues: ['opensea', 'blur'],
  priceMinWei: '1000', priceMaxWei: '9000', heldOverS: 10, heldUnderS: 20, buyerAgeOverS: 30, buyerAgeUnderS: 40,
  floorMin: 0.5, floorMax: 2, fromMs: 1_700_000_000_000, toMs: 1_700_100_000_000,
  wallet: '0xABC', group: { method: 'A', wallet: '0xDEF' }, token: '77', find: '0xabc123', sort: 'marketplace', dir: 'asc',
};

/** Pins the SQL text and bound parameters the console's trade queries build, so moving them changes nothing. */
describe('the console trade SQL', () => {
  it('tradeWhere builds one WHERE from every filter, in a fixed bind order', () => {
    const params: unknown[] = [];
    expect(tradeWhere(7, rich, ctx, params)).toBe("t.collection_id = $1 AND (x.counted OR x.tx_hash IS NULL) AND t.marketplace IS NOT NULL AND EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = t.collection_id AND f.method = $2 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index) AND x.tx_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = t.collection_id AND f.method = $3 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index) AND t.marketplace = ANY($4::text[]) AND t.price_wei IS NOT NULL AND t.currency = ANY($5::text[]) AND t.price_wei >= $6::numeric AND t.price_wei <= $7::numeric AND x.held_s >= $8::float8 AND x.held_s < $9::float8 AND x.buyer_age_s >= $10::float8 AND x.buyer_age_s < $11::float8 AND x.floor_ratio >= $12::float8 AND x.floor_ratio < $13::float8 AND t.block_time >= to_timestamp($14::float8) AND t.block_time < to_timestamp($15::float8) AND (t.from_address = $16 OR t.to_address = $16) AND t.token_id = $17::numeric AND t.from_address = ANY(ARRAY(SELECT DISTINCT unnest(w.wallets) FROM washtrace.witnesses w WHERE w.collection_id = $1 AND w.wallets @> ARRAY[$19]::text[]\n           AND EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = w.collection_id AND f.method = $18 AND f.witness_id = w.id))) AND t.to_address = ANY(ARRAY(SELECT DISTINCT unnest(w.wallets) FROM washtrace.witnesses w WHERE w.collection_id = $1 AND w.wallets @> ARRAY[$19]::text[]\n           AND EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = w.collection_id AND f.method = $18 AND f.witness_id = w.id))) AND (t.from_address LIKE $20 OR t.to_address LIKE $20)");
    expect(params).toEqual([7, "A", "AU", ["seaport-1.1", "seaport-1.4", "seaport-1.5", "seaport-1.6", "wyvern-1", "wyvern-2", "blur", "blur-v2"], ["ETH", "WETH"], "1000", "9000", 10, 20, 30, 40, 0.5, 2, 1700000000, 1700100000, "0xabc", "77", "A", "0xdef", "0xabc123%"]);
  });
  it('tradeOrder binds each venue arm, then falls back to newest', () => {
    const params: unknown[] = [];
    expect(tradeOrder(rich, ctx, params)).toBe("CASE WHEN t.marketplace = ANY($1::text[]) THEN $2::text WHEN t.marketplace = ANY($3::text[]) THEN $4::text WHEN t.marketplace = ANY($5::text[]) THEN $6::text WHEN t.marketplace = ANY($7::text[]) THEN $8::text ELSE t.marketplace END ASC NULLS LAST, t.block_time DESC NULLS LAST, t.block_number DESC, t.log_index DESC, t.tx_hash DESC");
    expect(params).toEqual([["seaport-1.1", "seaport-1.4", "seaport-1.5", "seaport-1.6", "wyvern-1", "wyvern-2"], "opensea", ["blur", "blur-v2"], "blur", ["looksrare", "looksrare-v2"], "looksrare", ["x2y2"], "x2y2"]);
  });
  it('walletWhere narrows one wallet by every filter', () => {
    const params: unknown[] = [];
    expect(walletWhere(1, '0xwallet', { collection: '0xABCD', flaggedOnly: true, find: '0xdead', with: '0xOTHER' }, params)).toBe("c.chain_id = $1 AND (t.from_address = $2 OR t.to_address = $2) AND c.address = $3 AND EXISTS (SELECT 1 FROM washtrace.flags f\n      WHERE f.collection_id = t.collection_id AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index AND f.method = ANY($4::text[])\n        AND (SELECT a.totals FROM washtrace.analyses a WHERE a.collection_id = t.collection_id ORDER BY a.ran_at DESC LIMIT 1) -> f.method ->> 'available' = 'true') AND ((t.from_address = $2 AND t.to_address = $5) OR (t.to_address = $2 AND t.from_address = $5)) AND ((t.from_address = $2 AND t.to_address LIKE $6) OR (t.to_address = $2 AND t.from_address LIKE $6))");
    expect(params).toEqual([1, "0xwallet", "0xabcd", ["A", "AC"], "0xother", "0xdead%"]);
  });
  it('betweenWhere reads the payments one way, the other, or both', () => {
    expect((['sent', 'received', 'both'] as const).map((d) => betweenWhere(d))).toEqual(["f.chain_id = $1 AND f.from_address = $2 AND f.to_address = $3", "f.chain_id = $1 AND f.from_address = $3 AND f.to_address = $2", "f.chain_id = $1 AND ((f.from_address = $2 AND f.to_address = $3) OR (f.from_address = $3 AND f.to_address = $2))"]);
  });
  it('a saved lens binds its id and reads lens_flags, in the filter, the order and the group', () => {
    const own: TradeContext = { ...ctx, ran: ['A', 'L7'] };
    const params: unknown[] = [];
    expect(tradeWhere(3, { ...NO_FILTER, caught: ['L7'], notCaught: ['A'] }, own, params)).toBe("t.collection_id = $1 AND (x.counted OR x.tx_hash IS NULL) AND t.marketplace IS NOT NULL AND EXISTS (SELECT 1 FROM washtrace.lens_flags f WHERE f.collection_id = t.collection_id AND f.lens_id = $2 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index) AND x.tx_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = t.collection_id AND f.method = $3 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index)");
    expect(params).toEqual([3, 7, 'A']);
    const sort: unknown[] = [];
    expect(tradeOrder({ ...NO_FILTER, sort: 'lens-L7', dir: 'desc' }, own, sort)).toBe("EXISTS (SELECT 1 FROM washtrace.lens_flags f WHERE f.collection_id = t.collection_id AND f.lens_id = $1 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index) DESC NULLS LAST, t.block_time DESC NULLS LAST, t.block_number DESC, t.log_index DESC, t.tx_hash DESC");
    expect(sort).toEqual([7]);
    const group: unknown[] = [];
    expect(tradeWhere(3, { ...NO_FILTER, group: { method: 'L7', wallet: '0xAB' } }, own, group)).toContain("ARRAY(SELECT DISTINCT unnest(f.wallets) FROM washtrace.lens_flags f WHERE f.collection_id = $1 AND f.lens_id = $2 AND f.wallets @> ARRAY[$3]::text[])");
    expect(group).toEqual([3, 7, '0xab']);
  });
  it('a lens not in ran, or a junk key, is never read', () => {
    const params: unknown[] = [];
    expect(tradeWhere(3, { ...NO_FILTER, caught: ['L8'] }, ctx, params)).toContain('AND false');
    expect(params).toEqual([3]);
  });
  it("a saved lens judged only through its run's block: \"not flagged by\" binds that block after its id, and a built-in binds none (Ruling FF)", () => {
    const own: TradeContext = { ...ctx, ran: ['A', 'L7'], through: { L7: 350, A: 5 } };
    const params: unknown[] = [];
    expect(tradeWhere(3, { ...NO_FILTER, notCaught: ['L7', 'A'] }, own, params)).toBe("t.collection_id = $1 AND (x.counted OR x.tx_hash IS NULL) AND t.marketplace IS NOT NULL AND x.tx_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM washtrace.lens_flags f WHERE f.collection_id = t.collection_id AND f.lens_id = $2 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index) AND t.block_number <= $3::bigint AND NOT EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = t.collection_id AND f.method = $4 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index)");
    expect(params).toEqual([3, 7, 350, 'A']);
    // A run that read every trade (a null block), or no block given, binds nothing.
    for (const through of [{ L7: null }, {}]) expect(tradeWhere(3, { ...NO_FILTER, notCaught: ['L7'] }, { ...own, through }, [])).not.toContain('block_number');
    // Caught needs none: a lens's flags are of the trades it read.
    expect(tradeWhere(3, { ...NO_FILTER, caught: ['L7'] }, own, [])).not.toContain('block_number');
  });
  it("caughtOf and tradeSelect keep a built-in's text, as main wrote it, with no lens of yours in ran", () => {
    const p: unknown[] = [7];
    expect(caughtOf('AU', p)).toEqual({
      from: 'FROM washtrace.flags f\n  JOIN washtrace.transfers t ON t.collection_id = f.collection_id AND t.tx_hash = f.tx_hash AND t.log_index = f.log_index\n  JOIN washtrace.trade_facts x ON x.collection_id = f.collection_id AND x.tx_hash = f.tx_hash AND x.log_index = f.log_index',
      where: 'f.collection_id = $1 AND f.method = $2 AND x.counted',
    });
    expect(p).toEqual([7, 'AU']);
    const params: unknown[] = [];
    expect(tradeSelect(7, { ...NO_FILTER, caught: ['A'], notCaught: ['AU'] }, ctx, params)).toBe("\nSELECT t.tx_hash, t.log_index, t.block_number, extract(epoch FROM t.block_time)::float8 AS bt, t.token_id::text AS token_id,\n       t.from_address, t.to_address, t.marketplace, t.price_wei::text AS price_wei, t.currency, x.tx_hash IS NOT NULL AS judged, x.held_s, x.buyer_age_s, x.floor_ratio,\n    ARRAY(SELECT f.method FROM washtrace.flags f\n          WHERE f.collection_id = t.collection_id AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index AND f.method = ANY($1::text[])) AS lenses\n    FROM washtrace.transfers t\n  LEFT JOIN washtrace.trade_facts x ON x.collection_id = t.collection_id AND x.tx_hash = t.tx_hash AND x.log_index = t.log_index WHERE t.collection_id = $2 AND (x.counted OR x.tx_hash IS NULL) AND t.marketplace IS NOT NULL AND EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = t.collection_id AND f.method = $3 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index) AND x.tx_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM washtrace.flags f WHERE f.collection_id = t.collection_id AND f.method = $4 AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index) ORDER BY t.block_time DESC NULLS LAST, t.block_number DESC, t.log_index DESC, t.tx_hash DESC");
    expect(params).toEqual([['A', 'AU'], 7, 'A', 'AU']);
  });
  it('flagSource gives a built-in the flags table and a lens its own', () => {
    const p: unknown[] = [1];
    expect(flagSource('AU', p)).toEqual({ from: 'washtrace.flags f', where: 'f.method = $2' });
    expect(flagSource('L12', p, 'g')).toEqual({ from: 'washtrace.lens_flags g', where: 'g.lens_id = $3' });
    expect(p).toEqual([1, 'AU', 12]);
  });
  it('isLensKey takes a method or L and a number with no leading zero, and lensIdOf reads the id', () => {
    for (const ok of ['A', 'AU', 'AC', 'L1', 'L7', 'L1234567890', 'L2147483647']) expect(isLensKey(ok)).toBe(true);
    for (const bad of ['', 'L', 'L0', 'L01', 'Lx', 'l7', 'L-1', 'L12345678901', 'L2147483648', 'L9999999999', 'L1.5', ' L1', 'B']) expect(isLensKey(bad)).toBe(false);
    expect([lensIdOf('A'), lensIdOf('L42')]).toEqual([null, 42]);
  });

  it('isOwnKey is the one test of "a lens of yours", for every reader: built-ins and junk are not', () => {
    for (const own of ['L1', 'L7', 'L2147483647']) expect(isOwnKey(own)).toBe(true);
    for (const not of ['A', 'AU', 'AC', 'L0', 'L01', 'Lx', 'L2147483648', '']) expect(isOwnKey(not)).toBe(false);
  });
});
