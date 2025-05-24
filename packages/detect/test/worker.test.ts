import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUDGET_MS, ingestTurns, MIN_SLICE_MS, Worker, type WorkerConfig } from '../src/worker.js';
import type { CollectionRow } from '../src/store.js';

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
