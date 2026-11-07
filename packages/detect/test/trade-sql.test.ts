import { describe, expect, it } from 'vitest';
import { tradeOrder, tradeWhere, walletWhere, betweenWhere } from '../src/trade-sql.js';
import { NO_FILTER, type TradeContext, type TradeQuery } from '../src/trades.js';

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
});
