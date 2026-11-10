import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Store } from '../src/store.js';
import { NO_FILTER, type TradeContext, type TradeQuery } from '../src/trades.js';
import { MONEY, WETH, w } from './fixtures.js';

/**
 * The Trades table's reads at BAYC's size: a million transfers over 20,000
 * tokens and 5,000 wallets, with their facts, and 200,000 wash trades flagged
 * in 4,000 loops of 300 wallets each. Each shape of query must answer in
 * under a second.
 * Heavy, so it runs only when asked: WASHTRACE_SCALE=1. The plans print only
 * when vitest shows passing tests' console, which it does not by default here:
 *   WASHTRACE_SCALE=1 npx vitest run --project integration packages/detect/test/trades-scale.int.test.ts --silent=false --reporter=verbose
 */

const BUDGET_MS = 1_000;
const TRANSFERS = 1_000_000;
const TOKENS = 20_000;
const WALLETS = 5_000;
/** Wash rings: 16 of 300 wallets, the size of group the Trades page must open at once. */
const RINGS = 16;
const RING = 300;
/** Transfers past this block have no facts row: read after the analysis. */
const JUDGED = 990_000;
const PAGE = 50;

let pg: StartedPostgreSqlContainer;
let store: Store;
let id: number;
const CTX: TradeContext = { money: MONEY, ran: ['A'], zone: 'UTC' };
/** The plan of the last read probe explained, for a test to look inside. */
let lastPlan = '';
const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

describe.skipIf(process.env.WASHTRACE_SCALE !== '1')('trades at a million transfers', () => {
  beforeAll(async () => {
    // As the compose file runs it: a parallel query shares memory through /dev/shm.
    pg = await new PostgreSqlContainer('postgres:17-alpine').withSharedMemorySize(256 * 2 ** 20).start();
    store = Store.connect(pg.getConnectionUri());
    await store.migrate();
    id = (await store.addCollection(1, w('5ca1e'), 'Scale', 1)).id;
    const q = (sql: string, params: unknown[] = []) => store.pool.query(sql, params);
    // A sale a minute for two years; one transfer in ten is no sale, and some sales are unpriced or in WETH.
    // Every fifth is a wash trade: on a token that is a multiple of 5, between two wallets of one ring of RING.
    await q(
      `INSERT INTO washtrace.transfers (collection_id, tx_hash, log_index, block_number, block_time, token_id, from_address, to_address, marketplace, price_wei, currency)
       SELECT $1, '0x' || lpad(to_hex(i), 64, '0'), 0, i, timestamptz '2021-01-01' + i * interval '1 minute', i % $3,
              '0x' || lpad(to_hex(CASE WHEN i % 5 = 0 THEN (i % $3 / 5 % $6) * $7 + (i * 7919) % $7 ELSE (i * 7919) % $4 END), 40, '0'),
              '0x' || lpad(to_hex(CASE WHEN i % 5 = 0 THEN (i % $3 / 5 % $6) * $7 + (i * 104729 + 1) % $7 ELSE (i * 104729 + 1) % $4 END), 40, '0'),
              (ARRAY['blur', 'blur', 'blur', 'blur', 'blur', 'seaport-1.6', 'seaport-1.5', 'looksrare-v2', 'x2y2', NULL])[i % 10 + 1],
              CASE WHEN i % 10 = 9 OR i % 13 = 0 THEN NULL ELSE ((i % 97) + 1) * 10000000000000000::numeric END,
              CASE WHEN i % 10 = 9 OR i % 13 = 0 THEN NULL WHEN i % 7 = 0 THEN $5 ELSE '' END
       FROM generate_series(1, $2::bigint) i`,
      [id, TRANSFERS, TOKENS, WALLETS, WETH, RINGS, RING],
    );
    await q(
      `INSERT INTO washtrace.trade_facts (collection_id, tx_hash, log_index, counted, held_s, buyer_age_s, floor_ratio)
       SELECT collection_id, tx_hash, log_index, block_number % 50 <> 0, NULLIF((block_number * 7919) % (90 * 86400), 0),
              (block_number * 13) % (400 * 86400), CASE WHEN price_wei IS NOT NULL THEN (block_number % 300) / 100.0 END
       FROM washtrace.transfers WHERE collection_id = $1 AND block_number <= $2`,
      [id, JUDGED],
    );
    // A loop per washed token, of its ring's wallets: 4,000 loops, 250 to a ring, so a wallet's group is RING wallets.
    await q(
      `INSERT INTO washtrace.witnesses (collection_id, id, kind, wallets, cycles)
       SELECT $1, k, 'scc', ARRAY(SELECT '0x' || lpad(to_hex((k % $3) * $4 + j), 40, '0') FROM generate_series(0, $4 - 1) j), 2
       FROM generate_series(0, $2::int / 5 - 1) k`,
      [id, TOKENS, RINGS, RING],
    );
    // The wash trades flagged by Round trips (200,000), each pointing at its token's loop.
    await q(
      `INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness, witness_id)
       SELECT collection_id, 'A', tx_hash, log_index, '{"kind":"scc"}', (token_id / 5)::int
       FROM washtrace.transfers WHERE collection_id = $1 AND block_number % 5 = 0`,
      [id],
    );
    await q('VACUUM ANALYZE washtrace.transfers');
    await q('VACUUM ANALYZE washtrace.trade_facts');
    await q('VACUUM ANALYZE washtrace.witnesses');
    await q('VACUUM ANALYZE washtrace.flags');
  }, 900_000);

  afterAll(async () => {
    await store?.pool.end();
    await pg?.stop();
  });

  /**
   * Run a read once to warm the cache, then again timed, and EXPLAIN the
   * statement it sent. The statement is caught by overriding the pool's
   * query on this instance, so the store needs no seam for it.
   */
  async function probe<T>(name: string, read: () => Promise<T>, budget = BUDGET_MS): Promise<T> {
    await read();
    const sent: { sql: string; params?: unknown[] }[] = [];
    const real = store.pool.query.bind(store.pool);
    const connect = store.pool.connect.bind(store.pool);
    (store.pool as { query: unknown }).query = (sql: string, params: unknown[]) => {
      sent.push({ sql, params });
      return real(sql, params);
    };
    // A read in its own transaction (a lens list, with JIT off) sends through a client: those statements are caught too, until it is released.
    // pool.query takes its client by callback; that one is left alone, as its statement is caught above.
    (store.pool as { connect: unknown }).connect = async (cb?: unknown) => {
      if (cb !== undefined) return (connect as (cb: unknown) => void)(cb);
      const c = await connect();
      const [query, release] = [c.query, c.release];
      (c as { query: unknown }).query = (sql: string, params?: unknown[]) => {
        sent.push({ sql, params });
        return (query as (...a: unknown[]) => unknown).call(c, sql, params);
      };
      c.release = (...a: Parameters<typeof release>) => {
        Object.assign(c, { query, release });
        return release.apply(c, a);
      };
      return c;
    };
    const started = performance.now();
    let result: T;
    try {
      result = await read();
    } finally {
      Object.assign(store.pool, { query: real, connect });
    }
    const wall = performance.now() - started;
    // The read itself is the last statement with parameters; one sent with JIT off is explained with it off.
    const { sql, params } = sent.filter((s) => s.params !== undefined).at(-1)!;
    const c = await store.pool.connect();
    let plan: string;
    try {
      await c.query('BEGIN');
      if (sent.some((s) => s.sql === 'SET LOCAL jit = off')) await c.query('SET LOCAL jit = off');
      const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
      plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    lastPlan = plan;
    const executed = Number(/Execution Time: ([\d.]+) ms/.exec(plan)![1]);
    // Whether the planner would have used JIT, had it been left on: a plain EXPLAIN says so without running it.
    const planned = (await store.pool.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
    const jit = /JIT:[\s\S]*?Options: (.*)/.exec(planned)?.[1] ?? 'not planned';
    console.log(`\n=== ${name}: ${wall.toFixed(0)} ms wall, ${executed.toFixed(0)} ms executed, JIT ${plan.includes('JIT:') ? 'on' : 'off'} (left on: ${jit})\n${plan}`);
    expect(wall).toBeLessThan(budget);
    expect(executed).toBeLessThan(budget);
    return result;
  }

  const page = (q: TradeQuery, offset = 0) => () => store.trades(id, q, CTX, PAGE, offset);

  it('pages the default list', async () => { await probe('trades default', page(NO_FILTER)); });
  it('pages what Round trips caught', async () => { await probe("trades caught ['A']", page({ ...NO_FILTER, caught: ['A'] })); });
  it('pages a wallet group', async () => {
    // Wallet 1234 is in ring 4: 250 loops of the same 300 wallets, and some 15,000 trades among them.
    const rows = await probe('trades wallet group', page({ ...NO_FILTER, kind: 'all', group: { method: 'A', wallet: wallet(1234) } }));
    expect(rows).toHaveLength(PAGE);
    expect((await store.tradeCount(id, { ...NO_FILTER, kind: 'all', group: { method: 'A', wallet: wallet(1234) } }, CTX)).total).toBeGreaterThan(10_000);
  });
  it('pages a token group', async () => {
    // Token 1235's loop is one of ring 7's: its group is that ring's 300 wallets.
    const rows = await probe('trades token group', page({ ...NO_FILTER, kind: 'all', group: { method: 'A', token: '1235' } }));
    expect(rows).toHaveLength(PAGE);
  });
  it('pages by price', async () => { await probe('trades price sort', page({ ...NO_FILTER, sort: 'price', dir: 'desc' })); });
  it('pages what Round trips caught by price', async () => {
    await probe("trades caught ['A'] price sort", page({ ...NO_FILTER, caught: ['A'], sort: 'price', dir: 'desc' }));
  });
  it('pages what Round trips did not catch', async () => { await probe("trades notCaught ['A']", page({ ...NO_FILTER, notCaught: ['A'] })); });
  it('reaches page 500', async () => { await probe('trades page 500', page(NO_FILTER, 499 * PAGE)); });
  it('counts the default list', async () => { await probe('tradeCount default', () => store.tradeCount(id, NO_FILTER, CTX)); });
  it('groups by month', async () => { await probe('tradeGroups month', () => store.tradeGroups(id, NO_FILTER, 'month', CTX)); });
  it('lists the tokens Round trips caught', async () => {
    // The flagged page's 50, ranked over the washed tokens: 4,000, less the 400 whose every trade is uncounted. The loops are read for the 50 alone.
    const { rows, total } = await probe('lensTokens default', () => store.lensTokens(id, 'A', { sort: 'caught', find: null, limit: PAGE, offset: 0 }, CTX));
    expect(rows).toHaveLength(PAGE);
    expect(total).toBe(TOKENS / 5 - TOKENS / 50);
    expect(rows[0]!.loops).toBe(1);
  });
  it('lists the wallets Round trips caught', async () => {
    // Each of these is in some 50 loops of the same 300 wallets: the widest a wallet's partners get.
    // The closest to its budget. About a third is ranking (every flag joined to its transfer and facts), a third
    // the page's counted trades (each wallet here has some 1,000), and the rest its partners. The counted trades
    // read trade_facts_counted_idx alone (some 50,000 index-only lookups, no heap fetch): with the heap fetches
    // they took 1.1 s of 2.3 s executed on a loaded machine, without them 0.5 s of 1.2 s.
    const { rows, total } = await probe('lensWallets default', () => store.lensWallets(id, 'A', { sort: 'caught', find: null, limit: PAGE, offset: 0 }, CTX));
    expect(rows).toHaveLength(PAGE);
    expect(total).toBeGreaterThan(PAGE);
    expect(rows[0]!.partners).toBe(RING - 1);
  });
  // The orders that read every counted trade before the page is cut: one pass over the collection, so a looser budget.
  it('lists the wallets Round trips caught by share', async () => {
    const { rows } = await probe('lensWallets share', () => store.lensWallets(id, 'A', { sort: 'share', find: null, limit: PAGE, offset: 0 }, CTX), 1_500);
    expect(rows).toHaveLength(PAGE);
  });
  it('lists the tokens Round trips caught, newest first', async () => {
    const { rows } = await probe('lensTokens newest', () => store.lensTokens(id, 'A', { sort: 'newest', find: null, limit: PAGE, offset: 0 }, CTX), 1_500);
    expect(rows).toHaveLength(PAGE);
  });

  /**
   * The wallet page's reads, for a wallet that trades two collections on one
   * chain: 100,000 transfers in a second collection of 200,000 are its, beside
   * its few hundred in the first, and it made 100,000 of a million payments,
   * half of them with one partner. A wallet's trades are found by address
   * across collections, so no read may scan the transfers.
   */
  describe('a busy wallet', () => {
    const BUSY = wallet(1234), PARTNER = wallet(77);
    const SECOND = 200_000, FLOWS = 1_000_000;
    let second: number;

    beforeAll(async () => {
      second = (await store.addCollection(1, w('5ca1f'), 'Second', 1)).id;
      const q = (sql: string, params: unknown[] = []) => store.pool.query(sql, params);
      await q(
        `INSERT INTO washtrace.transfers (collection_id, tx_hash, log_index, block_number, block_time, token_id, from_address, to_address, marketplace, price_wei, currency)
         SELECT $1, '0x' || lpad(to_hex(i + 100000000), 64, '0'), 0, i * 5 + 3, timestamptz '2021-01-01' + i * interval '5 minutes', i % 5000,
                CASE WHEN i % 4 = 0 THEN $3 ELSE '0x' || lpad(to_hex((i * 7919) % $4), 40, '0') END,
                CASE WHEN i % 4 = 1 THEN $3 ELSE '0x' || lpad(to_hex((i * 104729 + 1) % $4), 40, '0') END,
                'blur', 10000000000000000::numeric, ''
         FROM generate_series(1, $2::bigint) i`,
        [second, SECOND, BUSY, WALLETS],
      );
      // Its trades in the second collection flagged by Round trips, one in ten, as the first's are; only Round trips ran in either.
      await q(
        `INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness, witness_id)
         SELECT collection_id, m, tx_hash, log_index, '{"kind":"scc"}', 0
         FROM washtrace.transfers, unnest(ARRAY['A', 'AU', 'AC']) m WHERE collection_id = $1 AND block_number % 50 = 3`,
        [second],
      );
      for (const c of [id, second]) {
        await q(
          `INSERT INTO washtrace.analyses (collection_id, took_ms, through_block, totals, missing_data, funded_wallets, wallets, truncated_searches)
           VALUES ($1, 1, NULL, '{"A":{"available":true},"AU":{"available":false},"AC":{"available":false}}', 0, 0, 0, 0)`, [c]);
      }
      // A million payments among the wallets; a tenth of them the busy wallet's, half of those to or from one partner.
      await q(
        `INSERT INTO washtrace.flows (chain_id, tx_hash, kind, from_address, to_address, value_wei, token, block_number, block_time)
         SELECT $1::int, '0x' || lpad(to_hex(i), 64, '0'), 'native',
                CASE WHEN i % 20 = 0 THEN $2 WHEN i % 20 = 1 THEN (CASE WHEN i % 40 = 1 THEN $3 ELSE '0x' || lpad(to_hex((i * 31) % $5), 40, '0') END)
                     ELSE '0x' || lpad(to_hex((i * 7919) % $5), 40, '0') END,
                CASE WHEN i % 20 = 1 THEN $2 WHEN i % 20 = 0 THEN (CASE WHEN i % 40 = 0 THEN $3 ELSE '0x' || lpad(to_hex((i * 37) % $5), 40, '0') END)
                     ELSE '0x' || lpad(to_hex((i * 104729 + 1) % $5), 40, '0') END,
                1000, '', i, timestamptz '2021-01-01' + i * interval '1 minute'
         FROM generate_series(1, $4::bigint) i`,
        [1, BUSY, PARTNER, FLOWS, WALLETS],
      );
      await q('VACUUM ANALYZE washtrace.transfers');
      await q('VACUUM ANALYZE washtrace.flags');
      await q('VACUUM ANALYZE washtrace.flows');
      await q('VACUUM ANALYZE washtrace.analyses');
    }, 900_000);

    // EXPLAIN names the table bare, or schema-qualified under VERBOSE: either is caught.
    const SEQ_SCAN = /Seq Scan on (washtrace\.)?(transfers|flows)\b/;
    const scans = () => expect(lastPlan).not.toMatch(SEQ_SCAN);

    it('the seq-scan check catches a read no index serves', async () => {
      for (const table of ['transfers', 'flows']) {
        for (const verbose of ['', '(VERBOSE) ']) {
          const { rows } = await store.pool.query(`EXPLAIN ${verbose}SELECT * FROM washtrace.${table} WHERE tx_hash || 'x' = 'y'`);
          expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(SEQ_SCAN);
        }
      }
    });

    it('pages its trades', async () => {
      expect(await probe('walletTransfers', () => store.walletTransfers(1, BUSY, 100, 0))).toHaveLength(100);
      scans();
      expect(await probe('walletTransfers page 500', () => store.walletTransfers(1, BUSY, 100, 49_900))).toHaveLength(100);
      scans();
    });
    it('pages and counts its flagged trades', async () => {
      expect(await probe('walletTransfers flagged', () => store.walletTransfers(1, BUSY, 100, 0, { flaggedOnly: true }))).toHaveLength(100);
      scans();
      expect(await probe('walletTradeCount flagged', () => store.walletTradeCount(1, BUSY, { flaggedOnly: true }))).toBeGreaterThan(5_000);
      scans();
    });
    it('counts its trades in one collection, or with one wallet on the other side', async () => {
      expect(await probe('walletTradeCount', () => store.walletTradeCount(1, BUSY))).toBeGreaterThan(SECOND / 2);
      scans();
      expect(await probe('walletTradeCount collection', () => store.walletTradeCount(1, BUSY, { collection: w('5ca1e') }))).toBeGreaterThan(0);
      scans();
      await probe('walletTradeCount find prefix', () => store.walletTradeCount(1, BUSY, { find: '0x00000000000000000000000000000000000004' }));
      scans();
      await probe('walletTransfers with', () => store.walletTransfers(1, BUSY, 100, 0, { with: PARTNER }));
      scans();
    });
    it('lists its collections', async () => {
      expect(await probe('walletCollections', () => store.walletCollections(1, BUSY))).toHaveLength(2);
      scans();
    });
    it('pages, sorts and counts its money partners', async () => {
      expect(await probe('counterparties flows', () => store.counterparties(1, BUSY, 50, 0, 'flows'))).toHaveLength(50);
      scans();
      expect((await probe('counterparties watched', () => store.counterparties(1, BUSY, 50, 50, 'watched')))).toHaveLength(50);
      scans();
      expect(await probe('counterpartyCount', () => store.counterpartyCount(1, BUSY))).toBeGreaterThan(100);
      scans();
    });
    it('pages and counts the payments between it and its partner', async () => {
      expect(await probe('flowsBetween both', () => store.flowsBetween(1, BUSY, PARTNER, 'both', 50, 0))).toHaveLength(50);
      scans();
      expect(await probe('flowsBetween sent, page 100', () => store.flowsBetween(1, BUSY, PARTNER, 'sent', 50, 4_950))).toHaveLength(50);
      scans();
      expect(await probe('flowsBetweenCount', () => store.flowsBetweenCount(1, BUSY, PARTNER, 'both'))).toBeGreaterThanOrEqual(FLOWS / 20);
      scans();
    });
  });
});
