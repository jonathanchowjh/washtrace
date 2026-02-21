import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUDGET_MS, ingestTurns, interleave, MIN_SLICE_MS, needsRestore, needsTrail, nextAnalysis, Worker, type WorkerConfig } from '../src/worker.js';
import { StoredDataError, trailPath, type StoredEntry } from '../src/stored.js';
import type { CollectionRow, StaleRow } from '../src/store.js';
import type { AnalysisRequest } from '../src/analysis-thread.js';
import type { Analysis } from '../src/types.js';

function row(more: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1, chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, cursorBlock: 995, headBlock: 1_000,
    addedAt: 0, ingestedAt: 0, error: null, errorAt: null, transfers: 10, wallets: 4, fundedWallets: 4,
    stale: false, latest: null, servedAt: null, readRate: null, priority: false, pausedAt: null, rules: {}, contract: null,
    restoreProgress: null, restoreNote: null, storedThroughTime: null, storedThroughBlock: null, trailImportedSha: null, trailNote: null, ...more,
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

  it('leaves out a paused collection, at the head or behind', () => {
    const t = ingestTurns([row({ id: 1, pausedAt: 5 }), row({ id: 2, cursorBlock: 10, pausedAt: 5 }), row({ id: 3 })], 45_000);
    expect(t.keepUp.map((c) => c.id)).toEqual([3]);
    expect(t.backfill).toEqual([]);
  });

  it('treats a collection with no start block as a backfill', () => {
    expect(ingestTurns([row({ startBlock: null, cursorBlock: null })], 45_000).backfill).toHaveLength(1);
  });
});

describe('Worker.ingest', () => {
  afterEach(() => vi.restoreAllMocks());

  const config: WorkerConfig = { rpc: new Map([[1, 'http://rpc']]), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} };

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
    const w = new Worker(store, () => config, '');
    (w as any).manifest = async () => ({ version: 1, collections: [] });
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

  it('says where to set a missing RPC: Settings for Ethereum, the environment for other chains', async () => {
    const { w } = setup([at(1, { chainId: 1 }), at(2, { chainId: 8453 })], 1_000);
    const errors = new Map<number, string>();
    (w as any).store.setError = async (id: number, message: string) => { errors.set(id, message); };
    (w as any).config = () => ({ ...config, rpc: new Map() });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await w.ingest();
    expect(errors.get(1)).toBe('No RPC is configured for chain 1. Set it in Settings, or WASHTRACE_RPC_1 for the worker.');
    expect(errors.get(2)).toBe('No RPC is configured for chain 8453. Set WASHTRACE_RPC_8453 for the worker.');
  });

  it('leaves a collection with stored data and no RPC alone, and clears a "No RPC" error already recorded', async () => {
    const { w, started, served } = setup([at(1, { storedThroughTime: 1_700_000_000_000, error: 'No RPC is configured for chain 1.' })], 1_000);
    const errors = new Map<number, string | null>();
    (w as any).store.setError = async (id: number, message: string | null) => { errors.set(id, message); };
    (w as any).config = () => ({ ...config, rpc: new Map() });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await w.ingest();
    expect(errors.has(1)).toBe(true);
    expect(errors.get(1)).toBeNull();
    expect(logged).not.toHaveBeenCalled();
    expect(started).toEqual([]);
    expect(served).toEqual([]);
  });

  it('writes nothing for a collection with stored data and no RPC whose error is already clear', async () => {
    const { w } = setup([at(1, { storedThroughTime: 1_700_000_000_000 })], 1_000);
    const calls: number[] = [];
    (w as any).store.setError = async (id: number) => { calls.push(id); };
    (w as any).config = () => ({ ...config, rpc: new Map() });
    await w.ingest();
    expect(calls).toEqual([]);
  });

  it('gives a stored-only collection no slice of the budget, so the real backfill gets all of it', async () => {
    // Both behind the head: the stored-only one on a chain with no RPC, the other reading Ethereum.
    const { w, started } = setup([
      at(2, { chainId: 8453, cursorBlock: 10, servedAt: null, storedThroughTime: 1_700_000_000_000 }),
      at(1, { cursorBlock: 10, servedAt: 5 }),
    ], 1_000);
    await w.ingest();
    // One span a second over a 45 s budget: about 45 spans alone, about 22 in half a budget.
    expect(started.filter((s) => s.id === 1).length).toBeGreaterThanOrEqual(40);
    expect(started.some((s) => s.id === 2)).toBe(false);
  });
});

const ENTRY: StoredEntry = {
  chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, throughBlock: 900, throughTime: 1_700_000_000_000,
  transfers: { file: '1-0xbc4c.transfers.csv.zst', rows: 3, bytes: 10, sha256: 'abc' }, trail: null,
};

describe('needsRestore', () => {
  it('restores a watched collection whose stored data reaches past its cursor, and nothing else', () => {
    expect(needsRestore(row({ cursorBlock: null }), null)).toBe(false);
    expect(needsRestore(row({ cursorBlock: null, pausedAt: 5 }), ENTRY)).toBe(false);
    expect(needsRestore(row({ cursorBlock: null, restoreNote: 'Stored data could not be loaded (x); reading from the chain instead.' }), ENTRY)).toBe(false);
    expect(needsRestore(row({ cursorBlock: 900 }), ENTRY)).toBe(false);
    expect(needsRestore(row({ cursorBlock: 950 }), ENTRY)).toBe(false);
    expect(needsRestore(row({ cursorBlock: null }), ENTRY)).toBe(true);
    expect(needsRestore(row({ cursorBlock: 899 }), ENTRY)).toBe(true);
    // Read up to just before the stored start: the stored data carries on from there.
    expect(needsRestore(row({ cursorBlock: 99 }), ENTRY)).toBe(true);
    // Stopped short of the stored start: loading would skip the blocks in between for good.
    expect(needsRestore(row({ cursorBlock: 50 }), ENTRY)).toBe(false);
  });
});

describe('Worker.ingest restoring stored data', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A worker whose store says what happened, in order, and whose collections move to `after` once restored. */
  function setup(before: CollectionRow[], after: CollectionRow[], rpc: ReadonlyMap<number, string> = new Map()) {
    const events: string[] = [];
    let restored = false;
    const store: any = {
      collections: async () => { events.push('collections'); return restored ? after : before; },
      restore: async (id: number, chainId: number, entry: StoredEntry, batches: AsyncIterable<unknown>) => {
        events.push(`restore ${id} ${chainId} ${entry.address}`);
        for await (const _ of batches) events.push('batch');
        restored = true;
      },
      heartbeat: async (_job: string, doing: string | null, subjectId: number | null) => { events.push(`beat ${doing} ${subjectId}`); },
      setError: async (id: number) => { events.push(`error ${id}`); },
      setHead: async () => {}, setStart: async () => {}, ingest: async () => {},
      served: async (id: number) => { events.push(`served ${id}`); },
    };
    const w = new Worker(store, () => ({ rpc, etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '');
    (w as any).manifest = async () => ({ version: 1, collections: [ENTRY] });
    (w as any).storedTransfers = async function* (e: StoredEntry) { events.push(`read ${e.transfers.file}`); yield []; };
    return { w, events, store };
  }

  it('loads stored data first, with no RPC at all, then serves the collection as it now is', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events } = setup([row({ cursorBlock: null, startBlock: null })], [row({ cursorBlock: 900 })]);
    await w.ingest();
    expect(events.slice(0, 6)).toEqual([
      'collections', 'beat Loading stored data for BAYC 1', 'restore 1 1 0xbc4c', 'read 1-0xbc4c.transfers.csv.zst', 'batch', 'collections',
    ]);
    // Only then is the missing RPC found, and said.
    expect(events.indexOf('error 1')).toBeGreaterThan(events.indexOf('restore 1 1 0xbc4c'));
  });

  it('never loads stored data for a paused collection', async () => {
    const { w, events } = setup([row({ cursorBlock: null, pausedAt: 5 })], []);
    await w.ingest();
    expect(events.filter((e) => e.startsWith('restore'))).toEqual([]);
  });

  it('goes on to read the chain when a load fails, and says so in the log', async () => {
    const { w, events, store } = setup([row({ cursorBlock: 100 })], []);
    store.restore = async () => { events.push('restore'); throw new Error('checksum differs'); };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    (w as any).chain = () => ({ finalized: async () => 1_000, transfers: async () => ({ transfers: [], through: 1_000 }) });
    (w as any).config = () => ({ rpc: new Map([[1, 'http://rpc']]), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} });
    await w.ingest();
    expect(events).toContain('restore');
    expect(events).toContain('served 1');
    expect(logged.mock.calls.some((c) => c.join(' ').includes('checksum differs'))).toBe(true);
  });

  it('reads the chain as before when the manifest cannot be read', async () => {
    const { w, events } = setup([row({ cursorBlock: null })], []);
    (w as any).manifest = async () => { throw new Error('not json'); };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await w.ingest();
    expect(events.filter((e) => e.startsWith('restore'))).toEqual([]);
    expect(events).toContain('error 1');
  });
});

describe('needsTrail', () => {
  const TRAILED: StoredEntry = { ...ENTRY, trail: { rows: 9, wallets: 3, checked: 1_612, of: 11_259, bytes: 157, sha256: 'feed' } };

  it('imports a trail on disk that matches the manifest and was not imported yet, and nothing else', () => {
    expect(needsTrail(row(), TRAILED, 'feed')).toBe('import');
    // Already loaded: once per file.
    expect(needsTrail(row({ trailImportedSha: 'feed' }), TRAILED, 'feed')).toBeNull();
    // A re-cut trail loads again.
    expect(needsTrail(row({ trailImportedSha: 'old' }), TRAILED, 'feed')).toBe('import');
    // No file, or a file that is not the one the manifest names: nothing to load.
    expect(needsTrail(row(), TRAILED, null)).toBeNull();
    expect(needsTrail(row(), TRAILED, 'beef')).toBeNull();
    // No trail in the manifest, no manifest entry, or a paused collection.
    expect(needsTrail(row(), ENTRY, 'feed')).toBeNull();
    expect(needsTrail(row(), null, 'feed')).toBeNull();
    expect(needsTrail(row({ pausedAt: 5 }), TRAILED, 'feed')).toBeNull();
  });
});

describe('Worker.ingest loading a money trail', () => {
  const TRAILED: StoredEntry = { ...ENTRY, trail: { rows: 9, wallets: 3, checked: 1_612, of: 11_259, bytes: 157, sha256: 'feed' } };
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'washtrace-trail-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  afterEach(() => vi.restoreAllMocks());

  /** A worker over a stub store that says what happened, in order, with a trail file on disk whose sha256 is `sha`. */
  async function setup(rows: CollectionRow[], sha: string, after: CollectionRow[] = rows) {
    await writeFile(trailPath(dir, TRAILED), 'trail');
    const events: string[] = [];
    let restored = false;
    const store: any = {
      collections: async () => { events.push('collections'); return restored ? after : rows; },
      restore: async () => { events.push('restore'); restored = true; },
      importTrail: async (id: number, chainId: number, sha256: string, open: () => AsyncIterable<unknown>) => {
        events.push(`import ${id} ${chainId} ${sha256}`);
        for await (const _ of open()) events.push('batch');
        return { wallets: 1, flows: 1 };
      },
      setTrailNote: async (id: number, note: string | null) => { events.push(`note ${id} ${note}`); },
      heartbeat: async (_job: string, doing: string | null) => { events.push(`beat ${doing}`); },
      setError: async () => {}, setHead: async () => {}, setStart: async () => {}, ingest: async () => {}, served: async () => {},
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '', dir);
    (w as any).manifest = async () => ({ version: 1, collections: [TRAILED] });
    (w as any).storedTransfers = async function* () { yield []; };
    const hashed: string[] = [];
    w.fileSha = async (path: string) => { hashed.push(path); return sha; };
    (w as any).storedTrail = async function* (path: string, sha256: string) { events.push(`read ${path.slice(dir.length + 1)} ${sha256}`); yield { wallets: [], flows: [] }; };
    return { w, events, store, hashed };
  }

  it('loads a matching trail on disk after any stored data, in the ingest pass, with no button', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events } = await setup([row({ cursorBlock: null, startBlock: null })], 'feed', [row({ cursorBlock: 900 })]);
    await w.ingest();
    const at = (e: string) => events.indexOf(e);
    expect(at('import 1 1 feed')).toBeGreaterThan(at('restore'));
    expect(events).toContain('beat Loading the money trail for BAYC');
    expect(events).toContain('read 1-0xbc4c.trail.csv.zst feed');
  });

  it('leaves a paused collection\'s trail alone, and one already imported', async () => {
    const paused = await setup([row({ pausedAt: 5 })], 'feed');
    await paused.w.ingest();
    expect(paused.events.some((e) => e.startsWith('import'))).toBe(false);
    const done = await setup([row({ trailImportedSha: 'feed' })], 'feed');
    await done.w.ingest();
    expect(done.events.some((e) => e.startsWith('import'))).toBe(false);
  });

  it('hashes a trail once while the file stays the same, and again once it changes', async () => {
    const { w, hashed } = await setup([row({ trailImportedSha: 'feed' })], 'feed');
    await w.ingest();
    await w.ingest();
    expect(hashed).toHaveLength(1);
    await writeFile(trailPath(dir, TRAILED), 'a longer trail');
    await w.ingest();
    expect(hashed).toHaveLength(2);
  });

  it('loads nothing from a trail that does not match the manifest, and says so once', async () => {
    const { w, events } = await setup([row()], 'beef');
    await w.ingest();
    expect(events.some((e) => e.startsWith('import'))).toBe(false);
    expect(events).toContain('note 1 Money trail on disk does not match the stored data, so it was not loaded.');
    // The note already says it: not written again.
    const noted = await setup([row({ trailNote: 'Money trail on disk does not match the stored data, so it was not loaded.' })], 'beef');
    await noted.w.ingest();
    expect(noted.events.some((e) => e.startsWith('note'))).toBe(false);
  });

  it('clears a note once the file it was about is gone', async () => {
    const { w, events } = await setup([row({ trailNote: 'Money trail on disk does not match the stored data, so it was not loaded.' })], 'feed');
    await rm(trailPath(dir, TRAILED));
    await w.ingest();
    expect(events).toContain('note 1 null');
  });

  it('clears a note once the manifest has no trail for the collection', async () => {
    const { w, events } = await setup([row({ trailNote: 'Money trail on disk could not be read, so it was not loaded.' })], 'feed');
    (w as any).manifest = async () => ({ version: 1, collections: [ENTRY] });
    await w.ingest();
    expect(events).toContain('note 1 null');
    // And none to clear: nothing written.
    const clean = await setup([row()], 'feed');
    (clean.w as any).manifest = async () => ({ version: 1, collections: [] });
    await clean.w.ingest();
    expect(clean.events.some((e) => e.startsWith('note'))).toBe(false);
  });

  it('clears a mismatch note once the file on disk matches the manifest again', async () => {
    const note = 'Money trail on disk does not match the stored data, so it was not loaded.';
    const { w, events } = await setup([row({ trailImportedSha: 'feed', trailNote: note })], 'feed');
    await w.ingest();
    expect(events).toContain('note 1 null');
    // No note, nothing to clear.
    const clean = await setup([row({ trailImportedSha: 'feed' })], 'feed');
    await clean.w.ingest();
    expect(clean.events.some((e) => e.startsWith('note'))).toBe(false);
  });

  it('notes a trail that cannot be read and does not try it again until the file changes', async () => {
    const { w, events, store } = await setup([row()], 'feed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.importTrail = async () => { events.push('import'); throw new StoredDataError('/data/1-0xbc4c.trail.csv.zst has a row of 3 fields, expected 8'); };
    await w.ingest();
    await w.ingest();
    expect(events.filter((e) => e === 'import')).toHaveLength(1);
    expect(events).toContain('note 1 Money trail on disk could not be read, so it was not loaded.');
    expect(logged.mock.calls.some((c) => c.join(' ').includes('has a row of 3 fields'))).toBe(true);
    await writeFile(trailPath(dir, TRAILED), 'a trail cut again');
    await w.ingest();
    expect(events.filter((e) => e === 'import')).toHaveLength(2);
  });

  it('writes no note when the store failed, and tries again next pass', async () => {
    const { w, events, store } = await setup([row()], 'feed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.importTrail = async () => { events.push('import'); throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); };
    await w.ingest();
    await w.ingest();
    expect(events.filter((e) => e === 'import')).toHaveLength(2);
    expect(events.some((e) => e.startsWith('note'))).toBe(false);
    expect(logged.mock.calls.some((c) => c.join(' ').includes('deadlock detected'))).toBe(true);
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
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    expect(await w.fund()).toBe('4 wallets read, 0 failed');
    expect(funded).toEqual(['c', 'a', 'f', 'b']);
    expect(beats).toEqual(['Checking wallets for Doodles', 'Checking wallets for BAYC', 'Checking wallets for followed wallets', 'Checking wallets for BAYC']);
  });
});

describe('Worker heartbeat', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const config = (): WorkerConfig => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} });

  it('does not fail a funding pass when the heartbeat write throws, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const funded: string[] = [];
    const store: any = {
      collections: async () => [row({ id: 1, name: 'BAYC' })],
      fundingLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b'] }] }),
      heartbeat: async () => { throw new Error('db down'); },
      fund: async (_chain: number, wallet: string) => { funded.push(wallet); },
      fundingFailed: async () => {},
    };
    const w = new Worker(store, config, '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    expect(await w.fund()).toBe('2 wallets read, 0 failed');
    expect(funded).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('re-beats the current doing every 30 seconds while a pass runs, and stops after it', async () => {
    vi.useFakeTimers();
    const beats: [string, string | null, number | null][] = [];
    const store: any = {
      locked: async (_key: number, _wait: boolean, fn: () => Promise<void>) => { await fn(); return 'ran'; },
      passStarted: async () => {}, passFinished: async () => {},
      heartbeat: async (job: string, doing: string | null, id: number | null) => { beats.push([job, doing, id]); },
    };
    const w = new Worker(store, config, '');
    (w as any).analyze = async () => {
      await (w as any).beat('analyze', 'Analyzing Terraforms', 7);
      await new Promise((r) => setTimeout(r, 95_000));
      return 'done';
    };
    const pass = w.run('analyze');
    await vi.advanceTimersByTimeAsync(95_000);
    await pass;
    expect(beats).toEqual(Array(4).fill(['analyze', 'Analyzing Terraforms', 7]));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beats).toHaveLength(4);
  });
});

describe('Worker settings', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A store whose pass runs at once, recording what the worker reported. */
  function stub(more: Record<string, unknown> = {}) {
    const reported: unknown[] = [];
    const store: any = {
      locked: async (_key: number, _wait: boolean, fn: () => Promise<void>) => { await fn(); return 'ran'; },
      passStarted: async () => {}, passFinished: async () => {}, heartbeat: async () => {},
      settings: async () => new Map([['follow.hops', '2']]),
      reportSources: async (s: unknown) => { reported.push(s); },
      ...more,
    };
    return { store, reported };
  }

  it('loads the console settings once a pass, gives them to config, and reports where each came from', async () => {
    let reads = 0;
    const { store, reported } = stub({ settings: async () => { reads += 1; return new Map([['follow.hops', '2']]); } });
    const seen: ReadonlyMap<string, string>[] = [];
    const sources = { 'follow.hops': { source: 'console' as const, value: '2' } };
    const w = new Worker(store, (s) => {
      seen.push(s);
      return { rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: Number(s.get('follow.hops') ?? 0), sources };
    }, '');
    let hops = -1;
    (w as any).analyze = async () => { hops = (w as any).config((w as any).settings).followHops; return 'done'; };
    expect(await w.run('analyze')).toBe('ran');
    expect(reads).toBe(1);
    expect(reported).toEqual([sources]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.get('follow.hops') === '2')).toBe(true);
    expect(hops).toBe(2);
    expect(await w.run('analyze')).toBe('ran');
    expect(reads).toBe(2);
  });

  it('still runs the pass, on the settings it had, when the store cannot give them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const finished: string[] = [];
    let reads = 0;
    const { store } = stub({
      settings: async () => { if (++reads > 1) throw new Error('db down'); return new Map([['follow.hops', '2']]); },
      passFinished: async (_job: string, _ms: number, outcome: string) => { finished.push(outcome); },
    });
    const seen: ReadonlyMap<string, string>[] = [];
    const w = new Worker(store, (s) => { seen.push(s); return { rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }; }, '');
    (w as any).analyze = async () => { (w as any).config((w as any).settings); return 'done'; };
    expect(await w.run('analyze')).toBe('ran');
    seen.length = 0;
    expect(await w.run('analyze')).toBe('ran');
    expect(await w.run('analyze')).toBe('ran');
    expect(finished).toEqual(['ok', 'ok', 'ok']);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.get('follow.hops') === '2')).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('settings not read');
  });

  it('still runs the pass when reporting sources fails, and says the report failed, once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const finished: string[] = [];
    const { store } = stub({
      reportSources: async () => { throw new Error('db down'); },
      passFinished: async (_job: string, _ms: number, outcome: string) => { finished.push(outcome); },
    });
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '');
    (w as any).analyze = async () => 'done';
    expect(await w.run('analyze')).toBe('ran');
    expect(await w.run('analyze')).toBe('ran');
    expect(finished).toEqual(['ok', 'ok']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('settings sources not reported');
  });
});

describe('nextAnalysis', () => {
  const MIN = 60_000;
  const s = (more: Partial<StaleRow> = {}): StaleRow => ({ id: 1, chainId: 1, version: 2, rules: {}, name: 'BAYC', ranAt: null, tookMs: null, rulesAt: null, ...more });

  it('analyses a never-analysed collection first', () => {
    expect(nextAnalysis([s({ id: 2, ranAt: 0, tookMs: 1 }), s({ id: 9, ranAt: null, tookMs: null })], 10 * MIN)!.id).toBe(9);
  });

  it('waits five minutes, or twice the last run if longer', () => {
    expect(nextAnalysis([s({ ranAt: 0, tookMs: 1_000 })], 4 * MIN)).toBeNull();
    expect(nextAnalysis([s({ ranAt: 0, tookMs: 1_000 })], 5 * MIN)).not.toBeNull();
    expect(nextAnalysis([s({ ranAt: 0, tookMs: 17 * MIN })], 30 * MIN)).toBeNull();
  });

  it('analyses a rule edit at once, without waiting out the gap', () => {
    expect(nextAnalysis([s({ ranAt: 0, tookMs: 1_000, rulesAt: MIN })], 2 * MIN)).not.toBeNull();
    // A rule edit older than the last run was already analysed: the gap applies.
    expect(nextAnalysis([s({ ranAt: MIN, tookMs: 1_000, rulesAt: 0 })], 2 * MIN)).toBeNull();
  });

  it('orders never analysed, then rule edits by oldest edit, then due by oldest run', () => {
    const rows = [
      s({ id: 1, ranAt: 0, tookMs: 1 }),
      s({ id: 2, ranAt: 9 * MIN, tookMs: 1, rulesAt: 9.5 * MIN }),
      s({ id: 3, ranAt: 8 * MIN, tookMs: 1, rulesAt: 8.5 * MIN }),
      s({ id: 4, ranAt: null }),
    ];
    const order: number[] = [];
    let left = rows;
    for (let pick = nextAnalysis(left, 10 * MIN); pick !== null; pick = nextAnalysis(left, 10 * MIN)) {
      order.push(pick.id);
      left = left.filter((r) => r !== pick);
    }
    expect(order).toEqual([4, 3, 2, 1]);
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
        { id: 1, chainId: 1, version: 3, rules: {}, name: 'BAYC', ranAt: Date.now(), tookMs: 10, rulesAt: null },
        { id: 2, chainId: 1, version: 5, rules: {}, name: 'Doodles', ranAt: null, tookMs: null, rulesAt: null },
      ],
      heartbeat: async (_job: string, doing: string | null, subjectId: number | null) => { beats.push([doing, subjectId]); },
      saveAnalysis: async (id: number) => { saved.push(id); },
      importedFunding: async () => false,
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '');
    const off: number[] = [];
    w.analyzeOff = async (request) => { off.push(request.id); return { analysis: {} as Analysis, through: 7 }; };
    expect(await w.analyze()).toBe('Doodles analyzed');
    expect(off).toEqual([2]);
    expect(saved).toEqual([2]);
    expect(beats).toEqual([['Analyzing Doodles', 2]]);

    store.stale = async () => [{ id: 1, chainId: 1, version: 3, rules: {}, name: 'BAYC', ranAt: Date.now(), tookMs: 10, rulesAt: null }];
    expect(await w.analyze()).toBe('nothing due');
  });

  it('runs the money lenses with no key when the chain has an imported money trail', async () => {
    const asked: number[] = [];
    let imported = true;
    const store: any = {
      stale: async () => [{ id: 2, chainId: 1, version: 5, rules: {}, name: 'Doodles', ranAt: null, tookMs: null, rulesAt: null }],
      heartbeat: async () => {}, saveAnalysis: async () => {},
      importedFunding: async (id: number) => { asked.push(id); return imported; },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '');
    const sent: AnalysisRequest[] = [];
    w.analyzeOff = async (request) => { sent.push(request); return { analysis: {} as Analysis, through: 7 }; };
    await w.analyze();
    imported = false;
    await w.analyze();
    // Asked of the collection, not its chain: another collection's trail is not this one's funding.
    expect(asked).toEqual([2, 2]);
    expect(sent.map((r) => r.fundingAvailable)).toEqual([true, false]);
  });

  it('gives the thread where the store is and which collection, never the flows', async () => {
    // No analysisInput here: the main thread must not read the input, only the thread.
    const saved: [number, number | null][] = [];
    const store: any = {
      stale: async () => [{ id: 2, chainId: 1, version: 5, rules: { minCycles: 3 }, name: 'Doodles', ranAt: null, tookMs: null, rulesAt: null }],
      heartbeat: async () => {},
      saveAnalysis: async (id: number, _version: number, _a: Analysis, _ms: number, through: number | null) => { saved.push([id, through]); },
    };
    const url = 'postgres://washtrace:secret@db:5432/washtrace';
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), url);
    const sent: AnalysisRequest[] = [];
    w.analyzeOff = async (request) => { sent.push(request); return { analysis: {} as Analysis, through: 7 }; };
    await w.analyze();
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('flows');
    expect(sent[0]).not.toHaveProperty('transfers');
    expect(Object.keys(sent[0]!).sort()).toEqual(['chainId', 'contracts', 'custodians', 'fundingAvailable', 'id', 'money', 'rules', 'storeUrl']);
    expect(sent[0]).toMatchObject({ storeUrl: url, id: 2, chainId: 1, rules: { minCycles: 3 }, fundingAvailable: true });
    // The block the analysis ran through comes back from the thread, which read it with the input.
    expect(saved).toEqual([[2, 7]]);
  });
});
