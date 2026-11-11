import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionRow } from '@washtrace/detect';
import type { Item } from '@/lib/collection-reads';
import { carry } from '@/lib/links';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;
const totals = { available: true };
/** 45 tokens, numbered 1 to 45 in list order. */
const state = { tokens: Array.from({ length: 45 }, (_, i) => String(i + 1)), trades: [] as { txHash: string; tokenId: string; blockTime?: number; priceWei?: string }[] };
const RING = '0x' + 'a1'.repeat(20);
const w = (c: string) => '0x' + c.repeat(40);
vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => c,
    lensRuns: async () => [],
    lensTokens: async (_id: number, _m: string, o: { limit: number; offset: number }) => ({
      rows: state.tokens.slice(o.offset, o.offset + o.limit).map((tokenId) => ({ tokenId })), total: state.tokens.length,
    }),
    trades: async (_id: number, _q: unknown, _c: unknown, limit: number, offset: number) => state.trades.slice(offset, offset + limit),
    tradeCount: async () => ({ total: state.trades.length, unjudged: 0 }),
    ring: async (_id: number, anchor: string) => (anchor !== RING ? null : {
      line: { rank: 3 }, walletsCut: false, tokens: [{ tokenId: '7' }, { tokenId: '8' }],
      wallets: [{ address: w('1'), traded: true }, { address: w('2'), traded: false }, { address: w('3'), traded: true }],
    }),
  }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => { cleanup(); push.mockReset(); });

const c = { id: 1, chainId: 1, address: ADDR, latest: { totals: { A: totals, AU: totals, AC: totals } } } as unknown as CollectionRow;
const { fromOf, fromParam, stepOf } = await import('@/lib/step');
const step = (from: string, id: string) => stepOf(c, fromOf(from)!, id);

describe('a from', () => {
  it('names a list and its query, and nothing else', () => {
    expect(fromOf('tokens?method=A&page=2')).toMatchObject({ kind: 'tokens' });
    expect(fromOf('tokens?method=A&page=2')!.params.get('page')).toBe('2');
    expect([fromOf('nope'), fromOf(undefined), fromOf(['tokens'])]).toEqual([null, null, null]);
  });

  it('is written with its page, the first left out, and rides on a link before its hash', () => {
    expect(fromParam('tokens', new URLSearchParams('method=A&page=9'), 1)).toBe('tokens?method=A');
    expect(fromParam('rings', new URLSearchParams(), 3)).toBe('rings?page=3');
    expect(carry(`${BASE}/t/7?method=L7#why`, { from: 'tokens?method=L7' })).toBe(`${BASE}/t/7?method=L7&from=tokens%3Fmethod%3DL7#why`);
    expect(carry(`${BASE}/t/7`, {})).toBe(`${BASE}/t/7`);
  });

  it('carries the lens first, unless the link names one, and never onto Trades, whose from is a date', () => {
    expect(carry(`${BASE}/t/7#why`, { method: 'L7', from: 'tokens?method=L7' })).toBe(`${BASE}/t/7?method=L7&from=tokens%3Fmethod%3DL7#why`);
    expect(carry(`${BASE}/t/7?method=A`, { method: 'AC' })).toBe(`${BASE}/t/7?method=A`);
    expect(carry(`${BASE}/w/${w('1')}?flagged=1`, { method: 'AC' })).toBe(`${BASE}/w/${w('1')}?flagged=1&method=AC`);
    for (const trades of [`${BASE}/trades`, `${BASE}/trades?caught=A&from=2026-01-01`, `${BASE}/trades?token=7#top`]) {
      expect(carry(trades, { method: 'AC', from: 'tokens?method=AC' })).toBe(trades);
    }
  });
});

describe('stepping through a list', () => {
  it('steps to the neighbours on the same page, and says where the item sits', async () => {
    const s = (await step('tokens?method=AC', '5'))!;
    expect([s.prev?.label, s.next?.label, s.at, s.total]).toEqual(['#4', '#6', 5, 45]);
    expect(s.next!.href).toBe(`${BASE}/t/6?method=AC&from=tokens%3Fmethod%3DAC`);
    expect(s.back).toEqual({ href: `${BASE}/tokens?method=AC`, label: 'All 45 tokens' });
  });

  it('crosses a page\'s edge, carrying the page the neighbour is on', async () => {
    const last = (await step('tokens?method=AC', '20'))!;
    expect(last.next!.href).toBe(`${BASE}/t/21?method=AC&from=tokens%3Fmethod%3DAC%26page%3D2`);
    const first = (await step('tokens?method=AC&page=2', '21'))!;
    expect(first.prev!.href).toBe(`${BASE}/t/20?method=AC&from=tokens%3Fmethod%3DAC`);
  });

  it('has no step past either end of the list', async () => {
    expect((await step('tokens?method=AC', '1'))!.prev).toBeNull();
    expect((await step('tokens?method=AC&page=3', '45'))!.next).toBeNull();
  });

  it('finds the item by what it is: one no longer on its page steps nowhere', async () => {
    // A new analysis put #5 on page 2.
    expect(await step('tokens?method=AC&page=2', '5')).toBeNull();
  });

  it('makes a transaction with two transfers in the list one stop', async () => {
    state.trades = [{ txHash: '0x1', tokenId: '1' }, { txHash: '0x2', tokenId: '2' }, { txHash: '0x2', tokenId: '3' }, { txHash: '0x3', tokenId: '4' }];
    const s = (await step('trades', '0x2'))!;
    expect([s.prev?.label, s.next?.label]).toEqual(['#1', '#4']);
  });

  it('counts a trade\'s place in transfers, as its total is, and names a neighbour by its day, or its price on a list by price', async () => {
    const day = Date.UTC(2026, 10, 3, 12) / 1000;
    state.trades = [{ txHash: '0x1', tokenId: '1', blockTime: day, priceWei: '2000000000000000000' }, { txHash: '0x2', tokenId: '2' }, { txHash: '0x2', tokenId: '3' }, { txHash: '0x3', tokenId: '4', blockTime: day, priceWei: '1000000000000000000' }];
    const s = (await step('trades', '0x3'))!;
    expect([s.at, s.total]).toEqual([4, 4]);
    expect(s.prev?.label).toBe('#2');
    expect((await step('trades', '0x2'))!.prev?.label).toMatch(/^#1 · .*2026/);
    expect((await step('trades?sort=price', '0x2'))!.next?.label).toBe('#4 · 1 ETH');
  });

  it('steps through a ring\'s wallets, traders first as its page lists them, or its tokens, and leads back to the ring', async () => {
    const s = (await step(`ring?anchor=${RING}&of=wallets`, w('3')))!;
    expect([s.prev?.label, s.next?.label, s.at, s.total]).toEqual(['0x1111…1111', '0x2222…2222', 2, 3]);
    expect(s.back).toEqual({ href: `${BASE}/r/${RING}`, label: 'Ring 3\'s wallets' });
    expect(s.next!.href).toBe(`${BASE}/w/${w('2')}?from=${encodeURIComponent(`ring?anchor=${RING}&of=wallets`)}`);
    const t = (await step(`ring?anchor=${RING}&of=tokens`, '7'))!;
    expect([t.prev, t.next?.label, t.back.label]).toEqual([null, '#8', 'Ring 3\'s tokens']);
    expect(await step('ring?anchor=nope&of=tokens', '7')).toBeNull();
  });

  it('steps past a transaction\'s other half on the next page, never to itself', async () => {
    // Twenty to a page: 0xt's transfers are the last of page 1 and the first of page 2.
    state.trades = [...Array.from({ length: 19 }, (_, i) => ({ txHash: `0x${i}`, tokenId: String(i) })), { txHash: '0xt', tokenId: '19' }, { txHash: '0xt', tokenId: '20' }, { txHash: '0xn', tokenId: '21' }];
    expect((await step('trades', '0xt'))!.next?.label).toBe('#21');
    expect((await step('trades?page=2', '0xt'))!.prev?.label).toBe('#18');
  });
});

describe('the context a page was opened with', () => {
  it('keeps a lens and a list, and drops a method that is no lens, a from that names no list, and a wrong-kind from', async () => {
    const { contextOf } = await import('@/lib/step');
    expect(contextOf({ method: 'AC', from: 'tokens?method=AC' })).toEqual({ method: 'AC', from: 'tokens?method=AC' });
    expect(contextOf({ method: 'L7' })).toEqual({ method: 'L7' });
    expect(contextOf({ method: 'nope' })).toEqual({});
    expect(contextOf({ from: 'nope' })).toEqual({});
    expect(contextOf({ method: ['A', 'AC'], from: 'http://evil/x' })).toEqual({ method: 'A' });
  });

  it('keeps a well-formed key of yours whether or not that lens still exists: the page it opens drops a stale one', async () => {
    const { contextOf } = await import('@/lib/step');
    expect(contextOf({ method: 'L99', from: 'wallets?method=L99' })).toEqual({ method: 'L99', from: 'wallets?method=L99' });
    expect(contextOf({ method: 'L' })).toEqual({});
    expect(contextOf({ method: 'L7x' })).toEqual({});
  });
});

describe('the line above an item', () => {
  const line = async (from: string | undefined, of: Item, method?: string) => {
    const { StepLine } = await import('@/components/step-line');
    return render(await StepLine({ chainId: 1, address: ADDR, from, method, of })).container;
  };
  const backs = (el: HTMLElement) => [...el.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

  it('with no list to step, leads back to the item\'s list tab, under the lens it was opened with', async () => {
    expect(backs(await line(undefined, { token: '5' }, 'AC'))).toEqual([['‹ All tokens', `${BASE}/tokens?method=AC`]]);
    cleanup();
    expect(backs(await line(undefined, { wallet: w('1') }, 'A'))).toEqual([['‹ All wallets', `${BASE}/wallets?method=A`]]);
    cleanup();
    expect(backs(await line(undefined, { token: '5' }))).toEqual([['‹ All tokens', `${BASE}/tokens`]]);
    cleanup();
    expect(backs(await line(undefined, { ring: RING }))).toEqual([['‹ All rings', `${BASE}/rings`]]);
    cleanup();
    expect(backs(await line(undefined, { tx: '0x1' }, 'AC'))).toEqual([['‹ All trades', `${BASE}/trades`]]);
  });

  it('does the same when its list is another kind, or the item has left its page', async () => {
    expect(backs(await line('rings', { token: '5' }, 'AC'))).toEqual([['‹ All tokens', `${BASE}/tokens?method=AC`]]);
    cleanup();
    expect(backs(await line('tokens?method=AC&page=2', { token: '5' }, 'AC'))).toEqual([['‹ All tokens', `${BASE}/tokens?method=AC`]]);
  });

  it('with a list to step, steps through it', async () => {
    const el = await line('tokens?method=AC', { token: '5' }, 'AC');
    expect(backs(el).map((x) => x[0])).toContain('‹ All 45 tokens');
  });
});

describe('the stepper', () => {
  const s = { prev: { id: 'a', label: '#4', href: '/a' }, next: { id: 'b', label: '#6', href: '/b' }, at: 5, total: 45, back: { href: '/list', label: 'All 45 tokens' } };

  it('opens the next on J and the previous on K, and leaves keys typed into a field alone', async () => {
    const { Stepper } = await import('@/components/stepper');
    render(<><input aria-label="find" /><Stepper step={s} /></>);
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'k' });
    expect(push.mock.calls.map((x) => x[0])).toEqual(['/b', '/a']);
    fireEvent.keyDown(screen.getByLabelText('find'), { key: 'j' });
    expect(push).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: /#6 ›/ }).getAttribute('href')).toBe('/b');
    // Which key goes which way is said, not left to guess.
    expect(document.body.textContent).toContain('K previous · J next');
  });
});
