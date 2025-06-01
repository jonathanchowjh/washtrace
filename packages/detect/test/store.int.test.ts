import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Store } from '../src/store.js';
import { analyze } from '../src/methods.js';
import { Worker } from '../src/worker.js';
import { chain, flow, input, w } from './fixtures.js';

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

describe('Store', () => {
  it('migrates, and migrating again changes nothing', async () => {
    expect(await store.migrate()).toBe(7);
    expect(await store.migrate()).toBe(7);
    const { rows } = await store.pool.query('SELECT version FROM washtrace.schema_version');
    expect(rows).toEqual([{ version: 7 }]);
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
    await store.removeCollection(1, w('1a7e'));
  });

  it('stores a span and moves the cursor with it, queueing its wallets busiest first', async () => {
    const c = (await store.collection(1, collection))!;
    const ts = chain('1', a, b, a, b).map((t, i) => ({ ...t, blockTime: 1_700_000_000 + i, marketplace: i > 0 ? 'seaport-1.6' : null, priceWei: i > 0 ? '1000000000000000000' : null, currency: i > 0 ? '' : null }));
    await store.ingest(c.id, 1, ts, 200, [a, b, a, b, a, b, x]);
    // Read twice: a replayed span is a no-op, not a duplicate.
    await store.ingest(c.id, 1, ts, 200, []);
    const after = (await store.collection(1, collection))!;
    expect(after).toMatchObject({ cursorBlock: 200, transfers: 4 });
    expect(await store.fundingLanes(1, 10)).toEqual({ lanes: [{ collectionId: c.id, wallets: [a, b] }] });
  });

  it('gives each collection its own lane of unchecked traders, a shared one in both', async () => {
    const other = (await store.addCollection(1, w('0be'), 'Other', 1)).id;
    const c = (await store.collection(1, collection))!;
    await store.ingest(other, 1, chain('2', b, w('o1')), 10, [b, w('o1')]);
    const { lanes } = await store.fundingLanes(1, 10);
    expect(lanes).toEqual([{ collectionId: c.id, wallets: [b, a] }, { collectionId: other, wallets: [b, w('o1')] }]);
    expect((await store.fundingLanes(1, 1)).lanes.map((l) => l.wallets.length)).toEqual([1, 1]);
    await store.removeCollection(1, w('0be'));
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
    await store.removeCollection(1, w('de5c'));
  });

  it('stores funding and takes the wallet off the queue', async () => {
    await store.fund(1, x, [flow(x, a), flow(x, b)], false);
    expect(await store.counterparties(1, x)).toHaveLength(2);
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
    await store.removeCollection(1, w('90e'));
    await expect(store.saveAnalysis(id, due.version, analyze(input([])), 1, null)).resolves.toBeUndefined();
    expect(await store.history(id)).toEqual([]);
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
    const worker = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0 }));
    worker.analyzeOff = async (i) => analyze(i);
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
      const { lanes } = await store.fundingLanes(1, 10);
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
});
