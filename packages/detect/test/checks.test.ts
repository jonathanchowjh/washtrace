import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker } from '../src/worker.js';

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
