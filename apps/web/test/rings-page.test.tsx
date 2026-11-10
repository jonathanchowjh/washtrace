import { cleanup, render } from '@testing-library/react';
import { isValidElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { short } from '@/lib/format';
import { tradesHref } from '@/lib/trades-url';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b1'.repeat(20), M = '0x' + 'c1'.repeat(20);
const line = (rank: number, anchor = A, floorSales = 2) => ({ anchor, rank, wallets: 3, sample: [A, B, M], sales: 3, floorSales, tokens: 1, volumeWei: '9000000000000000000', firstAt: null, lastAt: null });
const X = '0x' + 'd1'.repeat(20);
const moved = (from: string, to: string, n: number) => ({ txHash: '0x' + String(n).repeat(64), logIndex: 0, blockNumber: n, blockTime: n, tokenId: '114', from, to, marketplace: 'opensea', priceWei: '1', currency: '', flags: {} });
const MEMBERS = [{ address: A, traded: true }, { address: B, traded: true }, { address: M, traded: false }];
const state = { rings: 2 as number | null, latest: true, list: [line(1), line(2, B, 0)], members: MEMBERS };
vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => ({ id: 1, name: 'Demo Apes', address: ADDR, latest: state.latest ? { rings: state.rings } : null }),
    rings: async (_id: number, _ctx: unknown, limit: number, offset: number) => ({ rows: state.list.slice(offset, offset + limit), total: state.list.length }),
    ring: async (_id: number, anchor: string) => (anchor === A ? { line: line(1), wallets: state.members, walletsCut: false, tokens: [{ tokenId: '114', sales: 1, volumeWei: '9000000000000000000' }] } : null),
    ringsOf: async (_id: number, of: { wallet?: string }) => (of.wallet === M ? [A] : []),
    ringLines: async (_id: number, anchors: string[]) => anchors.map((a) => line(3, a)),
    // A and B pass #114 back and forth; it then leaves the ring for X.
    token: async () => [moved(A, B, 1), moved(B, A, 2), moved(A, X, 3)],
    flowsAmong: async () => [{ txHash: '0x' + 'f'.repeat(64), kind: 'native', from: M, to: A, valueWei: '1000000000000000000', token: '', blockNumber: 1, blockTime: 1 }],
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

afterEach(() => { cleanup(); Object.assign(state, { rings: 2, latest: true, list: [line(1), line(2, B, 0)], members: MEMBERS }); });

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
    expect(rows[0]!.querySelector('td a')!.getAttribute('href')).toBe(`${BASE}/r/${A}?from=rings`);
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

  it('says its count once, and titles its tab "Rings · <Collection>"', async () => {
    const c = await list();
    expect(c.textContent!.match(/\b2 rings\b/g)).toHaveLength(1);
    expect(c.querySelector('h1')?.textContent).toBe('Rings');
    const { generateMetadata } = await import('@/app/c/[chain]/[address]/rings/page');
    expect((await generateMetadata({ params, searchParams: Promise.resolve({}) })).title).toBe('Rings · Demo Apes');
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
    // A member opened from here steps through the ring's tokens or wallets, and leads back to it.
    expect(links(c)).toContainEqual(['#114', `${BASE}/t/114?from=${encodeURIComponent(`ring?anchor=${A}&of=tokens`)}`]);
    expect(links(c)).toContainEqual([`${A.slice(0, 6)}…${A.slice(-4)}`, `${BASE}/w/${A}?from=${encodeURIComponent(`ring?anchor=${A}&of=wallets`)}`]);
    expect(c.querySelector('svg[role=img]')?.getAttribute('aria-label')).toBe('3 wallets: 2 traded, 1 only moved the money');
  });

  it('draws its loops as a token\'s graph: its own wallets\' transfers, each opening its trade, and the money among them', async () => {
    const c = await one(A);
    const fig = c.querySelector('svg[aria-label="Transfers and money among the wallets of Ring 1"]')!;
    expect(fig).toBeTruthy();
    // The two transfers between its wallets, not the one out to X; numbered by block, each opening its trade.
    const hrefs = [...fig.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining([`${BASE}/tx/0x${'1'.repeat(64)}`, `${BASE}/tx/0x${'2'.repeat(64)}`]));
    expect(hrefs.some((h) => h?.includes('3'.repeat(64)))).toBe(false);
  });

  it('answers what the ring is and what its flagged sales add up to, in the token page\'s voice', async () => {
    const c = await one(A);
    const answer = c.querySelector('p.text-lg')!;
    expect(answer.textContent).toBe('3 wallets joined by 3 flagged sales');
    const body = answer.nextElementSibling!.textContent;
    expect(body).toContain('2 traded the tokens and 1 only moved the money.');
    expect(body).toContain('Its 3 flagged sales, 2 of them round trips, moved 9 ETH across 1 token.');
    expect(body).toContain('What this means: Tokens went round among these wallets');
    expect(links(answer.nextElementSibling!)).toContainEqual(['Demo Apes’s share', BASE]);
  });

  it('gives Connected to its wallets: each trader by its side of the sales, the rest as moving money', async () => {
    const { default: P } = await import('@/app/c/[chain]/[address]/r/[anchor]/page');
    const { ConnectedRail } = await import('@/components/connected-rail');
    const rails: { props: Record<string, unknown> }[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!isValidElement(n)) return;
      if (n.type === ConnectedRail) rails.push(n as { props: Record<string, unknown> });
      Object.values(n.props as Record<string, unknown>).forEach(walk);
    };
    walk(await P({ params: Promise.resolve({ chain: '1', address: ADDR, anchor: A }) }));
    expect(rails.map((r) => r.props.wallets)).toEqual([[
      { address: A, role: 'seller · buyer' }, { address: B, role: 'buyer · seller' }, { address: M, role: 'moved money' },
    ]]);
  });

  it('leaves out an empty group, and says it in the lead', async () => {
    state.members = MEMBERS.filter((w) => w.traded);
    const c = await one(A);
    expect([...c.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Traded (2)']);
    expect(c.textContent).toContain('Every wallet listed traded; none only moved the money.');
    expect(c.textContent).not.toContain('None.');
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
    const c = render(<>{await RingChips({ chainId: 1, address: ADDR, of: { wallet: M } })}</>).container;
    expect(links(c)).toEqual([['Part of Ring 3 ›', `${BASE}/r/${A}`]]);
    cleanup();
    expect(await RingChips({ chainId: 1, address: ADDR, of: { wallet: B } })).toBeNull();
  });
});
