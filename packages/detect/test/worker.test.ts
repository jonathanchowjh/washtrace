import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUDGET_MS, ingestTurns, interleave, MIN_SLICE_MS, nextAnalysis, Worker, type WorkerConfig } from '../src/worker.js';
import type { CollectionRow, StaleRow } from '../src/store.js';
import type { Analysis } from '../src/types.js';

function row(more: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1, chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, cursorBlock: 995, headBlock: 1_000,
    addedAt: 0, ingestedAt: 0, error: null, errorAt: null, transfers: 10, wallets: 4, fundedWallets: 4,
    stale: false, latest: null, servedAt: null, readRate: null, priority: false, rules: {}, contract: null, ...more,
  };
}

describe('ingestTurns', () => {
  it('serves collections at the head first, then splits the rest across backfills', () => {
    const live = row({ id: 1, cursorBlock: 995, headBlock: 1_000 });
    const old = row({ id: 2, cursorBlock: 10, headBlock: 1_000, servedAt: 5 });
    const fresh = row({ id: 3, cursorBlock: 10, headBlock: 1_000, servedAt: null });
    const t = ingestTurns([old, live, fresh], 45_000);
    expect(t.keepUp.map((c) => c.id)).toEqual([1]);
    expect(t.backfill.map((b) => [b.c.id, b.sliceMs])).toEqual([[3, 22_500], [2, 22_500]]);
  });

  it('never slices thinner than MIN_SLICE_MS; the rest wait for the next pass', () => {
    const many = [1, 2, 3, 4, 5, 6].map((id) => row({ id, cursorBlock: 0, headBlock: 1_000, servedAt: id }));
    const slices = ingestTurns(many, 45_000).backfill.map((b) => b.sliceMs);
    expect(slices).toEqual([11_250, 11_250, 11_250, 11_250]);
    expect(Math.min(...slices)).toBeGreaterThanOrEqual(MIN_SLICE_MS);
  });

  it('treats a collection with no start block as a backfill', () => {
    expect(ingestTurns([row({ startBlock: null, cursorBlock: null })], 45_000).backfill).toHaveLength(1);
  });
});

describe('Worker.ingest', () => {
  afterEach(() => vi.restoreAllMocks());

  const config: WorkerConfig = { rpc: new Map([[1, 'http://rpc']]), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0 };

  /** A worker on a stub store and a chain whose every span takes `spanMs` of a fake clock. */
  function setup(rows: CollectionRow[], spanMs: number) {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const started: { id: number; at: number }[] = [];
    const served: { id: number; blocks: number }[] = [];
    const store: any = {
      collections: async () => rows,
      setHead: async () => {}, setStart: async () => {}, setError: async () => {}, heartbeat: async () => {},
      ingest: async () => {},
      served: async (id: number, blocks: number) => { served.push({ id, blocks }); },
    };
    const w = new Worker(store, () => config);
    (w as any).chain = () => ({
      finalized: async () => 1_000,
      transfers: async (address: string, from: number) => {
        started.push({ id: Number(address), at: now });
        now += spanMs;
        return { transfers: [], through: Math.min(from + 9, 1_000) };
      },
    });
    return { w, started, served, t0: now };
  }

  const at = (id: number, more: Partial<CollectionRow>) => row({ id, address: String(id), contract: {} as any, ...more });

  it('reads keep-up collections before backfills and starts no span after the pass deadline', async () => {
    const { w, started, t0 } = setup([
      at(2, { cursorBlock: 10, servedAt: null }),
      at(1, { cursorBlock: 950 }),
    ], 30_000);
    await w.ingest();
    expect(started[0]?.id).toBe(1);
    expect(started.every((s) => s.at < t0 + BUDGET_MS)).toBe(true);
    expect(started.map((s) => s.id)).toEqual([1, 1]);
  });

  it('still serves a failing collection, for the blocks it moved', async () => {
    const { w, served } = setup([at(1, { cursorBlock: 10 })], 1_000);
    let calls = 0;
    const real = (w as any).chain();
    (w as any).chain = () => ({ ...real, transfers: async (a: string, f: number) => { if (++calls === 2) throw new Error('rpc down'); return real.transfers(a, f); } });
    await w.ingest();
    expect(served).toEqual([{ id: 1, blocks: 10 }]);
  });
});

describe('interleave', () => {
  it('takes one wallet from each lane in turn and checks a shared one once', () => {
    expect(interleave([{ collectionId: 1, wallets: ['a', 'b', 'c'] }, { collectionId: 2, wallets: ['b', 'd'] }, { collectionId: null, wallets: ['f'] }], null))
      .toEqual(['a', 'b', 'f', 'c', 'd']);
  });

  it('gives the prioritised collection every other turn', () => {
    expect(interleave([{ collectionId: 1, wallets: ['a1', 'a2', 'a3'] }, { collectionId: 2, wallets: ['b1', 'b2'] }], 2))
      .toEqual(['b1', 'a1', 'b2', 'a2', 'a3']);
  });

  it('alternates the priority lane with each other lane in turn', () => {
    expect(interleave([{ collectionId: 1, wallets: ['p1', 'p2', 'p3'] }, { collectionId: 2, wallets: ['x1', 'x2'] }, { collectionId: 3, wallets: ['y1'] }], 1))
      .toEqual(['p1', 'x1', 'p2', 'y1', 'p3', 'x2']);
  });
});

describe('Worker.fund', () => {
  afterEach(() => vi.restoreAllMocks());

  it('checks wallets in turn across collections and says whose it is checking', async () => {
    const beats: (string | null)[] = [];
    const funded: string[] = [];
    const store: any = {
      collections: async () => [row({ id: 1, name: 'BAYC' }), row({ id: 2, name: 'Doodles', priority: true })],
      fundingLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b'] }, { collectionId: 2, wallets: ['c'] }, { collectionId: null, wallets: ['f'] }] }),
      heartbeat: async (_job: string, doing: string | null) => { beats.push(doing); },
      fund: async (_chain: number, wallet: string) => { funded.push(wallet); },
      fundingFailed: async () => {},
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0 }));
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    expect(await w.fund()).toBe('4 wallets read, 0 failed');
    expect(funded).toEqual(['c', 'a', 'f', 'b']);
    expect(beats).toEqual(['Checking wallets for Doodles', 'Checking wallets for BAYC', 'Checking wallets for followed wallets', 'Checking wallets for BAYC']);
  });
});

describe('nextAnalysis', () => {
  const MIN = 60_000;
  const s = (more: Partial<StaleRow> = {}): StaleRow => ({ id: 1, chainId: 1, version: 2, rules: {}, name: 'BAYC', ranAt: null, tookMs: null, ...more });

  it('analyses a never-analysed collection first', () => {
    expect(nextAnalysis([s({ id: 2, ranAt: 0, tookMs: 1 }), s({ id: 9, ranAt: null, tookMs: null })], 10 * MIN)!.id).toBe(9);
  });

  it('waits five minutes, or twice the last run if longer', () => {
    expect(nextAnalysis([s({ ranAt: 0, tookMs: 1_000 })], 4 * MIN)).toBeNull();
    expect(nextAnalysis([s({ ranAt: 0, tookMs: 1_000 })], 5 * MIN)).not.toBeNull();
    expect(nextAnalysis([s({ ranAt: 0, tookMs: 17 * MIN })], 30 * MIN)).toBeNull();
  });

  it('takes the longest waiting among those due', () => {
    expect(nextAnalysis([s({ id: 1, ranAt: 2 * MIN, tookMs: 1 }), s({ id: 2, ranAt: MIN, tookMs: 1 }), s({ id: 3, ranAt: 0, tookMs: 60 * MIN })], 10 * MIN)!.id).toBe(2);
  });
});

describe('Worker.analyze', () => {
  it('analyses one collection a pass, off the main thread, and says which', async () => {
    const beats: [string | null, number | null][] = [];
    const saved: number[] = [];
    const store: any = {
      stale: async () => [
        { id: 1, chainId: 1, version: 3, rules: {}, name: 'BAYC', ranAt: Date.now(), tookMs: 10 },
        { id: 2, chainId: 1, version: 5, rules: {}, name: 'Doodles', ranAt: null, tookMs: null },
      ],
      analysisInput: async () => ({ transfers: [], flows: [], funded: new Set(), truncated: new Set(), through: 7 }),
      heartbeat: async (_job: string, doing: string | null, subjectId: number | null) => { beats.push([doing, subjectId]); },
      saveAnalysis: async (id: number) => { saved.push(id); },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0 }));
    const off: number[] = [];
    w.analyzeOff = async (input) => { off.push(input.transfers.length); return {} as Analysis; };
    expect(await w.analyze()).toBe('Doodles analyzed');
    expect(off).toEqual([0]);
    expect(saved).toEqual([2]);
    expect(beats).toEqual([['Analyzing Doodles', 2]]);

    store.stale = async () => [{ id: 1, chainId: 1, version: 3, rules: {}, name: 'BAYC', ranAt: Date.now(), tookMs: 10 }];
    expect(await w.analyze()).toBe('nothing due');
  });
});
