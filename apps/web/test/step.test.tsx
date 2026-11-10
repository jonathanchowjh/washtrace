import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionRow } from '@washtrace/detect';
import { withFrom } from '@/lib/links';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;
const totals = { available: true };
/** 45 tokens, numbered 1 to 45 in list order. */
const state = { tokens: Array.from({ length: 45 }, (_, i) => String(i + 1)), trades: [] as { txHash: string; tokenId: string }[] };
vi.mock('@/lib/store', () => ({
  store: () => ({
    lensRuns: async () => [],
    lensTokens: async (_id: number, _m: string, o: { limit: number; offset: number }) => ({
      rows: state.tokens.slice(o.offset, o.offset + o.limit).map((tokenId) => ({ tokenId })), total: state.tokens.length,
    }),
    trades: async (_id: number, _q: unknown, _c: unknown, limit: number, offset: number) => state.trades.slice(offset, offset + limit),
    tradeCount: async () => ({ total: state.trades.length, unjudged: 0 }),
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
    expect(withFrom(`${BASE}/t/7?method=L7#why`, 'tokens?method=L7')).toBe(`${BASE}/t/7?method=L7&from=tokens%3Fmethod%3DL7#why`);
    expect(withFrom(`${BASE}/t/7`, undefined)).toBe(`${BASE}/t/7`);
  });
});

describe('stepping through a list', () => {
  it('steps to the neighbours on the same page, and says where the item sits', async () => {
    const s = (await step('tokens?method=AC', '5'))!;
    expect([s.prev?.label, s.next?.label, s.at, s.total]).toEqual(['#4', '#6', 5, 45]);
    expect(s.next!.href).toBe(`${BASE}/t/6?from=tokens%3Fmethod%3DAC`);
    expect(s.back).toEqual({ href: `${BASE}/tokens?method=AC`, label: 'All 45 tokens' });
  });

  it('crosses a page\'s edge, carrying the page the neighbour is on', async () => {
    const last = (await step('tokens?method=AC', '20'))!;
    expect(last.next!.href).toBe(`${BASE}/t/21?from=tokens%3Fmethod%3DAC%26page%3D2`);
    const first = (await step('tokens?method=AC&page=2', '21'))!;
    expect(first.prev!.href).toBe(`${BASE}/t/20?from=tokens%3Fmethod%3DAC`);
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
  });
});
