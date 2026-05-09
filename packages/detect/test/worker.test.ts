import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUDGET_MS, ingestTurns, interleave, MIN_SLICE_MS, needsRestore, needsTrail, nextAnalysis, Worker, type WorkerConfig } from '../src/worker.js';
import { HttpRequestError } from 'viem';
import { Chain } from '../src/chain.js';
import { workerConfig } from '../src/env.js';
import { ETHERSCAN_V2, Etherscan } from '../src/etherscan.js';
import { StoredDataError, trailPath, type StoredEntry } from '../src/stored.js';
import type { CollectionRow, StaleRow } from '../src/store.js';
import { ANALYZE_TIMEOUT_MS, analyzeInThread, type AnalysisRequest } from '../src/analysis-thread.js';
import type { Analysis } from '../src/types.js';

/**
 * Every analysis thread made in this file, which never answers: the real one
 * runs only compiled (see analyzeInThread). Every other test overrides
 * analyzeOff, so none starts one.
 */
const threads = vi.hoisted(() => [] as { terminated: boolean }[]);
vi.mock('node:worker_threads', async (original) => ({
  ...(await original<typeof import('node:worker_threads')>()),
  Worker: class {
    terminated = false;
    private readonly on = new Map<string, (arg: unknown) => void>();
    constructor() { threads.push(this); }
    once(event: string, fn: (arg: unknown) => void) { this.on.set(event, fn); return this; }
    async terminate() { this.terminated = true; this.on.get('exit')?.(1); return 1; }
  },
}));

function row(more: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1, chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, cursorBlock: 995, headBlock: 1_000,
    addedAt: 0, ingestedAt: 0, error: null, errorAt: null, transfers: 10, wallets: 4, fundedWallets: 4,
    stale: false, latest: null, servedAt: null, readRate: null, priority: false, pausedAt: null, rules: {}, contract: null,
    restoreProgress: null, restoreNote: null, restoreNoteKey: null, restoreRetryAt: null, analysisError: null, analysisRetryAt: null, storedThroughTime: null, storedThroughBlock: null, trailImportedSha: null, trailNote: null, ...more,
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
    expect(needsRestore(row({ cursorBlock: null }), null, null)).toBe(false);
    expect(needsRestore(row({ cursorBlock: null, pausedAt: 5 }), ENTRY, null)).toBe(false);
    expect(needsRestore(row({ cursorBlock: 900 }), ENTRY, null)).toBe(false);
    expect(needsRestore(row({ cursorBlock: 950 }), ENTRY, null)).toBe(false);
    expect(needsRestore(row({ cursorBlock: null }), ENTRY, null)).toBe(true);
    expect(needsRestore(row({ cursorBlock: 899 }), ENTRY, null)).toBe(true);
    // Read up to just before the stored start: the stored data carries on from there.
    expect(needsRestore(row({ cursorBlock: 99 }), ENTRY, null)).toBe(true);
    // Stopped short of the stored start: loading would skip the blocks in between for good.
    expect(needsRestore(row({ cursorBlock: 50 }), ENTRY, null)).toBe(false);
  });

  it('skips a load the stored data failed only while the manifest and the file are as they were', () => {
    const noted = row({ cursorBlock: null, restoreNote: 'Stored data could not be loaded: its file is missing.', restoreNoteKey: 'abc:absent' });
    expect(needsRestore(noted, ENTRY, 'abc:absent')).toBe(false);
    // A new cut, the file put back, or its permissions fixed: tried again.
    expect(needsRestore(noted, ENTRY, 'abc:10:1700000000000:1700000000000')).toBe(true);
    // A note from before notes were keyed is tried once more.
    expect(needsRestore(row({ cursorBlock: null, restoreNote: 'Stored data could not be loaded: its file is missing.' }), ENTRY, 'abc:absent')).toBe(true);
  });

  it('takes the key every time, so no caller can leave it out and retry a noted load on every call', () => {
    // @ts-expect-error the key is required
    needsRestore(row(), ENTRY);
  });

  it('waits out the back-off after the store failed a load, then tries again', () => {
    const failed = row({ cursorBlock: null, restoreNote: 'Stored data could not be loaded.', restoreRetryAt: 2_000 });
    expect(needsRestore(failed, ENTRY, null, 1_999)).toBe(false);
    expect(needsRestore(failed, ENTRY, null, 2_000)).toBe(true);
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

  it('tries a load the stored data failed again once the file changes, keyed on the file it read, and not before', async () => {
    const noted = row({ cursorBlock: null, startBlock: null, restoreNote: 'Stored data could not be loaded: its file does not match the manifest.', restoreNoteKey: 'abc:1:2:3' });
    const { w, events, store } = setup([noted], [row({ cursorBlock: 900 })]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const keys: string[] = [];
    store.restore = async (_id: number, _chainId: number, _entry: StoredEntry, _batches: unknown, key: string) => { events.push('restore'); keys.push(key); };
    let key = 'abc:1:2:3';
    (w as any).restoreKey = async () => key;
    await w.ingest();
    expect(events).not.toContain('restore');
    key = 'abc:1:2:4';
    await w.ingest();
    expect(keys).toEqual(['abc:1:2:4']);
  });

  it('holds a back-off itself when the store could not record it (a full disk), and forgets it once a load goes through', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The row never shows the back-off: the write that records it failed too.
    const { w, events, store } = setup([row({ cursorBlock: null, startBlock: null })], [row({ cursorBlock: null, startBlock: null })]);
    let fail = true;
    store.restore = async () => { events.push('restore'); if (fail) throw Object.assign(new Error('could not extend file: No space left on device'), { code: '53100' }); };
    const tries = () => events.filter((e) => e === 'restore').length;
    await w.ingest();
    expect(tries()).toBe(1);
    await w.ingest();
    expect(tries()).toBe(1);
    // Analysed meanwhile on what it has, as a recorded back-off is.
    expect((w as any).restoreFailed.has(1)).toBe(true);
    now += 5 * 60_000;
    await w.ingest();
    expect(tries()).toBe(2);
    // Doubling: ten minutes after the second failure.
    now += 5 * 60_000;
    await w.ingest();
    expect(tries()).toBe(2);
    now += 5 * 60_000;
    fail = false;
    await w.ingest();
    expect(tries()).toBe(3);
    expect((w as any).restoreFailed.has(1)).toBe(false);
  });

  it('clears a note about stored data the collection no longer reaches for: read past it, or gone from the manifest', async () => {
    const cleared: number[] = [];
    const past = setup([row({ id: 1, cursorBlock: 950, restoreNote: 'Stored data could not be loaded.' })], []);
    past.store.clearRestoreNote = async (id: number) => { cleared.push(id); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await past.w.ingest();
    const gone = setup([row({ id: 2, cursorBlock: null, restoreNote: 'Stored data could not be loaded.' })], []);
    gone.store.clearRestoreNote = async (id: number) => { cleared.push(id); };
    (gone.w as any).manifest = async () => ({ version: 1, collections: [] });
    await gone.w.ingest();
    expect(cleared).toEqual([1, 2]);
    expect([...past.events, ...gone.events].filter((e) => e.startsWith('restore'))).toEqual([]);
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
    expect(interleave([{ collectionId: 1, wallets: ['a', 'b', 'c'] }, { collectionId: 2, wallets: ['b', 'd'] }, { collectionId: null, wallets: ['f'] }], new Set()))
      .toEqual(['a', 'b', 'f', 'c', 'd']);
  });

  it('gives the prioritised collection every other turn', () => {
    expect(interleave([{ collectionId: 1, wallets: ['a1', 'a2', 'a3'] }, { collectionId: 2, wallets: ['b1', 'b2'] }], new Set([2])))
      .toEqual(['b1', 'a1', 'b2', 'a2', 'a3']);
  });

  it('alternates the priority lane with each other lane in turn', () => {
    expect(interleave([{ collectionId: 1, wallets: ['p1', 'p2', 'p3'] }, { collectionId: 2, wallets: ['x1', 'x2'] }, { collectionId: 3, wallets: ['y1'] }], new Set([1])))
      .toEqual(['p1', 'x1', 'p2', 'y1', 'p3', 'x2']);
  });

  it('shares the priority turns among every prioritised collection, and the rest go on once they run dry', () => {
    expect(interleave([{ collectionId: 1, wallets: ['a1', 'a2', 'a3'] }, { collectionId: 2, wallets: ['b1', 'b2'] }, { collectionId: 3, wallets: ['c1', 'c2', 'c3', 'c4', 'c5'] }], new Set([1, 2])))
      .toEqual(['a1', 'c1', 'b1', 'c2', 'a2', 'c3', 'b2', 'c4', 'a3', 'c5']);
  });

  it('lets a priority lane that meets a wallet already taken take its own next one in the same turn', () => {
    expect(interleave([{ collectionId: 1, wallets: ['s', 'a2'] }, { collectionId: 2, wallets: ['s', 'b2'] }, { collectionId: 3, wallets: ['c1'] }], new Set([1, 2])))
      .toEqual(['s', 'c1', 'b2', 'a2']);
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

describe('Worker.fund priority', () => {
  it('boosts every prioritised collection on its own chain, not only the first one added', async () => {
    const funded: string[] = [];
    const lanes: Record<number, { collectionId: number; wallets: string[] }[]> = {
      8453: [{ collectionId: 1, wallets: ['a1'] }],
      1: [{ collectionId: 3, wallets: ['x1', 'x2'] }, { collectionId: 2, wallets: ['b1', 'b2'] }],
    };
    const store: any = {
      // The earliest prioritised is on Base: Doodles, on Ethereum, still gets its priority turns there.
      collections: async () => [row({ id: 1, chainId: 8453, name: 'Base one', priority: true }), row({ id: 2, name: 'Doodles', priority: true }), row({ id: 3, name: 'Azuki' })],
      fundingLanes: async (chainId: number) => ({ lanes: lanes[chainId] }),
      heartbeat: async () => {}, fundingFailed: async () => {},
      fund: async (_chain: number, wallet: string) => { funded.push(wallet); },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    expect(funded).toEqual(['a1', 'b1', 'x1', 'b2', 'x2']);
  });

  it('gives a paused collection\'s priority to no one, and a live prioritised one its turns', async () => {
    const funded: string[] = [];
    const store: any = {
      // Two prioritised, the first paused: its lane is not served (the store leaves it out), so its priority must not hide the other's.
      collections: async () => [row({ id: 1, name: 'BAYC', priority: true, pausedAt: 5 }), row({ id: 2, name: 'Doodles', priority: true }), row({ id: 3, name: 'Azuki' })],
      fundingLanes: async () => ({ lanes: [{ collectionId: 3, wallets: ['x1', 'x2'] }, { collectionId: 2, wallets: ['c1', 'c2'] }] }),
      heartbeat: async () => {}, fundingFailed: async () => {},
      fund: async (_chain: number, wallet: string) => { funded.push(wallet); },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    expect(funded).toEqual(['c1', 'x1', 'c2', 'x2']);
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

  it('keeps a pass alive from its start, before the job says what it is doing', async () => {
    vi.useFakeTimers();
    const beats: [string, string | null, number | null][] = [];
    const store: any = {
      locked: async (_key: number, _wait: boolean, fn: () => Promise<void>) => { await fn(); return 'ran'; },
      passStarted: async () => {}, passFinished: async () => {}, settings: async () => new Map(), reportSources: async () => {},
      heartbeat: async (job: string, doing: string | null, id: number | null) => { beats.push([job, doing, id]); },
    };
    const w = new Worker(store, config, '');
    // A first RPC call that takes a minute and a half, before ingest has said anything.
    (w as any).ingest = async () => { await new Promise((r) => setTimeout(r, 95_000)); return 'done'; };
    const pass = w.run('ingest');
    await vi.advanceTimersByTimeAsync(95_000);
    await pass;
    expect(beats).toEqual(Array(3).fill(['ingest', null, null]));
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

  it('tests Etherscan at the environment\'s address, never a console one, while the key is from the environment', async () => {
    const { store } = stub({
      locked: async (_key: number, _wait: boolean, fn: () => Promise<number>) => fn(),
      settings: async () => new Map([['etherscan.url', 'https://attacker.example/api']]),
      expireChecks: async () => 0,
      pendingChecks: async () => [{ id: 1, kind: 'etherscan', chainId: null }],
      finishCheck: async () => {},
    });
    const w = new Worker(store, (s) => workerConfig({ WASHTRACE_ETHERSCAN_KEY: 'ENVKEY0123456789' }, s), '');
    const urls: string[] = [];
    w.etherscanClient = (config) => { urls.push(config!.etherscanUrl); return { ping: async () => {} } as unknown as Etherscan; };
    expect(await w.runChecks()).toBe(1);
    expect(urls).toEqual([ETHERSCAN_V2]);
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
  const s = (more: Partial<StaleRow> = {}): StaleRow => ({ id: 1, chainId: 1, version: 2, rules: {}, name: 'BAYC', ranAt: null, tookMs: null, rulesAt: null, retryAt: null, ...more });

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

  it('analyses a rule edited while the last run ran: that run read the rules it started with', () => {
    // Ran from 2 to 10 minutes, so twice its length holds it to 26: the edit at 5 does not wait for that.
    expect(nextAnalysis([s({ ranAt: 10 * MIN, tookMs: 8 * MIN, rulesAt: 5 * MIN })], 11 * MIN)).not.toBeNull();
    // Edited before it started: that run had it.
    expect(nextAnalysis([s({ ranAt: 10 * MIN, tookMs: 8 * MIN, rulesAt: MIN })], 11 * MIN)).toBeNull();
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
      collections: async () => [],
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
      collections: async () => [],
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
      collections: async () => [],
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

describe('Worker.analyze when an analysis fails', () => {
  afterEach(() => vi.restoreAllMocks());

  const stale = (id: number, name: string): StaleRow => ({ id, chainId: 1, version: 1, rules: {}, name, ranAt: null, tookMs: null, rulesAt: null, retryAt: null });

  /**
   * Two never-analysed collections on a fake clock; BAYC's analysis throws
   * while `broken` says so. The store keeps a failure as Store.analysisFailed
   * does, timed by the first wait only: the doubling is the store's, tested there.
   */
  function setup() {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const waiting = new Map([[1, stale(1, 'BAYC')], [2, stale(2, 'Doodles')]]);
    const failed: [number, string][] = [];
    const store: any = {
      stale: async () => [...waiting.values()],
      collections: async () => [row({ id: 1 }), row({ id: 2, address: '0xd00d' })],
      heartbeat: async () => {}, importedFunding: async () => false,
      saveAnalysis: async (id: number) => { waiting.delete(id); },
      analysisFailed: async (id: number, error: string) => {
        failed.push([id, error]);
        waiting.set(id, { ...waiting.get(id)!, retryAt: now + 5 * 60_000 });
      },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), 'postgres://washtrace:hunter2@db:5432/washtrace');
    (w as any).manifest = async () => ({ version: 1, collections: [] });
    const tried: number[] = [];
    const state = { broken: true, error: 'out of memory' };
    w.analyzeOff = async (request) => {
      tried.push(request.id);
      if (request.id === 1 && state.broken) throw new Error(state.error);
      return { analysis: {} as Analysis, through: 7 };
    };
    const at = (ms: number) => { now = 1_000_000 + ms; };
    return { w, tried, state, at, waiting, failed, store };
  }

  it('keeps the failure on the collection, analyses the others meanwhile, and tries it again only once its wait is over', async () => {
    const { w, tried, at, failed } = setup();
    await expect(w.analyze()).rejects.toThrow('out of memory');
    expect(failed).toEqual([[1, 'out of memory']]);
    at(60_000);
    expect(await w.analyze()).toBe('Doodles analyzed');
    at(5 * 60_000 - 1);
    expect(await w.analyze()).toBe('nothing due');
    at(5 * 60_000);
    await expect(w.analyze()).rejects.toThrow('out of memory');
    expect(tried).toEqual([1, 2, 1]);
  });

  it('waits out a failure written before this worker started: the wait is the store\'s, not held in memory', async () => {
    const { w, tried, at, waiting } = setup();
    waiting.set(1, { ...stale(1, 'BAYC'), retryAt: 1_000_000 + 10 * 60_000 });
    expect(await w.analyze()).toBe('Doodles analyzed');
    expect(await w.analyze()).toBe('nothing due');
    at(10 * 60_000);
    await expect(w.analyze()).rejects.toThrow('out of memory');
    expect(tried).toEqual([2, 1]);
  });

  it('saves a success, which is what clears the failure', async () => {
    const { w, state, waiting, failed } = setup();
    waiting.delete(2);
    state.broken = false;
    expect(await w.analyze()).toBe('BAYC analyzed');
    expect(waiting.size).toBe(0);
    expect(failed).toEqual([]);
  });

  it('writes the failure scrubbed of the store\'s URL, and still fails the pass when the write fails too', async () => {
    const { w, state, failed, store, at, waiting } = setup();
    waiting.delete(2);
    state.error = 'connect ECONNREFUSED postgres://washtrace:hunter2@db:5432/washtrace';
    await expect(w.analyze()).rejects.toThrow('ECONNREFUSED');
    expect(failed[0]![1]).not.toContain('hunter2');
    expect(failed[0]![1]).not.toContain('postgres://');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.analysisFailed = async () => { throw new Error('disk full'); };
    at(5 * 60_000);
    await expect(w.analyze()).rejects.toThrow('ECONNREFUSED');
    expect(logged.mock.calls.flat().join(' ')).toContain('disk full');
  });

  it('does not analyse a collection whose stored data is still to load, and analyses it once loaded', async () => {
    const { w, tried, state, waiting } = setup();
    state.broken = false;
    waiting.delete(2);
    let cursor: number | null = null;
    (w as any).store.collections = async () => [row({ id: 1, cursorBlock: cursor, startBlock: cursor === null ? null : 100 })];
    (w as any).manifest = async () => ({ version: 1, collections: [ENTRY] });
    expect(await w.analyze()).toBe('nothing due');
    cursor = 900;
    expect(await w.analyze()).toBe('BAYC analyzed');
    expect(tried).toEqual([1]);
  });

  it('analyses a collection whose stored data failed to load on what it has, unless the load is due again', async () => {
    const { w, tried, state, waiting } = setup();
    state.broken = false;
    waiting.delete(2);
    let more: Partial<CollectionRow> = { restoreNote: 'Stored data could not be loaded.', restoreRetryAt: Date.now() + 60_000 };
    (w as any).store.collections = async () => [row({ id: 1, cursorBlock: 100, ...more })];
    (w as any).manifest = async () => ({ version: 1, collections: [ENTRY] });
    (w as any).restoreKey = async () => 'abc:absent';
    // Due again (the file changed): held, so it is analysed once, after the load.
    more = { restoreNote: 'Stored data could not be loaded: its file is missing.', restoreNoteKey: 'abc:1:2:3' };
    expect(await w.analyze()).toBe('nothing due');
    // Backing off, or noted on the file as it is: analysed on what it has.
    more = { restoreNote: 'Stored data could not be loaded.', restoreRetryAt: Date.now() + 60_000 };
    expect(await w.analyze()).toBe('BAYC analyzed');
    more = { restoreNote: 'Stored data could not be loaded: its file is missing.', restoreNoteKey: 'abc:absent' };
    waiting.set(1, stale(1, 'BAYC'));
    expect(await w.analyze()).toBe('BAYC analyzed');
    // A back-off held in memory, its write lost: analysed on what it has too.
    more = {};
    (w as any).restoreFailed.set(1, { failures: 1, retryAt: Date.now() + 60_000 });
    waiting.set(1, stale(1, 'BAYC'));
    expect(await w.analyze()).toBe('BAYC analyzed');
    expect(tried).toEqual([1, 1, 1]);
  });
});

describe('an analysis that never ends', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const request = { storeUrl: '', id: 1, chainId: 1, rules: {}, fundingAvailable: false, custodians: new Set(), contracts: new Set(), money: new Set() } as AnalysisRequest;
  const STOPPED = 'Analysis took longer than 60 min and was stopped.';

  it('is stopped after an hour: its thread is ended, and it rejects in words', async () => {
    vi.useFakeTimers();
    const outcome = analyzeInThread(request).then(() => 'answered', (err: Error) => err.message);
    const thread = threads.at(-1)!;
    await vi.advanceTimersByTimeAsync(ANALYZE_TIMEOUT_MS - 1);
    expect(thread.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe(STOPPED);
    expect(thread.terminated).toBe(true);
  });

  it('counts as a failed analysis, kept on the collection', async () => {
    vi.useFakeTimers();
    const failed: [number, string][] = [];
    const store: any = {
      stale: async () => [{ id: 1, chainId: 1, version: 1, rules: {}, name: 'Terraforms', ranAt: null, tookMs: null, rulesAt: null, retryAt: null }],
      collections: async () => [], heartbeat: async () => {}, importedFunding: async () => false, saveAnalysis: async () => {},
      analysisFailed: async (id: number, error: string) => { failed.push([id, error]); },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '');
    (w as any).manifest = async () => ({ version: 1, collections: [] });
    const outcome = w.analyze().then(() => 'saved', (err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(ANALYZE_TIMEOUT_MS);
    expect(await outcome).toBe(STOPPED);
    expect(failed).toEqual([[1, STOPPED]]);
  });
});

describe('Worker checks with no notification', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** A worker whose listener connects to nothing: `pending` is what the store has waiting, `connects` counts each listen. */
  function setup(pending: { id: number; kind: 'rpc'; chainId: number; ageMs: number }[]) {
    const finished: number[] = [];
    const store: any = {
      locked: async (_key: number, _wait: boolean, fn: () => Promise<number>) => fn(),
      settings: async () => new Map(), expireChecks: async () => 0,
      pendingChecks: async () => pending.filter((c) => !finished.includes(c.id)),
      finishCheck: async (id: number) => { finished.push(id); },
    };
    const w = new Worker(store, () => ({ rpc: new Map([[1, 'http://rpc']]), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, sources: {} }), '');
    (w as any).chain = () => ({ check: async () => ({ finalized: 1, archive: true, logs: true }) });
    const connects = { n: 0 };
    // Connected, and hearing nothing: as a socket a NAT dropped without a word.
    (w as any).connectListener = async () => { connects.n += 1; (w as any).listener = { end: async () => {} }; };
    return { w, finished, connects, store };
  }

  it('does not take the listener for deaf while another replica holds the checks', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { w, connects, store } = setup([{ id: 1, kind: 'rpc', chainId: 1, ageMs: 25_000 }]);
    // Another replica is on a slow check: this one heard the request, and skips.
    store.locked = async () => 'skipped';
    await w.listen();
    expect(await w.runChecks()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connects.n).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    w.stop();
  });

  it('runs no checks from a sweep that was in flight when the worker stopped', async () => {
    vi.useFakeTimers();
    const { w, store } = setup([{ id: 1, kind: 'rpc', chainId: 1, ageMs: 2_000 }]);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const pending = store.pendingChecks;
    // The sweep's look at what waits is slow; the worker stops meanwhile.
    store.pendingChecks = async () => { await held; return pending(); };
    let runs = 0;
    store.locked = async (_key: number, _wait: boolean, fn: () => Promise<number>) => { runs += 1; return fn(); };
    await w.listen();
    await vi.advanceTimersByTimeAsync(30_000);
    w.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(0);
  });

  it('answers a pending check every 30 seconds, though no request was heard', async () => {
    vi.useFakeTimers();
    const { w, finished } = setup([{ id: 1, kind: 'rpc', chainId: 1, ageMs: 2_000 }]);
    await w.listen();
    expect(finished).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toEqual([1]);
    w.stop();
  });

  it('listens again when a check waited longer than a notification takes, and not when none did', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = setup([{ id: 1, kind: 'rpc', chainId: 1, ageMs: 2_000 }]);
    await fresh.w.listen();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fresh.connects.n).toBe(1);
    fresh.w.stop();
    const deaf = setup([{ id: 1, kind: 'rpc', chainId: 1, ageMs: 25_000 }]);
    await deaf.w.listen();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deaf.connects.n).toBe(2);
    expect(deaf.finished).toEqual([1]);
    expect(warn).toHaveBeenCalledTimes(1);
    deaf.w.stop();
    // Stopped, the timer is gone.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deaf.connects.n).toBe(2);
  });
});

describe('Worker keeps secrets out of what it records and logs', () => {
  afterEach(() => vi.restoreAllMocks());

  // A key in the subdomain and another in the path, as providers issue them.
  const RPC = 'https://SUBKEY0123456789.rpc.example/v2/PATHKEY0123456789';
  const RPC_LEAKS = ['SUBKEY0123456789', 'PATHKEY0123456789'];
  // A funding API on a URL of its own that carries a key in its query, as some do, beside the Etherscan key.
  const ES_URL = 'https://explorer.example/api?apikey=URLKEY0123456789';
  const ES_KEY = 'ESKEY0123456789';
  const ES_LEAKS = ['URLKEY0123456789', ES_KEY];
  const config = (): WorkerConfig => ({ rpc: new Map([[1, RPC]]), etherscanKey: ES_KEY, etherscanPerSecond: 1_000, etherscanUrl: ES_URL, followHops: 0, sources: {} });

  /** Everything the console was asked to print, as text. */
  const printed = (...spies: { mock: { calls: unknown[][] } }[]) => spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');

  it('records and logs a failed RPC read without the RPC URL or any part of its key', async () => {
    const errors: (string | null)[] = [];
    const store: any = {
      collections: async () => [row({ contract: {} as any })],
      setError: async (_id: number, message: string | null) => { errors.push(message); },
      setHead: async () => {}, heartbeat: async () => {}, served: async () => {},
    };
    const w = new Worker(store, config, '');
    (w as any).manifest = async () => ({ version: 1, collections: [] });
    // The real chain client, whose provider refuses: viem puts "URL: <the RPC URL>" in the message.
    (w as any).chain = (chainId: number, url: string) => {
      const c = new Chain(chainId, url);
      Object.assign(c.client, { getBlock: async () => { throw new HttpRequestError({ url, status: 401, details: 'no such key at SUBKEY0123456789.rpc.example' }); } });
      return c;
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await w.ingest();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^HTTP request failed\./);
    for (const leak of RPC_LEAKS) {
      expect(errors[0]).not.toContain(leak);
      expect(printed(logged)).not.toContain(leak);
    }
    expect(printed(logged)).toContain('HTTP request failed');
  });

  it('logs a contract that could not be described without the RPC URL', async () => {
    const store: any = {
      collections: async () => [row({ contract: null, cursorBlock: 1_000 })],
      setError: async () => {}, setHead: async () => {}, heartbeat: async () => {}, served: async () => {},
    };
    const w = new Worker(store, config, '');
    (w as any).manifest = async () => ({ version: 1, collections: [] });
    (w as any).chain = () => ({
      finalized: async () => 1_000,
      describe: async () => { throw new HttpRequestError({ url: RPC, status: 429, details: `rate limited: ${RPC}` }); },
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await w.ingest();
    expect(printed(warned)).toContain('not described yet');
    for (const leak of RPC_LEAKS) expect(printed(warned)).not.toContain(leak);
  });

  it('records a wallet whose funding read failed without the Etherscan key or URL', async () => {
    const failed: string[] = [];
    const store: any = {
      collections: async () => [row({ id: 1 })],
      fundingLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b'] }] }),
      heartbeat: async () => {},
      fundingFailed: async (_chain: number, _wallet: string, message: string) => { failed.push(message); },
    };
    const w = new Worker(store, config, '');
    const etherscan = new Etherscan(ES_KEY, 1_000, ES_URL);
    let calls = 0;
    // A client that puts the request URL in its error, and an API that echoes the key it was sent.
    etherscan.fetch = async (url: URL) => {
      if (++calls === 1) throw new TypeError(`fetch failed: ${url.toString()}`);
      return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: `Invalid API Key ${ES_KEY}` }));
    };
    (w as any).etherscanClient = () => etherscan;
    expect(await w.fund()).toBe('0 wallets read, 2 failed');
    expect(failed).toHaveLength(2);
    expect(failed[1]).toContain('Invalid API Key');
    for (const leak of ES_LEAKS) expect(failed.join('\n')).not.toContain(leak);
  });

  it('keeps the word Etherscan in an Etherscan error on its default URL, and still hides the key', async () => {
    const failed: string[] = [];
    const store: any = {
      collections: async () => [row({ id: 1 })],
      fundingLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b'] }] }),
      heartbeat: async () => {},
      fundingFailed: async (_chain: number, _wallet: string, message: string) => { failed.push(message); },
    };
    const w = new Worker(store, () => ({ ...config(), etherscanUrl: ETHERSCAN_V2 }), '');
    const etherscan = new Etherscan(ES_KEY, 1_000, ETHERSCAN_V2);
    let calls = 0;
    etherscan.fetch = async () => ++calls === 1
      ? new Response('', { status: 403 })
      : new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: `Invalid API Key ${ES_KEY}` }));
    (w as any).etherscanClient = () => etherscan;
    await w.fund();
    expect(failed).toEqual(['Etherscan answered HTTP 403', 'Etherscan refused txlist: Invalid API Key [hidden]']);
  });

  it('records and logs a failed pass without any configured secret', async () => {
    const details: string[] = [];
    const store: any = {
      locked: async (_key: number, _wait: boolean, fn: () => Promise<void>) => { await fn(); return 'ran'; },
      settings: async () => new Map(), reportSources: async () => {},
      passStarted: async () => {}, passFinished: async (_job: string, _ms: number, _outcome: string, detail: string) => { details.push(detail); },
      heartbeat: async () => {},
      collections: async () => { throw new Error(`lost ${RPC} and ${ES_URL}&key=${ES_KEY}`); },
    };
    const w = new Worker(store, config, '');
    (w as any).etherscanClient = () => ({});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await w.run('fund');
    expect(details).toHaveLength(1);
    for (const leak of [...RPC_LEAKS, ...ES_LEAKS]) {
      expect(details[0]).not.toContain(leak);
      expect(printed(logged)).not.toContain(leak);
    }
  });

  it('hides a key from settings since replaced, in a pass and in a Test', async () => {
    // An old provider's error can arrive after the URL is replaced mid-pass, echoing the old key without a scheme.
    let rpc = 'https://OLDKEY0123456789.rpc.example';
    const store: any = { settings: async () => new Map([['rpc.1', rpc]]), reportSources: async () => {} };
    const w = new Worker(store, (s) => workerConfig({}, s), '');
    await (w as any).loadSettings();
    rpc = 'https://NEWKEY0123456789.rpc.example';
    await (w as any).loadSettings();
    const echo = () => new Error('no such key at OLDKEY0123456789.rpc.example');
    const said: string = (w as any).scrubbed(echo());
    expect(said).toContain('no such key');
    expect(said).not.toContain('OLDKEY0123456789');
    (w as any).chain = () => ({ check: async () => { throw echo(); } });
    const { detail } = await (w as any).runCheck({ kind: 'rpc', chainId: 1 }, workerConfig({}, await store.settings()));
    expect(detail.error).toContain('no such key');
    expect(detail.error).not.toContain('OLDKEY0123456789');
  });
});
