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

/** Tests clean up with this: removeCollection only deletes what is paused. */
async function drop(chainId: number, address: string): Promise<void> {
  await store.pause(chainId, address);
  await store.removeCollection(chainId, address);
}

describe('Store', () => {
  it('migrates, and migrating again changes nothing', async () => {
    expect(await store.migrate()).toBe(9);
    expect(await store.migrate()).toBe(9);
    const { rows } = await store.pool.query('SELECT version FROM washtrace.schema_version');
    expect(rows).toEqual([{ version: 9 }]);
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
    expect(await store.fundingLanes(1, 10)).toEqual({ lanes: [{ collectionId: c.id, wallets: [a, b] }] });
  });

  it('gives each collection its own lane of unchecked traders, a shared one in both', async () => {
    const other = (await store.addCollection(1, w('0be'), 'Other', 1)).id;
    const c = (await store.collection(1, collection))!;
    await store.ingest(other, 1, chain('2', b, w('o1')), 10, [b, w('o1')]);
    const { lanes } = await store.fundingLanes(1, 10);
    expect(lanes).toEqual([{ collectionId: c.id, wallets: [b, a] }, { collectionId: other, wallets: [b, w('o1')] }]);
    expect((await store.fundingLanes(1, 1)).lanes.map((l) => l.wallets.length)).toEqual([1, 1]);
    await drop(1, w('0be'));
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
    const { lanes } = await store.fundingLanes(1, 10);
    expect(lanes.map((l) => l.collectionId)).not.toContain(c1);
    expect(lanes.find((l) => l.collectionId === c2)!.wallets).toContain(s);
    expect((await store.stale()).map((r) => r.id)).not.toContain(c1);
    // With nothing in sync on the chain there are no lanes, the followed one included.
    await store.pool.query('UPDATE washtrace.collections SET paused_at = now()');
    expect((await store.fundingLanes(1, 10)).lanes).toEqual([]);
    expect(await store.resume(1, w('9c2'))).toBe(true);
    expect(await store.resume(1, w('9c2'))).toBe(false);
    await store.pool.query('UPDATE washtrace.collections SET paused_at = NULL');
    expect((await store.collection(1, w('9c2')))!.pausedAt).toBeNull();
    await drop(1, w('9c1'));
    await drop(1, w('9c2'));
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

  it('stores funding and takes the wallet off the queue', async () => {
    await store.fund(1, x, [flow(x, a), flow(x, b)], false);
    expect(await store.counterparties(1, x)).toHaveLength(2);
  });

  it('counts the wallets finished in the last hour, for the funding wait', async () => {
    const lastHour = async () => (await store.fundingBacklog()).find((r) => r.chainId === 1)!.doneLastHour;
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
    const worker = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), pg.getConnectionUri());
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
      expect(await store.pendingChecks()).toEqual([{ id, kind: 'rpc', chainId: 1 }, { id: other, kind: 'etherscan', chainId: null }]);
      await store.finishCheck(id, true, { finalized: 100, archive: true, logs: false });
      expect(await store.check(id)).toEqual({ finished: true, ok: true, detail: { finalized: 100, archive: true, logs: false } });
      expect(await store.pendingChecks()).toEqual([{ id: other, kind: 'etherscan', chainId: null }]);
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
        id, name: coll, startBlock: 1, throughBlock: 11, throughTime: 1_700_000_001_000,
      });
      expect(await all(store.storedTransfers(id, 11))).toEqual(ts.slice(0, 2));

      const paid = [flow(a, m), flow(b, a)], onward = [flow(m, b)];
      await store.fund(chainId, a, paid, false, { hops: 2, fanout: 3, exclude: [] });
      await store.fund(chainId, m, onward, false);
      const trail = await store.trail(id, chainId);
      // b is still unchecked: it counts in "of", and stays out of the file.
      expect({ checked: trail.checked, of: trail.of }).toEqual({ checked: 1, of: 2 });
      const wallets = await all(trail.wallets);
      expect(wallets.map((x) => [x.address, x.status, x.depth])).toEqual([[a, 'done', 0], [m, 'done', 1]]);
      expect(wallets.every((x) => typeof x.fetchedAt === 'number')).toBe(true);
      const byTx = (x: { txHash: string }, y: { txHash: string }) => x.txHash.localeCompare(y.txHash);
      expect((await all(trail.flows)).sort(byTx)).toEqual([...paid, ...onward].sort(byTx));
    });

    it('has nothing to cut for a collection it does not watch', async () => {
      expect(await store.storedHeader(chainId, w('404'))).toBeNull();
    });
  });
});
