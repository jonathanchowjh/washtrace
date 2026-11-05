import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TINT_LEAD } from '@/lib/metrics';

let funding: object | null = null;
let trades = 0;
let flaggedTrades = 0;
let moneyOnlyTrades = 0;
let unjudgedTrades = 0;
let counterparties = 0;
const OTHER = '0x' + 'c'.repeat(40);
const totals = Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, { available: true }]));
vi.mock('@/lib/store', () => ({
  store: () => ({
    wallet: async () => funding,
    collection: async (_c: number, a: string) => ({ id: 1, latest: a === OTHER ? null : { throughBlock: 1000, totals } }),
    counterparties: async (_c: number, _a: string, limit?: number) => {
      return Array.from({ length: Math.min(counterparties, limit ?? 50) }, (_, i) => ({ address: `0x${i.toString(16).padStart(40, '0')}`, flows: 1, sent: 1, received: 0, watched: false }));
    },
    walletTransfers: async (_c: number, _a: string, limit?: number) => {
      return Array.from({ length: Math.min(trades, limit ?? 500) }, (_, i) => ({
        txHash: '0x' + i, logIndex: 0, blockNumber: 1, tokenId: String(i), from: '0x1', to: '0x2', blockTime: null, marketplace: null, priceWei: null, currency: null,
        flags: i < flaggedTrades ? { A: { kind: 'scc', wallets: ['0x1', '0x2'], cycles: 2 } } : i < flaggedTrades + moneyOnlyTrades ? { AU: { kind: 'pair', pair: ['0x1', '0x2'], middle: null, flowTx: '0xf' } } : {}, collection: { chainId: 1, address: i >= trades - unjudgedTrades ? OTHER : '0x' + 'b'.repeat(40), name: null },
      }));
    },
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

afterEach(() => { cleanup(); trades = 0; flaggedTrades = 0; moneyOnlyTrades = 0; unjudgedTrades = 0; counterparties = 0; funding = null; });

const params = Promise.resolve({ chain: '1', address: `0x${'a'.repeat(40)}` });

async function page(): Promise<string> {
  const { default: WalletPage } = await import('@/app/w/[chain]/[address]/page');
  const { container } = render(await WalletPage({ params }));
  return container.textContent ?? '';
}

describe('the wallet page', () => {
  it('says a wallet read from stored data was, with no dangling space before the full stop', async () => {
    funding = { status: 'done', transfers: 0, truncated: false, fetchedAt: null, error: null };
    expect(await page()).toContain('Its money was read from stored data.');
  });

  it('a wallet with exactly 500 trades says nothing about a cut', async () => {
    trades = 500;
    const text = await page();
    expect(text).toContain('Not flagged by any lens');
    expect(text).not.toContain('latest 500');
  });

  it('a wallet with more than 500 trades says the list is cut, and its verdict covers the trades shown', async () => {
    trades = 501;
    const text = await page();
    expect(text).toContain('Not flagged by any lens');
    expect(text).toContain('Its latest 500 trades are shown; older ones are not, so the verdict above covers these only.');
  });

  it('one flagged trade in a cut list is singular', async () => {
    trades = 501;
    flaggedTrades = 1;
    expect(await page()).toContain('In 1 flagged trade out of its latest 500');
  });

  it('a trade flagged only by Money loops back titles the page apart, with no extra note', async () => {
    trades = 1;
    moneyOnlyTrades = 1;
    const text = await page();
    expect(text).toContain('Flagged only by Money loops back, which is not counted');
    expect(text).not.toContain('more is flagged only by');
    expect(text).toContain(TINT_LEAD);
  });

  it('a Round trips trade and a Money loops back trade: counted lenses in the line, the other in a note', async () => {
    trades = 2;
    flaggedTrades = 1;
    moneyOnlyTrades = 1;
    const text = await page();
    expect(text).toContain('flagged by Round trips.');
    expect(text).toContain('1 more is flagged only by Money loops back, which is not counted');
  });

  it('a wallet with a trade analysed through its block and a trade with no analysis reads Not judged yet', async () => {
    trades = 2;
    unjudgedTrades = 1;
    const text = await page();
    expect(text).toContain('Not judged yet');
    expect(text).toContain('Some of its trades are read, but no analysis has covered them yet. That is not the same as clean.');
  });

  it('a Not judged yet wallet with a trade flagged only by Money loops back says that trade is not counted, with no "more"', async () => {
    trades = 2;
    moneyOnlyTrades = 1;
    unjudgedTrades = 1;
    const text = await page();
    expect(text).toContain('Not judged yet');
    expect(text).toContain('1 is flagged only by Money loops back, which is not counted.');
    expect(text).not.toContain('1 more is flagged');
  });

  it('walletView with 501 trades returns 500 and says it is cut', async () => {
    trades = 501;
    counterparties = 51;
    const { walletView } = await import('@/lib/views');
    const v = await walletView(1, `0x${'a'.repeat(40)}`);
    expect(v.transfers).toHaveLength(500);
    expect(v.counterparties).toHaveLength(50);
    expect(v.cut).toEqual({ trades: true, counterparties: true });
  });

  it('the wallets route returns cut and the verdict fields', async () => {
    trades = 1;
    flaggedTrades = 1;
    const { GET } = await import('@/app/api/wallets/[chain]/[address]/route');
    const body = await (await GET(new Request('http://x'), { params })).json();
    expect(body).toMatchObject({ cut: { trades: false, counterparties: false }, washTrade: true, judged: true, methods: ['A'] });
    expect(body).not.toHaveProperty('by');
  });

  it('more than 50 counterparties says the list is cut', async () => {
    counterparties = 51;
    const text = await page();
    expect(text).toContain('Its 50 busiest counterparties are shown; the rest are not.');
  });
});
