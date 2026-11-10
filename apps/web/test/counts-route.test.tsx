import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'ab'.repeat(20);
const available = { available: true };
const fake = {
  collection: vi.fn(async () => ({ id: 1, latest: { id: 3, totals: { A: available, AU: available, AC: available } } })),
  lensRuns: vi.fn(async () => []),
  tradeCount: vi.fn(async () => ({ total: 56, unjudged: 0 })),
  lensTokens: vi.fn(async (_id: number, _m: string, _o: { limit: number }) => ({ rows: [], total: 6 })),
  lensWallets: vi.fn(async () => ({ rows: [], total: 13 })),
};
vi.mock('@/lib/store', () => ({ store: () => fake }));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ usePathname: () => '/', useSearchParams: () => new URLSearchParams() }));

const { GET } = await import('@/app/api/collections/[chain]/[address]/counts/route');
const { TabCount } = await import('@/components/collection-nav');
const params = Promise.resolve({ chain: '1', address: ADDR });

beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the tab counts', () => {
  it('answers every sale for Trades and Linked wallets\' tokens and wallets, reading no row', async () => {
    const body = await (await GET(new Request(`http://x/api/collections/1/${ADDR}/counts`), { params })).json();
    expect(body).toEqual({ trades: 56, tokens: 6, wallets: 13 });
    expect(fake.lensTokens.mock.calls[0]![1]).toBe('AC');
    expect(fake.lensTokens.mock.calls[0]![2]).toMatchObject({ limit: 0 });
  });

  it('says no token or wallet count before Linked wallets has run', async () => {
    fake.collection.mockResolvedValueOnce({ id: 1, latest: null } as never);
    expect(await (await GET(new Request(`http://x/api/collections/1/${ADDR}/counts`), { params })).json()).toEqual({ trades: 56, tokens: null, wallets: null });
    expect(fake.lensTokens).not.toHaveBeenCalled();
  });

  it('is asked for once by all three badges, and shows nothing for a count it could not read', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ trades: 56, tokens: 6, wallets: null }) }));
    vi.stubGlobal('fetch', fetchMock);
    const src = '/api/collections/1/x/counts?analysis=3&transfers=9';
    const c = render(<><TabCount src={src} kind="trades" /><TabCount src={src} kind="tokens" /><TabCount src={src} kind="wallets" /></>).container;
    await waitFor(() => expect(c.textContent).toBe('566'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
