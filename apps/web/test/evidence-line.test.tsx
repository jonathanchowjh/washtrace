import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvidenceLine } from '@/components/coverage';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const COLL = '0x' + 'c'.repeat(40);
const done = { status: 'done', truncated: false, fetchedAt: 1_700_000_000_000, transfers: 1, error: null };
const totals = (money: boolean) => Object.fromEntries(['A', 'AC', 'AU'].map((m) => [m, { available: m === 'A' || money }]));

const state = { reads: new Map<string, object>(), key: true, latest: { ranAt: 1_700_000_000_000, throughBlock: 100, totals: totals(true) } as object | null, asked: [] as string[][] };
vi.mock('@/lib/store', () => ({
  store: () => ({
    wallets: async (_chain: number, addresses: string[]) => { state.asked.push(addresses); return state.reads; },
    sources: async () => ({}),
    settings: async () => new Map(state.key ? [['etherscan.key', 'k']] : []),
    importedMoney: async () => false,
    collection: async () => ({ id: 1, chainId: 1, address: COLL, latest: state.latest }),
    collections: async () => [],
  }),
}));

afterEach(() => {
  cleanup();
  Object.assign(state, { reads: new Map(), key: true, latest: { ranAt: 1_700_000_000_000, throughBlock: 100, totals: totals(true) }, asked: [] });
});

const line = async (more: Partial<Parameters<typeof EvidenceLine>[0]> = {}) =>
  render(await EvidenceLine({ chainId: 1, wallets: [A, B], home: COLL, ...more })).container.textContent ?? '';

describe('the evidence line', () => {
  it('says the money read and the analysis it is from, reading every wallet in one query', async () => {
    state.reads = new Map([[A, done], [B, done]]);
    expect(await line()).toMatch(/^Money read for both wallets · analysis \S/);
    expect(state.asked).toEqual([[A, B]]);
  });

  it('is local to its own wallets: one unread says so, in the words of whether a key can read the rest', async () => {
    state.reads = new Map([[A, done]]);
    expect(await line()).toMatch(/^Money read for 1 of 2 wallets, so Linked wallets and Money loops back are so far: reading the rest can change this · analysis /);
    state.key = false;
    expect(await line()).toMatch(/^Money read for 1 of 2 wallets; at least, since no funding source is set/);
  });

  it('says the money lenses did not run, and that nothing is analyzed yet', async () => {
    state.reads = new Map([[A, done], [B, done]]);
    state.latest = { ranAt: 1, throughBlock: 100, totals: totals(false) };
    expect(await line()).toMatch(/^Linked wallets and Money loops back not run · analysis /);
    state.latest = null;
    expect(await line()).toBe('Money read for both wallets · not analyzed yet');
  });

  it('says an analysis read only up to a block before a trade past it', async () => {
    state.reads = new Map([[A, done], [B, done]]);
    expect(await line({ block: 100 })).not.toContain('before this trade');
    expect(await line({ block: 101 })).toMatch(/analysis \S.* read up to block 100, before this trade$/);
  });

  it('says the money alone outside any collection', async () => {
    state.reads = new Map([[A, done]]);
    expect(await line({ wallets: [A], home: undefined })).toMatch(/^Its money was read \S[^·]*$/);
  });

  it('says a wallet with no trades and no row was never queued, not that it is waiting', async () => {
    expect(await line({ wallets: [A], home: undefined, untraded: true })).toBe('Its money is not read: no transfer of it is read in a watched collection');
    state.reads = new Map([[A, done]]);
    expect(await line({ wallets: [A], home: undefined, untraded: true })).toMatch(/^Its money was read /);
  });
});
