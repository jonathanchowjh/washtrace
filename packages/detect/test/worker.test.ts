import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { COUNT_TIMEOUT_MS } from '../src/store.js';
import { BUDGET_MS, EVERY, TOKEN_COUNT_MS, ingestTurns, interleave, LENS_WAIT_MS, MIN_SLICE_MS, nextAnalysis, pickWork, SEED_MS, TOKENS_MS, Worker, type Work } from '../src/worker.js';
import { needsRestore, needsTrail, StoredSync, TRAIL_NOTES } from '../src/stored-sync.js';
import { HttpRequestError } from 'viem';
import { Chain } from '../src/chain.js';
import { workerConfig, type WorkerConfig } from '../src/env.js';
import { ETHERSCAN_V2, Etherscan, WALLET_MS } from '../src/etherscan.js';
import { DOWNLOAD_NOTES, StoredDataError, readManifest, storedFile, trailPaths, trailSha, writeManifest, type Manifest, type StoredEntry } from '../src/stored.js';
import { hubUrl, partPath } from '../src/hub.js';
import { LOCKS, type CollectionRow, type StaleRow } from '../src/store.js';
import type { LensRequest, PreviewRequest } from '../src/lens-thread.js';
import { ANALYZE_TIMEOUT_MS, analyzeInThread, type AnalysisRequest } from '../src/analysis-thread.js';
import { runLensInThread, runPreviewInThread } from '../src/lens-thread.js';
import type { Analysis } from '../src/types.js';

/**
 * Every analysis thread made in this file, which never answers: the real one
 * runs only compiled (see analyzeInThread). Every other test overrides
 * analyzeOff, so none starts one.
 */
const threads = vi.hoisted(() => [] as { terminated: boolean; terminate(): Promise<number> }[]);
vi.mock('node:worker_threads', async (original) => ({
  ...(await original<typeof import('node:worker_threads')>()),
  Worker: class {
    terminated = false;
    private readonly handlers = new Map<string, (arg: unknown) => void>();
    constructor() { threads.push(this); }
    once(event: string, fn: (arg: unknown) => void) { this.handlers.set(event, fn); return this; }
    on(event: string, fn: (arg: unknown) => void) { return this.once(event, fn); }
    async terminate() { this.terminated = true; this.handlers.get('exit')?.(1); return 1; }
  },
}));

// No test reaches the Hub: one that forgets to say what the Hub answers finds it unreachable, and downloads nothing.
beforeEach(() => {
  vi.spyOn(StoredSync.prototype, 'fetchHubManifest').mockRejectedValue(new Error('tests never reach the Hub'));
  vi.spyOn(StoredSync.prototype, 'downloadFile').mockRejectedValue(new Error('tests never reach the Hub'));
});

/** The Hub was asked a moment ago, so a pass reads the manifest on disk (`manifest`, as the test overrides it) and asks nothing. */
function askedHub(w: Worker): Worker {
  (w.sync as any).hubAskedAt = Date.now();
  return w;
}

/**
 * The connection a lock is held on, as Store.locked hands it over and as
 * pg's: it emits 'error' when lost, and answers a query while `alive`.
 */
function lockClient() {
  const client = Object.assign(new EventEmitter(), { alive: true, query: async () => { if (!client.alive) throw new Error('Connection terminated unexpectedly'); return { rows: [] }; } });
  return client;
}

/**
 * An analyze pass's analysis, without the lock or the pick: the collection
 * dueAnalysis gives, analysed, or 'nothing due' when none is. It rejects as
 * the analysis does, where a pass would only record the failure.
 */
async function analyzeDue(w: Worker): Promise<string> {
  const c = await w.dueAnalysis(Date.now());
  return c === null ? 'nothing due' : (w as any).analyzeOne(c);
}

function row(more: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1, chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, cursorBlock: 995, headBlock: 1_000,
    addedAt: 0, ingestedAt: 0, error: null, errorAt: null, transfers: 10, wallets: 4, fundedWallets: 4,
    stale: false, latest: null, servedAt: null, readRate: null, priority: false, pausedAt: null, rules: {}, contract: null,
    restoreProgress: null, restoreNote: null, restoreNoteKey: null, restoreRetryAt: null, analysisError: null, analysisRetryAt: null, storedThroughTime: null, storedThroughBlock: null, trailImportedSha: null, trailNote: null, trailProgress: null,
    downloadFile: null, downloadProgress: null, downloadNote: null, downloadRetryAt: null, downloadMismatch: null, readTokens: false, ...more,
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

  it('serves the collections at the head never served first, then the longest waiting, so one the pass ran out on goes first next time', () => {
    const t = ingestTurns([row({ id: 1, servedAt: 30 }), row({ id: 2, servedAt: 10 }), row({ id: 3, servedAt: null }), row({ id: 4, servedAt: 20 })], 45_000);
    expect(t.keepUp.map((c) => c.id)).toEqual([3, 2, 4, 1]);
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

  const config: WorkerConfig = { rpc: new Map([[1, 'http://rpc']]), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' };

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
    const w = askedHub(new Worker(store, () => config, ''));
    (w.sync as any).manifest = async () => ({ version: 3, collections: [] });
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

  it('passes the re-read days to ingest, 0 when the setting is unset', async () => {
    const run = async (more: Partial<WorkerConfig>) => {
      const given = new Set<unknown>();
      const { w } = setup([at(1, { cursorBlock: 990 })], 1_000);
      (w as any).store.ingest = async (...args: unknown[]) => { given.add(args[5]); };
      (w as any).resolved = () => ({ ...config, ...more });
      await w.ingest();
      return given;
    };
    expect(await run({})).toEqual(new Set([0]));
    expect(await run({ followReread: 30 })).toEqual(new Set([30]));
  });

  it('serves the keep-up collections longest waiting first, and leaves one the pass ran out on unserved, to go first next time', async () => {
    const { w, served } = setup([at(1, { servedAt: 30 }), at(2, { servedAt: 20 }), at(3, { servedAt: null })], 30_000);
    await w.ingest();
    expect(served).toEqual([{ id: 3, blocks: 5 }, { id: 2, blocks: 5 }]);
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
    const w = askedHub(new Worker(store, () => ({ rpc, etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), ''));
    (w.sync as any).manifest = async () => ({ version: 3, collections: [ENTRY] });
    (w.sync as any).storedTransfers = async function* (e: StoredEntry) { events.push(`read ${e.transfers.file}`); yield []; };
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

  it('loads one collection\'s stored data a pass, and holds the chain reading of the next until its turn', async () => {
    const second: StoredEntry = { ...ENTRY, address: '0xb2', transfers: { ...ENTRY.transfers, file: '1-0xb2.transfers.csv.zst' } };
    const fresh = { cursorBlock: null, startBlock: null, contract: {} as any };
    const { w, events } = setup(
      [row({ ...fresh }), row({ id: 2, address: '0xb2', ...fresh })],
      [row({ cursorBlock: 900, contract: {} as any }), row({ id: 2, address: '0xb2', ...fresh })],
      new Map([[1, 'http://rpc']]),
    );
    (w.sync as any).manifest = async () => ({ version: 3, collections: [ENTRY, second] });
    (w as any).chain = () => ({ finalized: async () => 1_000, deployBlock: async () => 100, transfers: async () => ({ transfers: [], through: 1_000 }) });
    await w.ingest();
    expect(events.filter((e) => e.startsWith('restore'))).toEqual(['restore 1 1 0xbc4c']);
    // The one loaded is read on from where its data stops; the next is not read from its deploy block meanwhile.
    expect(events).toContain('served 1');
    expect(events).not.toContain('served 2');
    await w.ingest();
    expect(events.filter((e) => e.startsWith('restore'))).toEqual(['restore 1 1 0xbc4c', 'restore 2 1 0xb2']);
  });

  it('lets the next collection load in the same pass when the first one\'s load fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const second: StoredEntry = { ...ENTRY, address: '0xb2', transfers: { ...ENTRY.transfers, file: '1-0xb2.transfers.csv.zst' } };
    const fresh = { cursorBlock: null, startBlock: null, contract: {} as any };
    const rows = [row({ ...fresh }), row({ id: 2, address: '0xb2', ...fresh })];
    const { w, events, store } = setup(rows, rows, new Map([[1, 'http://rpc']]));
    (w.sync as any).manifest = async () => ({ version: 3, collections: [ENTRY, second] });
    (w as any).chain = () => ({ finalized: async () => 1_000, deployBlock: async () => 100, transfers: async () => ({ transfers: [], through: 1_000 }) });
    store.restore = async (id: number) => { events.push(`restore ${id}`); if (id === 1) throw new Error('store down'); };
    await w.ingest();
    expect(events.filter((e) => e.startsWith('restore'))).toEqual(['restore 1', 'restore 2']);
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
    (w as any).config = () => ({ rpc: new Map([[1, 'http://rpc']]), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' });
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
    (w.sync as any).restoreKey = async () => key;
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
    expect((w.sync as any).restoreFailed.has(1)).toBe(true);
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
    expect((w.sync as any).restoreFailed.has(1)).toBe(false);
  });

  it('clears a note about stored data the collection no longer reaches for: read past it, or gone from the manifest', async () => {
    const cleared: number[] = [];
    const past = setup([row({ id: 1, cursorBlock: 950, restoreNote: 'Stored data could not be loaded.' })], []);
    past.store.clearRestoreNote = async (id: number) => { cleared.push(id); };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await past.w.ingest();
    const gone = setup([row({ id: 2, cursorBlock: null, restoreNote: 'Stored data could not be loaded.' })], []);
    gone.store.clearRestoreNote = async (id: number) => { cleared.push(id); };
    (gone.w.sync as any).manifest = async () => ({ version: 3, collections: [] });
    await gone.w.ingest();
    expect(cleared).toEqual([1, 2]);
    expect([...past.events, ...gone.events].filter((e) => e.startsWith('restore'))).toEqual([]);
  });

  it('reads the chain as before when the manifest cannot be read', async () => {
    const { w, events } = setup([row({ cursorBlock: null })], []);
    (w.sync as any).manifest = async () => { throw new Error('not json'); };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await w.ingest();
    expect(events.filter((e) => e.startsWith('restore'))).toEqual([]);
    expect(events).toContain('error 1');
  });
});

/**
 * An entry with a money trail whose identity is 'feed', and whose two files
 * both have the sha256 SHA: the tests' fileSha answers one sha for every path.
 */
const SHA = 'feed';
const TRAILED: StoredEntry = {
  ...ENTRY,
  trail: { rows: 9, wallets: 3, checked: 1_612, of: 11_259, bytes: 100, sha256: 'feed', files: { wallets: { bytes: 10, sha256: SHA }, flows: { bytes: 90, sha256: SHA } } },
};

describe('needsTrail', () => {
  it('imports a trail on disk that matches the manifest and was not imported yet, and nothing else', () => {
    expect(needsTrail(row(), TRAILED, true)).toBe(true);
    // Already loaded: once per trail.
    expect(needsTrail(row({ trailImportedSha: 'feed' }), TRAILED, true)).toBe(false);
    // A re-cut trail loads again.
    expect(needsTrail(row({ trailImportedSha: 'old' }), TRAILED, true)).toBe(true);
    // No trail on disk that matches: nothing to load.
    expect(needsTrail(row(), TRAILED, false)).toBe(false);
    // No trail in the manifest, no manifest entry, or a paused collection.
    expect(needsTrail(row(), ENTRY, true)).toBe(false);
    expect(needsTrail(row(), null, true)).toBe(false);
    expect(needsTrail(row({ pausedAt: 5 }), TRAILED, true)).toBe(false);
  });

  it('needsTrail imports only when both files match and the trail is not the one loaded', () => {
    const table: [boolean, string | null, boolean][] = [
      [true, null, true],
      [true, 'old', true],
      [true, 'feed', false],
      [false, null, false],
      [false, 'old', false],
      [false, 'feed', false],
    ];
    for (const [onDisk, trailImportedSha, want] of table) {
      expect(needsTrail(row({ trailImportedSha }), TRAILED, onDisk), `${onDisk} ${trailImportedSha}`).toBe(want);
    }
  });
});

describe('Worker.ingest loading a money trail', () => {
  /** A second collection with a trail, for what one import at a time means. */
  const OTHER: StoredEntry = { ...TRAILED, address: '0xb2', transfers: { ...TRAILED.transfers, file: '1-0xb2.transfers.csv.zst' } };
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'washtrace-trail-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** An import the store was asked for, held until the test lets it go or its signal aborts it. */
  interface Held {
    id: number; sha: string; open: () => AsyncIterable<unknown>;
    opts: { onFlows: (flows: number) => void; signal: AbortSignal };
    release(): void;
  }

  /**
   * A worker over a stub store that says what happened, in order, and keeps
   * the rows as the store would, with a trail's two files on disk whose
   * sha256 is `sha`. The import runs under the trail lock (LOCKS.trail),
   * which another replica holds while `lock.other`. `hold` makes each import wait for the test; `settle` waits
   * for the one running in the background to end.
   */
  async function setup(rows: CollectionRow[], sha: string, after: CollectionRow[] = rows) {
    for (const e of [TRAILED, OTHER]) {
      const paths = trailPaths(dir, e);
      await writeFile(paths.wallets, 'wallets');
      await writeFile(paths.flows, 'trail');
    }
    const events: string[] = [];
    let restored = false;
    const now = () => (restored ? after : rows);
    const find = (id: number) => now().find((r) => r.id === id);
    const lock = { other: false };
    /** The connection the lock is held on, as pg's: it emits 'error' when lost, and answers a query while alive. */
    const client = lockClient();
    const store: any = {
      collections: async () => { events.push('collections'); return now().map((r) => ({ ...r })); },
      collection: async (_chainId: number, address: string) => { const r = now().find((x) => x.address === address); return r === undefined ? null : { ...r }; },
      locked: async (key: number, _wait: boolean, fn: (c: unknown) => Promise<unknown>) => { events.push(`lock ${key}`); return lock.other ? 'skipped' : fn(client); },
      restore: async () => { events.push('restore'); restored = true; },
      importTrail: async (id: number, chainId: number, sha256: string, open: () => AsyncIterable<unknown>) => {
        events.push(`import ${id} ${chainId} ${sha256}`);
        for await (const _ of open()) events.push('batch');
        find(id)!.trailImportedSha = sha256;
        return { wallets: 1, flows: 1 };
      },
      setTrailProgress: async (id: number, share: number | null) => {
        events.push(`progress ${id} ${share}`);
        const r = find(id);
        return r !== undefined && r.pausedAt === null;
      },
      setTrailNote: async (id: number, note: string | null) => {
        events.push(`note ${id} ${note}`);
        const r = find(id);
        if (r !== undefined) r.trailNote = note;
      },
      heartbeat: async (_job: string, doing: string | null) => { events.push(`beat ${doing}`); },
      served: async (id: number) => { events.push(`served ${id}`); },
      setError: async () => {}, setHead: async () => {}, setStart: async () => {}, ingest: async () => {},
    };
    const w = askedHub(new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '', dir));
    (w.sync as any).manifest = async () => ({ version: 3, collections: [TRAILED] });
    (w.sync as any).storedTransfers = async function* () { yield []; };
    const hashed: string[] = [];
    w.sync.fileSha = async (path: string) => { hashed.push(path); return sha; };
    (w.sync as any).storedTrail = async function* (entry: StoredEntry, verify: boolean) {
      events.push(`read ${entry.address} ${entry.trail!.sha256}`, `verify ${verify}`);
      yield { checked: [], flows: [] };
    };
    const settle = async () => { await (w.sync as any).importing?.done; };
    /** From now on each import waits for the test. An abort rejects it with `onAbort(reason)`, as the store throws the signal's reason between batches. */
    const hold = (onAbort: (reason: unknown) => unknown = (reason) => reason) => {
      const calls: Held[] = [];
      store.importTrail = (id: number, _chainId: number, sha256: string, open: () => AsyncIterable<unknown>, opts: Held['opts']) => new Promise((resolve, reject) => {
        events.push(`import ${id} ${sha256}`);
        opts.signal.addEventListener('abort', () => reject(onAbort(opts.signal.reason)));
        calls.push({ id, sha: sha256, open, opts, release: () => { find(id)!.trailImportedSha = sha256; resolve({ wallets: 1, flows: 1 }); } });
      });
      /** Resolves once the store has been asked for `n` imports in all. */
      const asked = (n: number) => vi.waitFor(() => expect(calls).toHaveLength(n));
      return { calls, asked };
    };
    return { w, events, store, hashed, lock, client, settle, hold, rows };
  }

  it('loads a matching trail on disk after any stored data, in the background, with no button', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, settle } = await setup([row({ cursorBlock: null, startBlock: null })], 'feed', [row({ cursorBlock: 900 })]);
    await w.ingest();
    await settle();
    const at = (e: string) => events.indexOf(e);
    expect(at('import 1 1 feed')).toBeGreaterThan(at('restore'));
    expect(events).toContain('read 0xbc4c feed');
    // No step of the pass: the pass says nothing of it.
    expect(events.some((e) => e.startsWith('beat Loading the money trail'))).toBe(false);
  });

  it('an ingest pass starts a trail import and returns without waiting for it', async () => {
    const { w, events, hold, settle } = await setup([row()], 'feed');
    const { calls, asked } = hold();
    expect(await w.ingest()).not.toContain('money trail');
    await asked(1);
    expect(events).toContain('lock 6');
    expect((w.sync as any).importing).toMatchObject({ id: 1, sha: 'feed' });
    // Still running when the next pass comes: not started twice.
    await w.ingest();
    expect(calls).toHaveLength(1);
    calls[0]!.release();
    await settle();
    expect((w.sync as any).importing).toBeNull();
  });

  it('writes no ingest heartbeat for a trail import', async () => {
    vi.useFakeTimers();
    const { w, events, store, hold, settle } = await setup([row()], 'feed');
    Object.assign(store, {
      settings: async () => new Map(), reportSources: async () => {},
      passStarted: async (job: string) => { events.push(`pass ${job}`); },
      passFinished: async (job: string, _ms: number, outcome: string) => { events.push(`passed ${job} ${outcome}`); },
    });
    const { calls, asked } = hold();
    expect(await w.run('ingest')).toBe('ran');
    await asked(1);
    // The pass is over while the import runs, and nothing beats for the import meanwhile.
    expect(events).toContain('passed ingest ok');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(events.filter((e) => e.startsWith('beat') || e.startsWith('pass'))).toEqual(['pass ingest', 'passed ingest ok']);
    calls[0]!.release();
    await settle();
  });

  it('starts no trail import while the collection\'s transfers still need loading', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, store, settle } = await setup([row({ cursorBlock: null, startBlock: null })], 'feed');
    // The load fails: its transfers are still to load, and the trail waits for them.
    store.restore = async () => { events.push('restore'); throw new Error('connection to server lost'); };
    await w.ingest();
    await settle();
    expect(events).toContain('restore');
    expect(events.some((e) => e === 'lock 6' || e.startsWith('import'))).toBe(false);
  });

  it('runs one trail import at a time, and none while another replica holds the lock', async () => {
    const { w, events, lock, hold, settle } = await setup([row(), row({ id: 2, address: '0xb2' })], 'feed');
    (w.sync as any).manifest = async () => ({ version: 3, collections: [TRAILED, OTHER] });
    lock.other = true;
    await w.ingest();
    await settle();
    // Asked for once, for the first due: the other replica is importing, and nothing else starts this pass.
    expect(events.filter((e) => e === 'lock 6')).toHaveLength(1);
    expect(events.some((e) => e.startsWith('import'))).toBe(false);
    lock.other = false;
    const { calls, asked } = hold();
    await w.ingest();
    await asked(1);
    await w.ingest();
    expect(calls.map((c) => c.id)).toEqual([1]);
    calls[0]!.release();
    await settle();
    await w.ingest();
    await asked(2);
    expect(calls.map((c) => c.id)).toEqual([1, 2]);
    calls[1]!.release();
    await settle();
  });

  it('skips an import another replica finished, by the row read inside the lock', async () => {
    const { w, events, store, settle } = await setup([row()], 'feed');
    // The pass read the row before the other replica's import ended; the lock is free by now.
    store.collection = async () => row({ trailImportedSha: 'feed' });
    await w.ingest();
    await settle();
    expect(events).toContain('lock 6');
    expect(events.some((e) => /^(import|progress|note|read)/.test(e))).toBe(false);
    expect((w.sync as any).importing).toBeNull();
  });

  it('reads the chain of a collection whose trail is importing', async () => {
    const { w, events, hold, settle } = await setup([row({ contract: {} as any })], 'feed');
    (w as any).config = () => ({ rpc: new Map([[1, 'http://rpc']]), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' });
    (w as any).chain = () => ({ finalized: async () => 1_000, transfers: async () => ({ transfers: [], through: 1_000 }) });
    const { calls, asked } = hold();
    await w.ingest();
    await asked(1);
    await w.ingest();
    expect(events.filter((e) => e === 'served 1')).toHaveLength(2);
    calls[0]!.release();
    await settle();
  });

  it('stops an import when a new cut changes its trail, without a mismatch note', async () => {
    const { w, events, hold, settle } = await setup([row()], 'feed');
    // The reader of a file replaced under it finds it no longer matches; the import was stopped first, and that is what counts.
    const { calls, asked } = hold(() => new StoredDataError('1-0xbc4c.flows.csv.zst does not match its checksum', 'mismatch'));
    await w.ingest();
    await asked(1);
    // A new cut: the manifest and the file on disk both change.
    (w.sync as any).manifest = async () => ({ version: 3, collections: [{ ...TRAILED, trail: { ...TRAILED.trail!, sha256: 'beef', files: { wallets: { bytes: 10, sha256: 'beef' }, flows: { bytes: 90, sha256: 'beef' } } } }] });
    w.sync.fileSha = async () => 'beef';
    await writeFile(trailPaths(dir, TRAILED).wallets, 'wallets cut again');
    await writeFile(trailPaths(dir, TRAILED).flows, 'a trail cut again');
    await w.ingest();
    expect(calls[0]!.opts.signal.reason).toBe('stopped');
    // The old import ended while the pass looked at the file, so the new cut starts in the same pass.
    await asked(2);
    expect(calls[1]!.sha).toBe('beef');
    expect(events.indexOf('progress 1 null')).toBeLessThan(events.indexOf('import 1 beef'));
    expect(events.some((e) => e.startsWith('note'))).toBe(false);
    calls[1]!.release();
    await settle();
  });

  it('stops the import of a collection paused mid-way, and clears its progress without a failure note', async () => {
    const paused = await setup([row()], 'feed');
    const one = paused.hold();
    await paused.w.ingest();
    await one.asked(1);
    // Seen by the next pass.
    paused.rows[0]!.pausedAt = Date.now();
    await paused.w.ingest();
    expect(one.calls[0]!.opts.signal.reason).toBe('stopped');
    await paused.settle();
    expect(paused.events).toContain('progress 1 null');
    expect(paused.events.some((e) => e.startsWith('note'))).toBe(false);
    // Seen by the progress it writes: this one is deleted mid-way.
    const deleted = await setup([row()], 'feed');
    const two = deleted.hold();
    await deleted.w.ingest();
    await two.asked(1);
    deleted.rows.splice(0, 1);
    two.calls[0]!.opts.onFlows(5);
    await deleted.settle();
    expect(two.calls[0]!.opts.signal.reason).toBe('stopped');
    expect(deleted.events.some((e) => e.startsWith('note'))).toBe(false);
  });

  it('writes trail progress in order, at most once per 1%, capped at 99%, and clears it after the last write', async () => {
    const { w, events, store, settle } = await setup([row()], 'feed');
    (w.sync as any).manifest = async () => ({ version: 3, collections: [{ ...TRAILED, trail: { ...TRAILED.trail!, rows: 1_000 } }] });
    // Batches of flows that bring the count to 1, 4, 11, 12, 500, 999, 1000 and 1200 of the manifest's 1000.
    const sizes = [1, 3, 7, 1, 488, 499, 1, 200];
    (w.sync as any).storedTrail = async function* () {
      yield { checked: ['0xa'], flows: [] };
      for (const n of sizes) yield { checked: [], flows: new Array(n).fill({}) };
    };
    // The first write is the slowest: a later one must still land after it.
    store.setTrailProgress = async (id: number, share: number | null) => {
      await new Promise((r) => setTimeout(r, share === 0 ? 30 : 1));
      events.push(`progress ${id} ${share}`);
      return true;
    };
    // As the store does: a flows pass, a wallets pass, then the final statement, which clears the progress.
    store.importTrail = async (id: number, _chainId: number, _sha: string, open: () => AsyncIterable<{ checked: string[]; flows: unknown[] }>, opts: Held['opts']) => {
      let flows = 0;
      for await (const b of open()) {
        flows += b.flows.length;
        opts.onFlows(flows);
      }
      for await (const b of open()) if (b.checked.length === 0) break;
      events.push(`imported ${id}, progress cleared`);
      return { wallets: 1, flows };
    };
    await w.ingest();
    await vi.waitFor(() => expect(events).toContain('imported 1, progress cleared'));
    await settle();
    expect(events.filter((e) => /^(progress|imported)/.test(e))).toEqual([
      'progress 1 0', 'progress 1 0.011', 'progress 1 0.5', 'progress 1 0.99', 'imported 1, progress cleared',
    ]);
  });

  it('clears a failed note when the retry starts', async () => {
    const { w, events, hold, settle } = await setup([row({ trailNote: TRAIL_NOTES.failed })], 'feed');
    const { calls, asked } = hold();
    await w.ingest();
    await asked(1);
    expect(events.indexOf('note 1 null')).toBeGreaterThan(events.indexOf('lock 6'));
    expect(events.indexOf('note 1 null')).toBeLessThan(events.indexOf('import 1 feed'));
    calls[0]!.release();
    await settle();
    expect(events.filter((e) => e.startsWith('note'))).toEqual(['note 1 null']);
  });

  it('notes a store failure instead of trying again next pass', async () => {
    const { w, events, store, settle } = await setup([row()], 'feed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.importTrail = async () => { events.push('import'); throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }); };
    await w.ingest();
    await settle();
    await w.ingest();
    await settle();
    expect(events.filter((e) => e === 'import')).toHaveLength(1);
    expect(events).toContain(`note 1 ${TRAIL_NOTES.failed}`);
    expect(events).toContain('progress 1 null');
    expect(logged.mock.calls.some((c) => c.join(' ').includes('terminating connection due to administrator command'))).toBe(true);
  });

  it('a store failure during an import notes it and waits out its back-off', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, store, settle } = await setup([row()], 'feed');
    store.importTrail = async () => { events.push('import'); throw Object.assign(new Error('could not extend file: No space left on device'), { code: '53100' }); };
    const tries = async () => { await w.ingest(); await settle(); return events.filter((e) => e === 'import').length; };
    expect(await tries()).toBe(1);
    expect(events).toContain(`note 1 ${TRAIL_NOTES.failed}`);
    now += 5 * 60_000 - 1;
    expect(await tries()).toBe(1);
    now += 1;
    expect(await tries()).toBe(2);
    // Doubling: ten minutes after the second failure.
    now += 10 * 60_000 - 1;
    expect(await tries()).toBe(2);
    now += 1;
    expect(await tries()).toBe(3);
  });

  it('an import with no committed batch for 15 minutes is given up as a failure', async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, hold, settle } = await setup([row()], 'feed');
    (w.sync as any).storedTrail = async function* () { for (let i = 0; i < 3; i++) yield { checked: [], flows: [] }; };
    const { calls, asked } = hold();
    await w.ingest();
    await asked(1);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    // The store asks for the next batch once the one before it committed: the 15 minutes start again.
    const batches = calls[0]!.open()[Symbol.asyncIterator]();
    await batches.next();
    await batches.next();
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(calls[0]!.opts.signal.aborted).toBe(false);
    // Looked at every ten seconds: given up within one look of the 15 minutes.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(calls[0]!.opts.signal.reason).toBe('stalled');
    await settle();
    expect(events).toContain(`note 1 ${TRAIL_NOTES.failed}`);
    expect(logged.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('nothing was written for 15 minutes');
  });

  it('a read of the trail that never returns is given up as a stall', async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, settle } = await setup([row()], 'feed');
    // A reader stuck in a read: its next batch never comes, and nothing between batches ever runs.
    (w.sync as any).storedTrail = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) });
    await w.ingest();
    await vi.waitFor(() => expect(events).toContain('import 1 1 feed'));
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 10_000);
    await settle();
    expect(events).toContain('progress 1 null');
    expect(events).toContain(`note 1 ${TRAIL_NOTES.failed}`);
    expect((w.sync as any).trailsRetry.has(1)).toBe(true);
    expect(logged.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('nothing was written for 15 minutes');
  });

  it('closes the trail reader on the second pass\'s break and on an abort', async () => {
    const { w, store, settle } = await setup([row()], 'feed');
    /** A reader that counts how often it is opened and closed: a real one holds a file and a decompressor open until closed. */
    const reader = { opened: 0, closed: 0 };
    (w.sync as any).storedTrail = () => {
      reader.opened += 1;
      const batches = [{ checked: ['0xa'], flows: [] }, { checked: [], flows: [{}] }];
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => (batches.length > 0 ? { done: false, value: batches.shift() } : { done: true, value: undefined }),
          return: async () => { reader.closed += 1; return { done: true, value: undefined }; },
        }),
      };
    };
    // As the store does: the wallets pass breaks off once the checked addresses are behind it.
    store.importTrail = async (_id: number, _chainId: number, _sha: string, open: () => AsyncIterable<{ checked: string[] }>) => {
      for await (const _ of open()) { /* the flows */ }
      for await (const b of open()) if (b.checked.length === 0) break;
      return { wallets: 1, flows: 1 };
    };
    await w.ingest();
    await settle();
    expect(reader).toEqual({ opened: 2, closed: 2 });

    // Stopped between batches: the store throws the signal's reason with the reader open.
    const stopped = await setup([row()], 'feed');
    const once = { opened: 0, closed: 0 };
    (stopped.w.sync as any).storedTrail = () => {
      once.opened += 1;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: { checked: [], flows: [] } }),
          return: async () => { once.closed += 1; return { done: true, value: undefined }; },
        }),
      };
    };
    let reading = () => {};
    const read = new Promise<void>((r) => { reading = r; });
    stopped.store.importTrail = async (_id: number, _chainId: number, _sha: string, open: () => AsyncIterable<unknown>, opts: { signal: AbortSignal }) => {
      for await (const _ of open()) {
        reading();
        await new Promise((r) => opts.signal.addEventListener('abort', r));
        opts.signal.throwIfAborted();
      }
      return { wallets: 1, flows: 1 };
    };
    await stopped.w.ingest();
    await read;
    stopped.w.stop();
    await stopped.settle();
    expect(once).toEqual({ opened: 1, closed: 1 });
  });

  it('loads no stored data beside an import of the same collection, and stops that import', async () => {
    const { w, events, hold, settle } = await setup([row()], 'feed');
    const { calls, asked } = hold();
    await w.ingest();
    await asked(1);
    // A new cut reaches past what was read: its transfers are to load again, and its trail goes after them.
    (w.sync as any).manifest = async () => ({ version: 3, collections: [{ ...TRAILED, throughBlock: 2_000 }] });
    await w.ingest();
    expect(events).not.toContain('restore');
    expect(calls[0]!.opts.signal.reason).toBe('stopped');
    await settle();
    await w.ingest();
    expect(events).toContain('restore');
  });

  it('a lost lock connection fails the import instead of crashing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, client, hold, settle } = await setup([row()], 'feed');
    const { calls, asked } = hold();
    await w.ingest();
    await asked(1);
    client.alive = false;
    client.emit('error', new Error('Connection terminated unexpectedly'));
    expect(calls[0]!.opts.signal.reason).toBe('lost');
    await settle();
    expect(events).toContain(`note 1 ${TRAIL_NOTES.failed}`);
    expect(logged.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('the connection holding its lock was lost (Connection terminated unexpectedly)');
    // Heard while the import ran, and only then: nothing is left listening.
    expect(client.listenerCount('error')).toBe(0);
  });

  it('stop() aborts a running import and drain() waits for it', async () => {
    const { w, events, store, hold } = await setup([row()], 'feed');
    const { calls, asked } = hold();
    await w.ingest();
    await asked(1);
    // The clear after a stop takes a while: drain waits for it.
    const write = store.setTrailProgress;
    store.setTrailProgress = async (id: number, share: number | null) => {
      if (share === null) await new Promise((r) => setTimeout(r, 300));
      return write(id, share);
    };
    w.stop();
    expect(calls[0]!.opts.signal.reason).toBe('stopped');
    await w.drain(5_000);
    expect((w.sync as any).importing).toBeNull();
    expect(events).toContain('progress 1 null');
    expect(events.some((e) => e.startsWith('note'))).toBe(false);
  });

  it('retries a progress clear that failed, at the next pass, and not for the import that runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, store, hold, settle } = await setup([row()], 'feed');
    const { asked } = hold();
    let failClear = true;
    const write = store.setTrailProgress;
    store.setTrailProgress = async (id: number, share: number | null) => {
      if (share === null && failClear) { events.push(`progress ${id} null (fails)`); failClear = false; throw new Error('store down'); }
      return write(id, share);
    };
    await w.ingest();
    await asked(1);
    (w.sync as any).importing.abort.abort('stopped');
    await settle();
    expect(events).toContain('progress 1 null (fails)');
    // The next pass clears it before anything else about trails.
    events.length = 0;
    await w.ingest();
    expect(events).toContain('progress 1 null');
    // Cleared once: not again.
    events.length = 0;
    await w.ingest();
    expect(events).not.toContain('progress 1 null');
  });

  it('clearStaleTrailProgress leaves the progress of an import another replica holds', async () => {
    const { w, events, store, lock } = await setup([row()], 'feed');
    let cleared = 0;
    store.clearTrailProgress = async () => { cleared += 1; };
    lock.other = true;
    await w.sync.clearStaleTrailProgress();
    expect(cleared).toBe(0);
    lock.other = false;
    await w.sync.clearStaleTrailProgress();
    expect(cleared).toBe(1);
    expect(events.filter((e) => e === 'lock 6')).toHaveLength(2);
  });

  it('leaves a paused collection\'s trail alone, and one already imported', async () => {
    const paused = await setup([row({ pausedAt: 5 })], 'feed');
    await paused.w.ingest();
    await paused.settle();
    expect(paused.events.some((e) => e.startsWith('import') || e === 'lock 6')).toBe(false);
    const done = await setup([row({ trailImportedSha: 'feed' })], 'feed');
    await done.w.ingest();
    await done.settle();
    expect(done.events.some((e) => e.startsWith('import') || e === 'lock 6')).toBe(false);
  });

  it('hashes no trail already imported: the file on disk has nothing more to give', async () => {
    const { w, hashed } = await setup([row({ trailImportedSha: 'feed' })], 'feed');
    await w.ingest();
    expect(hashed).toEqual([]);
  });

  it('reads a trail found matching without hashing it again, and checks one changed since', async () => {
    const { w, events, store, settle } = await setup([row()], 'feed');
    // Both passes of the import, as the store reads it.
    store.importTrail = async (_id: number, _chainId: number, _sha: string, open: () => AsyncIterable<unknown>) => {
      for (const _ of [1, 2]) for await (const __ of open()) events.push('batch');
      return { wallets: 0, flows: 0 };
    };
    await w.ingest();
    await settle();
    expect(events.filter((e) => e.startsWith('verify'))).toEqual(['verify false', 'verify false']);
    // Replaced after it was found to match: the next read checks it.
    const changed = await setup([row()], 'feed');
    changed.store.importTrail = async (_id: number, _chainId: number, _sha: string, open: () => AsyncIterable<unknown>) => {
      await writeFile(trailPaths(dir, TRAILED).flows, 'another trail');
      for await (const _ of open()) changed.events.push('batch');
      return { wallets: 0, flows: 0 };
    };
    await changed.w.ingest();
    await changed.settle();
    expect(changed.events.filter((e) => e.startsWith('verify'))).toEqual(['verify true']);
  });

  it('checks a trail rewritten in place, though its size and modified time are as they were', async () => {
    const { w, events, store, settle } = await setup([row()], 'feed');
    const path = trailPaths(dir, TRAILED).flows;
    // A whole second, which utimes can set back exactly.
    await utimes(path, 1_000, 1_000);
    store.importTrail = async (_id: number, _chainId: number, _sha: string, open: () => AsyncIterable<unknown>) => {
      // As cp -p or rsync -t leave it: other bytes, the same length, the old modified time.
      await writeFile(path, 'trial');
      await utimes(path, 1_000, 1_000);
      expect((await stat(path)).mtimeMs).toBe(1_000_000);
      for await (const _ of open()) events.push('batch');
      return { wallets: 0, flows: 0 };
    };
    await w.ingest();
    await settle();
    expect(events.filter((e) => e.startsWith('verify'))).toEqual(['verify true']);
  });

  it('hashes a trail once while the file stays the same, and again once it changes', async () => {
    // Not the manifest's trail, so never imported: each pass looks at it.
    const { w, hashed } = await setup([row()], 'beef');
    const paths = trailPaths(dir, TRAILED);
    await w.ingest();
    await w.ingest();
    expect(hashed).toEqual([paths.wallets, paths.flows]);
    await writeFile(paths.flows, 'a longer trail');
    await w.ingest();
    expect(hashed).toEqual([paths.wallets, paths.flows, paths.flows]);
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

  it('a trail with only its wallets file on disk is not noted and not imported', async () => {
    const { w, events, settle } = await setup([row()], 'feed');
    let read = 0;
    (w.sync as any).storedTrail = async function* () { read += 1; yield { checked: [], flows: [] }; };
    await rm(trailPaths(dir, TRAILED).flows);
    await w.ingest();
    await settle();
    expect(events).not.toContain(`note 1 ${TRAIL_NOTES.mismatch}`);
    expect(events.some((e) => e.startsWith('import') || e === 'lock 6')).toBe(false);
    expect(read).toBe(0);
  });

  it('a wallets file that does not match is noted as a mismatch, naming it', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { w, events } = await setup([row()], 'feed');
    const paths = trailPaths(dir, TRAILED);
    w.sync.fileSha = async (path: string) => (path === paths.wallets ? 'beef' : 'feed');
    await w.ingest();
    expect(events).toContain(`note 1 ${TRAIL_NOTES.mismatch}`);
    expect(events.some((e) => e.startsWith('import'))).toBe(false);
    const said = warned.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain(paths.wallets);
    expect(said).toContain('.wallets.csv.zst');
    expect(said).toContain('beef');
  });

  it('clears a note once the file it was about is gone', async () => {
    const { w, events } = await setup([row({ trailNote: 'Money trail on disk does not match the stored data, so it was not loaded.' })], 'feed');
    await rm(trailPaths(dir, TRAILED).flows);
    await w.ingest();
    expect(events).toContain('note 1 null');
  });

  it('clears a note once the manifest has no trail for the collection', async () => {
    const { w, events } = await setup([row({ trailNote: 'Money trail on disk could not be read, so it was not loaded.' })], 'feed');
    (w.sync as any).manifest = async () => ({ version: 3, collections: [ENTRY] });
    await w.ingest();
    expect(events).toContain('note 1 null');
    // And none to clear: nothing written.
    const clean = await setup([row()], 'feed');
    (clean.w.sync as any).manifest = async () => ({ version: 3, collections: [] });
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
    const { w, events, store, settle } = await setup([row()], 'feed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.importTrail = async () => { events.push('import'); throw new StoredDataError('/data/1-0xbc4c.flows.csv.zst has a row of 3 fields, expected 8'); };
    await w.ingest();
    await settle();
    await w.ingest();
    await settle();
    expect(events.filter((e) => e === 'import')).toHaveLength(1);
    expect(events).toContain('note 1 Money trail on disk could not be read, so it was not loaded.');
    expect(logged.mock.calls.some((c) => c.join(' ').includes('has a row of 3 fields'))).toBe(true);
    await writeFile(trailPaths(dir, TRAILED).flows, 'a trail cut again');
    await w.ingest();
    await settle();
    expect(events.filter((e) => e === 'import')).toHaveLength(2);
  });
});

describe('Worker downloading stored data', () => {
  const REV = 'c0ffee'.padEnd(40, '0');
  const A = `0x${'a1'.repeat(20)}`, B = `0x${'b2'.repeat(20)}`, C = `0x${'c3'.repeat(20)}`;
  const RPC = new Map([[1, 'http://rpc']]);
  const sha = (c: string) => c.repeat(64);
  /**
   * A manifest entry for `address`: its transfers' sha256 is sha(t), and with
   * `r` it has a trail whose wallets file's sha256 is sha(r) (10 bytes) and
   * whose flows file's is `r0` repeated (90 bytes).
   */
  const stored = (address: string, t: string, r: string | null = null): StoredEntry => {
    const files = r === null ? null : { wallets: { bytes: 10, sha256: sha(r) }, flows: { bytes: 90, sha256: `${r}0`.repeat(32) } };
    return {
      chainId: 1, address, name: 'BAYC', startBlock: 100, throughBlock: 900, throughTime: 1_700_000_000_000,
      transfers: { file: storedFile(1, address, 'transfers'), rows: 3, bytes: 10, sha256: sha(t) },
      trail: files === null ? null : { rows: 1, wallets: 1, checked: 1, of: 1, bytes: 100, sha256: trailSha(files), files },
    };
  };
  /** Put both files of `e`'s trail on disk, as a finished download leaves them: each says its own sha256. */
  const trailOnDisk = async (e: StoredEntry) => {
    const paths = trailPaths(dir, e);
    await writeFile(paths.wallets, e.trail!.files.wallets.sha256);
    await writeFile(paths.flows, e.trail!.files.flows.sha256);
  };
  /** A watched collection read up to just before where its stored data starts, so the stored data would load. */
  const watched = (id: number, address: string, more: Partial<CollectionRow> = {}) => row({ id, address, startBlock: 100, cursorBlock: 99, contract: {} as any, ...more });

  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'washtrace-download-')); });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  /** One call of downloadFile, held until the test ends it. An abort rejects it, as download does. */
  interface Call {
    url: string; dest: string; sha: string; onProgress: (share: number) => void; signal: AbortSignal;
    /** Writes the file (its content is its sha256, see fileSha) and resolves, then waits for the worker to finish with it: the download ends, or fetches its next file. */
    finish(): Promise<void>;
    fail(err: unknown): Promise<void>;
  }

  /**
   * A worker over a stub store that says what happened and keeps `rows` as
   * the store would, with a Hub that answers `entries` at REV. A file on
   * disk says its own sha256, as a finished download writes it.
   */
  function setup(rows: CollectionRow[], entries: StoredEntry[], rpc: ReadonlyMap<number, string> = new Map()) {
    const events: string[] = [];
    const calls: Call[] = [];
    const hub = { asked: 0, lock: true, repo: 'u/d', answer: async (): Promise<Manifest | null> => ({ version: 3, revision: REV, collections: entries }) };
    const find = (id: number) => rows.find((r) => r.id === id);
    /** The connection the lock is held on, as pg's: it emits 'error' when lost, and answers a query while alive. */
    const client = lockClient();
    const store: any = {
      collections: async () => rows.map((r) => ({ ...r })),
      collection: async (_chainId: number, address: string) => { const r = rows.find((x) => x.address === address); return r === undefined ? null : { ...r }; },
      locked: async (key: number, _wait: boolean, fn: (c: unknown) => Promise<unknown>) => { events.push(`lock ${key}`); return hub.lock ? fn(client) : 'skipped'; },
      restore: async (id: number, _chainId: number, e: StoredEntry) => {
        events.push(`restore ${id}`);
        Object.assign(find(id)!, { startBlock: e.startBlock, cursorBlock: e.throughBlock, storedThroughTime: e.throughTime, restoreNote: null, restoreNoteKey: null });
      },
      importTrail: async (id: number, _chainId: number, sha256: string) => { events.push(`import ${id}`); find(id)!.trailImportedSha = sha256; return { wallets: 1, flows: 1 }; },
      setTrailProgress: async (id: number, share: number | null) => { events.push(`trail ${id} ${share}`); return find(id)?.pausedAt === null; },
      setDownload: async (id: number, file: string | null, share: number | null) => {
        events.push(`progress ${id} ${file} ${share}`);
        const r = find(id);
        if (r === undefined) return false;
        Object.assign(r, { downloadFile: file, downloadProgress: share });
        return r.pausedAt === null;
      },
      downloadFailed: async (id: number, note: string, mismatch: string | null) => {
        events.push(`failed ${id} ${note}`);
        const r = find(id)!;
        Object.assign(r, { downloadFile: null, downloadProgress: null, downloadNote: note, downloadRetryAt: Date.now() + 5 * 60_000, downloadMismatch: mismatch ?? r.downloadMismatch });
      },
      downloadDone: async (id: number) => {
        events.push(`done ${id}`);
        Object.assign(find(id)!, { downloadFile: null, downloadProgress: null, downloadNote: null, downloadRetryAt: null });
      },
      clearDownloadNote: async (id: number, backoff: boolean) => {
        events.push(`unnoted ${id} ${backoff ? 'and back-off' : 'only'}`);
        Object.assign(find(id)!, backoff ? { downloadNote: null, downloadRetryAt: null } : { downloadNote: null });
      },
      setError: async (id: number, message: string | null) => { events.push(message === null ? `cleared ${id}` : `error ${id} ${message}`); },
      served: async (id: number) => { events.push(`served ${id}`); },
      heartbeat: async () => {}, setHead: async () => {}, setStart: async () => {}, ingest: async () => {},
      clearRestoreNote: async () => {}, setTrailNote: async () => {},
      stale: async () => rows.map((r) => ({ id: r.id, chainId: 1, version: 1, rules: {}, name: r.name, ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null })),
      importedMoney: async () => false, analysisStarted: async () => {}, saveAnalysis: async () => {},
    };
    const w = new Worker(store, () => ({ rpc, etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: hub.repo }), '', dir);
    /** Waits for the download and the trail import running in the background, if any, to end. */
    const settle = async () => {
      await (w.sync as any).downloading?.done;
      await (w.sync as any).importing?.done;
    };
    w.sync.fetchHubManifest = async () => { hub.asked += 1; return hub.answer(); };
    w.sync.fileSha = (path: string) => readFile(path, 'utf8');
    /** Resolved at the next call of downloadFile. */
    let called: () => void = () => {};
    const nextCall = () => new Promise<void>((r) => { called = r; });
    w.sync.downloadFile = (url, dest, sha256, onProgress, signal) => new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
      calls.push({
        url, dest, sha: sha256, onProgress, signal,
        finish: async () => { await writeFile(dest, sha256); const next = nextCall(); resolve(); await Promise.race([settle(), next]); },
        fail: async (err) => { reject(err); await settle(); },
      });
      called();
    });
    w.analyzeOff = async () => ({ analysis: {} as Analysis, through: 7 });
    (w as any).chain = () => ({ finalized: async () => 1_000, transfers: async () => ({ transfers: [], through: 1_000 }) });
    return { w, events, calls, hub, settle, store, client };
  }

  it('downloads the transfers of a watched collection that would load them, then loads them on a later pass', async () => {
    // Noted from before downloads: the file was missing. The download is what puts it there.
    const noted = watched(1, A, { restoreNote: 'Stored data could not be loaded: its file is missing.', restoreNoteKey: `${sha('a')}:absent` });
    const { w, events, calls } = setup([noted], [stored(A, 'a')]);
    await w.ingest();
    expect(calls.map((c) => [c.url, c.dest, c.sha])).toEqual([[hubUrl('u/d', REV, storedFile(1, A, 'transfers')), join(dir, storedFile(1, A, 'transfers')), sha('a')]]);
    // Fetched, and kept on disk for what reads it between fetches.
    expect(await readManifest(join(dir, 'manifest.json'))).toEqual({ version: 3, revision: REV, collections: [stored(A, 'a')] });
    // Not tried from disk meanwhile, which would only note it missing again.
    expect(events).not.toContain('restore 1');
    // Progress at most once per 1%.
    for (const share of [0.001, 0.004, 0.011, 0.0115, 0.5]) calls[0]!.onProgress(share);
    await calls[0]!.finish();
    expect(events.filter((e) => /^(progress|done)/.test(e))).toEqual(['progress 1 transfers 0', 'progress 1 transfers 0.011', 'progress 1 transfers 0.5', 'done 1']);
    await w.ingest();
    expect(events).toContain('restore 1');
    expect(calls).toHaveLength(1);
  });

  it('takes the sha256 a download checked, and does not hash the file again to load it', async () => {
    const { w, events, calls } = setup([watched(1, A)], [stored(A, 'a')]);
    const hashed: string[] = [];
    const read = w.sync.fileSha;
    w.sync.fileSha = (path: string) => { hashed.push(path); return read(path); };
    await w.ingest();
    await calls[0]!.finish();
    await w.ingest();
    expect(events).toContain('restore 1');
    expect(hashed).toEqual([]);
  });

  it('downloads nothing for a collection already read past its stored data', async () => {
    const { w, events, calls } = setup([watched(1, A, { cursorBlock: 950 })], [stored(A, 'a')], RPC);
    await w.ingest();
    expect(calls).toEqual([]);
    // Only the sweep of stale parts, once the manifest is fetched: no download's.
    expect(events.filter((e) => e.startsWith('lock'))).toEqual(['lock 5']);
    expect(events).toContain('served 1');
  });

  it('downloads nothing when the file on disk already matches', async () => {
    const e = stored(A, 'a', 'b');
    await writeFile(join(dir, e.transfers.file), sha('a'));
    await trailOnDisk(e);
    const { w, events, calls } = setup([watched(1, A)], [e]);
    await w.ingest();
    await w.ingest();
    expect(calls).toEqual([]);
    expect(events).toContain('restore 1');
    expect(events).toContain('import 1');
  });

  it('holds the collection\'s chain reading while its transfers download, and no other collection\'s', async () => {
    const { w, events, calls } = setup([watched(1, A), watched(2, B)], [stored(A, 'a')], RPC);
    await w.ingest();
    expect(calls).toHaveLength(1);
    expect(events).toContain('served 2');
    expect(events).not.toContain('served 1');
    // Still downloading next pass: still held, and not started twice.
    await w.ingest();
    expect(calls).toHaveLength(1);
    expect(events).not.toContain('served 1');
    await calls[0]!.finish();
    await w.ingest();
    expect(events).toContain('restore 1');
    expect(events).toContain('served 1');
  });

  it('says no "No RPC" fault for a collection whose stored data is downloading', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const NO_RPC = 'No RPC is configured for chain 1. Set it in Settings, or WASHTRACE_RPC_1 for the worker.';
    // A said the fault before its download started (a back-off, or before downloads were): cleared while it is on the way.
    const { w, events, calls } = setup([watched(1, A, { error: NO_RPC }), watched(2, B)], [stored(A, 'a')]);
    await w.ingest();
    expect(events.filter((e) => /^(error|cleared)/.test(e))).toEqual(['cleared 1', `error 2 ${NO_RPC}`]);
    await calls[0]!.finish();
  });

  it('runs one download at a time, every transfers file before any trail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The first watched has only a trail to download, the second its transfers: the transfers go first.
    const { w, calls } = setup([watched(1, A, { cursorBlock: 950 }), watched(2, B)], [stored(A, 'a', 'b'), stored(B, 'c')]);
    await w.ingest();
    await w.ingest();
    expect(calls.map((c) => c.dest)).toEqual([join(dir, storedFile(1, B, 'transfers'))]);
    await calls[0]!.finish();
    await w.ingest();
    expect(calls.map((c) => c.url)).toEqual([hubUrl('u/d', REV, storedFile(1, B, 'transfers')), hubUrl('u/d', REV, storedFile(1, A, 'wallets'))]);
    expect(calls[1]!.dest).toBe(trailPaths(dir, stored(A, 'a', 'b')).wallets);
    await calls[1]!.finish();
    await calls[2]!.finish();
  });

  it('a transfers download that comes due stops a running trail download', async () => {
    const rows = [watched(1, A, { cursorBlock: 950 })];
    const { w, events, calls, settle } = setup(rows, [stored(A, 'a', 'b'), stored(B, 'c')], RPC);
    await w.ingest();
    expect(calls.map((c) => c.dest)).toEqual([trailPaths(dir, stored(A, 'a', 'b')).wallets]);
    // A trail download holds nothing: its collection's chain is read.
    expect(events).toContain('served 1');
    rows.push(watched(2, B, { addedAt: Date.now() }));
    await w.ingest();
    expect(calls[0]!.signal.aborted).toBe(true);
    await settle();
    // Stopped, not failed: no back-off, and its progress goes.
    expect(events).toContain('progress 1 null null');
    expect(events.some((e) => e.startsWith('failed'))).toBe(false);
    expect(events).not.toContain('served 2');
    // The transfers start the pass after.
    expect(calls).toHaveLength(1);
    await w.ingest();
    expect(calls.map((c) => c.dest)).toEqual([trailPaths(dir, stored(A, 'a', 'b')).wallets, join(dir, storedFile(1, B, 'transfers'))]);
    await calls[1]!.finish();
  });

  it('starts no trail download for the collection importing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Read past its stored data: only its trail is due, and it is on disk.
    const e = stored(A, 'a', 'b');
    await trailOnDisk(e);
    const { w, events, calls, hub, store, settle } = setup([watched(1, A, { cursorBlock: 950 })], [e], RPC);
    // An import that, once stopped, takes until the test says to end: its reader is still on the file meanwhile.
    let signal: AbortSignal | null = null;
    let end: () => void = () => {};
    store.importTrail = (id: number, _chainId: number, _sha: string, _open: unknown, opts: { signal: AbortSignal }) => new Promise((_, reject) => {
      events.push(`import ${id}`);
      signal = opts.signal;
      end = () => reject(opts.signal.reason);
    });
    await w.ingest();
    await vi.waitFor(() => expect(events).toContain('import 1'));
    // A new cut on the Hub: the trail on disk is no longer the one wanted, and its import stops.
    hub.answer = async () => ({ version: 3, revision: REV, collections: [stored(A, 'a', 'c')] });
    (w.sync as any).hubAskedAt = -Infinity;
    await w.ingest();
    expect(signal!.reason).toBe('stopped');
    // Not downloaded over the file the import is still reading.
    expect(calls).toEqual([]);
    end();
    await settle();
    await w.ingest();
    expect(calls.map((c) => c.dest)).toEqual([trailPaths(dir, e).wallets]);
    await calls[0]!.finish();
    await calls[1]!.finish();
  });

  it('starts no download while another replica holds the download lock', async () => {
    // B is backed off here, so only its row, which says another replica is downloading it, holds it.
    const other = watched(2, B, { downloadFile: 'transfers', downloadRetryAt: Date.now() + 60 * 60_000 });
    const { w, events, calls, hub, settle } = setup([watched(1, A), other], [stored(A, 'a'), stored(B, 'c')], RPC);
    hub.lock = false;
    await w.ingest();
    await settle();
    await w.ingest();
    await settle();
    // One download tried each pass, and the first pass's sweep of stale parts.
    expect(events.filter((e) => e === 'lock 5')).toHaveLength(3);
    expect(calls).toEqual([]);
    // The other replica's download holds the chain reading here too.
    expect(events).not.toContain('served 2');
    expect(events).not.toContain('served 1');
  });

  it('aborts the download of a collection paused mid-way, and clears its progress', async () => {
    const rows = [watched(1, A), watched(2, B)];
    const { w, events, calls, settle } = setup(rows, [stored(A, 'a'), stored(B, 'c')]);
    await w.ingest();
    expect(calls).toHaveLength(1);
    // Seen by the next pass.
    rows[0]!.pausedAt = Date.now();
    await w.ingest();
    expect(calls[0]!.signal.aborted).toBe(true);
    await settle();
    expect(events).toContain('progress 1 null null');
    // Seen by the progress it writes: this one is deleted mid-way.
    await w.ingest();
    expect(calls[1]!.dest).toBe(join(dir, storedFile(1, B, 'transfers')));
    rows.splice(1, 1);
    calls[1]!.onProgress(0.2);
    await settle();
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(events.some((e) => e.startsWith('failed'))).toBe(false);
  });

  it('a failed trail download waits for its back-off after the transfers have loaded', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, calls } = setup([watched(1, A)], [stored(A, 'a', 'b')]);
    await w.ingest();
    await calls[0]!.finish();
    // Loads the transfers, which clears the load's own note, then starts the trail.
    await w.ingest();
    expect(events).toContain('restore 1');
    expect(calls[1]!.dest).toBe(trailPaths(dir, stored(A, 'a', 'b')).wallets);
    await calls[1]!.fail(new Error('socket hang up'));
    expect(events).toContain(`failed 1 ${DOWNLOAD_NOTES.failed}`);
    now += 5 * 60_000 - 1;
    await w.ingest();
    expect(calls).toHaveLength(2);
    now += 1;
    await w.ingest();
    expect(calls).toHaveLength(3);
    await calls[2]!.finish();
    await calls[3]!.finish();
  });

  it('a trail download fetches the wallets, then the flows, and its progress counts both', async () => {
    const e = stored(A, 'a', 'b');
    const { w, events, calls } = setup([watched(1, A, { cursorBlock: 950 })], [e], RPC);
    await w.ingest();
    calls[0]!.onProgress(0.5);
    await calls[0]!.finish();
    calls[1]!.onProgress(0.5);
    await calls[1]!.finish();
    const paths = trailPaths(dir, e);
    expect(calls.map((c) => c.dest)).toEqual([paths.wallets, paths.flows]);
    expect(calls.map((c) => [c.url, c.sha])).toEqual([
      [hubUrl('u/d', REV, storedFile(1, A, 'wallets')), e.trail!.files.wallets.sha256],
      [hubUrl('u/d', REV, storedFile(1, A, 'flows')), e.trail!.files.flows.sha256],
    ]);
    // The wallets are 10 of the trail's 100 bytes: half of them is 5%, all of them 10%, and half the flows 55%.
    expect(events.filter((x) => /^(progress|done)/.test(x))).toEqual(['progress 1 trail 0', 'progress 1 trail 0.05', 'progress 1 trail 0.1', 'progress 1 trail 0.55', 'done 1']);
    // Loaded the pass after, checked as it was written.
    await w.ingest();
    expect(events).toContain('import 1');
  });

  it('a trail download stopped after its wallets skips them on the next try', async () => {
    const e = stored(A, 'a', 'b');
    const rows = [watched(1, A, { cursorBlock: 950 })];
    const { w, calls, settle } = setup(rows, [e, stored(B, 'c')], RPC);
    const paths = trailPaths(dir, e);
    await w.ingest();
    await calls[0]!.finish();
    expect(calls[1]!.dest).toBe(paths.flows);
    // Transfers come due during the flows: the trail is stopped.
    rows.push(watched(2, B, { addedAt: Date.now() }));
    await w.ingest();
    expect(calls[1]!.signal.aborted).toBe(true);
    await settle();
    await expect(readFile(paths.wallets, 'utf8')).resolves.toBe(e.trail!.files.wallets.sha256);
    await w.ingest();
    expect(calls[2]!.dest).toBe(join(dir, storedFile(1, B, 'transfers')));
    await calls[2]!.finish();
    await w.ingest();
    expect(calls.slice(3).map((c) => c.dest)).toEqual([paths.flows]);
    await calls[3]!.finish();
  });

  it('a trail file that does not match from its first byte is not fetched again at this publish', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [watched(1, A, { cursorBlock: 950 })];
    const { w, events, calls } = setup(rows, [stored(A, 'a', 'b')], RPC);
    await w.ingest();
    await calls[0]!.finish();
    await calls[1]!.fail(new StoredDataError('does not match its checksum', 'mismatch'));
    expect(events).toContain(`failed 1 ${DOWNLOAD_NOTES.mismatch}`);
    expect(rows[0]!.downloadMismatch).toBe(hubUrl('u/d', REV, storedFile(1, A, 'flows')));
    // Its back-off long over, and the Hub asked again: the same publish, so the same bytes.
    now += 2 * 60 * 60_000;
    await w.ingest();
    expect(calls).toHaveLength(2);
  });

  it('a trail with only its wallets file on disk is not noted and not imported, and its flows are downloaded', async () => {
    const e = stored(A, 'a', 'b');
    const paths = trailPaths(dir, e);
    await writeFile(paths.wallets, e.trail!.files.wallets.sha256);
    const { w, events, calls, store } = setup([watched(1, A, { cursorBlock: 950 })], [e], RPC);
    store.setTrailNote = async (id: number, note: string | null) => { events.push(`note ${id} ${note}`); };
    await w.ingest();
    expect(events.some((x) => x.startsWith('note') || x.startsWith('import'))).toBe(false);
    // The trail is what downloads, and only its flows: its wallets are whole on disk.
    expect(events).toContain('progress 1 trail 0');
    expect(calls.map((c) => c.dest)).toEqual([paths.flows]);
    await calls[0]!.finish();
    expect(events).toContain('progress 1 trail 0.1');
  });

  it('a failed download backs off with a note, and the chain is read meanwhile', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, calls } = setup([watched(1, A)], [stored(A, 'a')], RPC);
    await w.ingest();
    expect(events).not.toContain('served 1');
    // Not analysed while its stored data is on the way: it is analysed once loaded.
    expect(await analyzeDue(w)).toBe('nothing due');
    await calls[0]!.fail(new Error(`fetch failed: ${hubUrl('u/d', REV, storedFile(1, A, 'transfers'))}`));
    expect(events).toContain(`failed 1 ${DOWNLOAD_NOTES.failed}`);
    const said = logged.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('fetch failed');
    expect(said).not.toContain('huggingface.co');
    now += 60_000;
    await w.ingest();
    expect(calls).toHaveLength(1);
    expect(events).toContain('served 1');
    // And analysed on what it has.
    expect(await analyzeDue(w)).toBe('BAYC analyzed');
    now += 4 * 60_000;
    await w.ingest();
    expect(calls).toHaveLength(2);
    await calls[1]!.finish();
  });

  it('a download note goes once the Hub has no stored data', async () => {
    // A download failed and backs off; then the Hub answers 404 (an empty manifest is cached): nothing is wanted, so the note says nothing true.
    const failed = watched(1, A, { downloadNote: DOWNLOAD_NOTES.failed, downloadRetryAt: Date.now() + 60 * 60_000 });
    const { w, events, hub, calls } = setup([failed], [stored(A, 'a')]);
    hub.answer = async () => null;
    await w.ingest();
    expect(calls).toEqual([]);
    expect(events).toContain('unnoted 1 and back-off');
    expect(failed.downloadNote).toBeNull();
  });

  it('a download note goes once the collection is read past its stored data', async () => {
    const past = watched(1, A, { cursorBlock: 950, downloadNote: DOWNLOAD_NOTES.failed, downloadRetryAt: Date.now() + 60 * 60_000 });
    const { w, events, calls } = setup([past], [stored(A, 'a')], RPC);
    await w.ingest();
    expect(calls).toEqual([]);
    expect(events).toContain('unnoted 1 and back-off');
    // Said once: nothing is left to clear on the next pass.
    await w.ingest();
    expect(events.filter((e) => e.startsWith('unnoted'))).toHaveLength(1);
  });

  it('keeps the note of a download that is still wanted and waiting out its back-off', async () => {
    const waiting = watched(1, A, { downloadNote: DOWNLOAD_NOTES.failed, downloadRetryAt: Date.now() + 60 * 60_000 });
    const { w, events } = setup([waiting], [stored(A, 'a')]);
    await w.ingest();
    expect(events.some((e) => e.startsWith('unnoted'))).toBe(false);
  });

  it('a retry clears the failure note when it starts, and keeps its back-off count', async () => {
    const retrying = watched(1, A, { downloadNote: DOWNLOAD_NOTES.failed, downloadRetryAt: Date.now() - 1 });
    const { w, events, calls } = setup([retrying], [stored(A, 'a')]);
    await w.ingest();
    expect(calls).toHaveLength(1);
    expect(events.filter((e) => /^(unnoted|progress)/.test(e))).toEqual(['unnoted 1 only', 'progress 1 transfers 0']);
    await calls[0]!.finish();
  });

  it('says a collection waits for its download while another runs, and clears it when no longer wanted', async () => {
    const rows = [watched(1, A), watched(2, B)];
    const { w, events, calls } = setup(rows, [stored(A, 'a'), stored(B, 'c')]);
    await w.ingest();
    expect(calls).toHaveLength(1);
    // The one running writes its own progress; the one held behind it is marked queued: the file, and no progress.
    expect(events.filter((e) => e.startsWith('progress')).sort()).toEqual(['progress 1 transfers 0', 'progress 2 transfers null']);
    // Said once, not on every pass.
    await w.ingest();
    expect(events.filter((e) => e === 'progress 2 transfers null')).toHaveLength(1);
    // Read past its stored data meanwhile: no longer waiting.
    rows[1]!.cursorBlock = 950;
    await w.ingest();
    expect(events).toContain('progress 2 null null');
    await calls[0]!.finish();
  });

  it('fails a download whose lock connection is lost, and goes on', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, calls, client, settle } = setup([watched(1, A)], [stored(A, 'a')]);
    await w.ingest();
    client.alive = false;
    client.emit('error', new Error('Connection terminated unexpectedly'));
    expect(calls[0]!.signal.aborted).toBe(true);
    await settle();
    expect(events).toContain(`failed 1 ${DOWNLOAD_NOTES.failed}`);
    expect(logged.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('the connection holding its lock was lost (Connection terminated unexpectedly)');
    // Heard while the download ran, and only then: nothing is left listening.
    expect(client.listenerCount('error')).toBe(0);
  });

  it('fails a download within a minute once its lock connection has died without a word', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, calls, client, settle } = setup([watched(1, A)], [stored(A, 'a')]);
    await w.ingest();
    // Bytes keep coming, so it is no stall.
    await appendFile(partPath(calls[0]!.dest, sha('a')), 'x');
    await vi.advanceTimersByTimeAsync(55_000);
    client.alive = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls[0]!.signal.aborted).toBe(true);
    await settle();
    expect(events).toContain(`failed 1 ${DOWNLOAD_NOTES.failed}`);
  });

  it('a full disk says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, calls } = setup([watched(1, A)], [stored(A, 'a')]);
    await w.ingest();
    await calls[0]!.fail(new StoredDataError(`not enough disk space for ${storedFile(1, A, 'transfers')}`, 'disk'));
    expect(events).toContain(`failed 1 ${DOWNLOAD_NOTES.disk}`);
  });

  it('waits out its back-off though the store could not record it, as when the store\'s disk is full too', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, calls, store } = setup([watched(1, A)], [stored(A, 'a')]);
    store.downloadFailed = async () => { throw new Error('could not extend file: No space left on device'); };
    await w.ingest();
    await calls[0]!.fail(new StoredDataError('not enough disk space', 'disk'));
    now += 5 * 60_000 - 1;
    await w.ingest();
    expect(calls).toHaveLength(1);
    now += 1;
    await w.ingest();
    expect(calls).toHaveLength(2);
    await calls[1]!.finish();
  });

  it('fetches the manifest again after a download that does not match it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, calls, hub } = setup([watched(1, A)], [stored(A, 'a')]);
    await w.ingest();
    expect(hub.asked).toBe(1);
    await calls[0]!.fail(new StoredDataError('does not match its checksum', 'mismatch'));
    await w.ingest();
    expect(hub.asked).toBe(2);
    await w.ingest();
    expect(hub.asked).toBe(2);
  });

  it('downloads a file that did not match its checksum again only once the Hub publishes again, reading the chain meanwhile', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [watched(1, A)];
    const { w, events, calls, hub } = setup(rows, [stored(A, 'a')], RPC);
    await w.ingest();
    await calls[0]!.fail(new StoredDataError('does not match its checksum', 'mismatch'));
    expect(events).toContain(`failed 1 ${DOWNLOAD_NOTES.mismatch}`);
    // On the row, so every replica, and this one after a restart, holds it too.
    expect(rows[0]!.downloadMismatch).toBe(hubUrl('u/d', REV, storedFile(1, A, 'transfers')));
    // Its back-off long over, and the Hub asked again: the same publish, so the same bytes.
    now += 2 * 60 * 60_000;
    await w.ingest();
    expect(calls).toHaveLength(1);
    expect(events).toContain('served 1');
    const REV2 = 'beef'.padEnd(40, '0');
    hub.answer = async () => ({ version: 3, revision: REV2, collections: [stored(A, 'a')] });
    now += 61 * 60_000;
    await w.ingest();
    expect(calls.map((c) => c.url)).toEqual([hubUrl('u/d', REV, storedFile(1, A, 'transfers')), hubUrl('u/d', REV2, storedFile(1, A, 'transfers'))]);
    await calls[1]!.finish();
  });

  it('holds a download the row says did not match at this publish, as another replica or this one before a restart found', async () => {
    const { w, calls, events } = setup([watched(1, A, { downloadMismatch: hubUrl('u/d', REV, storedFile(1, A, 'transfers')) })], [stored(A, 'a')], RPC);
    await w.ingest();
    expect(calls).toHaveLength(0);
    expect(events).toContain('served 1');
  });

  it('downloads again from its first byte, after its back-off, a resumed download that did not match: the bytes kept may be what broke', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = [watched(1, A)];
    const { w, events, calls } = setup(rows, [stored(A, 'a')], RPC);
    await writeFile(partPath(join(dir, storedFile(1, A, 'transfers')), sha('a')), 'half, from before a crash');
    await w.ingest();
    await calls[0]!.fail(new StoredDataError('does not match its checksum', 'mismatch'));
    expect(events).toContain(`failed 1 ${DOWNLOAD_NOTES.failed}`);
    expect(rows[0]!.downloadMismatch).toBeNull();
    now += 6 * 60_000;
    await w.ingest();
    expect(calls).toHaveLength(2);
    await calls[1]!.finish();
  });

  it('removes no parts while the Hub says it has no such dataset, as for a repo mistyped in Settings', async () => {
    const part = partPath(join(dir, storedFile(1, A, 'flows')), sha('b'));
    await writeFile(part, 'half');
    const { w, hub } = setup([watched(1, A)], [], RPC);
    hub.answer = async () => null;
    await w.ingest();
    await expect(readFile(part, 'utf8')).resolves.toBe('half');
  });

  it('removes the parts the fetched manifest names no file for, under the download lock, and none while another replica holds it', async () => {
    const stale = partPath(join(dir, storedFile(1, B, 'transfers')), sha('d'));
    const e = stored(A, 'a', 'b');
    const kept = partPath(join(dir, storedFile(1, A, 'flows')), e.trail!.files.flows.sha256);
    await writeFile(stale, 'old');
    await writeFile(kept, 'half');
    // Read past its stored data: nothing downloads, so the lock is the sweep's alone.
    const { w, events, hub } = setup([watched(1, A, { cursorBlock: 950, trailImportedSha: e.trail!.sha256 })], [e], RPC);
    hub.lock = false;
    await w.ingest();
    expect(events).toContain('lock 5');
    await expect(readFile(stale, 'utf8')).resolves.toBe('old');
    hub.lock = true;
    (w.sync as any).hubAskedAt = -Infinity;
    await w.ingest();
    await expect(readFile(stale, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(kept, 'utf8')).resolves.toBe('half');
  });

  it('a stalled download is given up after two minutes', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, events, calls, settle } = setup([watched(1, A)], [stored(A, 'a')]);
    await w.ingest();
    await vi.advanceTimersByTimeAsync(100_000);
    // Bytes came: the two minutes start again.
    await appendFile(partPath(calls[0]!.dest, sha('a')), 'some bytes');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(calls[0]!.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(calls[0]!.signal.aborted).toBe(true);
    await settle();
    expect(events).toContain(`failed 1 ${DOWNLOAD_NOTES.failed}`);
  });

  it('uses the cached manifest when the Hub cannot be reached, and says so once', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = stored(A, 'a');
    await writeManifest(join(dir, 'manifest.json'), { version: 3, revision: REV, collections: [e] });
    await writeFile(join(dir, e.transfers.file), sha('a'));
    const { w, events, hub } = setup([watched(1, A)], [e]);
    hub.answer = async () => { throw new Error('fetch failed: getaddrinfo ENOTFOUND https://huggingface.co/datasets/u/d/resolve/main/manifest.json'); };
    await w.ingest();
    expect(events).toContain('restore 1');
    // A failed fetch is an attempt: not tried again within the hour.
    now += 30 * 60_000;
    await w.ingest();
    expect(hub.asked).toBe(1);
    now += 31 * 60_000;
    await w.ingest();
    expect(hub.asked).toBe(2);
    const lines = () => warned.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('Hugging Face'));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('ENOTFOUND');
    expect(lines()[0]).not.toContain('huggingface.co');
    // Answered, then failing again: said again.
    hub.answer = async () => ({ version: 3, revision: REV, collections: [e] });
    now += 61 * 60_000;
    await w.ingest();
    hub.answer = async () => { throw new Error('fetch failed'); };
    now += 61 * 60_000;
    await w.ingest();
    expect(lines()).toHaveLength(2);
  });

  it('takes a Hub with no manifest as no stored data, and empties the older one on disk', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = stored(A, 'a');
    await writeManifest(join(dir, 'manifest.json'), { version: 3, revision: REV, collections: [e] });
    await writeFile(join(dir, e.transfers.file), sha('a'));
    const { w, events, calls, hub } = setup([watched(1, A)], [e]);
    hub.answer = async () => null;
    await w.ingest();
    expect(events).not.toContain('restore 1');
    expect(calls).toEqual([]);
    expect(await analyzeDue(w)).toBe('BAYC analyzed');
    // The cache now says the Hub has none, so the console quotes nothing either.
    const cached = await readManifest(join(dir, 'manifest.json'));
    expect(cached).toEqual({ version: 3, collections: [] });
    expect(cached.revision).toBeUndefined();
  });

  it('takes a 401 from the Hub (no such public dataset) as no stored data, and empties the cache', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = stored(A, 'a');
    await writeManifest(join(dir, 'manifest.json'), { version: 3, revision: REV, collections: [e] });
    const { w, calls } = setup([watched(1, A)], [e]);
    // The real method, over a Hub that answers 401 (and 503 below).
    vi.mocked(StoredSync.prototype.fetchHubManifest).mockRestore();
    delete (w.sync as any).fetchHubManifest;
    const answer = vi.fn(async () => new Response(null, { status: 401, headers: { 'x-error-code': 'RepoNotFound' } }));
    vi.stubGlobal('fetch', answer);
    try {
      await w.ingest();
      expect(answer).toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(await readManifest(join(dir, 'manifest.json'))).toEqual({ version: 3, collections: [] });
      // A Hub that is down is not "no dataset": the cache stays.
      await writeManifest(join(dir, 'manifest.json'), { version: 3, revision: REV, collections: [e] });
      answer.mockImplementation(async () => new Response(null, { status: 503 }));
      await expect(w.sync.fetchHubManifest('u/d')).rejects.toMatchObject({ status: 503 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('re-fetches the manifest at most hourly, and when a collection is newly watched', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const rows = [watched(1, A, { cursorBlock: 950 })];
    const { w, hub } = setup(rows, [stored(A, 'a')], RPC);
    await w.ingest();
    expect(hub.asked).toBe(1);
    now += 30 * 60_000;
    await w.ingest();
    // Only ingest fetches: an analysis reads what is on disk.
    await analyzeDue(w);
    expect(hub.asked).toBe(1);
    // A paused collection is no new watch.
    rows.push(watched(2, B, { addedAt: now, pausedAt: now }));
    now += 1;
    await w.ingest();
    expect(hub.asked).toBe(1);
    rows.push(watched(3, C, { addedAt: now, cursorBlock: 950 }));
    now += 1;
    await w.ingest();
    expect(hub.asked).toBe(2);
    now += 59 * 60_000;
    await w.ingest();
    expect(hub.asked).toBe(2);
    now += 2 * 60_000;
    await w.ingest();
    expect(hub.asked).toBe(3);
    // Another repo set in the console: asked at once.
    hub.repo = 'someone/else';
    now += 1;
    await w.ingest();
    expect(hub.asked).toBe(4);
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
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b'] }, { collectionId: 2, wallets: ['c'] }, { collectionId: null, wallets: ['f'] }] }),
      heartbeat: async (_job: string, doing: string | null) => { beats.push(doing); },
      rereadFrom: async () => null,
      saveMoney: async (_chain: number, wallet: string) => { funded.push(wallet); },
      moneyFailed: async () => {},
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    expect(await w.fund()).toBe('4 wallets read, 0 failed');
    expect(funded).toEqual(['c', 'a', 'f', 'b']);
    expect(beats).toEqual(['Checking wallets for Doodles', 'Checking wallets for BAYC', 'Checking wallets for followed wallets', 'Checking wallets for BAYC']);
  });

  it('asks for lanes within the hops it follows, so a lowered setting stops the deeper wallets queued before', async () => {
    const asked: number[] = [];
    const store: any = {
      collections: async () => [row({ id: 1 })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async (_chain: number, _perLane: number, hops: number) => { asked.push(hops); return { lanes: [] }; },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 1, tokensPayees: false, storedRepo: 'u/d', sources: {} }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    expect(asked).toEqual([1]);
  });

  it('gives each wallet read a budget, so one busy wallet cannot hold the pass past its stuck ceiling', async () => {
    const budgets: (number | undefined)[] = [];
    const store: any = {
      collections: async () => [row({ id: 1 })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['0xa'] }] }),
      rereadFrom: async () => null,
      saveMoney: async () => {},
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, storedRepo: 'u/d', sources: {} }), '');
    (w as any).etherscanClient = () => ({ flows: async (_c: number, _w: string, budgetMs?: number) => { budgets.push(budgetMs); return { flows: [], truncated: false }; } });
    await w.fund();
    expect(budgets).toEqual([WALLET_MS]);
  });
});

describe('Worker.fund reading traders again', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads a wallet due a re-read from the block after its last read, and a first read in full', async () => {
    const asked: unknown[][] = [];
    const saved: unknown[][] = [];
    const store: any = {
      collections: async () => [row({ id: 1 })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['old', 'new'] }] }),
      rereadFrom: async (_c: number, wallet: string, kind: string) => { expect(kind).toBe('money'); return wallet === 'old' ? 501 : null; },
      saveMoney: async (...args: unknown[]) => { saved.push(args.slice(1)); },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, storedRepo: 'u/d', sources: {} }), '');
    (w as any).etherscanClient = () => ({ flows: async (_c: number, wallet: string, _b: number, from?: number) => { asked.push([wallet, from]); return { flows: [], truncated: false, through: 900 }; } });
    await w.fund();
    expect(asked).toEqual([['old', 501], ['new', undefined]]);
    expect(saved).toEqual([['old', [], false, undefined, 900, true], ['new', [], false, undefined, 900, false]]);
  });

  it('reads a trader\'s tokens again the same way', async () => {
    const asked: unknown[][] = [];
    const saved: unknown[][] = [];
    const store: any = {
      collections: async () => [row({ id: 1, readTokens: true })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0, countTokens: async () => {},
      tokenLanes: async () => ({ lanes: [{ collectionId: 1, wallets: pending.slice() }] }),
      moneyLanes: async () => ({ lanes: [] }),
      heartbeat: async () => {},
      rereadFrom: async (_c: number, wallet: string, kind: string) => { expect(kind).toBe('tokens'); return wallet === 'old' ? 77 : null; },
      saveTokens: async (_c: number, wallet: string, ...rest: unknown[]) => { saved.push([wallet, ...rest]); pending.splice(pending.indexOf(wallet), 1); },
    };
    const pending = ['old', 'new'];
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, storedRepo: 'u/d', sources: {} }), '');
    (w as any).etherscanClient = () => ({ tokenFlows: async (_c: number, wallet: string, _b: number, from?: number) => { asked.push([wallet, from]); return { flows: [], truncated: false, through: 80 }; } });
    await w.fund();
    expect(asked).toEqual([['old', 77], ['new', undefined]]);
    expect(saved).toEqual([['old', [], false, 80, true], ['new', [], false, 80, false]]);
  });
});

describe('Worker.fund when Etherscan fails the key or the service', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  /** A fund pass over wallets a, b, c and a token read of t, with the real Etherscan client answering through `reply`. */
  const setup = (reply: (url: URL) => Response, readTokens = false) => {
    const marked: string[] = [];
    const saved: string[] = [];
    const store: any = {
      collections: async () => [row({ id: 1, readTokens })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      tokenLanes: async () => ({ lanes: [{ collectionId: 1, wallets: saved.includes('t') ? [] : ['t'] }] }),
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b', 'c'] }] }),
      heartbeat: async () => {},
      rereadFrom: async () => null,
      saveMoney: async (_c: number, wallet: string) => { saved.push(wallet); },
      saveTokens: async (_c: number, wallet: string) => { saved.push(wallet); },
      moneyFailed: async (_c: number, wallet: string) => { marked.push(`money ${wallet}`); },
      tokensFailed: async (_c: number, wallet: string) => { marked.push(`tokens ${wallet}`); },
      countTokens: async () => {},
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k-SECRET', etherscanPerSecond: 1_000, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    const asked: string[] = [];
    const etherscan = new Etherscan('k-SECRET', 1_000);
    etherscan.fetch = async (url: URL) => { asked.push(url.searchParams.get('address') ?? ''); return reply(url); };
    (w as any).etherscanClient = () => etherscan;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { w, marked, saved, asked };
  };
  /** The pass, with Etherscan's rate-limit waits skipped; resolves to its result or its error's message. */
  const pass = async (w: Worker) => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const done = w.fund().catch((err: Error) => `threw ${err.message}`);
    await vi.advanceTimersByTimeAsync(20_000);
    return done;
  };

  it('ends the pass on an invalid key without marking the wallet, and says why', async () => {
    const { w, marked, asked } = setup(() => answer({ status: '0', message: 'NOTOK', result: 'Invalid API Key k-SECRET' }));
    const result = await pass(w);
    expect(marked).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(result).toContain('threw Etherscan key or quota: Etherscan refused txlist: Invalid API Key');
    expect(result).not.toContain('k-SECRET');
  });

  it('ends the pass on an exhausted daily limit without marking the wallet', async () => {
    const { w, marked } = setup(() => answer({ status: '0', message: 'NOTOK', result: 'Max daily rate limit reached. Limit is 100000 calls per day' }));
    expect(await pass(w)).toContain('Max daily rate limit reached');
    expect(marked).toEqual([]);
  });

  it('ends the pass on HTTP 429 without marking the wallet', async () => {
    const { w, marked, asked } = setup(() => answer({}, 429));
    expect(await pass(w)).toContain('HTTP 429');
    expect(marked).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it('ends the pass on a key failure met in a token read, without marking that wallet', async () => {
    const { w, marked, asked } = setup(() => answer({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }), true);
    expect(await pass(w)).toContain('Invalid API Key');
    expect(marked).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it('marks a wallet the gateway answers 503 for, as before', async () => {
    const { w, marked } = setup(() => answer({}, 503));
    expect(await pass(w)).toBe('0 wallets read, 3 failed');
    expect(marked).toEqual(['money a', 'money b', 'money c']);
  });

  it('keeps reading the other wallets when one always draws a 504, pass after pass', async () => {
    const { w, marked, saved } = setup((url) => url.searchParams.get('address') === 'a'
      ? answer({}, 504)
      : answer({ status: '0', message: 'No transactions found', result: [] }));
    expect(await pass(w)).toBe('2 wallets read, 1 failed');
    expect(await pass(w)).toBe('2 wallets read, 1 failed');
    expect(marked).toEqual(['money a', 'money a']);
    expect(saved).toEqual(['b', 'c', 'b', 'c']);
  });

  it('logs a pass that fails the same way once until it next succeeds, and records every failure', async () => {
    let key = false;
    const outcomes: string[] = [];
    const store: any = {
      locked: async (_k: number, _w: boolean, fn: (c: unknown) => Promise<void>) => { await fn(lockClient()); return 'ran'; },
      settings: async () => new Map(), reportSources: async () => {},
      passStarted: async () => {}, passFinished: async (_j: string, _ms: number, outcome: string) => { outcomes.push(outcome); },
      heartbeat: async () => {},
      collections: async () => [row({ id: 1 })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a'] }] }),
      rereadFrom: async () => null,
      saveMoney: async () => {},
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 1_000, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    const etherscan = new Etherscan('k', 1_000);
    etherscan.fetch = async () => key
      ? new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }))
      : new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }));
    (w as any).etherscanClient = () => etherscan;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    key = true;
    for (let i = 0; i < 3; i++) await w.run('fund');
    expect(errors).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(['failed', 'failed', 'failed']);
    key = false;
    await w.run('fund');
    key = true;
    await w.run('fund');
    expect(errors).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual(['failed', 'failed', 'failed', 'ok', 'failed']);
  });

  it('still marks a wallet whose own read is refused, and goes on to the next', async () => {
    const { w, marked, saved } = setup((url) => url.searchParams.get('address') === 'a'
      ? answer({ status: '0', message: 'NOTOK', result: 'Error! Invalid address format' })
      : answer({ status: '0', message: 'No transactions found', result: [] }));
    expect(await pass(w)).toBe('2 wallets read, 1 failed');
    expect(marked).toEqual(['money a']);
    expect(saved).toEqual(['b', 'c']);
  });
});

describe('Worker.fund following a collection further, and counting its next hop', () => {
  afterEach(() => vi.restoreAllMocks());

  const config = (): WorkerConfig => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 3, tokensPayees: false, sources: {}, storedRepo: 'u/d' });
  /** A clock only the test moves. */
  const clock = () => {
    const t = { now: 1_000_000 };
    vi.spyOn(Date, 'now').mockImplementation(() => t.now);
    return t;
  };

  it('fund seeds in chunks within its budget, then funds', async () => {
    const t = clock();
    const calls: string[] = [];
    const beats: (string | null)[] = [];
    const store: any = {
      collections: async () => [row({ id: 1, name: 'BAYC' })],
      nextSpot: async () => null, nextCount: async () => null,
      // Each chunk takes four seconds, and there is always more.
      seedReach: async (chainId: number, hops: number, limit: number) => { calls.push(`seed ${chainId} ${hops} ${limit}`); t.now += 4_000; return 2_000; },
      moneyLanes: async () => { calls.push('lanes'); return { lanes: [{ collectionId: 1, wallets: ['a'] }] }; },
      heartbeat: async (_job: string, doing: string | null) => { beats.push(doing); },
      rereadFrom: async () => null,
      saveMoney: async (_chain: number, wallet: string) => { calls.push(`fund ${wallet}`); },
      moneyFailed: async () => {},
    };
    const w = new Worker(store, config, '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    expect(await w.fund()).toBe('1 wallets read, 0 failed');
    // Chunks at 0, 4 and 8 seconds in: the third ends past SEED_MS, so the rest waits for the next pass.
    expect(SEED_MS).toBe(10_000);
    expect(calls).toEqual(['seed 1 3 2000', 'seed 1 3 2000', 'seed 1 3 2000', 'lanes', 'fund a']);
    expect(beats).toEqual([...Array(3).fill("Finding watched collections' wallets from the money already read"), 'Checking wallets for BAYC']);

    // Each chain has its own SEED_MS: a long walk on the first leaves the second its turn.
    calls.length = 0;
    store.collections = async () => [row({ id: 1, name: 'BAYC' }), row({ id: 2, chainId: 8453, name: 'Base one' })];
    store.moneyLanes = async (chainId: number) => { calls.push(`lanes ${chainId}`); return { lanes: [] }; };
    await w.fund();
    expect(calls).toEqual([...Array(3).fill('seed 1 3 2000'), 'lanes 1', ...Array(3).fill('seed 8453 3 2000'), 'lanes 8453']);

    // Nothing left to walk: one call says so, and the checking starts.
    store.collections = async () => [row({ id: 1, name: 'BAYC' })];
    store.moneyLanes = async () => { calls.push('lanes'); return { lanes: [{ collectionId: 1, wallets: ['a'] }] }; };
    calls.length = 0;
    store.seedReach = async () => { calls.push('seed'); return 0; };
    await w.fund();
    expect(calls).toEqual(['seed', 'lanes', 'fund a']);
  });

  it('counts the stalest estimate after its funding, in the time kept for it', async () => {
    const t = clock();
    const calls: string[] = [];
    const beats: [string | null, number | null][] = [];
    const store: any = {
      collections: async () => [row({ id: 1, name: 'BAYC' }), row({ id: 7, name: 'Doodles' })],
      nextSpot: async () => null, nextCount: async (hops: number) => { calls.push(`next ${hops}`); return 7; },
      seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b', 'c', 'd', 'e', 'f'] }] }),
      heartbeat: async (_job: string, doing: string | null, id: number | null) => { beats.push([doing, id]); },
      // Each wallet takes ten seconds.
      rereadFrom: async () => null,
      saveMoney: async (_chain: number, wallet: string) => { calls.push(`fund ${wallet}`); t.now += 10_000; },
      moneyFailed: async () => {},
      countNext: async (id: number, hops: number, timeoutMs: number) => { calls.push(`count ${id} ${hops} ${timeoutMs}`); return 'counted'; },
    };
    const w = new Worker(store, config, '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    expect(await w.fund()).toBe('4 wallets read, 0 failed');
    // The checking stops COUNT_TIMEOUT_MS short of the budget: d starts at 30 seconds in, e would at 40, and the count has the rest.
    expect(BUDGET_MS - COUNT_TIMEOUT_MS).toBe(30_000);
    // At 40 seconds in, 5 are left: less than COUNT_TIMEOUT_MS, so the count is given those.
    expect(calls).toEqual(['next 3', 'fund a', 'fund b', 'fund c', 'fund d', 'count 7 3 5000']);
    expect(beats.at(-1)).toEqual(['Counting the next wallets out for Doodles', 7]);

    // None due: the checking has the whole budget.
    calls.length = 0;
    store.nextCount = async () => null;
    expect(await w.fund()).toBe('5 wallets read, 0 failed');
    expect(calls).toEqual(['fund a', 'fund b', 'fund c', 'fund d', 'fund e']);
  });

  it('a count that fails fails no checking, and says why without a secret', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const funded: string[] = [];
    const store: any = {
      collections: async () => [row({ id: 1 })],
      nextSpot: async () => null, nextCount: async () => 1,
      seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a'] }] }),
      heartbeat: async () => {}, moneyFailed: async () => {},
      rereadFrom: async () => null,
      saveMoney: async (_chain: number, wallet: string) => { funded.push(wallet); },
      countNext: async () => { throw new Error('canceling statement due to statement timeout (key k-SECRET)'); },
    };
    const w = new Worker(store, () => ({ ...config(), etherscanKey: 'k-SECRET' }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    expect(await w.fund()).toBe('1 wallets read, 0 failed');
    expect(funded).toEqual(['a']);
    expect(error).toHaveBeenCalledTimes(1);
    const said = error.mock.calls[0]!.map(String).join(' ');
    expect(said).toContain('statement timeout');
    expect(said).not.toContain('k-SECRET');
  });
});

describe('Worker.fund reading tokens', () => {
  afterEach(() => vi.restoreAllMocks());

  const config = (more: Partial<WorkerConfig> = {}): WorkerConfig => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 3, tokensPayees: false, sources: {}, storedRepo: 'u/d', ...more });
  const clock = () => {
    const t = { now: 1_000_000 };
    vi.spyOn(Date, 'now').mockImplementation(() => t.now);
    return t;
  };
  /** A store whose token lanes hold `pending` wallets for collection 1, handing each out until read. */
  const setup = (calls: string[], pending: string[], t?: { now: number }, readMs = 0, check = ['m1', 'm2']) => {
    const checking = [...check];
    const store: any = {
      collections: async () => [row({ id: 1, name: 'BAYC', readTokens: true })],
      nextSpot: async () => null, nextCount: async () => null,
      seedReach: async (_c: number, hops: number) => { calls.push(`seed ${hops}`); return 0; },
      tokenLanes: async (chain: number, perLane: number, hops: number, payees: boolean) => { calls.push(`lanes ${chain} ${perLane} ${hops} ${payees}`); return { lanes: [{ collectionId: 1, wallets: pending.slice(0, perLane) }] }; },
      moneyLanes: async () => { calls.push('moneyLanes'); return { lanes: [{ collectionId: 1, wallets: checking.splice(0) }] }; },
      heartbeat: async (_j: string, doing: string | null) => { calls.push(`beat ${doing}`); },
      rereadFrom: async () => null,
      saveMoney: async (_c: number, wallet: string) => { calls.push(`check ${wallet}`); if (t) t.now += 1_000; },
      moneyFailed: async () => {},
      saveTokens: async (_c: number, wallet: string, _f: unknown, truncated: boolean) => { calls.push(`save ${wallet} ${truncated}`); pending.splice(pending.indexOf(wallet), 1); if (t) t.now += readMs; },
      tokensFailed: async (_c: number, wallet: string) => { calls.push(`tokfail ${wallet}`); pending.splice(pending.indexOf(wallet), 1); },
      countTokens: async (chain: number, hops: number, payees: boolean) => { calls.push(`count ${chain} ${hops} ${payees}`); },
    };
    return store;
  };

  it('reads tokens after seeding and before checking, on the same global limit, then reads on and counts after the checking', async () => {
    const calls: string[] = [];
    const store = setup(calls, ['t1', 't2']);
    const w = new Worker(store, () => config({ tokensPayees: true }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }), tokenFlows: async (_c: number, wallet: string, budget: number) => { calls.push(`read ${wallet} ${budget}`); return { flows: [], truncated: wallet === 't2' }; } });
    expect(await w.fund()).toBe('2 wallets read, 0 failed');
    expect(calls.filter((c) => !c.startsWith('beat'))).toEqual([
      'seed 3', 'lanes 1 20 3 true', 'read t1 360000', 'save t1 false', 'read t2 360000', 'save t2 true', 'lanes 1 20 3 true',
      'moneyLanes', 'check m1', 'check m2', 'lanes 1 20 3 true', 'count 1 3 true',
    ]);
    expect(calls).toContain('beat Reading other tokens for BAYC');
  });

  it('keeps the token slice to TOKENS_MS, and the leftover reads to the check deadline, which keeps TOKEN_COUNT_MS for the counts', async () => {
    const t = clock();
    const calls: string[] = [];
    // Each read takes four seconds, and there are always more.
    const pending = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const store = setup(calls, pending, t, 4_000, []);
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ tokenFlows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    // Reads start at 0, 4 and 8 seconds in; the next would start past TOKENS_MS. Then checking has nothing, so the unused time reads on.
    expect(TOKENS_MS).toBe(10_000);
    const firstSlice = calls.indexOf('moneyLanes');
    expect(calls.slice(0, firstSlice).filter((c) => c.startsWith('save'))).toHaveLength(3);
    // Reads stop at BUDGET_MS - TOKEN_COUNT_MS: the last starts at 36 seconds, ends at 40.
    expect(calls.filter((c) => c.startsWith('save'))).toHaveLength(10);
    expect(t.now - 1_000_000).toBeLessThanOrEqual(BUDGET_MS - TOKEN_COUNT_MS);
  });

  it('hands the token lanes the slice\'s deadline, so asking for them never runs past it', async () => {
    const t = clock();
    const calls: string[] = [];
    const store = setup(calls, [], t);
    const untils: number[] = [];
    store.tokenLanes = async (_c: number, _p: number, _h: number, _y: boolean, until: number) => { untils.push(until); return { lanes: [] }; };
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    // The slice before checking (TOKENS_MS from its start), then the leftover reads (the check deadline, after two one-second checks).
    expect(untils).toEqual([1_000_000 + TOKENS_MS, 1_000_000 + BUDGET_MS - TOKEN_COUNT_MS]);
  });

  it('takes what checking leaves unused', async () => {
    const t = clock();
    const calls: string[] = [];
    const pending = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const store = setup(calls, pending, t, 4_000, ['m1']);
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }), tokenFlows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    const plain = calls.filter((c) => c.startsWith('save') || c.startsWith('check'));
    // Three before checking, the check, then the rest.
    expect(plain).toEqual(['save t1 false', 'save t2 false', 'save t3 false', 'check m1', 'save t4 false', 'save t5 false', 'save t6 false']);
  });

  it('notes a failed token read and fails no money check', async () => {
    const calls: string[] = [];
    const store = setup(calls, ['t1']);
    const w = new Worker(store, () => config({ etherscanKey: 'k-SECRET' }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }), tokenFlows: async () => { throw new Error('boom k-SECRET'); } });
    const noted: string[] = [];
    store.tokensFailed = async (_c: number, wallet: string, error: string) => { noted.push(error); calls.push(`tokfail ${wallet}`); };
    store.tokenLanes = async () => ({ lanes: calls.includes('tokfail t1') ? [] : [{ collectionId: 1, wallets: ['t1'] }] });
    expect(await w.fund()).toBe('2 wallets read, 0 failed');
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain('boom');
    expect(noted[0]).not.toContain('k-SECRET');
  });

  it('reads no tokens with no key', async () => {
    const calls: string[] = [];
    const store = setup(calls, ['t1']);
    const w = new Worker(store, () => config({ etherscanKey: null }), '');
    expect(await w.fund()).toBe('no funding source configured');
    expect(calls).toEqual([]);
  });

  it('counts each chain with a started collection, and touches no token SQL for one with none', async () => {
    const calls: string[] = [];
    const store = setup(calls, []);
    store.collections = async () => [row({ id: 1, readTokens: true }), row({ id: 2, chainId: 8453, name: 'Base one' })];
    store.moneyLanes = async () => ({ lanes: [] });
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ tokenFlows: async () => { throw new Error('not called'); } });
    await w.fund();
    // The slice before checking, the leftover slice after it, and the count.
    expect(calls.filter((c) => c.startsWith('count') || c.startsWith('lanes'))).toEqual(['lanes 1 20 3 false', 'lanes 1 20 3 false', 'count 1 3 false']);

    // None started anywhere: no token call and no token SQL.
    calls.length = 0;
    store.collections = async () => [row({ id: 1 })];
    await w.fund();
    expect(calls.filter((c) => c.startsWith('count') || c.startsWith('lanes'))).toEqual([]);
  });

  it('a count that fails fails no checking, and says why without a secret', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    const store = setup(calls, []);
    store.countTokens = async () => { throw new Error('canceling statement (key k-SECRET)'); };
    const w = new Worker(store, () => config({ etherscanKey: 'k-SECRET' }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    expect(await w.fund()).toBe('2 wallets read, 0 failed');
    expect(error.mock.calls[0]!.map(String).join(' ')).not.toContain('k-SECRET');
  });

  /** Two chains, each with a started collection, whose lanes and money wallets the test names. */
  const twoChains = (calls: string[], t: { now: number }, money: Record<number, string[]>, checkMs: number) => {
    const pending: Record<number, string[]> = { 1: ['a1', 'a2', 'a3', 'a4'], 8453: ['b1', 'b2'] };
    const store: any = {
      collections: async () => [row({ id: 1, name: 'BAYC', readTokens: true }), row({ id: 2, chainId: 8453, name: 'Base one', readTokens: true })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      tokenLanes: async (chain: number) => { calls.push(`lanes ${chain}`); return { lanes: [{ collectionId: chain === 1 ? 1 : 2, wallets: pending[chain]!.slice() }] }; },
      moneyLanes: async (chain: number) => ({ lanes: [{ collectionId: chain === 1 ? 1 : 2, wallets: money[chain]!.splice(0) }] }),
      heartbeat: async () => {},
      rereadFrom: async () => null,
      saveMoney: async (chain: number, wallet: string) => { calls.push(`check ${chain} ${wallet}`); t.now += checkMs; },
      moneyFailed: async () => {},
      saveTokens: async (chain: number, wallet: string) => { calls.push(`save ${chain} ${wallet}`); pending[chain]!.splice(pending[chain]!.indexOf(wallet), 1); t.now += chain === 1 ? 4_000 : 1_000; },
      tokensFailed: async () => {},
      countTokens: async (chain: number, _h: number, _p: boolean, until: number) => { calls.push(`count ${chain} ${until}`); t.now += Math.max(0, Math.min(TOKEN_COUNT_MS, until - t.now)); },
    };
    return store;
  };

  it('gives every chain its slice and its checking before any chain takes leftover reads, and counts them all', async () => {
    const t = clock();
    const calls: string[] = [];
    const store = twoChains(calls, t, { 1: ['m1'], 8453: ['m2'] }, 1_000);
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ tokenFlows: async () => ({ flows: [], truncated: false }), flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    const order = calls.filter((c) => !c.startsWith('lanes'));
    const firstCount = order.findIndex((c) => c.startsWith('count'));
    // Chain 1's slice and check, then chain 2's, and only then the leftover reads (the other wallets of the lanes) and the counts.
    expect(order.slice(0, firstCount)).toEqual(['save 1 a1', 'save 1 a2', 'save 1 a3', 'check 1 m1', 'save 8453 b1', 'save 8453 b2', 'check 8453 m2', 'save 1 a4']);
    expect(order.slice(firstCount).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['count 1', 'count 8453']);
  });

  it('counts a chain checking never reached, when chain 1\'s checking runs to the check deadline', async () => {
    const t = clock();
    const calls: string[] = [];
    const store = twoChains(calls, t, { 1: Array.from({ length: 100 }, (_, i) => `m${i}`), 8453: ['x'] }, 1_000);
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ tokenFlows: async () => ({ flows: [], truncated: false }), flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    expect(calls.some((c) => c === 'check 8453 x')).toBe(false);
    expect(calls.filter((c) => c.startsWith('count')).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual(['count 1', 'count 8453']);
  });

  it.each([[false], [true]])('a count that takes time leaves the pass within BUDGET_MS (countNext due: %s)', async (due) => {
    const t = clock();
    const calls: string[] = [];
    const store = twoChains(calls, t, { 1: Array.from({ length: 100 }, (_, i) => `m${i}`), 8453: [] }, 1_000);
    const begun = t.now;
    store.nextCount = async () => (due ? 2 : null);
    store.countNext = async (_id: number, _h: number, timeoutMs: number) => { calls.push('countNext'); t.now += timeoutMs; };
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ tokenFlows: async () => ({ flows: [], truncated: false }), flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    expect(t.now - begun).toBeLessThanOrEqual(BUDGET_MS);
    expect(calls.includes('countNext')).toBe(due);
    // The last count ends by the one deadline: BUDGET_MS, less COUNT_TIMEOUT_MS when the estimate is due.
    const untils = calls.filter((c) => c.startsWith('count ')).map((c) => Number(c.split(' ')[2]));
    expect(untils.at(-1)).toBe(begun + BUDGET_MS - (due ? COUNT_TIMEOUT_MS : 0));
  });

  it('gives each chain an equal share of the counting time left, so a count that always runs out cannot starve the next chain', async () => {
    const t = clock();
    const calls: string[] = [];
    const store = twoChains(calls, t, { 1: Array.from({ length: 100 }, (_, i) => `m${i}`), 8453: [] }, 1_000);
    const begun = t.now;
    const counted: { chain: number; from: number; until: number }[] = [];
    // Chain 1's count always runs to its deadline; Base's takes one second.
    store.countTokens = async (chain: number, _h: number, _p: boolean, until: number) => {
      counted.push({ chain, from: t.now, until });
      t.now = chain === 1 ? Math.max(t.now, until) : t.now + 1_000;
    };
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ tokenFlows: async () => ({ flows: [], truncated: false }), flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    const countUntil = begun + BUDGET_MS;
    const [first, second] = counted;
    expect(counted.map((c) => c.chain)).toEqual([1, 8453]);
    // Half of what is left for chain 1, and the rest, still most of a share, for Base, counted within it.
    expect(first!.until).toBe(first!.from + Math.floor((countUntil - first!.from) / 2));
    expect(second!.from).toBe(first!.until);
    expect(second!.until).toBe(countUntil);
    expect(second!.until - second!.from).toBeGreaterThanOrEqual(1_000);
    expect(t.now).toBeLessThanOrEqual(countUntil);
  });

  it('leaves the time a chain did not use to the chains after it', async () => {
    const t = clock();
    const calls: string[] = [];
    const store = twoChains(calls, t, { 1: Array.from({ length: 100 }, (_, i) => `m${i}`), 8453: [] }, 1_000);
    const begun = t.now;
    const counted: { from: number; until: number }[] = [];
    store.countTokens = async (_c: number, _h: number, _p: boolean, until: number) => { counted.push({ from: t.now, until }); };
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ tokenFlows: async () => ({ flows: [], truncated: false }), flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    // Chain 1 finished at once, so Base had all of it.
    expect(counted[1]).toEqual({ from: counted[0]!.from, until: begun + BUDGET_MS });
  });

  it('with no started collection, checking runs to the count deadline and no token call is made', async () => {
    const t = clock();
    const calls: string[] = [];
    const store: any = {
      collections: async () => [row({ id: 1 })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: Array.from({ length: 100 }, (_, i) => `m${i}`) }] }),
      heartbeat: async () => {}, moneyFailed: async () => {},
      rereadFrom: async () => null,
      saveMoney: async () => { calls.push('check'); t.now += 1_000; },
      tokenLanes: async () => { calls.push('tokenLanes'); return { lanes: [] }; },
      countTokens: async () => { calls.push('countTokens'); },
    };
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    // checkUntil = deadline: a wallet starts at each of seconds 0 to 45.
    expect(calls.filter((c) => c === 'check')).toHaveLength(46);
    expect(calls.filter((c) => c !== 'check')).toEqual([]);
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
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async (chainId: number) => ({ lanes: lanes[chainId] }),
      heartbeat: async () => {}, moneyFailed: async () => {},
      rereadFrom: async () => null,
      saveMoney: async (_chain: number, wallet: string) => { funded.push(wallet); },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    expect(funded).toEqual(['a1', 'b1', 'x1', 'b2', 'x2']);
  });

  it('gives a paused collection\'s priority to no one, and a live prioritised one its turns', async () => {
    const funded: string[] = [];
    const store: any = {
      // Two prioritised, the first paused: its lane is not served (the store leaves it out), so its priority must not hide the other's.
      collections: async () => [row({ id: 1, name: 'BAYC', priority: true, pausedAt: 5 }), row({ id: 2, name: 'Doodles', priority: true }), row({ id: 3, name: 'Azuki' })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 3, wallets: ['x1', 'x2'] }, { collectionId: 2, wallets: ['c1', 'c2'] }] }),
      heartbeat: async () => {}, moneyFailed: async () => {},
      rereadFrom: async () => null,
      saveMoney: async (_chain: number, wallet: string) => { funded.push(wallet); },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    await w.fund();
    expect(funded).toEqual(['c1', 'x1', 'c2', 'x2']);
  });
});

describe('Worker heartbeat', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const config = (): WorkerConfig => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' });

  it('does not fail a funding pass when the heartbeat write throws, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const funded: string[] = [];
    const store: any = {
      collections: async () => [row({ id: 1, name: 'BAYC' })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b'] }] }),
      heartbeat: async () => { throw new Error('db down'); },
      rereadFrom: async () => null,
      saveMoney: async (_chain: number, wallet: string) => { funded.push(wallet); },
      moneyFailed: async () => {},
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
      locked: async (_key: number, _wait: boolean, fn: (c: unknown) => Promise<void>) => { await fn(lockClient()); return 'ran'; },
      passStarted: async () => {}, passFinished: async () => {}, settings: async () => new Map(), reportSources: async () => {},
      sweepPreviews: async () => 0, fillRings: async () => false, nextPreview: async () => null, nextLensRun: async () => null,
      heartbeat: async (job: string, doing: string | null, id: number | null) => { beats.push([job, doing, id]); },
    };
    const w = new Worker(store, config, '');
    w.dueAnalysis = async () => ({ id: 7, chainId: 1, version: 1, rules: {}, name: 'Terraforms', ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null });
    (w as any).analyzeOne = async () => {
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
      locked: async (_key: number, _wait: boolean, fn: (c: unknown) => Promise<void>) => { await fn(lockClient()); return 'ran'; },
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
      locked: async (_key: number, _wait: boolean, fn: (c: unknown) => Promise<void>) => { await fn(lockClient()); return 'ran'; },
      passStarted: async () => {}, passFinished: async () => {}, heartbeat: async () => {},
      settings: async () => new Map([['follow.hops', '2']]),
      reportSources: async (s: unknown) => { reported.push(s); },
      sweepPreviews: async () => 0, fillRings: async () => false, nextPreview: async () => null, nextLensRun: async () => null,
      ...more,
    };
    return { store, reported };
  }

  /** `w` with an analysis due whose body is `body`, so each analyze pass runs it. */
  function analysing(w: Worker, body: () => Promise<string>): Worker {
    w.dueAnalysis = async () => ({ id: 1, chainId: 1, version: 1, rules: {}, name: 'Lab', ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null });
    (w as any).analyzeOne = body;
    return w;
  }

  it('loads the console settings once a pass, gives them to config, and reports where each came from', async () => {
    let reads = 0;
    const { store, reported } = stub({ settings: async () => { reads += 1; return new Map([['follow.hops', '2']]); } });
    const seen: ReadonlyMap<string, string>[] = [];
    const sources = { 'follow.hops': { source: 'console' as const, value: '2', env: null } };
    const w = new Worker(store, (s) => {
      seen.push(s);
      return { rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: Number(s.get('follow.hops') ?? 0), tokensPayees: false, sources, storedRepo: 'u/d' };
    }, '');
    let hops = -1;
    analysing(w, async () => { hops = (w as any).config((w as any).settings).followHops; return 'done'; });
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
      // The analyze row's: each pass also notes on the lens row why it ran no lens work.
      passFinished: async (job: string, _ms: number, outcome: string) => { if (job === 'analyze') finished.push(outcome); },
    });
    const seen: ReadonlyMap<string, string>[] = [];
    const w = new Worker(store, (s) => { seen.push(s); return { rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }; }, '');
    analysing(w, async () => { (w as any).config((w as any).settings); return 'done'; });
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
    expect(await w.checks.runChecks()).toBe(1);
    expect(urls).toEqual([ETHERSCAN_V2]);
  });

  it('still runs the pass when reporting sources fails, and says the report failed, once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const finished: string[] = [];
    const { store } = stub({
      reportSources: async () => { throw new Error('db down'); },
      // The analyze row's: each pass also notes on the lens row why it ran no lens work.
      passFinished: async (job: string, _ms: number, outcome: string) => { if (job === 'analyze') finished.push(outcome); },
    });
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    analysing(w, async () => 'done');
    expect(await w.run('analyze')).toBe('ran');
    expect(await w.run('analyze')).toBe('ran');
    expect(finished).toEqual(['ok', 'ok']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('settings sources not reported');
  });
});

describe('nextAnalysis', () => {
  const MIN = 60_000;
  const s = (more: Partial<StaleRow> = {}): StaleRow => ({ id: 1, chainId: 1, version: 2, rules: {}, name: 'BAYC', ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null, ...more });

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

describe('Worker.analyzeOne', () => {
  it('analyses one collection a pass, off the main thread, and says which', async () => {
    const beats: [string | null, number | null][] = [];
    const saved: number[] = [];
    const store: any = {
      stale: async () => [
        { id: 1, chainId: 1, version: 3, rules: {}, name: 'BAYC', ranAt: Date.now(), tookMs: 10, rulesAt: null, startedAt: null },
        { id: 2, chainId: 1, version: 5, rules: {}, name: 'Doodles', ranAt: null, tookMs: null, rulesAt: null, startedAt: null },
      ],
      heartbeat: async (_job: string, doing: string | null, subjectId: number | null) => { beats.push([doing, subjectId]); },
      analysisStarted: async () => {}, saveAnalysis: async (id: number) => { saved.push(id); },
      importedMoney: async () => false,
      collections: async () => [],
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    const off: number[] = [];
    w.analyzeOff = async (request) => { off.push(request.id); return { analysis: {} as Analysis, through: 7 }; };
    expect(await analyzeDue(w)).toBe('Doodles analyzed');
    expect(off).toEqual([2]);
    expect(saved).toEqual([2]);
    expect(beats).toEqual([['Analyzing Doodles', 2]]);

    store.stale = async () => [{ id: 1, chainId: 1, version: 3, rules: {}, name: 'BAYC', ranAt: Date.now(), tookMs: 10, rulesAt: null, startedAt: null }];
    expect(await analyzeDue(w)).toBe('nothing due');
  });

  it('runs the money lenses with no key when the chain has an imported money trail', async () => {
    const asked: number[] = [];
    let imported = true;
    const store: any = {
      stale: async () => [{ id: 2, chainId: 1, version: 5, rules: {}, name: 'Doodles', ranAt: null, tookMs: null, rulesAt: null, startedAt: null }],
      heartbeat: async () => {}, analysisStarted: async () => {}, saveAnalysis: async () => {},
      importedMoney: async (id: number) => { asked.push(id); return imported; },
      collections: async () => [],
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    const sent: AnalysisRequest[] = [];
    w.analyzeOff = async (request) => { sent.push(request); return { analysis: {} as Analysis, through: 7 }; };
    await analyzeDue(w);
    imported = false;
    await analyzeDue(w);
    // Asked of the collection, not its chain: another collection's trail is not this one's funding.
    expect(asked).toEqual([2, 2]);
    expect(sent.map((r) => r.fundingAvailable)).toEqual([true, false]);
  });

  it('gives the thread where the store is and which collection, never the flows', async () => {
    // No analysisInput here: the main thread must not read the input, only the thread.
    const saved: [number, number | null][] = [];
    const store: any = {
      stale: async () => [{ id: 2, chainId: 1, version: 5, rules: { minCycles: 3 }, name: 'Doodles', ranAt: null, tookMs: null, rulesAt: null, startedAt: null }],
      heartbeat: async () => {},
      analysisStarted: async () => {}, saveAnalysis: async (id: number, _version: number, _a: Analysis, _ms: number, through: number | null) => { saved.push([id, through]); },
      collections: async () => [],
    };
    const url = 'postgres://washtrace:secret@db:5432/washtrace';
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), url);
    const sent: AnalysisRequest[] = [];
    w.analyzeOff = async (request) => { sent.push(request); return { analysis: {} as Analysis, through: 7 }; };
    await analyzeDue(w);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('flows');
    expect(sent[0]).not.toHaveProperty('transfers');
    expect(Object.keys(sent[0]!).sort()).toEqual(['chainId', 'contracts', 'custodians', 'followHops', 'fundingAvailable', 'id', 'money', 'rules', 'storeUrl']);
    expect(sent[0]).toMatchObject({ storeUrl: url, id: 2, chainId: 1, rules: { minCycles: 3 }, fundingAvailable: true });
    // The block the analysis ran through comes back from the thread, which read it with the input.
    expect(saved).toEqual([[2, 7]]);
  });
});

describe('Worker.analyzeOne when an analysis fails', () => {
  afterEach(() => vi.restoreAllMocks());

  const stale = (id: number, name: string): StaleRow => ({ id, chainId: 1, version: 1, rules: {}, name, ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null });

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
      heartbeat: async () => {}, importedMoney: async () => false,
      analysisStarted: async () => {}, saveAnalysis: async (id: number) => { waiting.delete(id); },
      analysisFailed: async (id: number, error: string) => {
        failed.push([id, error]);
        waiting.set(id, { ...waiting.get(id)!, retryAt: now + 5 * 60_000, startedAt: null });
      },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), 'postgres://washtrace:hunter2@db:5432/washtrace');
    (w.sync as any).manifest = async () => ({ version: 3, collections: [] });
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
    await expect(analyzeDue(w)).rejects.toThrow('out of memory');
    expect(failed).toEqual([[1, 'out of memory']]);
    at(60_000);
    expect(await analyzeDue(w)).toBe('Doodles analyzed');
    at(5 * 60_000 - 1);
    expect(await analyzeDue(w)).toBe('nothing due');
    at(5 * 60_000);
    await expect(analyzeDue(w)).rejects.toThrow('out of memory');
    expect(tried).toEqual([1, 2, 1]);
  });

  it('waits out a failure written before this worker started: the wait is the store\'s, not held in memory', async () => {
    const { w, tried, at, waiting } = setup();
    waiting.set(1, { ...stale(1, 'BAYC'), retryAt: 1_000_000 + 10 * 60_000 });
    expect(await analyzeDue(w)).toBe('Doodles analyzed');
    expect(await analyzeDue(w)).toBe('nothing due');
    at(10 * 60_000);
    await expect(analyzeDue(w)).rejects.toThrow('out of memory');
    expect(tried).toEqual([2, 1]);
  });

  it('fails the try a dead worker left marked as started, picks the next collection instead, and tries it again after its wait', async () => {
    const { w, tried, at, failed, waiting } = setup();
    // BAYC was being analysed when the last worker was killed: nothing recorded that, but the mark stayed.
    waiting.set(1, { ...stale(1, 'BAYC'), startedAt: 1_000_000 - 60_000 });
    expect(await analyzeDue(w)).toBe('Doodles analyzed');
    expect(failed).toEqual([[1, 'The worker stopped during this analysis.']]);
    expect(tried).toEqual([2]);
    expect(await analyzeDue(w)).toBe('nothing due');
    at(5 * 60_000);
    await expect(analyzeDue(w)).rejects.toThrow('out of memory');
    expect(tried).toEqual([2, 1]);
  });

  it('saves a success, which is what clears the failure', async () => {
    const { w, state, waiting, failed } = setup();
    waiting.delete(2);
    state.broken = false;
    expect(await analyzeDue(w)).toBe('BAYC analyzed');
    expect(waiting.size).toBe(0);
    expect(failed).toEqual([]);
  });

  it('writes the failure scrubbed of the store\'s URL, and still fails the pass when the write fails too', async () => {
    const { w, state, failed, store, at, waiting } = setup();
    waiting.delete(2);
    state.error = 'connect ECONNREFUSED postgres://washtrace:hunter2@db:5432/washtrace';
    await expect(analyzeDue(w)).rejects.toThrow('ECONNREFUSED');
    expect(failed[0]![1]).not.toContain('hunter2');
    expect(failed[0]![1]).not.toContain('postgres://');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.analysisFailed = async () => { throw new Error('disk full'); };
    at(5 * 60_000);
    await expect(analyzeDue(w)).rejects.toThrow('ECONNREFUSED');
    expect(logged.mock.calls.flat().join(' ')).toContain('disk full');
  });

  it('holds the wait itself when the store could not record it, doubling, and forgets it once one is saved', async () => {
    const { w, tried, state, store, at, waiting } = setup();
    waiting.delete(2);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The row never shows the wait: the write that records it failed too.
    store.analysisFailed = async () => { throw new Error('disk full'); };
    await expect(analyzeDue(w)).rejects.toThrow('out of memory');
    at(5 * 60_000 - 1);
    expect(await analyzeDue(w)).toBe('nothing due');
    at(5 * 60_000);
    await expect(analyzeDue(w)).rejects.toThrow('out of memory');
    // Ten minutes after the second failure.
    at(15 * 60_000 - 1);
    expect(await analyzeDue(w)).toBe('nothing due');
    at(15 * 60_000);
    state.broken = false;
    expect(await analyzeDue(w)).toBe('BAYC analyzed');
    expect((w as any).analysesFailed.has(1)).toBe(false);
    expect(tried).toEqual([1, 1, 1]);
  });

  it('does not analyse a collection whose stored data is still to load, and analyses it once loaded', async () => {
    const { w, tried, state, waiting } = setup();
    state.broken = false;
    waiting.delete(2);
    let cursor: number | null = null;
    (w as any).store.collections = async () => [row({ id: 1, cursorBlock: cursor, startBlock: cursor === null ? null : 100 })];
    (w.sync as any).manifest = async () => ({ version: 3, collections: [ENTRY] });
    expect(await analyzeDue(w)).toBe('nothing due');
    cursor = 900;
    expect(await analyzeDue(w)).toBe('BAYC analyzed');
    expect(tried).toEqual([1]);
  });

  it('analyses a collection whose stored data failed to load on what it has, unless the load is due again', async () => {
    const { w, tried, state, waiting } = setup();
    state.broken = false;
    waiting.delete(2);
    let more: Partial<CollectionRow> = { restoreNote: 'Stored data could not be loaded.', restoreRetryAt: Date.now() + 60_000 };
    (w as any).store.collections = async () => [row({ id: 1, cursorBlock: 100, ...more })];
    (w.sync as any).manifest = async () => ({ version: 3, collections: [ENTRY] });
    (w.sync as any).restoreKey = async () => 'abc:absent';
    // Due again (the file changed): held, so it is analysed once, after the load.
    more = { restoreNote: 'Stored data could not be loaded: its file is missing.', restoreNoteKey: 'abc:1:2:3' };
    expect(await analyzeDue(w)).toBe('nothing due');
    // Backing off, or noted on the file as it is: analysed on what it has.
    more = { restoreNote: 'Stored data could not be loaded.', restoreRetryAt: Date.now() + 60_000 };
    expect(await analyzeDue(w)).toBe('BAYC analyzed');
    more = { restoreNote: 'Stored data could not be loaded: its file is missing.', restoreNoteKey: 'abc:absent' };
    waiting.set(1, stale(1, 'BAYC'));
    expect(await analyzeDue(w)).toBe('BAYC analyzed');
    // A back-off held in memory, its write lost: analysed on what it has too.
    more = {};
    (w.sync as any).restoreFailed.set(1, { failures: 1, retryAt: Date.now() + 60_000 });
    waiting.set(1, stale(1, 'BAYC'));
    expect(await analyzeDue(w)).toBe('BAYC analyzed');
    expect(tried).toEqual([1, 1, 1]);
  });
});

describe('an analysis that never ends', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const request = { storeUrl: '', id: 1, chainId: 1, followHops: 3, rules: {}, fundingAvailable: false, custodians: new Set(), contracts: new Set(), money: new Set() } as AnalysisRequest;
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

  it('is stopped at once when its signal aborts: its thread is ended and it rejects; one aborted already starts no thread', async () => {
    const abort = new AbortController();
    const outcome = analyzeInThread(request, abort.signal).then(() => 'answered', (err: Error) => err.message);
    const thread = threads.at(-1)!;
    expect(thread.terminated).toBe(false);
    abort.abort('lost');
    expect(await outcome).toContain('lock held for it was lost');
    expect(thread.terminated).toBe(true);
    const before = threads.length;
    await expect(analyzeInThread(request, abort.signal)).rejects.toThrow('lock held for it was lost');
    expect(threads.length).toBe(before);
  });

  it('takes its abort listener off the signal once the thread has settled', async () => {
    const abort = new AbortController();
    const removed = vi.spyOn(abort.signal, 'removeEventListener');
    const outcome = analyzeInThread(request, abort.signal).catch(() => {});
    await threads.at(-1)!.terminate();
    await outcome;
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('the lens and preview threads stop at once on an aborted signal, as the analysis does', async () => {
    for (const run of [(s: AbortSignal) => runLensInThread({} as any, () => {}, s), (s: AbortSignal) => runPreviewInThread({} as any, () => {}, s)]) {
      const abort = new AbortController();
      const outcome = run(abort.signal).then(() => 'answered', (err: Error) => err.message);
      const thread = threads.at(-1)!;
      abort.abort('lost');
      expect(await outcome).toContain('lock held for it was lost');
      expect(thread.terminated).toBe(true);
      const before = threads.length;
      await expect(run(abort.signal)).rejects.toThrow('lock held for it was lost');
      expect(threads.length).toBe(before);
    }
  });

  it('counts as a failed analysis, kept on the collection', async () => {
    vi.useFakeTimers();
    const failed: [number, string][] = [];
    const store: any = {
      stale: async () => [{ id: 1, chainId: 1, version: 1, rules: {}, name: 'Terraforms', ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null }],
      collections: async () => [], heartbeat: async () => {}, importedMoney: async () => false, analysisStarted: async () => {}, saveAnalysis: async () => {},
      analysisFailed: async (id: number, error: string) => { failed.push([id, error]); },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    (w.sync as any).manifest = async () => ({ version: 3, collections: [] });
    const outcome = analyzeDue(w).then(() => 'saved', (err: Error) => err.message);
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
    const w = new Worker(store, () => ({ rpc: new Map([[1, 'http://rpc']]), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '');
    (w as any).chain = () => ({ check: async () => ({ finalized: 1, archive: true, logs: true }) });
    const connects = { n: 0 };
    // Connected, and hearing nothing: as a socket a NAT dropped without a word.
    (w as any).checks.connectListener = async () => { connects.n += 1; (w as any).checks.listener = { end: async () => {} }; };
    return { w, finished, connects, store };
  }

  it('does not take the listener for deaf while another replica holds the checks', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { w, connects, store } = setup([{ id: 1, kind: 'rpc', chainId: 1, ageMs: 25_000 }]);
    // Another replica is on a slow check: this one heard the request, and skips.
    store.locked = async () => 'skipped';
    await w.checks.listen();
    expect(await w.checks.runChecks()).toBe(0);
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
    await w.checks.listen();
    await vi.advanceTimersByTimeAsync(30_000);
    w.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(0);
  });

  it('answers a pending check every 30 seconds, though no request was heard', async () => {
    vi.useFakeTimers();
    const { w, finished } = setup([{ id: 1, kind: 'rpc', chainId: 1, ageMs: 2_000 }]);
    await w.checks.listen();
    expect(finished).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(finished).toEqual([1]);
    w.stop();
  });

  it('listens again when a check waited longer than a notification takes, and not when none did', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fresh = setup([{ id: 1, kind: 'rpc', chainId: 1, ageMs: 2_000 }]);
    await fresh.w.checks.listen();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fresh.connects.n).toBe(1);
    fresh.w.stop();
    const deaf = setup([{ id: 1, kind: 'rpc', chainId: 1, ageMs: 25_000 }]);
    await deaf.w.checks.listen();
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
  const config = (): WorkerConfig => ({ rpc: new Map([[1, RPC]]), etherscanKey: ES_KEY, etherscanPerSecond: 1_000, etherscanUrl: ES_URL, followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' });

  /** Everything the console was asked to print, as text. */
  const printed = (...spies: { mock: { calls: unknown[][] } }[]) => spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');

  it('records and logs a failed RPC read without the RPC URL or any part of its key', async () => {
    const errors: (string | null)[] = [];
    const store: any = {
      collections: async () => [row({ contract: {} as any })],
      setError: async (_id: number, message: string | null) => { errors.push(message); },
      setHead: async () => {}, heartbeat: async () => {}, served: async () => {},
    };
    const w = askedHub(new Worker(store, config, ''));
    (w.sync as any).manifest = async () => ({ version: 3, collections: [] });
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
    const w = askedHub(new Worker(store, config, ''));
    (w.sync as any).manifest = async () => ({ version: 3, collections: [] });
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
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b'] }] }),
      heartbeat: async () => {},
      rereadFrom: async () => null,
      moneyFailed: async (_chain: number, _wallet: string, message: string) => { failed.push(message); },
    };
    const w = new Worker(store, config, '');
    const etherscan = new Etherscan(ES_KEY, 1_000, ES_URL);
    let calls = 0;
    // A client that puts the request URL in its error, and an API that echoes the key it was sent.
    etherscan.fetch = async (url: URL) => {
      if (++calls === 1) throw new TypeError(`fetch failed: ${url.toString()}`);
      return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: `Error! Invalid address format ${ES_KEY}` }));
    };
    (w as any).etherscanClient = () => etherscan;
    expect(await w.fund()).toBe('0 wallets read, 2 failed');
    expect(failed).toHaveLength(2);
    expect(failed[1]).toContain('Invalid address format');
    for (const leak of ES_LEAKS) expect(failed.join('\n')).not.toContain(leak);
  });

  it('keeps the word Etherscan in an Etherscan error on its default URL, and still hides the key', async () => {
    const failed: string[] = [];
    const store: any = {
      collections: async () => [row({ id: 1 })],
      nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b'] }] }),
      heartbeat: async () => {},
      rereadFrom: async () => null,
      moneyFailed: async (_chain: number, _wallet: string, message: string) => { failed.push(message); },
    };
    const w = new Worker(store, () => ({ ...config(), etherscanUrl: ETHERSCAN_V2 }), '');
    const etherscan = new Etherscan(ES_KEY, 1_000, ETHERSCAN_V2);
    let calls = 0;
    etherscan.fetch = async () => ++calls === 1
      ? new Response('', { status: 403 })
      : new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: `Error! Invalid address format ${ES_KEY}` }));
    (w as any).etherscanClient = () => etherscan;
    await w.fund();
    expect(failed).toEqual(['Etherscan answered HTTP 403', 'Etherscan refused txlist: Error! Invalid address format [hidden]']);
  });

  it('records and logs a failed pass without any configured secret', async () => {
    const details: string[] = [];
    const store: any = {
      locked: async (_key: number, _wait: boolean, fn: (c: unknown) => Promise<void>) => { await fn(lockClient()); return 'ran'; },
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
    const { detail } = await (w as any).checks.runCheck({ kind: 'rpc', chainId: 1 }, workerConfig({}, await store.settings()));
    expect(detail.error).toContain('no such key');
    expect(detail.error).not.toContain('OLDKEY0123456789');
  });
});


describe('pickWork', () => {
  const now = 2_000_000_000_000;
  const fresh = { dueAt: now - LENS_WAIT_MS + 1 };
  const waited = { dueAt: now - LENS_WAIT_MS };
  type Seen = Parameters<typeof pickWork>[0];

  it.each<[string, Partial<Seen>, Work]>([
    // (1) After a preview, a due analysis goes first, whatever else waits.
    ['after a preview, a due analysis goes before the next preview', { last: 'preview', preview: true, analysisDue: true }, 'analysis'],
    ['after a preview, a due analysis goes before a run that has waited', { last: 'preview', run: waited, analysisDue: true }, 'analysis'],
    // (2) A queued preview.
    ['a queued preview goes before a due analysis and a run that has waited', { preview: true, run: waited, analysisDue: true }, 'preview'],
    ['a queued preview goes after a run, though an analysis is due', { last: 'run', preview: true, analysisDue: true }, 'preview'],
    ['after a preview with no analysis due, the next preview goes', { last: 'preview', preview: true }, 'preview'],
    // (3) A run that has waited LENS_WAIT_MS, unless the last pass ran one.
    ['a run that has waited exactly LENS_WAIT_MS goes before a due analysis', { run: waited, analysisDue: true }, 'run'],
    ['a run that has waited goes before a due analysis after an analysis', { last: 'analysis', run: waited, analysisDue: true }, 'run'],
    ['a run that has waited exactly LENS_WAIT_MS gives way to a due analysis after a run', { last: 'run', run: waited, analysisDue: true }, 'analysis'],
    // (4) A due analysis.
    ['a run that has waited under LENS_WAIT_MS gives way to a due analysis', { run: fresh, analysisDue: true }, 'analysis'],
    ['an analysis due alone runs', { analysisDue: true }, 'analysis'],
    // (5) A due run.
    ['a run with no analysis due goes, after a run too', { last: 'run', run: fresh }, 'run'],
    ['a run that has waited goes after a run when no analysis is due', { last: 'run', run: waited }, 'run'],
    // (6) Nothing.
    ['nothing queued and nothing due is nothing', {}, 'nothing'],
    ['nothing queued after a preview is nothing', { last: 'preview' }, 'nothing'],
  ])('%s', (_name, seen, work) => {
    expect(pickWork({ last: null, preview: false, run: null, analysisDue: false, now, ...seen })).toBe(work);
  });
});

describe('Worker.lensRun', () => {
  afterEach(() => vi.restoreAllMocks());

  const due = { lens: { id: 7, name: 'Blur 3-hop', version: 2, rule: { marker: 'rule' } }, collectionId: 4, chainId: 1, name: 'Terraforms', analysisId: 11, through: 99, dueAt: Date.now() };
  const totals = { truncated: 0, untimed: 0 };
  const analysisDue = { stale: async () => [{ id: 1, chainId: 1, version: 2, rules: {}, name: 'Lab', ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null }] };

  /**
   * A worker on a stub store holding one due run, recording the store calls
   * in order, the pass's own rows aside (`finished`). `pass` runs one analyze
   * pass and gives what it recorded last: its detail, or `failed: ` and the error.
   */
  function setup(more: Record<string, unknown> = {}) {
    const calls: unknown[][] = [];
    const finished: [string, string, string][] = [];
    const record = (name: string, result?: unknown) => async (...args: unknown[]) => { calls.push([name, ...args]); return result; };
    const store: any = {
      locked: async (_key: number, _wait: boolean, fn: (c: unknown) => Promise<unknown>) => { await fn(lockClient()); return 'ran'; },
      settings: async () => new Map(), reportSources: async () => {}, passStarted: async () => {},
      passFinished: async (job: string, _ms: number, outcome: string, detail: string) => { finished.push([job, outcome, detail]); },
      nextLensRun: record('next', due),
      lensRunStarted: record('started'),
      lensRunProgress: record('progress'),
      lensRunFailed: record('failed'),
      saveLensRun: record('saved', 'saved'),
      heartbeat: record('beat'),
      // No analysis is due, so the lens run goes on; no preview is queued, and none is old enough to sweep.
      stale: async () => [], collections: async () => [],
      sweepPreviews: async () => 0, fillRings: async () => false, nextPreview: async () => null,
      // An analysis, when one is due, is saved at once.
      importedMoney: async () => false, analysisStarted: async () => {}, saveAnalysis: async () => {},
      ...more,
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), 'postgres://washtrace:hunter2@db:5432/washtrace', '/nonexistent');
    w.sync.storedManifest = async () => null;
    w.lensOff = async () => ({ totals: totals as any, flags: [], tokensRead: null });
    w.analyzeOff = async () => ({ analysis: {} as Analysis, through: 7 });
    const pass = async () => {
      await w.run('analyze');
      const [, outcome, detail] = finished.at(-1)!;
      return outcome === 'ok' ? detail : `failed: ${detail}`;
    };
    return { w, calls, store, finished, pass };
  }
  const names = (calls: unknown[][]) => calls.map((c) => c[0]);

  it('a pass with nothing to do records nothing due on both the analyze and lens rows', async () => {
    const started: string[] = [];
    const { w, calls, finished } = setup({ nextLensRun: async () => null, passStarted: async (job: string) => { started.push(job); } });
    const off = vi.fn();
    w.lensOff = off;
    expect(await w.run('analyze')).toBe('ran');
    expect(off).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(started).toEqual(['analyze', 'lens']);
    expect(finished).toEqual([['analyze', 'ok', 'nothing due'], ['lens', 'ok', 'nothing due']]);
  });

  it('records a pass under what it ran, and notes on the other row why that ran nothing, before the work starts', async () => {
    const now = 2_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    let analysis = true;
    let next: unknown = { ...due, dueAt: now };
    const started: string[] = [];
    const { finished, pass } = setup({
      stale: async () => (analysis ? analysisDue.stale() : []),
      nextLensRun: async () => next,
      passStarted: async (job: string) => { started.push(job); },
    });
    // The run has just become due, so the analysis goes first.
    expect(await pass()).toBe('Lab analyzed');
    // A run that has waited goes before the analysis.
    next = { ...due, dueAt: now - LENS_WAIT_MS };
    expect(await pass()).toBe('Ran Blur 3-hop on Terraforms');
    // With no run and no analysis due.
    next = null;
    expect(await pass()).toBe('Lab analyzed');
    analysis = false;
    next = { ...due, dueAt: now };
    expect(await pass()).toBe('Ran Blur 3-hop on Terraforms');
    expect(started).toEqual(['lens', 'analyze', 'analyze', 'lens', 'lens', 'analyze', 'analyze', 'lens']);
    expect(finished).toEqual([
      ['lens', 'ok', 'an analysis is due first'], ['analyze', 'ok', 'Lab analyzed'],
      ['analyze', 'ok', 'a lens run is due first'], ['lens', 'ok', 'Ran Blur 3-hop on Terraforms'],
      ['lens', 'ok', 'nothing to run'], ['analyze', 'ok', 'Lab analyzed'],
      ['analyze', 'ok', 'nothing due'], ['lens', 'ok', 'Ran Blur 3-hop on Terraforms'],
    ]);
  });

  it('keeps the lens row fresh through passes that each run an analysis, as the analyze row through lens runs', async () => {
    let analysis = true;
    let next: unknown = null;
    const { finished, pass } = setup({ stale: async () => (analysis ? analysisDue.stale() : []), nextLensRun: async () => next });
    for (let i = 0; i < 5; i++) expect(await pass()).toBe('Lab analyzed');
    expect(finished.filter(([job]) => job === 'lens')).toEqual(Array(5).fill(['lens', 'ok', 'nothing to run']));
    finished.length = 0;
    analysis = false;
    next = due;
    for (let i = 0; i < 5; i++) expect(await pass()).toBe('Ran Blur 3-hop on Terraforms');
    expect(finished.filter(([job]) => job === 'analyze')).toEqual(Array(5).fill(['analyze', 'ok', 'nothing due']));
  });

  it('a lens queue that throws fails the lens row alone, and the due analysis still runs', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { finished, pass } = setup({ ...analysisDue, nextLensRun: async () => { throw new Error('lens_runs gone on postgres://washtrace:hunter2@db:5432/washtrace'); } });
    expect(await pass()).toBe('Lab analyzed');
    expect(finished.map(([job, outcome]) => [job, outcome])).toEqual([['lens', 'failed'], ['analyze', 'ok']]);
    expect(finished[0]![2]).toContain('lens_runs gone');
    expect(finished[0]![2]).not.toContain('hunter2');
    // Logged once under lens, though every pass fails the same way.
    await pass();
    expect(logged.mock.calls.map((c) => [c[0], c[1]])).toEqual([['[washtrace] %s pass failed: %s', 'lens']]);
    // A sweep that throws leaves the queues unread this pass, the same way.
    const swept = setup({ ...analysisDue, sweepPreviews: async () => { throw new Error('sweep failed'); } });
    const asked = vi.fn(async () => null);
    swept.store.nextPreview = asked;
    expect(await swept.pass()).toBe('Lab analyzed');
    expect(asked).not.toHaveBeenCalled();
    expect(swept.finished[0]).toEqual(['lens', 'failed', 'sweep failed']);
  });

  it('fills one collection\'s rings a turn, and a failure there is logged and holds up no analysis', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const filled = vi.fn(async () => true);
    const ok = setup({ ...analysisDue, fillRings: filled });
    expect(await ok.pass()).toBe('Lab analyzed');
    expect(filled).toHaveBeenCalledTimes(1);
    const broken = setup({ ...analysisDue, fillRings: async () => { throw new Error('witnesses gone'); } });
    expect(await broken.pass()).toBe('Lab analyzed');
    expect(logged.mock.calls.map((c) => [c[1], c[2]])).toContainEqual(['analyze', 'witnesses gone']);
  });

  it('passes over a collection whose rings failed to fill, so it holds up none after it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fill = vi.fn(async (_skip?: readonly number[]): Promise<boolean> => { throw Object.assign(new Error('bad witness'), { collectionId: 3 }); });
    const t = setup({ ...analysisDue, fillRings: fill });
    await t.pass();
    await t.pass();
    expect(fill.mock.calls.map((c) => c[0])).toEqual([[], [3]]);
  });

  it('gives way to a due analysis while its run has waited under LENS_WAIT_MS, and runs once it has waited that long', async () => {
    const now = 2_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fresh = setup({ ...analysisDue, nextLensRun: async () => ({ ...due, dueAt: now - LENS_WAIT_MS + 1 }) });
    const off = vi.fn(async () => ({ totals: totals as any, flags: [], tokensRead: null }));
    fresh.w.lensOff = off;
    expect(await fresh.pass()).toBe('Lab analyzed');
    expect(off).not.toHaveBeenCalled();
    expect(names(fresh.calls)).not.toContain('started');
    const waited = setup({ ...analysisDue, nextLensRun: async () => ({ ...due, dueAt: now - LENS_WAIT_MS }) });
    expect(await waited.pass()).toBe('Ran Blur 3-hop on Terraforms');
    expect(names(waited.calls)).toEqual(['started', 'beat', 'saved']);
    // With no analysis due, a run that has just become due goes at once.
    expect(await setup({ nextLensRun: async () => ({ ...due, dueAt: now }) }).pass()).toBe('Ran Blur 3-hop on Terraforms');
  });

  it('after a pass that ran a run, a due analysis goes next whatever the wait; after any other pass, a run that has waited goes first', async () => {
    let next: unknown = { ...due, dueAt: Date.now() - LENS_WAIT_MS };
    let analysis = true;
    const { pass } = setup({ nextLensRun: async () => next, stale: async () => (analysis ? analysisDue.stale() : []) });
    expect(await pass()).toBe('Ran Blur 3-hop on Terraforms');
    expect(await pass()).toBe('Lab analyzed');
    expect(await pass()).toBe('Ran Blur 3-hop on Terraforms');
    // With no analysis due it runs on, back to back.
    analysis = false;
    expect(await pass()).toBe('Ran Blur 3-hop on Terraforms');
    // A pass that found nothing: the run that has waited goes before the analysis.
    next = null;
    expect(await pass()).toBe('nothing due');
    analysis = true;
    next = { ...due, dueAt: Date.now() - LENS_WAIT_MS };
    expect(await pass()).toBe('Ran Blur 3-hop on Terraforms');
  });

  it('starts the run, runs the lens off the main thread with its rule, then saves it', async () => {
    const { w, calls, pass } = setup();
    const sent: LensRequest[] = [];
    w.lensOff = async (request) => { sent.push(request); calls.push(['off']); return { totals: totals as any, flags: [], tokensRead: 12 }; };
    expect(await pass()).toBe('Ran Blur 3-hop on Terraforms');
    expect(names(calls)).toEqual(['next', 'started', 'beat', 'off', 'saved']);
    expect(sent).toEqual([{ storeUrl: 'postgres://washtrace:hunter2@db:5432/washtrace', lensId: 7, collectionId: 4, chainId: 1, rule: { marker: 'rule' }, through: 99, followHops: 0, payees: false }]);
    expect(calls.find((c) => c[0] === 'started')).toEqual(['started', 7, 4]);
    // Saved at the version it read, on the analysis it read, with the token reads it took in.
    expect(calls.find((c) => c[0] === 'saved')!.slice(1, 6)).toEqual([7, 4, 2, 11, 99]);
    expect(calls.find((c) => c[0] === 'saved')!.at(-1)).toBe(12);
  });

  it('passes tokens.payees, as the worker reads it, to the lens run', async () => {
    const { w, pass } = setup();
    (w as any).config = () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: true, sources: {}, storedRepo: 'u/d' });
    const sent: LensRequest[] = [];
    w.lensOff = async (request) => { sent.push(request); return { totals: totals as any, flags: [], tokensRead: null }; };
    await pass();
    expect(sent.map((r) => r.payees)).toEqual([true]);
  });

  it('writes progress at most once every 2 seconds, and says it in the heartbeat', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { w, calls, pass } = setup();
    w.lensOff = async (_request, onProgress) => {
      onProgress(0.1);
      now += 1_999;
      onProgress(0.2);
      now += 1;
      onProgress(0.4);
      return { totals: totals as any, flags: [], tokensRead: null };
    };
    await pass();
    expect(calls.filter((c) => c[0] === 'progress')).toEqual([['progress', 7, 4, 0.1], ['progress', 7, 4, 0.4]]);
    expect(calls.filter((c) => c[0] === 'beat').map((c) => c.slice(1))).toContainEqual(['lens', 'Running Blur 3-hop on Terraforms: 40%', 4]);
  });

  it('notes a failed run with the scrubbed error, and the pass fails with it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, calls, finished, pass } = setup();
    w.lensOff = async () => { throw new Error('connect failed for postgres://washtrace:hunter2@db:5432/washtrace'); };
    expect(await pass()).toMatch(/^failed: connect failed/);
    expect(finished.map(([job, outcome]) => [job, outcome])).toEqual([['analyze', 'ok'], ['lens', 'failed']]);
    const failed = calls.find((c) => c[0] === 'failed')!;
    expect(failed.slice(1, 3)).toEqual([7, 4]);
    expect(String(failed[3])).not.toContain('hunter2');
    expect(finished[1]![2]).not.toContain('hunter2');
    expect(names(calls)).not.toContain('saved');
    // Logged under the row it ran on, once.
    expect(logged.mock.calls.map((c) => [c[0], c[1]])).toEqual([['[washtrace] %s pass failed: %s', 'lens']]);
  });

  it('a stop with its analysis still going clears the analysis\'s mark, not failed, and a requeue that hangs does not hold the drain', async () => {
    const requeue = vi.fn(async () => {});
    const { w, calls } = passWorker({ stale: DUE_ANALYSIS, analysisRequeued: requeue });
    w.analyzeOff = () => new Promise(() => {});
    void w.run('analyze');
    await vi.waitFor(() => expect(calls).toContain('analysisStarted'));
    w.stop();
    await w.drain(20);
    expect(requeue).toHaveBeenCalledWith(1);
    expect(calls).not.toContain('analysisFailed');
    const hung = passWorker({ stale: DUE_ANALYSIS, analysisRequeued: () => new Promise(() => {}) });
    hung.w.analyzeOff = () => new Promise(() => {});
    void hung.w.run('analyze');
    await vi.waitFor(() => expect(hung.calls).toContain('analysisStarted'));
    hung.w.stop();
    await hung.w.drain(20);
    // A requeue that fails is logged by the kind of work it was.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = passWorker({ stale: DUE_ANALYSIS, analysisRequeued: async () => { throw new Error('db gone'); } });
    broken.w.analyzeOff = () => new Promise(() => {});
    void broken.w.run('analyze');
    await vi.waitFor(() => expect(broken.calls).toContain('analysisStarted'));
    broken.w.stop();
    await broken.w.drain(20);
    expect(logged.mock.calls.map((c) => [c[0], c[1]])).toContainEqual(['[washtrace] stop: analysis not queued again: %s', 'db gone']);
  });

  it('a stop with its run still going queues that run again, not failed; one that finished before the drain ended is left alone', async () => {
    const requeue = vi.fn(async () => {});
    const { w, calls } = setup({ requeueLensRun: requeue });
    w.lensOff = () => new Promise(() => {});
    void w.run('analyze');
    await vi.waitFor(() => expect(names(calls)).toContain('beat'));
    w.stop();
    await w.drain(20);
    expect(requeue).toHaveBeenCalledWith(7, 4);
    expect(names(calls)).not.toContain('failed');
    // A run that saved before the drain ended is no longer in flight: nothing is requeued for it.
    const done = vi.fn(async () => {});
    const finished = setup({ requeueLensRun: done });
    expect(await finished.pass()).toBe('Ran Blur 3-hop on Terraforms');
    finished.w.stop();
    await finished.w.drain(20);
    expect(done).not.toHaveBeenCalled();
  });

  it('a drain without a stop requeues nothing, and a requeue that hangs or fails does not hold the drain', async () => {
    const requeue = vi.fn(async () => {});
    const idle = setup({ requeueLensRun: requeue });
    idle.w.lensOff = () => new Promise(() => {});
    void idle.w.run('analyze');
    await vi.waitFor(() => expect(names(idle.calls)).toContain('beat'));
    await idle.w.drain(20);
    expect(requeue).not.toHaveBeenCalled();
    const hung = setup({ requeueLensRun: () => new Promise(() => {}) });
    hung.w.lensOff = () => new Promise(() => {});
    void hung.w.run('analyze');
    await vi.waitFor(() => expect(names(hung.calls)).toContain('beat'));
    hung.w.stop();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = Date.now();
    await hung.w.drain(20);
    expect(Date.now() - t).toBeLessThan(2_000);
    const broken = setup({ requeueLensRun: async () => { throw new Error('db gone'); } });
    broken.w.lensOff = () => new Promise(() => {});
    void broken.w.run('analyze');
    await vi.waitFor(() => expect(names(broken.calls)).toContain('beat'));
    broken.w.stop();
    await expect(broken.w.drain(20)).resolves.toBeUndefined();
    expect(vi.mocked(console.error).mock.calls.map((c) => [c[0], c[1]])).toContainEqual(['[washtrace] stop: lens work not queued again: %s', 'db gone']);
  });

  it('says a lens edited mid-run was queued again, and one whose lens or collection went mid-run saved nothing', async () => {
    const stale = setup({ saveLensRun: async () => 'stale' });
    expect(await stale.pass()).toBe('Blur 3-hop changed while it ran: queued again');
    const gone = setup({ saveLensRun: async () => 'gone' });
    expect(await gone.pass()).toBe('Blur 3-hop or Terraforms was removed while it ran: nothing saved');
    expect(names(gone.calls)).not.toContain('failed');
  });

  it('takes the analysis lock, not one of its own, and runs nothing while it is held', async () => {
    const keys: number[] = [];
    const { w } = setup({
      locked: async (key: number, _wait: boolean, fn: (c: unknown) => Promise<void>) => { keys.push(key); if (keys.length === 1) return 'skipped'; await fn(lockClient()); return 'ran'; },
    });
    const off = vi.fn(async () => ({ totals: totals as any, flags: [], tokensRead: null }));
    w.lensOff = off;
    expect(await w.run('analyze')).toBe('skipped');
    expect(off).not.toHaveBeenCalled();
    expect(await w.run('analyze')).toBe('ran');
    expect(keys).toEqual([LOCKS.analyze, LOCKS.analyze]);
    expect(off).toHaveBeenCalledTimes(1);
  });

  describe('a preview', () => {
    const queuedPreview = { id: 31, collectionId: 4, chainId: 1, name: 'Terraforms', rule: { marker: 'preview' }, through: 99 };
    const result = { sampled: 2_000, judged: 1_900, hops: 1_900, ofSales: 9_000, caught: 12, atLeast: false, roundTrips: { caught: 3 }, topMarket: { name: 'Blur', caught: 9 }, truncated: 0, untimed: 0, tookMs: 5 };

    /** `setup`'s worker with one preview queued and an analysis due, recording the preview's store calls too. */
    function withPreview(more: Record<string, unknown> = {}) {
      // Due LENS_WAIT_MS ago when made, so it has waited that long whenever the pass reads its clock.
      const dueAt = Date.now() - LENS_WAIT_MS;
      const s = setup({ ...analysisDue, nextLensRun: async () => ({ ...due, dueAt }), ...more });
      const record = (name: string, answer?: unknown) => async (...args: unknown[]) => { s.calls.push([name, ...args]); return answer; };
      Object.assign(s.store, {
        sweepPreviews: record('sweep', 0), fillRings: async () => false, nextPreview: record('nextPreview', queuedPreview),
        previewProgress: record('previewProgress'), savePreview: record('savePreview'), previewFailed: record('previewFailed'),
        nextLensRun: (() => { const next = s.store.nextLensRun; return async (...args: unknown[]) => { s.calls.push(['next']); return next(...args); }; })(),
        ...more,
      });
      const sent: PreviewRequest[] = [];
      s.w.previewOff = async (request) => { sent.push(request); s.calls.push(['previewOff']); return result; };
      return { ...s, sent };
    }

    it('a queued preview runs before a due lens run, even with an analysis due; the pass after it runs that analysis, and asks for the one after that at once, which takes the next preview', async () => {
      const { w, calls, sent, finished, pass } = withPreview();
      const off = vi.fn();
      w.lensOff = off;
      expect(await pass()).toBe('Previewed a lens on Terraforms');
      // Swept, then taken, run and saved: no lens run is asked for.
      expect(names(calls).filter((n) => n !== 'beat')).toEqual(['sweep', 'nextPreview', 'previewOff', 'savePreview']);
      expect(off).not.toHaveBeenCalled();
      expect(sent).toEqual([{ storeUrl: 'postgres://washtrace:hunter2@db:5432/washtrace', previewId: 31, collectionId: 4, chainId: 1, rule: { marker: 'preview' }, through: 99, followHops: 0, payees: false }]);
      expect(calls.find((c) => c[0] === 'savePreview')).toEqual(['savePreview', 31, result]);
      expect(finished).toEqual([['analyze', 'ok', 'a preview is due first'], ['lens', 'ok', 'Previewed a lens on Terraforms']]);
      // The next pass takes neither the next preview nor a lens run: the analysis goes first, and no preview is taken (marked running) for it.
      calls.length = 0;
      finished.length = 0;
      await w.run('analyze');
      // Once: the pass it asks for straight after takes the preview again, though the analysis is still due here. No timer is waited for.
      await vi.waitFor(() => expect(finished).toHaveLength(4));
      expect(finished).toEqual([
        ['lens', 'ok', 'an analysis is due first'], ['analyze', 'ok', 'Lab analyzed'],
        ['analyze', 'ok', 'a preview is due first'], ['lens', 'ok', 'Previewed a lens on Terraforms'],
      ]);
      expect(names(calls).filter((n) => n !== 'beat')).toEqual(['sweep', 'sweep', 'nextPreview', 'previewOff', 'savePreview']);
      // With none queued, the lens run that has waited is next.
      const other = withPreview({ nextPreview: async () => null });
      expect(await other.pass()).toBe('Ran Blur 3-hop on Terraforms');
      expect(names(other.calls)).toContain('next');
    });

    it('a dueAnalysis that throws fails the analyze row alone, and the queued preview still runs', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { w, finished, pass } = withPreview();
      w.dueAnalysis = async () => { throw new Error('stale read failed'); };
      expect(await pass()).toBe('Previewed a lens on Terraforms');
      expect(finished).toEqual([['analyze', 'failed', 'stale read failed'], ['lens', 'ok', 'Previewed a lens on Terraforms']]);
    });

    it('a preview taken by a pass whose own row cannot be started is failed with that error, not as one a stopped worker left', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { w, calls } = withPreview({
        passStarted: async (job: string) => { if (job === 'lens') throw new Error('passes write failed'); },
      });
      const off = vi.fn(async () => result);
      w.previewOff = off;
      expect(await w.run('analyze')).toBe('ran');
      expect(off).not.toHaveBeenCalled();
      expect(calls.filter((c) => c[0] === 'previewFailed')).toEqual([['previewFailed', 31, 'passes write failed']]);
      expect(logged.mock.calls.map((c) => [c[1], c[2]])).toEqual([['lens', 'passes write failed']]);
      // Nothing is left in flight for a drain to hand back.
      const requeue = vi.fn(async () => {});
      (w as any).store.requeuePreview = requeue;
      w.stop();
      await w.drain(20);
      expect(requeue).not.toHaveBeenCalled();
    });

    it('a stop just after a pass takes a preview, before it runs, hands that preview back', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const requeue = vi.fn(async () => {});
      const { w, calls } = withPreview({
        requeuePreview: requeue,
        // The pass's own row is started slowly, after the preview is taken.
        passStarted: async (job: string) => { if (job === 'lens') await held; },
      });
      void w.run('analyze');
      await vi.waitFor(() => expect(names(calls)).toContain('nextPreview'));
      w.stop();
      await w.drain(20);
      expect(requeue).toHaveBeenCalledWith(31);
      release();
    });

    it('sweeps old previews at the start of every pass, with its clock', async () => {
      const now = 2_000_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { calls, pass } = withPreview({ stale: async () => [], nextPreview: async () => null, nextLensRun: async () => null });
      expect(await pass()).toBe('nothing due');
      expect(calls[0]).toEqual(['sweep', now]);
    });

    it('writes its progress at most once every 2 seconds, and says it in the heartbeat', async () => {
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const { w, calls, pass } = withPreview();
      w.previewOff = async (_request, onProgress) => {
        onProgress(0.1);
        now += 1_999;
        onProgress(0.2);
        now += 1;
        onProgress(0.5);
        return result;
      };
      await pass();
      expect(calls.filter((c) => c[0] === 'previewProgress')).toEqual([['previewProgress', 31, 0.1], ['previewProgress', 31, 0.5]]);
      expect(calls.filter((c) => c[0] === 'beat').map((c) => c.slice(1))).toContainEqual(['lens', 'Previewing a lens on Terraforms: 50%', 4]);
    });

    it('a preview that throws is marked failed with the scrubbed error', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { w, calls, finished, pass } = withPreview();
      w.previewOff = async () => { throw new Error('connect failed for postgres://washtrace:hunter2@db:5432/washtrace'); };
      expect(await pass()).toMatch(/^failed: connect failed/);
      expect(finished.map(([job, outcome]) => [job, outcome])).toEqual([['analyze', 'ok'], ['lens', 'failed']]);
      const failed = calls.find((c) => c[0] === 'previewFailed')!;
      expect(failed[1]).toBe(31);
      expect(String(failed[2])).toContain('connect failed');
      expect(String(failed[2])).not.toContain('hunter2');
      expect(names(calls)).not.toContain('savePreview');
    });

    it('a stop with its preview still going queues that preview again, not failed', async () => {
      const requeue = vi.fn(async () => {});
      const { w, calls } = withPreview({ requeuePreview: requeue });
      w.previewOff = () => new Promise(() => {});
      void w.run('analyze');
      await vi.waitFor(() => expect(names(calls)).toContain('beat'));
      w.stop();
      await w.drain(20);
      expect(requeue).toHaveBeenCalledWith(31);
      expect(names(calls)).not.toContain('previewFailed');
    });

    it('a throw from beat marks the preview failed with its own error, not "the worker stopped"', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { w, calls, pass } = withPreview();
      w.beat = async () => { throw new Error('beat broke on postgres://washtrace:hunter2@db:5432/washtrace'); };
      const off = vi.fn(async () => result);
      w.previewOff = off;
      expect(await pass()).toMatch(/^failed: beat broke/);
      const failed = calls.find((c) => c[0] === 'previewFailed')!;
      expect(failed[1]).toBe(31);
      expect(String(failed[2])).toContain('beat broke');
      expect(String(failed[2])).not.toContain('hunter2');
      expect(off).not.toHaveBeenCalled();
    });

    it('runs under the analysis lock, as a lens run does', async () => {
      const keys: number[] = [];
      const { w } = withPreview({
        locked: async (key: number, _wait: boolean, fn: (c: unknown) => Promise<void>) => { keys.push(key); await fn(lockClient()); return 'ran'; },
      });
      const off = vi.fn(async () => result);
      w.previewOff = off;
      expect(await w.run('analyze')).toBe('ran');
      expect(keys).toEqual([LOCKS.analyze]);
      expect(off).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Worker hears preview requests', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A worker whose listener is a pg.Client that connects to nothing, and records what it was asked. */
  function listening() {
    const asked: string[] = [];
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(async () => {});
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation((async (sql: string) => { asked.push(sql); return { rows: [] }; }) as any);
    vi.spyOn(pg.Client.prototype, 'end').mockImplementation(async () => {});
    const passes: number[] = [];
    const store: any = {
      locked: async (key: number, _wait: boolean, fn: (c: unknown) => Promise<unknown>) => { if (key === LOCKS.analyze) passes.push(key); return fn(lockClient()); },
      settings: async () => new Map(), reportSources: async () => {}, passStarted: async () => {}, passFinished: async () => {}, heartbeat: async () => {},
      expireChecks: async () => 0, pendingChecks: async () => [],
      sweepPreviews: async () => 0, fillRings: async () => false, nextPreview: async () => null, nextLensRun: async () => null, stale: async () => [],
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '', '/nonexistent');
    w.sync.storedManifest = async () => null;
    return { w, asked, passes, store };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('listens on washtrace_previews beside the checks', async () => {
    const { w, asked } = listening();
    await w.checks.listen();
    expect(asked.join(' ')).toContain('LISTEN washtrace_checks');
    expect(asked.join(' ')).toContain('LISTEN washtrace_previews');
    w.stop();
  });

  it('a notify on washtrace_previews runs a pass now', async () => {
    const { w, passes } = listening();
    await w.checks.listen();
    await settle();
    expect(passes).toEqual([]);
    const run = vi.spyOn(w, 'run');
    (w as any).checks.listener.emit('notification', { channel: 'washtrace_previews', payload: '31' });
    await settle();
    expect(passes).toEqual([LOCKS.analyze]);
    expect(run.mock.calls).toEqual([['analyze']]);
    // A check's notify runs the checks, not a pass.
    (w as any).checks.listener.emit('notification', { channel: 'washtrace_checks', payload: '5' });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    w.stop();
  });

  /** `listening`'s worker with its first pass held at its sweep until `release`. */
  function heldPass() {
    const s = listening();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let sweeps = 0;
    s.store.sweepPreviews = async () => { sweeps += 1; if (sweeps === 1) await held; return 0; };
    return { ...s, release, sweeps: () => sweeps };
  }

  it('a notify during a pass runs one more after it, once however many were heard', async () => {
    const { w, release, sweeps } = heldPass();
    await w.checks.listen();
    const first = w.run('analyze');
    await settle();
    (w as any).checks.listener.emit('notification', { channel: 'washtrace_previews', payload: '31' });
    (w as any).checks.listener.emit('notification', { channel: 'washtrace_previews', payload: '32' });
    await settle();
    expect(sweeps()).toBe(1);
    release();
    await first;
    for (let i = 0; i < 5; i++) await settle();
    // Once more, not once per notify: a pass takes one preview, so a due analysis waits one at a time; any more wait for a later notify or the timer.
    expect(sweeps()).toBe(2);
    w.stop();
  });

  it('a worker stopped during a pass runs no more after it, though a notify asked for one', async () => {
    const { w, release, sweeps } = heldPass();
    await w.checks.listen();
    const first = w.run('analyze');
    await settle();
    (w as any).checks.listener.emit('notification', { channel: 'washtrace_previews', payload: '31' });
    await settle();
    w.stop();
    release();
    await first;
    for (let i = 0; i < 5; i++) await settle();
    expect(sweeps()).toBe(1);
  });
});

describe('Worker: a due analysis waits at most one preview', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * A listening worker whose store's try-lock is a JS lock, holding previews
   * 31, 32 and 33 queued back to back and, if `analysisDue`, one analysis due
   * until it is saved. `order` is the work done, in order: each preview run
   * and each analysis, off the main thread. `hold` makes preview 31 wait for
   * the promise it is given.
   */
  async function queuedBackToBack(analysisDue: boolean, hold?: Promise<void>) {
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(async () => {});
    vi.spyOn(pg.Client.prototype, 'query').mockImplementation((async () => ({ rows: [] })) as any);
    vi.spyOn(pg.Client.prototype, 'end').mockImplementation(async () => {});
    const order: string[] = [];
    const held = new Set<number>();
    let due = analysisDue;
    let queued = [31, 32, 33];
    const store: any = {
      locked: async (key: number, _wait: boolean, fn: (c: unknown) => Promise<unknown>) => {
        if (held.has(key)) return 'skipped';
        held.add(key);
        try { return await fn(lockClient()); } finally { held.delete(key); }
      },
      settings: async () => new Map(), reportSources: async () => {}, passStarted: async () => {}, passFinished: async () => {}, heartbeat: async () => {},
      expireChecks: async () => 0, pendingChecks: async () => [],
      sweepPreviews: async () => 0, fillRings: async () => false,
      nextPreview: async () => (queued.length === 0 ? null : { id: queued[0], collectionId: 4, chainId: 1, name: 'Terraforms', rule: {}, through: 99 }),
      previewProgress: async () => {},
      savePreview: async (id: number) => { queued = queued.filter((q) => q !== id); },
      nextLensRun: async () => null,
      stale: async () => (due ? [{ id: 1, chainId: 1, version: 2, rules: {}, name: 'Lab', ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null }] : []),
      collections: async () => [],
      importedMoney: async () => false,
      analysisStarted: async () => {}, saveAnalysis: async () => { due = false; },
    };
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '', '/nonexistent');
    w.sync.storedManifest = async () => null;
    const result = { sampled: 2_000, judged: 1_900, hops: 1_900, ofSales: 9_000, caught: 12, atLeast: false, roundTrips: { caught: 3 }, topMarket: { name: 'Blur', caught: 9 }, truncated: 0, untimed: 0, tookMs: 5 };
    w.previewOff = async (request) => {
      if (request.previewId === 31 && hold !== undefined) await hold;
      order.push(`preview ${request.previewId}`);
      return result;
    };
    w.analyzeOff = async (request) => { order.push(`analysis ${request.id}`); return { analysis: {} as Analysis, through: 7 }; };
    await w.checks.listen();
    return { w, order };
  }
  const settled = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

  it('with previews queued back to back and an analysis due, the analysis runs after one preview', async () => {
    const { w, order } = await queuedBackToBack(true);
    await w.run('analyze');
    await w.run('analyze');
    // The analysis pass asks for one more at once, which takes preview 32: no timer is waited for.
    await settled();
    expect(order).toEqual(['preview 31', 'analysis 1', 'preview 32']);
    // With no analysis due, previews go on back to back.
    await w.run('analyze');
    expect(order).toEqual(['preview 31', 'analysis 1', 'preview 32', 'preview 33']);
    w.stop();
  });

  it('a lone preview with no analysis due runs, and the next pass takes the next preview', async () => {
    const { w, order } = await queuedBackToBack(false);
    const analyzeOff = vi.spyOn(w, 'analyzeOff');
    await w.run('analyze');
    await w.run('analyze');
    await settled();
    expect(order).toEqual(['preview 31', 'preview 32']);
    // No analysis was run for nothing.
    expect(analyzeOff).not.toHaveBeenCalled();
    w.stop();
  });

  it('previews notified back to back while an analysis is due give preview, analysis, preview, with no timer between', async () => {
    let release!: () => void;
    const { w, order } = await queuedBackToBack(true, new Promise<void>((r) => { release = r; }));
    const notify = (id: number) => (w as any).checks.listener.emit('notification', { channel: 'washtrace_previews', payload: String(id) });
    notify(31);
    await settled();
    notify(32);
    notify(33);
    await settled();
    release();
    await settled();
    // The pass the notifies asked for takes the analysis, one preview's wait and not one per notify, and the pass it asks for takes preview 32.
    expect(order).toEqual(['preview 31', 'analysis 1', 'preview 32']);
    // Then no more without a timer or a notify: preview 33 is the next pass's.
    await settled();
    expect(order).toEqual(['preview 31', 'analysis 1', 'preview 32']);
    w.stop();
  });
});

describe('Worker.start: analyses, previews and lens runs take turns in one pass', () => {
  afterEach(() => vi.useRealTimers());

  /**
   * A worker on a store whose try-lock is a JS lock and whose every query
   * takes a millisecond, as the final review's timer model has it: the real
   * start() and run(), with only the work's bodies and the store stubbed.
   * `due` says whether an analysis is due each time the store is asked;
   * `next` is the lens run the store holds, given when the worker started.
   * `lens.ran` is when each lens run started, off the main thread.
   * `analysisMs` is how long an analysis takes; `runMs` how long a lens run
   * takes. `lens.taken` is every row the passes that took the analysis lock
   * recorded, in order, with what each said.
   */
  function started(due: () => boolean, next: (startedAt: number) => unknown = () => null, { analysisMs = 0, runMs = 60_000 } = {}) {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const tick = () => new Promise<void>((r) => setTimeout(r, 1));
    const held = new Set<number>();
    const lens = { asked: 0, ran: [] as number[], startedAt, locks: 0, taken: [] as [string, string][] };
    const store: any = new Proxy({
      async locked(key: number, _wait: boolean, fn: (c: unknown) => Promise<unknown>) {
        await tick();
        if (held.has(key)) return 'skipped';
        held.add(key);
        if (key === LOCKS.analyze) lens.locks += 1;
        try { return await fn(lockClient()); } finally { await tick(); held.delete(key); }
      },
      async settings() { await tick(); return new Map(); },
      async stale() { await tick(); return due() ? [{ id: 1, chainId: 1, version: 2, rules: {}, name: 'Lab', ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null }] : []; },
      async collections() { await tick(); return []; },
      async nextLensRun() { await tick(); lens.asked += 1; return next(startedAt); },
      async nextPreview() { await tick(); return null; },
      async passFinished(job: string, _ms: number, _outcome: string, detail: string) {
        await tick();
        if (job === 'lens' || job === 'analyze') lens.taken.push([job, detail]);
      },
    }, { get: (t, k) => (k in t ? (t as any)[k] : async () => { await tick(); }) });
    const w = new Worker(store, () => ({ rpc: new Map(), etherscanKey: null, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '', '/nonexistent');
    w.sync.storedManifest = async () => null;
    // A lens run holds the analysis lock while it goes.
    w.lensOff = async () => { lens.ran.push(Date.now()); await new Promise((r) => setTimeout(r, runMs)); return { totals: { truncated: 0, untimed: 0 } as any, flags: [], tokensRead: null }; };
    w.analyzeOff = async () => { if (analysisMs > 0) await new Promise((r) => setTimeout(r, analysisMs)); return { analysis: {} as Analysis, through: 7 }; };
    // Ingest and fund read the store as they always do, for five round trips and more.
    for (const job of ['ingest', 'fund'] as const) {
      w[job] = async () => {
        for (let i = 0; i < 4; i++) await tick();
        return 'nothing due';
      };
    }
    w.start();
    return { w, lens };
  }

  const queued = (startedAt: number) => ({
    lens: { id: 7, name: 'Blur 3-hop', version: 1, rule: {} }, collectionId: 1, chainId: 1, name: 'Lab', analysisId: 1, through: null, dueAt: startedAt,
  });

  it('looks for a lens run every pass while no analysis is due, and records nothing due on both rows', async () => {
    const { w, lens } = started(() => false);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    w.stop();
    // Twenty minutes of passes, one a minute and the first at once.
    expect(lens.asked).toBeGreaterThanOrEqual(20);
    expect(lens.locks).toBe(lens.asked);
    expect(lens.taken).toEqual(Array(2 * lens.asked).fill(null).map((_, i) => [i % 2 === 0 ? 'analyze' : 'lens', 'nothing due']));
  });

  it('gives way to an analysis that is due: while the run has waited under LENS_WAIT_MS, every pass analyses', async () => {
    const { w, lens } = started(() => true, queued);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    w.stop();
    expect(lens.ran).toEqual([]);
    expect(lens.locks).toBeGreaterThanOrEqual(5);
    // And every pass says on the lens row why it ran nothing, so the lens row stays as fresh as the analyze row.
    expect(lens.taken).toEqual(Array(lens.locks).fill([['lens', 'an analysis is due first'], ['analyze', 'Lab analyzed']]).flat());
  });

  it('runs a queued lens run within LENS_WAIT_MS and one period, though an analysis is always due', async () => {
    const { w, lens } = started(() => true, queued);
    await vi.advanceTimersByTimeAsync(LENS_WAIT_MS + EVERY.analyze);
    w.stop();
    expect(lens.ran).toHaveLength(1);
    const waited = lens.ran[0]! - lens.startedAt;
    expect(waited).toBeGreaterThanOrEqual(LENS_WAIT_MS);
    expect(waited).toBeLessThanOrEqual(LENS_WAIT_MS + EVERY.analyze);
    // Every pass before it analysed.
    const before = lens.taken.slice(0, lens.taken.findIndex(([job, said]) => job === 'lens' && said.startsWith('Ran ')));
    expect(before.length).toBeGreaterThanOrEqual(2 * 10);
    expect(new Set(before.map((t) => t.join(' ')))).toEqual(new Set(['lens an analysis is due first', 'analyze Lab analyzed']));
  });

  it('after a lens run, the due analysis goes next, though a backlog of runs has each waited LENS_WAIT_MS', async () => {
    const waited = (startedAt: number) => ({ ...queued(startedAt), dueAt: startedAt - LENS_WAIT_MS });
    const { w, lens } = started(() => true, waited, { analysisMs: 20_000, runMs: 100_000 });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    w.stop();
    // Each pass notes the other row first, then records its work.
    const idle = lens.taken.filter((_, i) => i % 2 === 0);
    const work = lens.taken.filter((_, i) => i % 2 === 1);
    const runs = work.filter(([job, said]) => job === 'lens' && said.startsWith('Ran ')).length;
    const analyses = work.filter(([job, said]) => job === 'analyze' && said === 'Lab analyzed').length;
    expect(idle.every(([job, said]) => said === (job === 'lens' ? 'an analysis is due first' : 'a lens run is due first'))).toBe(true);
    // Every pass worked: the backlog drains, and the analyses go on beside it.
    expect(runs + analyses).toBe(work.length);
    expect(runs).toBeGreaterThanOrEqual(5);
    expect(analyses).toBeGreaterThanOrEqual(runs - 1);
    // After each lens run, the next pass is the analysis.
    work.forEach(([job], i) => {
      if (job !== 'lens' || i + 1 === work.length) return;
      expect(work[i + 1], `pass ${i}`).toEqual(['analyze', 'Lab analyzed']);
    });
    expect(lens.locks).toBe(work.length);
  });
});

/**
 * A worker over a stub store whose every call is recorded by name (`calls`),
 * the pass rows also as `finished`, with `answers` answering the calls they
 * name and every other call answering nothing. Every lock is got, held on
 * `client`, which already has the listener Store.connect gives each client.
 * Etherscan's key is set; nothing is watched, stale or queued unless
 * `answers` says so.
 */
function passWorker(answers: Record<string, unknown> = {}) {
  const client = lockClient();
  client.on('error', () => {});
  const calls: string[] = [];
  const finished: [string, string, string][] = [];
  const known: Record<string, unknown> = {
    locked: async (_key: number, _wait: boolean, fn: (c: unknown) => Promise<unknown>) => fn(client),
    settings: async () => new Map(),
    passFinished: async (job: string, _ms: number, outcome: string, detail: string) => { finished.push([job, outcome, detail]); },
    collections: async () => [], stale: async () => [], nextPreview: async () => null, nextLensRun: async () => null, sweepPreviews: async () => 0, fillRings: async () => false,
    nextSpot: async () => null, nextCount: async () => null, seedReach: async () => 0, moneyLanes: async () => ({ lanes: [] }), tokenLanes: async () => ({ lanes: [] }),
    importedMoney: async () => false, saveLensRun: async () => 'saved',
    ...answers,
  };
  const store: any = new Proxy(known, {
    get: (t, k) => async (...args: unknown[]) => { calls.push(String(k)); return typeof t[k as string] === 'function' ? (t[k as string] as (...a: unknown[]) => unknown)(...args) : undefined; },
  });
  const w = askedHub(new Worker(store, () => ({ rpc: new Map([[1, 'http://rpc']]), etherscanKey: 'k', etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d' }), '', '/nonexistent'));
  w.sync.storedManifest = async () => null;
  return { w, client, calls, finished };
}

const DUE_ANALYSIS = async () => [{ id: 1, chainId: 1, version: 2, rules: {}, name: 'Lab', ranAt: null, tookMs: null, rulesAt: null, retryAt: null, startedAt: null }];
const DUE_RUN = { lens: { id: 7, name: 'Blur 3-hop', version: 2, rule: {} }, collectionId: 4, chainId: 1, name: 'Terraforms', analysisId: 11, through: 99, dueAt: 0 };
const QUEUED_PREVIEW = { id: 31, collectionId: 4, chainId: 1, name: 'Terraforms', rule: {}, through: 99 };
const PREVIEWED = { sampled: 2_000, judged: 1_900, hops: 1_900, ofSales: 9_000, caught: 12, atLeast: false, roundTrips: { caught: 3 }, topMarket: { name: 'Blur', caught: 9 }, truncated: 0, untimed: 0, tookMs: 5 };

describe('Worker: a pass whose lock connection is lost', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const LOST = 'the connection holding its lock was lost (Connection terminated unexpectedly)';
  const lose = (client: EventEmitter) => client.emit('error', new Error('Connection terminated unexpectedly'));

  it('an analysis whose lock connection errors saves nothing, fails the pass as lost, notes no failure on the collection, and runs on the next pass', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, client, calls, finished } = passWorker({ stale: DUE_ANALYSIS });
    w.analyzeOff = async () => { lose(client); return { analysis: {} as Analysis, through: 7 }; };
    expect(await w.run('analyze')).toBe('ran');
    expect(calls).not.toContain('saveAnalysis');
    // Not the analysis's failure: it is not held back, here or on another replica.
    expect(calls).not.toContain('analysisFailed');
    expect(finished).toEqual([['lens', 'ok', 'nothing to run'], ['analyze', 'failed', LOST]]);
    expect(errors.mock.calls.map((c) => [c[1], c[2]])).toEqual([['analyze', LOST]]);
    // The pass stopped listening: only Store.connect's listener is left.
    expect(client.listenerCount('error')).toBe(1);
    w.analyzeOff = async () => ({ analysis: {} as Analysis, through: 7 });
    await w.run('analyze');
    expect(calls).toContain('saveAnalysis');
    expect(finished.at(-1)).toEqual(['analyze', 'ok', 'Lab analyzed']);
  });

  /** A thread that settles only by its signal aborting: with no signal passed, it never settles. */
  const endedBy = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new Error(`thread ended, aborted: ${signal.aborted}`)));
  });

  it('a lost lock ends the analysis thread that is running through the signal the worker passes, and the analysis is queued again, not failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, client, calls, finished } = passWorker({ stale: DUE_ANALYSIS });
    w.analyzeOff = (_r, signal) => { const run = endedBy(signal); lose(client); return run; };
    expect(await Promise.race([w.run('analyze'), new Promise((r) => setTimeout(() => r('hung'), 500))])).toBe('ran');
    expect(calls).toContain('analysisRequeued');
    expect(calls).not.toContain('analysisFailed');
    expect(calls).not.toContain('saveAnalysis');
    expect(finished.at(-1)).toEqual(['analyze', 'failed', LOST]);
  });

  it('a lost lock ends the lens thread that is running through the signal the worker passes, and the run is queued again, not failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, client, calls } = passWorker({ nextLensRun: async () => DUE_RUN });
    w.lensOff = (_r, _p, signal) => { const run = endedBy(signal); lose(client); return run; };
    expect(await Promise.race([w.run('analyze'), new Promise((r) => setTimeout(() => r('hung'), 500))])).toBe('ran');
    expect(calls).toContain('requeueLensRun');
    expect(calls).not.toContain('lensRunFailed');
    expect(calls).not.toContain('saveLensRun');
  });

  it('a lost lock ends the preview thread that is running through the signal the worker passes, and the preview is queued again, not failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, client, calls } = passWorker({ nextPreview: async () => QUEUED_PREVIEW });
    w.previewOff = (_r, _p, signal) => { const run = endedBy(signal); lose(client); return run; };
    expect(await Promise.race([w.run('analyze'), new Promise((r) => setTimeout(() => r('hung'), 500))])).toBe('ran');
    expect(calls).toContain('requeuePreview');
    expect(calls).not.toContain('previewFailed');
    expect(calls).not.toContain('savePreview');
  });

  it('an analysis whose lock connection errors clears its started mark without counting a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const requeue = vi.fn(async () => {});
    const { w, client, calls } = passWorker({ stale: DUE_ANALYSIS, analysisRequeued: requeue });
    w.analyzeOff = async () => { lose(client); return { analysis: {} as Analysis, through: 7 }; };
    await w.run('analyze');
    expect(calls).toContain('analysisStarted');
    expect(requeue).toHaveBeenCalledWith(1);
    expect(calls).not.toContain('analysisFailed');
  });

  it('a lens run whose lock connection errors saves nothing, fails the pass as lost, and is queued again, not failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, client, calls, finished } = passWorker({ nextLensRun: async () => DUE_RUN });
    w.lensOff = async () => { lose(client); return { totals: { truncated: 0, untimed: 0 } as any, flags: [], tokensRead: null }; };
    expect(await w.run('analyze')).toBe('ran');
    expect(calls).not.toContain('saveLensRun');
    expect(calls).not.toContain('lensRunFailed');
    expect(calls).toContain('requeueLensRun');
    expect(finished).toEqual([['analyze', 'ok', 'nothing due'], ['lens', 'failed', LOST]]);
  });

  it('a preview whose lock connection errors saves nothing, fails the pass as lost, and is queued again, not failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, client, calls, finished } = passWorker({ nextPreview: async () => QUEUED_PREVIEW });
    w.previewOff = async () => { lose(client); return PREVIEWED; };
    expect(await w.run('analyze')).toBe('ran');
    expect(calls).not.toContain('savePreview');
    expect(calls).not.toContain('previewFailed');
    expect(calls).toContain('requeuePreview');
    expect(finished).toEqual([['analyze', 'ok', 'nothing due'], ['lens', 'failed', LOST]]);
  });

  it('an ingest pass whose lock connection errors reads no further span and no further collection, and fails as lost', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const behind = (id: number) => row({ id, address: String(id), contract: {} as any, cursorBlock: 10, servedAt: id });
    const { w, client, calls, finished } = passWorker({ collections: async () => [behind(1), behind(2)] });
    const spans: string[] = [];
    (w as any).chain = () => ({
      finalized: async () => 1_000,
      transfers: async (address: string, from: number) => { spans.push(`${address} ${from}`); lose(client); return { transfers: [], through: from + 9 }; },
    });
    expect(await w.run('ingest')).toBe('ran');
    expect(spans).toEqual(['1 11']);
    // The collection read was given its turn; the other never started one.
    expect(calls.filter((c) => c === 'served')).toHaveLength(1);
    expect(finished).toEqual([['ingest', 'failed', LOST]]);
  });

  it('a fund pass whose lock connection errors checks no further wallet, reads no further token, and counts nothing, and fails as lost', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, client, calls, finished } = passWorker({
      collections: async () => [row({ id: 1, readTokens: true })],
      nextSpot: async () => null, nextCount: async () => 1,
      tokenLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['t1', 't2'] }] }),
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets: ['a', 'b'] }] }),
    });
    const read: string[] = [];
    (w as any).etherscanClient = () => ({
      tokenFlows: async (_c: number, wallet: string) => { read.push(`tokens ${wallet}`); lose(client); return { flows: [], truncated: false }; },
      flows: async (_c: number, wallet: string) => { read.push(`money ${wallet}`); return { flows: [], truncated: false }; },
    });
    expect(await w.run('fund')).toBe('ran');
    expect(read).toEqual(['tokens t1']);
    expect(calls).not.toContain('countTokens');
    expect(calls).not.toContain('countNext');
    expect(finished).toEqual([['fund', 'failed', LOST]]);
  });

  it('a lock connection that goes silent fails its once-a-minute look, and the pass saves nothing and fails as lost', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, client, calls, finished } = passWorker({ stale: DUE_ANALYSIS });
    w.analyzeOff = () => new Promise((r) => setTimeout(() => r({ analysis: {} as Analysis, through: 7 }), 90_000));
    const pass = w.run('analyze');
    await vi.advanceTimersByTimeAsync(1);
    // No 'error' is heard: only a query on it fails.
    client.alive = false;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await pass).toBe('ran');
    expect(calls).not.toContain('saveAnalysis');
    expect(finished.at(-1)).toEqual(['analyze', 'failed', LOST]);
  });
});

describe('Worker: a pass row that cannot be written', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a pass whose start cannot be recorded runs nothing, writes no failed finish, and logs why', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, finished } = passWorker({ passStarted: async () => { throw new Error('passes write failed'); } });
    const ingest = vi.fn(async () => 'read');
    w.ingest = ingest;
    expect(await w.run('ingest')).toBe('ran');
    expect(ingest).not.toHaveBeenCalled();
    expect(finished).toEqual([]);
    expect(errors.mock.calls.map((c) => [c[1], c[2]])).toEqual([['ingest', 'passes write failed']]);
  });

  it('an idle row that cannot be noted is logged under its own row, once, and the picked analysis still runs', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { w, calls, finished } = passWorker({
      stale: DUE_ANALYSIS,
      passStarted: async (job: string) => { if (job === 'lens') throw new Error('lens row write failed'); },
    });
    w.analyzeOff = async () => ({ analysis: {} as Analysis, through: 7 });
    await w.run('analyze');
    await w.run('analyze');
    expect(calls.filter((c) => c === 'saveAnalysis')).toHaveLength(2);
    expect(finished).toEqual([['analyze', 'ok', 'Lab analyzed'], ['analyze', 'ok', 'Lab analyzed']]);
    expect(errors.mock.calls.map((c) => [c[1], c[2]])).toEqual([['lens', 'lens row write failed']]);
  });
});

describe('Worker.spots', () => {
  const RESULT = { washTrade: false, methods: [], notRun: ['AU'], atLeast: false, finalized: true, source: 'spot', transfers: [] };
  const config = (etherscanKey: string | null = 'k') => () => ({
    rpc: new Map([[1, 'http://rpc.example/one']]), etherscanKey, etherscanPerSecond: 4, etherscanUrl: '', followHops: 0, tokensPayees: false, sources: {}, storedRepo: 'u/d',
  });
  type Queued = { id: number; chainId: number; tx: string; lens: null };

  /** A fund pass over `wallets` with `queue` of spot checks, recording what ran in order. */
  function pass(queue: Queued[], wallets: string[] = [], etherscanKey: string | null = 'k') {
    const order: string[] = [];
    const failed: [number, string][] = [];
    const saved: number[] = [];
    const runs: { chainId: number; tx: string; etherscan: unknown }[] = [];
    const store: any = {
      collections: async () => [row({ id: 1 })],
      nextCount: async () => null, seedReach: async () => 0,
      moneyLanes: async () => ({ lanes: [{ collectionId: 1, wallets }] }),
      heartbeat: async () => {},
      rereadFrom: async () => null,
      saveMoney: async (_c: number, wallet: string) => { order.push(`wallet ${wallet}`); },
      moneyFailed: async () => {},
      nextSpot: async () => queue.shift() ?? null,
      saveSpot: async (id: number) => { saved.push(id); },
      spotFailed: async (id: number, error: string) => { failed.push([id, error]); },
    };
    const w = new Worker(store, config(etherscanKey), '');
    if (etherscanKey !== null) (w as any).etherscanClient = () => ({ flows: async () => ({ flows: [], truncated: false }) });
    (w as any).spotCheck = (chainId: number, _url: string, etherscan: unknown) => ({
      run: async (tx: string) => {
        runs.push({ chainId, tx, etherscan });
        order.push(`spot ${tx}`);
        if (tx === 'boom') throw new Error('No such transaction on chain 1.');
        return RESULT;
      },
    });
    return { w, order, failed, saved, runs, queue };
  }
  const q = (id: number, tx: string, chainId = 1): Queued => ({ id, chainId, tx, lens: null });

  it('the fund pass runs a queued spot check before reading any wallet', async () => {
    const { w, order, saved } = pass([q(1, 't1')], ['a']);
    await w.fund();
    expect(order).toEqual(['spot t1', 'wallet a']);
    expect(saved).toEqual([1]);
  });

  it('a spot check asked mid-pass runs before the next wallet', async () => {
    const p = pass([], ['a', 'b']);
    const save = (p.w as any).store.saveMoney;
    (p.w as any).store.saveMoney = async (c: number, wallet: string) => { await save(c, wallet); if (wallet === 'a') p.queue.push(q(2, 't2')); };
    await p.w.fund();
    expect(p.order).toEqual(['wallet a', 'spot t2', 'wallet b']);
  });

  it('a spot check on a chain with no RPC fails and the next one runs', async () => {
    const { w, failed, runs } = pass([q(1, 't1', 8453), q(2, 't2')]);
    await w.fund();
    expect(failed).toEqual([[1, 'No RPC is configured for chain 8453. Set WASHTRACE_RPC_8453.']]);
    expect(runs.map((r) => r.tx)).toEqual(['t2']);
  });

  it('spot checks run with no Etherscan key, and the pass then stops as before', async () => {
    const { w, runs } = pass([q(1, 't1')], ['a'], null);
    expect(await w.fund()).toBe('no funding source configured');
    expect(runs).toEqual([{ chainId: 1, tx: 't1', etherscan: null }]);
  });

  it('spot checks stay inside the pass budget', async () => {
    const { w, runs, queue } = pass([q(1, 't1')]);
    expect(await w.spots(null, Date.now() - 1)).toBe(0);
    expect(runs).toEqual([]);
    expect(queue).toHaveLength(1);
  });

  it('a failing spot check is saved as failed with its message, and the next one runs', async () => {
    const { w, failed, saved } = pass([q(1, 'boom'), q(2, 't2')]);
    await w.fund();
    expect(failed).toEqual([[1, 'No such transaction on chain 1.']]);
    expect(saved).toEqual([2]);
  });

  it('says how many transactions it checked', async () => {
    const { w } = pass([q(1, 't1'), q(2, 't2')], ['a']);
    expect(await w.fund()).toBe('1 wallets read, 0 failed, 2 transactions checked');
  });
});
