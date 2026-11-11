import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { COUNT_TIMEOUT_MS, retryMs } from '../src/store.js';
import { BUDGET_MS, EVERY, SPOT_PROBE_MS, SPOT_SHARE_MS, TOKEN_COUNT_MS, ingestTurns, interleave, LENS_WAIT_MS, MIN_SLICE_MS, nextAnalysis, pickWork, SEED_MS, TOKENS_MS, Worker, type Work } from '../src/worker.js';
import { HttpRequestError } from 'viem';
import { Chain } from '../src/chain.js';
import { workerConfig, type WorkerConfig } from '../src/env.js';
import { ETHERSCAN_V2, Etherscan, WALLET_MS } from '../src/etherscan.js';
import { LOCKS, type CollectionRow, type StaleRow } from '../src/store.js';
import type { LensRequest, PreviewRequest } from '../src/lens-thread.js';
import { ANALYZE_TIMEOUT_MS, analyzeInThread, type AnalysisRequest } from '../src/analysis-thread.js';
import { runLensInThread, runPreviewInThread } from '../src/lens-thread.js';
import type { Analysis } from '../src/types.js';
import { ENTRY, analyzeDue, askedHub, lockClient, refuseHub, row, stubStore } from './fixtures.js';

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

beforeEach(refuseHub);

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

  it.each([[30_000], [55_000]])('spot checks that overrun move the token reads, the counts and the estimate on by what they ran past (last wallet takes %i ms)', async (lastMs) => {
    const t = clock();
    const calls: string[] = [];
    const begun = t.now;
    const store = setup(calls, [], t, 0, ['m1', 'm2', 'm3']);
    const untils: number[] = [];
    const counts: number[] = [];
    store.tokenLanes = async (_c: number, _p: number, _h: number, _y: boolean, until: number) => { untils.push(until); return { lanes: [] }; };
    store.countTokens = async (_c: number, _h: number, _y: boolean, until: number) => { counts.push(until); };
    store.nextCount = async () => 1;
    let timeout = -1;
    store.countNext = async (_id: number, _h: number, ms: number) => { timeout = ms; };
    const waits = [6_000, 6_000, lastMs];
    store.saveMoney = async () => { t.now += waits.shift()!; };
    const w = new Worker(store, () => config(), '');
    (w as any).etherscanClient = () => ({ tokenFlows: async () => ({ flows: [], truncated: false }), flows: async () => ({ flows: [], truncated: false }) });
    // The first run of checks goes 10 seconds past its share, and the one mid-pass 15 more.
    const over = [10_000, 25_000];
    (w as any).spots = async () => { (w as any).spotLeft = -(over.length > 1 ? over.shift()! : over[0]!); return 0; };
    await w.fund();
    const deadline = begun + BUDGET_MS + 25_000;
    const countUntil = deadline - COUNT_TIMEOUT_MS;
    const checkUntil = countUntil - TOKEN_COUNT_MS;
    // The first token read is before the probe and so within TOKENS_MS; the one after the checking is within the moved check deadline, if time is left.
    expect(untils[0]).toBe(begun + TOKENS_MS);
    expect(untils.slice(1)).toEqual(begun + 12_000 + lastMs < checkUntil ? [checkUntil] : []);
    expect(counts).toEqual([countUntil]);
    expect(timeout).toBe(Math.min(COUNT_TIMEOUT_MS, deadline - (begun + 12_000 + lastMs)));
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
    const store: any = stubStore({
      passStarted: async () => {}, passFinished: async () => {}, settings: async () => new Map(), reportSources: async () => {},
      sweepFinished: async () => 0, fillRings: async () => false, nextPreview: async () => null, nextLensRun: async () => null,
      heartbeat: async (job: string, doing: string | null, id: number | null) => { beats.push([job, doing, id]); },
    });
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
    const store: any = stubStore({
      passStarted: async () => {}, passFinished: async () => {}, settings: async () => new Map(), reportSources: async () => {},
      heartbeat: async (job: string, doing: string | null, id: number | null) => { beats.push([job, doing, id]); },
    });
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
    const store: any = stubStore({
      passStarted: async () => {}, passFinished: async () => {}, heartbeat: async () => {},
      settings: async () => new Map([['follow.hops', '2']]),
      reportSources: async (s: unknown) => { reported.push(s); },
      sweepFinished: async () => 0, fillRings: async () => false, nextPreview: async () => null, nextLensRun: async () => null,
      ...more,
    });
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
    expect((w as any).analysesFailed.waits(1, 0)).toBe(false);
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
    (w.sync as any).restoreFailed.fail(1, Date.now());
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
    const store: any = stubStore({
      settings: async () => new Map(), reportSources: async () => {},
      passStarted: async () => {}, passFinished: async (_job: string, _ms: number, _outcome: string, detail: string) => { details.push(detail); },
      heartbeat: async () => {},
      collections: async () => { throw new Error(`lost ${RPC} and ${ES_URL}&key=${ES_KEY}`); },
    });
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
      sweepFinished: async () => 0, fillRings: async () => false, nextPreview: async () => null,
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
    const swept = setup({ ...analysisDue, sweepFinished: async () => { throw new Error('sweep failed'); } });
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

  it('tries a collection whose rings failed again after a wait that doubles, so its rings are not left unfilled until a restart', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let now = 2_000_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    // Collection 3 is the only one due, and fails whenever it is not passed over.
    const fill = vi.fn(async (skip: readonly number[] = []): Promise<boolean> => {
      if (skip.includes(3)) return false;
      throw Object.assign(new Error('bad witness'), { collectionId: 3 });
    });
    const t = setup({ ...analysisDue, fillRings: fill });
    await t.pass();
    now += retryMs(1) - 1;
    await t.pass();
    now += 1;
    await t.pass();
    // Failed twice: the wait doubled.
    now += retryMs(1);
    await t.pass();
    now += retryMs(2) - retryMs(1);
    await t.pass();
    expect(fill.mock.calls.map((c) => c[0])).toEqual([[], [3], [], [3], []]);
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
        sweepFinished: record('sweep', 0), fillRings: async () => false, nextPreview: record('nextPreview', queuedPreview),
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
      sweepFinished: async () => 0, fillRings: async () => false, nextPreview: async () => null, nextLensRun: async () => null, stale: async () => [],
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
    s.store.sweepFinished = async () => { sweeps += 1; if (sweeps === 1) await held; return 0; };
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
      sweepFinished: async () => 0, fillRings: async () => false,
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
    collections: async () => [], stale: async () => [], nextPreview: async () => null, nextLensRun: async () => null, sweepFinished: async () => 0, fillRings: async () => false,
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
  afterEach(() => vi.restoreAllMocks());
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

  it('a spot check asked mid-pass runs before the next wallet once SPOT_PROBE_MS has passed', async () => {
    const real = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + skew);
    const p = pass([], ['a', 'b']);
    const save = (p.w as any).store.saveMoney;
    (p.w as any).store.saveMoney = async (c: number, wallet: string) => {
      await save(c, wallet);
      if (wallet === 'a') { p.queue.push(q(2, 't2')); skew += SPOT_PROBE_MS; }
    };
    await p.w.fund();
    expect(p.order).toEqual(['wallet a', 'spot t2', 'wallet b']);
  });

  it('between wallets the queue is looked at no more than every SPOT_PROBE_MS', async () => {
    const p = pass([], ['a', 'b', 'c', 'd']);
    let looked = 0;
    const next = (p.w as any).store.nextSpot;
    (p.w as any).store.nextSpot = async () => { looked += 1; return next(); };
    await p.w.fund();
    expect(p.order).toEqual(['wallet a', 'wallet b', 'wallet c', 'wallet d']);
    // Once at the start of the pass; the wallets took no time.
    expect(looked).toBe(1);
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

  it('spot checks start only inside their share of the pass', async () => {
    const { w, runs, queue } = pass([q(1, 't1')]);
    (w as any).spotLeft = 0;
    expect(await w.spots(null)).toBe(0);
    expect(runs).toEqual([]);
    expect(queue).toHaveLength(1);
  });

  /** A clock that `took` moves on, and a pass whose spot checks each take `ms` of it. */
  function slow(p: ReturnType<typeof pass>, ms: number) {
    const real = Date.now.bind(Date);
    const clock = { skew: 0 };
    vi.spyOn(Date, 'now').mockImplementation(() => real() + clock.skew);
    const make = (p.w as any).spotCheck;
    (p.w as any).spotCheck = (...args: unknown[]) => {
      const c = make(...args);
      return { run: async (tx: string) => { clock.skew += ms; return c.run(tx); } };
    };
    return clock;
  }

  it('a queue of slow spot checks takes its share of the pass, and the pass still reads its wallets', async () => {
    // One check past the whole budget: the next waits for the next pass, and the wallets are still read.
    const p = pass([q(1, 't1'), q(2, 't2'), q(3, 't3')], ['a', 'b']);
    slow(p, BUDGET_MS - 5_000);
    await p.w.fund();
    expect(p.order).toEqual(['spot t1', 'wallet a', 'wallet b']);
    expect(p.queue.map((x) => x.tx)).toEqual(['t2', 't3']);
  });

  it('checks start while the share lasts, and one started inside it runs to its end', async () => {
    const p = pass([q(1, 't1'), q(2, 't2'), q(3, 't3')], ['a']);
    slow(p, SPOT_SHARE_MS / 2 + 1);
    await p.w.fund();
    expect(p.order).toEqual(['spot t1', 'spot t2', 'wallet a']);
    expect(p.queue.map((x) => x.tx)).toEqual(['t3']);
  });

  it('the pass\'s own work keeps its time when spot checks run past their share, and the pass ends one check\'s remainder late at most', async () => {
    // Each wallet takes a second; with the checks' 40 seconds past their share, the wallets still get BUDGET_MS - SPOT_SHARE_MS.
    const wallets = Array.from({ length: 60 }, (_, i) => `w${i}`);
    const p = pass([q(1, 't1')], wallets);
    const clock = slow(p, SPOT_SHARE_MS + 40_000);
    const save = (p.w as any).store.saveMoney;
    (p.w as any).store.saveMoney = async (c: number, wallet: string) => { clock.skew += 1_000; await save(c, wallet); };
    const start = Date.now();
    await p.w.fund();
    const read = p.order.filter((o) => o.startsWith('wallet')).length;
    expect(read).toBeGreaterThanOrEqual((BUDGET_MS - SPOT_SHARE_MS) / 1_000 - 2);
    expect(Date.now() - start).toBeLessThanOrEqual(BUDGET_MS + 40_000 + 2_000);
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
