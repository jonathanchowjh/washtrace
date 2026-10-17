import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pgClient from 'pg';
import { SECRET_KEYS, Store } from '../src/store.js';
import { analyze } from '../src/methods.js';
import { analyzeStored } from '../src/analysis-thread.js';
import { Worker } from '../src/worker.js';
import { Chain } from '../src/chain.js';
import { Etherscan } from '../src/etherscan.js';
import { workerConfig } from '../src/env.js';
import { HttpRequestError } from 'viem';
import { chain, flow, input, w } from './fixtures.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoredDataError, readTrail, trailPath, writeTrail, type StoredEntry } from '../src/stored.js';
import { needsRestore } from '../src/worker.js';
import type { Flow, Transfer } from '../src/types.js';

let pg: StartedPostgreSqlContainer;
let store: Store;
const collection = w('c011');
const a = w('a'), b = w('b'), x = w('x');

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

describe('Store', () => {
  it('migrates, and migrating again changes nothing', async () => {
    expect(await store.migrate()).toBe(17);
    expect(await store.schemaVersion()).toBe(17);
    expect(await store.migrate()).toBe(17);
    expect(await store.migrate()).toBe(17);
    const { rows } = await store.pool.query('SELECT version FROM washtrace.schema_version');
    expect(rows).toEqual([{ version: 17 }]);
  });

  it('drops "Reading from the chain instead" from notes written before the console said what follows', async () => {
    const id = (await store.addCollection(1, w('1ec1'), 'Noted', 1)).id;
    await store.pool.query("UPDATE washtrace.collections SET restore_note = 'Stored data could not be loaded: its file is missing. Reading from the chain instead.' WHERE id = $1", [id]);
    try {
      await store.pool.query('DELETE FROM washtrace.schema_version');
      await store.pool.query('INSERT INTO washtrace.schema_version (version) VALUES (13)');
      expect(await store.migrate()).toBe(17);
      expect(await store.collection(1, w('1ec1'))).toMatchObject({ restoreNote: 'Stored data could not be loaded: its file is missing.', restoreNoteKey: null, restoreRetryAt: null });
    } finally {
      await drop(1, w('1ec1'));
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
      expect(await store.migrate()).toBe(17);
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
    expect(await store.fundingLanes(1, 10, 3)).toEqual({ lanes: [{ collectionId: c.id, wallets: [a, b] }] });
  });

  it('gives each collection its own lane of unchecked traders, a shared one in both', async () => {
    const other = (await store.addCollection(1, w('0be'), 'Other', 1)).id;
    const c = (await store.collection(1, collection))!;
    await store.ingest(other, 1, chain('2', b, w('o1')), 10, [b, w('o1')]);
    const { lanes } = await store.fundingLanes(1, 10, 3);
    expect(lanes).toEqual([{ collectionId: c.id, wallets: [b, a] }, { collectionId: other, wallets: [b, w('o1')] }]);
    expect((await store.fundingLanes(1, 1, 3)).lanes.map((l) => l.wallets.length)).toEqual([1, 1]);
    await drop(1, w('0be'));
  });

  it('leaves followed wallets further out than the hops followed unchecked, and counts them held back', async () => {
    const chainId = 22, t = w('22a1'), m1 = w('22a2'), m2 = w('22a3');
    const id = (await store.addCollection(chainId, w('22c1'), 'Hops', 1)).id;
    const row = async (hops: number) => (await store.fundingBacklog(hops)).find((r) => r.chainId === chainId)!;
    try {
      await store.ingest(id, chainId, chain('25', t), 10, [t]);
      // Queued while following went two hops out; then the setting came down.
      await store.pool.query('INSERT INTO washtrace.wallets (chain_id, address, depth) VALUES ($1, $2, 1), ($1, $3, 2)', [chainId, m1, m2]);
      expect((await store.fundingLanes(chainId, 10, 2)).lanes.at(-1)).toEqual({ collectionId: null, wallets: [m1, m2] });
      expect((await store.fundingLanes(chainId, 10, 1)).lanes.at(-1)).toEqual({ collectionId: null, wallets: [m1] });
      // 0 reads traders only.
      expect((await store.fundingLanes(chainId, 10, 0)).lanes).toEqual([{ collectionId: id, wallets: [t] }]);
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
      expect((await store.fundingLanes(7, 10, 3)).lanes).toEqual([{ collectionId: id, wallets: [t] }, { collectionId: null, wallets: [m] }]);
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
    const { lanes } = await store.fundingLanes(1, 10, 3);
    expect(lanes.map((l) => l.collectionId)).not.toContain(c1);
    expect(lanes.find((l) => l.collectionId === c2)!.wallets).toContain(s);
    expect((await store.stale()).map((r) => r.id)).not.toContain(c1);
    // With nothing in sync on the chain there are no lanes, the followed one included.
    await store.pool.query('UPDATE washtrace.collections SET paused_at = now()');
    expect((await store.fundingLanes(1, 10, 3)).lanes).toEqual([]);
    expect(await store.resume(1, w('9c2'))).toBe(true);
    expect(await store.resume(1, w('9c2'))).toBe(false);
    await store.pool.query('UPDATE washtrace.collections SET paused_at = NULL');
    expect((await store.collection(1, w('9c2')))!.pausedAt).toBeNull();
    await drop(1, w('9c1'));
    await drop(1, w('9c2'));
  });

  it('counts as waiting only the wallets a lane serves, and the ones a paused collection holds back apart', async () => {
    const chainId = 21, live = w('21c1'), held = w('21c2');
    const l = w('21a1'), lf = w('21a2'), p = w('21a3'), pf = w('21a4'), m = w('21a5'), sh = w('21a6');
    const c1 = (await store.addCollection(chainId, live, 'Live', 1)).id;
    const c2 = (await store.addCollection(chainId, held, 'Held', 1)).id;
    const row = async () => (await store.fundingBacklog(3)).find((r) => r.chainId === chainId)!;
    try {
      await store.ingest(c1, chainId, chain('21', l, lf), 10, [l, lf]);
      await store.ingest(c2, chainId, chain('22', p, pf), 10, [p, pf]);
      // Traded in both: sent in the paused one, received in the live one, so a probe can meet the paused one's transfer first.
      await store.ingest(c2, chainId, chain('23', sh, p), 20, [sh, p]);
      await store.ingest(c1, chainId, chain('24', sh), 20, [sh]);
      await store.fundingFailed(chainId, lf, 'timeout');
      await store.fundingFailed(chainId, pf, 'timeout');
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
    await store.ingest(id, 1, ts, 10, []);
    const saleTx = ts[1]!.txHash;
    await store.fund(1, d1, [
      flow(d1, d3, { blockNumber: 900, txHash: '0xdedu1' }), flow(d1, d3, { blockNumber: 800, txHash: '0xdedu2' }),
      flow(d1, d2, { txHash: saleTx }), flow(d1, d1), flow(d3, d1, { valueWei: '0' }),
    ], false);
    const { flows } = await store.analysisInput(id, 1);
    // The one MoneyGraph.join would keep of the two, whatever their blocks.
    expect(flows.map((f) => [f.from, f.to, f.blockNumber])).toEqual([[d1, d3, 900]]);
    await drop(1, w('dedu'));
  });

  it('stores funding and takes the wallet off the queue', async () => {
    await store.fund(1, x, [flow(x, a), flow(x, b)], false);
    expect(await store.counterparties(1, x)).toHaveLength(2);
  });

  it('counts the wallets finished in the last hour, for the funding wait', async () => {
    const lastHour = async () => (await store.fundingBacklog(3)).find((r) => r.chainId === 1)!.doneLastHour;
    const before = await lastHour();
    expect(before).toBeGreaterThan(0);
    await store.pool.query(`UPDATE washtrace.wallets SET fetched_at = now() - interval '2 hours' WHERE chain_id = 1 AND address = $1`, [x]);
    expect(await lastHour()).toBe(before - 1);
  });

  it('round-trips an analysis, its flags and its reads', async () => {
    const [stale] = await store.stale();
    const read = await store.analysisInput(stale!.id, 1);
    expect(read.transfers).toHaveLength(4);
    expect(read.flows).toHaveLength(2);
    // X funded both, but never traded here: it is a middle, not one of the collection's wallets.
    expect(read.funded).toEqual(new Set());
    const result = analyze({ ...input(read.transfers, read.flows), funded: read.funded });
    await store.saveAnalysis(stale!.id, stale!.version, result, 5, read.through);

    expect(await store.stale()).toEqual([]);
    const c = (await store.collection(1, collection))!;
    expect(c.latest?.totals.A).toMatchObject({ transfers: 3, flagged: 3, sales: 3 });
    expect(await store.topTokens(c.id, 'A')).toEqual([{ tokenId: '1', transfers: 4, flagged: 3 }]);
    expect((await store.topWallets(c.id, 'A')).map((r) => r.address).sort()).toEqual([a, b].sort());
    const token = await store.token(c.id, '1');
    expect(token.map((t) => Object.keys(t.flags).sort())).toEqual([[], ['A', 'AC', 'AU'], ['A', 'AC', 'AU'], ['A', 'AC', 'AU']]);
    expect(await store.transaction(1, token[1]!.txHash)).toEqual([expect.objectContaining({ collection: { chainId: 1, address: collection, name: 'Test' } })]);
    expect(await store.history(c.id)).toHaveLength(1);
  });

  it('pages the ranked reads', async () => {
    const c = (await store.collection(1, collection))!;
    const all = await store.topWallets(c.id, 'A');
    expect(await store.topWallets(c.id, 'A', 1, 1)).toEqual([all[1]]);
    expect(await store.topTokens(c.id, 'A', 10, 1)).toEqual([]);
  });

  it('buckets the collection\'s own history by when its sales happened, with what each method flags', async () => {
    const c = (await store.collection(1, collection))!;
    // Four transfers a second apart: one bucket, the mint not a sale.
    expect(await store.timeline(c.id)).toEqual({
      bucket: 'hour', untimed: 0, readThrough: (1_700_000_000 + 3) * 1000,
      points: [{ at: Math.floor(1_700_000_000 / 3600) * 3600 * 1000, transfers: 4, sales: 3, flaggedSales: { A: 3, AU: 3, AC: 3 } }],
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
    await store.fund(1, a, [flow(a, b)], false);
    const [stale] = await store.stale();
    await store.fund(1, b, [], false);
    await store.saveAnalysis(c!.id, stale!.version, analyze(input([])), 1, null);
    expect(await store.stale()).toHaveLength(1);
  });

  it('drops an analysis of a collection removed while it ran', async () => {
    const { id } = await store.addCollection(1, w('90e'), 'Gone', 1);
    const due = (await store.stale()).find((s) => s.id === id)!;
    expect(due).toMatchObject({ name: 'Gone', ranAt: null, tookMs: null });
    await drop(1, w('90e'));
    await expect(store.saveAnalysis(id, due.version, analyze(input([])), 1, null)).resolves.toBeUndefined();
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
    await store.saveAnalysis(id, due.version, analyze(input([])), 1, null);
    expect(await store.collection(1, coll)).toMatchObject({ analysisError: null, analysisRetryAt: null });
    expect(await failures()).toBe(0);
    await drop(1, coll);
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
    const worker = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {}, storedRepo: 'u/d' }), pg.getConnectionUri());
    // The thread's own body, in-process: the TS sources cannot start the thread.
    worker.analyzeOff = (request) => analyzeStored(store, request);
    await store.configure(1, collection, { rules: { minCycles: null, reachDepth: null } });
    await worker.analyze();
    expect((await store.collection(1, collection))!.latest?.totals.A.flagged).toBe(3);
    // Two cycles is the paper's floor; at 99 the same trades are not a pattern.
    // A rule edit runs at once, though the last analysis was moments ago.
    await store.configure(1, collection, { rules: { minCycles: 99 } });
    await worker.analyze();
    expect((await store.collection(1, collection))!.latest?.totals.A.flagged).toBe(0);
  });

  describe('following money for SCC AU', () => {
    const follow = { hops: 2, fanout: 3, exclude: [w('5ea')] };
    const depthOf = async (a: string) => (await store.pool.query('SELECT depth FROM washtrace.wallets WHERE chain_id = 1 AND address = $1', [a])).rows[0]?.depth ?? null;

    it('queues the wallets a trader paid, one hop out, behind every trader', async () => {
      await store.fund(1, a, [flow(a, w('m1')), flow(w('in'), a), flow(a, w('5ea'))], false, follow);
      // Paid by a: followed. Paid a: not, since AU follows money onward. A contract: never.
      expect(await depthOf(w('m1'))).toBe(1);
      expect(await depthOf(w('in'))).toBeNull();
      expect(await depthOf(w('5ea'))).toBeNull();
      const { lanes } = await store.fundingLanes(1, 10, 3);
      expect(lanes.at(-1)).toEqual({ collectionId: null, wallets: [w('m1')] });
      expect(lanes.slice(0, -1).some((l) => l.wallets.includes(w('m1')))).toBe(false);
    });

    it('stops at the hop limit', async () => {
      await store.fund(1, w('m1'), [flow(w('m1'), w('m2'))], false, follow);
      expect(await depthOf(w('m2'))).toBe(2);
      await store.fund(1, w('m2'), [flow(w('m2'), w('m3'))], false, follow);
      expect(await depthOf(w('m3'))).toBeNull();
    });

    it('does not follow a wallet that paid more wallets than the fanout', async () => {
      await store.fund(1, b, [1, 2, 3, 4].map((i) => flow(b, w(`f${i}`))), false, follow);
      expect(await depthOf(w('f1'))).toBeNull();
    });

    it('reads a followed wallet\'s payments onward into the analysis', async () => {
      const [c] = await store.collections();
      const read = await store.analysisInput(c!.id, 1);
      expect(read.flows.some((f) => f.from === w('m1') && f.to === w('m2'))).toBe(true);
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
      await store.reportSources({ 'rpc.1': { source: 'env', value: null }, 'follow.hops': { source: 'env', value: '2' } });
      await store.reportSources({
        'etherscan.rps': { source: 'console', value: '5' },
        // A caller that forgot to blank a secret: the store blanks it.
        'rpc.1': { source: 'console', value: 'https://rpc.example/key' },
      });
      const sources = await store.sources();
      expect(Object.keys(sources).sort()).toEqual(['etherscan.rps', 'rpc.1']);
      expect(sources['etherscan.rps']).toMatchObject({ source: 'console', value: '5' });
      expect(sources['rpc.1']).toMatchObject({ source: 'console', value: null });
      expect(sources['rpc.1']!.reportedAt).toBeGreaterThan(Date.now() - 60_000);
      expect(JSON.stringify(sources)).not.toContain('https');
    });

    it('takes reports from passes that run at once, keeping the last', async () => {
      // ingest, fund and analyze start together and each reports where settings came from.
      const report = (n: number) => ({ 'follow.hops': { source: 'console' as const, value: String(n) }, [`rpc.${n}`]: { source: 'env' as const, value: null } });
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
      // Aged by the store's clock, so the worker can tell a check no notification brought (see Worker.sweepChecks).
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
      expect(await worker.runChecks()).toBe(1);
      const done = await store.check(id);
      expect(done).toEqual({ finished: true, ok: true, detail: { finalized: 26_253_624, archive: true, logs: false } });
      expect(JSON.stringify(done)).not.toContain('https');
      expect(await worker.runChecks()).toBe(0);
    });

    it('tests the URL saved a moment ago, not the one read at the last pass', async () => {
      const { worker, urls } = checker();
      (worker as any).settings = new Map([['rpc.1', 'https://old.example/rpc']]);
      await store.setSetting('rpc.1', 'https://fresh.example/rpc', 'alice');
      try {
        await store.requestCheck('rpc', 1);
        await worker.runChecks();
        expect(urls).toEqual(['https://fresh.example/rpc']);
        // A store that cannot be read falls back to the settings read last.
        const read = store.settings;
        store.settings = async () => { throw new Error('store away'); };
        try {
          await store.requestCheck('rpc', 1);
          await worker.runChecks();
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
        await worker.runChecks();
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
      await worker.runChecks();
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
        await expect(worker.runChecks()).rejects.toThrow('store away');
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
      await worker.runChecks();
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
      await worker.runChecks();
      const failed = JSON.stringify(await store.check(es));
      expect(failed).toContain('"ok":false');
      for (const leak of ['https', 'apikey', KEY]) expect(failed).not.toContain(leak);
    });

    it('expires a check asked for more than 5 minutes ago instead of running it', async () => {
      const id = await store.requestCheck('rpc', 1);
      await store.pool.query(`UPDATE washtrace.checks SET requested_at = now() - interval '6 minutes' WHERE id = $1`, [id]);
      const { worker, urls } = checker({ WASHTRACE_RPC_1: RPC });
      expect(await worker.runChecks()).toBe(1);
      expect(await store.check(id)).toEqual({ finished: true, ok: false, detail: { error: 'expired' } });
      expect(urls).toEqual([]);
    });

    it('finishes a malformed check with an error rather than throwing', async () => {
      const id = await store.requestCheck('rpc', null);
      const { worker, urls } = checker({ WASHTRACE_RPC_1: RPC });
      expect(await worker.runChecks()).toBe(1);
      const done = (await store.check(id))!;
      expect(done).toMatchObject({ finished: true, ok: false });
      expect(done.detail?.error).toMatch(/chain/i);
      expect(urls).toEqual([]);
    });

    it('says what is missing: an Etherscan key, or an RPC for the chain', async () => {
      const noKey = await store.requestCheck('etherscan', 1);
      const noRpc = await store.requestCheck('rpc', 5);
      const { worker } = checker({ WASHTRACE_RPC_1: RPC });
      expect(await worker.runChecks()).toBe(2);
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
      await worker.runChecks();
      expect(pinged).toEqual([1]);
      expect(await store.check(id)).toMatchObject({ finished: true, ok: true });
    });

    it('runs a check as soon as it is requested, one run at a time, until stopped', async () => {
      const { worker } = checker({ WASHTRACE_RPC_1: RPC });
      const run = worker.runChecks.bind(worker);
      let running = 0, most = 0, runs = 0;
      worker.runChecks = async () => {
        running += 1; runs += 1; most = Math.max(most, running);
        try {
          await new Promise((r) => setTimeout(r, 200));
          return await run();
        } finally {
          running -= 1;
        }
      };
      await worker.listen();
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
      await worker.listen();
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
      await store.fund(chainId, a, paid, false, { hops: 2, fanout: 3, exclude: [] });
      await store.fund(chainId, m, onward, false);
      const trail = await store.trail(id, chainId);
      // m2 is checked after the trail was begun: it is not in the file, rather
      // than in it as done without the flows that were not looked for.
      await store.fund(chainId, m2, [flow(m2, w('0u8'))], false);
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
      expect((await store.fundingLanes(chainId, 10, 3)).lanes.find((l) => l.collectionId === id)!.wallets.sort()).toEqual([p, q, r].sort());
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
      await store.fund(chainId, p, [local], false);
      await store.pool.query('INSERT INTO washtrace.wallets (chain_id, address, depth) VALUES ($1, $2, 2), ($1, $3, 1)', [chainId, deep, kept]);
      await store.fund(chainId, kept, [], false);
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
      await store.fund(13, ta, [flow(ta, e)], false, { hops: 2, fanout: 3, exclude: [] });
      await store.fund(13, tb, [flow(tb, f1)], true);
      await store.fundingFailed(13, td, 'rate limited');
      await store.fund(13, e, [flow(e, f1)], false);
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
        await store.fund(18, t1, [], true);
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
      const entry = (chainId: number, address: string, sha256: string): StoredEntry => ({
        // Through block 40: a collection read to 50 (see before) is past its transfers, and only its trail is due.
        chainId, address, name: 'Trailed', startBlock: 5, throughBlock: 40, throughTime: 1_700_000_100_000,
        transfers: { file: `${chainId}-${address}.transfers.csv.zst`, rows: 0, bytes: 0, sha256: '' },
        trail: { rows: 3, wallets: 3, checked: 2, of: 2, bytes: 0, sha256 },
      });
      const worker = (key: string | null) => new Worker(
        store, () => ({ rpc: new Map(), etherscanKey: key, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {}, storedRepo: 'u/d' }), pg.getConnectionUri(), dir,
      );
      const written = async (e: StoredEntry) => writeTrail(trailPath(dir, e), {
        checked: trail.flatMap((b) => b.checked).sort(),
        flows: trail.flatMap((b) => b.flows),
      });

      it('loads a trail that matches the manifest once, and the money lenses run on it with no key', async () => {
        const coll = w('14c1');
        const id = await before(14, coll);
        const { sha256 } = await written(entry(14, coll, ''));
        const e = entry(14, coll, sha256);
        const w14 = worker(null);
        const mine = async () => (await store.collections()).filter((c) => c.chainId === 14);
        // Another collection on the chain, with no trail of its own.
        const z = (await store.addCollection(14, w('14c2'), null, 10)).id;
        expect(await store.importedFunding(id)).toBe(false);
        await (w14 as any).trails((await mine()).filter((c) => c.id === id), { version: 2, collections: [e] });
        // The import runs in the background: wait for it.
        await (w14 as any).importing?.done;
        expect(await store.collection(14, coll)).toMatchObject({ trailImportedSha: sha256, trailNote: null });
        expect(await flowRows(14)).toHaveLength(3);
        expect(await store.importedFunding(id)).toBe(true);
        // Checked wallets on its chain are not its funding: no trail of its own, no key, no money lenses.
        expect(await store.importedFunding(z)).toBe(false);
        // Loaded: not loaded again.
        let read = 0;
        (w14 as any).storedTrail = (path: string, sha: string) => { read += 1; return readTrail(path, sha); };
        await (w14 as any).trails(await mine(), { version: 2, collections: [e] });
        expect(read).toBe(0);

        // No key, but checked wallets from the trail: the money lenses run.
        const analyse = async (which: number) => {
          const only = Object.assign(Object.create(store), { stale: async () => (await store.stale()).filter((s) => s.id === which) });
          const analyst = new Worker(only, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {}, storedRepo: 'u/d' }), pg.getConnectionUri(), dir);
          analyst.analyzeOff = (request) => analyzeStored(store, request);
          await analyst.analyze();
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
        await written(entry(15, coll, ''));
        const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await (worker(null) as any).trails([(await store.collection(15, coll))!], { version: 2, collections: [entry(15, coll, 'beef')] });
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
