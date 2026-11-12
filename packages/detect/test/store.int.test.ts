import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgClient from 'pg';
import { ANALYZE_GAP_MS, COUNT_TIMEOUT_MS, HISTORY_KEEP, Store, TooManyStreams, WALK_CAP, type Parsed, type TokenCounts } from '../src/store.js';
import { SECRET_KEYS } from '../src/env.js';
import { TOKEN_COUNT_MS } from '../src/worker.js';
import type { ListOpts, TokenSort, WalletSort } from '../src/trade-sql.js';
import { followOf } from '../src/reach.js';
import { FACTS_VERSION } from '../src/facts.js';
import { FLOOR_DAYS } from '../src/trades.js';
import { analyze } from '../src/methods.js';
import { analyzeStored } from '../src/analysis-thread.js';
import { LENS_WAIT_MS, Worker, interleave } from '../src/worker.js';
import { Chain } from '../src/chain.js';
import { Etherscan } from '../src/etherscan.js';
import { workerConfig } from '../src/env.js';
import { HttpRequestError } from 'viem';
import { LAB, LAB_MIXED, MONEY, USDC, WETH, at, chain, flow, input, transfer, w, type Fact } from './fixtures.js';
import { ZERO } from '../src/graph.js';
import { MOVE_KIND } from '../src/moves.js';
import { FLOWS_AMONG_SQL, PAYMENT_SQL } from '../src/store-rows.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoredDataError, readTrail, trailPaths, trailSha, writeTrail, type StoredEntry, type TrailFiles } from '../src/stored.js';
import { needsRestore } from '../src/stored-sync.js';
import type { Flow, Method, TokenFlow, Transfer } from '../src/types.js';
import { NO_FILTER, type TradeQuery } from '../src/trades.js';
import { COPIES, DEFAULT_RULE, FOLLOW_FANOUT } from '../src/lens-rule.js';
import { lensStored, previewStored } from '../src/lens-thread.js';
import { MIGRATIONS } from '../src/migrations.js';
import type { Payments } from '../src/payments.js';
import type { SpotResult } from '../src/spot.js';

let pg: StartedPostgreSqlContainer;
let store: Store;
const collection = w('c011');
// This test's own advisory-lock key, not one of the store's LOCKS.
const LOCKS_TEST_KEY = 987_654;
const a = w('a'), b = w('b'), x = w('x');
/** A list row's pairs by shape, when it has none. */
const NO_SHAPES = { funder: 0, payee: 0, back: 0, forward: 0, 'direct-back': 0, 'direct-forward': 0, both: 0 };

/** What the last pass recorded on `job`'s row: a worker's analyze pass records a lens run or a preview on the lens row. */
const said = async (job: 'analyze' | 'lens') => (await store.passes()).find((p) => p.job === job)?.detail;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:17-alpine').start();
  store = Store.connect(pg.getConnectionUri());
});

afterAll(async () => {
  await store?.pool.end();
  await pg?.stop();
});

describe('Store.connect', () => {
  it('keeps its connections alive, so a dropped one errors instead of waiting forever', () => {
    expect(store.pool.options).toMatchObject({ keepAlive: true });
  });

  it('rejects the query on a checked-out connection that is dropped, instead of ending the process', async () => {
    const killer = new pgClient.Client({ connectionString: pg.getConnectionUri() });
    await killer.connect();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const held = store.locked(LOCKS_TEST_KEY, false, async (c) => {
        const { rows } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const sleeping = c.query('SELECT pg_sleep(30)');
        sleeping.catch(() => {}); // may reject before the kill call returns; the awaiting caller still sees it
        await killer.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
        return sleeping;
      });
      await expect(held).rejects.toThrow();
      expect(logged).toHaveBeenCalledWith('[washtrace] store connection lost: %s', expect.any(String));
      // The pool is still usable: the dead client was discarded on release.
      expect((await store.pool.query('SELECT 1 AS one')).rows[0]).toEqual({ one: 1 });
    } finally {
      logged.mockRestore();
      await killer.end();
    }
  });
});

/** Tests clean up with this: removeCollection only deletes what is paused. */
async function drop(chainId: number, address: string): Promise<void> {
  await store.pause(chainId, address);
  await store.removeCollection(chainId, address);
}

describe('Store.schemaVersion', () => {
  it('reads 0 for a database with no schema, without creating one', async () => {
    await store.pool.query('CREATE DATABASE bare');
    const url = new URL(pg.getConnectionUri());
    url.pathname = '/bare';
    const bare = Store.connect(url.toString());
    try {
      expect(await bare.schemaVersion()).toBe(0);
      const { rows } = await bare.pool.query("SELECT to_regclass('washtrace.schema_version') AS t");
      expect(rows[0].t).toBeNull();
    } finally {
      await bare.pool.end();
    }
  });
});

describe('the counted trades index, built concurrently', () => {
  const index = async () => (await store.pool.query(
    `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'washtrace' AND c.relname = 'trade_facts_counted_idx'`,
  )).rows;

  it('holds the counted rows’ keys, so a lens list’s counted join reads the index alone, and is built again when missing', async () => {
    const step = MIGRATIONS[36]!;
    expect(typeof step).toBe('object');
    await store.migrate();
    const built = [{ valid: true, def: 'CREATE INDEX trade_facts_counted_idx ON washtrace.trade_facts USING btree (collection_id, tx_hash, log_index) WHERE counted' }];
    expect(await index()).toEqual(built);
    await store.pool.query('DROP INDEX washtrace.trade_facts_counted_idx');
    await store.pool.query('UPDATE washtrace.schema_version SET version = $1', [36]);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    expect(await index()).toEqual(built);
  });
});

describe('migration #38: a linked pair\'s shape', () => {
  const column = async () => (await store.pool.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = 'washtrace' AND table_name = 'witnesses' AND column_name = 'shape'`,
  )).rows;

  it('adds a nullable column with no default in one transaction, and a second run changes nothing', async () => {
    expect(typeof MIGRATIONS[37]).toBe('string');
    await store.migrate();
    const added = [{ data_type: 'text', is_nullable: 'YES', column_default: null }];
    expect(await column()).toEqual(added);
    await store.pool.query('UPDATE washtrace.schema_version SET version = $1', [37]);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    expect(await column()).toEqual(added);
  });
});

describe('migration #28: the money-edge index, built concurrently', () => {
  const isValid = async () => (await store.pool.query(
    `SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def, i.indexrelid::int AS oid FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'washtrace' AND c.relname = 'flows_moves_idx'`,
  )).rows;
  const at = async (version: number) => {
    await store.pool.query('DELETE FROM washtrace.schema_version');
    await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES ($1)', [version]);
  };
  const DEF = 'CREATE INDEX flows_moves_idx ON washtrace.flows USING btree (chain_id, from_address, to_address, block_number)';

  it('is a step the runner runs outside a transaction, and #27 holds the lens tables only', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(32);
    expect(typeof MIGRATIONS[26]).toBe('string');
    expect(MIGRATIONS[26]).not.toContain('flows_moves_idx');
    const step = MIGRATIONS[27]!;
    expect(typeof step).toBe('object');
    expect((step as { outside: readonly string[] }).outside.at(-1)).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS flows_moves_idx ON washtrace\.flows/);
    // #29, after it, is a plain one: the previews' table, and the index your lenses' flags of one tx are read by.
    expect(typeof MIGRATIONS[28]).toBe('string');
    expect(MIGRATIONS[28]).toContain('washtrace.lens_previews');
    expect(MIGRATIONS[28]).toContain('lens_flags_tx_idx ON washtrace.lens_flags (tx_hash)');
  });

  it('builds the index outside a transaction (CONCURRENTLY refuses one), and a second run changes nothing', async () => {
    await store.migrate();
    await store.pool.query('DROP INDEX washtrace.flows_moves_idx');
    await at(27);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    const built = await isValid();
    expect(built).toEqual([{ valid: true, def: DEF, oid: expect.any(Number) }]);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    await at(27);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    expect(await isValid()).toEqual(built);
    expect((await store.pool.query('SELECT version FROM washtrace.schema_version')).rows).toEqual([{ version: MIGRATIONS.length }]);
  });

  it('drops an INVALID index a stopped build left under its name, and builds it again', async () => {
    await store.migrate();
    await store.pool.query('DROP INDEX washtrace.flows_moves_idx');
    await store.saveMoney(1, w('1d01'), [flow(w('1d01'), w('1d02')), flow(w('1d01'), w('1d03'))], false);
    try {
      // A concurrent build that fails leaves its index behind, INVALID: here, a unique one over a column with repeats.
      await expect(store.pool.query('CREATE UNIQUE INDEX CONCURRENTLY flows_moves_idx ON washtrace.flows (chain_id)')).rejects.toThrow();
      expect(await isValid()).toEqual([expect.objectContaining({ valid: false })]);
      await at(27);
      expect(await store.migrate()).toBe(MIGRATIONS.length);
      expect(await isValid()).toEqual([{ valid: true, def: DEF, oid: expect.any(Number) }]);
    } finally {
      await store.pool.query('DELETE FROM washtrace.flows WHERE from_address = $1', [w('1d01')]);
    }
  });

  it('builds it with two migrators starting together: the one waiting holds no snapshot the build would wait out', async () => {
    await store.migrate();
    await store.pool.query('DROP INDEX washtrace.flows_moves_idx');
    await at(27);
    const named = (name: string) => new Store(new pgClient.Pool({ connectionString: pg.getConnectionUri(), application_name: name, max: 2 }));
    const [one, two] = [named('migrate-one'), named('migrate-two')];
    // A third replica holds the lock while both start, so both are waiting when it goes.
    const holder = new pgClient.Client({ connectionString: pg.getConnectionUri() });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, 0)', [0x77617368]);
      const both = [one.migrate(), two.migrate()];
      for (let i = 0; ; i++) {
        const { rows } = await store.pool.query(
          `SELECT count(DISTINCT application_name)::int AS n FROM pg_stat_activity WHERE application_name LIKE 'migrate-%' AND query LIKE '%advisory_lock(%'`,
        );
        if (rows[0].n === 2) break;
        if (i > 200) throw new Error('the migrators never asked for the lock');
        await new Promise((r) => setTimeout(r, 25));
      }
      await holder.query('SELECT pg_advisory_unlock($1, 0)', [0x77617368]);
      expect(await Promise.all(both)).toEqual([MIGRATIONS.length, MIGRATIONS.length]);
      expect(await isValid()).toEqual([{ valid: true, def: DEF, oid: expect.any(Number) }]);
    } finally {
      await holder.end();
      await one.pool.end();
      await two.pool.end();
    }
  });
});

describe('migration #30: flows_from_idx dropped, flows_moves_idx serves its lookups', () => {
  const indexes = async () => (await store.pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'washtrace' AND tablename = 'flows' AND indexname IN ('flows_from_idx', 'flows_moves_idx') ORDER BY indexname`,
  )).rows.map((r) => r.indexname);
  const at = async (version: number) => {
    await store.pool.query('DELETE FROM washtrace.schema_version');
    await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES ($1)', [version]);
  };

  it('is a step the runner runs outside a transaction (DROP INDEX CONCURRENTLY refuses one)', () => {
    const step = MIGRATIONS[29]!;
    expect(typeof step).toBe('object');
    expect((step as { outside: readonly string[] }).outside).toEqual(['DROP INDEX CONCURRENTLY IF EXISTS washtrace.flows_from_idx']);
  });

  it('drops flows_from_idx and keeps flows_moves_idx', async () => {
    await store.migrate();
    await store.pool.query('CREATE INDEX IF NOT EXISTS flows_from_idx ON washtrace.flows (chain_id, from_address)');
    await at(29);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    expect(await indexes()).toEqual(['flows_moves_idx']);
  });

  it('on a store without flows_from_idx is a no-op, and the version is the latest', async () => {
    await store.migrate();
    expect(await indexes()).toEqual(['flows_moves_idx']);
    await at(29);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    expect(await indexes()).toEqual(['flows_moves_idx']);
    expect((await store.pool.query('SELECT version FROM washtrace.schema_version')).rows).toEqual([{ version: MIGRATIONS.length }]);
  });

  it('a query by (chain_id, from_address) on flows still uses an index: flows_moves_idx', async () => {
    await store.migrate();
    const c = await store.pool.connect();
    try {
      await c.query('BEGIN');
      // Enough rows that the planner costs an index scan, not a seq scan over a handful; rolled back.
      await c.query(
        `INSERT INTO washtrace.flows (chain_id, tx_hash, kind, from_address, to_address, value_wei, token, block_number, block_time)
         SELECT 1, '0xfill' || g, 'eth', '0x' || lpad(to_hex(g % 2000), 40, '0'), '0x' || lpad(to_hex(g), 40, '0'), 1, '', g, now() FROM generate_series(1, 20000) g`,
      );
      await c.query('ANALYZE washtrace.flows');
      const plan = (await c.query(
        'EXPLAIN SELECT * FROM washtrace.flows WHERE chain_id = $1 AND from_address = $2',
        [1, '0x' + (7).toString(16).padStart(40, '0')],
      )).rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/flows_moves_idx/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('migration #31: a collection\'s own hop limit, and its reach', () => {
  const at = async (version: number) => {
    await store.pool.query('DELETE FROM washtrace.schema_version');
    await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES ($1)', [version]);
  };
  const ownLimit = async (id: number) => (await store.pool.query('SELECT follow_hops FROM washtrace.collections WHERE id = $1', [id])).rows[0]?.follow_hops;
  /** Wallet rows as a test wants them: each at its chain depth, in its state. */
  const wallets = async (chainId: number, rows: [address: string, depth: number, status: 'pending' | 'done' | 'failed'][]) => {
    for (const [address, depth, status] of rows) {
      await store.pool.query('INSERT INTO washtrace.wallets (chain_id, address, depth, status) VALUES ($1, $2, $3, $4)', [chainId, address, depth, status]);
    }
  };
  const reach = async (id: number, chainId: number, rows: [address: string, depth: number][]) => {
    for (const [address, depth] of rows) {
      await store.pool.query('INSERT INTO washtrace.reach (collection_id, chain_id, address, depth) VALUES ($1, $2, $3, $4)', [id, chainId, address, depth]);
    }
  };

  beforeAll(async () => {
    await store.migrate();
  });

  it('is one plain step: the nullable column, the table and its index; running it again changes nothing', async () => {
    expect(typeof MIGRATIONS[30]).toBe('string');
    expect(MIGRATIONS[30]).toContain('ADD COLUMN IF NOT EXISTS follow_hops smallint CHECK (follow_hops BETWEEN 1 AND 10)');
    expect(MIGRATIONS[30]).toContain('CREATE TABLE IF NOT EXISTS washtrace.reach');
    await at(30);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    await at(30);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    const { rows } = await store.pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'washtrace' AND tablename = 'reach' ORDER BY indexname`);
    expect(rows.map((r) => r.indexdef)).toEqual([
      'CREATE UNIQUE INDEX reach_pkey ON washtrace.reach USING btree (collection_id, address)',
      'CREATE INDEX reach_unstepped_idx ON washtrace.reach USING btree (collection_id, depth) WHERE (NOT stepped)',
      'CREATE INDEX reach_wallet_idx ON washtrace.reach USING btree (chain_id, address)',
    ]);
  });

  it('followFurther raises, never lowers, and answers already on a second press', async () => {
    const { id } = await store.addCollection(3101, w('31c1'), null, 1);
    try {
      expect(await ownLimit(id)).toBeNull();
      expect(await store.followFurther(id, 5)).toBe('set');
      expect(await ownLimit(id)).toBe(5);
      expect(await store.followFurther(id, 5)).toBe('already');
      expect(await store.followFurther(id, 4)).toBe('already');
      expect(await ownLimit(id)).toBe(5);
      expect(await store.followFurther(id, 6)).toBe('set');
      expect(await ownLimit(id)).toBe(6);
      // Two presses together: one sets it, the other finds it set.
      expect((await Promise.all([store.followFurther(id, 8), store.followFurther(id, 8)])).sort()).toEqual(['already', 'set']);
      // Washtrace follows 10 hops at most.
      await expect(store.followFurther(id, 11)).rejects.toThrow(/follow_hops/);
      expect(await ownLimit(id)).toBe(8);
      await drop(3101, w('31c1'));
      expect(await store.followFurther(id, 9)).toBe('gone');
    } finally {
      await drop(3101, w('31c1'));
    }
  });

  it('deleting a collection cascades its reach rows', async () => {
    const { id } = await store.addCollection(3102, w('32c1'), null, 1);
    const other = (await store.addCollection(3102, w('32c2'), null, 1)).id;
    try {
      await reach(id, 3102, [[w('32r1'), 4], [w('32r2'), 5]]);
      await reach(other, 3102, [[w('32r1'), 4]]);
      await drop(3102, w('32c1'));
      const { rows } = await store.pool.query('SELECT collection_id, address FROM washtrace.reach WHERE chain_id = 3102');
      expect(rows).toEqual([{ collection_id: other, address: w('32r1') }]);
    } finally {
      await drop(3102, w('32c1'));
      await drop(3102, w('32c2'));
    }
  });

  it('moneyRead gives the traders checked, the effective limit and pending reach by depth; a global limit above the own one wins', async () => {
    const C = 3103;
    const [t1, t2, t3, t4] = [w('33a1'), w('33a2'), w('33a3'), w('33a4')];
    const { id } = await store.addCollection(C, w('33c1'), null, 10);
    const other = (await store.addCollection(C, w('33c2'), null, 10)).id;
    try {
      await store.ingest(id, C, chain('1', t1, t2, t3, t4).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, [t1, t2, t3, t4]);
      await store.saveMoney(C, t1, [], false);
      // Truncated: never read again, so it is as checked as it will be, as coverage counts it.
      await store.saveMoney(C, t2, [], true);
      await store.moneyFailed(C, t3, 'rate limited');
      expect(await store.moneyRead(id, 3)).toEqual({ traders: { checked: 2, of: 4 }, limit: 3, ownLimit: null, pendingByDepth: {}, estimate: null, seeding: false });

      const [r1, r2, r3, r4] = [w('33r1'), w('33r2'), w('33r3'), w('33r4')];
      await wallets(C, [[r1, 3, 'pending'], [r2, 2, 'done'], [r3, 3, 'failed'], [r4, 3, 'pending']]);
      await reach(id, C, [[r1, 4], [r2, 4], [r3, 5], [r4, 5]]);
      // Another collection's reach is its own.
      await reach(other, C, [[r1, 4]]);
      expect(await store.followFurther(id, 5)).toBe('set');
      expect(await store.moneyRead(id, 3)).toEqual({ traders: { checked: 2, of: 4 }, limit: 5, ownLimit: 5, pendingByDepth: { 4: 1, 5: 2 }, estimate: null, seeding: true });
      // The global limit raised past the collection's own: the larger wins.
      expect(await store.moneyRead(id, 6)).toMatchObject({ limit: 6, ownLimit: 5 });
      expect(await store.moneyRead(other, 3)).toEqual({ traders: { checked: 0, of: 0 }, limit: 3, ownLimit: null, pendingByDepth: { 4: 1 }, estimate: null, seeding: false });
    } finally {
      await drop(C, w('33c1'));
      await drop(C, w('33c2'));
    }
  });

  it('flowsAmong leaves out a payment inside any sale of the collection, as the analysis does, whichever token it was of', async () => {
    const C = 3120;
    const [p, q] = [w('3fa1'), w('3fa2')];
    const { id } = await store.addCollection(C, w('3fc1'), null, 10);
    try {
      // Token 2 sold by p to q in tx 0xsale, with its price paid q to p in that same transaction (a WETH bid).
      await store.ingest(id, C, [transfer('2', p, q, { txHash: '0xsale', blockNumber: 20 })], 50, [p, q]);
      await store.saveMoney(C, q, [flow(q, p, { txHash: '0xsale', blockNumber: 20 }), flow(q, p, { txHash: '0xreal', blockNumber: 21 })], false);
      expect((await store.flowsAmong(C, id, [[q, p]])).map((f) => f.txHash)).toEqual(['0xreal']);
      // Another collection's sale does not hide it.
      const other = (await store.addCollection(C, w('3fc2'), null, 10)).id;
      expect((await store.flowsAmong(C, other, [[q, p]])).map((f) => f.txHash)).toEqual(['0xsale', '0xreal']);
    } finally {
      await drop(C, w('3fc1'));
      await drop(C, w('3fc2'));
    }
  });

  it('flowsAmong reads only the legs it is asked for, each once, so other payments among the same wallets never take the cap', async () => {
    const C = 3121;
    const [p, q, r] = [w('3fd1'), w('3fd2'), w('3fd3')];
    const { id } = await store.addCollection(C, w('3fd9'), null, 10);
    try {
      // Busy wallets: q pays p five times before the one payment p→r that a lens used.
      // Built here, not by the shared flow(), whose counter later tests' hashes depend on.
      const pay = (from: string, to: string, txHash: string, blockNumber: number): Flow => ({ txHash, kind: 'native', from, to, valueWei: '1000', token: '', blockNumber, blockTime: blockNumber });
      const busy = Array.from({ length: 5 }, (_, i) => pay(q, p, `0xbusy${i}`, 10 + i));
      await store.saveMoney(C, q, busy, false);
      await store.saveMoney(C, p, [pay(p, r, '0xleg', 30)], false);
      // The cap of 2 would be spent on q→p reading every pair of {p, q, r}; by its leg, p→r comes back.
      expect((await store.flowsAmong(C, id, [[p, r]], 2)).map((f) => f.txHash)).toEqual(['0xleg']);
      // A leg asked twice, or the way back, reads it once; a wallet to itself reads nothing.
      expect((await store.flowsAmong(C, id, [[p, r], [p, r], [r, p], [p, p]])).map((f) => f.txHash)).toEqual(['0xleg']);
      expect(await store.flowsAmong(C, id, [])).toEqual([]);
    } finally {
      await drop(C, w('3fd9'));
    }
  });

  it('flowsAmong reads each leg by flows_moves_idx, not a scan of the table', async () => {
    const pg = await store.pool.connect();
    try {
      await pg.query('BEGIN');
      // A busy chain: enough payments, among enough wallets, that the planner costs a probe per leg against reading the chain; rolled back.
      await pg.query(
        `INSERT INTO washtrace.flows (chain_id, tx_hash, kind, from_address, to_address, value_wei, token, block_number, block_time)
         SELECT 1, '0xamong' || g, 'native', '0x' || lpad(to_hex(g % 2000), 40, '0'), '0x' || lpad(to_hex(g), 40, '0'), 1, '', g, now() FROM generate_series(1, 20000) g`,
      );
      await pg.query('ANALYZE washtrace.flows');
      const hex = (n: number) => '0x' + n.toString(16).padStart(40, '0');
      const plan = (await pg.query(`EXPLAIN ${FLOWS_AMONG_SQL}`, [1, [hex(7), hex(9)], [hex(2007), hex(4009)], 500, 1])).rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan, plan).toMatch(/flows_moves_idx/);
      // Each leg probes the index by its payer and payee, not only by the chain.
      expect(plan, plan).toMatch(/Index Cond: [^\n]*from_address = l\.payer[^\n]*to_address = l\.payee/);
      expect(plan, plan).not.toMatch(/Seq Scan on flows/);
    } finally {
      await pg.query('ROLLBACK');
      pg.release();
    }
  });

  it('moneyRead reads a collection whose traders are all done, one truncated, as checked to the end', async () => {
    const C = 3119;
    const [t1, t2] = [w('39a1'), w('39a2')];
    const { id } = await store.addCollection(C, w('39c1'), null, 10);
    try {
      await store.ingest(id, C, chain('1', t1, t2).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, [t1, t2]);
      await store.saveMoney(C, t1, [], false);
      // A busy trader: its history is past what the funding source pages through, and it is never read again.
      await store.saveMoney(C, t2, [], true);
      expect((await store.moneyRead(id, 3)).traders).toEqual({ checked: 2, of: 2 });
    } finally {
      await drop(C, w('39c1'));
    }
  });

  it('checking a wallet in a collection\'s reach past the global limit moves that collection\'s version, and no one else\'s', async () => {
    const C = 3120;
    const [t1, t2, r4, r2, q] = [w('3ja1'), w('3ja2'), w('3jr4'), w('3jr2'), w('3jq1')];
    const one = (await store.addCollection(C, w('3jc1'), null, 10)).id;
    const two = (await store.addCollection(C, w('3jc2'), null, 10)).id;
    const version = async (id: number) => Number((await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id])).rows[0].version);
    try {
      await store.ingest(one, C, chain('1', t1, t2).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, [t1, t2]);
      await store.followFurther(one, 5);
      // r4 is 4 out from one's traders, past the global 3; r2 is 2 out, within it. Neither paid or was paid by a trader.
      await wallets(C, [[r4, 4, 'pending'], [r2, 2, 'pending']]);
      await reach(one, C, [[r4, 4], [r2, 2]]);
      const [before, other] = [await version(one), await version(two)];
      await store.saveMoney(C, r4, [{ txHash: '0x3j1', kind: 'native', from: r4, to: q, valueWei: '1000', token: '', blockNumber: 1, blockTime: 1 }], false, followOf(C, 3));
      expect(await version(one)).toBe(before + 1);
      expect(await version(two)).toBe(other);
      // Within the global limit its wallets are the followed lane's, read as they always were.
      await store.saveMoney(C, r2, [], false, followOf(C, 3));
      expect(await version(one)).toBe(before + 1);
    } finally {
      await drop(C, w('3jc1'));
      await drop(C, w('3jc2'));
    }
  });

  it('a run reads followed wallets within the global limit and its own reach, never another collection\'s reach past it', async () => {
    const C = 3121;
    const [x1, x2, y1, y2] = [w('3kx1'), w('3kx2'), w('3ky1'), w('3ky2')];
    const [near, far, busy, q1, q2, q3] = [w('3kn1'), w('3kf1'), w('3kf2'), w('3kq1'), w('3kq2'), w('3kq3')];
    const X = (await store.addCollection(C, w('3kc1'), null, 10)).id;
    const Y = (await store.addCollection(C, w('3kc2'), null, 10)).id;
    const pays = (p: Payments) => Array.from({ length: p.size }, (_, i) => `${p.names[p.ends[2 * i]!]}>${p.names[p.ends[2 * i + 1]!]}`);
    const moved = (m: Awaited<ReturnType<Store['lensInput']>>['moves']) => Array.from({ length: m.size }, (_, i) => `${m.name(m.from[i]!)}>${m.name(m.to[i]!)}`);
    try {
      await store.ingest(X, C, chain('1', x1, x2).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, [x1, x2]);
      await store.ingest(Y, C, chain('1', y1, y2).map((t, i) => ({ ...t, blockNumber: 30 + i })), 60, [y1, y2]);
      // near is 2 out on the chain, within the global 3: everyone's. far and busy are 4 out, in X's reach alone.
      await wallets(C, [[near, 2, 'pending'], [far, 4, 'pending'], [busy, 4, 'pending']]);
      await store.followFurther(X, 5);
      await reach(X, C, [[far, 4], [busy, 4]]);
      // A whole ETH each, over any floor the default rule sets.
      const one = { valueWei: String(10n ** 18n) };
      await store.saveMoney(C, near, [flow(near, q1, one)], false);
      await store.saveMoney(C, far, [flow(far, q2, one)], false);
      await store.saveMoney(C, busy, [flow(busy, q3, one)], true);

      const xs = await store.analysisInput(X, C, 3);
      expect(pays(xs.payments)).toEqual(expect.arrayContaining([`${near}>${q1}`, `${far}>${q2}`]));
      expect(xs.funded.has(far)).toBe(true);
      expect(xs.truncated.has(busy)).toBe(true);
      const ys = await store.analysisInput(Y, C, 3);
      expect(pays(ys.payments)).toContain(`${near}>${q1}`);
      expect(pays(ys.payments)).not.toContain(`${far}>${q2}`);
      expect(ys.funded.has(far)).toBe(false);
      expect(ys.truncated.has(busy)).toBe(false);

      expect(moved((await store.lensInput(X, C, DEFAULT_RULE, null, 3)).moves)).toEqual(expect.arrayContaining([`${near}>${q1}`, `${far}>${q2}`]));
      const yl = await store.lensInput(Y, C, DEFAULT_RULE, null, 3);
      expect(moved(yl.moves)).toContain(`${near}>${q1}`);
      expect(moved(yl.moves)).not.toContain(`${far}>${q2}`);
      expect(yl.truncated.has(busy)).toBe(false);

      // A collection that follows no further than the global limit asks nothing of reach: its SQL is what it was, less the deeper wallets.
      const asked = vi.spyOn(store.pool, 'query');
      try {
        await store.analysisInput(Y, C, 3);
        await store.lensInput(Y, C, DEFAULT_RULE, null, 3);
        expect(asked.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('reach');
      } finally {
        asked.mockRestore();
      }
    } finally {
      await drop(C, w('3kc1'));
      await drop(C, w('3kc2'));
    }
  });

  it('with follow.hops 0 a run still reads an imported trail\'s followed wallets, at depth 1', async () => {
    const C = 3123;
    const [t1, t2, fol, out] = [w('3ma1'), w('3ma2'), w('3mf1'), w('3mo1')];
    const { id } = await store.addCollection(C, w('3mc1'), null, 10);
    try {
      await store.ingest(id, C, chain('1', t1, t2).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, []);
      // As importTrail writes a trail's followed wallet: depth 1, done.
      await wallets(C, [[fol, 1, 'done']]);
      await store.saveMoney(C, fol, [flow(fol, out, { valueWei: String(10n ** 18n) })], false);
      const paid = (await store.analysisInput(id, C, 0)).payments;
      expect(Array.from({ length: paid.size }, (_, i) => `${paid.names[paid.ends[2 * i]!]}>${paid.names[paid.ends[2 * i + 1]!]}`)).toContain(`${fol}>${out}`);
      expect((await store.analysisInput(id, C, 0)).funded.has(fol)).toBe(true);
      const { moves } = await store.lensInput(id, C, DEFAULT_RULE, null, 0);
      expect(Array.from({ length: moves.size }, (_, i) => moves.name(moves.from[i]!))).toContain(fol);
    } finally {
      await drop(C, w('3mc1'));
    }
  });

  it('countNext counts the next depth\'s unread wallets from stored flows, respecting fanout, truncated and the excluded addresses, and stores it with the chain\'s growth', async () => {
    const C = 3104;
    const seaport = '0x00000000000000adc04c56bf30ac9d3c0aaf14dc';
    const [t1, t2, t3] = [w('34a1'), w('34a2'), w('34a3')];
    const [a1, a2, c1, c2, c3, e1] = [w('34b1'), w('34b2'), w('34d1'), w('34d2'), w('34d3'), w('34e1')];
    const estimate = async (globalHops: number) => (await store.moneyRead(id, globalHops)).estimate;
    const { id } = await store.addCollection(C, w('34c1'), null, 10);
    try {
      await store.ingest(id, C, chain('1', t1, t2, t3).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, [t1, t2, t3]);
      // The chain's wallets: 3 at depth 0 (the traders), 6 at depth 1. c1 and c3 are wallets another
      // collection's trader paid, at chain depth 1, but two sent-to steps out from these traders.
      await wallets(C, [[a1, 1, 'pending'], [a2, 1, 'pending'], [c1, 1, 'pending'], [c3, 1, 'pending'], [w('34f1'), 1, 'done'], [w('34f2'), 1, 'done']]);
      await store.saveMoney(C, t1, [flow(t1, a1), flow(t1, a2), flow(w('34i1'), t1)], false);
      await store.saveMoney(C, t2, [flow(t2, w('34g1'))], true); // truncated: not followed
      await store.saveMoney(C, t3, Array.from({ length: FOLLOW_FANOUT + 1 }, (_, i) => flow(t3, w(`34h${i}`))), false); // past the fanout: not followed
      // a1 paid c1 twice, c2, c3, a trader and a wallet as near as itself (neither further out),
      // a marketplace and the zero address (never followed), and itself.
      await store.saveMoney(C, a1, [flow(a1, c1), flow(a1, c1), flow(a1, c2), flow(a1, c3), flow(a1, t1), flow(a1, a2), flow(a1, seaport), flow(a1, ZERO), flow(a1, a1)], false);
      // a2 is not checked yet: what it sent, seen from the other end, is not followed from it.
      await store.saveMoney(C, w('34k1'), [flow(a2, w('34k1'))], false);
      // c1 is checked already (for the other collection): reading it again costs nothing, so it is not counted.
      await store.saveMoney(C, c1, [flow(c1, e1)], false);

      expect(await estimate(1)).toBeNull();
      // follow.hops 1: depth 2 is the next, c1, c2 and c3, of which c2 and c3 are still to read.
      // The chain grew from 3 wallets at depth 0 to 6 at depth 1.
      expect(await store.countNext(id, 1)).toBe('counted');
      const counted = await estimate(1);
      // within: the walk's wallets out to the limit, the 3 traders and the 2 they paid.
      expect(counted).toEqual({ depth: 2, wallets: 2, growth: 2, cut: false, within: 5, at: expect.any(String) });
      // One form for every client to parse: toISOString's, to the millisecond, in UTC.
      expect(new Date(counted!.at).toISOString()).toBe(counted!.at);
      // Stamped by the database's clock, so it is held to that clock: the container's and this process's need not agree.
      const dbNow = (await store.pool.query<{ ms: number }>('SELECT extract(epoch FROM now())::float8 * 1000 AS ms')).rows[0]!.ms;
      expect(Math.abs(Date.parse(counted!.at) - dbNow)).toBeLessThan(60_000);
      // The global limit raised past it: what was counted is for a depth no longer next.
      expect(await estimate(2)).toBeNull();

      // A wallet already in this collection's reach is not counted again.
      await reach(id, C, [[c2, 2]]);
      await store.countNext(id, 1);
      expect(await estimate(1)).toMatchObject({ depth: 2, wallets: 1 });
      // Its own limit past the global one: the count is stale until counted again, from it: c1's e1.
      expect(await store.followFurther(id, 2)).toBe('set');
      expect(await estimate(1)).toBeNull();
      await store.countNext(id, 1);
      expect(await estimate(1)).toMatchObject({ depth: 3, wallets: 1, growth: 2, cut: false });
    } finally {
      await drop(C, w('34c1'));
    }
    expect(await store.countNext(id, 1)).toBe('gone');
  });

  it('countNext walks WALK_CAP wallets at most, and scales a level it cut by its frontier over what it took', async () => {
    const C = 3105;
    const traders = [w('35a1'), w('35a2'), w('35a3'), w('35a4')];
    const { id } = await store.addCollection(C, w('35c1'), null, 10);
    try {
      expect(store.walkCap).toBe(WALK_CAP);
      await store.ingest(id, C, chain('1', ...traders).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, traders);
      for (const [i, t] of traders.entries()) await store.saveMoney(C, t, [flow(t, w(`35b${i}`))], false);
      // A chain that follows nothing yet: the growth is the walk's own last step, 4 traders to 4 payees.
      await store.countNext(id, 0);
      expect((await store.moneyRead(id, 0)).estimate).toMatchObject({ depth: 1, wallets: 4, growth: 1, cut: false });
      // Two of the four traders walked: their two payees stand for four.
      store.walkCap = 2;
      await store.countNext(id, 0);
      expect((await store.moneyRead(id, 0)).estimate).toMatchObject({ depth: 1, wallets: 4, growth: 1, cut: true });
    } finally {
      store.walkCap = WALK_CAP;
      await drop(C, w('35c1'));
    }
  });

  it('countNext carries what a level of the walk left of its share on to the next, and walks everything uncapped', async () => {
    const C = 3106;
    const t = w('36a1');
    const middles = [w('36b1'), w('36b2'), w('36b3'), w('36b4')];
    const { id } = await store.addCollection(C, w('36c1'), null, 10);
    const counted = async (cap: number) => {
      store.walkCap = cap;
      await store.countNext(id, 1);
      return (await store.moneyRead(id, 1)).estimate;
    };
    try {
      // One trader paid four wallets, checked already, each of which paid one wallet still to read: four at depth 2.
      await store.ingest(id, C, chain('1', t).map((x) => ({ ...x, blockNumber: 20 })), 50, [t]);
      await store.saveMoney(C, t, middles.map((m) => flow(t, m)), false);
      await wallets(C, middles.map((m) => [m, 1, 'pending'] as [string, number, 'pending']));
      for (const [i, m] of middles.entries()) await store.saveMoney(C, m, [flow(m, w(`36d${i}`))], false);
      // Two levels at a cap of 5: depth 0 may step from 2 and steps from its 1, so depth 1 may step from
      // the 4 left, all of it: nothing cut. Shares fixed at 2 a level would have cut depth 1.
      expect(await counted(5)).toMatchObject({ depth: 2, wallets: 4, cut: false });
      // At 4, depth 1 may step from 3 of its 4: their 3 payees stand for 4.
      expect(await counted(4)).toMatchObject({ depth: 2, wallets: 4, cut: true });
      // Uncapped: every wallet, nothing cut.
      expect(await counted(Infinity)).toMatchObject({ depth: 2, wallets: 4, cut: false });
    } finally {
      store.walkCap = WALK_CAP;
      await drop(C, w('36c1'));
    }
  });

  // Own builders, not the fixtures': those count up one sequence that later tests' block cursors are set against.
  let paid = 0;
  const pay = (from: string, to: string): Flow => ({ txHash: `0xreach${++paid}`, kind: 'native', from, to, valueWei: '1000', token: '', blockNumber: paid, blockTime: paid });
  const trade = (tokenId: string, from: string, to: string, blockNumber: number): Transfer => ({
    txHash: `0xreachtx${blockNumber}${from.slice(-4)}`, logIndex: 0, blockNumber, blockTime: null, tokenId, from, to, marketplace: null, priceWei: null, currency: null,
  });

  it('countNext gives each statement what is left of countTimeoutMs, so the count stops by then in all', async () => {
    const C = 3114;
    const t = w('3ea1');
    const { id } = await store.addCollection(C, w('3ec1'), null, 10);
    const given: number[] = [];
    const real = pgClient.Client.prototype.query;
    const spy = vi.spyOn(pgClient.Client.prototype, 'query').mockImplementation(function (this: pgClient.Client, ...args: any[]) {
      if (typeof args[0] === 'string' && args[0].includes("set_config('statement_timeout'")) given.push(parseInt(args[1][0], 10));
      return (real as any).apply(this, args);
    } as any);
    try {
      await store.ingest(id, C, [trade('1', ZERO, t, 20)], 50, [t]);
      await store.saveMoney(C, t, [pay(t, w('3eb1'))], false);
      expect(store.countTimeoutMs).toBe(COUNT_TIMEOUT_MS);
      store.countTimeoutMs = 60_000;
      expect(await store.countNext(id, 2)).toBe('counted');
      // Straight after BEGIN, before the walk's first rows, before each of its levels' two statements
      // (3 levels to depth 3), then before the count's two.
      expect(given).toHaveLength(10);
      expect(given.every((ms) => ms > 0 && ms <= 60_000)).toBe(true);
      expect([...given].sort((a, b) => b - a)).toEqual(given);
      // Past it, the next statement is given a millisecond (here, one that sleeps), and fails: a stopped count stores nothing.
      store.countTimeoutMs = -1;
      spy.mockImplementation(function (this: pgClient.Client, ...args: any[]) {
        if (typeof args[0] === 'string' && args[0].includes("set_config('statement_timeout'")) return (real as any).apply(this, [args[0], args[1]]).then(() => (real as any).apply(this, ['SELECT pg_sleep(0.05)']));
        return (real as any).apply(this, args);
      } as any);
      await store.pool.query('UPDATE washtrace.collections SET follow_estimate = NULL WHERE id = $1', [id]);
      await expect(store.countNext(id, 2)).rejects.toThrow(/statement timeout/);
      expect((await store.pool.query('SELECT follow_estimate FROM washtrace.collections WHERE id = $1', [id])).rows[0].follow_estimate).toBeNull();
    } finally {
      spy.mockRestore();
      store.countTimeoutMs = COUNT_TIMEOUT_MS;
      await drop(C, w('3ec1'));
    }
  });

  describe('the fund job following a collection\'s reach', () => {
    /** seedReach until it says nothing is left, `limit` wallets a call; how many calls did something. */
    const seedAll = async (chainId: number, hops: number, limit = 1) => {
      let calls = 0;
      while (await store.seedReach(chainId, hops, limit) > 0) calls += 1;
      return calls;
    };
    const reachOf = async (id: number) => (await store.pool.query(
      'SELECT address, depth FROM washtrace.reach WHERE collection_id = $1 ORDER BY depth, address', [id],
    )).rows.map((r) => [r.address, r.depth]);
    const walletOf = async (chainId: number, address: string) => (await store.pool.query(
      'SELECT depth, status FROM washtrace.wallets WHERE chain_id = $1 AND address = $2', [chainId, address],
    )).rows[0];

    /**
     * One collection's money, read three hops out by the global follow: t1 → a1 → b1 → c1 → d1, still to
     * check. b1 also paid x1 (at chain depth 1 for another collection, 3 out from these traders), which paid
     * y1; c2, truncated; and c3, which paid past the fanout. c1 also paid d3, checked already for another
     * collection, which paid e3.
     */
    async function setup(C: number, tag: string) {
      const n = (name: string) => w(`${tag}${name}`);
      const s = {
        t1: n('a1'), t2: n('a2'), a1: n('b1'), b1: n('b2'), c1: n('c1'), c2: n('c2'), c3: n('c3'), x1: n('c4'),
        d1: n('d1'), d3: n('d3'), e3: n('e3'), y1: n('f1'), z1: n('f2'),
      };
      const { id } = await store.addCollection(C, n('cc'), null, 10);
      await store.ingest(id, C, [trade('1', ZERO, s.t1, 20), trade('1', s.t1, s.t2, 21)], 50, [s.t1, s.t2]);
      await wallets(C, [[s.a1, 1, 'pending'], [s.b1, 2, 'pending'], [s.c1, 3, 'pending'], [s.c2, 3, 'pending'], [s.c3, 3, 'pending'], [s.x1, 1, 'pending'], [s.d3, 1, 'pending']]);
      await store.saveMoney(C, s.t1, [pay(s.t1, s.a1)], false);
      await store.saveMoney(C, s.t2, [], false);
      await store.saveMoney(C, s.a1, [pay(s.a1, s.b1)], false);
      await store.saveMoney(C, s.b1, [pay(s.b1, s.c1), pay(s.b1, s.c2), pay(s.b1, s.c3), pay(s.b1, s.x1)], false);
      await store.saveMoney(C, s.c1, [pay(s.c1, s.d1), pay(s.c1, s.d3)], false);
      await store.saveMoney(C, s.x1, [pay(s.x1, s.y1)], false);
      await store.saveMoney(C, s.c2, [pay(s.c2, s.z1)], true);
      await store.saveMoney(C, s.c3, Array.from({ length: FOLLOW_FANOUT + 1 }, (_, i) => pay(s.c3, n(`h${i}`))), false);
      await store.saveMoney(C, s.d3, [pay(s.d3, s.e3)], false);
      return { id, n, ...s };
    }

    it('a collection with follow_hops 5 over a global 3 gets its depth-4 wallets seeded from stored flows, and a reach lane serves them', async () => {
      const C = 3107;
      const s = await setup(C, '37');
      try {
        // Nothing follows further: nothing to seed.
        expect(await store.seedReach(C, 3, 100)).toBe(0);
        expect(await store.followFurther(s.id, 5)).toBe('set');
        expect(await store.moneyRead(s.id, 3)).toMatchObject({ seeding: true, pendingByDepth: {} });
        // One wallet a call: the traders together, then each checked wallet, shallowest first.
        expect(await seedAll(C, 3)).toBe(10);
        expect(await reachOf(s.id)).toEqual([
          [s.t1, 0], [s.t2, 0], [s.a1, 1], [s.b1, 2], [s.c1, 3], [s.c2, 3], [s.c3, 3], [s.x1, 3],
          // d3, checked already, is walked through: e3 is reached though no lane hands d3 out again.
          [s.d1, 4], [s.d3, 4], [s.y1, 4], [s.e3, 5],
        ]);
        // Queued as `fund` queues, at the nearer of the chain's depth and this walk's: y1 and e3, past
        // wallets at chain depth 1, are the followed lane's; d1 is past the global limit both ways.
        expect(await walletOf(C, s.d1)).toEqual({ depth: 4, status: 'pending' });
        expect(await walletOf(C, s.y1)).toEqual({ depth: 2, status: 'pending' });
        expect(await walletOf(C, s.e3)).toEqual({ depth: 2, status: 'pending' });
        // Truncated and past the fanout: not followed.
        expect(await walletOf(C, s.z1)).toBeUndefined();
        expect(await walletOf(C, s.n('h0'))).toBeUndefined();
        expect(await store.moneyRead(s.id, 3)).toMatchObject({ seeding: false, pendingByDepth: { 4: 2, 5: 1 } });
        const { lanes } = await store.moneyLanes(C, 10, 3);
        expect(lanes.map((l) => ({ ...l, wallets: [...l.wallets].sort() }))).toEqual([
          // Its own lane, its traders (none unchecked) then its reach past the global limit: y1 and e3
          // too, though the followed lane has them (interleave checks each once).
          { collectionId: s.id, wallets: [s.d1, s.e3, s.y1].sort() },
          { collectionId: null, wallets: [s.e3, s.y1].sort() },
        ]);
        // Seeded: a pass finds nothing more until a reach wallet is checked.
        expect(await store.seedReach(C, 3, 100)).toBe(0);
      } finally {
        await drop(C, s.n('cc'));
      }
    });

    it('checking a reach wallet at depth 4 adds its sent-to wallets at depth 5, and stops at follow_hops', async () => {
      const C = 3108;
      const s = await setup(C, '38');
      const [e1, f1] = [s.n('e1'), s.n('g1')];
      try {
        await store.followFurther(s.id, 5);
        await seedAll(C, 3, 100);
        expect((await store.moneyRead(s.id, 3)).seeding).toBe(false);
        // Checked, not yet stepped from: what it paid is not in the reach yet, so the walk is not done.
        await store.saveMoney(C, s.d1, [pay(s.d1, e1)], false);
        expect(await store.moneyRead(s.id, 3)).toMatchObject({ seeding: true, pendingByDepth: { 5: 1 } });
        expect(await seedAll(C, 3, 100)).toBe(1);
        expect((await store.moneyRead(s.id, 3)).seeding).toBe(false);
        expect((await reachOf(s.id)).filter(([, d]) => d === 5)).toEqual([[s.e3, 5], [e1, 5]].sort());
        expect(await walletOf(C, e1)).toEqual({ depth: 5, status: 'pending' });
        // Depth 5 is the limit: what e1 sends is not followed. Checked, it is marked stepped all the same,
        // so it leaves the index of wallets still to step.
        await store.saveMoney(C, e1, [pay(e1, f1)], false);
        expect(await seedAll(C, 3, 100)).toBe(1);
        expect((await reachOf(s.id)).map(([a]) => a)).not.toContain(f1);
        expect(await walletOf(C, f1)).toBeUndefined();
        expect((await store.pool.query('SELECT stepped FROM washtrace.reach WHERE collection_id = $1 AND address = $2', [s.id, e1])).rows).toEqual([{ stepped: true }]);
        // Raised to 6: e1 is stepped from now, and its reach reads as still being found until it is.
        expect(await store.followFurther(s.id, 6)).toBe('set');
        expect((await store.moneyRead(s.id, 3)).seeding).toBe(true);
        expect(await seedAll(C, 3, 100)).toBe(1);
        expect(await reachOf(s.id)).toContainEqual([f1, 6]);
        expect((await store.moneyRead(s.id, 3)).seeding).toBe(false);
      } finally {
        await drop(C, s.n('cc'));
      }
    });

    it('a trader who comes later is walked from at once, and a wallet found nearer moves in and is followed again', async () => {
      const C = 3109;
      const s = await setup(C, '39');
      const [t3, k1] = [s.n('a3'), s.n('k1')];
      try {
        await store.followFurther(s.id, 5);
        await seedAll(C, 3, 100);
        const locked = async () => (await store.pool.query('SELECT xmax::text AS x FROM washtrace.reach WHERE collection_id = $1 AND address = $2', [s.id, s.t1])).rows[0].x;
        const before = await locked();
        // t3 trades: the span leaves the walk unseeded, so the next turn adds it, not a day on.
        await store.ingest(s.id, C, [trade('2', s.t2, t3, 60)], 60, [t3]);
        expect(await seedAll(C, 3, 100)).toBe(1);
        // A trader already at depth 0 is not met at all: not locked, so not written.
        expect(await locked()).toBe(before);
        expect(await reachOf(s.id)).toContainEqual([t3, 0]);
        // Checked, it paid e3 itself: e3 is one hop out now, not five.
        await store.saveMoney(C, t3, [pay(t3, s.e3)], false);
        expect(await seedAll(C, 3, 100)).toBe(1);
        expect(await reachOf(s.id)).toContainEqual([s.e3, 1]);
        await store.saveMoney(C, s.e3, [pay(s.e3, k1)], false);
        expect(await seedAll(C, 3, 100)).toBe(1);
        expect(await reachOf(s.id)).toContainEqual([k1, 2]);
        // A day on its traders are added again; with none new, none is written.
        await store.pool.query("UPDATE washtrace.collections SET reach_seeded_at = now() - interval '25 hours' WHERE id = $1", [s.id]);
        expect(await seedAll(C, 3, 100)).toBe(0);
        expect(await locked()).toBe(before);
        expect((await store.moneyRead(s.id, 3)).seeding).toBe(false);
      } finally {
        await drop(C, s.n('cc'));
      }
    });

    it('a paused collection\'s reach lane isn\'t served, and its pending reach counts as stranded in the backlog', async () => {
      const C = 3110;
      const s = await setup(C, '3a');
      // Another collection on the chain is live, so the followed lane still serves y1 and e3.
      const other = await store.addCollection(C, s.n('co'), null, 10);
      const row = async () => (await store.moneyBacklog(3)).find((r) => r.chainId === C)!;
      try {
        await store.followFurther(s.id, 5);
        await seedAll(C, 3, 100);
        expect(await row()).toMatchObject({ pending: 3, stranded: 0 });
        await store.pause(C, s.n('cc'));
        expect((await store.moneyLanes(C, 10, 3)).lanes.map((l) => l.collectionId)).toEqual([other.id, null]);
        expect(await row()).toMatchObject({ pending: 2, stranded: 1 });
        // Nor is it walked while paused: a reach wallet checked meanwhile waits for it.
        await store.saveMoney(C, s.d1, [pay(s.d1, s.n('e1'))], false);
        expect(await store.seedReach(C, 3, 100)).toBe(0);
        await store.resume(C, s.n('cc'));
        expect(await store.seedReach(C, 3, 100)).toBe(1);
        // Gone: no pass touches it.
        await drop(C, s.n('cc'));
        expect(await store.seedReach(C, 3, 100)).toBe(0);
        expect(await reachOf(s.id)).toEqual([]);
      } finally {
        await drop(C, s.n('cc'));
        await drop(C, s.n('co'));
      }
    });

    it('a wallet in two collections\' reach is checked once, and both reaches get their rows', async () => {
      const C = 3111;
      const [t, a, b, c, d, e] = [w('3ba1'), w('3bb1'), w('3bb2'), w('3bb3'), w('3bb4'), w('3bb5')];
      const one = (await store.addCollection(C, w('3bc1'), null, 10)).id;
      const two = (await store.addCollection(C, w('3bc2'), null, 10)).id;
      try {
        // t trades in both.
        await store.ingest(one, C, [trade('1', w('3bd1'), t, 20)], 50, [t]);
        await store.ingest(two, C, [trade('1', w('3bd2'), t, 21)], 50, [t]);
        await wallets(C, [[a, 1, 'pending'], [b, 2, 'pending'], [c, 3, 'pending']]);
        for (const [from, to] of [[t, a], [a, b], [b, c], [c, d]] as const) await store.saveMoney(C, from, [pay(from, to)], false);
        await store.followFurther(one, 5);
        await store.followFurther(two, 5);
        await seedAll(C, 3, 100);
        const { lanes } = await store.moneyLanes(C, 10, 3);
        expect(lanes.filter((l) => l.wallets.includes(d)).map((l) => l.collectionId).sort()).toEqual([one, two].sort());
        expect(interleave(lanes, new Set()).filter((x) => x === d)).toEqual([d]);
        await store.saveMoney(C, d, [pay(d, e)], false);
        await seedAll(C, 3, 100);
        expect(await reachOf(one)).toContainEqual([e, 5]);
        expect(await reachOf(two)).toContainEqual([e, 5]);
      } finally {
        await drop(C, w('3bc1'));
        await drop(C, w('3bc2'));
      }
    });

    it('a level of wallets another collection read already moves the collection\'s version when its walk reaches them', async () => {
      const C = 3122;
      const [tx, a1, b1, c1, ty, a2, b2, c2, d1] = [w('3la1'), w('3lb1'), w('3lc1'), w('3ld1'), w('3la2'), w('3lb2'), w('3lc2'), w('3ld2'), w('3le1')];
      const X = (await store.addCollection(C, w('3lcx'), null, 10)).id;
      const Y = (await store.addCollection(C, w('3lcy'), null, 10)).id;
      const version = async (id: number) => Number((await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id])).rows[0].version);
      try {
        // Both walks reach d1, 4 out from each one's traders: tx -> a1 -> b1 -> c1 -> d1 and ty -> a2 -> b2 -> c2 -> d1.
        await store.ingest(X, C, [trade('1', ZERO, tx, 20)], 50, [tx]);
        await store.ingest(Y, C, [trade('1', ZERO, ty, 21)], 50, [ty]);
        await wallets(C, [[a1, 1, 'pending'], [b1, 2, 'pending'], [c1, 3, 'pending'], [a2, 1, 'pending'], [b2, 2, 'pending'], [c2, 3, 'pending']]);
        for (const [from, to] of [[tx, a1], [a1, b1], [b1, c1], [c1, d1], [ty, a2], [a2, b2], [b2, c2], [c2, d1]] as const) await store.saveMoney(C, from, [pay(from, to)], false);
        // X fetched 5 hops first, and read d1.
        await store.followFurther(X, 5);
        await seedAll(C, 3);
        await store.saveMoney(C, d1, [], false, followOf(C, 3));
        await seedAll(C, 3);
        const [x, y] = [await version(X), await version(Y)];
        // Y's level at 4 is d1 alone, already done: no fund call will ever check it again for Y.
        await store.followFurther(Y, 5);
        await seedAll(C, 3);
        expect(await reachOf(Y)).toContainEqual([d1, 4]);
        expect(await version(Y)).toBe(y + 1);
        expect(await version(X)).toBe(x);
      } finally {
        await drop(C, w('3lcx'));
        await drop(C, w('3lcy'));
      }
    });

    it('the global lane and a reach lane never hand out the same wallet in one pass', async () => {
      const C = 3112;
      const s = await setup(C, '3c');
      try {
        await store.followFurther(s.id, 5);
        await seedAll(C, 3, 100);
        const { lanes } = await store.moneyLanes(C, 10, 3);
        // y1 is both the followed lane's (chain depth 2) and in its own lane's reach (4 out from these traders).
        expect(lanes.filter((l) => l.wallets.includes(s.y1))).toHaveLength(2);
        const order = interleave(lanes, new Set([s.id]));
        expect(order.filter((x) => x === s.y1)).toHaveLength(1);
        expect(new Set(order).size).toBe(order.length);
        // A lane is perLane long at most, its reach filling what its traders leave: with two traders still to
        // check and two at a lane, none of its reach.
        await store.pool.query("UPDATE washtrace.wallets SET status = 'pending' WHERE chain_id = $1 AND address = ANY($2)", [C, [s.t1, s.t2]]);
        expect((await store.moneyLanes(C, 2, 3)).lanes.find((l) => l.collectionId === s.id)!.wallets.sort()).toEqual([s.t1, s.t2].sort());
        expect((await store.moneyLanes(C, 3, 3)).lanes.find((l) => l.collectionId === s.id)!.wallets).toHaveLength(3);
        await store.pool.query("UPDATE washtrace.wallets SET status = 'done' WHERE chain_id = $1 AND address = ANY($2)", [C, [s.t1, s.t2]]);
        // follow.hops raised to 4: d1 and y1 are within it both ways, the followed lane's alone now. e3,
        // 5 out from these traders, is still past it.
        expect((await store.moneyLanes(C, 10, 4)).lanes).toEqual([
          { collectionId: s.id, wallets: [s.e3] }, { collectionId: null, wallets: expect.arrayContaining([s.d1, s.y1, s.e3]) },
        ]);
        // Raised to the collection's own: no reach lane, and nothing to walk.
        expect((await store.moneyLanes(C, 10, 5)).lanes.map((l) => l.collectionId)).toEqual([s.id, null]);
        expect(await store.seedReach(C, 5, 100)).toBe(0);
      } finally {
        await drop(C, s.n('cc'));
      }
    });

    it('a wallet queued deep on the chain and found 2 out by this walk moves in: the followed lane checks it, and its reach neither serves nor counts it', async () => {
      const C = 3115;
      const [t, t9, a, b] = [w('3fa1'), w('3fa9'), w('3fb1'), w('3fb2')];
      const { id } = await store.addCollection(C, w('3fc1'), null, 10);
      const row = async () => (await store.moneyBacklog(3)).find((r) => r.chainId === C)!;
      try {
        // t9 trades and is still to check; t paid a, which paid b.
        await store.ingest(id, C, [trade('1', ZERO, t, 20), trade('1', t, t9, 21)], 50, [t, t9]);
        // b was queued 4 out on the chain, by another collection's walk: past every lane but a reach's.
        await wallets(C, [[a, 1, 'pending'], [b, 4, 'pending']]);
        await store.saveMoney(C, t, [pay(t, a)], false);
        await store.saveMoney(C, a, [pay(a, b)], false);
        expect(await row()).toMatchObject({ pending: 1, stranded: 1 });
        await store.followFurther(id, 5);
        await seedAll(C, 3, 100);
        expect(await reachOf(id)).toEqual(expect.arrayContaining([[b, 2], [t9, 0]]));
        // Moved in to 2, where the followed lane reads it.
        expect(await walletOf(C, b)).toEqual({ depth: 2, status: 'pending' });
        expect((await store.moneyLanes(C, 10, 3)).lanes).toEqual([{ collectionId: id, wallets: [t9] }, { collectionId: null, wallets: [b] }]);
        expect(await row()).toMatchObject({ pending: 2, stranded: 0 });
        // Within the global limit, its reach's pending wallets (b, and the trader t9) are not its own count.
        expect((await store.moneyRead(id, 3)).pendingByDepth).toEqual({});
      } finally {
        await drop(C, w('3fc1'));
      }
    });

    it('a press while seedReach is finishing leaves it seeding', async () => {
      const C = 3116;
      const s = await setup(C, '3g');
      const real = (store as any).reachStatement;
      try {
        await store.followFurther(s.id, 5);
        await seedAll(C, 3, 100);
        // As if the last call had not yet written that it was done.
        await store.pool.query('UPDATE washtrace.collections SET reach_seeded_at = NULL WHERE id = $1', [s.id]);
        let calls = 0;
        // Nothing to step, no trader to add: and then, before the call writes that it is done, a press for 6.
        (store as any).reachStatement = async (id: number, write: (c: pgClient.PoolClient) => Promise<number>) => {
          const n = await real.call(store, id, write);
          if (++calls === 2) expect(await store.followFurther(id, 6)).toBe('set');
          return n;
        };
        expect(await store.seedReach(C, 3, 100)).toBe(0);
        expect(calls).toBe(2);
        expect((await store.moneyRead(s.id, 3)).seeding).toBe(true);
        (store as any).reachStatement = real;
        await seedAll(C, 3, 100);
        expect((await store.moneyRead(s.id, 3)).seeding).toBe(false);
      } finally {
        (store as any).reachStatement = real;
        await drop(C, s.n('cc'));
      }
    });

    it('a press while a chunk is stepping waits for it, and the next chunk steps again from what it marked at the old limit', async () => {
      const C = 3118;
      const s = await setup(C, '3i');
      const [e1, f1] = [s.n('e1'), s.n('g1')];
      const real = (store as any).reachStatement;
      try {
        await store.followFurther(s.id, 5);
        await seedAll(C, 3, 100);
        await store.saveMoney(C, s.d1, [pay(s.d1, e1)], false);
        await seedAll(C, 3, 100);
        // e1, at the limit, is checked: the next chunk marks it stepped and does not follow it.
        await store.saveMoney(C, e1, [pay(e1, f1)], false);
        let pressed: Promise<string> | null = null;
        let state = '';
        (store as any).reachStatement = (id: number, write: (c: pgClient.PoolClient) => Promise<number>) => real.call(store, id, async (c: pgClient.PoolClient) => {
          const n = await write(c);
          if (pressed === null) {
            // Marked, not yet committed: a press now waits for the commit.
            pressed = store.followFurther(id, 6);
            state = await Promise.race([pressed.then(() => 'pressed'), new Promise<string>((r) => setTimeout(() => r('waiting'), 300))]);
          }
          return n;
        });
        expect(await store.seedReach(C, 3, 100)).toBe(1);
        expect(state).toBe('waiting');
        expect(await pressed).toBe('set');
        (store as any).reachStatement = real;
        // The press leaves the mark: the next chunk takes it off, as it finds the limit past reach_hops. Until then
        // the reach reads as still being found, and then e1 is stepped from, out to 6.
        expect((await store.pool.query('SELECT stepped FROM washtrace.reach WHERE collection_id = $1 AND address = $2', [s.id, e1])).rows).toEqual([{ stepped: true }]);
        expect((await store.moneyRead(s.id, 3)).seeding).toBe(true);
        await seedAll(C, 3, 100);
        expect(await reachOf(s.id)).toContainEqual([f1, 6]);
        expect((await store.moneyRead(s.id, 3)).seeding).toBe(false);
      } finally {
        (store as any).reachStatement = real;
        await drop(C, s.n('cc'));
      }
    });

    it('a collection whose count runs out of time doesn\'t get the next pass\'s count', async () => {
      const C = 3117;
      const one = (await store.addCollection(C, w('3hc1'), null, 10)).id;
      const two = (await store.addCollection(C, w('3hc2'), null, 10)).id;
      const real = pgClient.Client.prototype.query;
      try {
        expect(await store.nextCount(3)).toBe(one);
        // Each statement it is given time for sleeps past it.
        const spy = vi.spyOn(pgClient.Client.prototype, 'query').mockImplementation(function (this: pgClient.Client, ...args: any[]) {
          if (typeof args[0] === 'string' && args[0].includes("set_config('statement_timeout'")) return (real as any).apply(this, [args[0], args[1]]).then(() => (real as any).apply(this, ['SELECT pg_sleep(0.05)']));
          return (real as any).apply(this, args);
        } as any);
        try {
          await expect(store.countNext(one, 3, -1)).rejects.toThrow(/statement timeout/);
        } finally {
          spy.mockRestore();
        }
        // Not counted: it reads as not counted yet, and waits its turn behind the other.
        expect((await store.moneyRead(one, 3)).estimate).toBeNull();
        expect(await store.nextCount(3)).toBe(two);
        expect(await store.countNext(two, 3)).toBe('counted');
        // The only one due, but it ran out of time under an hour ago: not tried again each pass, at a count's cost each.
        expect(await store.nextCount(3)).toBeNull();
        await store.pool.query("UPDATE washtrace.collections SET count_tried_at = now() - interval '61 minutes' WHERE id = $1", [one]);
        expect(await store.nextCount(3)).toBe(one);
        // A count that did not fail waits for nothing: two, counted just now, is due again at once for a hop raised since.
        await store.pool.query("UPDATE washtrace.collections SET count_tried_at = now() WHERE id = $1", [one]);
        expect(await store.followFurther(two, 5)).toBe('set');
        expect(await store.nextCount(3)).toBe(two);
      } finally {
        await drop(C, w('3hc1'));
        await drop(C, w('3hc2'));
      }
    });

    it('with no collection over the global limit, the lanes and their SQL are unchanged', async () => {
      const C = 3113;
      const s = await setup(C, '3d');
      try {
        // Its own limit no further than the global one: as if it had none.
        await store.followFurther(s.id, 3);
        const asked = vi.spyOn(store.pool, 'query');
        try {
          const { lanes } = await store.moneyLanes(C, 10, 3);
          // Its traders' lane, then the followed lane's query, which finds none: two queries, as ever.
          expect(lanes).toEqual([{ collectionId: s.id, wallets: [] }]);
          expect(asked).toHaveBeenCalledTimes(2);
          expect(asked.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('reach');
        } finally {
          asked.mockRestore();
        }
      } finally {
        await drop(C, s.n('cc'));
      }
    });
  });
});

describe('migration #32: other tokens, and a walk safe at any limit', () => {
  const at = async (version: number) => {
    await store.pool.query('DELETE FROM washtrace.schema_version');
    await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES ($1)', [version]);
  };
  const wallets = async (chainId: number, rows: [address: string, depth: number, status: 'pending' | 'done' | 'failed'][]) => {
    for (const [address, depth, status] of rows) {
      await store.pool.query('INSERT INTO washtrace.wallets (chain_id, address, depth, status) VALUES ($1, $2, $3, $4)', [chainId, address, depth, status]);
    }
  };
  // Own builders, as #31's: the fixtures' count up one sequence that later tests' block cursors are set against.
  let paid = 0;
  const pay = (from: string, to: string): Flow => ({ txHash: `0xtokw${++paid}`, kind: 'native', from, to, valueWei: '1000', token: '', blockNumber: paid, blockTime: paid });
  const usdc = (from: string, to: string, valueRaw = '1000000'): TokenFlow => ({ txHash: `0xtokt${++paid}`, from, to, token: USDC, valueRaw, blockNumber: paid, blockTime: paid });
  const trade = (tokenId: string, from: string, to: string, blockNumber: number): Transfer => ({
    txHash: `0xtoktx${blockNumber}${from.slice(-4)}`, logIndex: 0, blockNumber, blockTime: null, tokenId, from, to, marketplace: null, priceWei: null, currency: null,
  });
  const seedAll = async (chainId: number, hops: number, limit = 100) => {
    let calls = 0;
    while (await store.seedReach(chainId, hops, limit) > 0) calls += 1;
    return calls;
  };
  const reachOf = async (id: number) => (await store.pool.query(
    'SELECT address, depth, stepped FROM washtrace.reach WHERE collection_id = $1 ORDER BY depth, address', [id],
  )).rows.map((r) => [r.address, r.depth, r.stepped]);
  const own = async (id: number) => (await store.pool.query(
    'SELECT reach_hops, read_tokens_at, token_counts, version::int AS version FROM washtrace.collections WHERE id = $1', [id],
  )).rows[0];
  const counted = async (id: number) => (await own(id))?.token_counts as TokenCounts | null;
  const stepped = async (id: number, address: string) => (await store.pool.query(
    'SELECT stepped FROM washtrace.reach WHERE collection_id = $1 AND address = $2', [id, address],
  )).rows[0]?.stepped;

  /**
   * One collection's money, a line out from its traders: t1 -> a1 -> b1 -> c1 -> d1 -> e1, each checked
   * but those in `unchecked` (d1 and e1 never are); t2 bought from t1 and paid nothing. As fund left them:
   * queued at their chain depth.
   */
  async function line(C: number, tag: string, unchecked: readonly string[] = []) {
    const n = (name: string) => w(`${tag}${name}`);
    const s = { t1: n('a1'), t2: n('a2'), a1: n('b1'), b1: n('b2'), c1: n('c1'), d1: n('d1'), e1: n('e1') };
    const { id } = await store.addCollection(C, n('cc'), null, 10);
    await store.ingest(id, C, [trade('1', ZERO, s.t1, 20), trade('1', s.t1, s.t2, 21)], 50, [s.t1, s.t2]);
    await wallets(C, [[s.a1, 1, 'pending'], [s.b1, 2, 'pending'], [s.c1, 3, 'pending']]);
    const steps: ['t1' | 't2' | 'a1' | 'b1' | 'c1', Flow[]][] = [['t1', [pay(s.t1, s.a1)]], ['t2', []], ['a1', [pay(s.a1, s.b1)]], ['b1', [pay(s.b1, s.c1)]], ['c1', [pay(s.c1, s.d1)]]];
    for (const [who, flows] of steps) if (!unchecked.includes(who)) await store.saveMoney(C, s[who], flows, false);
    return { id, n, ...s };
  }

  beforeAll(async () => {
    await store.migrate();
  });

  it('#32 is one plain step: three tables and six nullable columns; running it again changes nothing', async () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(32);
    const step = MIGRATIONS[31];
    expect(typeof step).toBe('string');
    for (const t of ['token_flows', 'token_reads', 'token_payees']) expect(step).toContain(`CREATE TABLE IF NOT EXISTS washtrace.${t}`);
    await at(31);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    await at(31);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    const keys = (await store.pool.query(
      // #34's index on token_reads aside: the latest store has it, and #32 never made it.
      `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'washtrace' AND tablename IN ('token_flows', 'token_reads', 'token_payees')
         AND indexname <> 'token_reads_stale_idx' ORDER BY tablename`,
    )).rows;
    expect(keys).toEqual([
      { tablename: 'token_flows', indexdef: 'CREATE UNIQUE INDEX token_flows_pkey ON washtrace.token_flows USING btree (chain_id, from_address, to_address, block_number, tx_hash, token, value_raw)' },
      { tablename: 'token_payees', indexdef: 'CREATE UNIQUE INDEX token_payees_pkey ON washtrace.token_payees USING btree (chain_id, payer, payee)' },
      { tablename: 'token_reads', indexdef: 'CREATE UNIQUE INDEX token_reads_pkey ON washtrace.token_reads USING btree (chain_id, address)' },
    ]);
    const columns = (await store.pool.query(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'washtrace' AND ((table_name = 'collections' AND column_name IN ('read_tokens_at', 'reach_hops', 'reach_stepped_at', 'token_counts', 'traders_at'))
         OR (table_name = 'lens_runs' AND column_name = 'tokens_read'))
       ORDER BY table_name, column_name`,
    )).rows;
    expect(columns).toEqual([
      { table_name: 'collections', column_name: 'reach_hops', is_nullable: 'YES' },
      { table_name: 'collections', column_name: 'reach_stepped_at', is_nullable: 'YES' },
      { table_name: 'collections', column_name: 'read_tokens_at', is_nullable: 'YES' },
      { table_name: 'collections', column_name: 'token_counts', is_nullable: 'YES' },
      { table_name: 'collections', column_name: 'traders_at', is_nullable: 'YES' },
      { table_name: 'lens_runs', column_name: 'tokens_read', is_nullable: 'YES' },
    ]);
  });

  it('#32 backfills reach_hops from follow_hops, for the collections that pressed Fetch them', async () => {
    const C = 3201;
    const fetched = (await store.addCollection(C, w('41c1'), null, 10)).id;
    const not = (await store.addCollection(C, w('41c2'), null, 10)).id;
    try {
      await store.followFurther(fetched, 5);
      await store.pool.query('UPDATE washtrace.collections SET reach_hops = NULL WHERE chain_id = $1', [C]);
      await at(31);
      expect(await store.migrate()).toBe(MIGRATIONS.length);
      expect((await own(fetched)).reach_hops).toBe(5);
      expect((await own(not)).reach_hops).toBeNull();
    } finally {
      await drop(C, w('41c1'));
      await drop(C, w('41c2'));
    }
  });

  it('startTokens sets once, answers already, and gone for a deleted collection', async () => {
    const C = 3202;
    const { id } = await store.addCollection(C, w('42c1'), null, 10);
    try {
      expect((await own(id)).read_tokens_at).toBeNull();
      expect(await store.startTokens(id)).toBe('set');
      const first = (await own(id)).read_tokens_at;
      expect(first).toBeInstanceOf(Date);
      expect(await store.startTokens(id)).toBe('already');
      expect((await own(id)).read_tokens_at).toEqual(first);
      await drop(C, w('42c1'));
      expect(await store.startTokens(id)).toBe('gone');
      const other = (await store.addCollection(C, w('42c2'), null, 10)).id;
      // Two presses together: one sets it, the other finds it set.
      expect((await Promise.all([store.startTokens(other), store.startTokens(other)])).sort()).toEqual(['already', 'set']);
    } finally {
      await drop(C, w('42c1'));
      await drop(C, w('42c2'));
    }
  });

  it('tokenCounts is the stored count, and null for none, for one a timed-out count left with only `tried`, and for a deleted collection', async () => {
    const C = 3299;
    const { id } = await store.addCollection(C, w('43c1'), null, 10);
    try {
      expect(await store.tokenCounts(id)).toBeNull();
      await store.pool.query(`UPDATE washtrace.collections SET token_counts = '{"tried":"2026-11-09T00:00:00.000Z"}' WHERE id = $1`, [id]);
      expect(await store.tokenCounts(id)).toBeNull();
      const counts = { wallets: 9, read: 4, truncated: 1, failed: 0, moneyFailed: 0, settled: true, payees: false, at: '2026-11-09T00:00:00.000Z' };
      await store.pool.query('UPDATE washtrace.collections SET token_counts = $2 WHERE id = $1', [id, JSON.stringify(counts)]);
      expect(await store.tokenCounts(id)).toEqual(counts);
      await drop(C, w('43c1'));
      expect(await store.tokenCounts(id)).toBeNull();
    } finally {
      await drop(C, w('43c1'));
    }
  });

  it('Start reading with no own limit walks from depth 0 to the global limit and settles; the reach lane and pendingByDepth are unchanged', async () => {
    const C = 3203;
    const s = await line(C, '43');
    try {
      // Not started, no own limit: nothing to walk.
      expect(await store.seedReach(C, 3, 100)).toBe(0);
      expect(await store.startTokens(s.id)).toBe('set');
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 0, settled: false });
      expect(await seedAll(C, 3)).toBeGreaterThan(0);
      expect(await reachOf(s.id)).toEqual([
        // c1, at the limit, is marked stepped and not followed: d1 is no set wallet.
        [s.t1, 0, true], [s.t2, 0, true], [s.a1, 1, true], [s.b1, 2, true], [s.c1, 3, true],
      ]);
      expect((await own(s.id)).reach_hops).toBe(3);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toEqual({ wallets: 5, read: 0, truncated: 0, failed: 0, moneyFailed: 0, settled: true, payees: false, at: expect.any(String) });
      // Within the global limit its reach is the walk's own: no reach lane, nothing pending of its own, no seeding.
      expect((await store.moneyLanes(C, 10, 3)).lanes).toEqual([{ collectionId: s.id, wallets: [] }]);
      expect(await store.moneyRead(s.id, 3)).toMatchObject({ limit: 3, ownLimit: null, pendingByDepth: {}, seeding: false });
    } finally {
      await drop(C, s.n('cc'));
    }
  });

  it('Start reading then Fetch them: the next chunk unmarks at reach_hops and writes reach_hops = L in one transaction, reaches the new limit, and only then settles', async () => {
    const C = 3204;
    const s = await line(C, '44');
    const real = (store as any).reachStatement;
    try {
      await store.startTokens(s.id);
      await seedAll(C, 3);
      // followFurther no longer unmarks: c1 stays marked until a chunk finds the limit past reach_hops.
      expect(await store.followFurther(s.id, 5)).toBe('set');
      expect(await stepped(s.id, s.c1)).toBe(true);
      expect((await own(s.id)).reach_hops).toBe(3);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect((await counted(s.id))!.settled).toBe(false);
      // The first statement the next chunk commits is the unmark and the new reach_hops, both, and no step.
      const seen: unknown[] = [];
      (store as any).reachStatement = async (id: number, write: (c: pgClient.PoolClient) => Promise<unknown>) => {
        const n = await real.call(store, id, write);
        seen.push([(await own(id)).reach_hops, await stepped(id, s.c1), (await reachOf(id)).length]);
        return n;
      };
      expect(await store.seedReach(C, 3, 100)).toBe(1);
      expect(seen[0]).toEqual([5, false, 5]);
      (store as any).reachStatement = real;
      await seedAll(C, 3);
      expect(await reachOf(s.id)).toContainEqual([s.d1, 4, false]);
      // d1 is still to check, short of the limit: not settled, so no row reads Enough.
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 6, settled: false });
      await store.saveMoney(C, s.d1, [pay(s.d1, s.e1)], false);
      await seedAll(C, 3);
      expect(await reachOf(s.id)).toContainEqual([s.e1, 5, false]);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 7, settled: true });
    } finally {
      (store as any).reachStatement = real;
      await drop(C, s.n('cc'));
    }
  });

  it('a chunk at L = reach_hops unmarks nothing, so the walk settles', async () => {
    const C = 3205;
    const s = await line(C, '45');
    try {
      await store.startTokens(s.id);
      await seedAll(C, 3);
      const before = await reachOf(s.id);
      expect(await store.seedReach(C, 3, 100)).toBe(0);
      expect(await reachOf(s.id)).toEqual(before);
      expect(await stepped(s.id, s.c1)).toBe(true);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect((await counted(s.id))!.settled).toBe(true);
    } finally {
      await drop(C, s.n('cc'));
    }
  });

  it('raising the global follow.hops past reach_hops does the same for a started collection; a Fetch-them collection whose follow_hops is now within it leaves seedReach, and its reach is the global lane\'s', async () => {
    const C = 3206;
    const s = await line(C, '46');
    const f = await line(C, '47');
    try {
      await store.startTokens(s.id);
      await store.followFurther(f.id, 4);
      await seedAll(C, 3);
      expect(await reachOf(f.id)).toContainEqual([f.d1, 4, false]);
      const fetched = await reachOf(f.id);
      // follow.hops 4: the started one walks on to 4; the Fetch-them one is within it now, and is not walked.
      await seedAll(C, 4);
      expect((await own(s.id)).reach_hops).toBe(4);
      expect(await reachOf(s.id)).toContainEqual([s.d1, 4, false]);
      expect(await stepped(s.id, s.c1)).toBe(true);
      expect((await own(f.id)).reach_hops).toBe(4);
      expect(await reachOf(f.id)).toEqual(fetched);
      // Its d1, 4 out, is the followed lane's to check now, not a reach lane's.
      expect((await store.moneyLanes(C, 10, 4)).lanes.map((l) => ({ ...l, wallets: [...l.wallets].sort() }))).toEqual([
        { collectionId: s.id, wallets: [] }, { collectionId: f.id, wallets: [] }, { collectionId: null, wallets: [f.d1, s.d1].sort() },
      ]);
      expect(await store.moneyRead(f.id, 4)).toMatchObject({ limit: 4, ownLimit: 4, pendingByDepth: {}, seeding: false });
      await store.countTokens(C, 4, false, Date.now() + TOKEN_COUNT_MS);
      // d1 is at the limit: a leaf, not one the set waits on.
      expect(await counted(s.id)).toMatchObject({ wallets: 6, settled: true });
    } finally {
      await drop(C, s.n('cc'));
      await drop(C, f.n('cc'));
    }
  });

  it('a set wallet pending its money check keeps the set unsettled, and one that failed is counted', async () => {
    const C = 3207;
    const s = await line(C, '48', ['b1', 'c1']);
    try {
      await store.startTokens(s.id);
      await seedAll(C, 3);
      expect((await reachOf(s.id)).map(([a]) => a)).toEqual([s.t1, s.t2, s.a1, s.b1]);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 4, moneyFailed: 0, settled: false });
      await store.moneyFailed(C, s.b1, 'rate limited');
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 4, moneyFailed: 1, settled: false });
      // Checked at last, it adds c1, at the limit, and the set settles.
      await store.saveMoney(C, s.b1, [pay(s.b1, s.c1)], false);
      await seedAll(C, 3);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 5, moneyFailed: 0, settled: true });
    } finally {
      await drop(C, s.n('cc'));
    }
  });

  it('tokenLanes serves unread set wallets shallowest first, skips paused collections and those not started, and retries a failed one only after an hour', async () => {
    const C = 3208;
    const s = await line(C, '49');
    const quiet = await line(C, '4a');
    const empty = (await store.addCollection(C, w('4bc1'), null, 10)).id;
    try {
      await store.startTokens(s.id);
      await store.startTokens(empty);
      await seedAll(C, 3);
      expect(await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).toEqual({ lanes: [
        { collectionId: s.id, wallets: [s.t1, s.t2, s.a1, s.b1, s.c1] }, { collectionId: empty, wallets: [] },
      ] });
      await store.saveTokens(C, s.t1, [], false);
      await store.tokensFailed(C, s.a1, 'rate limited');
      expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toEqual([s.t2, s.b1, s.c1]);
      expect((await store.pool.query('SELECT status, error FROM washtrace.token_reads WHERE chain_id = $1 AND address = $2', [C, s.a1])).rows).toEqual([{ status: 'failed', error: 'rate limited' }]);
      // An hour on, the failed one is served again, after the rest.
      await store.pool.query("UPDATE washtrace.token_reads SET read_at = now() - interval '61 minutes' WHERE chain_id = $1 AND address = $2", [C, s.a1]);
      expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toEqual([s.t2, s.b1, s.c1, s.a1]);
      expect((await store.tokenLanes(C, 2, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toEqual([s.t2, s.b1]);
      await store.pause(C, s.n('cc'));
      expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes).toEqual([{ collectionId: empty, wallets: [] }]);
    } finally {
      await drop(C, s.n('cc'));
      await drop(C, quiet.n('cc'));
      await drop(C, w('4bc1'));
    }
  });

  it('saveTokens records fanout capped at 26; a truncated read is done and never served again; collections.version does not move', async () => {
    const C = 3209;
    const s = await line(C, '4c');
    const read = async (address: string) => (await store.pool.query(
      'SELECT status, truncated, fanout, error FROM washtrace.token_reads WHERE chain_id = $1 AND address = $2', [C, address],
    )).rows[0];
    try {
      await store.startTokens(s.id);
      await seedAll(C, 3);
      const version = (await own(s.id)).version;
      await store.tokensFailed(C, s.t1, 'rate limited');
      // 30 wallets paid, one twice, one paying it back, and itself: 30 recipients, kept as 26.
      const flows = [...Array.from({ length: 30 }, (_, i) => usdc(s.t1, w(`4cp${i}`))), usdc(s.t1, w('4cp0')), usdc(w('4cq1'), s.t1), usdc(s.t1, s.t1)];
      await store.saveTokens(C, s.t1, flows, false);
      expect(await read(s.t1)).toEqual({ status: 'done', truncated: false, fanout: 26, error: null });
      // A self-transfer is no edge, and the same transfer read twice is one row.
      await store.saveTokens(C, s.t1, flows, false);
      expect((await store.pool.query('SELECT count(*)::int AS n FROM washtrace.token_flows WHERE chain_id = $1', [C])).rows[0].n).toBe(32);
      // Past the fanout: a mass sender, so none of its payees are kept.
      expect((await store.pool.query('SELECT count(*)::int AS n FROM washtrace.token_payees WHERE chain_id = $1', [C])).rows[0].n).toBe(0);
      await store.saveTokens(C, s.a1, [usdc(s.a1, w('4cr1'))], true);
      expect(await read(s.a1)).toEqual({ status: 'done', truncated: true, fanout: 1, error: null });
      // A failure after a read is done changes nothing.
      await store.tokensFailed(C, s.a1, 'late');
      expect(await read(s.a1)).toMatchObject({ status: 'done', error: null });
      await store.pool.query("UPDATE washtrace.token_reads SET read_at = now() - interval '2 days' WHERE chain_id = $1", [C]);
      expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toEqual([s.t2, s.b1, s.c1]);
      expect((await own(s.id)).version).toBe(version);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 5, read: 2, truncated: 1, failed: 0 });
      expect((await own(s.id)).version).toBe(version);
    } finally {
      await drop(C, s.n('cc'));
    }
  });

  describe('a token read again from the block its last read reached', () => {
    type Row = { status: string; truncated: boolean; fanout: number; stale: boolean; staleIn: number | null; read_block: string | null; error: string | null };
    const tokenRow = async (C: number, address: string): Promise<Row> => (await store.pool.query<Row>(
      `SELECT status, truncated, fanout, stale_at IS NOT NULL AS stale, extract(epoch FROM stale_at - now())::float8 AS "staleIn", read_block, error
       FROM washtrace.token_reads WHERE chain_id = $1 AND address = $2`, [C, address])).rows[0]!;
    const aged = (C: number, address: string, days: number) => store.pool.query(
      'UPDATE washtrace.token_reads SET read_at = now() - make_interval(days => $3) WHERE chain_id = $1 AND address = $2', [C, address, days]);
    const trader = (who: string, block: number) => trade('1', ZERO, who, block);
    const payeesOf = async (C: number, payer: string) => (await store.pool.query(
      'SELECT payee FROM washtrace.token_payees WHERE chain_id = $1 AND payer = $2 ORDER BY payee', [C, payer])).rows.map((r) => r.payee);

    it('ingest with rereadDays marks the done, untruncated token reads older than that, and the lanes serve never-read, then stale, then retries', async () => {
      const C = 3470;
      const s = await line(C, '5a');
      const wanted = async () => (await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes[0]!.wallets;
      try {
        await store.startTokens(s.id);
        await seedAll(C, 3);
        await store.saveTokens(C, s.t1, [], false, 90);
        await store.saveTokens(C, s.t2, [], true, 90);
        await store.saveTokens(C, s.a1, [], false, 90);
        await store.tokensFailed(C, s.b1, 'rate limited');
        for (const a of [s.t1, s.t2, s.a1]) await aged(C, a, 8);
        await store.pool.query("UPDATE washtrace.token_reads SET read_at = now() - interval '2 hours' WHERE chain_id = $1 AND address = $2", [C, s.b1]);
        // Off: nothing marked, and the lane is what it was.
        await store.ingest(s.id, C, [trader(s.t1, 60)], 60, [s.t1, s.t2, s.a1, s.b1], 0);
        expect((await tokenRow(C, s.t1)).stale).toBe(false);
        expect(await wanted()).toEqual([s.c1, s.b1]);
        // t1 and a1 are done, whole and read 8 days ago; t2 was cut short; b1 never finished; c1 was never read.
        await store.ingest(s.id, C, [trader(s.t1, 61)], 61, [s.t1, s.t2, s.a1, s.b1, s.c1], 7);
        expect(await tokenRow(C, s.t1)).toMatchObject({ status: 'done', stale: true });
        expect(await tokenRow(C, s.a1)).toMatchObject({ status: 'done', stale: true });
        for (const a of [s.t2, s.b1, s.c1]) expect((await tokenRow(C, a))?.stale ?? false).toBe(false);
        expect(await wanted()).toEqual([s.c1, s.t1, s.a1, s.b1]);
        // A read of 6 days ago is not due for 7.
        await store.saveTokens(C, s.t1, [], false, 90, true);
        await aged(C, s.t1, 6);
        await store.ingest(s.id, C, [trader(s.t1, 62)], 62, [s.t1], 7);
        expect((await tokenRow(C, s.t1)).stale).toBe(false);
      } finally {
        await drop(C, s.n('cc'));
      }
    });

    it('rereadFrom gives a marked token read a day of blocks before the one after its last read, floored at 0, 0 for one that had no rows, and null for a full read', async () => {
      const C = 3471;
      const s = await line(C, '5b');
      try {
        await store.startTokens(s.id);
        await seedAll(C, 3);
        await store.saveTokens(C, s.t1, [usdc(s.t1, w('5bp1'))], false, 10_000);
        await store.saveTokens(C, s.t2, [], false, null);
        expect(await store.rereadFrom(C, s.t1, 'tokens')).toBeNull();
        expect(await store.rereadFrom(C, s.a1, 'tokens')).toBeNull();
        await aged(C, s.t1, 8);
        await aged(C, s.t2, 8);
        await store.ingest(s.id, C, [trader(s.t1, 60)], 60, [s.t1, s.t2], 7);
        expect(await store.rereadFrom(C, s.t1, 'tokens')).toBe(10_000 + 1 - 7200);
        expect(await store.rereadFrom(C, s.t2, 'tokens')).toBe(0);
        // Read no further than block 100: the day before it starts before block 0.
        await store.pool.query('UPDATE washtrace.token_reads SET read_block = 100 WHERE chain_id = $1 AND address = $2', [C, s.t1]);
        expect(await store.rereadFrom(C, s.t1, 'tokens')).toBe(0);
        // The money read of the same wallet is its own: this one was never marked.
        expect(await store.rereadFrom(C, s.t1, 'money')).toBeNull();
      } finally {
        await drop(C, s.n('cc'));
      }
    });

    it('a re-read adds its flows, sets the fanout from every payee stored (capped at 26), keeps the old token_payees, clears the mark and stays done', async () => {
      const C = 3472;
      const s = await line(C, '5c');
      const ps = Array.from({ length: 30 }, (_, i) => w(`5cp${String(i).padStart(2, '0')}`));
      try {
        await store.startTokens(s.id);
        await seedAll(C, 3);
        const first = [usdc(s.t1, ps[0]!), usdc(s.t1, ps[1]!)];
        await store.saveTokens(C, s.t1, first, false, 100);
        await store.saveTokens(C, s.t2, ps.slice(0, 20).map((p) => usdc(s.t2, p)), false, 100);
        for (const a of [s.t1, s.t2]) await aged(C, a, 8);
        await store.ingest(s.id, C, [trader(s.t1, 60)], 60, [s.t1, s.t2], 7);
        // The boundary flow again, as an inclusive startblock gives it, and one new payee.
        await store.saveTokens(C, s.t1, [first[1]!, usdc(s.t1, ps[2]!)], false, 140, true);
        expect(await tokenRow(C, s.t1)).toMatchObject({ status: 'done', stale: false, read_block: '140', fanout: 3, error: null });
        expect(await payeesOf(C, s.t1)).toEqual([ps[0], ps[1], ps[2]]);
        expect((await store.pool.query('SELECT count(*)::int AS n FROM washtrace.token_flows WHERE chain_id = $1 AND from_address = $2', [C, s.t1])).rows[0].n).toBe(3);
        // 20 paid already, and 6 more: past the fanout, so a mass sender, with the 20 it was kept for.
        await store.saveTokens(C, s.t2, ps.slice(20, 26).map((p) => usdc(s.t2, p)), false, 150, true);
        expect(await tokenRow(C, s.t2)).toMatchObject({ status: 'done', stale: false, read_block: '150', fanout: 26 });
        expect(await payeesOf(C, s.t2)).toEqual(ps.slice(0, 20));
        // A read with no rows leaves the block where it was, and the fanout on what is stored.
        await store.saveTokens(C, s.t2, [], false, null, true);
        expect(await tokenRow(C, s.t2)).toMatchObject({ read_block: '150', fanout: 26 });
      } finally {
        await drop(C, s.n('cc'));
      }
    });

    it('a failed re-read keeps the old read: still done, the error noted, tried again in an hour; an unmarked done read and a first read fail as before', async () => {
      const C = 3473;
      const s = await line(C, '5d');
      try {
        await store.startTokens(s.id);
        await seedAll(C, 3);
        await store.saveTokens(C, s.t1, [usdc(s.t1, w('5dp1'))], false, 70);
        await store.saveTokens(C, s.t2, [], false, 70);
        await aged(C, s.t1, 8);
        await store.ingest(s.id, C, [trader(s.t1, 60)], 60, [s.t1], 7);
        const before = (await store.pool.query('SELECT read_at::text AS at FROM washtrace.token_reads WHERE chain_id = $1 AND address = $2', [C, s.t1])).rows[0].at;
        await store.tokensFailed(C, s.t1, 'timeout');
        const after = await tokenRow(C, s.t1);
        expect(after).toMatchObject({ status: 'done', truncated: false, fanout: 1, read_block: '70', error: 'timeout', stale: true });
        expect(after.staleIn!).toBeGreaterThan(3590);
        expect(after.staleIn!).toBeLessThanOrEqual(3600);
        expect((await store.pool.query('SELECT read_at::text AS at FROM washtrace.token_reads WHERE chain_id = $1 AND address = $2', [C, s.t1])).rows[0].at).toBe(before);
        // Not served while it waits, and its read still counts: the flows are there.
        expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toEqual([s.a1, s.b1, s.c1]);
        await store.pool.query("UPDATE washtrace.token_reads SET stale_at = now() - interval '1 minute' WHERE chain_id = $1 AND address = $2", [C, s.t1]);
        expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toEqual([s.a1, s.b1, s.c1, s.t1]);
        // Done and not marked: as today, it stays done and takes no error.
        await store.tokensFailed(C, s.t2, 'late');
        expect(await tokenRow(C, s.t2)).toMatchObject({ status: 'done', error: null, stale: false });
        // A first read fails as ever.
        await store.tokensFailed(C, s.a1, 'timeout');
        expect(await tokenRow(C, s.a1)).toMatchObject({ status: 'failed', error: 'timeout', stale: false });
      } finally {
        await drop(C, s.n('cc'));
      }
    });
  });

  it('countTokens writes each started collection\'s counts, and none for one not started', async () => {
    const C = 3210;
    const one = await line(C, '4d');
    const two = await line(C, '4e', ['c1']);
    const not = await line(C, '4f');
    try {
      await store.startTokens(one.id);
      await store.startTokens(two.id);
      await seedAll(C, 3);
      await store.saveTokens(C, one.t1, [], false);
      await store.saveTokens(C, one.a1, [], true);
      await store.tokensFailed(C, one.b1, 'rate limited');
      await store.saveTokens(C, two.t2, [], false);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      const first = (await counted(one.id))!;
      expect(first).toEqual({ wallets: 5, read: 2, truncated: 1, failed: 1, moneyFailed: 0, settled: true, payees: false, at: expect.any(String) });
      expect(new Date(first.at).toISOString()).toBe(first.at);
      // c1 is at the limit: unchecked, it is a set wallet all the same, and the walk is settled.
      expect(await counted(two.id)).toEqual({ wallets: 5, read: 1, truncated: 0, failed: 0, moneyFailed: 0, settled: true, payees: false, at: expect.any(String) });
      expect(await counted(not.id)).toBeNull();
    } finally {
      for (const s of [one, two, not]) await drop(C, s.n('cc'));
    }
  });

  it('a wallet in two started collections\' sets is read once', async () => {
    const C = 3211;
    const t = w('4ga1');
    const one = (await store.addCollection(C, w('4gc1'), null, 10)).id;
    const two = (await store.addCollection(C, w('4gc2'), null, 10)).id;
    try {
      await store.ingest(one, C, [trade('1', w('4gd1'), t, 20)], 50, [t]);
      await store.ingest(two, C, [trade('1', w('4gd2'), t, 21)], 50, [t]);
      await store.startTokens(one);
      await store.startTokens(two);
      await seedAll(C, 3);
      const { lanes } = await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000);
      expect(lanes.filter((l) => l.wallets.includes(t)).map((l) => l.collectionId)).toEqual([one, two]);
      expect(interleave(lanes, new Set()).filter((x) => x === t)).toEqual([t]);
      await store.saveTokens(C, t, [], false);
      expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes.some((l) => l.wallets.includes(t))).toBe(false);
    } finally {
      await drop(C, w('4gc1'));
      await drop(C, w('4gc2'));
    }
  });

  it('seedReach takes collections in turn, so one with much to walk does not take every chunk', async () => {
    const C = 3212;
    const x = await line(C, '4h');
    const y = await line(C, '4i');
    try {
      await store.startTokens(x.id);
      await store.startTokens(y.id);
      // How many reach rows each has, and how many of them it has stepped from.
      const sizes = async () => [x.id, y.id].map(async (id) => {
        const rows = await reachOf(id);
        return [rows.length, rows.filter(([, , done]) => done).length];
      });
      const both = async () => Promise.all(await sizes());
      // A wallet a chunk: x's traders, then y's, then a step of x's, then of y's, then x's again.
      expect(await store.seedReach(C, 3, 1)).toBe(2);
      expect(await both()).toEqual([[2, 0], [0, 0]]);
      expect(await store.seedReach(C, 3, 1)).toBe(2);
      expect(await both()).toEqual([[2, 0], [2, 0]]);
      expect(await store.seedReach(C, 3, 1)).toBe(1);
      expect((await both()).map(([, n]) => n)).toEqual([1, 0]);
      expect(await store.seedReach(C, 3, 1)).toBe(1);
      expect((await both()).map(([, n]) => n)).toEqual([1, 1]);
      expect(await store.seedReach(C, 3, 1)).toBe(1);
      expect((await both()).map(([, n]) => n)).toEqual([2, 1]);
    } finally {
      await drop(C, x.n('cc'));
      await drop(C, y.n('cc'));
    }
  });

  it('saveTokens writes token_payees only for a read that isn\'t truncated and has fanout within 25; with payees on a trader\'s payees join the set, a deeper wallet\'s and a payee\'s own don\'t; with payees off none do', async () => {
    const C = 3213;
    const s = await line(C, '4j');
    const [p1, p2, p3, p4, p5] = [w('4jp1'), w('4jp2'), w('4jp3'), w('4jp4'), w('4jp5')];
    const payees = async () => (await store.pool.query(
      'SELECT payer, payee FROM washtrace.token_payees WHERE chain_id = $1 ORDER BY payer, payee', [C],
    )).rows.map((r) => `${r.payer}>${r.payee}`);
    try {
      await store.startTokens(s.id);
      await seedAll(C, 3);
      // t1 paid p1 twice and p2, was paid by p3, and burned some: the zero address is never a payee.
      await store.saveTokens(C, s.t1, [usdc(s.t1, p1), usdc(s.t1, p1), usdc(s.t1, p2), usdc(p3, s.t1), usdc(s.t1, ZERO)], false);
      // t2's read was cut short: what it paid is not all known.
      await store.saveTokens(C, s.t2, [usdc(s.t2, p3)], true);
      // a1 is a set wallet one out: its payees are kept, but join no set.
      await store.saveTokens(C, s.a1, [usdc(s.a1, p4)], false);
      // p1 is a payee: its own payees are kept, and join no set either.
      await store.saveTokens(C, p1, [usdc(p1, p5)], false);
      expect(await payees()).toEqual([`${s.a1}>${p4}`, `${s.t1}>${p1}`, `${s.t1}>${p2}`, `${p1}>${p5}`].sort());
      // On: the set's wallets first, shallowest first, then the traders' payees.
      expect((await store.tokenLanes(C, 20, 3, true, Date.now() + 60_000)).lanes[0]!.wallets).toEqual([s.b1, s.c1, p2]);
      await store.countTokens(C, 3, true, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 7, read: 4, truncated: 1, payees: true, settled: true });
      // Off: the set is the walk's alone.
      expect((await store.tokenLanes(C, 20, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toEqual([s.b1, s.c1]);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 5, read: 3, truncated: 1, payees: false });
    } finally {
      await drop(C, s.n('cc'));
    }
  });

  it('countTokens counts each collection in its own statement within one deadline: one that runs out keeps its last counts, and so does one not reached, which goes first next time', async () => {
    const C = 3214;
    const big = await line(C, '4k');
    const small = await line(C, '4m');
    const real = pgClient.Client.prototype.query;
    const read = async (id: number) => (await counted(id))!.read;
    const at = async (id: number) => (await counted(id))!.at;
    /** countTokens with `ms` in all, the big one's count sleeping past it, as a set too big to count in time. */
    const slowBig = async (ms: number) => {
      const spy = vi.spyOn(pgClient.Client.prototype, 'query').mockImplementation(function (this: pgClient.Client, ...args: any[]) {
        if (typeof args[0] === 'string' && args[0].includes('AS settled') && args[1]?.[0] === big.id) {
          return (real as any).apply(this, ['SELECT pg_sleep(0.2)']).then(() => (real as any).apply(this, args));
        }
        return (real as any).apply(this, args);
      } as any);
      try {
        await store.countTokens(C, 3, false, Date.now() + ms);
      } finally {
        spy.mockRestore();
      }
    };
    try {
      expect(TOKEN_COUNT_MS).toBe(5_000);
      await store.startTokens(big.id);
      await store.startTokens(small.id);
      await seedAll(C, 3);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      await store.saveTokens(C, big.t1, [], false);
      await store.saveTokens(C, small.t1, [], false);
      // The small one counted longer ago: counted first, then the big one runs out and keeps its counts.
      await store.pool.query(`UPDATE washtrace.collections SET token_counts = token_counts || '{"at": "2020-01-01T00:00:00.000Z"}' WHERE id = $1`, [small.id]);
      const bigAt = await at(big.id);
      await slowBig(50);
      expect(await read(small.id)).toBe(1);
      expect(await read(big.id)).toBe(0);
      expect(await at(big.id)).toBe(bigAt);
      // Its stop is noted. Made the oldest again, it goes first, takes the whole deadline, and the small one is not reached.
      expect((await counted(big.id))!.tried).toEqual(expect.any(String));
      await store.pool.query(`UPDATE washtrace.collections SET token_counts = (token_counts - 'tried') || '{"at": "2019-01-01T00:00:00.000Z"}' WHERE id = $1`, [big.id]);
      await store.saveTokens(C, small.t2, [], false);
      const smallAt = await at(small.id);
      await slowBig(50);
      expect(await read(small.id)).toBe(1);
      expect(await at(small.id)).toBe(smallAt);
      // Each statement is given what is left of the one deadline.
      const given: number[] = [];
      const spy = vi.spyOn(pgClient.Client.prototype, 'query').mockImplementation(function (this: pgClient.Client, ...args: any[]) {
        if (typeof args[0] === 'string' && args[0].includes("set_config('statement_timeout'")) given.push(parseInt(args[1][0], 10));
        return (real as any).apply(this, args);
      } as any);
      try {
        await store.countTokens(C, 3, false, Date.now() + 60_000);
      } finally {
        spy.mockRestore();
      }
      expect(given).toHaveLength(2);
      expect(given[1]!).toBeLessThanOrEqual(given[0]!);
      expect(given[0]!).toBeLessThanOrEqual(60_000);
      expect(await read(big.id)).toBe(1);
      expect(await read(small.id)).toBe(2);
    } finally {
      await drop(C, big.n('cc'));
      await drop(C, small.n('cc'));
    }
  });

  it('countTokens notes a count that ran out as tried, keeping its other fields, and counts a set that always times out after the others', async () => {
    const C = 3217;
    const big = await line(C, '4p');
    const small = await line(C, '4q');
    const real = pgClient.Client.prototype.query;
    /** countTokens in which the big one's count always runs out. */
    const pass = async () => {
      const spy = vi.spyOn(pgClient.Client.prototype, 'query').mockImplementation(function (this: pgClient.Client, ...args: any[]) {
        if (typeof args[0] === 'string' && args[0].includes('AS settled') && args[1]?.[0] === big.id) {
          return (real as any).apply(this, ['SELECT pg_sleep(0.5)']).then(() => (real as any).apply(this, args));
        }
        return (real as any).apply(this, args);
      } as any);
      try {
        await store.countTokens(C, 3, false, Date.now() + 100);
      } finally {
        spy.mockRestore();
      }
    };
    try {
      await store.startTokens(big.id);
      await store.startTokens(small.id);
      await seedAll(C, 3);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      // The big one counted longest ago, so it goes first and runs out.
      await store.pool.query(`UPDATE washtrace.collections SET token_counts = token_counts || '{"at": "2020-01-01T00:00:00.000Z"}' WHERE id = $1`, [big.id]);
      await store.pool.query(`UPDATE washtrace.collections SET token_counts = token_counts || '{"at": "2020-06-01T00:00:00.000Z"}' WHERE id = $1`, [small.id]);
      const before = (await counted(big.id))!;
      await pass();
      const after = (await counted(big.id))!;
      expect(after.tried).toEqual(expect.any(String));
      expect({ ...after, tried: undefined }).toEqual({ ...before, tried: undefined });
      // It no longer goes first: the small one is counted this time, and the big one stays tried and stale.
      const smallAt = (await counted(small.id))!.at;
      await pass();
      expect((await counted(small.id))!.at > smallAt).toBe(true);
      expect((await counted(big.id))!.at).toBe(before.at);
      // A count that completes replaces the counts and drops `tried`: its `at` is newer, so the order is the same.
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect((await counted(big.id))!.at > before.at).toBe(true);
    } finally {
      await drop(C, big.n('cc'));
      await drop(C, small.n('cc'));
    }
  });

  it('tokenLanes stops under its timeout or the slice\'s deadline, whichever is sooner, with no lanes, never an error', async () => {
    const C = 3216;
    const s = await line(C, '4n');
    const real = pgClient.Client.prototype.query;
    try {
      expect(store.tokenLanesMs).toBe(5_000);
      await store.startTokens(s.id);
      await seedAll(C, 3);
      const spy = vi.spyOn(pgClient.Client.prototype, 'query').mockImplementation(function (this: pgClient.Client, ...args: any[]) {
        if (typeof args[0] === 'string' && args[0].includes("set_config('statement_timeout'")) return (real as any).apply(this, [args[0], args[1]]).then(() => (real as any).apply(this, ['SELECT pg_sleep(0.05)']));
        return (real as any).apply(this, args);
      } as any);
      try {
        // The slice's deadline bounds it too, sooner than its own 5 s, so a call made just before it eats no reserve.
        expect(await store.tokenLanes(C, 10, 3, false, Date.now() - 1)).toEqual({ lanes: [] });
        store.tokenLanesMs = -1;
        expect(await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).toEqual({ lanes: [] });
      } finally {
        spy.mockRestore();
        store.tokenLanesMs = 5_000;
      }
      expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toHaveLength(5);
    } finally {
      store.tokenLanesMs = 5_000;
      await drop(C, s.n('cc'));
    }
  });

  it('a span that adds a trader to a started, settled collection unsettles it until the next chunk adds the trader at depth 0', async () => {
    const C = 3217;
    const s = await line(C, '4o');
    const t3 = s.n('a3');
    try {
      await store.startTokens(s.id);
      await seedAll(C, 3);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 5, settled: true });
      await store.ingest(s.id, C, [trade('2', s.t2, t3, 60)], 60, [t3]);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 5, settled: false });
      // The next chunk adds it: in the set, and in its lane, at once.
      expect(await store.seedReach(C, 3, 100)).toBe(1);
      expect(await reachOf(s.id)).toContainEqual([t3, 0, false]);
      expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toContain(t3);
      // Still to check, a trader may add wallets: settled once it is checked and stepped from.
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 6, settled: false });
      await store.saveMoney(C, t3, [], false);
      await seedAll(C, 3);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 6, settled: true });
      // A span with no transfers leaves it settled.
      await store.ingest(s.id, C, [], 70, []);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect((await counted(s.id))!.settled).toBe(true);
    } finally {
      await drop(C, s.n('cc'));
    }
  });

  it('a load that adds a trader mid-turn, without moving the cursor, leaves the walk unseeded: the next turn adds it, and nothing reads settled between', async () => {
    const C = 3220;
    const s = await line(C, '4r');
    const t3 = s.n('a3');
    const real = (store as any).reachStatement;
    async function* batches(...bs: Transfer[][]): AsyncIterable<Transfer[]> {
      for (const b of bs) yield b;
    }
    // Stored data that stops short of the cursor (50): the load adds a transfer, GREATEST leaves the cursor.
    const entry: StoredEntry = {
      chainId: C, address: s.n('cc'), name: 'Stored', startBlock: 5, throughBlock: 30, throughTime: 1_700_000_100_000,
      transfers: { file: 'x.transfers.csv.zst', rows: 1, bytes: 0, sha256: '' }, trail: null,
    };
    const cursor = async () => (await store.pool.query('SELECT cursor_block::int AS b FROM washtrace.collections WHERE id = $1', [s.id])).rows[0].b;
    try {
      await store.startTokens(s.id);
      await seedAll(C, 3);
      // Unseeded as a day on would leave it: the next turn reads its traders again.
      await store.pool.query("UPDATE washtrace.collections SET reach_seeded_at = now() - interval '25 hours' WHERE id = $1", [s.id]);
      const before = await cursor();
      let loaded = false;
      // Once the turn has read its traders, and before it writes that it is seeded, the load commits.
      (store as any).reachStatement = async (id: number, write: (c: pgClient.PoolClient) => Promise<unknown>) => {
        const n = await real.call(store, id, write);
        if (write.toString().includes('addTraders') && !loaded) {
          loaded = true;
          await store.restore(s.id, C, entry, batches([trade('2', s.t2, t3, 25)]), 'k');
        }
        return n;
      };
      expect(await store.seedReach(C, 3, 100)).toBe(0);
      expect(loaded).toBe(true);
      (store as any).reachStatement = real;
      expect(await cursor()).toBe(before);
      expect((await store.pool.query('SELECT reach_seeded_at FROM washtrace.collections WHERE id = $1', [s.id])).rows[0].reach_seeded_at).toBeNull();
      // t3 is in transfers, not yet in the set: not settled.
      expect((await reachOf(s.id)).map(([a]) => a)).not.toContain(t3);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 5, settled: false });
      // The next turn adds it at depth 0, in the set and its lane.
      expect(await store.seedReach(C, 3, 100)).toBe(1);
      expect(await reachOf(s.id)).toContainEqual([t3, 0, false]);
      expect((await store.tokenLanes(C, 10, 3, false, Date.now() + 60_000)).lanes[0]!.wallets).toContain(t3);
      await store.saveMoney(C, t3, [], false);
      await seedAll(C, 3);
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 6, settled: true });
    } finally {
      (store as any).reachStatement = real;
      await drop(C, s.n('cc'));
    }
  });

  it('a span committed mid-turn with a stamp older than the turn\'s read still leaves the walk unseeded: compared by value, not by time', async () => {
    const C = 3221;
    const s = await line(C, '4s');
    const t3 = s.n('a3');
    const real = (store as any).reachStatement;
    try {
      await store.startTokens(s.id);
      await seedAll(C, 3);
      await store.pool.query("UPDATE washtrace.collections SET reach_seeded_at = now() - interval '25 hours' WHERE id = $1", [s.id]);
      let spanned = false;
      // After the traders are read, a span commits whose stamp is older than the read: as one that computed its
      // stamp, then waited on a lock, and committed only now.
      (store as any).reachStatement = async (id: number, write: (c: pgClient.PoolClient) => Promise<unknown>) => {
        const n = await real.call(store, id, write);
        if (write.toString().includes('addTraders') && !spanned) {
          spanned = true;
          await store.ingest(s.id, C, [trade('2', s.t2, t3, 60)], 60, [t3]);
          await store.pool.query("UPDATE washtrace.collections SET traders_at = '2000-01-01T00:00:00Z' WHERE id = $1", [s.id]);
        }
        return n;
      };
      expect(await store.seedReach(C, 3, 100)).toBe(0);
      expect(spanned).toBe(true);
      (store as any).reachStatement = real;
      await store.countTokens(C, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 5, settled: false });
      expect(await store.seedReach(C, 3, 100)).toBe(1);
      expect(await reachOf(s.id)).toContainEqual([t3, 0, false]);
    } finally {
      (store as any).reachStatement = real;
      await drop(C, s.n('cc'));
    }
  });

  it('a lowered limit is recorded, so raising it again unmarks from there, reaches the new limit and settles', async () => {
    const C = 3218;
    const s = await line(C, '4p', ['c1']);
    try {
      await store.startTokens(s.id);
      await seedAll(C, 5);
      expect((await own(s.id)).reach_hops).toBe(5);
      expect(await stepped(s.id, s.c1)).toBe(false);
      // follow.hops lowered to 3: recorded, nothing unmarked. c1, checked now, is at the limit: marked, not followed.
      await seedAll(C, 3);
      expect((await own(s.id)).reach_hops).toBe(3);
      await store.saveMoney(C, s.c1, [pay(s.c1, s.d1)], false);
      await seedAll(C, 3);
      expect(await stepped(s.id, s.c1)).toBe(true);
      expect((await reachOf(s.id)).map(([a]) => a)).not.toContain(s.d1);
      // Raised to 4: unmarked from the lowered 3, so c1 is followed out to d1, and the walk settles.
      await seedAll(C, 4);
      expect((await own(s.id)).reach_hops).toBe(4);
      expect(await reachOf(s.id)).toContainEqual([s.d1, 4, false]);
      await store.countTokens(C, 4, false, Date.now() + TOKEN_COUNT_MS);
      expect(await counted(s.id)).toMatchObject({ wallets: 6, settled: true });
    } finally {
      await drop(C, s.n('cc'));
    }
  });

  it('saveTokens reads a wallet given in mixed case as the read gives it, so a mass sender is never read as sending nothing', async () => {
    const C = 3219;
    const sender = w('4qa1');
    try {
      const flows = Array.from({ length: 30 }, (_, i) => usdc(sender, w(`4qp${i}`)));
      await store.saveTokens(C, `0x${sender.slice(2).toUpperCase()}`, flows, false);
      expect((await store.pool.query('SELECT address, fanout FROM washtrace.token_reads WHERE chain_id = $1', [C])).rows).toEqual([{ address: sender, fanout: 26 }]);
    } finally {
      await store.pool.query('DELETE FROM washtrace.token_reads WHERE chain_id = $1', [C]);
      await store.pool.query('DELETE FROM washtrace.token_flows WHERE chain_id = $1', [C]);
    }
  });

  it('countNext writes within, scaled when cut; an estimate without within is counted again', async () => {
    const C = 3215;
    const traders = [w('4la1'), w('4la2'), w('4la3'), w('4la4')];
    const { id } = await store.addCollection(C, w('4lc1'), null, 10);
    try {
      await store.ingest(id, C, traders.map((t, i) => trade(String(i + 1), ZERO, t, 20 + i)), 50, traders);
      for (const [i, t] of traders.entries()) await store.saveMoney(C, t, [pay(t, w(`4lb${i}`))], false);
      // follow.hops 1: within is the 4 traders and the 4 they paid.
      await store.countNext(id, 1);
      expect((await store.moneyRead(id, 1)).estimate).toMatchObject({ depth: 2, within: 8, cut: false });
      // One trader of the four walked: its one payee stands for four.
      store.walkCap = 2;
      await store.countNext(id, 1);
      expect((await store.moneyRead(id, 1)).estimate).toMatchObject({ depth: 2, within: 8, cut: true });
      store.walkCap = WALK_CAP;
      expect(await store.nextCount(1)).toBeNull();
      // Counted before within was: read as not counted, and counted again.
      await store.pool.query("UPDATE washtrace.collections SET follow_estimate = follow_estimate - 'within' WHERE id = $1", [id]);
      expect((await store.moneyRead(id, 1)).estimate).toBeNull();
      expect(await store.nextCount(1)).toBe(id);
    } finally {
      store.walkCap = WALK_CAP;
      await drop(C, w('4lc1'));
    }
  });
});

describe('migration #34: a trader\'s money read again from the block its last read reached', () => {
  // A chain of its own: wallets outlive their collections, and these would turn up in others' lanes.
  const C = 3434;
  const coll = w('34c1');
  type Row = { status: string; truncated: boolean; fetched: string | null; stale: boolean; staleIn: number | null; read_block: string | null; error: string | null };
  const row = async (address: string): Promise<Row> => (await store.pool.query<Row>(
    `SELECT status, truncated, fetched_at::text AS fetched, stale_at IS NOT NULL AS stale,
            extract(epoch FROM stale_at - now())::float8 AS "staleIn", read_block, error
     FROM washtrace.wallets WHERE chain_id = $1 AND address = $2`, [C, address])).rows[0]!;
  /** Its money read `days` ago: done as saveMoney leaves it, then aged. */
  const readAgo = async (address: string, days: number, truncated = false) => {
    await store.saveMoney(C, address, [], truncated);
    await store.pool.query(`UPDATE washtrace.wallets SET fetched_at = now() - make_interval(days => $3) WHERE chain_id = $1 AND address = $2`, [C, address, days]);
  };
  const flowsOf = async (address: string) => Number((await store.pool.query(
    'SELECT count(*) FROM washtrace.flows WHERE chain_id = $1 AND (from_address = $2 OR to_address = $2)', [C, address])).rows[0].count);
  const depthOf = async (address: string) => (await store.pool.query('SELECT depth FROM washtrace.wallets WHERE chain_id = $1 AND address = $2', [C, address])).rows[0]?.depth ?? null;
  const lane = async () => (await store.moneyLanes(C, 10, 2)).lanes.find((l) => l.collectionId === id)?.wallets;
  let id: number;

  beforeAll(async () => {
    await store.migrate();
  });

  beforeEach(async () => {
    id = (await store.addCollection(C, coll, 'Reread', 1)).id;
  });

  afterEach(async () => {
    await drop(C, coll);
    await store.pool.query('DELETE FROM washtrace.wallets WHERE chain_id = $1', [C]);
    await store.pool.query('DELETE FROM washtrace.flows WHERE chain_id = $1', [C]);
  });

  it('#34 is one plain step: two nullable columns on each of wallets and token_reads, and a partial index each; running it again changes nothing', async () => {
    expect(typeof MIGRATIONS[33]).toBe('string');
    for (let i = 0; i < 2; i++) {
      await store.pool.query('DELETE FROM washtrace.schema_version');
      await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES (33)');
      expect(await store.migrate()).toBe(MIGRATIONS.length);
    }
    const columns = (await store.pool.query(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'washtrace' AND table_name IN ('wallets', 'token_reads') AND column_name IN ('read_block', 'stale_at')
       ORDER BY table_name, column_name`,
    )).rows;
    expect(columns).toEqual([
      { table_name: 'token_reads', column_name: 'read_block', data_type: 'bigint', is_nullable: 'YES' },
      { table_name: 'token_reads', column_name: 'stale_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { table_name: 'wallets', column_name: 'read_block', data_type: 'bigint', is_nullable: 'YES' },
      { table_name: 'wallets', column_name: 'stale_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);
    const { rows } = await store.pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'washtrace' AND indexname IN ('wallets_stale_idx', 'token_reads_stale_idx') ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexdef)).toEqual([
      'CREATE INDEX token_reads_stale_idx ON washtrace.token_reads USING btree (chain_id, stale_at) WHERE (stale_at IS NOT NULL)',
      'CREATE INDEX wallets_stale_idx ON washtrace.wallets USING btree (chain_id, stale_at) WHERE (stale_at IS NOT NULL)',
    ]);
  });

  it('ingest with rereadDays marks the done, untruncated traders it saw read longer ago, and no other', async () => {
    const old = w('34a1'), recent = w('34a2'), cut = w('34a3'), trail = w('34a4'), pending = w('34a5'), unseen = w('34a6');
    await store.ingest(id, C, chain('1', old, recent, cut, trail, pending, unseen), 10, [old, recent, cut, trail, pending, unseen]);
    await readAgo(old, 8);
    await readAgo(recent, 6);
    await readAgo(cut, 8, true);
    await readAgo(unseen, 8);
    // As a loaded trail leaves a wallet: done, never read here.
    await store.pool.query(`UPDATE washtrace.wallets SET status = 'done', fetched_at = NULL WHERE chain_id = $1 AND address = $2`, [C, trail]);
    await store.ingest(id, C, chain('2', old, recent), 20, [old, recent, cut, trail, pending], 7);
    expect((await row(old)).stale).toBe(true);
    for (const a of [recent, cut, trail, pending, unseen]) expect((await row(a)).stale).toBe(false);
    // Still done, so everything that reads a done wallet reads it as before.
    expect(await row(old)).toMatchObject({ status: 'done', error: null });
  });

  it('ingest marks nothing with rereadDays 0, given or left out', async () => {
    const old = w('34b1');
    await store.ingest(id, C, chain('1', old), 10, [old]);
    await readAgo(old, 400);
    await store.ingest(id, C, chain('2', old), 20, [old]);
    await store.ingest(id, C, chain('3', old), 30, [old], 0);
    expect((await row(old)).stale).toBe(false);
  });

  it('a load of stored data marks nothing, however long ago its traders were read', async () => {
    const old = w('34b2');
    await store.ingest(id, C, chain('1', old), 10, [old]);
    await readAgo(old, 400);
    const ts = chain('4', old).map((t) => ({ ...t, blockNumber: 50, blockTime: 1_700_000_000 }));
    const entry: StoredEntry = {
      chainId: C, address: coll, name: 'Reread', startBlock: 5, throughBlock: 300, throughTime: 1_700_000_100_000,
      transfers: { file: `${C}-${coll}.transfers.csv.zst`, rows: 1, bytes: 0, sha256: '' }, trail: null,
    };
    await store.restore(id, C, entry, (async function* () { yield ts; })(), 'abc:1:1:1');
    expect((await store.collection(C, coll))!.cursorBlock).toBe(300);
    expect((await row(old)).stale).toBe(false);
  });

  it('the lanes serve a stale trader after every pending one and before a failed retry, and not while its failed re-read waits', async () => {
    const p = w('34d1'), s = w('34d2'), f = w('34d3');
    // s the busiest: by transfers alone it would come first.
    await store.ingest(id, C, chain('1', p, s, f), 10, [p, s, s, s, f]);
    await readAgo(s, 8);
    await store.moneyFailed(C, f, 'timeout');
    await store.pool.query(`UPDATE washtrace.wallets SET fetched_at = now() - interval '2 hours' WHERE chain_id = $1 AND address = $2`, [C, f]);
    expect(await lane()).toEqual([p, f]);
    await store.ingest(id, C, chain('2', s), 20, [s], 7);
    expect(await lane()).toEqual([p, s, f]);
    await store.moneyFailed(C, s, 'timeout');
    expect(await lane()).toEqual([p, f]);
  });

  it('with nothing stale the lanes are what they were: rereadDays 0 leaves a long-read trader unserved', async () => {
    const p = w('34e1'), q = w('34e2'), d = w('34e3'), f = w('34e4');
    await store.ingest(id, C, chain('1', p, q, d, f), 10, [p, q, q, d, f]);
    await readAgo(d, 400);
    await store.moneyFailed(C, f, 'timeout');
    await store.pool.query(`UPDATE washtrace.wallets SET fetched_at = now() - interval '2 hours' WHERE chain_id = $1 AND address = $2`, [C, f]);
    const before = await store.moneyLanes(C, 10, 2);
    expect(before.lanes).toEqual([{ collectionId: id, wallets: [q, p, f] }]);
    await store.ingest(id, C, chain('2', d), 20, [d]);
    expect(await store.moneyLanes(C, 10, 2)).toEqual(before);
  });

  it('rereadFrom gives a stale wallet a day of blocks before the one after its last read\'s, floored at 0, 0 for one whose read had no rows, and null for a full read', async () => {
    const s = w('34f1'), empty = w('34f2'), fresh = w('34f3'), low = w('34f4');
    await store.ingest(id, C, chain('1', s, empty, fresh, low), 10, [s, empty, fresh, low]);
    await store.saveMoney(C, s, [flow(s, w('34f9'), { blockNumber: 10_000 })], false, undefined, 10_000);
    await store.saveMoney(C, low, [flow(low, w('34f9'), { blockNumber: 100 })], false, undefined, 100);
    await store.saveMoney(C, empty, [], false, undefined, null);
    expect(await store.rereadFrom(C, fresh, 'money')).toBeNull();
    expect(await store.rereadFrom(C, s, 'money')).toBeNull();
    await store.pool.query(`UPDATE washtrace.wallets SET fetched_at = now() - interval '8 days' WHERE chain_id = $1 AND address = ANY($2)`, [C, [s, empty, low]]);
    await store.ingest(id, C, chain('2', s, empty, low), 20, [s, empty, low], 7);
    expect(await store.rereadFrom(C, s, 'money')).toBe(10_000 + 1 - 7200);
    expect(await store.rereadFrom(C, low, 'money')).toBe(0);
    expect(await store.rereadFrom(C, empty, 'money')).toBe(0);
    expect(await store.rereadFrom(C, w('34f8'), 'money')).toBeNull();
  });

  it('saveMoney keeps the highest block read, and a re-read adds only its new flows, clears the mark and stays done', async () => {
    const t = w('34g1'), m = w('34g2'), n = w('34g3');
    await store.ingest(id, C, chain('1', t), 10, [t]);
    const first = [flow(t, m, { blockNumber: 100 }), flow(m, t, { blockNumber: 100 })];
    await store.saveMoney(C, t, first, false, undefined, 100);
    expect((await row(t)).read_block).toBe('100');
    await store.pool.query(`UPDATE washtrace.wallets SET fetched_at = now() - interval '8 days' WHERE chain_id = $1 AND address = $2`, [C, t]);
    await store.ingest(id, C, chain('2', t), 20, [t], 7);
    // The read from the block after gives the boundary flow again, as an inclusive startblock would, and one new one.
    await store.saveMoney(C, t, [first[1]!, flow(t, n, { blockNumber: 140 })], false, undefined, 140, true);
    expect(await row(t)).toMatchObject({ status: 'done', stale: false, read_block: '140', error: null });
    expect(await flowsOf(t)).toBe(3);
    // A read with no rows (through null) leaves the block where it was.
    await store.saveMoney(C, t, [], false, undefined, null, true);
    expect((await row(t)).read_block).toBe('140');
  });

  it('a re-read judges the fanout on the whole history: a wallet that paid 30 already is not followed for 1 more', async () => {
    const follow = { hops: 2, fanout: FOLLOW_FANOUT, exclude: [] };
    const big = w('34h1'), small = w('34h2'), late = w('34h3'), later = w('34h4');
    await store.ingest(id, C, chain('1', big, small), 10, [big, small]);
    await store.saveMoney(C, big, Array.from({ length: 30 }, (_, i) => flow(big, w(`34h9${i}`))), false, follow, 50);
    expect(await depthOf(w('34h90'))).toBeNull();
    await store.saveMoney(C, small, [flow(small, w('34h80')), flow(small, w('34h81'))], false, follow, 50);
    expect(await depthOf(w('34h80'))).toBe(1);
    await store.saveMoney(C, big, [flow(big, late)], false, follow, 60, true);
    expect(await depthOf(late)).toBeNull();
    // Within the fanout, history and all: the new payee is followed as a first read's would be.
    await store.saveMoney(C, small, [flow(small, later)], false, follow, 60, true);
    expect(await depthOf(later)).toBe(1);
  });

  it('a re-read unmarks the wallet\'s reach rows as stepped only when it stored a new flow and read a flow out of the wallet', async () => {
    const t = w('34i1'), o = w('34i2'), in1 = w('34i3'), in2 = w('34i5');
    await store.ingest(id, C, chain('1', t, o), 10, [t, o]);
    const old = flow(t, o, { blockNumber: 30 });
    await store.saveMoney(C, t, [old], false, undefined, 30);
    await store.saveMoney(C, o, [], false);
    await store.pool.query('INSERT INTO washtrace.reach (collection_id, chain_id, address, depth, stepped) VALUES ($1, $2, $3, 0, true), ($1, $2, $4, 0, true)', [id, C, t, o]);
    const stepped = async () => Object.fromEntries((await store.pool.query(
      'SELECT address, stepped FROM washtrace.reach WHERE collection_id = $1 ORDER BY address', [id])).rows.map((r) => [r.address, r.stepped]));
    // Money in only: nothing out of it to walk from.
    await store.saveMoney(C, t, [flow(in1, t, { blockNumber: 40 })], false, undefined, 40, true);
    expect(await stepped()).toEqual({ [t]: true, [o]: true });
    // Money in, and the overlap's flow out again: something new, and the read went out, so the walk steps from it again.
    await store.saveMoney(C, t, [old, flow(in2, t, { blockNumber: 50 })], false, undefined, 50, true);
    expect(await stepped()).toEqual({ [t]: false, [o]: true });
  });

  describe('a re-read and its collections\' versions', () => {
    const t = w('34m1'), m = w('34m2'), n = w('34m3'), far = w('34m9');
    let other: number;
    const versions = async () => (await store.pool.query(
      'SELECT id, version FROM washtrace.collections WHERE id = ANY($1) ORDER BY id', [[id, other]])).rows.map((r) => [r.id, Number(r.version)]);
    const stepped = async () => (await store.pool.query(
      'SELECT collection_id, stepped FROM washtrace.reach WHERE chain_id = $1 AND address = $2 ORDER BY collection_id', [C, t])).rows.map((r) => [r.collection_id, r.stepped]);
    const old = flow(t, m, { blockNumber: 100 }), back = flow(n, t, { blockNumber: 90 });

    beforeEach(async () => {
      // id names t in its transfers; other holds it in its reach past the global limit. Both are bumped by a read that adds flows.
      other = (await store.addCollection(C, far, 'Reread far', 1)).id;
      await store.ingest(id, C, chain('1', t), 10, [t]);
      await store.saveMoney(C, t, [old, back], false, undefined, 100);
      await store.pool.query('INSERT INTO washtrace.reach (collection_id, chain_id, address, depth, stepped) VALUES ($1, $3, $4, 0, true), ($2, $3, $4, 1, true)', [id, other, C, t]);
      await store.pool.query(`UPDATE washtrace.wallets SET fetched_at = now() - interval '8 days' WHERE chain_id = $1 AND address = $2`, [C, t]);
      await store.ingest(id, C, chain('2', t), 20, [t], 7);
      expect((await row(t)).stale).toBe(true);
    });

    afterEach(async () => {
      await drop(C, far);
    });

    it('one whose flows are all stored already bumps no collection and leaves its reach rows stepped, but clears the mark and raises the block', async () => {
      const before = await versions();
      // The overlap gives back what the last read stored, and a later block it read past (a row the read filtered out).
      await store.saveMoney(C, t, [old, back], false, undefined, 130, true);
      expect(await versions()).toEqual(before);
      expect(await stepped()).toEqual([[id, true], [other, true]]);
      expect(await row(t)).toMatchObject({ status: 'done', stale: false, read_block: '130', error: null });
    });

    it('one with a new flow out of the wallet unmarks its reach rows as stepped and bumps its collections', async () => {
      const before = await versions();
      await store.saveMoney(C, t, [old, flow(t, w('34m4'), { blockNumber: 140 })], false, undefined, 140, true);
      expect(await versions()).toEqual(before.map(([c, v]) => [c, v + 1]));
      expect(await stepped()).toEqual([[id, false], [other, false]]);
      expect(await row(t)).toMatchObject({ status: 'done', stale: false, read_block: '140', error: null });
    });
  });

  it('a failed re-read keeps the old read: still done, its flows and fetched_at kept, the error noted, tried again in an hour', async () => {
    const t = w('34j1'), m = w('34j2'), first = w('34j3');
    // The cursor past the fixtures' blocks, so the analysis reads these traders.
    await store.ingest(id, C, chain('1', t, first), 1_000_000, [t, first]);
    await store.saveMoney(C, t, [flow(t, m, { blockNumber: 70 })], false, undefined, 70);
    await store.pool.query(`UPDATE washtrace.wallets SET fetched_at = now() - interval '8 days' WHERE chain_id = $1 AND address = $2`, [C, t]);
    await store.ingest(id, C, chain('2', t), 1_000_001, [t], 7);
    const before = await row(t);
    await store.moneyFailed(C, t, 'timeout');
    const after = await row(t);
    expect(after).toMatchObject({ status: 'done', truncated: false, fetched: before.fetched, read_block: '70', error: 'timeout', stale: true });
    expect(after.staleIn!).toBeGreaterThan(3590);
    expect(after.staleIn!).toBeLessThanOrEqual(3600);
    expect(await flowsOf(t)).toBe(1);
    expect((await store.analysisInput(id, C, 2)).funded.has(t)).toBe(true);
    // A first read fails as ever.
    await store.moneyFailed(C, first, 'timeout');
    expect(await row(first)).toMatchObject({ status: 'failed', error: 'timeout', stale: false });
  });

  it('only a marked re-read keeps done when it fails: a done wallet with no mark fails as a first read does', async () => {
    const trail = w('34l1'), marked = w('34l2');
    await store.ingest(id, C, chain('1', trail, marked), 10, [trail, marked]);
    // As a trail loaded while its first read ran leaves it: done, never read here.
    await store.pool.query(`UPDATE washtrace.wallets SET status = 'done', fetched_at = NULL WHERE chain_id = $1 AND address = $2`, [C, trail]);
    await readAgo(marked, 8);
    await store.ingest(id, C, chain('2', marked), 20, [marked], 7);
    await store.moneyFailed(C, trail, 'timeout');
    await store.moneyFailed(C, marked, 'timeout');
    const failed = await row(trail);
    expect(failed).toMatchObject({ status: 'failed', error: 'timeout', stale: false });
    const ago = Number((await store.pool.query('SELECT extract(epoch FROM now() - fetched_at)::float8 AS s FROM washtrace.wallets WHERE chain_id = $1 AND address = $2', [C, trail])).rows[0].s);
    expect(ago).toBeLessThan(60);
    expect(await row(marked)).toMatchObject({ status: 'done', error: 'timeout', stale: true });
  });

  it('moneyBacklog counts the stale wallets a lane serves apart, and pending, failed and stranded as before', async () => {
    const backlog = async () => (await store.moneyBacklog(2)).find((r) => r.chainId === C)!;
    const s1 = w('34k1'), s2 = w('34k2'), p = w('34k3');
    await store.ingest(id, C, chain('1', s1, s2, p), 10, [s1, s2, p]);
    await readAgo(s1, 8);
    await readAgo(s2, 8);
    expect(await backlog()).toMatchObject({ pending: 1, failed: 0, stranded: 0, stale: 0, done: 2 });
    await store.ingest(id, C, chain('2', s1, s2), 20, [s1, s2], 7);
    expect(await backlog()).toMatchObject({ pending: 1, failed: 0, stranded: 0, stale: 2, done: 2 });
    // Held back with the paused collection, as a pending one is: counted in neither.
    await store.pause(C, coll);
    expect(await backlog()).toMatchObject({ pending: 0, failed: 0, stranded: 1, stale: 0, done: 2 });
  });
});

describe('Store', () => {
  // Funding ran in this block's analysis, so every lens did.
  const RAN = { money: new Set(['']), ran: ['A', 'AU', 'AC'] as Method[], zone: 'UTC' };
  const LIST = { sort: 'caught' as const, find: null, limit: 50, offset: 0 };

  it('migrates, and migrating again changes nothing', async () => {
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    expect(await store.schemaVersion()).toBe(MIGRATIONS.length);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    expect(await store.migrate()).toBe(MIGRATIONS.length);
    const { rows } = await store.pool.query('SELECT version FROM washtrace.schema_version');
    expect(rows).toEqual([{ version: MIGRATIONS.length }]);
  });

  it('drops "Reading from the chain instead" from notes written before the console said what follows', async () => {
    const id = (await store.addCollection(1, w('1ec1'), 'Noted', 1)).id;
    await store.pool.query("UPDATE washtrace.collections SET restore_note = 'Stored data could not be loaded: its file is missing. Reading from the chain instead.' WHERE id = $1", [id]);
    try {
      await store.pool.query('DELETE FROM washtrace.schema_version');
      await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES (13)');
      expect(await store.migrate()).toBe(MIGRATIONS.length);
      expect(await store.collection(1, w('1ec1'))).toMatchObject({ restoreNote: 'Stored data could not be loaded: its file is missing.', restoreNoteKey: null, restoreRetryAt: null });
    } finally {
      await drop(1, w('1ec1'));
    }
  });

  it('drops console settings that .env was shadowing when upgrading, and keeps the rest', async () => {
    await store.migrate(); // a no-op in a full run; lets this test run by itself
    await store.pool.query("INSERT INTO washtrace.settings (key, value) VALUES ('follow.hops', '7'), ('etherscan.rps', '2') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    await store.pool.query("INSERT INTO washtrace.setting_sources (key, source, value, reported_at) VALUES ('follow.hops', 'env', '3', now()), ('etherscan.rps', 'console', '2', now()) ON CONFLICT (key) DO UPDATE SET source = EXCLUDED.source");
    try {
      await store.pool.query('DELETE FROM washtrace.schema_version');
      await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES (17)');
      expect(await store.migrate()).toBe(MIGRATIONS.length);
      const { rows } = await store.pool.query("SELECT key, value FROM washtrace.settings WHERE key IN ('follow.hops', 'etherscan.rps') ORDER BY key");
      expect(rows).toEqual([{ key: 'etherscan.rps', value: '2' }]);
    } finally {
      await store.pool.query("DELETE FROM washtrace.settings WHERE key IN ('follow.hops', 'etherscan.rps')");
      await store.pool.query("DELETE FROM washtrace.setting_sources WHERE key IN ('follow.hops', 'etherscan.rps')");
    }
  });

  it('clears errors written before they were scrubbed, which may hold an RPC URL, and keeps the rest', async () => {
    const leaky = (await store.addCollection(1, w('1ea1'), 'Leaky', 1)).id;
    const plain = (await store.addCollection(1, w('1ea2'), 'Plain', 1)).id;
    await store.setError(leaky, 'HTTP request failed. URL: https://eth.example/v2/KEY0123456789');
    await store.setError(plain, 'No RPC is configured for chain 1.');
    await store.pool.query(`INSERT INTO washtrace.wallets (chain_id, address, status, error) VALUES (1, $1, 'failed', 'fetch failed: HTTPS://api.example/?apikey=K0123456789'), (1, $2, 'failed', 'Etherscan answered HTTP 502')`, [w('1eb1'), w('1eb2')]);
    try {
      // Run the newest migration again, as an install upgrading to it would.
      await store.pool.query('DELETE FROM washtrace.schema_version');
      await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES (12)');
      expect(await store.migrate()).toBe(MIGRATIONS.length);
      expect((await store.collection(1, w('1ea1')))!.error).toBeNull();
      expect((await store.collection(1, w('1ea2')))!.error).toBe('No RPC is configured for chain 1.');
      const { rows } = await store.pool.query('SELECT address, error FROM washtrace.wallets WHERE address = ANY($1) ORDER BY address', [[w('1eb1'), w('1eb2')]]);
      expect(rows).toEqual([{ address: w('1eb1'), error: null }, { address: w('1eb2'), error: 'Etherscan answered HTTP 502' }]);
    } finally {
      await drop(1, w('1ea1'));
      await drop(1, w('1ea2'));
      await store.pool.query('DELETE FROM washtrace.wallets WHERE address = ANY($1)', [[w('1eb1'), w('1eb2')]]);
    }
  });

  it('removeCollection deletes nothing that is not paused', async () => {
    await store.addCollection(1, w('d0e'), null, null);
    expect(await store.removeCollection(1, w('d0e'))).toBe(false);
    expect(await store.collection(1, w('d0e'))).not.toBeNull();
    await store.pause(1, w('d0e'));
    expect(await store.removeCollection(1, w('d0e'))).toBe(true);
    expect(await store.collection(1, w('d0e'))).toBeNull();
  });

  it('adds a collection once, and lists it before any analysis', async () => {
    expect((await store.addCollection(1, collection, 'Test', 100)).created).toBe(true);
    expect((await store.addCollection(1, collection, null, null)).created).toBe(false);
    const c = await store.collection(1, collection);
    expect(c).toMatchObject({ name: 'Test', startBlock: 100, cursorBlock: 99, transfers: 0, latest: null, stale: true });
  });

  it('takes a start block found later, once', async () => {
    const { id } = await store.addCollection(1, w('1a7e'), null, null);
    expect(await store.collection(1, w('1a7e'))).toMatchObject({ startBlock: null, cursorBlock: null });
    await store.setStart(id, 500);
    await store.setStart(id, 900);
    expect(await store.collection(1, w('1a7e'))).toMatchObject({ startBlock: 500, cursorBlock: 499 });
    await drop(1, w('1a7e'));
  });

  it('stores a span and moves the cursor with it, queueing its wallets busiest first', async () => {
    const c = (await store.collection(1, collection))!;
    const ts = chain('1', a, b, a, b).map((t, i) => ({ ...t, blockTime: 1_700_000_000 + i, marketplace: i > 0 ? 'seaport-1.6' : null, priceWei: i > 0 ? '1000000000000000000' : null, currency: i > 0 ? '' : null }));
    await store.ingest(c.id, 1, ts, 200, [a, b, a, b, a, b, x]);
    // Read twice: a replayed span is a no-op, not a duplicate.
    await store.ingest(c.id, 1, ts, 200, []);
    const after = (await store.collection(1, collection))!;
    expect(after).toMatchObject({ cursorBlock: 200, transfers: 4 });
    expect(await store.moneyLanes(1, 10, 3)).toEqual({ lanes: [{ collectionId: c.id, wallets: [a, b] }] });
  });

  it('gives each collection its own lane of unchecked traders, a shared one in both', async () => {
    const other = (await store.addCollection(1, w('0be'), 'Other', 1)).id;
    const c = (await store.collection(1, collection))!;
    await store.ingest(other, 1, chain('2', b, w('o1')), 10, [b, w('o1')]);
    const { lanes } = await store.moneyLanes(1, 10, 3);
    expect(lanes).toEqual([{ collectionId: c.id, wallets: [b, a] }, { collectionId: other, wallets: [b, w('o1')] }]);
    expect((await store.moneyLanes(1, 1, 3)).lanes.map((l) => l.wallets.length)).toEqual([1, 1]);
    await drop(1, w('0be'));
  });

  it('leaves followed wallets further out than the hops followed unchecked, and counts them held back', async () => {
    const chainId = 22, t = w('22a1'), m1 = w('22a2'), m2 = w('22a3');
    const id = (await store.addCollection(chainId, w('22c1'), 'Hops', 1)).id;
    const row = async (hops: number) => (await store.moneyBacklog(hops)).find((r) => r.chainId === chainId)!;
    try {
      await store.ingest(id, chainId, chain('25', t), 10, [t]);
      // Queued while following went two hops out; then the setting came down.
      await store.pool.query('INSERT INTO washtrace.wallets (chain_id, address, depth) VALUES ($1, $2, 1), ($1, $3, 2)', [chainId, m1, m2]);
      expect((await store.moneyLanes(chainId, 10, 2)).lanes.at(-1)).toEqual({ collectionId: null, wallets: [m1, m2] });
      expect((await store.moneyLanes(chainId, 10, 1)).lanes.at(-1)).toEqual({ collectionId: null, wallets: [m1] });
      // 0 reads traders only.
      expect((await store.moneyLanes(chainId, 10, 0)).lanes).toEqual([{ collectionId: id, wallets: [t] }]);
      expect(await row(2)).toMatchObject({ pending: 3, stranded: 0 });
      expect(await row(1)).toMatchObject({ pending: 2, stranded: 1 });
      expect(await row(0)).toMatchObject({ pending: 1, stranded: 2 });
    } finally {
      await drop(chainId, w('22c1'));
      await store.pool.query('DELETE FROM washtrace.wallets WHERE chain_id = $1', [chainId]);
    }
  });

  it('probes a collection\'s transfers for its traders only, never for followed wallets', async () => {
    const t = w('8f1'), m = w('8f2');
    const id = (await store.addCollection(7, w('8c0'), 'Probe', 1)).id;
    await store.ingest(id, 7, chain('31', t, m), 10, [t, m]);
    // Named in its transfers yet followed (depth > 0), as no ingest leaves a trader: in the followed lane alone.
    await store.pool.query('UPDATE washtrace.wallets SET depth = 1 WHERE chain_id = 7 AND address = $1', [m]);
    try {
      expect((await store.moneyLanes(7, 10, 3)).lanes).toEqual([{ collectionId: id, wallets: [t] }, { collectionId: null, wallets: [m] }]);
    } finally {
      await drop(7, w('8c0'));
      // Wallets outlive a collection's data: these would turn up in the other tests on chain 7.
      await store.pool.query('DELETE FROM washtrace.wallets WHERE chain_id = 7 AND address = ANY($1)', [[t, m]]);
    }
  });

  it('pausing stops a collection\'s lane but not a wallet another collection shares', async () => {
    const s = w('5ba'), p1 = w('9a1'), p2 = w('9a2');
    const c1 = (await store.addCollection(1, w('9c1'), 'P1', 1)).id;
    const c2 = (await store.addCollection(1, w('9c2'), 'P2', 1)).id;
    await store.ingest(c1, 1, chain('11', p1, s), 10, [p1, s]);
    await store.ingest(c2, 1, chain('12', p2, s), 10, [p2, s]);
    expect(await store.pause(1, w('9c1'))).toBe(true);
    expect(await store.pause(1, w('9c1'))).toBe(false);
    expect((await store.collection(1, w('9c1')))!.pausedAt).not.toBeNull();
    const { lanes } = await store.moneyLanes(1, 10, 3);
    expect(lanes.map((l) => l.collectionId)).not.toContain(c1);
    expect(lanes.find((l) => l.collectionId === c2)!.wallets).toContain(s);
    expect((await store.stale()).map((r) => r.id)).not.toContain(c1);
    // With nothing in sync on the chain there are no lanes, the followed one included.
    await store.pool.query('UPDATE washtrace.collections SET paused_at = now()');
    expect((await store.moneyLanes(1, 10, 3)).lanes).toEqual([]);
    expect(await store.resume(1, w('9c2'))).toBe(true);
    expect(await store.resume(1, w('9c2'))).toBe(false);
    await store.pool.query('UPDATE washtrace.collections SET paused_at = NULL');
    expect((await store.collection(1, w('9c2')))!.pausedAt).toBeNull();
    await drop(1, w('9c1'));
    await drop(1, w('9c2'));
  });

  describe('a paused collection that a delete holds locked', () => {
    const chainId = 41;
    const version = async (id: number) => Number((await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id])).rows[0].version);

    /** Pauses a collection that traded `trader`, then holds its row FOR UPDATE on a second connection, as a delete's cascade does, and runs `body`. */
    async function whileLocked(n: string, body: (id: number, trader: string) => Promise<void>): Promise<void> {
      const addr = w(`41${n}`), trader = w(`41${n}a`), other = w(`41${n}b`);
      const id = (await store.addCollection(chainId, addr, 'Deleting', 1)).id;
      const holder = new pgClient.Client({ connectionString: pg.getConnectionUri() });
      await holder.connect();
      try {
        await store.ingest(id, chainId, chain(n === 'a' ? '411' : '412', trader, other), 10, [trader, other]);
        await store.startTokens(id);
        await store.pause(chainId, addr);
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM washtrace.collections WHERE id = $1 FOR UPDATE', [id]);
        await body(id, trader);
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        await holder.end();
        await drop(chainId, addr);
      }
    }

    /** Fails after 2 s instead of hanging if `run` is waiting on the lock; the holder's rollback in whileLocked then frees the stuck query. */
    async function within2s(run: () => Promise<void>): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('still waiting on the delete\'s lock after 2 s')), 2000); });
      try { await Promise.race([run(), late]); } finally { clearTimeout(timer); }
    }

    it('saveMoney for a wallet that traded it does not wait for the delete', async () => {
      await whileLocked('a', async (id, trader) => {
        const before = await version(id);
        await within2s(() => store.saveMoney(chainId, trader, [flow(trader, w('41aff'))], false));
        // A paused collection is not analyzed, so its version is left alone.
        expect(await version(id)).toBe(before);
      });
    });

    it('countTokens does not wait for the delete either', async () => {
      await whileLocked('b', async () => {
        await within2s(() => store.countTokens(chainId, 3, false, Date.now() + TOKEN_COUNT_MS));
      });
    });
  });

  it('resume moves the version, so the collection is analyzed again, and countTokens counts it on its next pass', async () => {
    const chainId = 42, addr = w('42c');
    const id = (await store.addCollection(chainId, addr, 'Back', 1)).id;
    try {
      await store.ingest(id, chainId, chain('42', w('42a'), w('42b')), 10, [w('42a'), w('42b')]);
      await store.startTokens(id);
      await store.pause(chainId, addr);
      const paused = Number((await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id])).rows[0].version);
      await store.countTokens(chainId, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect((await store.pool.query('SELECT token_counts FROM washtrace.collections WHERE id = $1', [id])).rows[0].token_counts).toBeNull();
      await store.resume(chainId, addr);
      expect(Number((await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id])).rows[0].version)).toBeGreaterThan(paused);
      expect((await store.stale()).map((r) => r.id)).toContain(id);
      await store.countTokens(chainId, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect((await store.pool.query('SELECT token_counts FROM washtrace.collections WHERE id = $1', [id])).rows[0].token_counts).not.toBeNull();
    } finally {
      await drop(chainId, addr);
    }
  });

  it('watching a paused collection again moves the version too, so it is analyzed again; watching a live one again does not', async () => {
    const chainId = 43, addr = w('43c');
    const id = (await store.addCollection(chainId, addr, 'Again', 1)).id;
    const version = async () => Number((await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id])).rows[0].version);
    try {
      const live = await version();
      await store.addCollection(chainId, addr, null, 1);
      expect(await version()).toBe(live);
      await store.pause(chainId, addr);
      const paused = await version();
      await store.addCollection(chainId, addr, null, 1);
      expect(await version()).toBeGreaterThan(paused);
    } finally {
      await drop(chainId, addr);
    }
  });

  it('counts as waiting only the wallets a lane serves, and the ones a paused collection holds back apart', async () => {
    const chainId = 21, live = w('21c1'), held = w('21c2');
    const l = w('21a1'), lf = w('21a2'), p = w('21a3'), pf = w('21a4'), m = w('21a5'), sh = w('21a6');
    const c1 = (await store.addCollection(chainId, live, 'Live', 1)).id;
    const c2 = (await store.addCollection(chainId, held, 'Held', 1)).id;
    const row = async () => (await store.moneyBacklog(3)).find((r) => r.chainId === chainId)!;
    try {
      await store.ingest(c1, chainId, chain('21', l, lf), 10, [l, lf]);
      await store.ingest(c2, chainId, chain('22', p, pf), 10, [p, pf]);
      // Traded in both: sent in the paused one, received in the live one, so a probe can meet the paused one's transfer first.
      await store.ingest(c2, chainId, chain('23', sh, p), 20, [sh, p]);
      await store.ingest(c1, chainId, chain('24', sh), 20, [sh]);
      await store.moneyFailed(chainId, lf, 'timeout');
      await store.moneyFailed(chainId, pf, 'timeout');
      await store.pool.query('INSERT INTO washtrace.wallets (chain_id, address, depth) VALUES ($1, $2, 1)', [chainId, m]);
      await store.pause(chainId, held);
      // The live collection's traders and failed wallet, and the followed one while something on the chain is in sync.
      expect(await row()).toMatchObject({ pending: 3, failed: 1, stranded: 2 });
      await store.pause(chainId, live);
      expect(await row()).toMatchObject({ pending: 0, failed: 0, stranded: 6 });
      // Removed, its traders are named by no collection: still held back.
      await store.removeCollection(chainId, held);
      await store.resume(chainId, live);
      expect(await row()).toMatchObject({ pending: 3, failed: 1, stranded: 2 });
    } finally {
      await drop(chainId, live);
      await drop(chainId, held);
      await store.pool.query('DELETE FROM washtrace.wallets WHERE chain_id = $1', [chainId]);
    }
  });

  it('watching a paused collection again resumes it, data intact', async () => {
    const id = (await store.addCollection(1, w('9c3'), 'P3', 1)).id;
    await store.ingest(id, 1, chain('13', w('9a3'), w('9a4')), 10, []);
    await store.pause(1, w('9c3'));
    const again = await store.addCollection(1, w('9c3'), null, 1);
    expect(again).toEqual({ id, created: false });
    expect(await store.collection(1, w('9c3'))).toMatchObject({ pausedAt: null, transfers: 2 });
    await drop(1, w('9c3'));
  });

  it('profiles a collection from its transfers: the latest receiver holds the token', async () => {
    const c = (await store.collection(1, collection))!;
    expect(await store.profile(c.id)).toEqual({
      supply: 1, holders: 1,
      firstMint: 1_700_000_000_000, firstSale: 1_700_000_001_000, lastSale: 1_700_000_003_000,
      marketplaces: [{ name: 'seaport-1.6', sales: 3 }],
    });
  });

  it('keeps what the contract says of itself, its own name filling a missing one', async () => {
    const { id } = await store.addCollection(1, w('de5c'), null, 1);
    expect((await store.collection(1, w('de5c')))!.contract).toBeNull();
    await store.describe(id, { name: 'Terraforms', symbol: 'TERRAFORMS', creator: a, creationTx: '0xtx' });
    expect(await store.collection(1, w('de5c'))).toMatchObject({
      name: 'Terraforms', contract: { name: 'Terraforms', symbol: 'TERRAFORMS', creator: a, creationTx: '0xtx' },
    });
    await drop(1, w('de5c'));
  });

  it('reads analysis one flow per pair, the smallest hash, leaving out payments inside the collection\'s own sales', async () => {
    const d1 = w('d1'), d2 = w('d2'), d3 = w('d3');
    const { id } = await store.addCollection(1, w('dedu'), null, 1);
    const ts = chain('5', d1, d2);
    await store.ingest(id, 1, ts, 1_000_000, []);
    const saleTx = ts[1]!.txHash;
    await store.saveMoney(1, d1, [
      flow(d1, d3, { blockNumber: 900, txHash: '0xdedu1' }), flow(d1, d3, { blockNumber: 800, txHash: '0xdedu2' }),
      flow(d1, d2, { txHash: saleTx }), flow(d1, d1), flow(d3, d1, { valueWei: '0' }),
    ], false);
    const { payments } = await store.analysisInput(id, 1, 3);
    // Of the two d1 -> d3, the graph keeps the smaller hash, whatever their blocks.
    expect(payments.size).toBe(1);
    expect([payments.names[payments.ends[0]!], payments.names[payments.ends[1]!], payments.tx(0)]).toEqual([d1, d3, '0xdedu1']);
    await drop(1, w('dedu'));
  });

  it('analysisInput reads payments in batches, no matter how many', async () => {
    const d1 = w('b1'), d2 = w('b2');
    const { id } = await store.addCollection(1, w('batch'), null, 1);
    await store.ingest(id, 1, chain('6', d1, d2), 1_000_000, []);
    await store.saveMoney(1, d1, [1, 2, 3, 4, 5, 6, 7].map((i) => flow(d1, w(`b1p${i}`), { txHash: `0xbatch${i}` })), false);
    const request = { storeUrl: '', id, chainId: 1, followHops: 3, rules: {}, fundingAvailable: true, custodians: new Set<string>(), contracts: new Set<string>(), money: new Set(['']) };
    const whole = await analyzeStored(store, request);
    const edges = (p: Payments) => Array.from({ length: p.size }, (_, i) => [p.names[p.ends[2 * i]!], p.names[p.ends[2 * i + 1]!], p.tx(i)]);
    const one = edges((await store.analysisInput(id, 1, 3)).payments);
    const was = store.paymentBatch;
    store.paymentBatch = 2;
    try {
      const batched = (await store.analysisInput(id, 1, 3)).payments;
      expect(batched.size).toBe(7);
      expect(edges(batched)).toEqual(one);
      expect(await analyzeStored(store, request)).toEqual(whole);
    } finally {
      store.paymentBatch = was;
    }
    await drop(1, w('batch'));
  });

  it('a cursor is planned to be read to the end', async () => {
    const rows: string[] = [];
    for await (const f of (store as any).stream(`SELECT current_setting('cursor_tuple_fraction') AS f`, [], (r: any) => r.f)) rows.push(f);
    expect(rows).toEqual(['1']);
  });

  it('analysisInput releases its client and rolls back when a read fails mid-cursor', async () => {
    const d1 = w('r1'), d2 = w('r2');
    const { id } = await store.addCollection(1, w('rollb'), null, 1);
    await store.ingest(id, 1, chain('7', d1, d2), 1_000_000, []);
    await store.saveMoney(1, d1, [1, 2, 3, 4, 5].map((i) => flow(d1, w(`r1p${i}`), { txHash: `0xrollb${i}` })), false);
    const out = () => store.pool.totalCount - store.pool.idleCount;
    const before = out();
    const connect = store.pool.connect.bind(store.pool) as () => Promise<pgClient.PoolClient>;
    const rolledBack: string[] = [];
    (store.pool as any).connect = async (...args: unknown[]) => {
      // pool.query asks for its client with a callback; only the cursor's client, asked for without, is rigged.
      if (args.length > 0) return (connect as any)(...args);
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      let fetches = 0;
      (client as any).query = (text: unknown, ...rest: unknown[]) => {
        if (typeof text === 'string' && text.startsWith('FETCH') && ++fetches === 2) return Promise.reject(new Error('connection lost'));
        if (text === 'ROLLBACK') rolledBack.push(text);
        return query(text, ...rest);
      };
      const release = client.release;
      client.release = (err?: Error | boolean) => {
        delete (client as any).query;
        client.release = release;
        return release(err);
      };
      return client;
    };
    const was = store.paymentBatch;
    store.paymentBatch = 2;
    try {
      await expect(store.analysisInput(id, 1, 3)).rejects.toThrow('connection lost');
    } finally {
      store.paymentBatch = was;
      delete (store.pool as any).connect;
    }
    expect(rolledBack).toEqual(['ROLLBACK']);
    expect(out()).toBe(before);
    await drop(1, w('rollb'));
  });

  it('stores funding and takes the wallet off the queue', async () => {
    await store.saveMoney(1, x, [flow(x, a), flow(x, b)], false);
    expect(await store.counterparties(1, x, 50, 0, 'flows')).toHaveLength(2);
  });

  it('counts the wallets finished in the last hour, for the funding wait', async () => {
    const lastHour = async () => (await store.moneyBacklog(3)).find((r) => r.chainId === 1)!.doneLastHour;
    const before = await lastHour();
    expect(before).toBeGreaterThan(0);
    await store.pool.query(`UPDATE washtrace.wallets SET fetched_at = now() - interval '2 hours' WHERE chain_id = 1 AND address = $1`, [x]);
    expect(await lastHour()).toBe(before - 1);
  });

  it('round-trips an analysis, its flags and its reads', async () => {
    const [stale] = await store.stale();
    const read = await store.analysisInput(stale!.id, 1, 3);
    expect(read.transfers).toHaveLength(4);
    expect(read.payments.size).toBe(2);
    // X funded both, but never traded here: it is a middle, not one of the collection's wallets.
    expect(read.funded).toEqual(new Set());
    const result = analyze({ ...input(read.transfers), payments: read.payments, funded: read.funded });
    await store.saveAnalysis(stale!.id, stale!.version, result, 5, read.through, new Set(['']));

    expect(await store.stale()).toEqual([]);
    const c = (await store.collection(1, collection))!;
    expect(c.latest?.totals.A).toMatchObject({ transfers: 3, flagged: 3, sales: 3 });
    // The mint is no trade: token 1's three sales are its counted trades, and all three are caught.
    expect((await store.lensTokens(c.id, 'A', LIST, RAN)).rows).toEqual([expect.objectContaining({ tokenId: '1', trades: 3, caught: 3 })]);
    expect((await store.lensWallets(c.id, 'A', LIST, RAN)).rows.map((r) => r.address).sort()).toEqual([a, b].sort());
    const token = await store.token(c.id, '1');
    expect(token.map((t) => Object.keys(t.flags).sort())).toEqual([[], ['A', 'AC', 'AU'], ['A', 'AC', 'AU'], ['A', 'AC', 'AU']]);
    expect(await store.transaction(1, token[1]!.txHash)).toEqual([expect.objectContaining({ collection: { chainId: 1, address: collection, name: 'Test' } })]);
    expect(await store.history(c.id)).toHaveLength(1);
  });

  it('saves the analysis\'s rings with it: its wallets, its counted sales, and the ring a wallet or token is in', async () => {
    const c = (await store.collection(1, collection))!;
    const anchor = [a, b].sort()[0]!;
    const { rows, total } = await store.rings(c.id, RAN, 10, 0);
    expect(total).toBe(1);
    expect(rows).toEqual([expect.objectContaining({ anchor, rank: 1, wallets: 2, sales: 3, floorSales: 3, tokens: 1, tokenSample: ['1'] })]);
    // Its pattern is what its witnesses are, one loop here; the pair it also holds is Linked wallets' and counted too.
    expect(rows[0]!.pattern).toEqual({ loops: expect.any(Number), pairs: expect.any(Number), middles: 0, shapes: expect.objectContaining({ funder: 0 }) });
    expect(rows[0]!.pattern.loops).toBe(1);
    expect((await store.pool.query('SELECT rings FROM washtrace.analyses WHERE collection_id = $1', [c.id])).rows[0].rings).toBe(1);
    const view = (await store.ring(c.id, anchor, RAN))!;
    const token = await store.token(c.id, '1');
    // Each member's side of its counted sales, as the line counts them: a sold #1 to b twice and bought it back once.
    expect(view.wallets).toEqual([
      { address: a, traded: true, sold: 2, bought: 1, volumeWei: '3000000000000000000' },
      { address: b, traded: true, sold: 1, bought: 2, volumeWei: '3000000000000000000' },
    ]);
    expect(view.tokens).toEqual([expect.objectContaining({ tokenId: '1', sales: 3, floor: true })]);
    expect(await store.ring(c.id, '0xnone', RAN)).toBeNull();
    expect(await store.ringsOf(c.id, { wallet: b })).toEqual([anchor]);
    expect(await store.ringsOf(c.id, { tokenId: '1' })).toEqual([anchor]);
    expect(await store.ringsOf(c.id, { tx: token[1]!.txHash })).toEqual([anchor]);
    expect(await store.ringLines(c.id, [anchor, '0xnone'], RAN)).toEqual([rows[0]]);
    // Past its last page a list still says how many there are.
    expect(await store.rings(c.id, RAN, 10, 5)).toEqual({ rows: [], total: 1 });
  });

  it('names the first three tokens of a ring, by number and not as text', async () => {
    const coll = w('70c');
    const { id } = await store.addCollection(1, coll, 'Tokens', 1);
    try {
      const p = w('70a'), q = w('70b');
      // Tokens 9, 10, 100 and 2 are each sold p to q; sorted as numbers they run 2, 9, 10, 100.
      const sales = ['9', '10', '100', '2'].map((t) => transfer(t, p, q, { marketplace: 'blur', priceWei: '1000', currency: '' }));
      await store.ingest(id, 1, sales, 100, [p, q]);
      const pair = { kind: 'pair' as const, pair: [p, q] as [string, string], middle: null, flowTx: '0xf' };
      const flags = sales.map((t) => ({ txHash: t.txHash, logIndex: t.logIndex, method: 'AC' as const, witness: pair }));
      const [stale] = (await store.stale()).filter((s) => s.id === id);
      const done = analyze(input(sales));
      await store.saveAnalysis(id, stale!.version, { ...done, flags }, 1, 1_000_000, new Set(['']));
      const line = (await store.rings(id, RAN, 10, 0)).rows[0]!;
      expect(line).toMatchObject({ tokens: 4, tokenSample: ['2', '9', '10'], pattern: { loops: 0, pairs: 1, middles: 0, shapes: { funder: 0, payee: 0, back: 0, forward: 0, 'direct-back': 0, 'direct-forward': 0, both: 0 } } });
      // Its members' sides, the most ETH first, and no token on a loop: Linked wallets alone flags them.
      const view = (await store.ring(id, line.anchor, RAN))!;
      expect(view.wallets).toEqual([{ address: p, traded: true, sold: 4, bought: 0, volumeWei: '4000' }, { address: q, traded: true, sold: 0, bought: 4, volumeWei: '4000' }]);
      expect(view.tokens.map((t) => t.floor)).toEqual([false, false, false, false]);
    } finally {
      await drop(1, coll);
    }
  });

  it('counts a ring\'s pattern: its loops, its pairs, those through a middle, and each pair\'s shape', async () => {
    const coll = w('71c');
    const { id } = await store.addCollection(1, coll, 'Pattern', 1);
    try {
      const p = w('71a'), q = w('71b'), m = w('71d');
      const sales = ['1', '2', '3'].map((t) => transfer(t, p, q, { marketplace: 'blur', priceWei: '1000', currency: '' }));
      await store.ingest(id, 1, sales, 100, [p, q]);
      const funder = { kind: 'pair' as const, pair: [p, q] as [string, string], middle: m, flowTx: '0xf', shape: 'funder' as const };
      const direct = { kind: 'pair' as const, pair: [p, q] as [string, string], middle: null, flowTx: '0xg', shape: 'direct-back' as const };
      // Saved before shapes were: through a middle, and no shape.
      const old = { kind: 'pair' as const, pair: [p, q] as [string, string], middle: m, flowTx: '0xh' };
      const flags = [funder, direct, old].map((witness, i) => ({ txHash: sales[i]!.txHash, logIndex: sales[i]!.logIndex, method: 'AC' as const, witness }));
      const [stale] = (await store.stale()).filter((s) => s.id === id);
      await store.saveAnalysis(id, stale!.version, { ...analyze(input(sales)), flags }, 1, 1_000_000, new Set(['']));
      const line = (await store.rings(id, RAN, 10, 0)).rows[0]!;
      expect(line.pattern).toEqual({ loops: 0, pairs: 3, middles: 2, shapes: { funder: 1, payee: 0, back: 0, forward: 0, 'direct-back': 1, 'direct-forward': 0, both: 0 } });
      expect((await store.ring(id, line.anchor, RAN))!.line.pattern).toEqual(line.pattern);
    } finally {
      await drop(1, coll);
    }
  });

  it('wallets reads the money state of many wallets in one query, and leaves out one with no row', async () => {
    const C = 3301;
    const [done, pending, failed, never] = [w('d01'), w('d02'), w('d03'), w('d04')];
    await store.addWallets(C, [done, pending, failed]);
    await store.saveMoney(C, done, [], true);
    await store.moneyFailed(C, failed, 'rate limited');
    const got = await store.wallets(C, [done, pending, failed, never]);
    expect([...got.keys()].sort()).toEqual([done, pending, failed].sort());
    expect(got.get(done)).toMatchObject({ status: 'done', truncated: true, error: null });
    expect(got.get(done)!.fetchedAt).toBeGreaterThan(0);
    expect(got.get(pending)).toMatchObject({ status: 'pending', fetchedAt: null });
    expect(got.get(failed)).toMatchObject({ status: 'failed', error: 'rate limited' });
    expect(await store.wallets(C + 1, [done])).toEqual(new Map());
    expect(await store.wallets(C, [])).toEqual(new Map());
  });

  it('gives a wallet its tier by its own counted flagged trades, and a scoped search hit carries it', async () => {
    const c = (await store.collection(1, collection))!;
    expect(await store.walletTiers(c.id, [a, b, x, w('nobody')])).toEqual(new Map([[a, 'cycle'], [b, 'cycle']]));
    const hit = async (address: string, scope = { id: c.id, chainId: 1 }) => (await store.search({ kind: 'address', address }, { scope })).wallets[0]!;
    expect(await hit(a)).toMatchObject({ address: a, here: true, tier: 'cycle' });
    expect(await hit(a)).not.toHaveProperty('ring');
    // Found by its address but never traded here: no mark of this collection's.
    expect(await hit(x)).toMatchObject({ here: false, tier: null });
    // A hit on another chain than the scope's inherits nothing.
    expect(await hit(a, { id: c.id, chainId: 10 })).toMatchObject({ tier: null });
    // Unscoped, a wallet is in every collection at once: it carries no tier.
    expect((await store.search({ kind: 'address', address: a })).wallets[0]).not.toHaveProperty('tier');
    const anchor = [a, b].sort()[0]!;
    expect(await store.walletRings(c.id, [a, x, w('nobody')])).toEqual(new Map([[a, [anchor]]]));
    expect(await store.walletRings(c.id, [])).toEqual(new Map());
  });

  it('gives a wallet that traded the tier of its own flagged trades only; a middle that traded none has none, one that never traded has the ceiling', async () => {
    const coll = w('70d');
    const { id } = await store.addCollection(1, coll, 'Ceiling', 1);
    try {
      const p = w('71a'), q = w('71b'), m = w('71c'), t = w('71d'), n = w('71e'), r = w('71f');
      const u = w('72a'), v = w('72b'), j = w('72c'), k = w('72e');
      const sale = transfer('1', p, q, { marketplace: 'blur', priceWei: '1000', currency: '' });
      const again = transfer('1', q, p, { marketplace: 'blur', priceWei: '1000', currency: '' });
      // m traded, but not in a flagged sale; n never did.
      const other = transfer('2', m, t, { marketplace: 'blur', priceWei: '1000', currency: '' });
      // u and v's one sale is flagged by Money loops back alone; j and k's by Linked wallets alone.
      const apart = transfer('3', u, v, { marketplace: 'blur', priceWei: '1000', currency: '' });
      const linked = transfer('4', j, k, { marketplace: 'blur', priceWei: '1000', currency: '' });
      const all = [sale, again, other, apart, linked];
      await store.ingest(id, 1, all, 100, [p, q, m, t, u, v, j, k]);
      const [stale] = (await store.stale()).filter((s) => s.id === id);
      const pair = (middle: string, of: [string, string] = [p, q]) => ({ kind: 'pair' as const, pair: of, middle, flowTx: '0xf' });
      const flags = [
        { txHash: sale.txHash, logIndex: sale.logIndex, method: 'AC' as const, witness: pair(m) },
        { txHash: again.txHash, logIndex: again.logIndex, method: 'AC' as const, witness: pair(n) },
        { txHash: again.txHash, logIndex: again.logIndex, method: 'A' as const, witness: { kind: 'scc' as const, wallets: [q, r], cycles: 1 } },
        { txHash: apart.txHash, logIndex: apart.logIndex, method: 'AU' as const, witness: { kind: 'scc+flow' as const, wallets: [u, v], cycles: 1, via: [[v, u]] as [string, string][] } },
        { txHash: linked.txHash, logIndex: linked.logIndex, method: 'AC' as const, witness: pair(n, [j, k]) },
      ];
      await store.saveAnalysis(id, stale!.version, { ...analyze(input(all)), flags }, 1, 1_000_000, new Set(['']));
      // p and q are in the trade Round trips flags; r and n never traded, and are in counted witnesses; m traded, and none of its own trades is flagged.
      // Money loops back never counts, so u and v have none; Linked wallets alone gives j and k the ceiling. The rule is kept twice (here, and lib/metrics toneOf).
      expect(await store.walletTiers(id, [p, q, m, t, n, r, u, v, j, k, w('72d')])).toEqual(new Map([[p, 'cycle'], [q, 'cycle'], [n, 'ceiling'], [r, 'ceiling'], [j, 'ceiling'], [k, 'ceiling']]));
      expect(await store.walletTiers(id, [])).toEqual(new Map());
      // A search in the collection finds the never-traded middle with the ceiling, as its ring and card say.
      await store.addWallets(1, [n]);
      expect((await store.search({ kind: 'address', address: n }, { scope: { id, chainId: 1 } })).wallets[0]).toMatchObject({ address: n, here: false, tier: 'ceiling' });
      // Across collections, the ones it is a middle of though it traded there nothing; a wallet that traded there is in none.
      expect(await store.middleIn(1, n)).toEqual([{ address: coll, name: 'Ceiling' }]);
      expect(await store.middleIn(1, p)).toEqual([]);
      expect(await store.middleIn(10, n)).toEqual([]);
    } finally {
      await drop(1, coll);
    }
  });

  it('finds the wallets that link a ring, traded or not, by prefix and by full address, scoped and unscoped', async () => {
    const coll = w('73d'), other = w('74d');
    const { id } = await store.addCollection(1, coll, 'Funders', 1);
    const second = (await store.addCollection(1, other, 'Others', 1)).id;
    try {
      const p = w('73a'), q = w('73b'), m = '0x73c1' + '0'.repeat(36), t = w('73e'), funder = '0x8318' + '0'.repeat(36);
      const sale = transfer('1', p, q, { marketplace: 'blur', priceWei: '1000', currency: '' });
      const again = transfer('1', q, p, { marketplace: 'blur', priceWei: '1000', currency: '' });
      const mine = transfer('2', m, t, { marketplace: 'blur', priceWei: '1000', currency: '' });
      const all = [sale, again, mine];
      await store.ingest(id, 1, all, 100, [p, q, m, t]);
      const [stale] = (await store.stale()).filter((s) => s.id === id);
      const pair = (middle: string) => ({ kind: 'pair' as const, pair: [p, q] as [string, string], middle, flowTx: '0xf' });
      // The funder never traded and has no wallets row; m is a middle that also traded here.
      const flags = [
        { txHash: sale.txHash, logIndex: sale.logIndex, method: 'AC' as const, witness: pair(funder) },
        { txHash: again.txHash, logIndex: again.logIndex, method: 'AC' as const, witness: pair(m) },
      ];
      await store.saveAnalysis(id, stale!.version, { ...analyze(input(all)), flags }, 1, 1_000_000, new Set(['']));
      expect((await store.wallets(1, [funder])).size).toBe(0);
      const scope = { id, chainId: 1 };
      const find = async (p: Parsed, opts = {}) => (await store.search(p, opts)).wallets;
      const prefix = funder.slice(0, 6);
      const funderAsks: Parsed[] = [{ kind: 'prefix', prefix }, { kind: 'address', address: funder }];
      for (const ask of funderAsks) {
        expect(await find(ask, { scope })).toEqual([{ chainId: 1, address: funder, transfers: 0, here: false, tier: 'ceiling' }]);
        expect(await find(ask)).toEqual([{ chainId: 1, address: funder, transfers: 0 }]);
        // Another collection of the chain does not hold it as a middle.
        expect(await find(ask, { scope: { id: second, chainId: 1 } })).toEqual(ask.kind === 'address' ? [{ chainId: 1, address: funder, transfers: 0, here: false, tier: null }] : []);
        // A scope on another chain gives it no tier.
        expect((await find(ask, { scope: { id, chainId: 10 } })).map((h) => h.tier)).not.toContain('ceiling');
      }
      // A middle that also traded is one hit, here.
      const mAsks: Parsed[] = [{ kind: 'prefix', prefix: m.slice(0, 6) }, { kind: 'address', address: m }];
      for (const ask of mAsks) {
        expect((await find(ask, { scope })).map((h) => [h.address, h.here])).toEqual([[m, true]]);
        expect((await find(ask)).map((h) => h.address)).toEqual([m]);
      }

      const pg = await store.pool.connect();
      try {
        await pg.query('BEGIN');
        // Enough witnesses that the planner costs the index; rolled back, so nothing reaches later tests.
        await pg.query(
          `INSERT INTO washtrace.witnesses (collection_id, id, kind, wallets, middle)
           SELECT $1, 1000 + g, 'pair', ARRAY[]::text[], '0x' || md5(g::text) FROM generate_series(1, 20000) g`,
          [id],
        );
        await pg.query('ANALYZE washtrace.witnesses');
        const plan = (await pg.query(
          `EXPLAIN SELECT middle FROM washtrace.witnesses WHERE collection_id = ${id} AND middle LIKE $1 || '%'`, ['0x8318'],
        )).rows.map((r) => r['QUERY PLAN']).join('\n');
        // A plain or a bitmap index scan, its condition on the line under it.
        expect(plan, plan).toMatch(/witnesses_middle_idx.*\n\s*Index Cond: \(\(middle ~>=~ /);
      } finally {
        await pg.query('ROLLBACK');
        pg.release();
      }
    } finally {
      await drop(1, coll);
      await drop(1, other);
    }
  });

  it('records a linked pair\'s shape, counts the lists by it, and names the pairs a wallet is the middle of', async () => {
    const coll = w('70e');
    const { id } = await store.addCollection(1, coll, 'Shapes', 1);
    try {
      const p = w('73a'), q = w('73b'), m = w('73c');
      const sales = ['6', '5'].map((t) => transfer(t, p, q, { marketplace: 'blur', priceWei: '1000', currency: '' }));
      await store.ingest(id, 1, sales, 100, [p, q]);
      const [stale] = (await store.stale()).filter((s) => s.id === id);
      // m funded both: each sale is a linked pair through it.
      const done = analyze(input(sales, [flow(m, p), flow(m, q)]));
      expect(done.flags.filter((f) => f.method === 'AC').map((f) => f.witness)).toEqual([0, 1].map(() => expect.objectContaining({ kind: 'pair', middle: m, shape: 'funder' })));
      await store.saveAnalysis(id, stale!.version, done, 1, 1_000_000, new Set(['']));
      expect((await store.pool.query('SELECT shape FROM washtrace.witnesses WHERE collection_id = $1', [id])).rows).toEqual([{ shape: 'funder' }, { shape: 'funder' }]);
      expect((await store.token(id, '5'))[0]!.flags.AC).toMatchObject({ kind: 'pair', middle: m, shape: 'funder' });
      expect((await store.lensTokens(id, 'AC', LIST, RAN)).rows.map((r) => [r.tokenId, r.pairs, r.middles, r.shapes]))
        .toEqual([['5', 1, 1, { ...NO_SHAPES, funder: 1 }], ['6', 1, 1, { ...NO_SHAPES, funder: 1 }]]);
      expect((await store.lensWallets(id, 'AC', LIST, RAN)).rows.map((r) => [r.address, r.pairs, r.shapes]))
        .toEqual([p, q].sort().map((x) => [x, 2, { ...NO_SHAPES, funder: 2 }]));
      const anchor = [p, q, m].sort()[0]!;
      const pairs = ['5', '6'].map((tokenId) => ({ tokenId, seller: p, buyer: q, ring: anchor, shape: 'funder' }));
      expect(await store.middleOf(id, m)).toEqual({ rows: pairs, tokens: 2 });
      // A seller's or buyer's partner here is the middle, with its pair's shape; the middle has none.
      expect(await store.middlesOf(id, p)).toEqual([{ middle: m, shape: 'funder' }]);
      expect(await store.middlesOf(id, q)).toEqual([{ middle: m, shape: 'funder' }]);
      expect(await store.middlesOf(id, m)).toEqual([]);
      // The seller and buyer are in the pairs, not their middle.
      expect(await store.middleOf(id, p)).toEqual({ rows: [], tokens: 0 });
      expect(await store.middleOf(id, w('nobody'))).toEqual({ rows: [], tokens: 0 });
    } finally {
      await drop(1, coll);
    }
  });

  it('keeps a Money loops back loop\'s paths in its flags, and the loop\'s wallets as its holders alone', async () => {
    const coll = w('7a0');
    const { id } = await store.addCollection(1, coll, 'Paths', 1);
    try {
      const seller = w('77a'), buyer = w('77b'), hop = w('77c');
      const sale = transfer('1', seller, buyer, { marketplace: 'blur', priceWei: '1000', currency: '' });
      await store.ingest(id, 1, [sale], 100, [seller, buyer]);
      const [stale] = (await store.stale()).filter((s) => s.id === id);
      const steps = [flow(buyer, hop), flow(hop, seller)];
      await store.saveAnalysis(id, stale!.version, analyze(input([sale], steps)), 1, 1_000_000, new Set(['']));
      expect((await store.token(id, '1'))[0]!.flags.AU).toEqual({
        kind: 'scc+flow', wallets: expect.arrayContaining([seller, buyer]), cycles: 1, via: [[buyer, seller]],
        paths: [{ wallets: [buyer, hop, seller], txs: steps.map((f) => f.txHash) }],
      });
      const { rows } = await store.pool.query(`SELECT wallets FROM washtrace.witnesses WHERE collection_id = $1 AND kind = 'scc+flow'`, [id]);
      expect(rows.map((r) => r.wallets)).toEqual([expect.not.arrayContaining([hop])]);
    } finally {
      await drop(1, coll);
    }
  });

  it('reads the flags of a page of trades in one query, keyed by transaction and log, and gives a trade nothing flagged no entry', async () => {
    const coll = w('70f');
    const { id } = await store.addCollection(1, coll, 'Page flags', 1);
    try {
      const p = w('76a'), q = w('76b'), m = w('76c');
      // Tokens 5, 6 and 7 are flagged; 7 shares token 5's transaction at another log index.
      const sales = ['6', '5'].map((t) => transfer(t, p, q, { marketplace: 'blur', priceWei: '1000', currency: '' }));
      const twin = { ...sales[1]!, logIndex: sales[1]!.logIndex + 1, tokenId: '7' };
      await store.ingest(id, 1, [...sales, twin], 100, [p, q]);
      const [stale] = (await store.stale()).filter((s) => s.id === id);
      await store.saveAnalysis(id, stale!.version, analyze(input([...sales, twin], [flow(m, p), flow(m, q)])), 1, 1_000_000, new Set(['']));
      const key = (t: { txHash: string; logIndex: number }) => `${t.txHash}:${t.logIndex}`;
      // A witness stored before shapes were recorded has none.
      await store.pool.query(`UPDATE washtrace.flags SET witness = witness - 'shape' WHERE collection_id = $1 AND tx_hash = $2 AND log_index = $3`, [id, sales[0]!.txHash, sales[0]!.logIndex]);
      const spy = vi.spyOn(store.pool, 'query');
      // Token 6 is not asked for: it must not leak in. The twin shares token 5's hash, so only log_index tells them apart.
      const flags = await store.tradeFlags(id, [sales[1]!, { txHash: '0xnone', logIndex: 9 }]);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      expect([...flags.keys()]).toEqual([key(sales[1]!)]);
      expect(flags.get(key(sales[1]!))!.AC).toMatchObject({ kind: 'pair', middle: m, shape: 'funder' });
      const both = await store.tradeFlags(id, [twin, sales[0]!]);
      expect([...both.keys()].sort()).toEqual([key(twin), key(sales[0]!)].sort());
      const old = both.get(key(sales[0]!))!.AC!;
      expect(old).toMatchObject({ kind: 'pair', middle: m });
      expect('shape' in old && old.shape).toBeFalsy();
      expect(await store.tradeFlags(id, [])).toEqual(new Map());
    } finally {
      await drop(1, coll);
    }
  });

  it('lists at most 20 of the tokens a wallet is the middle of, in numeric order, and counts them all', async () => {
    const coll = w('70d');
    const { id } = await store.addCollection(1, coll, 'Many pairs', 1);
    try {
      const p = w('75a'), q = w('75b'), m = w('75c');
      // 22 tokens, one numbered 100: by text it would sort before 2.
      const ids = [...Array.from({ length: 21 }, (_, i) => String(i + 1)), '100'];
      const sales = ids.map((t) => transfer(t, p, q, { marketplace: 'blur', priceWei: '1000', currency: '' }));
      await store.ingest(id, 1, sales, 100, [p, q]);
      const [stale] = (await store.stale()).filter((s) => s.id === id);
      await store.saveAnalysis(id, stale!.version, analyze(input(sales, [flow(m, p), flow(m, q)])), 1, 1_000_000, new Set(['']));
      const { rows, tokens } = await store.middleOf(id, m);
      expect(tokens).toBe(22);
      expect(rows.map((r) => r.tokenId)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    } finally {
      await drop(1, coll);
    }
  });

  it('reads a pair witness saved before #38 with no shape, counts it in no shape, and fills it at the next analysis', async () => {
    const coll = w('70f');
    const { id } = await store.addCollection(1, coll, 'Before shapes', 1);
    try {
      const p = w('74a'), q = w('74b'), m = w('74c');
      const sale = transfer('5', p, q, { marketplace: 'blur', priceWei: '1000', currency: '' });
      await store.ingest(id, 1, [sale], 100, [p, q]);
      const [stale] = (await store.stale()).filter((s) => s.id === id);
      const done = analyze(input([sale], [flow(m, p), flow(q, m)]));
      // The witness as an analysis before #38 made it, with no shape.
      const old = { kind: 'pair' as const, pair: [p, q] as [string, string], middle: m, flowTx: '0xf' };
      await store.saveAnalysis(id, stale!.version, { ...done, flags: done.flags.map((f) => ({ ...f, witness: old })) }, 1, 1_000_000, new Set(['']));
      // And its row as #37's insert wrote it: no shape column named.
      const [row] = (await store.pool.query('SELECT id, kind, wallets, cycles, middle, ring FROM washtrace.witnesses WHERE collection_id = $1', [id])).rows;
      await store.pool.query('DELETE FROM washtrace.witnesses WHERE collection_id = $1', [id]);
      await store.pool.query(
        'INSERT INTO washtrace.witnesses (collection_id, id, kind, wallets, cycles, middle, ring) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, row.id, row.kind, row.wallets, row.cycles, row.middle, row.ring],
      );
      const ac = (await store.token(id, '5'))[0]!.flags.AC!;
      expect(ac).toMatchObject({ kind: 'pair', middle: m });
      expect(ac).not.toHaveProperty('shape');
      expect((await store.lensTokens(id, 'AC', LIST, RAN)).rows).toEqual([expect.objectContaining({ tokenId: '5', pairs: 1, middles: 1, shapes: NO_SHAPES })]);
      expect(await store.middleOf(id, m)).toEqual({ rows: [{ tokenId: '5', seller: p, buyer: q, ring: row.ring, shape: null }], tokens: 1 });
      expect(await store.middlesOf(id, p)).toEqual([{ middle: m, shape: null }]);

      // The next analysis writes it: m was paid by the buyer and paid the seller, so the buyer paid the seller back.
      await store.saveAnalysis(id, stale!.version, done, 1, 1_000_000, new Set(['']));
      expect((await store.token(id, '5'))[0]!.flags.AC).toMatchObject({ shape: 'back' });
      expect((await store.lensTokens(id, 'AC', LIST, RAN)).rows[0]!.shapes).toEqual({ ...NO_SHAPES, back: 1 });
      expect(await store.middleOf(id, m)).toEqual({ rows: [{ tokenId: '5', seller: p, buyer: q, ring: row.ring, shape: 'back' }], tokens: 1 });
    } finally {
      await drop(1, coll);
    }
  });

  it('pages the ranked reads', async () => {
    const c = (await store.collection(1, collection))!;
    const all = (await store.lensWallets(c.id, 'A', LIST, RAN)).rows;
    expect(await store.lensWallets(c.id, 'A', { ...LIST, limit: 1, offset: 1 }, RAN)).toEqual({ rows: [all[1]], total: 2 });
    expect(await store.lensTokens(c.id, 'A', { ...LIST, limit: 10, offset: 1 }, RAN)).toEqual({ rows: [], total: 1 });
    // A whole address finds that one wallet.
    expect((await store.lensWallets(c.id, 'A', { ...LIST, find: a.toUpperCase().replace('0X', '0x') }, RAN)).rows.map((r) => r.address)).toEqual([a]);
  });

  it('buckets the collection\'s own history by when its sales happened, with what each method flags', async () => {
    const c = (await store.collection(1, collection))!;
    // Four transfers a second apart: one bucket, the mint not a sale.
    expect(await store.timeline(c.id)).toEqual({
      bucket: 'hour', untimed: 0, readThrough: (1_700_000_000 + 3) * 1000,
      points: [{ at: Math.floor(1_700_000_000 / 3600) * 3600 * 1000, transfers: 4, sales: 3, apartSales: 0, flaggedSales: { A: 3, AU: 3, AC: 3 } }],
    });
  });

  it('buckets by the reader\'s calendar: an hour in Kolkata starts on the half hour UTC', async () => {
    const c = (await store.collection(1, collection))!;
    const [p] = (await store.timeline(c.id, 'Asia/Kolkata')).points;
    const halfHour = 1800;
    expect(p!.at).toBe((Math.floor((1_700_000_000 + halfHour) / 3600) * 3600 - halfHour) * 1000);
  });

  it('keeps a write that lands mid-analysis stale', async () => {
    const [c] = await store.collections();
    await store.saveMoney(1, a, [flow(a, b)], false);
    const [stale] = await store.stale();
    await store.saveMoney(1, b, [], false);
    await store.saveAnalysis(c!.id, stale!.version, analyze(input([])), 1, null, new Set(['']));
    expect(await store.stale()).toHaveLength(1);
  });

  it('drops an analysis of a collection removed while it ran', async () => {
    const { id } = await store.addCollection(1, w('90e'), 'Gone', 1);
    const due = (await store.stale()).find((s) => s.id === id)!;
    expect(due).toMatchObject({ name: 'Gone', ranAt: null, tookMs: null });
    await drop(1, w('90e'));
    await expect(store.saveAnalysis(id, due.version, analyze(input([])), 1, null, new Set(['']))).resolves.toBeUndefined();
    expect(await store.history(id)).toEqual([]);
  });

  it('keeps a failed analysis on its collection, waiting five minutes doubling to an hour, until one is saved', async () => {
    const coll = w('9a1');
    const { id } = await store.addCollection(1, coll, 'Failing', 1);
    const failures = async () => (await store.pool.query('SELECT analysis_failures FROM washtrace.collections WHERE id = $1', [id])).rows[0].analysis_failures;
    const waits = async () => {
      const c = (await store.collection(1, coll))!;
      const due = (await store.stale()).find((s) => s.id === id)!;
      expect(due.retryAt).toBe(c.analysisRetryAt);
      return c.analysisRetryAt! - Date.now();
    };
    expect(await store.collection(1, coll)).toMatchObject({ analysisError: null, analysisRetryAt: null });
    expect((await store.stale()).find((s) => s.id === id)!.retryAt).toBeNull();
    await store.analysisFailed(id, 'out of memory');
    expect(await store.collection(1, coll)).toMatchObject({ analysisError: 'out of memory' });
    expect(await failures()).toBe(1);
    expect(await waits()).toBeGreaterThan(5 * 60_000 - 5_000);
    expect(await waits()).toBeLessThan(5 * 60_000 + 5_000);
    await store.analysisFailed(id, 'out of memory again');
    expect(await store.collection(1, coll)).toMatchObject({ analysisError: 'out of memory again' });
    expect(await waits()).toBeGreaterThan(10 * 60_000 - 5_000);
    expect(await waits()).toBeLessThan(10 * 60_000 + 5_000);
    // However many in a row, an hour at most.
    await store.pool.query('UPDATE washtrace.collections SET analysis_failures = 2000 WHERE id = $1', [id]);
    await store.analysisFailed(id, 'out of memory');
    expect(await waits()).toBeGreaterThan(60 * 60_000 - 5_000);
    expect(await waits()).toBeLessThan(60 * 60_000 + 5_000);
    // A rule edit may be the fix: tried on the next pass, the failure still said until a run succeeds.
    await store.configure(1, coll, { name: 'Still failing' });
    expect((await store.collection(1, coll))!.analysisRetryAt).not.toBeNull();
    await store.configure(1, coll, { rules: { minCycles: 7 } });
    expect(await store.collection(1, coll)).toMatchObject({ analysisError: 'out of memory', analysisRetryAt: null });
    expect((await store.stale()).find((s) => s.id === id)!.retryAt).toBeNull();
    expect(await failures()).toBe(2001);
    const due = (await store.stale()).find((s) => s.id === id)!;
    await store.saveAnalysis(id, due.version, analyze(input([])), 1, null, new Set(['']));
    expect(await store.collection(1, coll)).toMatchObject({ analysisError: null, analysisRetryAt: null });
    expect(await failures()).toBe(0);
    await drop(1, coll);
  });

  it('marks an analysis as started, and a save, a failure or a requeue each take the mark off; only a failure counts', async () => {
    const coll = w('9a2');
    const { id } = await store.addCollection(1, coll, 'Marked', 1);
    const marked = async () => (await store.stale()).find((s) => s.id === id)!.startedAt;
    const failures = async () => (await store.pool.query('SELECT analysis_failures FROM washtrace.collections WHERE id = $1', [id])).rows[0].analysis_failures;
    try {
      expect(await marked()).toBeNull();
      await store.analysisStarted(id);
      expect(Math.abs((await marked())! - Date.now())).toBeLessThan(5_000);
      await store.analysisRequeued(id);
      expect(await marked()).toBeNull();
      expect(await failures()).toBe(0);
      await store.analysisStarted(id);
      await store.analysisFailed(id, 'out of memory');
      expect(await marked()).toBeNull();
      expect(await failures()).toBe(1);
      await store.analysisStarted(id);
      const due = (await store.stale()).find((s) => s.id === id)!;
      await store.saveAnalysis(id, due.version, analyze(input([])), 1, null, new Set(['']));
      const { rows } = await store.pool.query('SELECT analysis_started_at FROM washtrace.collections WHERE id = $1', [id]);
      expect(rows[0].analysis_started_at).toBeNull();
    } finally {
      await drop(1, coll);
    }
  });

  it('#33 adds the nullable started-at column, and running it again changes nothing', async () => {
    const MARK = `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'washtrace' AND table_name = 'collections' AND column_name = 'analysis_started_at'`;
    expect(typeof MIGRATIONS[32]).toBe('string');
    expect(MIGRATIONS[32]).toContain('ADD COLUMN IF NOT EXISTS analysis_started_at timestamptz');
    await store.migrate();
    for (let i = 0; i < 2; i++) {
      await store.pool.query('DELETE FROM washtrace.schema_version');
      await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES (32)');
      expect(await store.migrate()).toBe(MIGRATIONS.length);
      expect((await store.pool.query(MARK)).rows).toEqual([{ is_nullable: 'YES' }]);
    }
  });

  it('runs a job in one session only: a second is skipped, not queued', async () => {
    let release!: () => void;
    const held = store.locked(7, false, () => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 100));
    expect(await store.locked(7, false, async () => 'ran')).toBe('skipped');
    release();
    await held;
    expect(await store.locked(7, false, async () => 'ran')).toBe('ran');
  });

  it('merges a collection\'s rules, and null puts one back to its default', async () => {
    expect((await store.collection(1, collection))!.rules).toEqual({});
    await store.configure(1, collection, { rules: { minCycles: 3, hubDegree: 40 } });
    await store.configure(1, collection, { rules: { hubDegree: null, reachDepth: 10 } });
    expect((await store.collection(1, collection))!.rules).toEqual({ minCycles: 3, reachDepth: 10 });
  });

  it('renames without touching the rules, and only a rule change queues analysis', async () => {
    const version = async () => (await store.stale()).find((s) => s.chainId === 1)!.version;
    const before = await version();
    const renamed = await store.configure(1, collection, { name: 'Renamed' });
    expect(renamed).toMatchObject({ name: 'Renamed', rules: { minCycles: 3, reachDepth: 10 } });
    expect(await version()).toBe(before);
    await store.configure(1, collection, { rules: { minCycles: 3 } });
    expect(await version()).toBe(before);
    await store.configure(1, collection, { rules: { minCycles: 4 } });
    expect(await version()).toBe(before + 1);
  });

  it('configures nothing for a collection it does not watch', async () => {
    expect(await store.configure(1, w('dead'), { name: 'x' })).toBeNull();
  });

  it('smooths a collection\'s read rate and remembers when it was served', async () => {
    const c = (await store.collection(1, collection))!;
    await store.served(c.id, 1000, 10_000);   // 100 blocks/s
    await store.served(c.id, 1000, 5_000);    // 200 blocks/s
    const after = (await store.collection(1, collection))!;
    expect(after.readRate).toBeCloseTo(130);
    expect(after.servedAt).not.toBeNull();
    await store.served(c.id, 1000, 0);        // no duration: served, rate untouched
    expect((await store.collection(1, collection))!.readRate).toBeCloseTo(130);
  });

  it('keeps a heartbeat and what a pass is doing', async () => {
    await store.passStarted('analyze');
    await store.heartbeat('analyze', 'Analyzing Test', 7);
    const p = (await store.passes()).find((r) => r.job === 'analyze')!;
    expect(p).toMatchObject({ doing: 'Analyzing Test', subjectId: 7 });
    expect(p.heartbeatAt).not.toBeNull();
  });

  it('prioritises a collection without queueing an analysis', async () => {
    const before = (await store.collection(1, collection))!;
    await store.configure(1, collection, { priority: true });
    const after = (await store.collection(1, collection))!;
    expect(after.priority).toBe(true);
    expect(after.stale).toBe(before.stale);
  });

  it('analyzes a collection with its own rules', async () => {
    const worker = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), pg.getConnectionUri());
    // The thread's own body, in-process: the TS sources cannot start the thread.
    worker.analyzeOff = (request) => analyzeStored(store, request);
    await store.configure(1, collection, { rules: { minCycles: null, reachDepth: null } });
    await worker.run('analyze');
    expect((await store.collection(1, collection))!.latest?.totals.A.flagged).toBe(3);
    // Two cycles is the paper's floor; at 99 the same trades are not a pattern.
    // A rule edit runs at once, though the last analysis was moments ago.
    await store.configure(1, collection, { rules: { minCycles: 99 } });
    await worker.run('analyze');
    expect((await store.collection(1, collection))!.latest?.totals.A.flagged).toBe(0);
  });

  describe('following money for SCC AU', () => {
    const follow = { hops: 2, fanout: 3, exclude: [w('5ea')] };
    const depthOf = async (a: string) => (await store.pool.query('SELECT depth FROM washtrace.wallets WHERE chain_id = 1 AND address = $1', [a])).rows[0]?.depth ?? null;

    it('queues the wallets a trader paid, one hop out, behind every trader', async () => {
      await store.saveMoney(1, a, [flow(a, w('m1')), flow(w('in'), a), flow(a, w('5ea'))], false, follow);
      // Paid by a: followed. Paid a: not, since AU follows money onward. A contract: never.
      expect(await depthOf(w('m1'))).toBe(1);
      expect(await depthOf(w('in'))).toBeNull();
      expect(await depthOf(w('5ea'))).toBeNull();
      const { lanes } = await store.moneyLanes(1, 10, 3);
      expect(lanes.at(-1)).toEqual({ collectionId: null, wallets: [w('m1')] });
      expect(lanes.slice(0, -1).some((l) => l.wallets.includes(w('m1')))).toBe(false);
    });

    it('stops at the hop limit', async () => {
      await store.saveMoney(1, w('m1'), [flow(w('m1'), w('m2'))], false, follow);
      expect(await depthOf(w('m2'))).toBe(2);
      await store.saveMoney(1, w('m2'), [flow(w('m2'), w('m3'))], false, follow);
      expect(await depthOf(w('m3'))).toBeNull();
    });

    it('does not follow a wallet that paid more wallets than the fanout', async () => {
      await store.saveMoney(1, b, [1, 2, 3, 4].map((i) => flow(b, w(`f${i}`))), false, follow);
      expect(await depthOf(w('f1'))).toBeNull();
    });

    it('reads a followed wallet\'s payments onward into the analysis', async () => {
      const [c] = await store.collections();
      const read = await store.analysisInput(c!.id, 1, 3);
      const { payments } = read;
      const m1 = payments.number(w('m1')), m2 = payments.number(w('m2'));
      expect(m1).toBeDefined();
      expect([...payments.ends].some((n, i) => i % 2 === 0 && n === m1 && payments.ends[i + 1] === m2)).toBe(true);
    });

    it('takes a followed wallet back to depth 0 when it trades', async () => {
      const [c] = await store.collections();
      await store.ingest(c!.id, 1, [], c!.cursorBlock!, [w('m1')]);
      expect(await depthOf(w('m1'))).toBe(0);
    });
  });

  describe('settings, where they came from, and checks', () => {
    it('round-trips a setting, and null deletes it', async () => {
      expect(await store.settings()).toEqual(new Map());
      await store.setSetting('follow.hops', '2', 'alice');
      await store.setSetting('follow.hops', '3', 'bob');
      await store.setSetting('etherscan.key', 'k-secret', 'alice');
      expect(await store.settings()).toEqual(new Map([['etherscan.key', 'k-secret'], ['follow.hops', '3']]));
      const { rows } = await store.pool.query(`SELECT updated_by FROM washtrace.settings WHERE key = 'follow.hops'`);
      expect(rows).toEqual([{ updated_by: 'bob' }]);
      await store.setSetting('follow.hops', null, 'bob');
      await store.setSetting('etherscan.key', null, 'bob');
      expect(await store.settings()).toEqual(new Map());
    });

    it('knows which keys are secret', () => {
      expect(['rpc.1', 'rpc.8453', 'etherscan.key'].every(SECRET_KEYS)).toBe(true);
      expect(['etherscan.rps', 'etherscan.url', 'follow.hops'].some(SECRET_KEYS)).toBe(false);
    });

    it('replaces the earlier report of where settings came from, and never keeps a secret', async () => {
      await store.reportSources({ 'rpc.1': { source: 'env', value: '••••', env: null }, 'follow.hops': { source: 'env', value: '2', env: '2' } });
      await store.reportSources({
        'etherscan.rps': { source: 'console', value: '5', env: null },
        // A caller that forgot to mask a secret: the store blanks it.
        'rpc.1': { source: 'console', value: 'https://rpc.example/key', env: null },
      });
      const sources = await store.sources();
      expect(Object.keys(sources).sort()).toEqual(['etherscan.rps', 'rpc.1']);
      expect(sources['etherscan.rps']).toMatchObject({ source: 'console', value: '5' });
      expect(sources['rpc.1']).toMatchObject({ source: 'console', value: null });
      expect(sources['rpc.1']!.reportedAt).toBeGreaterThan(Date.now() - 60_000);
      expect(JSON.stringify(sources)).not.toContain('https');
    });

    it('keeps what the environment holds, and never an unmasked secret', async () => {
      await store.reportSources({
        'rpc.1': { source: 'console', value: 'https://a.example/••••EY77', env: 'https://b.example/v2/RAWKEY99' },
        'etherscan.key': { source: 'env', value: '••••1234', env: '••••1234' },
        'follow.hops': { source: 'console', value: '1', env: '2' },
      });
      const s = await store.sources();
      expect(s['rpc.1']).toMatchObject({ source: 'console', value: 'https://a.example/••••EY77', env: null });
      expect(s['etherscan.key']).toMatchObject({ value: '••••1234', env: '••••1234' });
      expect(s['follow.hops']).toMatchObject({ value: '1', env: '2' });
    });

    it('takes reports from passes that run at once, keeping the last', async () => {
      // ingest, fund and analyze start together and each reports where settings came from.
      const report = (n: number) => ({ 'follow.hops': { source: 'console' as const, value: String(n), env: null }, [`rpc.${n}`]: { source: 'env' as const, value: '••••', env: null } });
      for (let round = 0; round < 5; round++) {
        await expect(Promise.all([1, 2, 3].map((n) => store.reportSources(report(n))))).resolves.toBeDefined();
      }
      await store.reportSources(report(4));
      const sources = await store.sources();
      expect(Object.keys(sources).sort()).toEqual(['follow.hops', 'rpc.4']);
      expect(sources['follow.hops']).toMatchObject({ source: 'console', value: '4' });
    });

    it('keeps a requested check pending until it is finished', async () => {
      const id = await store.requestCheck('rpc', 1);
      const other = await store.requestCheck('etherscan', null);
      expect(await store.check(id)).toEqual({ finished: false, ok: null, detail: null });
      const age = expect.any(Number);
      expect(await store.pendingChecks()).toEqual([{ id, kind: 'rpc', chainId: 1, ageMs: age }, { id: other, kind: 'etherscan', chainId: null, ageMs: age }]);
      // Aged by the store's clock, so the worker can tell a check no notification brought (see Checks.sweepChecks).
      await store.pool.query(`UPDATE washtrace.checks SET requested_at = now() - interval '25 seconds' WHERE id = $1`, [id]);
      const [first] = await store.pendingChecks();
      expect(first!.ageMs).toBeGreaterThanOrEqual(25_000);
      expect(first!.ageMs).toBeLessThan(35_000);
      await store.finishCheck(id, true, { finalized: 100, archive: true, logs: false });
      expect(await store.check(id)).toEqual({ finished: true, ok: true, detail: { finalized: 100, archive: true, logs: false } });
      expect(await store.pendingChecks()).toEqual([{ id: other, kind: 'etherscan', chainId: null, ageMs: age }]);
      await store.finishCheck(other, false, { error: 'timed out' });
      expect(await store.pendingChecks()).toEqual([]);
      expect(await store.check(999_999)).toBeNull();
    });

    it('tells a listener on another connection that a check was requested', async () => {
      const listener = new pgClient.Client({ connectionString: pg.getConnectionUri() });
      await listener.connect();
      try {
        await listener.query('LISTEN washtrace_checks');
        const heard = new Promise<string | undefined>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no notify within 5s')), 5_000);
          listener.on('notification', (n) => { clearTimeout(timer); resolve(n.channel); });
        });
        const id = await store.requestCheck('rpc', 1);
        expect(await heard).toBe('washtrace_checks');
        await store.finishCheck(id, true, {});
      } finally {
        await listener.end();
      }
    });
  });

  describe('the worker running checks', () => {
    const RPC = 'https://rpc.example/v2/RPCSECRET0123456789';
    const KEY = 'ESKEYSECRET987654321';
    /** A worker on the real store whose chain and Etherscan clients never touch a network. */
    function checker(env: Record<string, string> = {}, check: Chain['check'] = async () => ({ finalized: 26_253_624, archive: true, logs: false })) {
      const worker = new Worker(store, (s) => workerConfig(env, s), pg.getConnectionUri());
      const urls: string[] = [];
      worker.chain = (chainId, url) => {
        urls.push(url);
        const c = new Chain(chainId, url);
        c.check = check;
        return c;
      };
      return { worker, urls };
    }

    it('finishes a requested RPC check with what the chain answered, and no URL', async () => {
      const id = await store.requestCheck('rpc', 1);
      const { worker } = checker({ WASHTRACE_RPC_1: RPC });
      expect(await worker.checks.runChecks()).toBe(1);
      const done = await store.check(id);
      expect(done).toEqual({ finished: true, ok: true, detail: { finalized: 26_253_624, archive: true, logs: false } });
      expect(JSON.stringify(done)).not.toContain('https');
      expect(await worker.checks.runChecks()).toBe(0);
    });

    it('tests the URL saved a moment ago, not the one read at the last pass', async () => {
      const { worker, urls } = checker();
      (worker as any).settings = new Map([['rpc.1', 'https://old.example/rpc']]);
      await store.setSetting('rpc.1', 'https://fresh.example/rpc', 'alice');
      try {
        await store.requestCheck('rpc', 1);
        await worker.checks.runChecks();
        expect(urls).toEqual(['https://fresh.example/rpc']);
        // A store that cannot be read falls back to the settings read last.
        const read = store.settings;
        store.settings = async () => { throw new Error('store away'); };
        try {
          await store.requestCheck('rpc', 1);
          await worker.checks.runChecks();
        } finally {
          store.settings = read;
        }
        expect(urls).toEqual(['https://fresh.example/rpc', 'https://old.example/rpc']);
      } finally {
        await store.setSetting('rpc.1', null, 'alice');
      }
    });

    it('never keeps a short key a provider echoes without the scheme, nor one it echoes decoded', async () => {
      const cases = [
        { url: 'http://127.0.0.1:8545/v2/Sh0rtK3y', echo: '127.0.0.1:8545/v2/Sh0rtK3y refused', leaks: ['127.0.0.1:8545', 'Sh0rtK3y'] },
        { url: 'https://rpc.example/v2/ab%2Bcd%2Fefghijklmno', echo: 'key ab+cd/efghijklmno refused', leaks: ['ab+cd/efghijklmno', 'ab%2Bcd%2Fefghijklmno'] },
        // A key in the subdomain, echoed as the host alone.
        { url: 'https://SECRETLABEL12345.rpc.example/', echo: 'no route to SECRETLABEL12345.rpc.example refused', leaks: ['SECRETLABEL12345'] },
        // A query value's '+' is a space once decoded.
        { url: 'https://rpc.example/v2?key=ab+cd+efgh', echo: 'key ab cd efgh refused', leaks: ['ab cd efgh'] },
        // A proxy echoing the Authorization header it was sent: base64 of user:password.
        { url: 'https://alice:p%40ss%2Fw0rd@rpc.example/', echo: 'header Basic YWxpY2U6cEBzcy93MHJk refused', leaks: ['YWxpY2U6cEBzcy93MHJk'] },
      ];
      for (const { url, echo, leaks } of cases) {
        const id = await store.requestCheck('rpc', 1);
        const { worker } = checker({ WASHTRACE_RPC_1: url }, async () => {
          throw new HttpRequestError({ url, status: 401, details: echo });
        });
        await worker.checks.runChecks();
        const done = (await store.check(id))!;
        expect(done.ok).toBe(false);
        // The short message and details came through, minus the secrets.
        expect(String(done.detail?.error)).toMatch(/^HTTP request failed\. .*refused$/);
        for (const leak of leaks) expect(JSON.stringify(done)).not.toContain(leak);
      }
    });

    it('says Etherscan in a failed Etherscan Test on the default URL, and never the key', async () => {
      const id = await store.requestCheck('etherscan', 1);
      const { worker } = checker({ WASHTRACE_ETHERSCAN_KEY: KEY });
      const real = worker.etherscanClient.bind(worker);
      worker.etherscanClient = (config) => {
        const e = real(config)!;
        e.fetch = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: `Invalid API Key ${KEY}` } }));
        return e;
      };
      await worker.checks.runChecks();
      const done = (await store.check(id))!;
      expect(done).toMatchObject({ finished: true, ok: false, detail: { error: 'Etherscan refused eth_blockNumber: Invalid API Key [hidden]' } });
    });

    it('lets every check finish before it gives up the run over one that could not be saved', async () => {
      const first = await store.requestCheck('rpc', 1);
      const second = await store.requestCheck('rpc', 1);
      const { worker } = checker({ WASHTRACE_RPC_1: RPC });
      const finish = store.finishCheck;
      store.finishCheck = async (id, ok, detail) => {
        if (id === first) throw new Error('store away');
        await new Promise((r) => setTimeout(r, 200));
        return finish.call(store, id, ok, detail);
      };
      try {
        await expect(worker.checks.runChecks()).rejects.toThrow('store away');
        expect((await store.check(second))!.finished).toBe(true);
      } finally {
        store.finishCheck = finish;
        await store.finishCheck(first, false, { error: 'test done' });
      }
    });

    it('never keeps a URL or a key from an error', async () => {
      const id = await store.requestCheck('rpc', 1);
      const { worker } = checker({ WASHTRACE_RPC_1: RPC, WASHTRACE_ETHERSCAN_KEY: KEY }, async () => {
        throw new Error(`HTTP request failed.\n\nStatus: 401\nURL: ${RPC}\nDetails: key ${KEY} refused at http://other.example/x?apikey=${KEY}`);
      });
      await worker.checks.runChecks();
      const done = (await store.check(id))!;
      expect(done.ok).toBe(false);
      expect(typeof done.detail?.error).toBe('string');
      const text = JSON.stringify(done);
      for (const leak of ['https', 'http://', 'RPCSECRET0123456789', KEY]) expect(text).not.toContain(leak);
      // Etherscan's own URL carries the key in its query.
      const es = await store.requestCheck('etherscan', 1);
      worker.etherscanClient = () => {
        const e = new Etherscan(KEY);
        e.ping = async () => { throw new Error(`fetch failed for https://api.etherscan.io/v2/api?chainid=1&apikey=${KEY}`); };
        return e;
      };
      await worker.checks.runChecks();
      const failed = JSON.stringify(await store.check(es));
      expect(failed).toContain('"ok":false');
      for (const leak of ['https', 'apikey', KEY]) expect(failed).not.toContain(leak);
    });

    it('expires a check asked for more than 5 minutes ago instead of running it', async () => {
      const id = await store.requestCheck('rpc', 1);
      await store.pool.query(`UPDATE washtrace.checks SET requested_at = now() - interval '6 minutes' WHERE id = $1`, [id]);
      const { worker, urls } = checker({ WASHTRACE_RPC_1: RPC });
      expect(await worker.checks.runChecks()).toBe(1);
      expect(await store.check(id)).toEqual({ finished: true, ok: false, detail: { error: 'expired' } });
      expect(urls).toEqual([]);
    });

    it('finishes a malformed check with an error rather than throwing', async () => {
      const id = await store.requestCheck('rpc', null);
      const { worker, urls } = checker({ WASHTRACE_RPC_1: RPC });
      expect(await worker.checks.runChecks()).toBe(1);
      const done = (await store.check(id))!;
      expect(done).toMatchObject({ finished: true, ok: false });
      expect(done.detail?.error).toMatch(/chain/i);
      expect(urls).toEqual([]);
    });

    it('says what is missing: an Etherscan key, or an RPC for the chain', async () => {
      const noKey = await store.requestCheck('etherscan', 1);
      const noRpc = await store.requestCheck('rpc', 5);
      const { worker } = checker({ WASHTRACE_RPC_1: RPC });
      expect(await worker.checks.runChecks()).toBe(2);
      expect(await store.check(noKey)).toEqual({ finished: true, ok: false, detail: { error: 'No Etherscan key is set' } });
      expect(await store.check(noRpc)).toEqual({ finished: true, ok: false, detail: { error: 'No RPC is set for chain 5' } });
    });

    it('finishes an Etherscan check ok when Etherscan answers', async () => {
      const id = await store.requestCheck('etherscan', 1);
      const { worker } = checker({ WASHTRACE_ETHERSCAN_KEY: KEY });
      const pinged: number[] = [];
      worker.etherscanClient = () => {
        const e = new Etherscan(KEY);
        e.ping = async (chainId) => { pinged.push(chainId); };
        return e;
      };
      await worker.checks.runChecks();
      expect(pinged).toEqual([1]);
      expect(await store.check(id)).toMatchObject({ finished: true, ok: true });
    });

    it('runs a check as soon as it is requested, one run at a time, until stopped', async () => {
      const { worker } = checker({ WASHTRACE_RPC_1: RPC });
      const run = worker.checks.runChecks.bind(worker.checks);
      let running = 0, most = 0, runs = 0;
      worker.checks.runChecks = async () => {
        running += 1; runs += 1; most = Math.max(most, running);
        try {
          await new Promise((r) => setTimeout(r, 200));
          return await run();
        } finally {
          running -= 1;
        }
      };
      await worker.checks.listen();
      try {
        const ids = [await store.requestCheck('rpc', 1), await store.requestCheck('rpc', 1), await store.requestCheck('rpc', 1)];
        const until = Date.now() + 5_000;
        while (Date.now() < until && (await Promise.all(ids.map((i) => store.check(i)))).some((c) => !c!.finished)) await new Promise((r) => setTimeout(r, 50));
        for (const i of ids) expect(await store.check(i)).toMatchObject({ finished: true, ok: true });
        expect(most).toBe(1);
        expect(runs).toBeGreaterThanOrEqual(2);
      } finally {
        worker.stop();
      }
      // Stopped: a request is no longer heard.
      await new Promise((r) => setTimeout(r, 300));
      const before = runs;
      const late = await store.requestCheck('rpc', 1);
      await new Promise((r) => setTimeout(r, 500));
      expect(runs).toBe(before);
      await store.finishCheck(late, false, { error: 'test done' });
    });

    it('listens again after its connection is lost', async () => {
      const { worker } = checker({ WASHTRACE_RPC_1: RPC });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await worker.checks.listen();
      try {
        const { rowCount } = await store.pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'washtrace-checks'`);
        expect(rowCount).toBe(1);
        const until = Date.now() + 15_000;
        while (Date.now() < until && (await store.pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name = 'washtrace-checks' AND query ILIKE 'LISTEN%'`)).rowCount === 0) {
          await new Promise((r) => setTimeout(r, 100));
        }
        const id = await store.requestCheck('rpc', 1);
        while (Date.now() < until && !(await store.check(id))!.finished) await new Promise((r) => setTimeout(r, 50));
        expect(await store.check(id)).toMatchObject({ finished: true, ok: true });
        // One line, and never the store's URL with its password.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]!.slice(1))).not.toContain(pg.getPassword());
      } finally {
        worker.stop();
        warn.mockRestore();
      }
    });
  });

  describe('cutting stored data', () => {
    // A chain of its own, so the rest of this file's wallets stay out of it.
    const chainId = 7, coll = w('57d'), m = w('5d1');
    const all = async <T>(rows: AsyncIterable<T>) => { const out: T[] = []; for await (const r of rows) out.push(r); return out; };

    it('streams a collection\'s transfers up to its cursor, and its money trail', async () => {
      await store.migrate(); // a no-op in a full run; lets this block run by itself
      const { id } = await store.addCollection(chainId, coll, null, 1);
      const ts = chain('1', a, b, a).map((t, i) => ({ ...t, blockNumber: 10 + i, blockTime: 1_700_000_000 + i }));
      await store.ingest(id, chainId, ts, 12, [a, b, a, b]);
      // A span stored past the cursor is not in a snapshot that stops at it.
      await store.pool.query('UPDATE washtrace.collections SET cursor_block = 11 WHERE id = $1', [id]);
      expect(await store.storedHeader(chainId, coll.toUpperCase().replace('0X', '0x'))).toEqual({
        id, name: coll, contractName: null, startBlock: 1, throughBlock: 11, throughTime: 1_700_000_001_000,
      });
      expect(await all(store.storedTransfers(id, 11))).toEqual(ts.slice(0, 2));

      const m2 = w('5d2'), outsider = w('0u7');
      const paid = [flow(a, m), flow(b, a), flow(a, m2)];
      // m was paid by a wallet that is neither a trader nor followed. An install
      // that imports m as done never reads it again, so the file must carry it.
      const onward = [flow(m, b), flow(outsider, m)];
      await store.saveMoney(chainId, a, paid, false, { hops: 2, fanout: 3, exclude: [] });
      await store.saveMoney(chainId, m, onward, false);
      const trail = await store.trail(id, chainId);
      // m2 is checked after the trail was begun: it is not in the file, rather
      // than in it as done without the flows that were not looked for.
      await store.saveMoney(chainId, m2, [flow(m2, w('0u8'))], false);
      // b is still unchecked: it counts in "of", and stays out of the file.
      expect({ checked: trail.checked, of: trail.of }).toEqual({ checked: 1, of: 2 });
      expect(await all(trail.addresses)).toEqual([a, m]);
      // In block order, each flow in its own block here.
      expect(await all(trail.flows)).toEqual([...paid, ...onward]);
    });

    it('gives the connection back when a stream is left early', async () => {
      const [c] = (await store.collections()).filter((x) => x.chainId === chainId);
      const out = () => store.pool.totalCount - store.pool.idleCount;
      const before = out();
      for await (const _ of store.storedTransfers(c!.id, 11)) break;
      expect(out()).toBe(before);
      const trail = await store.trail(c!.id, chainId);
      for await (const _ of trail.addresses) break;
      for await (const _ of trail.flows) break;
      expect(out()).toBe(before);
      // And the pool still answers: nothing is left holding a transaction open.
      expect((await store.pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = $1', ['idle in transaction'])).rows[0].n).toBe(0);
    });

    describe('downloads', () => {
      // The private stream, over rows 1..n a page at a time, as a download.
      const download = (n: number, page = 1) => (store as any).stream(`SELECT g AS n FROM generate_series(1, ${n}) g`, [], (r: any) => r.n, page, true) as AsyncGenerator<number>;
      const out = () => store.pool.totalCount - store.pool.idleCount;
      afterEach(() => { store.streamIdleS = 60; store.streamMaxMs = 15 * 60_000; });

      it('holds three at once and refuses a fourth on its first pull', async () => {
        const before = out();
        const open = [download(5), download(5), download(5)];
        for (const d of open) await d.next();
        expect(store.streaming).toBe(3);
        await expect(download(5).next()).rejects.toBeInstanceOf(TooManyStreams);
        for (const d of open) await d.return(undefined);
        expect(store.streaming).toBe(0);
        expect(out()).toBe(before);
        // A slot is free again.
        const again = download(2);
        expect((await again.next()).value).toBe(1);
        await again.return(undefined);
        expect(store.streaming).toBe(0);
      });

      it('refuses the fourth of four first pulls at once, never holding more than three clients', async () => {
        const pool = store.pool as any;
        const connect = pool.connect;
        let held = 0, most = 0;
        // Only the promise form: the pool's own query passes a callback.
        pool.connect = (cb?: unknown) => (cb ? connect.call(pool, cb) : (async () => {
          const c = await connect.call(pool);
          most = Math.max(most, ++held);
          const release = c.release;
          c.release = (...a: unknown[]) => { held--; c.release = release; return release.apply(c, a); };
          return c;
        })());
        const four = [download(5), download(5), download(5), download(5)];
        try {
          const pulled = await Promise.allSettled(four.map((d) => d.next()));
          expect(pulled.filter((p) => p.status === 'rejected').map((p) => (p as PromiseRejectedResult).reason))
            .toEqual([expect.any(TooManyStreams)]);
          expect(most).toBe(3);
        } finally {
          for (const d of four) await d.return(undefined);
          delete pool.connect;
        }
        expect(store.streaming).toBe(0);
      });

      it('frees its slot when it cannot get a client', async () => {
        const pool = store.pool as any;
        const connect = pool.connect;
        pool.connect = (cb?: unknown) => (cb ? connect.call(pool, cb) : Promise.reject(new Error('no client')));
        try {
          await expect(download(5).next()).rejects.toThrow('no client');
        } finally {
          delete pool.connect;
        }
        expect(store.streaming).toBe(0);
      });

      it('ends the session of one idle past the limit, rejects its next pull and gives the client back', async () => {
        const before = out();
        store.streamIdleS = 1;
        const d = download(5);
        await d.next();
        await new Promise((r) => setTimeout(r, 1500));
        await expect(d.next()).rejects.toThrow();
        expect(store.streaming).toBe(0);
        expect(out()).toBe(before);
      });

      it('errors a download open past the time cap', async () => {
        const before = out();
        store.streamMaxMs = 0;
        const d = download(5);
        await d.next();
        await new Promise((r) => setTimeout(r, 5));
        await expect(d.next()).rejects.toThrow('ran too long');
        expect(store.streaming).toBe(0);
        expect(out()).toBe(before);
      });
    });

    it('has nothing to cut for a collection it does not watch', async () => {
      expect(await store.storedHeader(chainId, w('404'))).toBeNull();
    });
  });

  describe('restoring stored data', () => {
    // A chain of its own, so the rest of this file's wallets stay out of it.
    const chainId = 8;
    const entry = (address: string, more: Partial<StoredEntry> = {}): StoredEntry => ({
      chainId, address, name: 'Stored', startBlock: 5, throughBlock: 300, throughTime: 1_700_000_100_000,
      transfers: { file: `${chainId}-${address}.transfers.csv.zst`, rows: 3, bytes: 0, sha256: '' }, trail: null, ...more,
    });
    async function* batches(...bs: Transfer[][]): AsyncIterable<Transfer[]> {
      for (const b of bs) yield b;
    }
    /** What a failed load is keyed on: the manifest's sha256 and the file as it stood (storedKey). */
    const KEY = 'abc:10:1700000000000:1700000000000';
    const version = async (id: number) => Number((await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id])).rows[0].version);
    const wallets = async (...addresses: string[]) => Object.fromEntries((await store.pool.query(
      'SELECT address, transfers FROM washtrace.wallets WHERE chain_id = $1 AND address = ANY($2)', [chainId, addresses])).rows.map((r) => [r.address, r.transfers]));

    it('loads every stored transfer in one go, keeps the ones already read, and moves the cursor to where the data stops', async () => {
      await store.migrate(); // a no-op in a full run; lets this block run by itself
      const coll = w('8e1'), p = w('8a1'), q = w('8a2'), r = w('8a3');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      const ts = chain('1', p, q, r).map((t, i) => ({ ...t, blockNumber: 20 + i, blockTime: 1_700_000_000 + i }));
      await store.ingest(id, chainId, ts.slice(0, 1), 20, [p]);
      const before = await version(id);
      await store.restore(id, chainId, entry(coll), batches(ts.slice(0, 2), ts.slice(2)), KEY);
      const c = (await store.collection(chainId, coll))!;
      expect(c).toMatchObject({
        transfers: 3, startBlock: 5, cursorBlock: 300, storedThroughTime: 1_700_000_100_000, storedThroughBlock: 300, restoreProgress: null, restoreNote: null,
      });
      expect(await version(id)).toBe(before + 1);
      // Queued as ingest queues them: the zero address left out, and the one already read not counted twice.
      expect(await wallets(p, q, r)).toEqual({ [p]: 2, [q]: 2, [r]: 1 });
      expect((await store.moneyLanes(chainId, 10, 3)).lanes.find((l) => l.collectionId === id)!.wallets.sort()).toEqual([p, q, r].sort());
      await drop(chainId, coll);
    });

    it('takes the stored start block when none is known, and never moves a start or a cursor the wrong way', async () => {
      const fresh = w('8e2'), ahead = w('8e3');
      const f = (await store.addCollection(chainId, fresh, null, null)).id;
      await store.restore(f, chainId, entry(fresh), batches(), KEY);
      expect(await store.collection(chainId, fresh)).toMatchObject({ startBlock: 5, cursorBlock: 300 });
      const a2 = (await store.addCollection(chainId, ahead, null, 2)).id;
      await store.pool.query('UPDATE washtrace.collections SET cursor_block = 500 WHERE id = $1', [a2]);
      await store.restore(a2, chainId, entry(ahead), batches(), KEY);
      expect(await store.collection(chainId, ahead)).toMatchObject({ startBlock: 2, cursorBlock: 500 });
      await drop(chainId, fresh);
      await drop(chainId, ahead);
    });

    it('stores nothing when the stored data turns out bad partway, and says why in a few words', async () => {
      const coll = w('8e4');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      const read = chain('2', w('8a4'), w('8a5')).map((t, i) => ({ ...t, blockNumber: 20 + i }));
      await store.ingest(id, chainId, read.slice(0, 1), 20, []);
      async function* broken(): AsyncIterable<Transfer[]> {
        yield read;
        throw new StoredDataError('/app/data/stored/8-x.transfers.csv.zst has a row of 3 fields, expected 10', 'unreadable');
      }
      await expect(store.restore(id, chainId, entry(coll), broken(), KEY)).rejects.toThrow('has a row of 3 fields');
      expect(await store.collection(chainId, coll)).toMatchObject({
        transfers: 1, startBlock: 10, cursorBlock: 20, restoreProgress: null, storedThroughTime: null,
        restoreNote: 'Stored data could not be loaded: its file could not be read.',
      });
      await drop(chainId, coll);
    });

    it('says which way a stored file was bad: missing, or not matching the manifest', async () => {
      const coll = w('8e8');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      const failing = (err: Error) => (async function* (): AsyncIterable<Transfer[]> { throw err; })();
      await expect(store.restore(id, chainId, entry(coll), failing(new StoredDataError('x is missing', 'missing')), KEY)).rejects.toThrow();
      expect((await store.collection(chainId, coll))!.restoreNote).toBe('Stored data could not be loaded: its file is missing.');
      await expect(store.restore(id, chainId, entry(coll), failing(new StoredDataError('x does not match', 'mismatch')), KEY)).rejects.toThrow();
      expect((await store.collection(chainId, coll))!.restoreNote).toBe('Stored data could not be loaded: its file does not match the manifest.');
      await drop(chainId, coll);
    });

    it('takes a value the store refuses as bad stored data, noted once, not a failure to retry', async () => {
      const coll = w('8ec');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      // A token id that is no number: the file matched its sha256, but holds what the store will not take.
      const bad = chain('7', w('8b5')).map((t) => ({ ...t, tokenId: 'seven' }));
      await expect(store.restore(id, chainId, entry(coll), batches(bad), KEY)).rejects.toBeInstanceOf(StoredDataError);
      expect(await store.collection(chainId, coll)).toMatchObject({
        transfers: 0, restoreNote: 'Stored data could not be loaded: its file could not be read.',
      });
      await drop(chainId, coll);
    });

    it('notes bad stored data on what failed, so it is tried again once the manifest or the file changes', async () => {
      const coll = w('8ed');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      const failing = (async function* (): AsyncIterable<Transfer[]> { throw new StoredDataError('x is missing', 'missing'); })();
      await expect(store.restore(id, chainId, entry(coll), failing, KEY)).rejects.toThrow();
      const c = (await store.collection(chainId, coll))!;
      expect(c).toMatchObject({ restoreNote: 'Stored data could not be loaded: its file is missing.', restoreNoteKey: KEY, restoreRetryAt: null });
      expect(needsRestore(c, entry(coll), KEY)).toBe(false);
      expect(needsRestore(c, entry(coll), 'abc:absent')).toBe(true);
      await drop(chainId, coll);
    });

    it('backs off when the store, not the data, failed: five minutes, doubling, and a load that goes through clears it all', async () => {
      const coll = w('8e9');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
      async function* interrupted(): AsyncIterable<Transfer[]> {
        yield chain('5', w('8b1'), w('8b2'));
        throw deadlock;
      }
      const failures = async () => (await store.pool.query('SELECT restore_failures FROM washtrace.collections WHERE id = $1', [id])).rows[0].restore_failures;
      const started = Date.now();
      await expect(store.restore(id, chainId, entry(coll), interrupted(), KEY)).rejects.toThrow('deadlock detected');
      const c = (await store.collection(chainId, coll))!;
      expect(c).toMatchObject({ transfers: 0, restoreProgress: null, restoreNote: 'Stored data could not be loaded.', restoreNoteKey: null, cursorBlock: 9 });
      expect(await failures()).toBe(1);
      expect(c.restoreRetryAt! - started).toBeGreaterThan(5 * 60_000 - 5_000);
      expect(c.restoreRetryAt! - started).toBeLessThan(5 * 60_000 + 5_000);
      // Not tried again until then; and meanwhile analysed on what it has (needsRestore is what holds analysis back).
      expect(needsRestore(c, entry(coll), null)).toBe(false);
      expect(needsRestore(c, entry(coll), null, c.restoreRetryAt!)).toBe(true);
      await expect(store.restore(id, chainId, entry(coll), interrupted(), KEY)).rejects.toThrow('deadlock detected');
      const again = (await store.collection(chainId, coll))!;
      expect(await failures()).toBe(2);
      expect(again.restoreRetryAt! - Date.now()).toBeGreaterThan(10 * 60_000 - 5_000);
      await store.restore(id, chainId, entry(coll), batches(chain('5', w('8b1'), w('8b2'))), KEY);
      expect(await store.collection(chainId, coll)).toMatchObject({ transfers: 2, restoreNote: null, restoreNoteKey: null, restoreRetryAt: null });
      expect(await failures()).toBe(0);
      await drop(chainId, coll);
    });

    it('waits an hour at most, however many loads failed in a row', async () => {
      const coll = w('8ee');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      await store.pool.query('UPDATE washtrace.collections SET restore_failures = 2000 WHERE id = $1', [id]);
      const lost = (async function* (): AsyncIterable<Transfer[]> { throw Object.assign(new Error('connection lost'), { code: '08006' }); })();
      await expect(store.restore(id, chainId, entry(coll), lost, KEY)).rejects.toThrow('connection lost');
      const c = (await store.collection(chainId, coll))!;
      expect(c.restoreRetryAt! - Date.now()).toBeGreaterThan(60 * 60_000 - 5_000);
      expect(c.restoreRetryAt! - Date.now()).toBeLessThan(60 * 60_000 + 5_000);
      await drop(chainId, coll);
    });

    it('forgets a note, its key and any back-off, when the stored data no longer applies', async () => {
      const coll = w('8ef');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      await store.pool.query("UPDATE washtrace.collections SET restore_note = 'x', restore_note_key = 'k', restore_failures = 3, restore_retry_at = now() WHERE id = $1", [id]);
      await store.clearRestoreNote(id);
      expect(await store.collection(chainId, coll)).toMatchObject({ restoreNote: null, restoreNoteKey: null, restoreRetryAt: null });
      expect((await store.pool.query('SELECT restore_failures FROM washtrace.collections WHERE id = $1', [id])).rows[0].restore_failures).toBe(0);
      await drop(chainId, coll);
    });

    it('holds no wallet while it loads, so funding is never kept waiting on it', async () => {
      const coll = w('8ea'), p = w('8b3'), q = w('8b4');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      const ts = chain('6', p, q).map((t, i) => ({ ...t, blockNumber: 20 + i }));
      await store.ingest(id, chainId, ts.slice(0, 1), 20, [p]);
      // What fund does to a wallet, from its own connection, with no patience for a lock.
      const probe = await store.pool.connect();
      await probe.query("SET lock_timeout = '500ms'");
      const funded: string[] = [];
      async function* loading(): AsyncIterable<Transfer[]> {
        yield ts;
        await probe.query("UPDATE washtrace.wallets SET status = 'done' WHERE chain_id = $1 AND address = $2", [chainId, p]);
        funded.push(p);
        yield [];
      }
      try {
        await store.restore(id, chainId, entry(coll), loading(), KEY);
      } finally {
        probe.release();
      }
      expect(funded).toEqual([p]);
      expect(await wallets(p, q)).toEqual({ [p]: 2, [q]: 1 });
      await drop(chainId, coll);
    });

    it('stops quietly when the collection is paused midway, and lets a delete through at once', async () => {
      const coll = w('8eb');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      let deleting: Promise<boolean> | null = null;
      async function* paused(): AsyncIterable<Transfer[]> {
        yield chain('7', w('8b5'), w('8b6'));
        await store.pause(chainId, coll);
        deleting = store.removeCollection(chainId, coll);
        await new Promise((r) => setTimeout(r, 200));
        now += 2_000;
        yield chain('8', w('8b7'));
        throw new Error('read on after the pause');
      }
      try {
        await expect(store.restore(id, chainId, entry(coll), paused(), KEY)).resolves.toBeUndefined();
      } finally {
        vi.restoreAllMocks();
      }
      expect(await deleting).toBe(true);
      expect(await store.collection(chainId, coll)).toBeNull();
    });

    it('stops quietly when paused midway, with no note and no progress left', async () => {
      const coll = w('8ec');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      async function* paused(): AsyncIterable<Transfer[]> {
        yield chain('9', w('8b8'), w('8b9'));
        await store.pause(chainId, coll);
        now += 2_000;
        yield chain('10', w('8ba'));
      }
      try {
        await expect(store.restore(id, chainId, entry(coll), paused(), KEY)).resolves.toBeUndefined();
      } finally {
        vi.restoreAllMocks();
      }
      expect(await store.collection(chainId, coll)).toMatchObject({ transfers: 0, cursorBlock: 9, restoreProgress: null, restoreNote: null, storedThroughTime: null, storedThroughBlock: null });
      await drop(chainId, coll);
    });

    it('shows its progress outside the load while the transfers stay unseen until it commits', async () => {
      const coll = w('8e5');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      const ts = chain('3', w('8a6'), w('8a7')).map((t, i) => ({ ...t, blockNumber: 20 + i }));
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const seen: { progress: number | null; transfers: number }[] = [];
      async function* watched(): AsyncIterable<Transfer[]> {
        yield ts.slice(0, 1);
        // Two seconds on: the next batch first writes the progress so far.
        now += 2_000;
        yield ts.slice(1, 2);
        const c = (await store.collection(chainId, coll))!;
        seen.push({ progress: c.restoreProgress, transfers: c.transfers });
        yield [];
      }
      try {
        await store.restore(id, chainId, entry(coll, { transfers: { file: 'x', rows: 3, bytes: 0, sha256: '' } }), watched(), KEY);
      } finally {
        vi.restoreAllMocks();
      }
      expect(seen).toHaveLength(1);
      expect(seen[0]!.progress).toBeCloseTo(1 / 3, 5);
      expect(seen[0]!.transfers).toBe(0);
      expect(await store.collection(chainId, coll)).toMatchObject({ transfers: 2, restoreProgress: null });
      await drop(chainId, coll);
    });

    it('drops a load quietly when the collection was deleted under it', async () => {
      const coll = w('8e6');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      await drop(chainId, coll);
      await expect(store.restore(id, chainId, entry(coll), batches(chain('4', w('8a8'))), KEY)).resolves.toBeUndefined();
      expect(await store.collection(chainId, coll)).toBeNull();
    });

    it('clears the progress a worker that died mid-load left behind, and keeps any note', async () => {
      const coll = w('8e7');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      await store.pool.query("UPDATE washtrace.collections SET restore_progress = 0.5, restore_note = 'kept' WHERE id = $1", [id]);
      await store.clearRestoreProgress();
      expect(await store.collection(chainId, coll)).toMatchObject({ restoreProgress: null, restoreNote: 'kept' });
      await drop(chainId, coll);
    });
  });

  describe('downloading stored data', () => {
    const chainId = 9;
    const failures = async (id: number) => (await store.pool.query('SELECT download_failures FROM washtrace.collections WHERE id = $1', [id])).rows[0].download_failures;

    it('downloadFailed backs off on the restore curve, and downloadDone clears it', async () => {
      const coll = w('9d1');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      expect(await store.setDownload(id, 'transfers', 0.25)).toBe(true);
      expect(await store.collection(chainId, coll)).toMatchObject({ downloadFile: 'transfers', downloadProgress: 0.25, downloadNote: null, downloadRetryAt: null });
      const started = Date.now();
      await store.downloadFailed(id, 'could not');
      const c = (await store.collection(chainId, coll))!;
      expect(c).toMatchObject({ downloadFile: null, downloadProgress: null, downloadNote: 'could not' });
      expect(await failures(id)).toBe(1);
      expect(c.downloadRetryAt! - started).toBeGreaterThan(5 * 60_000 - 5_000);
      expect(c.downloadRetryAt! - started).toBeLessThan(5 * 60_000 + 5_000);
      await store.downloadFailed(id, 'could not');
      expect((await store.collection(chainId, coll))!.downloadRetryAt! - Date.now()).toBeGreaterThan(10 * 60_000 - 5_000);
      // An hour at most, however many in a row.
      await store.pool.query('UPDATE washtrace.collections SET download_failures = 2000 WHERE id = $1', [id]);
      await store.downloadFailed(id, 'could not');
      const capped = (await store.collection(chainId, coll))!.downloadRetryAt! - Date.now();
      expect(capped).toBeGreaterThan(60 * 60_000 - 5_000);
      expect(capped).toBeLessThan(60 * 60_000 + 5_000);
      await store.setDownload(id, 'trail', 0.5);
      await store.downloadDone(id);
      expect(await store.collection(chainId, coll)).toMatchObject({ downloadFile: null, downloadProgress: null, downloadNote: null, downloadRetryAt: null });
      expect(await failures(id)).toBe(0);
      await drop(chainId, coll);
    });

    it('clearDownloadNote drops the note, and the back-off only when asked', async () => {
      const coll = w('9d4');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      await store.downloadFailed(id, 'could not');
      await store.clearDownloadNote(id, false);
      expect(await store.collection(chainId, coll)).toMatchObject({ downloadNote: null });
      expect((await store.collection(chainId, coll))!.downloadRetryAt).not.toBeNull();
      expect(await failures(id)).toBe(1);
      await store.downloadFailed(id, 'could not');
      await store.clearDownloadNote(id, true);
      expect(await store.collection(chainId, coll)).toMatchObject({ downloadNote: null, downloadRetryAt: null });
      expect(await failures(id)).toBe(0);
      await drop(chainId, coll);
    });

    it('downloadFailed keeps the URL that did not match until another does, whatever fails or goes through meanwhile', async () => {
      const coll = w('9d5');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      expect((await store.collection(chainId, coll))!.downloadMismatch).toBeNull();
      await store.downloadFailed(id, 'bad bytes', 'https://hub/r1/t');
      expect((await store.collection(chainId, coll))!.downloadMismatch).toBe('https://hub/r1/t');
      // The other file failing for another reason, or going through, says nothing of those bytes.
      await store.downloadFailed(id, 'could not');
      await store.downloadDone(id);
      expect((await store.collection(chainId, coll))!.downloadMismatch).toBe('https://hub/r1/t');
      await store.downloadFailed(id, 'bad bytes', 'https://hub/r2/t');
      expect((await store.collection(chainId, coll))!.downloadMismatch).toBe('https://hub/r2/t');
      await drop(chainId, coll);
    });

    it('a collection waiting its turn is a file with no progress, and a restart clears it', async () => {
      const coll = w('9d5');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      expect(await store.setDownload(id, 'transfers', null)).toBe(true);
      expect(await store.collection(chainId, coll)).toMatchObject({ downloadFile: 'transfers', downloadProgress: null });
      await store.clearDownloads();
      expect(await store.collection(chainId, coll)).toMatchObject({ downloadFile: null, downloadProgress: null });
      await drop(chainId, coll);
    });

    it('writes no progress for a collection paused or deleted, and says the download should stop', async () => {
      const coll = w('9d2');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      await store.pause(chainId, coll);
      expect(await store.setDownload(id, 'transfers', 0.25)).toBe(false);
      expect(await store.collection(chainId, coll)).toMatchObject({ downloadFile: null, downloadProgress: null });
      await store.removeCollection(chainId, coll);
      expect(await store.setDownload(id, 'transfers', 0.5)).toBe(false);
    });

    it('clearDownloads clears what a restart left', async () => {
      const coll = w('9d3');
      const { id } = await store.addCollection(chainId, coll, null, 10);
      await store.setDownload(id, 'transfers', 0.4);
      await store.pool.query("UPDATE washtrace.collections SET download_note = 'kept', download_retry_at = now() + interval '1 hour' WHERE id = $1", [id]);
      await store.clearDownloads();
      const c = (await store.collection(chainId, coll))!;
      expect(c).toMatchObject({ downloadFile: null, downloadProgress: null, downloadNote: 'kept' });
      expect(c.downloadRetryAt).not.toBeNull();
      await drop(chainId, coll);
    });
  });

  describe('loading a money trail', () => {
    type Batch = { checked: string[]; flows: Flow[] };
    /** A trail's reader: each call reads it from the start, as readTrail does, checked addresses first. */
    const trailOf = (...bs: Batch[]) => () => (async function* () { for (const b of bs) yield b; })();
    const walletRows = async (chainId: number) => (await store.pool.query(
      `SELECT address, transfers, status, truncated, depth, extract(epoch FROM fetched_at)::float8 * 1000 AS fetched
       FROM washtrace.wallets WHERE chain_id = $1 ORDER BY address`, [chainId])).rows;
    const flowRows = async (chainId: number) => (await store.pool.query(
      `SELECT tx_hash, kind, from_address, to_address, value_wei::text AS v, token, block_number::text AS bn, extract(epoch FROM block_time)::float8 AS bt
       FROM washtrace.flows WHERE chain_id = $1 ORDER BY tx_hash, from_address, to_address`, [chainId])).rows;
    const version = async (id: number) => Number((await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id])).rows[0].version);

    const p = w('9a1'), q = w('9a2'), m = w('9a3'), deep = w('9a5'), kept = w('9a6'), x1 = w('9a7');
    const local = flow(p, x1);
    const trail: Batch[] = [
      { checked: [p, q, m], flows: [] },
      // The flow p's own check already stored, read again from the trail: one edge, not two.
      { checked: [], flows: [{ ...local }, flow(q, m)] },
      { checked: [], flows: [flow(m, p)] },
    ];

    /** A chain's store before the import: p checked here, q queued, a followed wallet two hops out, and one followed and checked. */
    async function before(chainId: number, address: string): Promise<number> {
      const { id } = await store.addCollection(chainId, address, null, 10);
      await store.ingest(id, chainId, chain('1', p, q).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, [p, p, q]);
      await store.saveMoney(chainId, p, [local], false);
      await store.pool.query('INSERT INTO washtrace.wallets (chain_id, address, depth) VALUES ($1, $2, 2), ($1, $3, 1)', [chainId, deep, kept]);
      await store.saveMoney(chainId, kept, [], false);
      return id;
    }

    it('merges a trail into what this store checked: its own checks stand, new ones come in, flows add once', async () => {
      await store.migrate(); // a no-op in a full run; lets this block run by itself
      const id = await before(9, w('9c1'));
      const other = (await store.addCollection(9, w('9c2'), null, 10)).id;
      const elsewhere = (await store.addCollection(1, w('9c3'), null, 10)).id;
      const was = Object.fromEntries((await walletRows(9)).map((r) => [r.address, r]));
      const versions = [await version(id), await version(other), await version(elsewhere)];

      await store.importTrail(id, 9, 'feed', trailOf(...trail));

      const now = Object.fromEntries((await walletRows(9)).map((r) => [r.address, r]));
      // Checked here first: kept as it was, its count and its check.
      expect(now[p]).toEqual(was[p]);
      expect(now[kept]).toEqual(was[kept]);
      // Queued here, checked in the trail: done now, its count still this store's, and no time it was read.
      expect(now[q]).toMatchObject({ status: 'done', transfers: 1, truncated: false, depth: 0, fetched: null });
      // New here: it trades nothing in this collection, so a followed wallet, counting no transfer this store has not seen.
      expect(now[m]).toMatchObject({ status: 'done', transfers: 0, depth: 1 });
      // Not on the trail's list: left as it was.
      expect(now[deep]).toEqual(was[deep]);
      expect((await flowRows(9)).map((r) => [r.from_address, r.to_address])).toEqual(expect.arrayContaining([[p, x1], [q, m], [m, p]]));
      expect(await flowRows(9)).toHaveLength(3);
      expect(await store.collection(9, w('9c1'))).toMatchObject({ trailImportedSha: 'feed', trailNote: null });
      expect(await store.collection(9, w('9c2'))).toMatchObject({ trailImportedSha: null });
      // Every collection on the chain reads it again; one on another chain does not.
      expect([await version(id), await version(other), await version(elsewhere)]).toEqual([versions[0]! + 1, versions[1]! + 1, versions[2]]);
      await drop(1, w('9c3'));
    });

    it('changes nothing when the same trail is loaded again', async () => {
      const id = (await store.collection(9, w('9c1')))!.id;
      const [wallets, flows] = [await walletRows(9), await flowRows(9)];
      await store.importTrail(id, 9, 'feed', trailOf(...trail));
      expect(await walletRows(9)).toEqual(wallets);
      expect(await flowRows(9)).toEqual(flows);
    });

    it('marks no wallet done before its flows are in, and a load cut off and run again ends as one clean run', async () => {
      const clean = await before(10, w('10c1'));
      await store.importTrail(clean, 10, 'feed', trailOf(...trail));

      const cut = await before(11, w('11c1'));
      const before11 = await walletRows(11);
      // Cut off in the flows (the first pass): no wallet has changed.
      let reads = 0;
      const lostInFlows = () => (async function* () {
        reads += 1;
        yield* trail.slice(0, 2);
        throw new Error('connection lost');
      })();
      await expect(store.importTrail(cut, 11, 'feed', lostInFlows)).rejects.toThrow('connection lost');
      expect(reads).toBe(1);
      expect(await walletRows(11)).toEqual(before11);
      // Cut off in the wallets (the second pass): their flows are all in already.
      reads = 0;
      const lostInWallets = () => (async function* () {
        reads += 1;
        if (reads === 1) { yield* trail; return; }
        yield trail[0]!;
        throw new Error('connection lost');
      })();
      await expect(store.importTrail(cut, 11, 'feed', lostInWallets)).rejects.toThrow('connection lost');
      expect((await walletRows(11)).find((r) => r.address === q)).toMatchObject({ status: 'done' });
      expect(await flowRows(11)).toHaveLength(3);
      // Not loaded yet, so the next pass loads it again.
      expect(await store.collection(11, w('11c1'))).toMatchObject({ trailImportedSha: null });

      await store.importTrail(cut, 11, 'feed', trailOf(...trail));
      const strip = (rows: any[]) => rows.map(({ fetched: _, ...r }) => r);
      expect(strip(await walletRows(11))).toEqual(strip(await walletRows(10)));
      expect(await flowRows(11)).toEqual(await flowRows(10));
      expect(await store.collection(11, w('11c1'))).toMatchObject({ trailImportedSha: 'feed' });
    });

    it('takes a value the store refuses as a bad file, not a store failure, and marks no wallet done', async () => {
      const id = await before(16, w('16c1'));
      const was = await walletRows(16);
      const bad = [trail[0]!, { checked: [], flows: [flow(q, m, { valueWei: 'not a number' })] }];
      const err = await store.importTrail(id, 16, 'feed', trailOf(...bad)).catch((e) => e);
      expect(err).toBeInstanceOf(StoredDataError);
      expect(err.kind).toBe('unreadable');
      expect(await walletRows(16)).toEqual(was);
    });

    it('importTrail stops between batches when its signal aborts, and a second run completes it', async () => {
      const clean = await before(21, w('21c1'));
      await store.importTrail(clean, 21, 'feed', trailOf(...trail));
      const id = await before(20, w('20c1'));
      const was = await walletRows(20);
      const abort = new AbortController();
      // Stopped once the second batch's flows are in: the third is never written.
      const onFlows = (n: number) => { if (n >= 2) abort.abort('stopped'); };
      const err = await store.importTrail(id, 20, 'feed', trailOf(...trail), { onFlows, signal: abort.signal }).catch((e) => e);
      expect(err).toBe('stopped');
      expect((await flowRows(20)).map((r) => [r.from_address, r.to_address])).not.toContainEqual([m, p]);
      expect(await walletRows(20)).toEqual(was);
      expect(await store.collection(20, w('20c1'))).toMatchObject({ trailImportedSha: null });
      await store.importTrail(id, 20, 'feed', trailOf(...trail), { signal: new AbortController().signal });
      const strip = (rows: any[]) => rows.map(({ fetched: _, ...r }) => r);
      expect(strip(await walletRows(20))).toEqual(strip(await walletRows(21)));
      expect(await flowRows(20)).toEqual(await flowRows(21));
      expect(await store.collection(20, w('20c1'))).toMatchObject({ trailImportedSha: 'feed' });
    });

    it('importTrail reports flows as each batch commits', async () => {
      const id = await before(22, w('22c1'));
      const totals: number[] = [];
      await store.importTrail(id, 22, 'feed', trailOf(...trail), { onFlows: (n) => totals.push(n) });
      // A running count, once a batch: the trail's first batch holds no flow, then two, then one.
      expect(totals).toEqual([0, 2, 3]);
    });

    it('importTrail cut off in its flows goes on from the last batch that committed, not from the start', async () => {
      const id = await before(40, w('40c1'));
      const pairs = async () => (await flowRows(40)).map((r) => [r.from_address, r.to_address]);
      const abort = new AbortController();
      await store.importTrail(id, 40, 'feed', trailOf(...trail), { onFlows: (n) => { if (n >= 2) abort.abort('stopped'); }, signal: abort.signal }).catch(() => {});
      // Gone behind the import's back: a run from the start would put it back.
      await store.pool.query('DELETE FROM washtrace.flows WHERE chain_id = 40 AND from_address = $1 AND to_address = $2', [q, m]);
      const totals: number[] = [];
      await store.importTrail(id, 40, 'feed', trailOf(...trail), { onFlows: (n) => totals.push(n) });
      // The progress moves through the batches that committed, and only the third is written.
      expect(totals).toEqual([0, 2, 3]);
      expect(await pairs()).not.toContainEqual([q, m]);
      expect(await pairs()).toContainEqual([m, p]);
      expect(await store.collection(40, w('40c1'))).toMatchObject({ trailImportedSha: 'feed' });
      // A finished import leaves nothing to go on from: loaded again, it reads from the start.
      await store.importTrail(id, 40, 'feed', trailOf(...trail));
      expect(await pairs()).toContainEqual([q, m]);
    });

    it('importTrail starts another trail from its start, whatever an earlier one got to', async () => {
      const id = await before(41, w('41c1'));
      const abort = new AbortController();
      await store.importTrail(id, 41, 'feed', trailOf(...trail), { onFlows: (n) => { if (n >= 2) abort.abort('stopped'); }, signal: abort.signal }).catch(() => {});
      await store.pool.query('DELETE FROM washtrace.flows WHERE chain_id = 41 AND from_address = $1 AND to_address = $2', [q, m]);
      const totals: number[] = [];
      await store.importTrail(id, 41, 'cafe', trailOf(...trail), { onFlows: (n) => totals.push(n) });
      expect(totals).toEqual([0, 2, 3]);
      expect((await flowRows(41)).map((r) => [r.from_address, r.to_address])).toContainEqual([q, m]);
    });

    it('importTrail retries a statement that deadlocks', async () => {
      const clean = await before(24, w('24c1'));
      await store.importTrail(clean, 24, 'feed', trailOf(...trail));
      const id = await before(23, w('23c1'));
      // Each kind of statement the import runs deadlocks once: the flows, the wallets, the final mark.
      // Each runs on a connection of its own, in a transaction of its own (see importTrail), so the connections are what is overridden.
      const deadlocked = new Set<string>();
      const connect = store.pool.connect.bind(store.pool) as () => Promise<pgClient.PoolClient>;
      (store.pool as any).connect = async () => {
        const client = await connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as any).query = (text: unknown, ...rest: unknown[]) => {
          const kind = typeof text === 'string' ? ['INSERT INTO washtrace.flows', 'INSERT INTO washtrace.wallets', 'UPDATE washtrace.collections SET version'].find((k) => text.includes(k)) : undefined;
          if (kind !== undefined && !deadlocked.has(kind)) {
            deadlocked.add(kind);
            return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
          }
          return query(text, ...rest);
        };
        const release = client.release;
        client.release = (err?: Error | boolean) => {
          delete (client as any).query;
          client.release = release;
          return release(err);
        };
        return client;
      };
      try {
        await store.importTrail(id, 23, 'feed', trailOf(...trail));
      } finally {
        delete (store.pool as any).connect;
      }
      expect(deadlocked.size).toBe(3);
      const strip = (rows: any[]) => rows.map(({ fetched: _, ...r }) => r);
      expect(strip(await walletRows(23))).toEqual(strip(await walletRows(24)));
      expect(await flowRows(23)).toEqual(await flowRows(24));
      expect(await store.collection(23, w('23c1'))).toMatchObject({ trailImportedSha: 'feed' });
    });

    it('importTrail gives up a statement waiting on a lock for longer than its lock timeout, and does not retry it', async () => {
      const id = await before(27, w('27c1'));
      // Another writer holds the chain's collection rows, which the final statement locks.
      const blocker = await store.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM washtrace.collections WHERE chain_id = 27 FOR UPDATE');
      // Five minutes in the worker; a fifth of a second here.
      store.trailLockTimeout = () => '200ms';
      try {
        const err = await store.importTrail(id, 27, 'feed', trailOf(...trail)).catch((e) => e);
        expect(err).not.toBeInstanceOf(StoredDataError);
        expect(err.code).toBe('55P03');
      } finally {
        delete (store as any).trailLockTimeout;
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(await store.collection(27, w('27c1'))).toMatchObject({ trailImportedSha: null });
      // With the lock free, it goes through, on the five minutes as the worker runs it.
      await store.importTrail(id, 27, 'feed', trailOf(...trail));
      expect(await store.collection(27, w('27c1'))).toMatchObject({ trailImportedSha: 'feed' });
    });

    it('importTrail\'s version bump skips a paused collection: it is not bumped, and a lock held on it does not hold the import', async () => {
      const id = await before(28, w('28c1'));
      const paused = (await store.addCollection(28, w('28c2'), null, 10)).id;
      await store.pool.query('UPDATE washtrace.collections SET paused_at = now() WHERE id = $1', [paused]);
      const [mine, theirs] = [await version(id), await version(paused)];
      const blocker = await store.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM washtrace.collections WHERE id = $1 FOR UPDATE', [paused]);
      store.trailLockTimeout = () => '200ms';
      try {
        await store.importTrail(id, 28, 'feed', trailOf(...trail));
      } finally {
        delete (store as any).trailLockTimeout;
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(await version(id)).toBe(mine + 1);
      expect(await version(paused)).toBe(theirs);
    });

    it('importTrail\'s final statement clears the collection\'s trail progress', async () => {
      const id = await before(25, w('25c1'));
      const other = (await store.addCollection(25, w('25c2'), null, 10)).id;
      expect(await store.setTrailProgress(id, 0.5)).toBe(true);
      expect(await store.setTrailProgress(other, 0.25)).toBe(true);
      expect(await store.collection(25, w('25c1'))).toMatchObject({ trailProgress: 0.5 });
      await store.importTrail(id, 25, 'feed', trailOf(...trail));
      expect(await store.collection(25, w('25c1'))).toMatchObject({ trailProgress: null, trailImportedSha: 'feed' });
      // Another collection's import is its own: its progress stays.
      expect(await store.collection(25, w('25c2'))).toMatchObject({ trailProgress: 0.25 });
    });

    it('setTrailProgress refuses a paused row, and clearTrailProgress clears every row', async () => {
      const live = (await store.addCollection(26, w('26c1'), null, 10)).id;
      const paused = (await store.addCollection(26, w('26c2'), null, 10)).id;
      expect(await store.setTrailProgress(live, 0.25)).toBe(true);
      expect(await store.setTrailProgress(paused, 0.5)).toBe(true);
      await store.pause(26, w('26c2'));
      expect(await store.setTrailProgress(paused, 0.75)).toBe(false);
      expect(await store.collection(26, w('26c2'))).toMatchObject({ trailProgress: 0.5 });
      // Clearing always writes, paused or not.
      expect(await store.setTrailProgress(paused, null)).toBe(false);
      expect(await store.collection(26, w('26c2'))).toMatchObject({ trailProgress: null });
      // Gone: nothing to write.
      expect(await store.setTrailProgress(-1, 0.25)).toBe(false);
      await store.clearTrailProgress();
      expect(await store.collection(26, w('26c1'))).toMatchObject({ trailProgress: null });
      expect((await store.collections()).filter((c) => c.trailProgress !== null)).toEqual([]);
    });

    it('holds no wallet between batches, so funding is never kept waiting on it', async () => {
      const id = await before(12, w('12c1'));
      const probe = await store.pool.connect();
      await probe.query("SET lock_timeout = '500ms'");
      const funded: string[] = [];
      let reads = 0;
      const open = () => (async function* () {
        reads += 1;
        yield trail[0]!;
        if (reads === 2) {
          // What fund does to a wallet the load has just written, from its own connection.
          await probe.query("UPDATE washtrace.wallets SET error = NULL, fetched_at = now() WHERE chain_id = 12 AND address = $1", [q]);
          funded.push(q);
        }
        yield* trail.slice(1);
      })();
      try {
        await store.importTrail(id, 12, 'feed', open);
      } finally {
        probe.release();
      }
      expect(funded).toEqual([q]);
    });

    it('cuts a trail of checked wallets, leaving out the truncated and the unchecked', async () => {
      const all = async <T>(rows: AsyncIterable<T>) => { const out: T[] = []; for await (const r of rows) out.push(r); return out; };
      const coll = w('13c1'), ta = w('13a1'), tb = w('13a2'), tc = w('13a3'), td = w('13a4'), e = w('13e1'), f1 = w('13f1');
      const { id } = await store.addCollection(13, coll, null, 10);
      await store.ingest(id, 13, chain('1', ta, tb, tc, td).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, [ta, tb, tc, td]);
      await store.saveMoney(13, ta, [flow(ta, e)], false, { hops: 2, fanout: 3, exclude: [] });
      await store.saveMoney(13, tb, [flow(tb, f1)], true);
      await store.moneyFailed(13, td, 'rate limited');
      await store.saveMoney(13, e, [flow(e, f1)], false);
      const cut = await store.trail(id, 13);
      expect(await all(cut.addresses)).toEqual([ta, e].sort());
      expect({ checked: cut.checked, of: cut.of }).toEqual({ checked: 1, of: 4 });
    });

    describe('a v2 trail', () => {
      const asTrail = (checked: string[], flows: Flow[]) => () => (async function* () { yield { checked, flows }; })();

      it('imports: checked traders at depth 0, others at depth 1, flows in', async () => {
        const coll = w('17c1'), t1 = w('17a1'), t2 = w('17a2'), x = w('17b1'), y = w('17b2');
        const { id } = await store.addCollection(17, coll, null, 10);
        await store.ingest(id, 17, chain('1', t1, t2).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, [t1, t2]);
        const done = await store.importTrail(id, 17, 'cafe', asTrail([t1, x], [flow(t1, x), flow(x, y)]));
        expect(done).toEqual({ wallets: 2, flows: 2 });
        const rows = Object.fromEntries((await walletRows(17)).map((r) => [r.address, r]));
        expect(rows[t1]).toMatchObject({ status: 'done', depth: 0, truncated: false, fetched: null });
        expect(rows[x]).toMatchObject({ status: 'done', depth: 1, truncated: false, fetched: null });
        // y is only the end of a flow: nothing says it was checked, so it is not here.
        expect(rows[y]).toBeUndefined();
        // t2 was not on the list: it keeps what this store has of it.
        expect(rows[t2]).toMatchObject({ status: 'pending', depth: 0 });
        expect(await flowRows(17)).toHaveLength(2);
        expect(await store.collection(17, coll)).toMatchObject({ trailImportedSha: 'cafe' });
      });

      it('a local done wallet keeps its own check and depth on import', async () => {
        const coll = w('18c1'), t1 = w('18a1');
        const { id } = await store.addCollection(18, coll, null, 10);
        await store.ingest(id, 18, chain('1', t1, t1).map((t, i) => ({ ...t, blockNumber: 20 + i })), 50, [t1]);
        await store.saveMoney(18, t1, [], true);
        const was = (await walletRows(18))[0];
        expect(was).toMatchObject({ status: 'done', truncated: true });
        await store.importTrail(id, 18, 'cafe', asTrail([t1], []));
        expect((await walletRows(18))[0]).toEqual(was);
      });
    });

    it('storedHeader gives the contract\'s own name, not the console label', async () => {
      const coll = w('19c1');
      await store.addCollection(19, coll, 'My label', 10);
      await store.pool.query('UPDATE washtrace.collections SET contract_name = $2 WHERE chain_id = 19 AND address = $1', [coll, 'Bored Ape Yacht Club']);
      expect(await store.storedHeader(19, coll)).toMatchObject({ name: 'My label', contractName: 'Bored Ape Yacht Club' });
    });

    describe('from a file on disk', () => {
      let dir: string;
      beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'washtrace-trail-int-')); });
      afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
      const entry = (chainId: number, address: string, files: TrailFiles): StoredEntry => ({
        // Through block 40: a collection read to 50 (see before) is past its transfers, and only its trail is due.
        chainId, address, name: 'Trailed', startBlock: 5, throughBlock: 40, throughTime: 1_700_000_100_000,
        transfers: { file: `${chainId}-${address}.transfers.csv.zst`, rows: 0, bytes: 0, sha256: '' },
        trail: { rows: 3, wallets: 3, checked: 2, of: 2, bytes: files.wallets.bytes + files.flows.bytes, sha256: trailSha(files), files },
      });
      const worker = (key: string | null) => new Worker(
        store, () => ({ rpc: new Map(), etherscanKey: key, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), pg.getConnectionUri(), dir,
      );
      const none: TrailFiles = { wallets: { bytes: 0, sha256: '' }, flows: { bytes: 0, sha256: '' } };
      const written = async (e: StoredEntry) => writeTrail(trailPaths(dir, e), {
        checked: trail.flatMap((b) => b.checked).sort(),
        flows: trail.flatMap((b) => b.flows),
      });

      it('loads a trail that matches the manifest once, and the money lenses run on it with no key', async () => {
        const coll = w('14c1');
        const id = await before(14, coll);
        const { files } = await written(entry(14, coll, none));
        const e = entry(14, coll, files);
        const sha256 = trailSha(files);
        const w14 = worker(null);
        const mine = async () => (await store.collections()).filter((c) => c.chainId === 14);
        // Another collection on the chain, with no trail of its own.
        const z = (await store.addCollection(14, w('14c2'), null, 10)).id;
        expect(await store.importedMoney(id)).toBe(false);
        await (w14.sync as any).trails((await mine()).filter((c) => c.id === id), { version: 3, collections: [e] });
        // The import runs in the background: wait for it.
        await (w14.sync as any).importing?.done;
        expect(await store.collection(14, coll)).toMatchObject({ trailImportedSha: sha256, trailNote: null });
        expect(await flowRows(14)).toHaveLength(3);
        expect(await store.importedMoney(id)).toBe(true);
        // Checked wallets on its chain are not its funding: no trail of its own, no key, no money lenses.
        expect(await store.importedMoney(z)).toBe(false);
        // Loaded: not loaded again.
        let read = 0;
        (w14.sync as any).storedTrail = (e: StoredEntry, verify: boolean) => { read += 1; return readTrail(trailPaths(dir, e), e.trail!.files, verify); };
        await (w14.sync as any).trails(await mine(), { version: 3, collections: [e] });
        expect(read).toBe(0);

        // No key, but checked wallets from the trail: the money lenses run.
        const analyse = async (which: number) => {
          const only = Object.assign(Object.create(store), { stale: async () => (await store.stale()).filter((s) => s.id === which) });
          const analyst = new Worker(only, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), pg.getConnectionUri(), dir);
          analyst.analyzeOff = (request) => analyzeStored(store, request);
          await analyst.run('analyze');
        };
        await analyse(id);
        const latest = (await store.collection(14, coll))!.latest!;
        expect(latest.totals.AU.available).toBe(true);
        expect(latest.totals.AC.available).toBe(true);
        await analyse(z);
        expect((await store.collection(14, w('14c2')))!.latest!.totals.AU.available).toBe(false);
      });

      it('loads nothing from a trail that does not match the manifest, and says so', async () => {
        const coll = w('15c1');
        await store.addCollection(15, coll, null, 10);
        const { files } = await written(entry(15, coll, none));
        const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await (worker(null).sync as any).trails([(await store.collection(15, coll))!], { version: 3, collections: [entry(15, coll, { ...files, flows: { ...files.flows, sha256: 'b'.repeat(64) } })] });
        logged.mockRestore();
        expect(await walletRows(15)).toEqual([]);
        expect(await flowRows(15)).toEqual([]);
        expect(await store.collection(15, coll)).toMatchObject({
          trailImportedSha: null, trailNote: 'Money trail on disk does not match the stored data, so it was not loaded.',
        });
      });
    });
  });
});

describe('Store.search', () => {
  const hex = (s: string) => '0x' + s.padEnd(40, '0');
  const c1 = hex('5ea0'), c2 = hex('5eb0');
  const tx = '0x' + 'd'.repeat(64);
  const alice = hex('ab12'), bob = hex('ab34'), carol = hex('cd56');

  it('finds collections by name, tokens by number in each collection, wallets by the start of their address, and trades by hash', async () => {
    await store.migrate();
    const one = (await store.addCollection(1, c1, 'Searchable Apes', 1)).id;
    const two = (await store.addCollection(10, c2, 'Searchable Cats', 1)).id;
    await store.ingest(one, 1, [...chain('7', alice, bob), ...chain('8', alice)], 100, [alice, bob, alice]);
    await store.ingest(two, 10, [transfer('7', carol, alice, { txHash: tx })], 100, [carol, alice]);
    try {
      // A name, on every chain, in any case; `%` and `_` are only themselves.
      const byName = await store.search({ kind: 'text', text: 'SEARCHABLE' });
      expect(byName.collections.map((r) => r.address).sort()).toEqual([c1, c2]);
      expect(byName.more.collections).toBe(false);
      expect((await store.search({ kind: 'text', text: '100%' })).collections).toEqual([]);
      expect((await store.search({ kind: 'text', text: '%' })).collections).toEqual([]);
      // A hit carries its latest analysis's totals, and none before the first.
      expect(byName.collections.map((r) => r.totals)).toEqual([null, null]);
      const save = (n: number) => store.pool.query(
        `INSERT INTO washtrace.analyses (collection_id, took_ms, through_block, totals, missing_data, funded_wallets, wallets, truncated_searches)
         VALUES ($1, 1, 100, $2, 0, 0, 0, 0)`, [one, JSON.stringify({ A: { sales: n } })]);
      await save(1);
      await save(2);
      expect((await store.search({ kind: 'address', address: c1 })).collections[0]!.totals).toEqual({ A: { sales: 2 } });

      // Token 7 is in both collections, token 8 in one; busiest first.
      const tokens = (await store.search({ kind: 'token', tokenId: '7', text: '7' })).tokens;
      expect(tokens.map((r) => [r.address, r.tokenId, r.transfers])).toEqual([[c1, '7', 2], [c2, '7', 1]]);
      expect((await store.search({ kind: 'token', tokenId: '8', text: '8' })).tokens.map((r) => r.address)).toEqual([c1]);
      expect((await store.search({ kind: 'token', tokenId: '999', text: '999' })).tokens).toEqual([]);

      // Wallets by the start of their address, collections by the start of theirs.
      const wallets = (await store.search({ kind: 'prefix', prefix: '0xab' })).wallets;
      // A wallet is per chain: alice is on both, busiest first.
      expect(wallets.map((r) => [r.chainId, r.address, r.transfers])).toEqual([[1, alice, 2], [1, bob, 1], [10, alice, 1]]);
      expect((await store.search({ kind: 'prefix', prefix: '0x5ea' })).collections.map((r) => r.address)).toEqual([c1]);
      expect((await store.search({ kind: 'address', address: c2 })).collections.map((r) => r.address)).toEqual([c2]);
      expect((await store.search({ kind: 'address', address: carol })).wallets.map((r) => r.address)).toEqual([carol]);

      // In one collection: its tokens, the wallets that traded it; a full address and a hash ignore the scope.
      const scope = { id: one, chainId: 1 };
      expect((await store.search({ kind: 'token', tokenId: '7', text: '7' }, { scope })).tokens.map((r) => r.address)).toEqual([c1]);
      const inOne = (await store.search({ kind: 'prefix', prefix: '0xab' }, { scope: { id: two, chainId: 10 } })).wallets;
      expect(inOne.map((r) => [r.chainId, r.address, r.here])).toEqual([[10, alice, true]]);
      expect((await store.search({ kind: 'prefix', prefix: '0xcd' }, { scope })).wallets).toEqual([]);
      // Carol is found by her full address, and marked as never having traded in the scope.
      expect((await store.search({ kind: 'address', address: carol }, { scope })).wallets.map((r) => [r.address, r.here])).toEqual([[carol, false]]);
      expect((await store.search({ kind: 'address', address: carol })).wallets[0]).not.toHaveProperty('here');
      expect((await store.search({ kind: 'tx', tx }, { scope })).trades).toHaveLength(1);

      // A transaction.
      expect((await store.search({ kind: 'tx', tx })).trades).toEqual([{ chainId: 10, txHash: tx, address: c2, name: 'Searchable Cats', tokenId: '7' }]);
      expect(await store.search({ kind: 'empty' })).toMatchObject({ collections: [], tokens: [], wallets: [], trades: [] });
    } finally {
      await drop(1, c1);
      await drop(10, c2);
      await store.pool.query('DELETE FROM washtrace.wallets WHERE address = ANY($1)', [[alice, bob, carol]]);
    }
  });

  it('finds trades by the start of their hash, in every collection, on transfers_tx_idx', async () => {
    await store.migrate();
    const one = (await store.addCollection(1, c1, 'Searchable Apes', 1)).id;
    const two = (await store.addCollection(10, c2, 'Searchable Cats', 1)).id;
    const h = (start: string, fill: string) => start + fill.repeat(66 - start.length);
    // Each pair sits either side of a prefix's end: 9 is followed by a, f by g.
    const [a, b, c, d, e, f, g] = [h('0x1ee2', 'a'), h('0x1ee2', 'b'), h('0x1ee3', 'a'), h('0x1ee9', 'a'), h('0x1eea', 'a'), h('0x1eef', 'a'), h('0x1ef0', 'a')];
    await store.ingest(one, 1, [
      transfer('1', alice, bob, { txHash: a }), transfer('2', alice, bob, { txHash: b }), transfer('3', bob, alice, { txHash: b, logIndex: 1 }),
      transfer('4', alice, bob, { txHash: d }), transfer('5', alice, bob, { txHash: e }), transfer('6', alice, bob, { txHash: f }),
    ], 100, [alice, bob]);
    await store.ingest(two, 10, [transfer('7', carol, alice, { txHash: c }), transfer('8', carol, alice, { txHash: g })], 100, [carol, alice]);
    const found = async (prefix: string, opts = {}) => (await store.search({ kind: 'prefix', prefix }, opts)).trades.map((r) => [r.txHash, r.tokenId]);
    try {
      expect(await found('0x1ee2')).toEqual([[a, '1'], [b, '2'], [b, '3']]);
      expect(await found('0x1ee9')).toEqual([[d, '4']]);
      expect(await found('0x1eef')).toEqual([[f, '6']]);
      expect(await found('0x1ee')).toEqual([[a, '1'], [b, '2'], [b, '3'], [c, '7'], [d, '4'], [e, '5'], [f, '6']]);
      expect(await found('0x1eef' + 'a'.repeat(30))).toEqual([[f, '6']]);
      expect(await found('0x1ee4')).toEqual([]);
      // The scope narrows wallets only: a hash's start, like the whole of one, is found wherever it is.
      expect(await found('0x1ee3', { scope: { id: one, chainId: 1 } })).toEqual([[c, '7']]);
      const cut = await store.search({ kind: 'prefix', prefix: '0x1ee' }, { limit: 2, offset: 1 });
      expect([cut.trades.map((r) => r.tokenId), cut.more.trades]).toEqual([['2', '3'], true]);

      const pg = await store.pool.connect();
      try {
        await pg.query('BEGIN');
        // Enough transfers that the planner costs an index scan, not a seq scan over a handful; rolled back.
        await pg.query(
          `INSERT INTO washtrace.transfers (collection_id, tx_hash, log_index, block_number, token_id, from_address, to_address)
           SELECT $1, '0x' || md5(g::text) || md5((g + 1)::text), 0, g, g, $2, $3 FROM generate_series(1, 20000) g`,
          [one, alice, bob],
        );
        await pg.query('ANALYZE washtrace.transfers');
        // Whether the index can serve the range, not whether these stats make it cheapest: with a seq scan priced out, the
        // planner still reads a range the index cannot serve some other way, and the index's own condition says it serves this one.
        await pg.query('SET LOCAL enable_seqscan = off');
        // Store.search's own read of a prefix's trades.
        const plan = (await pg.query(
          `EXPLAIN SELECT c.chain_id, t.tx_hash FROM washtrace.transfers t JOIN washtrace.collections c ON c.id = t.collection_id
           WHERE t.tx_hash >= $1 AND t.tx_hash < $2 AND t.tx_hash LIKE $1 || '%' ORDER BY t.tx_hash, c.id, t.log_index LIMIT 21`,
          ['0x1ee2', '0x1ee3'],
        )).rows.map((r) => r['QUERY PLAN']).join('\n');
        // A plain or a bitmap index scan, its condition on the line under it.
        expect(plan, plan).toMatch(/transfers_tx_idx.*\n\s*Index Cond: \(\((?:t\.)?tx_hash >= /);
      } finally {
        await pg.query('ROLLBACK');
        pg.release();
      }
    } finally {
      await drop(1, c1);
      await drop(10, c2);
      await store.pool.query('DELETE FROM washtrace.wallets WHERE address = ANY($1)', [[alice, bob, carol]]);
    }
  });

  it('says whether a token has a flagged trade in the latest analysis, read by key from the token\'s own transfers', async () => {
    await store.migrate();
    const one = (await store.addCollection(1, c1, 'Searchable Apes', 1)).id;
    const two = (await store.addCollection(10, c2, 'Searchable Cats', 1)).id;
    const h = (n: number) => '0x' + String(n).repeat(64);
    await store.ingest(one, 1, [
      transfer('7', alice, bob, { txHash: h(1) }), transfer('7', bob, alice, { txHash: h(2) }), transfer('8', alice, bob, { txHash: h(3) }),
    ], 100, [alice, bob]);
    await store.ingest(two, 10, [transfer('7', alice, carol, { txHash: h(4) })], 100, [alice, carol]);
    const q = (sql: string, args: unknown[]) => store.pool.query(sql, args);
    // Token 7's first trade is flagged by Round trips; token 8's only by Money loops back, which no count holds.
    await q(`INSERT INTO washtrace.trade_facts (collection_id, tx_hash, log_index, counted) VALUES ($1, $2, 0, true), ($1, $3, 0, true)`, [one, h(1), h(3)]);
    await q(`INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness) VALUES ($1, 'A', $2, 0, '{}'), ($1, 'AU', $3, 0, '{}')`, [one, h(1), h(3)]);
    try {
      const tokens = async (tokenId: string) => (await store.search({ kind: 'token', tokenId, text: tokenId })).tokens.map((r) => [r.address, r.flagged]);
      expect(await tokens('7')).toEqual([[c1, true], [c2, false]]);
      expect(await tokens('8')).toEqual([[c1, false]]);

      const pg = await store.pool.connect();
      try {
        await pg.query('BEGIN');
        // A collection's worth of flagged, counted transfers, so the plan is costed as on a real install; rolled back.
        await pg.query(
          `WITH t AS (INSERT INTO washtrace.transfers (collection_id, tx_hash, log_index, block_number, token_id, from_address, to_address)
             SELECT $1, '0xfill' || g, 0, g, g % 5000, $2, $3 FROM generate_series(1, 20000) g RETURNING tx_hash),
           x AS (INSERT INTO washtrace.trade_facts (collection_id, tx_hash, log_index, counted) SELECT $1, tx_hash, 0, true FROM t)
           INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness) SELECT $1, 'A', tx_hash, 0, '{}' FROM t`,
          [one, alice, bob],
        );
        await pg.query('ANALYZE washtrace.transfers, washtrace.trade_facts, washtrace.flags');
        // Store.search's own read of whether one collection's token has a flagged trade.
        const plan = (await pg.query(
          `EXPLAIN SELECT 1 FROM washtrace.transfers t JOIN washtrace.trade_facts x ON x.collection_id = t.collection_id AND x.tx_hash = t.tx_hash AND x.log_index = t.log_index AND x.counted
           JOIN washtrace.flags f ON f.collection_id = t.collection_id AND f.method IN ('A', 'AC') AND f.tx_hash = t.tx_hash AND f.log_index = t.log_index
           WHERE t.collection_id = $1 AND t.token_id = $2::numeric`,
          [one, '7'],
        )).rows.map((r) => r['QUERY PLAN']).join('\n');
        expect(plan).toMatch(/transfers_token_idx/);
        expect(plan).not.toMatch(/Seq Scan/);
      } finally {
        await pg.query('ROLLBACK');
        pg.release();
      }
    } finally {
      await drop(1, c1);
      await drop(10, c2);
      await store.pool.query('DELETE FROM washtrace.wallets WHERE address = ANY($1)', [[alice, bob, carol]]);
    }
  });

  it('pages a kind: one more than the limit says there is more, an offset moves on, and `only` leaves the other kinds alone', async () => {
    await store.migrate();
    const addrs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const a = hex(`5ec${i}`);
      addrs.push(a);
      await store.addCollection(1, a, `Pageable ${i}`, 1);
    }
    try {
      const first = await store.search({ kind: 'text', text: 'pageable' }, { limit: 2 });
      expect(first.collections.map((r) => r.name)).toEqual(['Pageable 0', 'Pageable 1']);
      expect(first.more.collections).toBe(true);
      const last = await store.search({ kind: 'text', text: 'pageable' }, { limit: 2, offset: 4 });
      expect(last.collections.map((r) => r.name)).toEqual(['Pageable 4']);
      expect(last.more.collections).toBe(false);
      expect((await store.search({ kind: 'address', address: addrs[0]! }, { only: 'wallets' })).collections).toEqual([]);
    } finally {
      for (const a of addrs) await drop(1, a);
    }
  });
});

describe('trade facts', () => {
  const labAddress = w('lab1');
  // Idempotent; lets this block run alone.
  beforeAll(async () => { await store.migrate(); });

  /** The collection's facts keyed by fixture key, the bigints as numbers. */
  async function factsOf(id: number): Promise<Record<string, Fact>> {
    const { rows } = await store.pool.query(
      'SELECT tx_hash, counted, held_s, buyer_age_s, floor_ratio FROM washtrace.trade_facts WHERE collection_id = $1', [id]);
    return Object.fromEntries(rows.map((r) => [LAB.keyOf(r.tx_hash), {
      counted: r.counted,
      heldS: r.held_s === null ? null : Number(r.held_s),
      buyerAgeS: r.buyer_age_s === null ? null : Number(r.buyer_age_s),
      floorRatio: r.floor_ratio,
    }]));
  }

  async function lab(address: string): Promise<number> {
    const { id } = await store.addCollection(1, address, null, 1);
    await store.ingest(id, 1, LAB.transfers, LAB.cursor, []);
    return id;
  }

  it('reads no transfer past the cursor it reports, so a trade ingested meanwhile is not judged', async () => {
    const id = await lab(labAddress);
    // As an ingest running during the analysis would leave it: LATE stored, the cursor where it was read.
    await store.pool.query(
      `INSERT INTO washtrace.transfers (collection_id, tx_hash, log_index, block_number, block_time, token_id, from_address, to_address, marketplace, price_wei, currency)
       VALUES ($1, $2, 0, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10)`,
      [id, LAB.late.txHash, LAB.late.blockNumber, LAB.late.blockTime, LAB.late.tokenId, LAB.late.from, LAB.late.to, LAB.late.marketplace, LAB.late.priceWei, LAB.late.currency],
    );
    const read = await store.analysisInput(id, 1, 3);
    expect(read.through).toBe(600);
    expect(read.transfers.map((t) => t.blockNumber)).not.toContain(900);
    expect(read.transfers).toHaveLength(LAB.transfers.length);
    await drop(1, labAddress);
  });

  it('writes trade facts with the analysis, through its cursor only', async () => {
    const id = await lab(labAddress);
    await store.ingest(id, 1, [LAB.late], LAB.cursor, []);
    await store.saveAnalysis(id, 1, LAB.analysis, 5, 600, MONEY);
    const facts = await factsOf(id);
    expect(facts).toEqual(LAB.facts);
    expect(facts).not.toHaveProperty('LATE');
    await drop(1, labAddress);
  });

  it('a second analysis replaces the facts, and removing the collection removes them', async () => {
    const id = await lab(labAddress);
    await store.saveAnalysis(id, 1, LAB.analysis, 5, 600, MONEY);
    // Judged again with nothing uncounted, and the cursor past everything: M1 is counted now and LATE has a row.
    await store.ingest(id, 1, [LAB.late], 900, []);
    await store.saveAnalysis(id, 2, { ...LAB.analysis, uncounted: [] }, 5, 900, MONEY);
    const facts = await factsOf(id);
    expect(Object.keys(facts).sort()).toEqual([...Object.keys(LAB.facts), 'LATE'].sort());
    expect(facts.M1!.counted).toBe(true);
    // LATE: its buyer W4 is new there (age 0), the token last moved on day 51, and no priced sale in days 53-59 gives a floor.
    expect(facts.LATE).toMatchObject({ counted: true, heldS: 9 * 86_400, buyerAgeS: 0, floorRatio: null });
    await drop(1, labAddress);
    const { rows } = await store.pool.query('SELECT 1 FROM washtrace.trade_facts WHERE collection_id = $1', [id]);
    expect(rows).toEqual([]);
  });

  it('writes facts for every transfer when the analysis has no cursor', async () => {
    const id = await lab(labAddress);
    await store.saveAnalysis(id, 1, LAB.analysis, 5, null, MONEY);
    expect(Object.keys(await factsOf(id))).toHaveLength(LAB.transfers.length);
    await drop(1, labAddress);
  });

  describe('after an append', () => {
    const twinAddress = w('lab2');
    const [W2, W4, W5, W6, W8, K] = ['w2', 'w4', 'w5', 'w6', 'w8', 'k'].map(w) as [string, string, string, string, string, string];
    const ETH = (10n ** 18n).toString();

    /** What the engine makes of `ts` without funding, so each save carries a real `uncounted`. */
    const judged = (ts: Transfer[], custodians: ReadonlySet<string> = new Set()) =>
      analyze(input(ts, [], { fundingAvailable: false, money: MONEY, custodians }));

    /** Each fact's row version, by fixture key: a row written again gets a new one. */
    async function xminsOf(id: number): Promise<Record<string, string>> {
      const { rows } = await store.pool.query('SELECT tx_hash, xmin::text AS xmin FROM washtrace.trade_facts WHERE collection_id = $1', [id]);
      return Object.fromEntries(rows.map((r) => [LAB.keyOf(r.tx_hash), r.xmin]));
    }

    /** The facts a single save of every transfer writes, on a second collection that had no analysis before. */
    async function rewritten(ts: Transfer[], analysis: ReturnType<typeof judged>, through: number, money = MONEY): Promise<Record<string, Fact>> {
      const { id } = await store.addCollection(1, twinAddress, null, 1);
      await store.ingest(id, 1, ts, through, []);
      await store.saveAnalysis(id, 1, analysis, 5, through, money);
      const facts = await factsOf(id);
      await drop(1, twinAddress);
      return facts;
    }

    /** As a stored-data load leaves it: the transfer in, the cursor where it was. */
    async function loaded(id: number, t: Transfer): Promise<void> {
      await store.pool.query(
        `INSERT INTO washtrace.transfers (collection_id, tx_hash, log_index, block_number, block_time, token_id, from_address, to_address, marketplace, price_wei, currency)
         VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7, $8, $9, $10, $11)`,
        [id, t.txHash, t.logIndex, t.blockNumber, t.blockTime, t.tokenId, t.from, t.to, t.marketplace, t.priceWei, t.currency],
      );
    }

    it('writes the facts a full rewrite would, after one append and another', async () => {
      const own = w('lab3');
      const id = await lab(own);
      await store.saveAnalysis(id, 1, judged(LAB.transfers), 5, 600, MONEY);
      const once = [...LAB.transfers, LAB.late];
      await store.ingest(id, 1, [LAB.late], 900, []);
      await store.saveAnalysis(id, 2, judged(once), 5, 900, MONEY);
      // Token 2 sold again on day 61: its floor is LATE's price, a sale the previous save wrote.
      const after = transfer('2', W8, W5, { txHash: '0xlab_after', blockNumber: 1000, blockTime: at(61), marketplace: 'blur', priceWei: (2n * 10n ** 18n).toString(), currency: '' });
      const twice = [...once, after];
      await store.ingest(id, 1, [after], 1000, []);
      const [xmins, counted] = [await xminsOf(id), await factsOf(id)];
      await store.saveAnalysis(id, 3, judged(twice), 5, 1000, MONEY);
      const facts = await factsOf(id);
      expect(facts).toEqual(await rewritten(twice, judged(twice), 1000));
      // The third save added to the second's facts: every one it had, its counted the same, is the row it was.
      const kept = Object.keys(counted).filter((k) => counted[k]!.counted === facts[k]!.counted);
      expect(kept).toHaveLength(once.length);
      const now = await xminsOf(id);
      expect(kept.filter((k) => now[k] !== xmins[k])).toEqual([]);
      expect(Object.keys(facts)).toHaveLength(twice.length);
      expect(facts.AFTER).toEqual({ counted: true, heldS: 47 * 86_400, buyerAgeS: 50 * 86_400, floorRatio: 2 });
      await drop(1, own);
    });

    it('writes again only the old facts whose counted changed: a custodian named since turns a park uncounted', async () => {
      const own = w('lab4');
      const id = (await store.addCollection(1, own, null, 1)).id;
      const old = [
        transfer('7', ZERO, W2, { txHash: '0xlab_mint7', blockNumber: 100, blockTime: at(0) }),
        transfer('8', ZERO, W4, { txHash: '0xlab_mint8', blockNumber: 150, blockTime: at(0) }),
        transfer('7', W2, K, { txHash: '0xlab_park', blockNumber: 200, blockTime: at(1) }),
        transfer('8', W4, W6, { txHash: '0xlab_sale8', blockNumber: 300, blockTime: at(2), marketplace: 'blur', priceWei: ETH, currency: '' }),
      ];
      await store.ingest(id, 1, old, 600, []);
      // K is no custodian yet: the park is a hop W2 -> K, and counted.
      await store.saveAnalysis(id, 1, judged(old), 5, 600, MONEY);
      expect((await factsOf(id)).PARK!.counted).toBe(true);
      const before = await xminsOf(id);
      const unpark = transfer('7', K, W5, { txHash: '0xlab_unpark', blockNumber: 900, blockTime: at(3) });
      const all = [...old, unpark];
      await store.ingest(id, 1, [unpark], 900, []);
      // Now K holds without owning: W2 -> K -> W5 is one hop, the unpark's, and the park no hop at all.
      const analysis = judged(all, new Set([K]));
      expect(analysis.uncounted.map((u) => LAB.keyOf(u.txHash))).toEqual(['MINT7', 'MINT8', 'PARK']);
      await store.saveAnalysis(id, 2, analysis, 5, 900, MONEY);
      const facts = await factsOf(id);
      expect(facts.PARK!.counted).toBe(false);
      expect(facts.UNPARK!.counted).toBe(true);
      expect(facts).toEqual(await rewritten(all, analysis, 900));
      const after = await xminsOf(id);
      expect(Object.keys(after).filter((k) => after[k] === before[k]).sort()).toEqual(['MINT7', 'MINT8', 'SALE8']);
      expect(after.UNPARK).toBe(after.PARK);
      expect(after.PARK).not.toBe(before.PARK);
      await drop(1, own);
    });

    it('rewrites them all when a transfer came in below the old cursor', async () => {
      const own = w('lab5');
      const id = await lab(own);
      await store.saveAnalysis(id, 1, LAB.analysis, 5, 600, MONEY);
      const before = await xminsOf(id);
      // A stored-data load: a trade at block 500, which the facts through 600 never saw.
      const stored = transfer('2', W8, W5, { txHash: '0xlab_stored', blockNumber: 500, blockTime: at(51), marketplace: 'blur', priceWei: ETH, currency: '' });
      await loaded(id, stored);
      await store.ingest(id, 1, [LAB.late], 900, []);
      const all = [...LAB.transfers, stored, LAB.late];
      await store.saveAnalysis(id, 2, judged(all), 5, 900, MONEY);
      const facts = await factsOf(id);
      expect(facts).toHaveProperty('STORED');
      expect(facts).toEqual(await rewritten(all, judged(all), 900));
      const after = await xminsOf(id);
      expect(Object.keys(before).filter((k) => after[k] === before[k])).toEqual([]);
      await drop(1, own);
    });

    it('rewrites them all when the money they price in changed', async () => {
      const own = w('lab7');
      const id = await lab(own);
      await store.saveAnalysis(id, 1, LAB.analysis, 5, 600, MONEY);
      const before = await xminsOf(id);
      await store.ingest(id, 1, [LAB.late], 900, []);
      const all = [...LAB.transfers, LAB.late];
      // USDC counted as money now: U1's sale has a floor, the days before it priced in ETH.
      const money = new Set([...MONEY, USDC]);
      await store.saveAnalysis(id, 2, judged(all), 5, 900, money);
      const facts = await factsOf(id);
      expect(facts.U1!.floorRatio).not.toBeNull();
      expect(facts).toEqual(await rewritten(all, judged(all), 900, money));
      const after = await xminsOf(id);
      expect(Object.keys(before).filter((k) => after[k] === before[k])).toEqual([]);
      await drop(1, own);
    });

    it('rewrites them all when the previous analysis keyed no facts, as one from before keys was', async () => {
      const own = w('lab8');
      const id = await lab(own);
      await store.saveAnalysis(id, 1, LAB.analysis, 5, 600, MONEY);
      const { rows: [key] } = await store.pool.query('SELECT facts_key FROM washtrace.analyses WHERE collection_id = $1', [id]);
      expect(key.facts_key).toBe(`${FACTS_VERSION}/${FLOOR_DAYS}/,${WETH}`);
      await store.pool.query('UPDATE washtrace.analyses SET facts_key = NULL WHERE collection_id = $1', [id]);
      const before = await xminsOf(id);
      await store.ingest(id, 1, [LAB.late], 900, []);
      const all = [...LAB.transfers, LAB.late];
      await store.saveAnalysis(id, 2, judged(all), 5, 900, MONEY);
      expect(await factsOf(id)).toEqual(await rewritten(all, judged(all), 900));
      const after = await xminsOf(id);
      expect(Object.keys(before).filter((k) => after[k] === before[k])).toEqual([]);
      await drop(1, own);
    });

    it('rewrites them all when the cursor went back', async () => {
      const own = w('lab9');
      const id = await lab(own);
      await store.ingest(id, 1, [LAB.late], 900, []);
      const all = [...LAB.transfers, LAB.late];
      await store.saveAnalysis(id, 1, judged(all), 5, 900, MONEY);
      const before = await xminsOf(id);
      await store.saveAnalysis(id, 2, judged(LAB.transfers), 5, 600, MONEY);
      const facts = await factsOf(id);
      expect(facts).toEqual(LAB.facts);
      expect(facts).toEqual(await rewritten(LAB.transfers, judged(LAB.transfers), 600));
      const after = await xminsOf(id);
      expect(Object.keys(after).filter((k) => after[k] === before[k])).toEqual([]);
      await drop(1, own);
    });

    it('rewrites them all when the previous analysis read every transfer', async () => {
      const own = w('lab6');
      const id = await lab(own);
      await store.saveAnalysis(id, 1, LAB.analysis, 5, null, MONEY);
      const before = await xminsOf(id);
      await store.ingest(id, 1, [LAB.late], 900, []);
      await store.saveAnalysis(id, 2, judged([...LAB.transfers, LAB.late]), 5, 900, MONEY);
      const after = await xminsOf(id);
      expect(Object.keys(before).filter((k) => after[k] === before[k])).toEqual([]);
      expect(Object.keys(after)).toHaveLength(LAB.transfers.length + 1);
      await drop(1, own);
    });
  });
});

describe('loops', () => {
  const address = w('lab2');
  beforeAll(async () => { await store.migrate(); });

  async function mixed(): Promise<number> {
    const { id } = await store.addCollection(1, address, null, 1);
    await store.ingest(id, 1, LAB_MIXED.transfers, LAB_MIXED.cursor, []);
    await store.saveAnalysis(id, 1, LAB_MIXED.analysis, 5, LAB_MIXED.cursor, MONEY);
    return id;
  }

  it('counts the loops and pairs each lens found, and stores each loop once', async () => {
    const id = await mixed();
    const latest = (await store.collection(1, address))!.latest!;
    expect(latest.loops).toEqual({ A: { loops: 1, pairs: 0 }, AU: { loops: 1, pairs: 0 }, AC: { loops: 1, pairs: 1 } });
    const { rows } = await store.pool.query('SELECT kind, wallets, cycles, middle FROM washtrace.witnesses WHERE collection_id = $1 ORDER BY id', [id]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind)).toEqual(['scc', 'pair']);
    // Wallet order carries no meaning: compare as sets.
    expect(rows[0].wallets.slice().sort()).toEqual([w('w10'), w('w11')].sort());
    expect(rows[0].cycles).toBe(2);
    expect(rows[1].wallets.slice().sort()).toEqual([w('w11'), w('w12'), w('w13')].sort());
    expect(rows[1].middle).toBe(w('w13'));
    const flags = await store.pool.query('SELECT method, tx_hash, witness_id FROM washtrace.flags WHERE collection_id = $1', [id]);
    expect(flags.rows).toHaveLength(LAB_MIXED.analysis.flags.length);
    // Ids go by first appearance: the scc is 0, the pair 1. Q1-Q3 are in the scc under every lens; Q4 is the pair, under Linked wallets only.
    const pointed = flags.rows.map((r) => `${r.method} ${LAB.keyOf(r.tx_hash)} ${r.witness_id}`).sort();
    const expected = [
      ...['A', 'AU', 'AC'].flatMap((m) => ['Q1', 'Q2', 'Q3'].map((q) => `${m} ${q} 0`)), 'AC Q4 1',
    ].sort();
    expect(pointed).toEqual(expected);
    await drop(1, address);
  });

  it('a lens that did not run counts no loops, though its flags carry Round trips\' copy', async () => {
    const { id } = await store.addCollection(1, address, null, 1);
    await store.saveAnalysis(id, 1, LAB.analysis, 5, null, MONEY);
    const latest = (await store.collection(1, address))!.latest!;
    expect(latest.totals.AU.available).toBe(false);
    expect(latest.loops!.A).toEqual({ loops: 1, pairs: 0 });
    expect(latest.loops!.AU).toEqual({ loops: 0, pairs: 0 });
    expect(latest.loops!.AC).toEqual({ loops: 0, pairs: 0 });
    expect((await store.history(id))[0]!.loops!.AU).toEqual({ loops: 0, pairs: 0 });
    await drop(1, address);
  });

  it('finds the pair through any of its wallets, middle included', async () => {
    const id = await mixed();
    const { rows } = await store.pool.query('SELECT id FROM washtrace.witnesses WHERE collection_id = $1 AND wallets @> ARRAY[$2]::text[]', [id, w('w13')]);
    expect(rows).toHaveLength(1);
    const pair = await store.pool.query(
      `SELECT count(*)::int AS n FROM washtrace.flags f WHERE f.collection_id = $1 AND f.witness_id = $2`, [id, rows[0].id]);
    expect(pair.rows[0].n).toBe(1);
    await drop(1, address);
  });

  it('a re-save replaces the witnesses with the new ones, not adds to them', async () => {
    const id = await mixed();
    await store.saveAnalysis(id, 2, LAB_MIXED.analysis, 5, LAB_MIXED.cursor, MONEY);
    const { rows } = await store.pool.query('SELECT count(*)::int AS n FROM washtrace.witnesses WHERE collection_id = $1', [id]);
    expect(rows[0].n).toBe(2);
    await store.saveAnalysis(id, 3, { ...LAB_MIXED.analysis, flags: [] }, 5, LAB_MIXED.cursor, MONEY);
    const none = await store.pool.query('SELECT count(*)::int AS n FROM washtrace.witnesses WHERE collection_id = $1', [id]);
    expect(none.rows[0].n).toBe(0);
    await drop(1, address);
  });

  it('is null on an analysis saved before loops were counted', async () => {
    const { id } = await store.addCollection(1, address, null, 1);
    await store.saveAnalysis(id, 1, LAB_MIXED.analysis, 5, null, MONEY);
    await store.pool.query('UPDATE washtrace.analyses SET loops = NULL WHERE collection_id = $1', [id]);
    expect((await store.collection(1, address))!.latest!.loops).toBeNull();
    expect((await store.history(id))[0]!.loops).toBeNull();
    await drop(1, address);
  });

  it('queues a collection analysed before loops were counted to run again, and leaves a newer one be', async () => {
    const newer = w('lab6');
    const old = (await store.addCollection(1, address, null, 1)).id;
    await store.saveAnalysis(old, 1, LAB_MIXED.analysis, 5, null, MONEY);
    await store.pool.query('UPDATE washtrace.analyses SET loops = NULL WHERE collection_id = $1', [old]);
    const fresh = (await store.addCollection(1, newer, null, 1)).id;
    await store.saveAnalysis(fresh, 1, LAB_MIXED.analysis, 5, null, MONEY);
    try {
      expect((await store.stale()).map((s) => s.id)).not.toContain(old);
      // Run the re-analysis migration again, and the one after it, as an install upgrading to them would.
      await store.pool.query('DELETE FROM washtrace.schema_version');
      await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES (24)');
      expect(await store.migrate()).toBe(MIGRATIONS.length);
      const due = (await store.stale()).map((s) => s.id);
      expect(due).toContain(old);
      expect(due).not.toContain(fresh);
      // The newest-first page's index, in the order it reads, in place of the ascending one.
      const { rows } = await store.pool.query(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'washtrace' AND tablename = 'transfers' AND indexname LIKE 'transfers_coll_time%'");
      expect(rows.map((r) => r.indexname)).toEqual(['transfers_coll_time_desc_idx']);
      expect(rows[0].indexdef).toContain('block_time DESC NULLS LAST');
    } finally {
      await drop(1, address);
      await drop(1, newer);
    }
  });
});

describe('trades', () => {
  const labAddress = w('lab3'), mixedAddress = w('lab4'), hexAddress = w('lab5');
  const CTX = { money: MONEY, ran: ['A'] as Method[], zone: 'UTC' };
  const ALL = { money: MONEY, ran: ['A', 'AU', 'AC'] as Method[], zone: 'UTC' };
  const ETH = (x: number) => (BigInt(Math.round(x * 1000)) * 10n ** 15n).toString();
  const keys = (rows: { txHash: string }[]) => rows.map((r) => LAB.keyOf(r.txHash));
  const DAY_MS = 86_400_000;
  // The lab's wallets and hashes are not hex, so a Find on them is tried on a collection whose are.
  const hex = (s: string) => '0x' + s.padEnd(40, '0');
  const alice = hex('ab12'), bob = hex('ab34'), carol = hex('cd56');
  const t1 = '0x' + 'e'.repeat(64), t2 = '0x' + 'f'.repeat(64);
  let lab: number, mixed: number, hexed: number;

  beforeAll(async () => {
    await store.migrate();
    // LAB as the analysis left it: judged through block 600 without funding, so only Round trips ran; LATE came in after.
    lab = (await store.addCollection(1, labAddress, null, 1)).id;
    await store.ingest(lab, 1, [...LAB.transfers, LAB.late], LAB.cursor, []);
    await store.saveAnalysis(lab, 1, LAB.analysis, 5, LAB.cursor, MONEY);
    mixed = (await store.addCollection(1, mixedAddress, null, 1)).id;
    await store.ingest(mixed, 1, LAB_MIXED.transfers, LAB_MIXED.cursor, []);
    await store.saveAnalysis(mixed, 1, LAB_MIXED.analysis, 5, LAB_MIXED.cursor, MONEY);
    // Never analysed: a mint, then two sales, the first at midday UTC on 31 January.
    hexed = (await store.addCollection(1, hexAddress, null, 1)).id;
    await store.ingest(hexed, 1, [
      transfer('9', ZERO, alice, { blockTime: Date.UTC(2023, 0, 1) / 1000 }),
      transfer('9', alice, bob, { txHash: t1, marketplace: 'blur', blockTime: Date.UTC(2023, 0, 31, 12) / 1000 }),
      transfer('9', bob, carol, { txHash: t2, marketplace: 'blur', blockTime: Date.UTC(2023, 1, 1, 12) / 1000 }),
    ], 1_000_000, []);
  });
  afterAll(async () => {
    await drop(1, labAddress);
    await drop(1, mixedAddress);
    await drop(1, hexAddress);
  });

  const list = async (q: Partial<TradeQuery>, ctx = CTX, id = lab) => keys(await store.trades(id, { ...NO_FILTER, ...q }, ctx, 50, 0));

  it('indexes a collection’s senders and receivers once each, for both equality and the start of an address', async () => {
    const { rows } = await store.pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'washtrace' AND tablename = 'transfers' AND indexdef LIKE '%(collection_id, %_address%' ORDER BY indexname`);
    expect(rows.map((r) => r.indexname)).toEqual(['transfers_coll_from_prefix_idx', 'transfers_coll_to_prefix_idx']);
    expect(rows.every((r) => r.indexdef.includes('text_pattern_ops'))).toBe(true);
  });

  it('lists counted sales newest first, with only the lenses that ran, and counts not-judged-yet rows apart', async () => {
    const rows = await store.trades(lab, NO_FILTER, CTX, 50, 0);
    expect(keys(rows)).toEqual(['LATE', 'S4', 'S3', 'P1', 'U1', 'S2', 'S5', 'S1']); // M1 not counted
    expect(rows[0]).toMatchObject({ judged: false, lenses: [], heldS: null, buyerAgeS: null, floorRatio: null });
    expect(rows[1]!.lenses).toEqual(['A']); // AU and AC copies ignored
    expect(rows[1]).toMatchObject({ judged: true, heldS: 86_400, buyerAgeS: 41 * 86_400, floorRatio: 0.5, priceWei: ETH(1), marketplace: 'blur', tokenId: '1' });
    expect(await store.tradeCount(lab, NO_FILTER, CTX)).toEqual({ total: 8, unjudged: 1 });
    // Every transfer, not just sales; the uncounted mint stays out.
    expect(await list({ kind: 'all' })).toEqual(['LATE', 'S4', 'S3', 'P1', 'U1', 'S2', 'S5', 'S1']);
    expect((await store.trades(mixed, NO_FILTER, ALL, 50, 0)).map((r) => r.lenses)).toEqual([['AC'], ['A', 'AU', 'AC'], ['A', 'AU', 'AC'], ['A', 'AU', 'AC']]);
  });

  it('a caught filter on a lens that did not run returns nothing; not-caught leaves out rows not judged yet', async () => {
    expect(await store.trades(lab, { ...NO_FILTER, caught: ['AU'] }, CTX, 50, 0)).toEqual([]);
    expect(await store.tradeCount(lab, { ...NO_FILTER, caught: ['A', 'AC'] }, CTX)).toEqual({ total: 0, unjudged: 0 });
    expect(await list({ caught: ['A'] })).toEqual(['S4', 'S3', 'S2', 'S1']);
    expect(await list({ notCaught: ['A'] })).toEqual(['P1', 'U1', 'S5']);
    // A not-caught lens that did not run is ignored: the rest still apply.
    expect(await list({ notCaught: ['AU'] })).toEqual(['LATE', 'S4', 'S3', 'P1', 'U1', 'S2', 'S5', 'S1']);
    expect(await list({ caught: ['AC'], notCaught: ['A'] }, ALL, mixed)).toEqual(['Q4']);
  });

  it('a price bound drops unpriced and non-ETH sales, and a price sort puts them last both ways', async () => {
    expect(await list({ priceMinWei: ETH(1.5) })).toEqual(['S3', 'S2', 'S5']);
    expect(await list({ priceMaxWei: ETH(1) })).toEqual(['LATE', 'S4', 'S1']);
    for (const dir of ['asc', 'desc'] as const) expect((await list({ sort: 'price', dir })).slice(-2)).toEqual(['P1', 'U1']);
    // Ties by date, newest first.
    expect(await list({ sort: 'price', dir: 'asc' })).toEqual(['LATE', 'S4', 'S1', 'S3', 'S5', 'S2', 'P1', 'U1']);
  });

  it('a venue key matches every raw string of it', async () => {
    expect(await list({ venues: ['opensea'] })).toEqual(['S2']);
    expect(await list({ venues: ['opensea', 'blur'] })).toHaveLength(8);
    expect(await list({ venues: ['x2y2'] })).toEqual([]);
  });

  it('filters by what the facts say, by time, by wallet and by token', async () => {
    expect(await list({ heldOverS: 30 * 86_400 })).toEqual(['S3']);
    // [over, under), as the bands read it: two days is not under two days.
    expect(await list({ heldUnderS: 2 * 86_400 })).toEqual(['S4', 'P1']);
    expect(await list({ buyerAgeOverS: 1 })).toEqual(['S4', 'S3']);
    expect(await list({ floorMin: 1 })).toEqual(['S2', 'S5']);
    expect(await list({ floorMax: 1 })).toEqual(['S4']);
    expect(await list({ fromMs: at(50) * 1000, toMs: at(51) * 1000 })).toEqual(['S3']);
    expect(await list({ fromMs: at(51) * 1000 - DAY_MS / 2 })).toEqual(['LATE', 'S4']);
    expect(await list({ wallet: w('w3') })).toEqual(['S3', 'S2']);
    expect(await list({ token: '2' })).toEqual(['P1', 'U1', 'S5']);
  });

  it('a token group is the wallets in that token’s loops; a wallet group goes through the index', async () => {
    expect(await list({ kind: 'all', group: { method: 'A', token: '1' } })).toEqual(['S4', 'S3', 'S2', 'S1']);
    expect(await list({ kind: 'all', group: { method: 'AC', wallet: w('w12') } }, ALL, mixed)).toEqual(['Q4']);
    expect(await list({ kind: 'all', group: { method: 'A', wallet: w('w12') } }, ALL, mixed)).toEqual([]);
    // A group by a lens that did not run has none of its copied loops.
    expect(await list({ kind: 'all', group: { method: 'AU', token: '1' } })).toEqual([]);
    expect(await list({ kind: 'all', group: { method: 'AU', wallet: w('w1') } })).toEqual([]);
  });

  it('groups by held band with only the lenses that ran, unknown last', async () => {
    expect(await store.tradeGroups(lab, { ...NO_FILTER, token: '1' }, 'held', CTX)).toEqual([
      { key: '2', trades: 3, caught: { A: 3 } }, { key: '3', trades: 1, caught: { A: 1 } }, { key: '-', trades: 1, caught: { A: 0 } },
    ]);
  });

  it('groups by marketplace busiest first, by month in order, and by buyer age and floor band', async () => {
    expect(await store.tradeGroups(lab, NO_FILTER, 'marketplace', CTX)).toEqual([
      { key: 'blur', trades: 7, caught: { A: 3 } }, { key: 'opensea', trades: 1, caught: { A: 1 } },
    ]);
    expect(await store.tradeGroups(mixed, NO_FILTER, 'marketplace', ALL)).toEqual([{ key: 'blur', trades: 4, caught: { A: 3, AU: 3, AC: 4 } }]);
    // Every transfer: one that is no sale has no marketplace, so it is unknown, and last.
    expect(await store.tradeGroups(hexed, { ...NO_FILTER, kind: 'all' }, 'marketplace', CTX)).toEqual([
      { key: 'blur', trades: 2, caught: { A: 0 } }, { key: '-', trades: 1, caught: { A: 0 } },
    ]);
    expect(await store.tradeGroups(lab, NO_FILTER, 'month', CTX)).toEqual([
      { key: '2023-01', trades: 5, caught: { A: 2 } }, { key: '2023-02', trades: 2, caught: { A: 2 } }, { key: '2023-03', trades: 1, caught: { A: 0 } },
    ]);
    expect(await store.tradeGroups(lab, NO_FILTER, 'buyerAge', CTX)).toEqual([
      { key: '0', trades: 5, caught: { A: 2 } }, { key: '2', trades: 2, caught: { A: 2 } }, { key: '-', trades: 1, caught: { A: 0 } },
    ]);
    // A ratio of exactly 2 is at an edge, so in the top band.
    expect(await store.tradeGroups(lab, NO_FILTER, 'floor', CTX)).toEqual([
      { key: '1', trades: 1, caught: { A: 1 } }, { key: '4', trades: 2, caught: { A: 1 } }, { key: '-', trades: 5, caught: { A: 2 } },
    ]);
  });

  it('a month is the reader’s month, whatever the server’s time zone', async () => {
    const months = async (zone: string) => (await store.tradeGroups(hexed, NO_FILTER, 'month', { ...CTX, zone })).map((g) => [g.key, g.trades]);
    expect(await months('UTC')).toEqual([['2023-01', 1], ['2023-02', 1]]);
    // Midday UTC on 31 January is already 1 February at UTC+14.
    expect(await months('Pacific/Kiritimati')).toEqual([['2023-02', 2]]);
  });

  it('find takes a token number, a tx hash, or the start of a wallet address', async () => {
    expect(await list({ find: '2' })).toEqual(['P1', 'U1', 'S5']);
    expect(await list({ find: ' #2 ' })).toEqual(['P1', 'U1', 'S5']);
    expect(await list({ find: 'hello' })).toEqual([]);
    expect(await list({ find: '0x000' })).toEqual([]); // too short to be the start of an address
    expect(await list({ find: '0x0000' })).toHaveLength(8); // four digits are enough, and every lab wallet starts so
    const find = async (f: string) => (await store.trades(hexed, { ...NO_FILTER, find: f }, CTX, 50, 0)).map((r) => r.txHash);
    expect(await find(t1.toUpperCase().replace('0X', '0x'))).toEqual([t1]);
    expect(await find(carol)).toEqual([t2]);
    expect(await find('0xAB34')).toEqual([t2, t1]);
    expect(await find('0xcd56')).toEqual([t2]);
    expect(await find('0xcd5')).toEqual([]);
    expect(await find('9')).toEqual([t2, t1]);
    // '#' makes a number a token, and hex after it is not an address.
    expect(await find('#0xab34')).toEqual([]);
  });

  it('sorts by a lens, flagged first, and by a lens that did not run not at all', async () => {
    expect(await list({ sort: 'lens-A', dir: 'desc' })).toEqual(['S4', 'S3', 'S2', 'S1', 'LATE', 'P1', 'U1', 'S5']);
    expect(await list({ sort: 'lens-AU', dir: 'desc' })).toEqual(await list({}));
    expect(await list({ sort: 'held', dir: 'desc' })).toEqual(['S3', 'S1', 'U1', 'S2', 'S4', 'P1', 'LATE', 'S5']);
  });

  it('the stream yields the same rows as every page put together', async () => {
    const queries: TradeQuery[] = [NO_FILTER, { ...NO_FILTER, sort: 'price', dir: 'asc' }, { ...NO_FILTER, kind: 'all', caught: ['A'] }];
    for (const q of queries) {
      const pages = [];
      for (let offset = 0; ; offset += 3) {
        const page = await store.trades(lab, q, CTX, 3, offset);
        pages.push(...page);
        if (page.length < 3) break;
      }
      const streamed = [];
      for await (const r of store.tradeStream(lab, q, CTX)) streamed.push(r);
      expect(streamed).toEqual(pages);
      expect(streamed.length).toBe((await store.tradeCount(lab, q, CTX)).total);
    }
  });

  it('the stream is a download that fetches a thousand rows at a time: a slow reader drains each fetch inside the idle limit', async () => {
    const s = store as any;
    const stream = s.stream;
    const asked: unknown[][] = [];
    s.stream = function (this: unknown, ...a: unknown[]) { asked.push(a.slice(3)); return stream.apply(this, a); };
    try {
      for await (const _ of store.tradeStream(lab, NO_FILTER, CTX)) { /* drain */ }
    } finally {
      delete s.stream;
    }
    expect(asked).toEqual([[1_000, true]]);
  });
});

describe('lens lists', () => {
  const labAddress = w('lab7'), mixedAddress = w('lab8'), sortedAddress = w('lab9');
  const CTX = { money: MONEY, ran: ['A'] as Method[], zone: 'UTC' };
  const ALL = { money: MONEY, ran: ['A', 'AU', 'AC'] as Method[], zone: 'UTC' };
  const ETH = (x: number) => (BigInt(Math.round(x * 1000)) * 10n ** 15n).toString();
  const [W1, W11] = ['w1', 'w11'].map(w) as [string, string];
  const tokens = (o: Partial<ListOpts<TokenSort>> = {}): ListOpts<TokenSort> => ({ sort: 'caught', find: null, limit: 50, offset: 0, ...o });
  const wallets = (o: Partial<ListOpts<WalletSort>> = {}): ListOpts<WalletSort> => ({ sort: 'caught', find: null, limit: 50, offset: 0, ...o });
  let lab: number, mixed: number, sorted: number;

  // Three tokens whose orders differ by every sort, each order with a real tie. Every mint is on day 0 and counts for nothing.
  const [A, B, C, D, E, F, G] = ['a', 'b', 'c', 'd', 'e', 'f', 'f1'].map(w) as [string, string, string, string, string, string, string];
  const sale = (token: string, from: string, to: string, day: number, eth: number) =>
    transfer(token, from, to, { marketplace: 'blur', priceWei: ETH(eth), currency: '', blockTime: at(day) });
  const mints = [transfer('10', ZERO, A, { blockTime: at(0) }), transfer('20', ZERO, D, { blockTime: at(0) }), transfer('30', ZERO, F, { blockTime: at(0) })];
  // Token 10: A and B round twice, then B sells on to C: 3 of 4 caught, 3 ETH, last on day 20.
  const ring10 = [sale('10', A, B, 1, 1), sale('10', B, A, 2, 1), sale('10', A, B, 3, 1)];
  // Token 20: D and E, once round: 2 of 2, 8 ETH, last on day 6.
  const ring20 = [sale('20', D, E, 5, 4), sale('20', E, D, 6, 4)];
  // Token 30: F and G round twice: 3 of 3, 3 ETH, last on day 42.
  const ring30 = [sale('30', F, G, 40, 1), sale('30', G, F, 41, 1), sale('30', F, G, 42, 1)];
  const sortedTransfers = [...mints, ...ring10, sale('10', B, C, 20, 5), ...ring20, ...ring30];
  const flagsOn = (txs: typeof ring10, wallets: string[], cycles: number) =>
    txs.map((t) => ({ txHash: t.txHash, logIndex: t.logIndex, method: 'A' as const, witness: { kind: 'scc' as const, wallets, cycles } }));

  beforeAll(async () => {
    await store.migrate();
    // As the analysis left LAB: no funding, so only Round trips ran, and LATE came in after it.
    lab = (await store.addCollection(1, labAddress, null, 1)).id;
    await store.ingest(lab, 1, [...LAB.transfers, LAB.late], LAB.cursor, []);
    await store.saveAnalysis(lab, 1, LAB.analysis, 5, LAB.cursor, MONEY);
    mixed = (await store.addCollection(1, mixedAddress, null, 1)).id;
    await store.ingest(mixed, 1, LAB_MIXED.transfers, LAB_MIXED.cursor, []);
    await store.saveAnalysis(mixed, 1, LAB_MIXED.analysis, 5, LAB_MIXED.cursor, MONEY);
    sorted = (await store.addCollection(1, sortedAddress, null, 1)).id;
    await store.ingest(sorted, 1, sortedTransfers, 1_000_000, []);
    await store.saveAnalysis(sorted, 1, {
      ...LAB.analysis,
      flags: [...flagsOn(ring10, [A, B], 2), ...flagsOn(ring20, [D, E], 1), ...flagsOn(ring30, [F, G], 2)],
      uncounted: mints.map((t) => ({ txHash: t.txHash, logIndex: t.logIndex })),
    }, 5, null, MONEY);
  });
  afterAll(async () => {
    await drop(1, labAddress);
    await drop(1, mixedAddress);
    await drop(1, sortedAddress);
  });

  it('a token counts its counted trades, what the lens caught of them, its loops and their wallets', async () => {
    // M1 is a mint and LATE was never judged: token 1's counted trades are S1-S4, every one caught.
    expect(await store.lensTokens(lab, 'A', tokens(), CTX)).toEqual({
      total: 1,
      rows: [{ tokenId: '1', caught: 4, trades: 4, volumeWei: ETH(7), lastAt: at(51) * 1000, loops: 1, pairs: 0, wallets: 3, closedByMoney: 0, laps: 2, middles: 0, shapes: NO_SHAPES }],
    });
  });

  it('a wallet counts the trades it was in, and the other wallets in its loops', async () => {
    const { rows, total } = await store.lensWallets(lab, 'A', wallets(), CTX);
    expect(total).toBe(3);
    expect(rows.find((r) => r.address === W1)).toEqual({ address: W1, caught: 3, trades: 3, volumeWei: ETH(4), firstAt: at(10) * 1000, loops: 1, pairs: 0, partners: 2, shapes: NO_SHAPES });
  });

  it('loops and linked pairs are counted apart, with the middle wallet among the wallets', async () => {
    const t = await store.lensTokens(mixed, 'AC', tokens(), ALL);
    expect(t.rows[0]).toMatchObject({ tokenId: '3', caught: 4, trades: 4, loops: 1, pairs: 1, wallets: 4, middles: 1, laps: 2, closedByMoney: 0 });
    // W13 funded both sides of Q4's pair.
    expect(t.rows[0]!.shapes).toEqual({ ...NO_SHAPES, funder: 1 });
    const { rows } = await store.lensWallets(mixed, 'AC', wallets(), ALL);
    expect(rows.find((r) => r.address === W11)).toMatchObject({ caught: 4, trades: 4, loops: 1, pairs: 1, partners: 3, shapes: { ...NO_SHAPES, funder: 1 } });
    // Under Round trips Q4 is not caught, so W11 is 3 of 4, in the loop alone.
    const a = await store.lensWallets(mixed, 'A', wallets(), ALL);
    expect(a.rows.find((r) => r.address === W11)).toMatchObject({ caught: 3, trades: 4, loops: 1, pairs: 0, partners: 1 });
  });

  it('reads nothing for a lens that did not run, though the engine copied its flags', async () => {
    expect(await store.lensTokens(lab, 'AU', tokens(), CTX)).toEqual({ rows: [], total: 0 });
    expect(await store.lensWallets(lab, 'AC', wallets(), CTX)).toEqual({ rows: [], total: 0 });
  });

  it('sorts tokens by most caught, share, volume and newest, a tie by token number', async () => {
    const order = async (sort: TokenSort) => (await store.lensTokens(sorted, 'A', tokens({ sort }), CTX)).rows.map((r) => r.tokenId);
    // 10 and 30 both caught 3: the lower number first.
    expect(await order('caught')).toEqual(['10', '30', '20']);
    // 20 and 30 both all caught: the more caught first; 10 is 3 of 4.
    expect(await order('share')).toEqual(['30', '20', '10']);
    // 20 is 8 ETH; 10 and 30 both 3 ETH, B's 5 ETH sale to C not caught.
    expect(await order('volume')).toEqual(['20', '10', '30']);
    expect(await order('newest')).toEqual(['30', '10', '20']);
    expect((await store.lensTokens(sorted, 'A', tokens(), CTX)).rows.map((r) => r.lastAt)).toEqual([at(20) * 1000, at(42) * 1000, at(6) * 1000]);
  });

  it('sorts wallets by most caught, share, volume and first seen, a tie by address', async () => {
    const order = async (sort: WalletSort) => (await store.lensWallets(sorted, 'A', wallets({ sort }), CTX)).rows.map((r) => r.address);
    expect(await order('caught')).toEqual([A, B, F, G, D, E]);
    // A, F and G all caught 3 of 3, D and E 2 of 2: the more caught first. B is 3 of 4.
    expect(await order('share')).toEqual([A, F, G, D, E, B]);
    expect(await order('volume')).toEqual([D, E, A, B, F, G]);
    // Newest first, by each wallet's first counted trade: the mints on day 0 would tie A, D and F.
    expect(await order('first')).toEqual([F, G, D, E, A, B]);
    const firsts = Object.fromEntries((await store.lensWallets(sorted, 'A', wallets(), CTX)).rows.map((r) => [r.address, r.firstAt]));
    expect([firsts[A], firsts[D], firsts[F]]).toEqual([at(1) * 1000, at(5) * 1000, at(40) * 1000]);
  });

  it('a limit of 0 reads the count alone', async () => {
    expect(await store.lensTokens(sorted, 'A', tokens({ limit: 0 }), CTX)).toEqual({ rows: [], total: 3 });
    expect(await store.lensWallets(sorted, 'A', wallets({ limit: 0, find: '0x000000' }), CTX)).toEqual({ rows: [], total: 6 });
  });

  it('a Find narrows to tokens whose number, or wallets whose address, starts with it; anything else matches nothing', async () => {
    expect((await store.lensTokens(lab, 'A', tokens({ find: '1' }), CTX)).rows.map((r) => r.tokenId)).toEqual(['1']);
    expect((await store.lensTokens(mixed, 'A', tokens({ find: '#3' }), ALL)).total).toBe(1);
    expect(await store.lensTokens(lab, 'A', tokens({ find: '2' }), CTX)).toEqual({ rows: [], total: 0 });
    expect(await store.lensTokens(lab, 'A', tokens({ find: 'hello' }), CTX)).toEqual({ rows: [], total: 0 });
    expect(await store.lensTokens(lab, 'A', tokens({ find: '0x000000' }), CTX)).toEqual({ rows: [], total: 0 });
    // The lab's wallets are 0x and zeros before their names, which are not hex: a hex start matches all three, and the whole name none.
    expect((await store.lensWallets(lab, 'A', wallets({ find: '0x000000' }), CTX)).total).toBe(3);
    expect((await store.lensWallets(lab, 'A', wallets({ find: W1 }), CTX)).total).toBe(0);
    expect(await store.lensWallets(lab, 'A', wallets({ find: '1' }), CTX)).toEqual({ rows: [], total: 0 });
  });

  it('pages, and still counts the list past its last page', async () => {
    const all = (await store.lensWallets(lab, 'A', wallets(), CTX)).rows;
    expect(await store.lensWallets(lab, 'A', wallets({ limit: 1, offset: 1 }), CTX)).toEqual({ rows: [all[1]], total: 3 });
    expect(await store.lensWallets(lab, 'A', wallets({ limit: 2, offset: 4 }), CTX)).toEqual({ rows: [], total: 3 });
  });
});

describe('a wallet', () => {
  // Its own chain, so no other block's collections hold its trades; hex wallets, so a Find on their start reads them.
  const CHAIN = 909;
  const hex = (s: string) => '0x' + s.padEnd(40, '0');
  const W = hex('aa'), P = hex('bb'), Q = hex('cc'), R = hex('dd');
  const ran = hex('c1'), notRan = hex('c2');
  const tx = (n: number) => '0x' + String(n).padStart(64, '0');
  // Newest first: u2 u1 t4 t3 t2 t1. W is in all but u3.
  const T = { t1: 1, t2: 2, t3: 3, t4: 4, u1: 5, u2: 6, u3: 7 } as const;
  const keys = (rows: { txHash: string }[]) => rows.map((r) => Object.entries(T).find(([, n]) => tx(n) === r.txHash)![0]);

  beforeAll(async () => {
    await store.migrate();
    const at = (k: keyof typeof T, token: string, from: string, to: string) => transfer(token, from, to, { txHash: tx(T[k]), blockNumber: T[k] });
    const c1 = (await store.addCollection(CHAIN, ran, 'Ran', 1)).id;
    await store.ingest(c1, CHAIN, [at('t1', '1', W, P), at('t2', '2', P, W), at('t3', '3', W, Q), at('t4', '4', Q, W)], 100, [W, P, Q]);
    const c2 = (await store.addCollection(CHAIN, notRan, null, 1)).id;
    await store.ingest(c2, CHAIN, [at('u1', '1', W, P), at('u2', '7', W, Q), at('u3', '8', P, Q)], 100, []);
    // Linked wallets ran in the first collection. In the second only Round trips did, so its copied Linked wallets flag caught nothing.
    const analysis = (id: number, funded: boolean) => store.pool.query(
      `INSERT INTO washtrace.analyses (collection_id, took_ms, through_block, totals, missing_data, funded_wallets, wallets, truncated_searches)
       VALUES ($1, 1, 100, $2, 0, 0, 0, 0)`,
      [id, JSON.stringify({ A: { available: true }, AU: { available: funded }, AC: { available: funded } })]);
    await analysis(c1, true);
    await analysis(c2, false);
    const flag = (id: number, m: Method, k: keyof typeof T) => store.pool.query(
      `INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness) VALUES ($1, $2, $3, 0, '{"kind":"pair","pair":[],"middle":null,"flowTx":"0x"}')`,
      [id, m, tx(T[k])]);
    await flag(c1, 'AC', 't1');
    await flag(c1, 'A', 't2');
    await flag(c1, 'AU', 't3');
    await flag(c2, 'AC', 'u1');
    await flag(c2, 'A', 'u2');
    // W paid P three times and was paid once; Q both ways; R only paid W, five times, and trades nothing watched.
    const pays = (from: string, to: string, n: number) => Array.from({ length: n }, () => flow(from, to));
    await store.saveMoney(CHAIN, W, [...pays(W, P, 3), ...pays(P, W, 1), ...pays(W, Q, 1), ...pays(Q, W, 2), ...pays(R, W, 5)], false);
  });
  afterAll(async () => {
    await drop(CHAIN, ran);
    await drop(CHAIN, notRan);
  });

  it('pages its trades newest first across collections, and counts them', async () => {
    expect(keys(await store.walletTransfers(CHAIN, W, 50, 0))).toEqual(['u2', 'u1', 't4', 't3', 't2', 't1']);
    expect(keys(await store.walletTransfers(CHAIN, W, 2, 2))).toEqual(['t4', 't3']);
    expect(await store.walletTransfers(CHAIN, W, 2, 6)).toEqual([]);
    expect(await store.walletTradeCount(CHAIN, W)).toBe(6);
  });

  it('flagged only is what the page calls flagged: a counted lens, and only one that ran in that trade’s collection', async () => {
    // t1: Linked wallets ran there. t2, u2: Round trips. Not t3 (Money loops back is not counted), nor u1 (Linked wallets did not run there).
    expect(keys(await store.walletTransfers(CHAIN, W, 50, 0, { flaggedOnly: true }))).toEqual(['u2', 't2', 't1']);
    expect(await store.walletTradeCount(CHAIN, W, { flaggedOnly: true })).toBe(3);
  });

  it('flagged only reads nothing where no analysis ran, and only the latest analysis where several did', async () => {
    const V = hex('ee'), unanalysed = hex('c3'), reanalysed = hex('c4');
    const one = async (coll: string, n: number, m: Method) => {
      const { id } = await store.addCollection(CHAIN, coll, null, 1);
      await store.ingest(id, CHAIN, [transfer(String(n), V, P, { txHash: tx(n), blockNumber: n })], 200, []);
      await store.pool.query(
        `INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness) VALUES ($1, $2, $3, 0, '{"kind":"scc","wallets":[],"cycles":2}')`, [id, m, tx(n)]);
      return id;
    };
    try {
      // A Round trips flag with no analyses row: nothing is known to have run.
      await one(unanalysed, 101, 'A');
      // Linked wallets ran in an older analysis, not in the latest. The latest is inserted first, so ran_at decides, not the id.
      const id = await one(reanalysed, 102, 'AC');
      const analysis = (ac: boolean, ago: string) => store.pool.query(
        `INSERT INTO washtrace.analyses (collection_id, ran_at, took_ms, through_block, totals, missing_data, funded_wallets, wallets, truncated_searches)
         VALUES ($1, now() - $2::interval, 1, 200, $3, 0, 0, 0, 0)`,
        [id, ago, JSON.stringify({ A: { available: true }, AU: { available: ac }, AC: { available: ac } })]);
      await analysis(false, '0 seconds');
      await analysis(true, '1 day');
      expect(await store.walletTradeCount(CHAIN, V)).toBe(2);
      expect(await store.walletTradeCount(CHAIN, V, { flaggedOnly: true })).toBe(0);
      // The same trade counts once the latest analysis ran Linked wallets.
      await analysis(true, '-1 day');
      expect(await store.walletTransfers(CHAIN, V, 50, 0, { flaggedOnly: true })).toMatchObject([{ txHash: tx(102) }]);
    } finally {
      await drop(CHAIN, unanalysed);
      await drop(CHAIN, reanalysed);
    }
  });

  it('narrows to one collection, and lists its collections busiest first', async () => {
    expect(keys(await store.walletTransfers(CHAIN, W, 50, 0, { collection: notRan }))).toEqual(['u2', 'u1']);
    expect(await store.walletTradeCount(CHAIN, W, { collection: ran, flaggedOnly: true })).toBe(2);
    expect(await store.walletCollections(CHAIN, W)).toEqual([{ address: ran, name: 'Ran', trades: 4 }, { address: notRan, name: null, trades: 2 }]);
  });

  it('lists the tokens it traded in one collection, not one it never touched, cut at the limit', async () => {
    // Token 8 moved between P and Q only. One transfer each, so the token number breaks the tie.
    expect(await store.walletTokens(CHAIN, W, notRan, 5)).toEqual(['1', '7']);
    expect(await store.walletTokens(CHAIN, W, ran, 2)).toEqual(['1', '2']);
  });

  it('a Find reads a token number, the other side of the trade by its address or the start of it, or a transaction by its hash; anything else matches nothing', async () => {
    expect(keys(await store.walletTransfers(CHAIN, W, 50, 0, { find: '#1' }))).toEqual(['u1', 't1']);
    expect(keys(await store.walletTransfers(CHAIN, W, 50, 0, { find: P }))).toEqual(['u1', 't2', 't1']);
    expect(keys(await store.walletTransfers(CHAIN, W, 50, 0, { find: '0xbb0000' }))).toEqual(['u1', 't2', 't1']);
    // The wallet itself is no other side.
    expect(await store.walletTradeCount(CHAIN, W, { find: W })).toBe(0);
    expect(await store.walletTradeCount(CHAIN, W, { find: 'hello' })).toBe(0);
    // A transaction's hash finds its trade, and so does the start of one longer than an address.
    expect(await store.walletTradeCount(CHAIN, W, { find: tx(1) })).toBe(1);
    // tx(n) are zero-padded: their first 50 characters are every one of its trades' hashes.
    expect(await store.walletTradeCount(CHAIN, W, { find: tx(1).slice(0, 50) })).toBe(await store.walletTradeCount(CHAIN, W));
  });

  it('with another wallet, holds the trades where the two are seller and buyer, either way', async () => {
    expect(keys(await store.walletTransfers(CHAIN, W, 50, 0, { with: Q }))).toEqual(['u2', 't4', 't3']);
    expect(await store.walletTradeCount(CHAIN, W, { with: Q, collection: ran })).toBe(2);
  });

  it('sorts its money partners four ways, pages them and counts them', async () => {
    const order = async (sort: 'flows' | 'sent' | 'received' | 'watched') => (await store.counterparties(CHAIN, W, 50, 0, sort)).map((c) => c.address);
    expect(await order('flows')).toEqual([R, P, Q]);
    expect(await order('sent')).toEqual([P, Q, R]);
    expect(await order('received')).toEqual([R, Q, P]);
    expect(await order('watched')).toEqual([P, Q, R]);
    expect(await store.counterparties(CHAIN, W, 1, 1, 'flows')).toEqual([{ address: P, flows: 4, sent: 3, received: 1, watched: true }]);
    expect(await store.counterpartyCount(CHAIN, W)).toBe(3);
  });

  it('lists the payments between two wallets in each direction, newest first, paged and counted', async () => {
    const sent = await store.flowsBetween(CHAIN, W, P, 'sent', 50, 0);
    expect(sent.map((f) => [f.from, f.to])).toEqual([[W, P], [W, P], [W, P]]);
    expect(sent.map((f) => f.blockNumber)).toEqual(sent.map((f) => f.blockNumber).sort((a, b) => b - a));
    expect((await store.flowsBetween(CHAIN, W, P, 'received', 50, 0)).map((f) => [f.from, f.to])).toEqual([[P, W]]);
    const both = await store.flowsBetween(CHAIN, W, P, 'both', 50, 0);
    expect(both).toHaveLength(4);
    expect(await store.flowsBetween(CHAIN, W, P, 'both', 2, 2)).toEqual(both.slice(2));
    expect(await store.flowsBetweenCount(CHAIN, W, P, 'sent')).toBe(3);
    expect(await store.flowsBetweenCount(CHAIN, W, P, 'received')).toBe(1);
    expect(await store.flowsBetweenCount(CHAIN, W, P, 'both')).toBe(4);
    expect(await store.flowsBetweenCount(CHAIN, W, R, 'sent')).toBe(0);
  });
});

describe('lenses', () => {
  beforeAll(async () => { await store.migrate(); });

  const FLAGS = [
    { txHash: '0xaa', logIndex: 0, path: [{ from: a, to: b, kind: 'nft-token' as const, tx: '0xaa', time: 100, amountWei: null, tokenId: '1', token: null }], wallets: [a, b] },
    { txHash: '0xbb', logIndex: 1, path: [{ from: b, to: a, kind: 'funds' as const, tx: null, time: null, amountWei: '5', tokenId: null, token: null }], wallets: [b, a] },
  ];
  const TOTALS = { transfers: 9, flagged: 2, sales: 5, flaggedSales: 2, volumeWei: '10', flaggedVolumeWei: '4', wallets: 4, tokens: 3, available: true, truncated: 1, untimed: 0 };

  /** A collection ingested and analysed as the worker would leave it. */
  async function analysed(address: string): Promise<{ id: number; analysis: number }> {
    const { id } = await store.addCollection(1, address, 'Lab', 1);
    await store.ingest(id, 1, LAB.transfers, LAB.cursor, []);
    await store.saveAnalysis(id, 1, LAB.analysis, 5, 600, MONEY);
    return { id, analysis: await latest(id) };
  }
  async function latest(id: number): Promise<number> {
    const { rows } = await store.pool.query('SELECT id FROM washtrace.analyses WHERE collection_id = $1 ORDER BY ran_at DESC LIMIT 1', [id]);
    return Number(rows[0].id);
  }
  const flagCount = async (lensId: number) =>
    Number((await store.pool.query('SELECT count(*) FROM washtrace.lens_flags WHERE lens_id = $1', [lensId])).rows[0].count);

  it('creates, updates and finds a lens by name, the built-ins\' names included', async () => {
    const lens = await store.createLens('Blur 3-hop', DEFAULT_RULE);
    try {
      expect(lens).toMatchObject({ key: `L${lens.id}`, name: 'Blur 3-hop', version: 1, rule: DEFAULT_RULE });
      expect(await store.lens(lens.id)).toEqual(lens);
      expect(await store.lens(lens.id + 999)).toBeNull();
      const edited = await store.updateLens(lens.id, 'Blur 3-hop v2', { ...DEFAULT_RULE, minCycles: 1 });
      expect(edited).toMatchObject({ version: 2, name: 'Blur 3-hop v2' });
      expect(await store.updateLens(lens.id + 999, 'x', DEFAULT_RULE)).toBeNull();
      expect((await store.lenses()).map((l) => l.id)).toContain(lens.id);
      expect(await store.nameTaken('blur 3-HOP V2')).toBe(true);
      expect(await store.nameTaken('Blur 3-hop v2', lens.id)).toBe(false);
      expect(await store.nameTaken('Blur 3-hop')).toBe(false);
      for (const built of ['Round trips', 'money LOOPS back', 'Linked wallets']) expect(await store.nameTaken(built)).toBe(true);
      await expect(store.createLens('BLUR 3-hop V2', DEFAULT_RULE)).rejects.toThrow();
    } finally {
      await store.deleteLens(lens.id);
    }
  });

  it('refuses to read one lens whose rule no longer checks, naming it, and leaves it out of the lists', async () => {
    const lens = await store.createLens('Corrupt', DEFAULT_RULE);
    const healthy = await store.createLens('Healthy', DEFAULT_RULE);
    const { id } = await analysed(w('1e50'));
    try {
      await store.requestLensRun(lens.id, id);
      await store.requestLensRun(healthy.id, id);
      await store.pool.query('UPDATE washtrace.lenses SET rule = \'{"edges": 3}\' WHERE id = $1', [lens.id]);
      await expect(store.lens(lens.id)).rejects.toThrow(new RegExp(`lens ${lens.id}\\b`));
      expect((await store.lenses()).map((l) => l.id)).toEqual([healthy.id]);
      expect((await store.lensRuns(id)).map((r) => r.lens.id)).toEqual([healthy.id]);
      // The corrupt lens's run is the oldest due, and is failed so the healthy one is picked in the same call.
      expect(await store.nextLensRun(Date.now())).toMatchObject({ lens: { id: healthy.id }, collectionId: id });
      const { rows } = await store.pool.query('SELECT status, error, failures, retry_at > now() AS later FROM washtrace.lens_runs WHERE lens_id = $1', [lens.id]);
      expect(rows).toEqual([{ status: 'failed', error: expect.stringMatching(/^This lens's rule can't be read: .+/), failures: 1, later: true }]);
    } finally {
      await store.deleteLens(lens.id);
      await store.deleteLens(healthy.id);
      await drop(1, w('1e50'));
    }
  });

  it('creates a lens with its first run queued in one statement, so a failure leaves neither', async () => {
    const { id } = await analysed(w('1e62'));
    const named = async (name: string) => (await store.pool.query('SELECT 1 FROM washtrace.lenses WHERE name = $1', [name])).rowCount;
    try {
      const lens = await store.createLens('With its run', DEFAULT_RULE, [id]);
      expect((await store.lensRuns(id)).find((r) => r.lens.id === lens.id)!.run).toMatchObject({ status: 'queued', lensVersion: 1, totals: null });
      await store.deleteLens(lens.id);
      // A collection gone by then fails its run's insert, and the lens and its other runs go with it.
      await expect(store.createLens('Orphaned', DEFAULT_RULE, [id, 2_000_000_000])).rejects.toMatchObject({ code: '23503', constraint: 'lens_runs_collection_id_fkey' });
      expect(await named('Orphaned')).toBe(0);
      // With no collection, the lens alone, as before.
      const alone = await store.createLens('Alone', DEFAULT_RULE);
      expect((await store.lensRuns(id)).find((r) => r.lens.id === alone.id)!.run).toBeNull();
      await store.deleteLens(alone.id);
    } finally {
      await drop(1, w('1e62'));
    }
  });

  it('lists every lens with its runs on every collection at once, a lens with none included', async () => {
    const { id } = await analysed(w('1e65'));
    const { id: other } = await analysed(w('1e66'));
    const ran = await store.createLens('Runs on two', DEFAULT_RULE, [id, other]);
    const none = await store.createLens('Runs on none', DEFAULT_RULE);
    try {
      const all = await store.lensRunsAll();
      const of = (lensId: number) => all.find((x) => x.lens.id === lensId)!;
      expect([...of(ran.id).runs.keys()].sort((a, b) => a - b)).toEqual([id, other].sort((a, b) => a - b));
      expect(of(ran.id).runs.get(id)).toMatchObject({ status: 'queued' });
      expect(of(none.id).runs.size).toBe(0);
    } finally {
      await store.deleteLens(ran.id);
      await store.deleteLens(none.id);
      await drop(1, w('1e65'));
      await drop(1, w('1e66'));
    }
  });

  it('queues a run on the collection an edit names, in the same statement, once whether or not one is there', async () => {
    const { id } = await analysed(w('1e63'));
    const { id: other } = await analysed(w('1e64'));
    const lens = await store.createLens('Edited here', DEFAULT_RULE, [other]);
    const runOf = async (c: number) => (await store.lensRuns(c)).find((r) => r.lens.id === lens.id)!.run;
    const rows = async () => Number((await store.pool.query('SELECT count(*) FROM washtrace.lens_runs WHERE lens_id = $1', [lens.id])).rows[0].count);
    try {
      // None here yet: the edit queues one at the new version; the run elsewhere is queued again as before.
      expect(await runOf(id)).toBeNull();
      expect(await store.updateLens(lens.id, 'Edited here', { ...DEFAULT_RULE, minCycles: 1 }, [id])).toMatchObject({ version: 2 });
      expect(await runOf(id)).toMatchObject({ status: 'queued', lensVersion: 2, totals: null });
      expect(await runOf(other)).toMatchObject({ status: 'queued' });
      expect(await rows()).toBe(2);
      // One already here: queued again by the same statement, never a second row, and its version stays the one its totals are from.
      await store.pool.query(`UPDATE washtrace.lens_runs SET status = 'done', totals = '{}'::jsonb WHERE lens_id = $1 AND collection_id = $2`, [lens.id, id]);
      expect(await store.updateLens(lens.id, 'Edited here', DEFAULT_RULE, [id])).toMatchObject({ version: 3 });
      expect(await runOf(id)).toMatchObject({ status: 'queued', lensVersion: 2 });
      expect(await rows()).toBe(2);
      // A collection gone by then fails the run's insert, and the edit goes with it.
      await expect(store.updateLens(lens.id, 'Renamed', DEFAULT_RULE, [2_000_000_000])).rejects.toMatchObject({ code: '23503', constraint: 'lens_runs_collection_id_fkey' });
      expect(await store.lens(lens.id)).toMatchObject({ name: 'Edited here', version: 3 });
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e63'));
      await drop(1, w('1e64'));
    }
  });

  it('refuses a second lens whose name differs only in case with the unique index (23505), which the route answers as 409', async () => {
    const lens = await store.createLens('Case Twin', DEFAULT_RULE);
    try {
      await expect(store.createLens('CASE twin', DEFAULT_RULE)).rejects.toMatchObject({ code: '23505' });
      await expect(store.updateLens(lens.id, 'Case Twin', DEFAULT_RULE)).resolves.toMatchObject({ name: 'Case Twin' });
      const other = await store.createLens('Other Twin', DEFAULT_RULE);
      try {
        await expect(store.updateLens(other.id, 'case TWIN', DEFAULT_RULE)).rejects.toMatchObject({ code: '23505' });
      } finally {
        await store.deleteLens(other.id);
      }
    } finally {
      await store.deleteLens(lens.id);
    }
  });

  it('leaves a running run alone when asked to run again', async () => {
    const lens = await store.createLens('Busy', DEFAULT_RULE);
    const { id } = await analysed(w('1e5c'));
    try {
      await store.requestLensRun(lens.id, id);
      await store.lensRunStarted(lens.id, id);
      await store.requestLensRun(lens.id, id);
      expect((await store.lensRuns(id))[0]!.run!.status).toBe('running');
      // An edit still requeues it.
      await store.updateLens(lens.id, 'Busy', DEFAULT_RULE);
      expect((await store.lensRuns(id))[0]!.run).toMatchObject({ status: 'queued', lensVersion: 1 });
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e5c'));
    }
  });

  it('requeueLensRun puts a running run back to queued with its failures unchanged, and touches nothing else', async () => {
    const lens = await store.createLens('Deploy', DEFAULT_RULE);
    const { id } = await analysed(w('1e5c'));
    const row = async () => (await store.pool.query('SELECT status, failures, progress FROM washtrace.lens_runs WHERE lens_id = $1', [lens.id])).rows[0];
    try {
      await store.requestLensRun(lens.id, id);
      await store.lensRunStarted(lens.id, id);
      await store.lensRunFailed(lens.id, id, 'earlier');
      await store.pool.query(`UPDATE washtrace.lens_runs SET status = 'running', progress = 0.4 WHERE lens_id = $1`, [lens.id]);
      await store.requeueLensRun(lens.id, id);
      expect(await row()).toEqual({ status: 'queued', failures: 1, progress: null });
      // The next worker takes it as an ordinary queued run, not as one a crash left.
      expect(await store.nextLensRun(Date.now())).toMatchObject({ lens: { id: lens.id }, collectionId: id });
      // Only while it runs: a run that has since finished or failed is not queued again.
      await store.pool.query(`UPDATE washtrace.lens_runs SET status = 'failed' WHERE lens_id = $1`, [lens.id]);
      await store.requeueLensRun(lens.id, id);
      expect((await row()).status).toBe('failed');
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e5c'));
    }
  });

  it('counts a run a stopped worker left running as a failed try, backs it off, and after three waits to be asked again', async () => {
    const lens = await store.createLens('Orphan', DEFAULT_RULE);
    const { id } = await analysed(w('1e5b'));
    const runOf = async () => (await store.lensRuns(id)).find((r) => r.lens.id === lens.id)!.run!;
    const FAR = Date.now() + 365 * 86_400_000;
    try {
      await store.requestLensRun(lens.id, id);
      await store.lensRunStarted(lens.id, id);
      expect((await runOf()).status).toBe('running');
      // A run that took the worker down would take it down again: it is not picked at once.
      expect(await store.nextLensRun(Date.now())).toBeNull();
      const first = await runOf();
      expect(first).toMatchObject({ status: 'failed', error: 'The worker stopped during this run.', progress: null });
      expect(first.retryAt! - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(await store.nextLensRun(first.retryAt! + 1_000)).toMatchObject({ lens: { id: lens.id }, collectionId: id });
      // The second and third tries stop the worker too.
      await store.lensRunStarted(lens.id, id);
      expect(await store.nextLensRun(Date.now())).toBeNull();
      expect(await runOf()).toMatchObject({ status: 'failed', retryAt: expect.any(Number) });
      expect(await store.nextLensRun(FAR)).toMatchObject({ lens: { id: lens.id } });
      await store.lensRunStarted(lens.id, id);
      expect(await store.nextLensRun(FAR)).toBeNull();
      expect(await runOf()).toMatchObject({ status: 'failed', error: 'The worker stopped during this run.', retryAt: null });
      expect(await store.nextLensRun(FAR)).toBeNull();
      const { rows } = await store.pool.query('SELECT failures FROM washtrace.lens_runs WHERE lens_id = $1', [lens.id]);
      expect(rows).toEqual([{ failures: 3 }]);
      // Asked again, it runs at once.
      await store.requestLensRun(lens.id, id);
      expect(await store.nextLensRun(Date.now())).toMatchObject({ lens: { id: lens.id } });
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e5b'));
    }
  });

  it('stops trying a run that failed three times in a row until it is asked again or edited', async () => {
    const lens = await store.createLens('Thrice', DEFAULT_RULE);
    const { id } = await analysed(w('1e5f'));
    const FAR = Date.now() + 365 * 86_400_000;
    try {
      await store.requestLensRun(lens.id, id);
      for (let i = 0; i < 3; i++) {
        expect(await store.nextLensRun(FAR)).toMatchObject({ lens: { id: lens.id } });
        await store.lensRunStarted(lens.id, id);
        await store.lensRunFailed(lens.id, id, `boom ${i}`);
      }
      expect((await store.lensRuns(id))[0]!.run).toMatchObject({ status: 'failed', error: 'boom 2', retryAt: null });
      expect(await store.nextLensRun(FAR)).toBeNull();
      await store.updateLens(lens.id, 'Thrice', DEFAULT_RULE);
      expect(await store.nextLensRun(Date.now())).toMatchObject({ lens: { id: lens.id, version: 2 } });
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e5f'));
    }
  });

  /**
   * Waits until the backend running a statement like `like` is blocked on a lock, so the interleaves below
   * need no sleep of a guessed length, and a lock some other backend waits on is not taken for it.
   */
  async function blocked(like: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rowCount } = await store.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE $1", [like],
      );
      if (rowCount) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no ${like} ever waited on a lock`);
  }
  const SAVE_WAITS = '%FROM washtrace.lenses WHERE id = $1 FOR SHARE';

  it('waits for an edit in flight, then gives stale and writes no flags', async () => {
    const lens = await store.createLens('Race edit', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e5c'));
    const other = new pgClient.Client({ connectionString: pg.getConnectionUri() });
    await other.connect();
    try {
      await store.requestLensRun(lens.id, id);
      // As updateLens does it: the lens's row, then its runs'.
      await other.query('BEGIN');
      await other.query('UPDATE washtrace.lenses SET version = 2 WHERE id = $1', [lens.id]);
      await other.query('UPDATE washtrace.lens_runs SET status = \'queued\' WHERE lens_id = $1', [lens.id]);
      const saving = store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1);
      await blocked(SAVE_WAITS);
      await other.query('COMMIT');
      expect(await saving).toBe('stale');
      expect(await flagCount(lens.id)).toBe(0);
      expect((await store.lensRuns(id))[0]!.run).toMatchObject({ status: 'queued', lensVersion: 1, totals: null });
    } finally {
      await other.end();
      await store.deleteLens(lens.id);
      await drop(1, w('1e5c'));
    }
  });

  it('waits for a delete in flight, then gives gone and writes no flags', async () => {
    const lens = await store.createLens('Race delete', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e5d'));
    const other = new pgClient.Client({ connectionString: pg.getConnectionUri() });
    await other.connect();
    try {
      await store.requestLensRun(lens.id, id);
      await other.query('BEGIN');
      await other.query('DELETE FROM washtrace.lenses WHERE id = $1', [lens.id]);
      const saving = store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1);
      await blocked(SAVE_WAITS);
      await other.query('COMMIT');
      expect(await saving).toBe('gone');
      expect(await flagCount(lens.id)).toBe(0);
    } finally {
      await other.end();
      await drop(1, w('1e5d'));
    }
  });

  it('a delete that arrives once the save holds its locks waits for it, and neither deadlocks', async () => {
    const lens = await store.createLens('Race delete late', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e60'));
    const [hold, del] = [new pgClient.Client({ connectionString: pg.getConnectionUri() }), new pgClient.Client({ connectionString: pg.getConnectionUri() })];
    await hold.connect();
    await del.connect();
    try {
      await store.requestLensRun(lens.id, id);
      expect(await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1)).toBe('saved');
      // Its old flags held elsewhere, so the second save stops at them with its own locks taken.
      await hold.query('BEGIN');
      await hold.query('SELECT 1 FROM washtrace.lens_flags WHERE lens_id = $1 FOR UPDATE', [lens.id]);
      const saving = store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, [FLAGS[0]!], 2);
      await blocked('DELETE FROM washtrace.lens_flags%');
      const deleting = del.query('DELETE FROM washtrace.lenses WHERE id = $1', [lens.id]);
      await blocked('DELETE FROM washtrace.lenses%');
      await hold.query('COMMIT');
      expect(await saving).toBe('saved');
      expect((await deleting).rowCount).toBe(1);
      expect(await flagCount(lens.id)).toBe(0);
      expect((await store.pool.query('SELECT 1 FROM washtrace.lens_runs WHERE lens_id = $1', [lens.id])).rowCount).toBe(0);
    } finally {
      await hold.end();
      await del.end();
      await store.deleteLens(lens.id);
      await drop(1, w('1e60'));
    }
  });

  /**
   * The collection's delete against the run's save. The delete (removeCollection, only of a paused collection)
   * takes the collections row FOR UPDATE, then its cascade takes lens_runs' and lens_flags' rows. The save used
   * to take the lenses row FOR SHARE, the lens_runs row FOR UPDATE and the old lens_flags rows, and only then,
   * through lens_flags' foreign key, the collections row FOR KEY SHARE: the reverse order, so each waited on
   * the other until Postgres ended one (40P01). Rare, because a run only starts on a collection that is not
   * paused: it needs the collection paused and deleted while the run is in flight.
   */
  it('a collection paused and deleted once the save holds its locks waits for it, and neither deadlocks', async () => {
    const lens = await store.createLens('Race collection late', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e66'));
    const hold = new pgClient.Client({ connectionString: pg.getConnectionUri() });
    await hold.connect();
    try {
      await store.requestLensRun(lens.id, id);
      expect(await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1)).toBe('saved');
      // Its old flags held elsewhere, so the second save stops at them with its own locks taken.
      await hold.query('BEGIN');
      await hold.query('SELECT 1 FROM washtrace.lens_flags WHERE lens_id = $1 FOR UPDATE', [lens.id]);
      const saving = store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, [FLAGS[0]!], 2);
      await blocked('DELETE FROM washtrace.lens_flags%');
      expect(await store.pause(1, w('1e66'))).toBe(true);
      const deleting = store.removeCollection(1, w('1e66'));
      await blocked('DELETE FROM washtrace.collections%');
      await hold.query('COMMIT');
      // Both settled before either is checked, so a save that throws never leaves the delete's rejection unhandled.
      const [saved, deleted] = await Promise.allSettled([saving, deleting]);
      expect(saved).toEqual({ status: 'fulfilled', value: 'saved' });
      expect(deleted).toEqual({ status: 'fulfilled', value: true });
      expect(await flagCount(lens.id)).toBe(0);
      expect((await store.pool.query('SELECT 1 FROM washtrace.lens_runs WHERE lens_id = $1', [lens.id])).rowCount).toBe(0);
    } finally {
      await hold.end();
      await store.deleteLens(lens.id);
      await drop(1, w('1e66'));
    }
  });

  it('waits for a collection delete in flight, then gives gone and writes no flags', async () => {
    const lens = await store.createLens('Race collection', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e67'));
    const other = new pgClient.Client({ connectionString: pg.getConnectionUri() });
    await other.connect();
    try {
      await store.requestLensRun(lens.id, id);
      await store.pause(1, w('1e67'));
      await other.query('BEGIN');
      await other.query('DELETE FROM washtrace.collections WHERE id = $1', [id]);
      const saving = store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1);
      await blocked('%FROM washtrace.collections WHERE id = $1 FOR KEY SHARE');
      await other.query('COMMIT');
      expect(await saving).toBe('gone');
      expect(await flagCount(lens.id)).toBe(0);
      // Run here on it now is refused by the run's foreign key, which the web's routes answer as not watched.
      await expect(store.requestLensRun(lens.id, id)).rejects.toMatchObject({ code: '23503', constraint: 'lens_runs_collection_id_fkey' });
    } finally {
      await other.end();
      await store.deleteLens(lens.id);
      await drop(1, w('1e67'));
    }
  });

  it("keeps a run's lens_version the version its totals came from: an edit and Run here leave it, the next save moves it", async () => {
    const lens = await store.createLens('Versions', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e61'));
    const runOf = async () => (await store.lensRuns(id)).find((r) => r.lens.id === lens.id)!;
    try {
      await store.requestLensRun(lens.id, id);
      expect(await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1)).toBe('saved');
      await store.updateLens(lens.id, 'Versions', DEFAULT_RULE);
      expect(await runOf()).toMatchObject({ lens: { version: 2 }, run: { status: 'queued', lensVersion: 1, totals: TOTALS, analysisId: analysis } });
      await store.requestLensRun(lens.id, id);
      expect((await runOf()).run).toMatchObject({ status: 'queued', lensVersion: 1 });
      // Picked at the new version, and saved at it.
      const picked = (await store.nextLensRun(Date.now()))!;
      expect(picked.lens.version).toBe(2);
      expect(await store.saveLensRun(lens.id, id, 2, analysis, 600, TOTALS, FLAGS, 1)).toBe('saved');
      expect((await runOf()).run).toMatchObject({ status: 'done', lensVersion: 2 });
      expect(await store.nextLensRun(Date.now())).toBeNull();
      // The latest analysis's id is on the collection, beside the run's.
      expect((await store.collection(1, w('1e61')))!.latest!.id).toBe(analysis);
      expect((await store.history(id)).map((a) => a.id)).toEqual([analysis]);
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e61'));
    }
  });

  it('deletes a lens, and its runs and flags go with it', async () => {
    const lens = await store.createLens('Doomed', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e51'));
    try {
      await store.requestLensRun(lens.id, id);
      await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 3);
      expect(await flagCount(lens.id)).toBe(2);
      expect(await store.deleteLens(lens.id)).toBe(true);
      expect(await store.deleteLens(lens.id)).toBe(false);
      expect(await flagCount(lens.id)).toBe(0);
      expect((await store.pool.query('SELECT 1 FROM washtrace.lens_runs WHERE lens_id = $1', [lens.id])).rowCount).toBe(0);
    } finally {
      await drop(1, w('1e51'));
    }
  });

  it('lists every lens for a collection, run or not', async () => {
    const lens = await store.createLens('Unrun', DEFAULT_RULE);
    const { id } = await analysed(w('1e52'));
    try {
      expect((await store.lensRuns(id)).find((r) => r.lens.id === lens.id)).toEqual({ lens, run: null });
      await store.requestLensRun(lens.id, id);
      expect((await store.lensRuns(id)).find((r) => r.lens.id === lens.id)!.run).toMatchObject({ lensId: lens.id, collectionId: id, status: 'queued', lensVersion: 1, totals: null, finishedAt: null });
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e52'));
    }
  });

  it('picks a queued run of the latest analysis, and none for a collection never analysed', async () => {
    const lens = await store.createLens('Pick', DEFAULT_RULE);
    const bare = (await store.addCollection(1, w('1e53'), null, 1)).id;
    const { id, analysis } = await analysed(w('1e54'));
    try {
      await store.requestLensRun(lens.id, bare);
      expect(await store.nextLensRun(Date.now())).toBeNull();
      await store.requestLensRun(lens.id, id);
      const next = await store.nextLensRun(Date.now());
      expect(next).toMatchObject({ lens: { id: lens.id }, collectionId: id, chainId: 1, name: 'Lab', analysisId: analysis, through: 600 });
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e53'));
      await drop(1, w('1e54'));
    }
  });

  it('saves a run with its flags, and saving again replaces them', async () => {
    const lens = await store.createLens('Save', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e55'));
    try {
      await store.requestLensRun(lens.id, id);
      await store.lensRunStarted(lens.id, id);
      await store.lensRunProgress(lens.id, id, 0.5);
      expect((await store.lensRuns(id))[0]!.run).toMatchObject({ status: 'running', progress: 0.5 });
      expect(await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 7)).toBe('saved');
      const run = (await store.lensRuns(id)).find((r) => r.lens.id === lens.id)!.run!;
      expect(run).toMatchObject({ status: 'done', progress: null, lensVersion: 1, analysisId: analysis, throughBlock: 600, totals: TOTALS, error: null, retryAt: null, tookMs: 7 });
      expect(run.finishedAt).toBeGreaterThan(0);
      const { rows } = await store.pool.query('SELECT tx_hash, log_index, path, wallets FROM washtrace.lens_flags WHERE lens_id = $1 ORDER BY tx_hash', [lens.id]);
      expect(rows).toEqual(FLAGS.map((f) => ({ tx_hash: f.txHash, log_index: f.logIndex, path: f.path, wallets: f.wallets })));
      expect(await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, [FLAGS[0]!], 7)).toBe('saved');
      expect(await flagCount(lens.id)).toBe(1);
      expect(await store.nextLensRun(Date.now())).toBeNull();
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e55'));
    }
  });

  it('queues again a run saved after its lens was edited, keeps its old totals, and writes no flags', async () => {
    const lens = await store.createLens('Stale', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e56'));
    try {
      await store.requestLensRun(lens.id, id);
      await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, [FLAGS[0]!], 1);
      await store.requestLensRun(lens.id, id);
      const picked = (await store.nextLensRun(Date.now()))!;
      await store.lensRunStarted(lens.id, id);
      await store.updateLens(lens.id, 'Stale', DEFAULT_RULE);
      expect(await store.saveLensRun(lens.id, id, picked.lens.version, analysis, 600, { ...TOTALS, flagged: 99 }, FLAGS, 1)).toBe('stale');
      expect(await flagCount(lens.id)).toBe(1);
      expect((await store.lensRuns(id))[0]!.run).toMatchObject({ status: 'queued', lensVersion: 1, totals: TOTALS });
      expect((await store.nextLensRun(Date.now()))!.lens.version).toBe(2);
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e56'));
    }
  });

  it('requeues every run of an edited lens', async () => {
    const lens = await store.createLens('Requeue', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e57'));
    try {
      await store.requestLensRun(lens.id, id);
      await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1);
      await store.updateLens(lens.id, 'Requeue', DEFAULT_RULE);
      expect((await store.lensRuns(id))[0]!.run).toMatchObject({ status: 'queued', lensVersion: 1, totals: TOTALS });
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e57'));
    }
  });

  it('writes nothing for a lens deleted mid-run', async () => {
    const lens = await store.createLens('Gone', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e58'));
    try {
      await store.requestLensRun(lens.id, id);
      await store.nextLensRun(Date.now());
      await store.deleteLens(lens.id);
      expect(await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1)).toBe('gone');
      expect(await flagCount(lens.id)).toBe(0);
    } finally {
      await drop(1, w('1e58'));
    }
  });

  it('runs a done lens again after a newer analysis, and not while the collection is paused', async () => {
    const lens = await store.createLens('Again', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e59'));
    try {
      await store.requestLensRun(lens.id, id);
      await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1);
      expect(await store.nextLensRun(Date.now())).toBeNull();
      await store.saveAnalysis(id, 2, LAB.analysis, 5, 700, MONEY);
      const later = Date.now() + ANALYZE_GAP_MS + 1_000;
      const next = (await store.nextLensRun(later))!;
      expect(next).toMatchObject({ collectionId: id, analysisId: await latest(id), through: 700 });
      await store.pause(1, w('1e59'));
      expect(await store.nextLensRun(later)).toBeNull();
    } finally {
      await drop(1, w('1e59'));
      await store.deleteLens(lens.id);
    }
  });

  it('runs a done lens again for a newer analysis only once the gap has passed since it finished, twice its length if longer; an edit or Run here does not wait', async () => {
    const lens = await store.createLens('Gap', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e5e'));
    try {
      await store.requestLensRun(lens.id, id);
      expect(await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1)).toBe('saved');
      await store.saveAnalysis(id, 2, LAB.analysis, 5, 700, MONEY);
      const now = Date.now();
      expect(await store.nextLensRun(now)).toBeNull();
      expect(await store.nextLensRun(now + ANALYZE_GAP_MS + 1_000)).toMatchObject({ collectionId: id, through: 700 });
      // A run that took ten minutes waits twenty.
      await store.pool.query('UPDATE washtrace.lens_runs SET took_ms = 600000 WHERE lens_id = $1', [lens.id]);
      expect(await store.nextLensRun(now + ANALYZE_GAP_MS + 1_000)).toBeNull();
      expect(await store.nextLensRun(now + 20 * 60_000 + 1_000)).toMatchObject({ collectionId: id });
      // Asked for, it is due at once.
      await store.requestLensRun(lens.id, id);
      expect(await store.nextLensRun(now)).toMatchObject({ collectionId: id });
      expect(await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1)).toBe('saved');
      await store.updateLens(lens.id, 'Gap', DEFAULT_RULE);
      expect(await store.nextLensRun(now)).toMatchObject({ collectionId: id, lens: { version: 2 } });
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e5e'));
    }
  });

  it("runs a token lens again once token_counts.read moves off its run's tokens_read, not sooner than the gap; a lens not using tokens is not; the run record carries tokensRead; collections.version is untouched", async () => {
    const rule = structuredClone(DEFAULT_RULE);
    rule.edges['other-tokens'].use = true;
    const tokens = await store.createLens('Tokens due', rule);
    const plain = await store.createLens('Plain due', DEFAULT_RULE);
    const { id, analysis } = await analysed(w('1e7a'));
    const version = async () => (await store.pool.query('SELECT version::int AS v FROM washtrace.collections WHERE id = $1', [id])).rows[0].v;
    const trader = LAB.transfers.find((t) => t.from !== ZERO)!.from;
    try {
      // Started, its traders in its walk, and counted with nothing read yet.
      expect(await store.startTokens(id)).toBe('set');
      await store.pool.query(
        'INSERT INTO washtrace.reach (collection_id, chain_id, address, depth, stepped) SELECT $1, 1, unnest($2::text[]), 0, true ON CONFLICT DO NOTHING',
        [id, [...new Set(LAB.transfers.flatMap((t) => [t.from, t.to]))].filter((x) => x !== ZERO)],
      );
      await store.countTokens(1, 3, false, Date.now() + TOKEN_COUNT_MS);
      const before = await version();
      for (const l of [tokens, plain]) {
        await store.requestLensRun(l.id, id);
        expect(await store.saveLensRun(l.id, id, 1, analysis, 600, TOTALS, FLAGS, 1, l === tokens ? 0 : null)).toBe('saved');
      }
      const runOf = async (lensId: number) => (await store.lensRuns(id)).find((r) => r.lens.id === lensId)!.run!;
      expect((await runOf(tokens.id)).tokensRead).toBe(0);
      expect((await runOf(plain.id)).tokensRead).toBeNull();
      const now = Date.now();
      expect(await store.nextLensRun(now + ANALYZE_GAP_MS + 1_000)).toBeNull();
      // A wallet read and counted: the token lens is due once the gap has passed since it finished, the other never.
      await store.saveTokens(1, trader, [], false);
      await store.countTokens(1, 3, false, Date.now() + TOKEN_COUNT_MS);
      expect(((await store.pool.query('SELECT token_counts FROM washtrace.collections WHERE id = $1', [id])).rows[0].token_counts as TokenCounts).read).toBe(1);
      expect(await version()).toBe(before);
      expect(await store.nextLensRun(now)).toBeNull();
      const due = (await store.nextLensRun(now + ANALYZE_GAP_MS + 1_000))!;
      expect(due).toMatchObject({ lens: { id: tokens.id }, collectionId: id });
      expect(Math.abs(due.dueAt - ((await runOf(tokens.id)).finishedAt! + ANALYZE_GAP_MS))).toBeLessThan(5);
      // A run that took ten minutes waits twenty.
      await store.pool.query('UPDATE washtrace.lens_runs SET took_ms = 600000 WHERE lens_id = $1', [tokens.id]);
      expect(await store.nextLensRun(now + ANALYZE_GAP_MS + 1_000)).toBeNull();
      expect(await store.nextLensRun(now + 20 * 60_000 + 1_000)).toMatchObject({ lens: { id: tokens.id } });
      // Run again with the count it read: not due, however long after.
      expect(await store.saveLensRun(tokens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1, 1)).toBe('saved');
      expect(await store.nextLensRun(now + 60 * 60_000)).toBeNull();
      // Counts holding only `tried` (a first count that timed out) are no counts: nothing to be behind.
      await store.pool.query(`UPDATE washtrace.collections SET token_counts = '{"tried": "2026-11-09T00:00:00.000Z"}' WHERE id = $1`, [id]);
      expect(await store.nextLensRun(now + 60 * 60_000)).toBeNull();
      expect(await version()).toBe(before);
    } finally {
      await store.deleteLens(tokens.id);
      await store.deleteLens(plain.id);
      await store.pool.query('DELETE FROM washtrace.token_reads WHERE chain_id = 1 AND address = $1', [trader]);
      await drop(1, w('1e7a'));
    }
  });

  it("a run due by its token reads alone is due from the gap's end, never from the count's time, which every pass rewrites: after LENS_WAIT_MS it goes before a due analysis", async () => {
    const rule = structuredClone(DEFAULT_RULE);
    rule.edges['other-tokens'].use = true;
    const lens = await store.createLens('Tokens wait', rule);
    const { id, analysis } = await analysed(w('1e7b'));
    const iso = (ms: number) => new Date(ms).toISOString();
    try {
      await store.requestLensRun(lens.id, id);
      expect(await store.saveLensRun(lens.id, id, 1, analysis, 600, TOTALS, FLAGS, 1, 0)).toBe('saved');
      const finished = (await store.lensRuns(id)).find((r) => r.lens.id === lens.id)!.run!.finishedAt!;
      const gapEnd = finished + ANALYZE_GAP_MS;
      const now = gapEnd + LENS_WAIT_MS + 1_000;
      // The read moved, and the count was written again just now, long after the gap's end.
      await store.pool.query('UPDATE washtrace.collections SET token_counts = $2 WHERE id = $1', [id, JSON.stringify({ wallets: 3, read: 1, at: iso(now) })]);
      const due = (await store.nextLensRun(now))!;
      expect(due).toMatchObject({ lens: { id: lens.id }, collectionId: id });
      expect(Math.abs(due.dueAt - gapEnd)).toBeLessThan(5);
      // So the pass, with an analysis due, runs it rather than giving way again.
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const worker = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 3, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
      (worker as unknown as { dueAnalysis: () => Promise<unknown> }).dueAnalysis = async () => ({ id: 0 });
      worker.lensOff = async () => ({ totals: TOTALS, flags: [], tokensRead: 1 });
      expect(await worker.run('analyze')).toBe('ran');
      expect(await said('lens')).toBe('Ran Tokens wait on Lab');
    } finally {
      vi.restoreAllMocks();
      await store.deleteLens(lens.id);
      await drop(1, w('1e7b'));
    }
  });

  it('picks a run asked for before re-runs that have waited longer, and says since when each was due', async () => {
    const { id, analysis } = await analysed(w('1e65'));
    const made = [];
    for (const name of ['Rerun 1', 'Rerun 2', 'Rerun 3', 'Fresh']) made.push(await store.createLens(name, DEFAULT_RULE));
    const fresh = made.at(-1)!;
    const reruns = made.slice(0, 3).map((l) => l.id);
    try {
      for (const l of reruns) {
        await store.requestLensRun(l, id);
        expect(await store.saveLensRun(l, id, 1, analysis, 600, TOTALS, FLAGS, 1)).toBe('saved');
      }
      // Asked for a day ago, each a minute apart, so the oldest is first among them.
      await store.pool.query(`UPDATE washtrace.lens_runs SET requested_at = now() - interval '1 day' + make_interval(mins => lens_id - $2) WHERE collection_id = $1`, [id, reruns[0]]);
      await store.saveAnalysis(id, 2, LAB.analysis, 5, 700, MONEY);
      const later = Date.now() + ANALYZE_GAP_MS + 1_000;
      const rerun = (await store.nextLensRun(later))!;
      expect(rerun.lens.id).toBe(reruns[0]);
      // A re-run is due once the gap has passed since it finished (the newer analysis came before that).
      const finished = (await store.lensRuns(id)).find((r) => r.lens.id === reruns[0])!.run!.finishedAt!;
      expect(Math.abs(rerun.dueAt - (finished + ANALYZE_GAP_MS))).toBeLessThan(5);

      const asked = Date.now();
      await store.requestLensRun(fresh.id, id);
      const next = (await store.nextLensRun(later))!;
      expect(next.lens.id).toBe(fresh.id);
      // A queued one is due from when it was asked for.
      expect(Math.abs(next.dueAt - asked)).toBeLessThan(2_000);
      // A failed one is due from its retry.
      await store.lensRunStarted(fresh.id, id);
      await store.lensRunFailed(fresh.id, id, 'boom');
      const retry = (await store.lensRuns(id)).find((r) => r.lens.id === fresh.id)!.run!.retryAt!;
      await store.pool.query(`UPDATE washtrace.lens_runs SET requested_at = now() - interval '2 days' WHERE lens_id = $1`, [fresh.id]);
      const failed = (await store.nextLensRun(retry + 1_000))!;
      expect(failed.lens.id).toBe(fresh.id);
      expect(Math.abs(failed.dueAt - retry)).toBeLessThan(5);
    } finally {
      for (const l of made) await store.deleteLens(l.id);
      await drop(1, w('1e65'));
    }
  });

  it('backs a failed run off, and picks it only once its time has come', async () => {
    const lens = await store.createLens('Fails', DEFAULT_RULE);
    const { id } = await analysed(w('1e5a'));
    try {
      await store.requestLensRun(lens.id, id);
      await store.lensRunStarted(lens.id, id);
      await store.lensRunFailed(lens.id, id, 'boom');
      const run = (await store.lensRuns(id))[0]!.run!;
      expect(run).toMatchObject({ status: 'failed', error: 'boom' });
      expect(run.retryAt! - Date.now()).toBeGreaterThan(4 * 60_000);
      expect(await store.nextLensRun(Date.now())).toBeNull();
      expect(await store.nextLensRun(run.retryAt! + 1000)).toMatchObject({ lens: { id: lens.id } });
      // A second failure in a row waits longer.
      await store.lensRunStarted(lens.id, id);
      await store.lensRunFailed(lens.id, id, 'again');
      expect((await store.lensRuns(id))[0]!.run!.retryAt! - Date.now()).toBeGreaterThan(9 * 60_000);
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e5a'));
    }
  });

  it('a saved lens runs end to end: the worker picks it, runs it and keeps its flags, which are the built-in\'s', async () => {
    const lens = await store.createLens('Round trips copy', COPIES.A.rule);
    const { id } = await analysed(w('1e5b'));
    try {
      await store.requestLensRun(lens.id, id);
      const worker = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), pg.getConnectionUri());
      // In-process, as analyzeOff is in the tests above: the thread only runs compiled.
      worker.lensOff = (request, onProgress) => lensStored(store, request, onProgress);
      // Other tests leave collections waiting to be analysed, and a due analysis goes first: this one is about the lens.
      worker.dueAnalysis = async () => null;
      expect(await worker.run('analyze')).toBe('ran');
      const run = (await store.lensRuns(id)).find((r) => r.lens.id === lens.id)!.run!;
      expect(run).toMatchObject({ status: 'done', error: null, lensVersion: 1 });
      const keys = async (sql: string, params: unknown[]) => (await store.pool.query(sql, params)).rows.map((r) => `${r.tx_hash} ${r.log_index}`).sort();
      const mine = await keys('SELECT tx_hash, log_index FROM washtrace.lens_flags WHERE collection_id = $1 AND lens_id = $2', [id, lens.id]);
      const theirs = await keys("SELECT tx_hash, log_index FROM washtrace.flags WHERE collection_id = $1 AND method = 'A'", [id]);
      expect(theirs.length).toBeGreaterThan(0);
      expect(mine).toEqual(theirs);
      // Nothing is due now: the pass ends with nothing to do.
      expect(await worker.run('analyze')).toBe('ran');
      expect(await said('lens')).toBe('nothing due');
    } finally {
      await store.deleteLens(lens.id);
      await drop(1, w('1e5b'));
    }
  });
});

describe('previews', () => {
  beforeAll(async () => { await store.migrate(); });

  const sale = (i: number, more: Partial<Transfer> = {}) =>
    transfer(String(i), a, b, { txHash: `0xpv${i}`, logIndex: 0, blockNumber: i, blockTime: 1_000 + i, marketplace: 'blur', priceWei: '1', currency: '', ...more });
  const keysOf = async (id: number, through: number | null) => (await store.pool.query(
    `SELECT tx_hash || ':' || log_index AS k FROM washtrace.transfers WHERE collection_id = $1 AND marketplace IS NOT NULL AND ($2::bigint IS NULL OR block_number <= $2::bigint)`, [id, through],
  )).rows.map((r) => r.k as string).sort();

  /** A collection ingested and analysed as the worker would leave it, through block 600. */
  async function analysed(address: string): Promise<number> {
    const { id } = await store.addCollection(1, address, 'Lab', 1);
    await store.ingest(id, 1, LAB.transfers, LAB.cursor, []);
    await store.saveAnalysis(id, 1, LAB.analysis, 5, 600, MONEY);
    return id;
  }

  /** The next notification on `channel`, or null after `ms`. */
  async function heard(channel: string, act: () => Promise<unknown>, ms = 2_000): Promise<string | null> {
    const listener = new pgClient.Client({ connectionString: pg.getConnectionUri() });
    await listener.connect();
    try {
      await listener.query(`LISTEN ${channel}`);
      const got = new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        listener.on('notification', (n) => { clearTimeout(timer); resolve(n.payload ?? ''); });
      });
      await act();
      return await got;
    } finally {
      await listener.end();
    }
  }

  it('keeps previews in a table of their own, with the queued ones indexed by when they were asked for', async () => {
    const { rows } = await store.pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'washtrace' AND tablename = 'lens_previews' AND indexdef LIKE '%requested_at%'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\(requested_at\) WHERE \(status = 'queued'::text\)/);
    await expect(store.pool.query(`INSERT INTO washtrace.lens_previews (collection_id, rule, status) VALUES (-1, '{}', 'queued')`)).rejects.toThrow(/foreign key/);
  });

  it('previewSample is seeded and repeatable, and takes all sales under 2,000', async () => {
    const big = (await store.addCollection(1, w('1b01'), 'Big', 1)).id;
    const small = await analysed(w('1b02'));
    try {
      // 2,600 sales and 50 changes of owner that are not; the last 100 sales are past the block the preview reads through.
      const ts = [...Array.from({ length: 2_600 }, (_, i) => sale(i + 1)), ...Array.from({ length: 50 }, (_, i) => sale(5_000 + i, { marketplace: null, priceWei: null, currency: null }))];
      await store.ingest(big, 1, ts, 6_000, []);
      const eligible = new Set(await keysOf(big, 2_500));
      expect(eligible.size).toBe(2_500);
      const one = await store.previewSample(big, 7, 2_500);
      expect(one).toHaveLength(2_000);
      expect(new Set(one).size).toBe(2_000);
      expect(one.every((k) => eligible.has(k))).toBe(true);
      // The same seed gives the same sample, in the same order; another seed another.
      expect(await store.previewSample(big, 7, 2_500)).toEqual(one);
      const other = await store.previewSample(big, 8, 2_500);
      expect(other).toHaveLength(2_000);
      expect(new Set(other)).not.toEqual(new Set(one));
      // Under 2,000 sales, all of them, and none past the block.
      expect((await store.previewSample(small, 7, 600)).sort()).toEqual(await keysOf(small, 600));
      expect((await store.previewSample(small, 7, 600))).toHaveLength(7);
      expect((await store.previewSample(small, 7, null)).sort()).toEqual(await keysOf(small, null));
      expect(await store.previewSample(small, 7, 0)).toEqual([]);
    } finally {
      await drop(1, w('1b01'));
      await drop(1, w('1b02'));
    }
  });

  it('requestPreview answers no-sales for a collection with none, and notifies', async () => {
    const none = (await store.addCollection(1, w('1b11'), 'No analysis', 1)).id;
    const unsold = (await store.addCollection(1, w('1b12'), 'Unsold', 1)).id;
    const lab = await analysed(w('1b13'));
    const count = async () => Number((await store.pool.query('SELECT count(*) FROM washtrace.lens_previews WHERE collection_id = ANY($1)', [[none, unsold, lab]])).rows[0].count);
    try {
      expect(await store.requestPreview(none, DEFAULT_RULE)).toBe('not-analysed');
      const ts = chain('1', a, b, x);
      await store.ingest(unsold, 1, ts, 1_000, []);
      await store.saveAnalysis(unsold, 1, analyze(input(ts)), 5, 1_000, MONEY);
      let said: unknown;
      expect(await heard('washtrace_previews', async () => { said = await store.requestPreview(unsold, DEFAULT_RULE); }, 500)).toBeNull();
      expect(said).toBe('no-sales');
      // A sale past the block the latest analysis read through is not one it can preview.
      await store.ingest(unsold, 1, [transfer('1', x, a, { blockNumber: 2_000, marketplace: 'blur', priceWei: '1', currency: '' })], 2_000, []);
      expect(await store.requestPreview(unsold, DEFAULT_RULE)).toBe('no-sales');
      expect(await count()).toBe(0);
      // With sales, queued, and the worker told its id.
      let asked: unknown;
      const payload = await heard('washtrace_previews', async () => { asked = await store.requestPreview(lab, DEFAULT_RULE); });
      expect(asked).toEqual({ id: expect.any(Number) });
      const { id } = asked as { id: number };
      expect(payload).toBe(String(id));
      expect(await store.preview(id)).toMatchObject({ id, collectionId: lab, rule: DEFAULT_RULE, status: 'queued', progress: null, result: null, error: null, finishedAt: null });
      expect(Math.abs((await store.preview(id))!.requestedAt - Date.now())).toBeLessThan(5_000);
      expect(await store.preview(id + 9_999)).toBeNull();
    } finally {
      await drop(1, w('1b11'));
      await drop(1, w('1b12'));
      await drop(1, w('1b13'));
    }
  });

  it('requeuePreview puts a running preview back to queued, and only one that is running', async () => {
    const lab = await analysed(w('1b22'));
    try {
      const p = await store.requestPreview(lab, DEFAULT_RULE) as { id: number };
      await store.pool.query(`UPDATE washtrace.lens_previews SET status = 'running', progress = 0.3 WHERE id = $1`, [p.id]);
      await store.requeuePreview(p.id);
      expect(await store.preview(p.id)).toMatchObject({ status: 'queued', progress: null });
      await store.requeuePreview(p.id);
      expect(await store.preview(p.id)).toMatchObject({ status: 'queued' });
      await store.previewFailed(p.id, 'x');
      await store.pool.query(`UPDATE washtrace.lens_previews SET status = 'done' WHERE id = $1`, [p.id]);
      await store.requeuePreview(p.id);
      expect(await store.preview(p.id)).toMatchObject({ status: 'done' });
    } finally {
      await drop(1, w('1b22'));
    }
  });

  it('nextPreview takes the oldest queued and marks it running, failing one a stopped worker left running', async () => {
    const lab = await analysed(w('1b21'));
    try {
      const left = await store.requestPreview(lab, DEFAULT_RULE) as { id: number };
      const first = await store.requestPreview(lab, COPIES.A.rule) as { id: number };
      const second = await store.requestPreview(lab, DEFAULT_RULE) as { id: number };
      await store.pool.query(`UPDATE washtrace.lens_previews SET status = 'running' WHERE id = $1`, [left.id]);
      // The latest analysis is the one read through.
      await store.saveAnalysis(lab, 1, LAB.analysis, 5, 650, MONEY);
      expect(await store.nextPreview()).toEqual({ id: first.id, collectionId: lab, chainId: 1, name: 'Lab', rule: COPIES.A.rule, through: 650 });
      expect(await store.preview(left.id)).toMatchObject({ status: 'failed', error: 'The worker stopped during this preview.', finishedAt: expect.any(Number) });
      expect(await store.preview(first.id)).toMatchObject({ status: 'running', progress: 0 });
      await store.previewProgress(first.id, 0.4);
      expect((await store.preview(first.id))!.progress).toBeCloseTo(0.4);
      const result = { sampled: 7, judged: 7, hops: 7, ofSales: 7, caught: 4, atLeast: false, roundTrips: { caught: 4 }, topMarket: { name: 'Blur', caught: 4 }, truncated: 0, untimed: 0, tookMs: 12 };
      await store.savePreview(first.id, result);
      expect(await store.preview(first.id)).toMatchObject({ status: 'done', result, error: null, finishedAt: expect.any(Number) });
      // The next one's turn; it fails.
      expect((await store.nextPreview())!.id).toBe(second.id);
      await store.previewFailed(second.id, 'boom');
      expect(await store.preview(second.id)).toMatchObject({ status: 'failed', error: 'boom', result: null, finishedAt: expect.any(Number) });
      expect(await store.nextPreview()).toBeNull();
    } finally {
      await drop(1, w('1b21'));
    }
  });

  it('a preview is deleted with its collection', async () => {
    const lab = await analysed(w('1b31'));
    const { id } = await store.requestPreview(lab, DEFAULT_RULE) as { id: number };
    expect(await store.preview(id)).not.toBeNull();
    await drop(1, w('1b31'));
    expect(await store.preview(id)).toBeNull();
  });

  it('sweepFinished deletes rows past an hour', async () => {
    const lab = await analysed(w('1b41'));
    try {
      const old = await store.requestPreview(lab, DEFAULT_RULE) as { id: number };
      const done = await store.requestPreview(lab, DEFAULT_RULE) as { id: number };
      const fresh = await store.requestPreview(lab, DEFAULT_RULE) as { id: number };
      await store.pool.query(`UPDATE washtrace.lens_previews SET requested_at = now() - interval '61 minutes' WHERE id = ANY($1)`, [[old.id, done.id]]);
      await store.pool.query(`UPDATE washtrace.lens_previews SET status = 'done', finished_at = now() WHERE id = $1`, [done.id]);
      expect(await store.sweepFinished(Date.now())).toBe(2);
      expect(await store.preview(old.id)).toBeNull();
      expect(await store.preview(done.id)).toBeNull();
      expect(await store.preview(fresh.id)).not.toBeNull();
      // By the clock it is given: an hour on, the fresh one goes too.
      expect(await store.sweepFinished(Date.now() + 61 * 60_000)).toBe(1);
      expect(await store.preview(fresh.id)).toBeNull();
    } finally {
      await drop(1, w('1b41'));
    }
  });

  it('previews Round trips\' copy on the sample, catching what Round trips caught there, without reading any money edge\'s hash', async () => {
    const lab = await analysed(w('1b51'));
    const moveTxs = vi.spyOn(store, 'moveTxs');
    try {
      const { id } = await store.requestPreview(lab, COPIES.A.rule) as { id: number };
      const request = { storeUrl: pg.getConnectionUri(), previewId: id, followHops: 3, payees: false, ...(await store.nextPreview())! };
      const shares: number[] = [];
      const result = await previewStored(store, request, (s) => shares.push(s));
      // Seven sales, all sampled: the copy catches Round trips' four, three on Blur and one on OpenSea.
      expect(result).toEqual({
        sampled: 7, judged: 7, hops: 7, ofSales: 7, caught: 4, atLeast: false, roundTrips: { caught: 4 }, topMarket: { name: 'Blur', caught: 3 },
        truncated: 0, untimed: 0, tookMs: expect.any(Number),
      });
      expect(shares.at(-1)).toBe(1);
      expect(moveTxs).not.toHaveBeenCalled();
      // Nothing saved by it: the worker saves.
      expect(await store.preview(id)).toMatchObject({ status: 'running', result: null });
      // Round trips did not run on the latest analysis: no share of it to give.
      await store.pool.query(`UPDATE washtrace.analyses SET totals = jsonb_set(totals, '{A,available}', 'false') WHERE collection_id = $1`, [lab]);
      expect((await previewStored(store, request, () => {})).roundTrips).toBeNull();
    } finally {
      moveTxs.mockRestore();
      await drop(1, w('1b51'));
    }
  });

  it('the worker runs a queued preview end to end in its pass, and saves the result', async () => {
    const lab = await analysed(w('1b61'));
    try {
      const { id } = await store.requestPreview(lab, COPIES.A.rule) as { id: number };
      const worker = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), pg.getConnectionUri());
      worker.previewOff = (request, onProgress) => previewStored(store, request, onProgress);
      expect(await worker.run('analyze')).toBe('ran');
      expect(await store.preview(id)).toMatchObject({ status: 'done', error: null, result: { sampled: 7, caught: 4, roundTrips: { caught: 4 } } });
    } finally {
      await drop(1, w('1b61'));
    }
  });
});

describe('Store.lensInput', () => {
  const eth = (n: number) => String(BigInt(Math.round(n * 1000)) * 10n ** 15n);
  // Only the edges among a setup's own wallets: a full run leaves other tests' followed wallets, whose flows every read includes.
  const edgesOf = (m: Awaited<ReturnType<Store['lensInput']>>['moves'], s: { d1: string; d2: string; d3: string; out: string; fol: string }) => {
    const mine = new Set([s.d1, s.d2, s.d3, s.out, s.fol]);
    return Array.from({ length: m.size }, (_, i) => ({ from: m.name(m.from[i]!), to: m.name(m.to[i]!), kind: m.kind[i]!, eth: m.amountEth[i]!, time: m.time[i]!, block: m.block[i]!, sale: m.sale[i]! }))
      .filter((e) => mine.has(e.from) && mine.has(e.to));
  };

  // Flows outlive a dropped collection, so each setup has wallets and hashes of its own.
  let runs = 0;
  async function setup() {
    await store.migrate(); // a no-op in a full run; lets these run by themselves
    const n = ++runs;
    const d1 = w(`1a1${n}`), d2 = w(`1a2${n}`), d3 = w(`1a3${n}`), out = w(`1a4${n}`), fol = w(`1af${n}`), addr = w(`1a0c${n}`);
    const { id } = await store.addCollection(1, addr, null, 1);
    const ts = chain('9', d1, d2);
    await store.ingest(id, 1, ts, 1_000_000, []);
    const saleTx = ts[1]!.txHash;
    await store.pool.query(`INSERT INTO washtrace.wallets (chain_id, address, depth, status) VALUES (1, $1, 1, 'done') ON CONFLICT DO NOTHING`, [fol]);
    const dust = flow(d1, d2, { valueWei: eth(0.001), txHash: `0xla_dust${n}` });
    const inSale = flow(d1, d2, { valueWei: eth(0.05), txHash: saleTx });
    const usdc = flow(d1, d2, { kind: 'token', token: USDC, valueWei: eth(0.5), txHash: `0xla_usdc${n}` });
    const bid = flow(d1, d3, { kind: 'token', token: WETH, valueWei: eth(0.02), txHash: `0xla_weth${n}` });
    const internal = flow(d3, d1, { kind: 'internal', valueWei: eth(0.03), txHash: `0xla_int${n}` });
    const fromFollowed = flow(fol, out, { valueWei: eth(0.05), txHash: `0xla_fol${n}` });
    const intoFollowed = flow(out, fol, { valueWei: eth(0.05), txHash: `0xla_into${n}` });
    await store.saveMoney(1, d1, [dust, inSale, usdc, bid, internal], false);
    await store.saveMoney(1, fol, [fromFollowed, intoFollowed], false);
    return { id, addr, ts, d1, d2, d3, out, fol, saleTx, inSale, bid, internal, fromFollowed };
  }

  /** Drops the collection, and the flows and followed wallet that would otherwise reach the next test. */
  async function finish(s: Awaited<ReturnType<typeof setup>>) {
    await drop(1, s.addr);
    await store.pool.query('DELETE FROM washtrace.flows WHERE from_address = ANY($1) OR to_address = ANY($1)', [[s.d1, s.d2, s.d3, s.out, s.fol]]);
    await store.pool.query('DELETE FROM washtrace.wallets WHERE chain_id = 1 AND address = $1', [s.fol]);
  }

  it('reads the money the rule may use: kinds, floors, sale-tx edges kept and marked, followed reach as analysisInput', async () => {
    const s = await setup();
    try {
      const read = await store.lensInput(s.id, 1, DEFAULT_RULE, null, 3);
      const edges = edgesOf(read.moves, s);
      // Absent: the 0.001 ETH dust, the USDC flow, and the outside -> followed flow.
      expect(edges).toHaveLength(4);
      expect(edges.find((e) => e.from === s.d1 && e.to === s.d2)).toMatchObject({ kind: 0, eth: Math.fround(0.05), block: s.inSale.blockNumber, time: s.inSale.blockTime, sale: 1 });
      expect(read.tradeTxs.indexOf(s.saleTx)).toBeGreaterThanOrEqual(0);
      expect(edges.find((e) => e.to === s.d3)).toMatchObject({ kind: 2, eth: Math.fround(0.02), sale: 0 });
      expect(edges.find((e) => e.from === s.d3)).toMatchObject({ kind: 1, eth: Math.fround(0.03), sale: 0 });
      expect(edges.find((e) => e.from === s.fol)).toMatchObject({ kind: 0, to: s.out, sale: 0 });
      expect(edges.some((e) => e.to === s.fol)).toBe(false);
      // The same reach as analysisInput: every payment it reads is among these (it drops the sale-tx one, which a lens keeps).
      const paid = (await store.analysisInput(s.id, 1, 3)).payments;
      const mine = new Set(edges.map((e) => `${e.from}>${e.to}`));
      const own = new Set([s.d1, s.d2, s.d3, s.out, s.fol]);
      const theirs = Array.from({ length: paid.size }, (_, i) => [paid.names[paid.ends[2 * i]!]!, paid.names[paid.ends[2 * i + 1]!]!] as const)
        .filter(([f, t]) => own.has(f) && own.has(t));
      expect(theirs.length).toBeGreaterThan(0);
      for (const [f, t] of theirs) expect(mine.has(`${f}>${t}`)).toBe(true);
      expect(read.transfers).toHaveLength(s.ts.length);
      expect(read.tradeTxs).toEqual(s.ts.map((t) => t.txHash));
      expect(read.through).toBeNull();
      expect(read.money.has(WETH)).toBe(true);
    } finally {
      await finish(s);
    }
  });

  it('reads which of its wallets had their funding history cut short, as analysisInput does, and none with no money row', async () => {
    const s = await setup();
    try {
      // D2 traded here and has more history than the funding source pages through; D3 never traded here.
      await store.pool.query(
        `INSERT INTO washtrace.wallets (chain_id, address, depth, status, truncated) VALUES (1, $1, 0, 'done', true), (1, $2, 0, 'done', true)`, [s.d2, s.d3],
      );
      const read = await store.lensInput(s.id, 1, DEFAULT_RULE, null, 3);
      expect([...read.truncated].filter((t) => [s.d1, s.d2, s.d3].includes(t))).toEqual([s.d2]);
      expect([...(await store.analysisInput(s.id, 1, 3)).truncated].filter((t) => [s.d1, s.d2, s.d3].includes(t))).toEqual([s.d2]);
      const off = (k: 'eth' | 'internal' | 'weth') => ({ ...DEFAULT_RULE.edges[k], use: false });
      const none = { ...DEFAULT_RULE, edges: { ...DEFAULT_RULE.edges, eth: off('eth'), internal: off('internal'), weth: off('weth') } };
      expect((await store.lensInput(s.id, 1, none, null, 3)).truncated.size).toBe(0);
    } finally {
      await store.pool.query('DELETE FROM washtrace.wallets WHERE chain_id = 1 AND address = ANY($1)', [[s.d2, s.d3]]);
      await finish(s);
    }
  });

  it('pushes the switched-off kinds and the floor into SQL, and reads no flows with no money row', async () => {
    const s = await setup();
    try {
      const noEth = { ...DEFAULT_RULE, edges: { ...DEFAULT_RULE.edges, eth: { ...DEFAULT_RULE.edges.eth, use: false } } };
      const kinds = async (rule: typeof DEFAULT_RULE) => new Set(edgesOf((await store.lensInput(s.id, 1, rule, null, 3)).moves, s).map((e) => e.kind));
      expect(await kinds(noEth)).toEqual(new Set([1, 2]));
      // A zero floor lets the dust in; a 0.04 ETH floor takes out the 0.02 WETH.
      const low = { ...DEFAULT_RULE, edges: { ...DEFAULT_RULE.edges, eth: { ...DEFAULT_RULE.edges.eth, minWei: null } } };
      expect(edgesOf((await store.lensInput(s.id, 1, low, null, 3)).moves, s)).toHaveLength(5);
      const high = { ...DEFAULT_RULE, edges: { ...DEFAULT_RULE.edges, weth: { ...DEFAULT_RULE.edges.weth, minWei: eth(0.04) } } };
      expect(await kinds(high)).toEqual(new Set([0, 1]));
      const off = (k: 'eth' | 'internal' | 'weth') => ({ ...DEFAULT_RULE.edges[k], use: false });
      const none = { ...DEFAULT_RULE, edges: { ...DEFAULT_RULE.edges, eth: off('eth'), internal: off('internal'), weth: off('weth') } };
      const read = await store.lensInput(s.id, 1, none, null, 3);
      expect(read.moves.size).toBe(0);
      expect(read.transfers).toHaveLength(s.ts.length);
    } finally {
      await finish(s);
    }
  });

  it("reads money of the same second in the flows key's order, so a capped search is the same every run", async () => {
    const s = await setup();
    try {
      // Two ties, one stored in its hashes' order and one against it: whatever order the table keeps, one would show it.
      const first = { blockNumber: 777_000 + runs, blockTime: 1_700_000_000 + runs };
      const second = { blockNumber: 778_000 + runs, blockTime: 1_700_100_000 + runs };
      // Values against the hashes' order too, so neither the amount nor the storing order can stand in for the key.
      await store.saveMoney(1, s.d1, [
        flow(s.d1, s.d3, { ...first, valueWei: eth(0.06), txHash: `0xla_tie_b${runs}` }),
        flow(s.d1, s.d3, { ...first, valueWei: eth(0.07), txHash: `0xla_tie_a${runs}` }),
        flow(s.d1, s.d3, { ...second, valueWei: eth(0.09), txHash: `0xla_tie_c${runs}` }),
        flow(s.d1, s.d3, { ...second, valueWei: eth(0.08), txHash: `0xla_tie_d${runs}` }),
      ], false);
      // A small table is read through its primary key, which is already that order; a big one is scanned, as here.
      const url = new URL(pg.getConnectionUri());
      url.searchParams.set('options', '-c enable_indexscan=off -c enable_bitmapscan=off -c enable_indexonlyscan=off');
      const scanned = Store.connect(url.toString());
      try {
        const edges = edgesOf((await scanned.lensInput(s.id, 1, DEFAULT_RULE, null, 3)).moves, s)
          .filter((e) => e.time === first.blockTime || e.time === second.blockTime);
        expect(edges.map((e) => e.eth)).toEqual([0.07, 0.06, 0.09, 0.08].map(Math.fround));
      } finally {
        await scanned.pool.end();
      }
    } finally {
      await finish(s);
    }
  });

  it('reads no payment of no value, none a wallet paid itself, none to or from the zero address, and none of another chain', async () => {
    const s = await setup();
    try {
      await store.saveMoney(1, s.d1, [
        flow(s.d1, s.d2, { valueWei: '0', txHash: `0xla_nothing${runs}` }),
        flow(s.d1, s.d1, { valueWei: eth(0.04), txHash: `0xla_self${runs}` }),
        flow(ZERO, s.d1, { valueWei: eth(0.06), txHash: `0xla_minted${runs}` }),
        flow(s.d1, ZERO, { valueWei: eth(0.07), txHash: `0xla_burned${runs}` }),
      ], false);
      await store.saveMoney(2, s.d1, [flow(s.d1, s.d2, { valueWei: eth(0.08), txHash: `0xla_chain2${runs}` })], false);
      // No floor on any row, so only the predicates under test keep these out.
      const floorless = structuredClone(DEFAULT_RULE);
      for (const k of ['eth', 'internal', 'weth'] as const) floorless.edges[k].minWei = null;
      const { moves } = await store.lensInput(s.id, 1, floorless, null, 3);
      const d1 = moves.id(s.d1)!;
      const touching = [...moves.out(d1), ...moves.into(d1)].map((e) => ({ from: moves.name(moves.from[e]!), to: moves.name(moves.to[e]!), eth: moves.amountEth[e]! }));
      expect(touching.length).toBeGreaterThan(0);
      expect(touching.filter((e) => e.eth === 0)).toEqual([]);
      expect(touching.filter((e) => e.from === e.to)).toEqual([]);
      expect(moves.id(ZERO)).toBeUndefined();
      expect(touching.filter((e) => e.eth === Math.fround(0.08))).toEqual([]);
      // Each of them is in flows: only the filter keeps it out.
      const { rows } = await store.pool.query('SELECT count(*)::int AS n FROM washtrace.flows WHERE tx_hash = ANY($1)', [[`0xla_nothing${runs}`, `0xla_self${runs}`, `0xla_minted${runs}`, `0xla_burned${runs}`, `0xla_chain2${runs}`]]);
      expect(rows[0].n).toBe(5);
    } finally {
      await finish(s);
    }
  });

  it("refuses a collection with more money edges than the ceiling, saying how many it has", async () => {
    const s = await setup();
    const was = store.moneyEdgeCeiling;
    try {
      expect(was).toBe(40_000_000);
      const n = (await store.lensInput(s.id, 1, DEFAULT_RULE, null, 3)).moves.size;
      expect(n).toBeGreaterThan(1);
      store.moneyEdgeCeiling = n - 1;
      await expect(store.lensInput(s.id, 1, DEFAULT_RULE, null, 3))
        .rejects.toThrow(`This collection's money is too big for a lens run yet (${n.toLocaleString('en-US')} money edges).`);
      store.moneyEdgeCeiling = n;
      expect((await store.lensInput(s.id, 1, DEFAULT_RULE, null, 3)).moves.size).toBe(n);
    } finally {
      store.moneyEdgeCeiling = was;
      await finish(s);
    }
  });

  it('stops the transfers at through', async () => {
    const s = await setup();
    try {
      const read = await store.lensInput(s.id, 1, DEFAULT_RULE, s.ts[0]!.blockNumber, 3);
      expect(read.transfers.map((t) => t.txHash)).toEqual([s.ts[0]!.txHash]);
      expect(read.through).toBe(s.ts[0]!.blockNumber);
    } finally {
      await finish(s);
    }
  });

  /** What `moveTxs` is told of the run: the chain, the collection, the rule and the block it read through. */
  const runOf = (s: { id: number }, rule = DEFAULT_RULE, through: number | null = null) => ({ chainId: 1, collectionId: s.id, rule, through });

  it('re-reads the hash and exact amount of a money edge by its ends, kind and block, and null for one that is not there', async () => {
    const s = await setup();
    try {
      const got = await store.moveTxs(runOf(s), [
        { from: s.d1, to: s.d3, kind: 'weth', block: s.bid.blockNumber },
        { from: s.d3, to: s.d1, kind: 'internal', block: s.internal.blockNumber },
        { from: s.d1, to: s.d2, kind: 'eth', block: 999_999 },
        { from: s.d1, to: s.d2, kind: 'nft-token', block: s.inSale.blockNumber },
        { from: s.d1, to: s.d3, kind: 'eth', block: s.bid.blockNumber },
      ]);
      expect(got).toEqual([{ tx: s.bid.txHash, amountWei: eth(0.02) }, { tx: s.internal.txHash, amountWei: eth(0.03) }, null, null, null]);
      expect(await store.moveTxs(runOf(s), [])).toEqual([]);
    } finally {
      await finish(s);
    }
  });

  it('matches only a payment the rule let in: the 1 ETH beside dust in one block, not the dust', async () => {
    const s = await setup();
    try {
      const block = { blockNumber: 790_000 + runs, blockTime: 1_700_200_000 + runs };
      // The dust's hash sorts first, so the old tie rule alone took it.
      const dust = flow(s.d1, s.d2, { ...block, valueWei: eth(0.001), txHash: `0xla_a_dust${runs}` });
      const one = flow(s.d1, s.d2, { ...block, valueWei: eth(1), txHash: `0xla_b_one${runs}` });
      const none = flow(s.d1, s.d2, { ...block, valueWei: '0', txHash: `0xla_0_none${runs}` });
      await store.saveMoney(1, s.d1, [dust, one, none], false);
      const edge = [{ from: s.d1, to: s.d2, kind: 'eth', block: block.blockNumber }] as const;
      expect(await store.moveTxs(runOf(s), [...edge])).toEqual([{ tx: one.txHash, amountWei: eth(1) }]);
      // With no floor the dust is a payment the rule reads, and the tie goes to the smaller hash; a payment of nothing never is.
      const floorless = structuredClone(DEFAULT_RULE);
      floorless.edges.eth.minWei = null;
      expect(await store.moveTxs(runOf(s, floorless), [...edge])).toEqual([{ tx: dust.txHash, amountWei: eth(0.001) }]);
      // Each kind keeps its own floor: a high WETH floor leaves the ETH one as it was.
      const highWeth = structuredClone(DEFAULT_RULE);
      highWeth.edges.weth.minWei = eth(5);
      expect(await store.moveTxs(runOf(s, highWeth), [...edge, { from: s.d1, to: s.d3, kind: 'weth', block: s.bid.blockNumber }]))
        .toEqual([{ tx: one.txHash, amountWei: eth(1) }, null]);
    } finally {
      await finish(s);
    }
  });

  it("never matches a payment in a transaction that moves one of this collection's tokens, though it shares the pair and block", async () => {
    const s = await setup();
    try {
      // inSale is in the sale's transaction; a mint's transaction moves a token too. Their hashes sort before the payment outside both.
      const inMint = flow(s.d1, s.d2, { blockNumber: s.inSale.blockNumber, blockTime: s.inSale.blockTime, valueWei: eth(0.5), txHash: s.ts[0]!.txHash });
      const outside = flow(s.d1, s.d2, { blockNumber: s.inSale.blockNumber, blockTime: s.inSale.blockTime, valueWei: eth(0.06), txHash: `0xzz_out${runs}` });
      expect([s.saleTx, inMint.txHash].every((h) => h < outside.txHash)).toBe(true);
      await store.saveMoney(1, s.d1, [inMint], false);
      const edge = { from: s.d1, to: s.d2, kind: 'eth', block: s.inSale.blockNumber } as const;
      expect(await store.moveTxs(runOf(s), [edge])).toEqual([null]);
      await store.saveMoney(1, s.d1, [outside], false);
      expect(await store.moveTxs(runOf(s), [edge])).toEqual([{ tx: outside.txHash, amountWei: eth(0.06) }]);
      // A run that read through the mint only: the sale's transaction is not one of the transfers it loaded, so its payment is one it read.
      expect(await store.moveTxs(runOf(s, DEFAULT_RULE, s.ts[0]!.blockNumber), [edge])).toEqual([{ tx: s.saleTx, amountWei: eth(0.05) }]);
    } finally {
      await finish(s);
    }
  });

  it('asks in batches, each answer still in its own place: an NFT edge between them, a batch with no match, an edge asked twice', async () => {
    const s = await setup();
    const was = store.moveTxBatch;
    store.moveTxBatch = 2;
    const asked = vi.spyOn(store.pool, 'query');
    try {
      const bid = { from: s.d1, to: s.d3, kind: 'weth', block: s.bid.blockNumber } as const;
      const got = await store.moveTxs(runOf(s), [
        { from: s.d1, to: s.d2, kind: 'eth', block: 999_999 },
        { from: s.d1, to: s.d2, kind: 'nft-token', block: s.inSale.blockNumber },
        { from: s.d3, to: s.d1, kind: 'eth', block: s.internal.blockNumber },
        { from: s.d3, to: s.d1, kind: 'internal', block: s.internal.blockNumber },
        bid,
        // In the sale's transaction: never a match, wherever it falls in a batch.
        { from: s.d1, to: s.d2, kind: 'eth', block: s.inSale.blockNumber },
        bid,
        { from: s.fol, to: s.out, kind: 'eth', block: s.fromFollowed.blockNumber },
      ]);
      // Seven money edges at two a query; the first query's two find nothing.
      expect(asked).toHaveBeenCalledTimes(4);
      expect(got).toEqual([
        null, null, null, { tx: s.internal.txHash, amountWei: eth(0.03) }, { tx: s.bid.txHash, amountWei: eth(0.02) },
        null, { tx: s.bid.txHash, amountWei: eth(0.02) }, { tx: s.fromFollowed.txHash, amountWei: eth(0.05) },
      ]);
    } finally {
      asked.mockRestore();
      store.moveTxBatch = was;
      await finish(s);
    }
  });
});

describe('other tokens in a lens run', () => {
  const C = 1;
  let runs = 0;
  let paid = 0;
  const T = 1_700_500_000;
  const eth = (n: number) => String(BigInt(Math.round(n * 1000)) * 10n ** 15n);
  /** Other tokens alone (with `eth` too when asked), no floor, no window: each test changes one field. */
  const tokensRule = (change: (r: typeof DEFAULT_RULE) => void = () => {}) => {
    const r = structuredClone(DEFAULT_RULE);
    for (const k of Object.keys(r.edges) as (keyof typeof r.edges)[]) r.edges[k] = { use: false, direction: 'along', max: null, minWei: null, repeats: 'each' };
    r.edges['other-tokens'].use = true;
    Object.assign(r, { hops: { min: 0, max: 3 }, window: null, never: { marketplaces: false, over: null, addresses: [] }, judges: 'sales' });
    change(r);
    return r;
  };
  const either = (r: typeof DEFAULT_RULE) => { r.edges['other-tokens'].direction = 'either'; };

  /** One sale, seller to buyer, on a collection of its own; every wallet of it named for this run alone. */
  async function setup() {
    await store.migrate();
    const n = ++runs;
    const name = (s: string) => w(`7e${s}${n}`);
    const s = { seller: name('a'), buyer: name('b'), mid: name('d'), pool: name('e'), payee: name('f'), addr: name('c') };
    const { id } = await store.addCollection(C, s.addr, 'Tokens lab', 1);
    const ts = [
      transfer('1', ZERO, s.seller, { txHash: `0x7emint${n}`, blockNumber: 3_000_000 + 10 * n, blockTime: T }),
      transfer('1', s.seller, s.buyer, { txHash: `0x7esale${n}`, blockNumber: 3_000_001 + 10 * n, blockTime: T + 10, marketplace: 'blur', priceWei: '1000', currency: '' }),
    ];
    await store.ingest(id, C, ts, 4_000_000, []);
    return { id, n, ts, saleTx: ts[1]!.txHash, saleBlock: ts[1]!.blockNumber, ...s };
  }
  type Setup = Awaited<ReturnType<typeof setup>>;
  const all = (s: Setup) => [s.seller, s.buyer, s.mid, s.pool, s.payee];
  async function finish(s: Setup) {
    await drop(C, s.addr);
    await store.pool.query('DELETE FROM washtrace.token_flows WHERE chain_id = $1 AND (from_address = ANY($2) OR to_address = ANY($2))', [C, all(s)]);
    await store.pool.query('DELETE FROM washtrace.token_reads WHERE chain_id = $1 AND address = ANY($2)', [C, all(s)]);
    await store.pool.query('DELETE FROM washtrace.token_payees WHERE chain_id = $1 AND (payer = ANY($2) OR payee = ANY($2))', [C, all(s)]);
    await store.pool.query('DELETE FROM washtrace.flows WHERE from_address = ANY($1) OR to_address = ANY($1)', [all(s)]);
    await store.pool.query('DELETE FROM washtrace.wallets WHERE chain_id = $1 AND address = ANY($2)', [C, all(s)]);
  }
  /** A wallet's token read as saveTokens would leave it, with the fanout and truncation the test needs. */
  const read = (address: string, o: { fanout?: number; truncated?: boolean } = {}) => store.pool.query(
    `INSERT INTO washtrace.token_reads (chain_id, address, status, truncated, fanout) VALUES ($1, $2, 'done', $3, $4)
     ON CONFLICT (chain_id, address) DO UPDATE SET status = 'done', truncated = EXCLUDED.truncated, fanout = EXCLUDED.fanout`,
    [C, address, o.truncated ?? false, o.fanout ?? 1],
  );
  /** A listed-token transfer as token_flows holds it, a day after the sale unless told. */
  async function pay(from: string, to: string, o: { tx?: string; block?: number; time?: number; value?: string; token?: string } = {}) {
    const f = { tx: o.tx ?? `0x7epay${++paid}`, block: o.block ?? 3_500_000 + paid, time: o.time ?? T + 86_400 + paid, value: o.value ?? '1250500000', token: o.token ?? USDC };
    await store.pool.query(
      `INSERT INTO washtrace.token_flows (chain_id, tx_hash, from_address, to_address, token, value_raw, block_number, block_time) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))`,
      [C, f.tx, from, to, f.token, f.value, f.block, f.time],
    );
    return f;
  }
  const inWalk = (id: number, address: string, depth: number) => store.pool.query(
    'INSERT INTO washtrace.reach (collection_id, chain_id, address, depth, stepped) VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING', [id, C, address, depth],
  );
  const request = (s: Setup, rule: typeof DEFAULT_RULE, payees = false) =>
    ({ storeUrl: '', lensId: 0, collectionId: s.id, chainId: C, rule, through: null, followHops: 3, payees });
  const flagged = async (s: Setup, rule: typeof DEFAULT_RULE, payees = false) => (await lensStored(store, request(s, rule, payees))).flags;
  /** Every SQL text the pool's connections send while `body` runs. */
  async function sqlOf(body: () => Promise<unknown>): Promise<string[]> {
    const spy = vi.spyOn(pgClient.Client.prototype, 'query');
    try {
      await body();
      return spy.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : (c[0] as { text?: string })?.text ?? ''));
    } finally {
      spy.mockRestore();
    }
  }

  it("a USDC payment back from buyer to seller closes the loop under other tokens, and not with the edge off; its evidence is the payment's tx, raw amount and token", async () => {
    const s = await setup();
    try {
      await read(s.buyer);
      const back = await pay(s.buyer, s.seller);
      const flags = await flagged(s, tokensRule());
      expect(flags).toHaveLength(1);
      expect(flags[0]!.path.map((e) => [e.from, e.to, e.kind])).toEqual([[s.seller, s.buyer, 'nft-token'], [s.buyer, s.seller, 'other-tokens']]);
      expect(flags[0]!.path[0]!.token).toBeNull();
      expect(flags[0]!.path[1]).toEqual({ from: s.buyer, to: s.seller, kind: 'other-tokens', tx: back.tx, time: back.time, amountWei: '1250500000', tokenId: null, token: USDC });
      const off = tokensRule((r) => { r.edges['other-tokens'].use = false; r.edges.eth.use = true; });
      expect(await flagged(s, off)).toEqual([]);
    } finally {
      await finish(s);
    }
  });

  it("carries token_counts.read as read at load, and null with no counts or counts holding only tried; a lens not using tokens reads none", async () => {
    const s = await setup();
    try {
      const at = (rule: typeof DEFAULT_RULE) => store.lensInput(s.id, C, rule, null, 3, false).then((i) => i.tokensRead);
      expect(await at(tokensRule())).toBeNull();
      await store.pool.query(`UPDATE washtrace.collections SET token_counts = '{"tried": "2026-11-09T00:00:00.000Z"}' WHERE id = $1`, [s.id]);
      expect(await at(tokensRule())).toBeNull();
      await store.pool.query(`UPDATE washtrace.collections SET token_counts = token_counts || '{"wallets": 9, "read": 7}' WHERE id = $1`, [s.id]);
      expect(await at(tokensRule())).toBe(7);
      expect(await at(DEFAULT_RULE)).toBeNull();
    } finally {
      await finish(s);
    }
  });

  it('a sender with fanout 26, an unread sender, a truncated one or one outside the set closes nothing, even under either; a truncated one is no middle; an airdrop or a pool that paid both buyer and seller closes nothing', async () => {
    const s = await setup();
    try {
      await read(s.buyer);
      await inWalk(s.id, s.mid, 1);
      await pay(s.buyer, s.mid);
      await pay(s.mid, s.seller);
      const along = tokensRule(), back = tokensRule(either);
      await read(s.mid);
      expect(await flagged(s, along)).toHaveLength(1);
      await read(s.mid, { fanout: 26 });
      expect(await flagged(s, along)).toEqual([]);
      expect(await flagged(s, back)).toEqual([]);
      await read(s.mid, { fanout: 25 });
      expect(await flagged(s, back)).toHaveLength(1);
      await read(s.mid, { truncated: true });
      expect(await flagged(s, back)).toEqual([]);
      await store.pool.query('DELETE FROM washtrace.token_reads WHERE chain_id = $1 AND address = $2', [C, s.mid]);
      expect(await flagged(s, back)).toEqual([]);
      // Read, but not in this collection's set: never judged here.
      await read(s.mid);
      await store.pool.query('DELETE FROM washtrace.reach WHERE collection_id = $1 AND address = $2', [s.id, s.mid]);
      expect(await flagged(s, back)).toEqual([]);

      // A pool in the set that paid both: under either, buyer <- pool -> seller, which its fanout bars, and only it.
      await inWalk(s.id, s.pool, 1);
      await pay(s.pool, s.buyer);
      await pay(s.pool, s.seller);
      await read(s.pool, { fanout: 26 });
      expect(await flagged(s, back)).toEqual([]);
      await read(s.pool, { truncated: true });
      expect(await flagged(s, back)).toEqual([]);
      await read(s.pool, { fanout: 2 });
      expect(await flagged(s, back)).toHaveLength(1);
    } finally {
      await finish(s);
    }
  });

  it('under either, a token edge is walked against its arrow only when its receiver is a sender washtrace can judge: buyer and seller who both paid an unread, truncated or fanout-26 wallet close nothing; along, nothing changes', async () => {
    const s = await setup();
    try {
      await read(s.buyer);
      await read(s.seller);
      // Both sends are the traders' own, which are judgeable: only the pool's own read can judge it.
      await pay(s.buyer, s.pool);
      await pay(s.seller, s.pool);
      const back = tokensRule(either), along = tokensRule();
      const kinds = async () => {
        const { moves } = await store.lensInput(s.id, C, back, null, 3, false);
        return Array.from({ length: moves.size }, (_, i) => i).filter((i) => moves.name(moves.to[i]!) === s.pool).map((i) => moves.kind[i]);
      };
      expect(await kinds()).toEqual([MOVE_KIND.otherOneWay, MOVE_KIND.otherOneWay]);
      expect(await flagged(s, back)).toEqual([]);
      for (const o of [{ truncated: true }, { fanout: 26 }]) {
        await read(s.pool, o);
        expect(await flagged(s, back)).toEqual([]);
      }
      expect(await flagged(s, along)).toEqual([]);
      await read(s.pool, { fanout: 25 });
      expect(await kinds()).toEqual([MOVE_KIND.other, MOVE_KIND.other]);
      const flags = await flagged(s, back);
      expect(flags).toHaveLength(1);
      expect(flags[0]!.path.slice(1).map((e) => [e.from, e.to, e.kind, e.token])).toEqual([[s.buyer, s.pool, 'other-tokens', USDC], [s.seller, s.pool, 'other-tokens', USDC]]);
      expect(await flagged(s, along)).toEqual([]);
    } finally {
      await finish(s);
    }
  });

  it('a token-truncated middle on an ETH-closed loop still closes it: lensInput.truncated leaves it out, as it keeps an ETH-truncated one', async () => {
    const s = await setup();
    try {
      await store.pool.query(`INSERT INTO washtrace.wallets (chain_id, address, depth, status) VALUES ($1, $2, 1, 'pending')`, [C, s.mid]);
      await store.saveMoney(C, s.mid, [
        flow(s.buyer, s.mid, { valueWei: eth(1), txHash: `0x7eeth_in${s.n}`, blockTime: T + 100 }),
        flow(s.mid, s.seller, { valueWei: eth(1), txHash: `0x7eeth_out${s.n}`, blockTime: T + 200 }),
      ], false);
      await read(s.mid, { truncated: true });
      const rule = tokensRule((r) => { r.edges.eth.use = true; });
      const input = await store.lensInput(s.id, C, rule, null, 3, false);
      expect(input.truncated.has(s.mid)).toBe(false);
      const flags = await flagged(s, rule);
      expect(flags).toHaveLength(1);
      expect(flags[0]!.wallets).toContain(s.mid);
      await store.pool.query('UPDATE washtrace.wallets SET truncated = true WHERE chain_id = $1 AND address = $2', [C, s.mid]);
      expect((await store.lensInput(s.id, C, rule, null, 3, false)).truncated.has(s.mid)).toBe(true);
      expect(await flagged(s, rule)).toEqual([]);
    } finally {
      await finish(s);
    }
  });

  it('with tokens.payees on, a payee of a trader sends as one of the set; off, it does not', async () => {
    const s = await setup();
    try {
      await inWalk(s.id, s.seller, 0);
      await inWalk(s.id, s.buyer, 0);
      await store.saveTokens(C, s.buyer, [{ txHash: `0x7epayee${s.n}`, from: s.buyer, to: s.payee, token: USDC, valueRaw: '5000000', blockNumber: 3_600_000 + s.n, blockTime: T + 1_000 }], false);
      await store.saveTokens(C, s.payee, [{ txHash: `0x7epayback${s.n}`, from: s.payee, to: s.seller, token: USDC, valueRaw: '5000000', blockNumber: 3_600_001 + s.n, blockTime: T + 2_000 }], false);
      expect(await flagged(s, tokensRule(), false)).toEqual([]);
      const flags = await flagged(s, tokensRule(), true);
      expect(flags).toHaveLength(1);
      expect(flags[0]!.wallets).toEqual([s.seller, s.buyer, s.payee]);
    } finally {
      await finish(s);
    }
  });

  it('token and ETH edges load in one time-ordered stream, ETH first at an equal time; Moves never sorts', async () => {
    const s = await setup();
    try {
      await read(s.buyer);
      // A receiver washtrace can judge, so each token edge is kind other, walked either way.
      await read(s.mid);
      await store.saveMoney(C, s.buyer, [
        flow(s.buyer, s.mid, { valueWei: eth(1), txHash: `0x7eo_e1${s.n}`, blockTime: T + 300, blockNumber: 3_700_001 }),
        flow(s.buyer, s.mid, { valueWei: eth(1), txHash: `0x7eo_e2${s.n}`, blockTime: T + 100, blockNumber: 3_700_002 }),
        flow(s.buyer, s.mid, { kind: 'token', token: WETH, valueWei: eth(1), txHash: `0x7eo_w${s.n}`, blockTime: T + 200, blockNumber: 3_700_003 }),
      ], false);
      await pay(s.buyer, s.mid, { time: T + 200, block: 3_700_004, tx: `0x7eo_t1${s.n}` });
      await pay(s.buyer, s.mid, { time: T + 50, block: 3_700_005, tx: `0x7eo_t2${s.n}` });
      await pay(s.buyer, s.mid, { time: T + 400, block: 3_700_006, tx: `0x7eo_t3${s.n}` });
      const sort = vi.spyOn(Int32Array.prototype, 'sort');
      try {
        const { moves } = await store.lensInput(s.id, C, tokensRule((r) => { r.edges.eth.use = true; r.edges.weth.use = true; }), null, 3, false);
        const mine = Array.from({ length: moves.size }, (_, i) => i).filter((i) => moves.name(moves.from[i]!) === s.buyer);
        expect(mine.map((i) => [moves.time[i]! - T, moves.kind[i]!])).toEqual([
          [50, MOVE_KIND.other], [100, MOVE_KIND.eth], [200, MOVE_KIND.weth], [200, MOVE_KIND.other], [300, MOVE_KIND.eth], [400, MOVE_KIND.other],
        ]);
        expect(mine.every((i) => moves.amountEth[i]! > 0 || moves.kind[i] === MOVE_KIND.other)).toBe(true);
        expect(mine.filter((i) => moves.kind[i] === MOVE_KIND.other).every((i) => moves.amountEth[i] === 0)).toBe(true);
        expect(sort).not.toHaveBeenCalled();
      } finally {
        sort.mockRestore();
      }
    } finally {
      await finish(s);
    }
  });

  it("counts token edges toward the money-edge ceiling, failing with today's message", async () => {
    const s = await setup();
    const was = store.moneyEdgeCeiling;
    try {
      await read(s.buyer);
      await pay(s.buyer, s.seller);
      await pay(s.buyer, s.mid);
      const n = (await store.lensInput(s.id, C, tokensRule(), null, 3, false)).moves.size;
      expect(n).toBeGreaterThanOrEqual(2);
      store.moneyEdgeCeiling = n - 1;
      await expect(store.lensInput(s.id, C, tokensRule(), null, 3, false))
        .rejects.toThrow(`This collection's money is too big for a lens run yet (${n.toLocaleString('en-US')} money edges).`);
    } finally {
      store.moneyEdgeCeiling = was;
      await finish(s);
    }
  });

  it("a lens not using other tokens sends today's money query verbatim and no SQL naming a token table; Store.trail and analysisInput read none either", async () => {
    const s = await setup();
    try {
      await read(s.buyer);
      await pay(s.buyer, s.seller);
      const TODAY = [
      'SELECT f.from_address, f.to_address, f.tx_hash,',
      '                CASE f.kind WHEN \'native\' THEN 0 WHEN \'internal\' THEN 1 ELSE 2 END AS k,',
      '                extract(epoch FROM f.block_time)::int AS t, f.block_number::int AS b, (f.value_wei / 1e18)::float8 AS eth',
      '         FROM washtrace.flows f',
      '         WHERE f.chain_id = $1 AND (f.from_address = ANY($6::text[]) OR f.to_address = ANY($6::text[])',
      '           -- Followed wallets\' payments onward, as analysisInput reads them.',
      '           OR f.from_address = ANY($7::text[]))',
      '           AND f.value_wei > 0 AND f.from_address <> f.to_address AND f.from_address <> $8 AND f.to_address <> $8',
      '           AND ((f.kind = \'native\' AND f.value_wei >= $2::numeric) OR (f.kind = \'internal\' AND f.value_wei >= $3::numeric) OR (f.kind = \'token\' AND f.token = ANY($4::text[]) AND f.value_wei >= $5::numeric))',
      '         -- By time, as Moves holds them, so it need not sort them (a sort of Terraforms\' 37M edges',
      '         -- held them all twice over); then the flows key, whole: Moves keeps equal-time edges in the',
      '         -- order read, and a capped search meets them in that order, so the same data must be read',
      '         -- the same way every run.',
      '         ORDER BY t, f.kind, f.tx_hash, f.from_address, f.to_address, f.token, f.value_wei',
      ].join('\n');
      const lens = await sqlOf(() => store.lensInput(s.id, C, DEFAULT_RULE, null, 3, true));
      expect(lens.filter((q) => q.startsWith('DECLARE'))).toEqual([`DECLARE stored NO SCROLL CURSOR FOR ${TODAY}`]);
      const named = (qs: string[]) => qs.filter((q) => /token_(flows|reads|payees|counts)|tokens_read/.test(q));
      expect(named(lens)).toEqual([]);
      expect(named(await sqlOf(() => store.analysisInput(s.id, C, 3)))).toEqual([]);
      expect(named(await sqlOf(async () => {
        const trail = await store.trail(s.id, C);
        for await (const _ of trail.addresses);
        for await (const _ of trail.flows);
      }))).toEqual([]);
      // Not vacuous: a lens using them names token_flows.
      expect((await sqlOf(() => store.lensInput(s.id, C, tokensRule(), null, 3, false))).some((q) => q.includes('washtrace.token_flows'))).toBe(true);
    } finally {
      await finish(s);
    }
  });

  it("moveTxs finds a token edge's tx, raw amount and token, skips the sale's own leg and a zero, and keeps an ETH edge's answer as it was", async () => {
    const s = await setup();
    const run = (through: number | null = null) => ({ chainId: C, collectionId: s.id, rule: tokensRule(), through });
    try {
      // In the sale's own transaction, and of nothing: neither is a payment the lens admitted.
      await pay(s.buyer, s.seller, { tx: s.saleTx, block: s.saleBlock, value: '9000000' });
      await pay(s.buyer, s.seller, { tx: `0x7e00zero${s.n}`, block: s.saleBlock, value: '0' });
      const edge = { from: s.buyer, to: s.seller, kind: 'other-tokens' as const, block: s.saleBlock };
      expect(await store.moveTxs(run(), [edge])).toEqual([null]);
      const outside = await pay(s.buyer, s.seller, { tx: `0x7ezz_out${s.n}`, block: s.saleBlock, value: '3000000000000000000', token: '0x4d224452801aced8b2f0aebe155379bb5d594381' });
      expect(await store.moveTxs(run(), [edge])).toEqual([{ tx: outside.tx, amountWei: '3000000000000000000', token: '0x4d224452801aced8b2f0aebe155379bb5d594381' }]);
      // A run that read through the mint only: the sale's transaction is not one it loaded, so its leg is one it read.
      expect(await store.moveTxs(run(s.ts[0]!.blockNumber), [edge])).toEqual([{ tx: s.saleTx, amountWei: '9000000', token: USDC }]);
      const ethEdge = flow(s.buyer, s.seller, { valueWei: eth(1), txHash: `0x7emt_eth${s.n}` });
      await store.saveMoney(C, s.buyer, [ethEdge], false);
      const ethRule = { chainId: C, collectionId: s.id, rule: tokensRule((r) => { r.edges.eth.use = true; }), through: null };
      expect(await store.moveTxs(ethRule, [{ from: s.buyer, to: s.seller, kind: 'eth', block: ethEdge.blockNumber }, edge]))
        .toEqual([{ tx: ethEdge.txHash, amountWei: eth(1) }, { tx: outside.tx, amountWei: '3000000000000000000', token: '0x4d224452801aced8b2f0aebe155379bb5d594381' }]);
    } finally {
      await finish(s);
    }
  });

  it('a stored token flow is read with no key set: the worker runs a token lens, passes tokens.payees, saves token_counts.read as tokens_read, and an old path reads token null', async () => {
    const s = await setup();
    const lens = await store.createLens('Tokens, no key', tokensRule());
    try {
      await read(s.buyer);
      const back = await pay(s.buyer, s.seller);
      await store.saveAnalysis(s.id, 1, analyze(input(s.ts, [], { money: MONEY })), 5, null, MONEY);
      await store.pool.query(`UPDATE washtrace.collections SET token_counts = '{"wallets": 2, "read": 5}' WHERE id = $1`, [s.id]);
      await store.requestLensRun(lens.id, s.id);
      const worker = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 3, tokensPayees: true, sources: {}, storedRepo: 'u/d' }), '');
      (worker as unknown as { dueAnalysis: () => Promise<null> }).dueAnalysis = async () => null;
      const sent: { payees: boolean }[] = [];
      worker.lensOff = (req, progress) => { sent.push(req); return lensStored(store, req, progress); };
      expect(await worker.run('analyze')).toBe('ran');
      expect(await said('lens')).toBe('Ran Tokens, no key on Tokens lab');
      expect(sent.map((r) => r.payees)).toEqual([true]);
      const run = (await store.lensRuns(s.id)).find((r) => r.lens.id === lens.id)!.run!;
      expect(run).toMatchObject({ status: 'done', tokensRead: 5 });
      const saved = await store.lensFlagsOfTx(C, s.saleTx);
      expect(saved.map((f) => f.path[1])).toEqual([{ from: s.buyer, to: s.seller, kind: 'other-tokens', tx: back.tx, time: back.time, amountWei: '1250500000', tokenId: null, token: USDC }]);
      // A path stored before LoopEdge had a token reads it as null.
      await store.pool.query(`UPDATE washtrace.lens_flags SET path = '[{"from": "${s.seller}", "to": "${s.buyer}", "kind": "nft-token", "tx": null, "time": null, "amountWei": null, "tokenId": "1"}]' WHERE lens_id = $1`, [lens.id]);
      expect((await store.lensFlagsOfTx(C, s.saleTx))[0]!.path[0]!.token).toBeNull();
    } finally {
      await store.deleteLens(lens.id);
      await finish(s);
    }
  });
});

describe('a saved lens in the reads', () => {
  const address = w('1e6a');
  const MONEY_CTX = (ran: string[]) => ({ money: MONEY, ran: ran as Method[], zone: 'UTC' });
  const [W1, W2, W3] = ['w1', 'w2', 'w3'].map(w) as [string, string, string];
  const hashOf = (key: string) => LAB.transfers.find((t) => LAB.keyOf(t.txHash) === key)!.txHash;
  // The lens flags S1 and S2 (a path of W1, W2, W3) and S5, a sale elsewhere; Round trips flags S1 to S4.
  const flag = (key: string, wallets: string[]) => ({ txHash: hashOf(key), logIndex: 0, path: [], wallets });
  const TOTALS = { transfers: 7, flagged: 3, sales: 6, flaggedSales: 3, volumeWei: '1', flaggedVolumeWei: '1', wallets: 3, tokens: 2, available: true, truncated: 0, untimed: 0 };
  const LIST = { sort: 'caught' as const, find: null, limit: 50, offset: 0 };
  let id: number, lens: string, other: string;
  let ctx: ReturnType<typeof MONEY_CTX>;

  beforeAll(async () => {
    await store.migrate();
    id = (await store.addCollection(1, address, 'Lab', 1)).id;
    await store.ingest(id, 1, [...LAB.transfers, LAB.late], LAB.cursor, []);
    await store.saveAnalysis(id, 1, LAB.analysis, 5, LAB.cursor, MONEY);
    const analysis = Number((await store.pool.query('SELECT id FROM washtrace.analyses WHERE collection_id = $1', [id])).rows[0].id);
    const l = await store.createLens('Mine', DEFAULT_RULE);
    lens = l.key;
    other = (await store.createLens('Never run', DEFAULT_RULE)).key;
    await store.requestLensRun(l.id, id);
    await store.saveLensRun(l.id, id, 1, analysis, 600, TOTALS, [flag('S1', [W1, W2, W3]), flag('S2', [W1, W2, W3]), flag('S5', [w('w5'), w('w6')])], 1);
    ctx = MONEY_CTX(['A', lens]);
  });
  afterAll(async () => {
    await store.pool.query('DELETE FROM washtrace.lenses');
    await drop(1, address);
  });

  const keys = (rows: { txHash: string }[]) => rows.map((r) => LAB.keyOf(r.txHash));
  const list = async (q: Partial<TradeQuery>, c = ctx) => keys(await store.trades(id, { ...NO_FILTER, ...q }, c, 50, 0));

  it('lists the trades the lens flags, and counts the same', async () => {
    const q = { ...NO_FILTER, caught: [lens as 'L1'] };
    expect(await list(q)).toEqual(['S2', 'S5', 'S1']);
    expect(await store.tradeCount(id, q, ctx)).toEqual({ total: 3, unjudged: 0 });
  });
  it('not caught is the rest of the judged trades, and a row names the lens where it is flagged', async () => {
    expect(await list({ notCaught: [lens as 'L1'] })).toEqual(['S4', 'S3', 'P1', 'U1']);
    const rows = await store.trades(id, NO_FILTER, ctx, 50, 0);
    const by = Object.fromEntries(rows.map((r) => [LAB.keyOf(r.txHash), r.lenses]));
    expect(by.S1).toEqual(['A', lens]);
    expect(by.S5).toEqual([lens]);
    expect(by.S3).toEqual(['A']);
    expect(by.LATE).toEqual([]);
  });
  it('sorts by the lens, flagged first', async () => {
    expect((await list({ sort: `lens-${lens}` as 'lens-L1', dir: 'desc' })).slice(0, 3)).toEqual(['S2', 'S5', 'S1']);
  });
  it('groups count what the lens caught, beside the built-ins', async () => {
    expect(await store.tradeGroups(id, NO_FILTER, 'marketplace', ctx)).toEqual([
      { key: 'blur', trades: 7, caught: { A: 3, [lens]: 2 }, judged: { [lens]: 7 } }, { key: 'opensea', trades: 1, caught: { A: 1, [lens]: 1 }, judged: { [lens]: 1 } },
    ]);
  });
  it('lists tokens and wallets with the counts its paths give', async () => {
    const t = await store.lensTokens(id, lens as 'L1', LIST, ctx);
    // Its stored paths here are empty: no money edge, and a middle only where a flag holds a third wallet.
    expect(t.rows).toEqual([
      expect.objectContaining({ tokenId: '1', caught: 2, trades: 4, loops: 2, pairs: 0, laps: 2, closedByMoney: 0, middles: 2, wallets: 3 }),
      expect.objectContaining({ tokenId: '2', caught: 1, trades: 3, loops: 1, middles: 0, wallets: 2 }),
    ]);
    expect(t.total).toBe(2);
    const wl = await store.lensWallets(id, lens as 'L1', LIST, ctx);
    expect(wl.rows.map((r) => r.address).sort()).toEqual([W1, W2, W3, w('w5'), w('w6')].sort());
    expect(wl.rows.every((r) => r.loops !== null && r.caught > 0)).toBe(true);
  });

  describe('a lens with real paths', () => {
    const edge = (from: string, to: string, kind: 'nft-token' | 'eth' | 'funds' | 'nft-collection') =>
      ({ from, to, kind, tx: null, time: null, amountWei: null, tokenId: null, token: null });
    let paths: { id: number; key: string };
    beforeAll(async () => {
      const analysis = Number((await store.pool.query('SELECT id FROM washtrace.analyses WHERE collection_id = $1', [id])).rows[0].id);
      paths = await store.createLens('Paths', DEFAULT_RULE);
      await store.requestLensRun(paths.id, id);
      // Three flags on token 1: two close over money (one through a middle wallet), one over an NFT alone.
      await store.saveLensRun(paths.id, id, 1, analysis, 600, TOTALS, [
        { txHash: hashOf('S1'), logIndex: 0, path: [edge(W1, W2, 'nft-token'), edge(W2, W3, 'eth'), edge(W3, W1, 'funds')], wallets: [W1, W2, W3] },
        { txHash: hashOf('S2'), logIndex: 0, path: [edge(W1, W2, 'nft-token'), edge(W2, W1, 'funds')], wallets: [W1, W2] },
        { txHash: hashOf('S3'), logIndex: 0, path: [edge(W1, W2, 'nft-token'), edge(W2, W1, 'nft-collection')], wallets: [W1, W2] },
      ], 1);
    });

    it("lensFlagsOfToken returns your lens's path for each flagged transfer of the token, only for the lens ids asked", async () => {
      const got = await store.lensFlagsOfToken(id, '1', [paths.id]);
      expect(got.map((f) => LAB.keyOf(f.txHash))).toEqual(['S1', 'S2', 'S3']);
      expect(got.every((f) => f.lensId === paths.id && f.collectionId === id)).toBe(true);
      expect(got[0]!.path.map((e) => e.kind)).toEqual(['nft-token', 'eth', 'funds']);
      expect(got[0]!.wallets).toEqual([W1, W2, W3]);
      expect(await store.lensFlagsOfToken(id, '2', [paths.id])).toEqual([]);
      expect(await store.lensFlagsOfToken(id, '1', [])).toEqual([]);
      const mine = Number(lens.slice(1));
      expect((await store.lensFlagsOfToken(id, '1', [mine])).map((f) => LAB.keyOf(f.txHash))).toEqual(['S1', 'S2']);
      expect((await store.lensFlagsOfToken(id, '1', [mine, paths.id])).length).toBe(5);
    });

    it('lensFlagsOfTx returns the flags of a tx across two collections, each with its collectionId', async () => {
      const second = w('1e6b');
      const c2 = (await store.addCollection(1, second, 'Twin', 1)).id;
      try {
        await store.ingest(c2, 1, LAB.transfers, LAB.cursor, []);
        await store.saveAnalysis(c2, 1, LAB.analysis, 5, LAB.cursor, MONEY);
        const analysis = Number((await store.pool.query('SELECT id FROM washtrace.analyses WHERE collection_id = $1', [c2])).rows[0].id);
        await store.requestLensRun(paths.id, c2);
        await store.saveLensRun(paths.id, c2, 1, analysis, 600, TOTALS, [flag('S1', [W1, W2])], 1);
        const got = await store.lensFlagsOfTx(1, hashOf('S1'));
        expect(got.map((f) => [f.collectionId, f.lensId]).sort()).toEqual([
          [id, Number(lens.slice(1))], [id, paths.id], [c2, paths.id],
        ].sort());
        expect(got.find((f) => f.collectionId === c2)!.wallets).toEqual([W1, W2]);
        expect(await store.lensFlagsOfTx(1, hashOf('P1'))).toEqual([]);
        expect(await store.lensFlagsOfTx(2, hashOf('S1'))).toEqual([]);
      } finally {
        await drop(1, second);
      }
    });

    it('lensFlagsOfTx seeks its tx by an index on tx_hash, as the built-ins’ flags do, not through every lens’s entries on the chain', async () => {
      const { rows } = await store.pool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'washtrace' AND tablename = 'lens_flags' AND indexname = 'lens_flags_tx_idx'`);
      expect(rows.map((r) => r.indexdef)).toEqual(['CREATE INDEX lens_flags_tx_idx ON washtrace.lens_flags USING btree (tx_hash)']);
      const c = await store.pool.connect();
      try {
        await c.query('BEGIN');
        // A collection's worth of one lens's flags, so the plan is costed as on a real install, not on a handful of rows; rolled back.
        await c.query(
          `INSERT INTO washtrace.lens_flags (collection_id, lens_id, tx_hash, log_index, path, wallets)
           SELECT $1, $2, '0xfill' || g, 0, '[]', '{}' FROM generate_series(1, 20000) g`,
          [id, paths.id],
        );
        await c.query('ANALYZE washtrace.lens_flags');
        // lensFlagsOfTx's own WHERE.
        const plan = (await c.query(
          `EXPLAIN SELECT f.* FROM washtrace.lens_flags f JOIN washtrace.collections c ON c.id = f.collection_id WHERE c.chain_id = $1 AND f.tx_hash = $2 ORDER BY f.collection_id, f.log_index, f.lens_id`,
          [1, hashOf('S1')],
        )).rows.map((r) => r['QUERY PLAN']).join('\n');
        expect(plan).toMatch(/lens_flags_tx_idx/);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it("your lens's token line counts loops, wallets, closedByMoney and middles from its paths", async () => {
      const c = MONEY_CTX(['A', paths.key]);
      const { rows } = await store.lensTokens(id, paths.key as 'L1', LIST, c);
      expect(rows).toEqual([expect.objectContaining({ tokenId: '1', caught: 3, loops: 3, wallets: 3, closedByMoney: 2, middles: 1, laps: 3, pairs: 0 })]);
    });

    it("a loop closed by other tokens is closed by money on your lens's token line, and a built-in's lines and trades filter read the same as before", async () => {
      const c = MONEY_CTX(['A', paths.key]);
      const builtIn = async () => [
        await store.lensTokens(id, 'A', LIST, c), await store.lensWallets(id, 'A', LIST, c),
        await store.trades(id, { ...NO_FILTER, caught: ['A'] }, c, 50, 0), await store.trades(id, { ...NO_FILTER, notCaught: ['A'] }, c, 50, 0),
      ];
      const was = await builtIn();
      const s3 = [edge(W1, W2, 'nft-token'), { ...edge(W2, W1, 'eth'), kind: 'other-tokens' as const, token: USDC }];
      const old = (await store.pool.query('SELECT path FROM washtrace.lens_flags WHERE lens_id = $1 AND tx_hash = $2', [paths.id, hashOf('S3')])).rows[0].path;
      try {
        await store.pool.query('UPDATE washtrace.lens_flags SET path = $3 WHERE lens_id = $1 AND tx_hash = $2', [paths.id, hashOf('S3'), JSON.stringify(s3)]);
        const { rows } = await store.lensTokens(id, paths.key as 'L1', LIST, c);
        expect(rows).toEqual([expect.objectContaining({ tokenId: '1', caught: 3, loops: 3, closedByMoney: 3 })]);
        expect(await builtIn()).toEqual(was);
      } finally {
        await store.pool.query('UPDATE washtrace.lens_flags SET path = $3 WHERE lens_id = $1 AND tx_hash = $2', [paths.id, hashOf('S3'), JSON.stringify(old)]);
      }
    });

    it("your lens's wallet line counts loops and partners", async () => {
      const c = MONEY_CTX(['A', paths.key]);
      const { rows } = await store.lensWallets(id, paths.key as 'L1', LIST, c);
      const by = Object.fromEntries(rows.map((r) => [r.address, r]));
      expect(by[W1]).toMatchObject({ loops: 3, pairs: 0, partners: 2 });
      expect(by[W2]).toMatchObject({ loops: 3, partners: 2 });
      expect(by[W3]).toMatchObject({ loops: 1, partners: 2 });
      // A page cut off the top still counts the rows it shows.
      const paged = await store.lensWallets(id, paths.key as 'L1', { ...LIST, sort: 'caught', limit: 1, offset: 2 }, c);
      expect(paged.rows.map((r) => r.address)).toEqual([W3]);
      expect(paged.rows[0]).toMatchObject({ loops: 1, partners: 2 });
    });
  });

  it('a group narrows to the wallets in the flags of that lens, on a token or around a wallet', async () => {
    expect(await list({ kind: 'all', group: { method: lens as 'L1', token: '1' } })).toEqual(['S4', 'S3', 'S2', 'S1']);
    expect(await list({ kind: 'all', group: { method: lens as 'L1', wallet: w('w5') } })).toEqual(['S5']);
    expect(await list({ kind: 'all', group: { method: lens as 'L1', wallet: w('w9') } })).toEqual([]);
  });
  it('a lens that is not in ran gives the empty state everywhere', async () => {
    const none = MONEY_CTX(['A']);
    expect(await store.trades(id, { ...NO_FILTER, caught: [lens as 'L1'] }, none, 50, 0)).toEqual([]);
    expect(await store.tradeCount(id, { ...NO_FILTER, caught: [lens as 'L1'] }, none)).toEqual({ total: 0, unjudged: 0 });
    expect(await list({ kind: 'all', group: { method: lens as 'L1', token: '1' } }, none)).toEqual([]);
    expect(await store.lensTokens(id, lens as 'L1', LIST, none)).toEqual({ rows: [], total: 0 });
    expect(await store.lensWallets(id, lens as 'L1', LIST, none)).toEqual({ rows: [], total: 0 });
    expect(await list({ sort: `lens-${lens}` as 'lens-L1' }, none)).toEqual(await list({}, none));
    // A lens with no flags saved here, put in ran, still lists nothing rather than failing.
    expect(await list({ caught: [other as 'L1'] }, MONEY_CTX(['A', other]))).toEqual([]);
    expect((await store.tradeGroups(id, NO_FILTER, 'marketplace', none))[0]!.caught).toEqual({ A: 3 });
  });

  const idOf = (k: string) => Number(k.slice(1));
  const sum = (t: Awaited<ReturnType<typeof store.timeline>>, k: string) => t.points.reduce((n, p) => n + ((p.flaggedSales as Record<string, number>)[k] ?? 0), 0);

  it("timeline counts a lens of yours's caught sales per bucket, and none past its through block", async () => {
    // Flags on S1 (block 200), S5 (250) and S2 (300), all sales.
    const all = await store.timeline(id, 'UTC', [{ lensId: idOf(lens), through: null }]);
    expect(sum(all, lens)).toBe(3);
    expect(all.points[0]!.flaggedSales).toMatchObject({ A: expect.any(Number), AU: expect.any(Number), AC: expect.any(Number) });
    // Judged through block 250: S2 is not judged yet, so not caught.
    expect(sum(await store.timeline(id, 'UTC', [{ lensId: idOf(lens), through: 250 }]), lens)).toBe(2);
    // A lens with no flags here counts zero, not nothing.
    expect((await store.timeline(id, 'UTC', [{ lensId: idOf(other), through: null }])).points[0]!.flaggedSales[other as 'L1']).toBe(0);
  });
  it("timeline gives a lens of yours's judged sales per bucket: all with no through, only those up to it otherwise", async () => {
    const judged = (t: Awaited<ReturnType<typeof store.timeline>>, k: string) => t.points.reduce((n, p) => n + (p.judgedSales?.[k as 'L1'] ?? 0), 0);
    // The sales at or before a block, counted straight from the table.
    const salesTo = async (block: number | null) => (await store.pool.query(
      'SELECT count(*)::int AS n FROM washtrace.transfers WHERE collection_id = $1 AND marketplace IS NOT NULL AND ($2::bigint IS NULL OR block_number <= $2::bigint)', [id, block])).rows[0].n as number;
    const everySale = await salesTo(null);
    expect(everySale).toBeGreaterThan(await salesTo(250));
    expect(await salesTo(250)).toBeGreaterThan(0);
    expect(judged(await store.timeline(id, 'UTC', [{ lensId: idOf(lens), through: null }]), lens)).toBe(everySale);
    expect(judged(await store.timeline(id, 'UTC', [{ lensId: idOf(lens), through: 250 }]), lens)).toBe(await salesTo(250));
    expect((await store.timeline(id, 'UTC', [{ lensId: idOf(lens), through: 100 }])).points[0]!.judgedSales).toEqual({ [lens]: 0 });
    // The built-ins' points carry no such field.
    expect((await store.timeline(id)).points[0]).not.toHaveProperty('judgedSales');
  });
  it("timeline's SQL is unchanged with no lens of yours", async () => {
    const asked: { text: string; values: unknown[] }[] = [];
    const was = store.pool.query.bind(store.pool);
    (store.pool as any).query = (text: any, values?: unknown[]) => { asked.push({ text: String(text), values: values ?? [] }); return (was as any)(text, values); };
    try {
      await store.timeline(id);
    } finally {
      (store.pool as any).query = was;
    }
    const sql = asked.at(-1)!;
    expect(sql.values).toEqual([id, expect.any(String), 'UTC']);
    expect(sql.text.replace(/\s+/g, ' ').trim()).toBe(
      "WITH f AS ( SELECT tx_hash, log_index, bool_or(method = 'A') AS a, bool_or(method = 'AU') AS au, bool_or(method = 'AC') AS ac FROM washtrace.flags WHERE collection_id = $1 GROUP BY tx_hash, log_index) " +
      "SELECT extract(epoch FROM date_trunc($2, t.block_time, $3))::float8 * 1000 AS at, count(*)::int AS transfers, count(*) FILTER (WHERE t.marketplace IS NOT NULL)::int AS sales, " +
      "count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.a)::int AS a, count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.au)::int AS au, count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.ac)::int AS ac, count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.au AND NOT f.a AND NOT f.ac)::int AS apart " +
      'FROM washtrace.transfers t LEFT JOIN f ON f.tx_hash = t.tx_hash AND f.log_index = t.log_index WHERE t.collection_id = $1 AND t.block_time IS NOT NULL GROUP BY 1 ORDER BY 1',
    );
  });

  // Every cell, diagonal and "not" against the query its link opens.
  const checkCompare = async (c: { money: ReadonlySet<string>; ran: Method[]; zone: string; through?: Record<string, number | null> }) => {
    const got = await store.compare(id, c);
    const both = got.both as Record<string, Record<string, number>>, not = got.not as Record<string, Record<string, number>>;
    const count = async (q: Partial<TradeQuery>) => (await store.tradeCount(id, { ...NO_FILTER, ...q }, c)).total;
    for (const r of c.ran as string[]) {
      expect(both[r]![r]).toBe(await count({ caught: [r as 'A'] }));
      for (const col of c.ran as string[]) {
        if (col === r) continue;
        expect(both[r]![col]).toBe(await count({ caught: [r as 'A', col as 'A'] }));
        expect(not[r]![col]).toBe(await count({ caught: [r as 'A'], notCaught: [col as 'A'] }));
      }
    }
    return { both, not };
  };
  it("compare: each cell equals tradeCount of its link's query", async () => {
    const { both } = await checkCompare(MONEY_CTX(['A', 'AU', lens]));
    // The lens caught S1, S2 and S5 as sales; the matrix is symmetric.
    expect(both[lens]![lens]).toBe(3);
    expect(both[lens]!.A).toBe(both.A![lens]);
  });
  it('compare: "not" counts only what the other lens judged, when its run is behind', async () => {
    // The lens read through block 250: S2 (300), S3 (400) and later sales are not judged by it yet.
    const behind = { ...MONEY_CTX(['A', lens]), through: { [lens]: 250 } };
    const { both, not } = await checkCompare(behind);
    // Round trips caught S3, which the lens has not judged: it is in neither "both" nor "not", though in A's total.
    expect(both.A![lens]! + not.A![lens]!).toBeLessThan(both.A!.A!);
  });
  it('compare leaves out a lens not in ctx.ran', async () => {
    const got = (await store.compare(id, MONEY_CTX(['A', lens]))).both;
    expect(Object.keys(got).sort()).toEqual(['A', lens].sort());
    expect(Object.keys(got.A!).sort()).toEqual(['A', lens].sort());
    expect(got[other as 'L1']).toBeUndefined();
  });

  describe('a lens whose run read through an earlier block than the latest analysis', () => {
    // Its run read through block 350: S1 (200), S5 (250), S2 (300) and U1 (350), not P1 (360), S3 (400) or S4 (500).
    let behind: string;
    let at: ReturnType<typeof MONEY_CTX> & { through: Record<string, number | null> };
    beforeAll(async () => {
      const analysis = Number((await store.pool.query('SELECT id FROM washtrace.analyses WHERE collection_id = $1', [id])).rows[0].id);
      const b = await store.createLens('Behind', DEFAULT_RULE);
      behind = b.key;
      await store.requestLensRun(b.id, id);
      await store.saveLensRun(b.id, id, 1, analysis, 350, TOTALS, [flag('S1', [W1, W2])], 1);
      at = { ...MONEY_CTX(['A', lens, behind]), through: { [lens]: 600, [behind]: 350 } };
    });

    it('calls clean only what it judged: a trade past its block is not judged yet', async () => {
      expect(await list({ notCaught: [behind as 'L1'] }, at)).toEqual(['U1', 'S2', 'S5']);
      expect(await store.tradeCount(id, { ...NO_FILTER, notCaught: [behind as 'L1'] }, at)).toEqual({ total: 3, unjudged: 0 });
      // Caught needs no bound: its flags are of the trades it read.
      expect(await list({ caught: [behind as 'L1'] }, at)).toEqual(['S1']);
      // With no block for it, it read them all.
      expect(await list({ notCaught: [behind as 'L1'] }, MONEY_CTX(['A', behind]))).toEqual(['S4', 'S3', 'P1', 'U1', 'S2', 'S5']);
    });

    it("counts a group's trades it judged as its denominator, and the built-ins' stay every trade", async () => {
      expect(await store.tradeGroups(id, NO_FILTER, 'marketplace', at)).toEqual([
        { key: 'blur', trades: 7, caught: { A: 3, [lens]: 2, [behind]: 1 }, judged: { [lens]: 6, [behind]: 3 } },
        { key: 'opensea', trades: 1, caught: { A: 1, [lens]: 1, [behind]: 0 }, judged: { [lens]: 1, [behind]: 1 } },
      ]);
    });

    it("counts a token's and a wallet's trades it judged as theirs in its lists", async () => {
      const t = await store.lensTokens(id, behind as 'L1', LIST, at);
      expect(t.rows).toEqual([expect.objectContaining({ tokenId: '1', caught: 1, trades: 2 })]);
      const wl = await store.lensWallets(id, behind as 'L1', LIST, at);
      expect(Object.fromEntries(wl.rows.map((r) => [r.address, r.trades]))).toEqual({ [W1]: 1, [W2]: 2 });
      // The one-pass count, which an order by share reads first, the same.
      const share = await store.lensWallets(id, behind as 'L1', { ...LIST, sort: 'share' }, at);
      expect(Object.fromEntries(share.rows.map((r) => [r.address, r.trades]))).toEqual({ [W1]: 1, [W2]: 2 });
    });

    it('counts its lists alone, with a Find and past the last page, though the block is bound for the page only', async () => {
      const L = behind as 'L1';
      for (const find of [null, '1']) {
        expect(await store.lensTokens(id, L, { ...LIST, find, limit: 0 }, at)).toEqual({ rows: [], total: 1 });
        expect(await store.lensTokens(id, L, { ...LIST, find, offset: 10 }, at)).toEqual({ rows: [], total: 1 });
      }
      for (const find of [null, '0x000000']) {
        expect(await store.lensWallets(id, L, { ...LIST, find, limit: 0 }, at)).toEqual({ rows: [], total: 2 });
        expect(await store.lensWallets(id, L, { ...LIST, find, offset: 10 }, at)).toEqual({ rows: [], total: 2 });
        expect(await store.lensWallets(id, L, { ...LIST, find, sort: 'share', offset: 10 }, at)).toEqual({ rows: [], total: 2 });
      }
    });
  });
});

describe('Store.tx', () => {
  // tx is private on purpose; the test reaches it through a cast, as nothing else does.
  const tx = <T>(fn: (c: pgClient.PoolClient) => Promise<T>): Promise<T> => (store as unknown as { tx: typeof tx }).tx(fn);

  async function probeTable(): Promise<void> {
    await store.pool.query('CREATE TABLE IF NOT EXISTS public.tx_probe (n int)');
    await store.pool.query('TRUNCATE public.tx_probe');
  }
  const count = async () => (await store.pool.query('SELECT count(*)::int AS n FROM public.tx_probe')).rows[0].n as number;

  it('commits what fn wrote and returns what fn returns, releasing the client', async () => {
    await probeTable();
    const idle = store.pool.idleCount;
    const out = await tx(async (c) => {
      await c.query('INSERT INTO public.tx_probe VALUES (1)');
      return 'done';
    });
    expect(out).toBe('done');
    expect(await count()).toBe(1);
    expect(store.pool.totalCount - store.pool.idleCount).toBe(0);
    expect(store.pool.idleCount).toBeGreaterThanOrEqual(idle);
  });

  it('rolls back and throws the original error when fn throws, releasing the client', async () => {
    await probeTable();
    const boom = new Error('boom');
    await expect(tx(async (c) => {
      await c.query('INSERT INTO public.tx_probe VALUES (1)');
      throw boom;
    })).rejects.toBe(boom);
    expect(await count()).toBe(0);
    expect(store.pool.totalCount - store.pool.idleCount).toBe(0);
  });
});

describe('pruning', () => {
  const empty = () => analyze(input([]));
  const kept = async (id: number) => (await store.pool.query('SELECT id FROM washtrace.analyses WHERE collection_id = $1 ORDER BY id', [id])).rows.map((r) => Number(r.id));

  it('keeps a collection\'s newest 100 analyses when it saves a 101st and 102nd, and touches no other collection', async () => {
    const id = (await store.addCollection(1, w('pr01'), null, 1)).id;
    const other = (await store.addCollection(1, w('pr02'), null, 1)).id;
    for (let n = 0; n < 3; n++) await store.saveAnalysis(other, 1, empty(), 1, null, new Set(['']));
    const saved: number[] = [];
    for (let n = 0; n < 102; n++) {
      await store.saveAnalysis(id, 1, empty(), 1, null, new Set(['']));
      saved.push(...(await kept(id)).filter((r) => !saved.includes(r)));
    }
    const rows = await kept(id);
    expect(saved).toHaveLength(102);
    expect(rows).toHaveLength(HISTORY_KEEP);
    // The two oldest went and the newest stayed.
    expect(rows).toEqual(saved.slice(2));
    expect(await kept(other)).toHaveLength(3);
    expect(await store.history(id)).toHaveLength(HISTORY_KEEP);
    const ids = (await store.history(id)).map((r) => r.id);
    expect(ids).toEqual([...ids].sort((p, q) => p - q));
    expect(ids).toEqual(rows);
  });

  it('deletes a check finished more than a day ago when checks expire, and keeps a pending or recent one', async () => {
    const old = await store.requestCheck('rpc', 1);
    const recent = await store.requestCheck('rpc', 1);
    const pending = await store.requestCheck('etherscan', null);
    await store.finishCheck(old, true, {});
    await store.finishCheck(recent, true, {});
    await store.pool.query(`UPDATE washtrace.checks SET finished_at = now() - interval '25 hours' WHERE id = $1`, [old]);
    await store.expireChecks(5 * 60_000);
    expect(await store.check(old)).toBeNull();
    expect(await store.check(recent)).toMatchObject({ finished: true, ok: true });
    expect(await store.check(pending)).toEqual({ finished: false, ok: null, detail: null });
  });
});

describe('spot checks', () => {
  beforeAll(async () => { await store.migrate(); });

  const TX = `0x${'5'.repeat(64)}`;
  const tx = (n: number) => `0x${String(n).padStart(64, '0')}`;
  const finished = { washTrade: true, methods: ['A'], notRun: ['AU'], atLeast: false, finalized: true, source: 'spot', transfers: [] } as unknown as SpotResult;

  it('requestSpot reuses a queued, running or fresh check', async () => {
    const first = await store.requestSpot(1, tx(1), null);
    expect(first.reused).toBe(false);
    expect(await store.requestSpot(1, tx(1), null)).toEqual({ id: first.id, reused: true });
    const withLens = await store.requestSpot(1, tx(1), { key: 'L7', version: 1 });
    expect(withLens.id).not.toBe(first.id);
    const edited = await store.requestSpot(1, tx(1), { key: 'L7', version: 2 });
    expect(edited.id).not.toBe(withLens.id);
    // Running is still in flight.
    await store.pool.query(`UPDATE washtrace.spot_checks SET status = 'running' WHERE id = $1`, [first.id]);
    expect((await store.requestSpot(1, tx(1), null)).id).toBe(first.id);
    // Done and fresh is reused; done two hours back is not.
    await store.saveSpot(first.id, finished);
    expect(await store.requestSpot(1, tx(1), null)).toEqual({ id: first.id, reused: true });
    await store.pool.query(`UPDATE washtrace.spot_checks SET finished_at = now() - interval '2 hours' WHERE id = $1`, [first.id]);
    const again = await store.requestSpot(1, tx(1), null);
    expect(again.id).not.toBe(first.id);
    // A failed check is asked again.
    await store.pool.query(`UPDATE washtrace.spot_checks SET status = 'running' WHERE id = $1`, [again.id]);
    await store.spotFailed(again.id, 'No such transaction on chain 1.');
    expect((await store.requestSpot(1, tx(1), null)).id).not.toBe(again.id);
  });

  it('does not reuse a done check of a block that was not final', async () => {
    const one = await store.requestSpot(1, tx(2), null);
    await store.pool.query(`UPDATE washtrace.spot_checks SET status = 'running' WHERE id = $1`, [one.id]);
    await store.saveSpot(one.id, { ...finished, finalized: false });
    expect((await store.requestSpot(1, tx(2), null)).id).not.toBe(one.id);
  });

  it('does not reuse a done check that was not complete, so Check again after its cause is fixed checks again', async () => {
    const incomplete: SpotResult[] = [
      { ...finished, washTrade: null, notRun: ['AU', 'AC'] },
      { ...finished, washTrade: true, atLeast: true },
      { ...finished, washTrade: null, notRun: ['L7'] },
    ];
    for (const [i, result] of incomplete.entries()) {
      const one = await store.requestSpot(1, tx(40 + i), null);
      await store.pool.query(`UPDATE washtrace.spot_checks SET status = 'running' WHERE id = $1`, [one.id]);
      await store.saveSpot(one.id, result);
      expect((await store.requestSpot(1, tx(40 + i), null)).id).not.toBe(one.id);
    }
  });

  it('two requests at once make one row', async () => {
    const [p, q] = await Promise.all([store.requestSpot(1, tx(3), null), store.requestSpot(1, tx(3), null)]);
    expect(p.id).toBe(q.id);
    const { rows } = await store.pool.query(`SELECT count(*)::int AS n FROM washtrace.spot_checks WHERE tx_hash = $1`, [tx(3)]);
    expect(rows[0].n).toBe(1);
  });

  it('spot reads a check back as the console polls it, and null for an unknown id', async () => {
    const { id } = await store.requestSpot(5, TX, null);
    expect(await store.spot(id)).toMatchObject({ id, chainId: 5, tx: TX, lens: null, status: 'queued', result: null, error: null, finishedAt: null });
    expect(await store.spot(2_000_000_000)).toBeNull();
  });

  it('nextSpot takes the oldest queued, fails one left running, and fails one whose lens was removed or edited', async () => {
    await store.pool.query(`DELETE FROM washtrace.spot_checks`);
    const left = await store.requestSpot(1, tx(10), null);
    await store.pool.query(`UPDATE washtrace.spot_checks SET status = 'running' WHERE id = $1`, [left.id]);
    const removed = await store.createLens('Spot removed', DEFAULT_RULE);
    const gone = await store.requestSpot(1, tx(11), { key: removed.key, version: removed.version });
    await store.deleteLens(removed.id);
    const edited = await store.createLens('Spot edited', DEFAULT_RULE);
    const stale = await store.requestSpot(1, tx(12), { key: edited.key, version: edited.version });
    await store.updateLens(edited.id, 'Spot edited', DEFAULT_RULE);
    const plain = await store.requestSpot(1, tx(13), null);
    const own = await store.createLens('Spot kept', DEFAULT_RULE);
    const kept = await store.requestSpot(1, tx(14), { key: own.key, version: own.version });

    expect(await store.nextSpot()).toEqual({ id: plain.id, chainId: 1, tx: tx(13), lens: null });
    // The fund pass finishes one check before it takes the next.
    await store.saveSpot(plain.id, finished);
    expect(await store.nextSpot()).toEqual({ id: kept.id, chainId: 1, tx: tx(14), lens: { key: own.key, rule: DEFAULT_RULE } });
    await store.saveSpot(kept.id, finished);
    expect(await store.nextSpot()).toBeNull();
    expect(await store.spot(left.id)).toMatchObject({ status: 'failed', error: 'The worker stopped during this check.' });
    expect(await store.spot(gone.id)).toMatchObject({ status: 'failed', error: 'That lens was removed.' });
    expect(await store.spot(stale.id)).toMatchObject({ status: 'failed', error: 'That lens was edited; ask again.' });
    expect(await store.spot(plain.id)).toMatchObject({ status: 'done' });
    expect(await store.spot(kept.id)).toMatchObject({ status: 'done' });
    await store.deleteLens(edited.id);
    await store.deleteLens(own.id);
  });

  it('saveSpot and spotFailed finish only a running check', async () => {
    const { id } = await store.requestSpot(1, tx(20), null);
    await store.saveSpot(id, finished);
    expect(await store.spot(id)).toMatchObject({ status: 'queued' });
    await store.pool.query(`UPDATE washtrace.spot_checks SET status = 'running' WHERE id = $1`, [id]);
    await store.saveSpot(id, finished);
    const done = await store.spot(id);
    expect(done).toMatchObject({ status: 'done', result: finished, error: null });
    expect(done!.finishedAt).not.toBeNull();
  });

  it('moneyReadOn says where each stored read goes on from, however far it reached', async () => {
    const reached = w('5c01'), older = w('5c02'), empty = w('5c03'), waiting = w('5c04');
    await store.addWallets(77, [reached, older, empty, waiting]);
    await store.saveMoney(77, reached, [flow(reached, x, { blockNumber: 50_000 })], false, undefined, 50_000);
    await store.saveMoney(77, older, [flow(older, x, { blockNumber: 30_000 })], true, undefined, 30_000);
    await store.saveMoney(77, empty, [], false, undefined, null);
    const at = await store.moneyReadOn(77, [reached, older, empty, waiting]);
    // A read past the trade still reads on: a payment since it was read can link the pair. A day of blocks (7,200)
    // before the one after its last read.
    expect(at.get(reached)).toEqual({ from: 50_000 + 1 - 7_200, truncated: false });
    // A truncated read is a hub either way, and reading on could save it as untruncated over its gap: never read on.
    expect(at.get(older)).toEqual({ from: 30_000 + 1 - 7_200, truncated: true });
    // A read that found no rows has no block: it reads again from 0.
    expect(at.get(empty)).toEqual({ from: 0, truncated: false });
    expect(at.has(waiting)).toBe(false);
    // Floored at 0 near the chain's start.
    await store.saveMoney(77, waiting, [flow(waiting, x, { blockNumber: 100 })], false, undefined, 100);
    expect((await store.moneyReadOn(77, [waiting])).get(waiting)).toEqual({ from: 0, truncated: false });
  });

  it('addWallets adds a row once, and flowsOf returns flows either way', async () => {
    const me = w('5d01');
    await store.addWallets(78, [me]);
    await store.addWallets(78, [me]);
    const { rows } = await store.pool.query(`SELECT count(*)::int AS n, min(status) AS s FROM washtrace.wallets WHERE chain_id = 78 AND address = $1`, [me]);
    expect(rows[0]).toEqual({ n: 1, s: 'pending' });
    const out = flow(me, a, { blockNumber: 10, blockTime: 1_000 });
    const into = flow(b, me, { blockNumber: 11, blockTime: 1_001 });
    const other = flow(a, b, { blockNumber: 12, blockTime: 1_002 });
    await store.saveMoney(78, me, [out, into, other], false, undefined, 12);
    expect((await store.flowsOf(78, [me])).map((f) => f.txHash).sort()).toEqual([out.txHash, into.txHash].sort());
    expect(await store.flowsOf(78, [])).toEqual([]);
  });

  it('sweepFinished also deletes spot checks past a day', async () => {
    const old = await store.requestSpot(1, tx(30), null);
    const fresh = await store.requestSpot(1, tx(31), null);
    await store.pool.query(`UPDATE washtrace.spot_checks SET requested_at = now() - interval '25 hours' WHERE id = $1`, [old.id]);
    await store.sweepFinished(Date.now());
    expect(await store.spot(old.id)).toBeNull();
    expect(await store.spot(fresh.id)).not.toBeNull();
  });
});

describe('the timeline\'s sales apart', () => {
  const CHAIN = 911;
  const coll = '0x' + 'e1'.padEnd(40, '0');
  const A = '0x' + 'aa'.padEnd(40, '0'), B = '0x' + 'bb'.padEnd(40, '0');
  const tx = (n: number) => '0x' + String(n).padStart(64, '0');
  afterAll(() => drop(CHAIN, coll));

  it('counts a sale only Money loops back flags apart, and none a counted method also flags', async () => {
    await store.migrate();
    const id = (await store.addCollection(CHAIN, coll, null, 1)).id;
    const sale = (n: number) => transfer(String(n), n % 2 ? A : B, n % 2 ? B : A, { txHash: tx(n), blockNumber: n, blockTime: 1_700_000_000 + n, marketplace: 'Seaport' });
    await store.ingest(id, CHAIN, [1, 2, 3, 4].map(sale), 100, [A, B]);
    const flag = (m: Method, n: number) => store.pool.query(
      `INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness) VALUES ($1, $2, $3, 0, '{"kind":"pair","pair":[],"middle":null,"flowTx":"0x"}')`,
      [id, m, tx(n)]);
    // 1: all three; 2: Linked wallets and Money loops back; 3: Money loops back alone; 4: nothing.
    for (const m of ['A', 'AC', 'AU'] as const) await flag(m, 1);
    await flag('AC', 2);
    await flag('AU', 2);
    await flag('AU', 3);
    const [p] = (await store.timeline(id)).points;
    expect(p).toMatchObject({ sales: 4, apartSales: 1, flaggedSales: { A: 1, AC: 2, AU: 3 } });
  });
});

describe('rings worked out from an analysis saved before them', () => {
  const CHAIN = 912;
  const coll = '0x' + 'e2'.padEnd(40, '0');
  const w = (s: string) => '0x' + s.padEnd(40, '0');
  const S = w('a1'), B = w('b1'), M = w('c1'), X = w('d1'), Y = w('e1');
  const tx = (n: number) => '0x' + String(n).padStart(64, '0');
  const RAN = { money: new Set(['']), ran: ['A', 'AU', 'AC'] as Method[], zone: 'UTC' };
  let id = 0;
  afterAll(() => drop(CHAIN, coll));

  beforeAll(async () => {
    await store.migrate();
    id = (await store.addCollection(CHAIN, coll, null, 1)).id;
    const sale = (n: number, from: string, to: string) => transfer(String(n), from, to, { txHash: tx(n), blockNumber: n, blockTime: 1_700_000_000 + n, marketplace: 'Seaport', priceWei: '1000000000000000000', currency: '' });
    await store.ingest(id, CHAIN, [sale(1, S, B), sale(2, B, S), sale(3, X, Y)], 100, [S, B, X, Y]);
    // Saved before rings: loops counted, rings not.
    await store.pool.query(
      `INSERT INTO washtrace.analyses (collection_id, took_ms, through_block, totals, missing_data, funded_wallets, wallets, truncated_searches, loops)
       VALUES ($1, 1, 100, $2, 0, 0, 0, 0, '{}')`,
      [id, JSON.stringify({ A: { available: true }, AU: { available: true }, AC: { available: true } })]);
    // 0: S and B's round trip. 1: B and a new seller linked through middle M, by Linked wallets. 2: X and Y, by Money loops back alone.
    const witness = (wid: number, kind: string, wallets: string[], middle: string | null = null) => store.pool.query(
      'INSERT INTO washtrace.witnesses (collection_id, id, kind, wallets, cycles, middle) VALUES ($1, $2, $3, $4, $5, $6)', [id, wid, kind, wallets, kind === 'pair' ? null : 1, middle]);
    await witness(0, 'scc', [S, B]);
    await witness(1, 'pair', [B, S, M], M);
    await witness(2, 'pair', [X, Y]);
    const flag = (m: Method, n: number, wid: number) => store.pool.query(
      `INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness, witness_id) VALUES ($1, $2, $3, 0, '{"kind":"scc","wallets":[],"cycles":1}', $4)`, [id, m, tx(n), wid]);
    // Sale 2 is Round trips' through the loop and Linked wallets' through the pair: two witnesses, one ring.
    await flag('A', 1, 0);
    await flag('AC', 1, 0);
    await flag('A', 2, 0);
    await flag('AC', 2, 1);
    await flag('AU', 3, 2);
    // Counted, as an analysis's trade facts count a sale.
    await store.pool.query(`INSERT INTO washtrace.trade_facts (collection_id, tx_hash, log_index, counted) SELECT $1, tx_hash, log_index, true FROM washtrace.transfers WHERE collection_id = $1`, [id]);
  });

  it('fills them once, from the witnesses a counted lens points at, leaves Money loops back\'s in none, and passes over one skipped', async () => {
    // Skipped, it is passed over while every other collection fills; then it fills.
    while (await store.fillRings([id])) { /* other collections' first */ }
    expect((await store.pool.query('SELECT rings FROM washtrace.analyses WHERE collection_id = $1', [id])).rows[0].rings).toBeNull();
    expect(await store.fillRings()).toBe(true);
    const rings = (await store.pool.query('SELECT id, ring FROM washtrace.witnesses WHERE collection_id = $1 ORDER BY id', [id])).rows;
    expect(rings).toEqual([{ id: 0, ring: S }, { id: 1, ring: S }, { id: 2, ring: null }]);
    expect((await store.pool.query('SELECT rings FROM washtrace.analyses WHERE collection_id = $1', [id])).rows[0].rings).toBe(1);
    expect(await store.fillRings()).toBe(false);
  });

  it('lists a middle as a wallet of its ring that only moved the money, and counts a trade two witnesses flag once', async () => {
    const view = (await store.ring(id, S, RAN))!;
    // A middle sold and bought nothing; S and B each sold one sale of 1 ETH to the other.
    expect(view.wallets).toEqual([
      { address: S, traded: true, sold: 1, bought: 1, volumeWei: '2000000000000000000' },
      { address: B, traded: true, sold: 1, bought: 1, volumeWei: '2000000000000000000' },
      { address: M, traded: false, sold: 0, bought: 0, volumeWei: '0' },
    ]);
    expect(view.line).toMatchObject({ wallets: 3, sales: 2, floorSales: 2, volumeWei: '2000000000000000000' });
    expect((await store.rings(id, RAN, 10, 0)).total).toBe(1);
    expect(await store.ringsOf(id, { wallet: X })).toEqual([]);
  });

  it('narrows the trades to a ring\'s: those a counted lens flags through its witnesses', async () => {
    expect((await store.tradeCount(id, { ...NO_FILTER, ring: S }, RAN)).total).toBe(2);
    // Sale 3 is flagged, but only by Money loops back, which makes no ring.
    expect((await store.tradeCount(id, { ...NO_FILTER, ring: X }, RAN)).total).toBe(0);
  });
});

// Last in the file: a fixture's counter moves with every transfer or flow built, and a test above reads block numbers it gave.
describe('Store.payment', () => {
  it('payment reads one payment from the flows key, and the witnesses that use it: every leg of a Linked wallets pair, and each step of a Money loops back path', async () => {
    const C = 3130;
    const [s, bu, m, u, v, h, x1] = [w('3ba1'), w('3ba2'), w('3ba3'), w('3ba4'), w('3ba5'), w('3ba6'), w('3ba7')];
    const { id } = await store.addCollection(C, w('3bc1'), 'Paid Apes', 10);
    const pair = { kind: 'pair' as const, pair: [s, bu] as [string, string], middle: m, flowTx: '0xpay1', shape: 'funder' as const };
    try {
      // Five sales flagged by the one pair; one flagged by a loop whose path runs through h, a wallet no witness row holds.
      const sales = Array.from({ length: 5 }, (_, i) => transfer(String(i + 1), s, bu, { txHash: `0xpsale${i}`, blockNumber: 20 + i }));
      const looped = transfer('9', u, v, { txHash: '0xpsaleU', blockNumber: 30 });
      // Another loop, with a path of its own: its witness holds none of the payments below.
      const [u2, v2, h2] = [w('3ba8'), w('3ba9'), w('3baa')];
      const other = transfer('10', u2, v2, { txHash: '0xpsaleV', blockNumber: 31 });
      const loop2 = { kind: 'scc+flow' as const, wallets: [u2, v2], cycles: 1, via: [[v2, u2]] as [string, string][], paths: [{ wallets: [v2, h2, u2], txs: ['0xhop9', '0xhop10'] }] };
      const loop = { kind: 'scc+flow' as const, wallets: [u, v], cycles: 1, via: [[v, u]] as [string, string][], paths: [{ wallets: [v, h, u], txs: ['0xhop1', '0xhop2'] }] };
      await store.ingest(id, C, [...sales, looped, other], 100, [s, bu, u, v, u2, v2]);
      const [stale] = (await store.stale()).filter((r) => r.id === id);
      const flags = [
        ...sales.map((t) => ({ txHash: t.txHash, logIndex: t.logIndex, method: 'AC' as const, witness: pair })),
        { txHash: looped.txHash, logIndex: looped.logIndex, method: 'AU' as const, witness: loop },
        { txHash: other.txHash, logIndex: other.logIndex, method: 'AU' as const, witness: loop2 },
      ];
      await store.saveAnalysis(id, stale!.version, { ...analyze(input([...sales, looped, other])), flags }, 1, 1_000_000, new Set(['']));
      await store.saveMoney(C, m, [
        flow(m, s, { txHash: '0xpay1' }), flow(m, bu, { txHash: '0xpay2' }), flow(s, x1, { txHash: '0xpay3' }), flow(m, s, { txHash: '0xpayzero', valueWei: '0' }),
        // Two hops of v's path back, each with a hash other than the one the witness keeps; the first paid twice, in two transactions.
        flow(v, h, { txHash: '0xhop1' }), flow(v, h, { txHash: '0xhop1b' }), flow(h, u, { txHash: '0xhop2' }),
        // A payment inside one of the collection's sales is no evidence.
        flow(m, s, { txHash: '0xpsale0' }),
      ], false);
      const used = async (hash: string, chainId = C, only: number | null = null) => {
        const flows = await store.payment(chainId, hash);
        return flows === null ? undefined : (await store.paymentUsedBy(chainId, flows, only)).map((o) => [o.use, o.collection.address, o.sales.length, o.more]);
      };
      const apes = w('3bc1');
      // Both legs of the pair are used, and the one the witness names says so.
      expect(await used('0xpay1')).toEqual([[{ method: 'AC', named: true }, apes, 3, true]]);
      expect(await used('0xpay2')).toEqual([[{ method: 'AC', named: false }, apes, 3, true]]);
      // The first three of its sales, in the order of the chain.
      const read = (await store.payment(C, '0xpay1'))!;
      expect(read).toMatchObject([{ txHash: '0xpay1', from: m, to: s, valueWei: '1000' }]);
      expect((await store.paymentUsedBy(C, read, null))[0]).toMatchObject({ witness: pair, collection: { id, name: 'Paid Apes' }, sales: [{ txHash: '0xpsale0', tokenId: '1' }, { txHash: '0xpsale1', tokenId: '2' }, { txHash: '0xpsale2', tokenId: '3' }] });
      // Every payment of a path's step, whichever hash the witness keeps.
      expect(await used('0xhop1')).toEqual([[{ method: 'AU', back: [v, u] }, apes, 1, false]]);
      expect(await used('0xhop1b')).toEqual([[{ method: 'AU', back: [v, u] }, apes, 1, false]]);
      expect(await used('0xhop2')).toEqual([[{ method: 'AU', back: [v, u] }, apes, 1, false]]);
      // Scoped to a collection: its own uses only.
      expect(await used('0xhop1', C, id)).toHaveLength(1);
      expect(await used('0xhop1', C, id + 1000)).toEqual([]);
      expect(await used('0xpay1', C, id + 1000)).toEqual([]);
      // Stored, and used by nothing: money among no pair; a zero value; a payment inside a sale.
      expect(await used('0xpay3')).toEqual([]);
      expect(await used('0xpayzero')).toEqual([]);
      expect(await used('0xpsale0')).toEqual([]);
      // Not stored, or on another chain.
      expect(await used('0xnever')).toBeUndefined();
      expect(await used('0xpay1', C + 1)).toBeUndefined();
    } finally {
      await drop(C, w('3bc1'));
    }
  });

  it('payment finds a payment by the flows primary key, not a scan of the table', async () => {
    await store.migrate();
    const pg = await store.pool.connect();
    try {
      await pg.query('BEGIN');
      // A busy chain, as for flowsAmong above, so the plan does not hang on whatever earlier tests left in the table: one
      // payment a transaction across a few hundred payees, which flows_to_idx (the chain and payee) can only scan; rolled back.
      await pg.query(
        `INSERT INTO washtrace.flows (chain_id, tx_hash, kind, from_address, to_address, value_wei, token, block_number, block_time)
         SELECT 1, '0xpay' || g, 'native', '0x' || lpad(to_hex(g), 40, '0'), '0x' || lpad(to_hex(g % 300), 40, '0'), 1, '', g, now() FROM generate_series(1, 20000) g`,
      );
      await pg.query('ANALYZE washtrace.flows');
      const plan = (await pg.query(`EXPLAIN ${PAYMENT_SQL}`, [1, '0xabc'])).rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan, plan).toMatch(/flows_pkey/);
      expect(plan, plan).toMatch(/Index Cond: .*chain_id = 1.*kind = ANY.*tx_hash = '0xabc'/s);
      expect(plan, plan).not.toMatch(/flows_(from|to)_idx|Seq Scan/);
    } finally {
      await pg.query('ROLLBACK');
      pg.release();
    }
  });
});
