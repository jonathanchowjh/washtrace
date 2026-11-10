import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { short } from '@/lib/format';
import { tradesHref } from '@/lib/trades-url';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b1'.repeat(20), M = '0x' + 'c1'.repeat(20);
const line = (rank: number, anchor = A, floorSales = 2) => ({ anchor, rank, wallets: 3, sample: [A, B, M], sales: 3, floorSales, tokens: 1, volumeWei: '9000000000000000000', firstAt: null, lastAt: null });
const state = { rings: 2 as number | null, latest: true, list: [line(1), line(2, B, 0)] };
vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => ({ id: 1, name: 'Demo Apes', address: ADDR, latest: state.latest ? { rings: state.rings } : null }),
    rings: async (_id: number, _ctx: unknown, limit: number, offset: number) => ({ rows: state.list.slice(offset, offset + limit), total: state.list.length }),
    ring: async (_id: number, anchor: string) => (anchor === A ? { line: line(1), wallets: [{ address: A, traded: true }, { address: B, traded: true }, { address: M, traded: false }], walletsCut: false, tokens: [{ tokenId: '114', sales: 1, volumeWei: '9000000000000000000' }] } : null),
    ringsOf: async (_id: number, of: { wallet?: string }) => (of.wallet === M ? [A] : []),
    ringLines: async (_id: number, anchors: string[]) => anchors.map((a) => line(3, a)),
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

afterEach(() => { cleanup(); Object.assign(state, { rings: 2, latest: true, list: [line(1), line(2, B, 0)] }); });

const params = Promise.resolve({ chain: '1', address: ADDR });
async function list(page?: string) {
  const { default: P } = await import('@/app/c/[chain]/[address]/rings/page');
  return render(await P({ params, searchParams: Promise.resolve(page === undefined ? {} : { page }) })).container;
}
async function one(anchor: string) {
  const { default: P } = await import('@/app/c/[chain]/[address]/r/[anchor]/page');
  return render(await P({ params: Promise.resolve({ chain: '1', address: ADDR, anchor }) })).container;
}
const links = (c: Element) => [...c.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

describe('the rings list', () => {
  it('names each ring by rank with its mark, and opens it by its anchor; its counts open its trades', async () => {
    const c = await list();
    const rows = [...c.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.querySelector('td a')!.textContent)).toEqual(['Ring 1', 'Ring 2']);
    expect(rows[0]!.querySelector('td a')!.getAttribute('href')).toBe(`${BASE}/r/${A}`);
    // Round trips flags some of Ring 1's sales, none of Ring 2's.
    expect(rows[0]!.querySelector('td a i')!.className).toContain('bg-cycle');
    expect(rows[1]!.querySelector('td a i')!.className).toContain('repeating-linear-gradient');
    expect(links(rows[0]!)).toContainEqual(['3', tradesHref(BASE, { ring: A })]);
    expect(links(rows[0]!)).toContainEqual([short(M), `${BASE}/w/${M}`]);
  });

  it('says why it is empty: no analysis, rings not worked out yet, or none', async () => {
    state.latest = false;
    expect((await list()).textContent).toContain('No analysis yet, so no ring.');
    cleanup();
    Object.assign(state, { latest: true, rings: null });
    expect((await list()).textContent).toContain('being worked out');
    cleanup();
    Object.assign(state, { rings: 0, list: [] });
    expect((await list()).textContent).toContain('No ring: nothing Round trips or Linked wallets flags ties wallets together.');
  });

  it('reads a page past the last as the last', async () => {
    state.list = Array.from({ length: 25 }, (_, i) => line(i + 1, '0x' + String(i).padStart(40, '0')));
    state.rings = 25;
    const c = await list('9');
    expect(c.querySelectorAll('tbody tr')).toHaveLength(5);
  });
});

describe('a ring', () => {
  it('heads as a ring, splits who traded from who only moved the money, and opens its sales and tokens', async () => {
    const c = await one(A);
    expect(c.querySelector('h1')?.textContent).toBe('Ring 1');
    expect(c.querySelector('header')?.textContent).toContain('Ring');
    const groups = [...c.querySelectorAll('h3')].map((h) => h.textContent);
    expect(groups).toEqual(['Traded (2)', 'Only moved the money (1)']);
    expect(links(c)).toContainEqual(['All its 3 sales →', tradesHref(BASE, { ring: A })]);
    expect(links(c)).toContainEqual(['#114', `${BASE}/t/114`]);
    expect(c.querySelector('svg[role=img]')?.getAttribute('aria-label')).toBe('3 wallets: 2 traded, 1 only moved the money');
  });

  it('says when no ring of the latest analysis has the anchor, and links the list', async () => {
    const c = await one(B);
    expect(c.textContent).toContain(`No ring of the latest analysis is named by ${short(B)}`);
    expect(links(c)).toContainEqual(['All rings', `${BASE}/rings`]);
  });
});

describe('the ring chips', () => {
  it('say each ring a thing is in, by rank, and nothing for a thing in none', async () => {
    const { RingChips } = await import('@/components/rings');
    const c = render(<>{await RingChips({ id: 1, base: BASE, money: new Set(['']), of: { wallet: M } })}</>).container;
    expect(links(c)).toEqual([['Part of Ring 3 ›', `${BASE}/r/${A}`]]);
    cleanup();
    expect(await RingChips({ id: 1, base: BASE, money: new Set(['']), of: { wallet: B } })).toBeNull();
  });
});
