import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { isValidElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { short } from '@/lib/format';
import { EvidenceLine } from '@/components/coverage';
import { tradesHref } from '@/lib/trades-url';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b1'.repeat(20), M = '0x' + 'c1'.repeat(20);
const SHAPES = { funder: 0, payee: 0, back: 0, forward: 0, 'direct-back': 0, 'direct-forward': 0, both: 0 };
// A ring with Round trips sales is one loop; one without is one pair funded by a third.
const line = (rank: number, anchor = A, floorSales = 2) => ({
  anchor, rank, wallets: 3, sample: [A, B, M], sales: 3, floorSales, tokens: 1, volumeWei: '9000000000000000000', firstAt: null, lastAt: null, tokenSample: ['114'],
  pattern: floorSales > 0 ? { loops: 1, pairs: 0, middles: 0, shapes: SHAPES } : { loops: 0, pairs: 1, middles: 1, shapes: { ...SHAPES, funder: 1 } },
});
const X = '0x' + 'd1'.repeat(20);
const ETH1 = '1000000000000000000';
const moved = (from: string, to: string, n: number, flags: object = {}) => ({ txHash: '0x' + String(n).repeat(64), logIndex: 0, blockNumber: n, blockTime: n, tokenId: '114', from, to, marketplace: 'opensea', priceWei: ETH1, currency: '', flags });
const pay = (from: string, to: string, n: number) => ({ txHash: '0x' + `f${n}`.repeat(32), kind: 'native' as 'native' | 'token', from, to, valueWei: ETH1, token: '', blockNumber: n, blockTime: n });
const LOOP = { A: { kind: 'scc', wallets: [A, B], cycles: 2 } };
// A and B pass #114 back and forth; it then leaves the ring for X.
const LOOPS = () => [moved(A, B, 1, LOOP), moved(B, A, 2, LOOP), moved(A, X, 3)];
const member = (address: string, traded: boolean, sold = 0, bought = 0) => ({ address, traded, sold, bought, volumeWei: String(BigInt(sold + bought) * BigInt(ETH1)) });
const MEMBERS = [member(A, true, 1, 1), member(B, true, 1, 1), member(M, false)];
const fresh = () => ({
  extra: [] as ReturnType<typeof moved>[], rings: 2 as number | null, latest: true, list: [line(1), line(2, B, 0)], members: MEMBERS, cut: false, floorSales: 2,
  history: LOOPS as () => ReturnType<typeof moved>[], flows: [pay(M, A, 1)], ringLine: {} as Partial<ReturnType<typeof line>>, tokenFloor: true,
});
const state = fresh();
vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => ({ id: 1, chainId: 1, name: 'Demo Apes', address: ADDR, latest: state.latest ? { rings: state.rings, totals: { A: { available: true }, AU: { available: true }, AC: { available: true } } } : null }),
    rings: async (_id: number, _ctx: unknown, limit: number, offset: number) => ({ rows: state.list.slice(offset, offset + limit), total: state.list.length }),
    ring: async (_id: number, anchor: string) => (anchor === A
      ? { line: { ...line(1, A, state.floorSales), ...state.ringLine }, wallets: state.members, walletsCut: state.cut, tokens: [{ tokenId: '114', sales: 1, volumeWei: '9000000000000000000', floor: state.tokenFloor }] }
      : null),
    ringsOf: async (_id: number, of: { wallet?: string }) => (of.wallet === M ? [A] : []),
    ringLines: async (_id: number, anchors: string[]) => anchors.map((a) => line(3, a)),
    token: async () => [...state.history(), ...state.extra],
    // As the store caps its read, earliest first.
    flowsAmong: async (_c: number, _id: number, _legs: unknown, limit = 500) => state.flows.slice(0, limit),
  }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

afterEach(() => { cleanup(); Object.assign(state, fresh()); });

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
    // Each mark says its standing to a screen reader before the name.
    expect(rows.map((r) => r.querySelector('td a')!.textContent)).toEqual(['Round trips · the floor: Ring 1', 'Linked wallets · the ceiling: Ring 2']);
    expect(rows[0]!.querySelector('td a')!.getAttribute('href')).toBe(`${BASE}/r/${A}?from=rings`);
    // Round trips flags some of Ring 1's sales, none of Ring 2's.
    expect(rows[0]!.querySelector('td a i')!.className).toContain('bg-cycle');
    expect(rows[1]!.querySelector('td a i')!.className).toContain('repeating-linear-gradient');
    expect(links(rows[0]!)).toContainEqual(['3', tradesHref(BASE, { ring: A })]);
    expect(links(rows[0]!)).toContainEqual([short(M), `${BASE}/w/${M}`]);
  });

  it('says each ring\'s pattern in its own column, and on its card', async () => {
    const c = await list();
    const rows = [...c.querySelectorAll('tbody tr')];
    expect(c.querySelector('thead')!.textContent).toBe('RingPatternWalletsTokensSalesETH');
    expect(rows.map((r) => r.querySelector('td:nth-child(2)')!.textContent)).toEqual(['Round trips among 3 wallets', 'Both funded by a third']);
    expect(rows[0]!.querySelector('td:nth-child(2) svg[role=img]')).not.toBeNull();
    expect([...c.querySelectorAll('ul[aria-label=Rings] > li')].map((li) => li.textContent!.includes('Both funded by a third'))).toEqual([false, true]);
  });

  it('keys the marks it uses, the lenses in order and then the glyphs, and only those its rows show', async () => {
    const key = (await list()).querySelector('[aria-label=Key]')!;
    expect(key.textContent).toBe('Round trips · the floorLinked wallets · the ceilingloop' + 'linked pair, through a third');
    expect(key.querySelector('i.bg-cycle')).not.toBeNull();
    expect(key.querySelector('i[class*=repeating-linear-gradient]')).not.toBeNull();
    cleanup();
    state.list = [line(1, A, 0)];
    expect((await list()).querySelector('[aria-label=Key]')!.textContent).toBe('Linked wallets · the ceilinglinked pair, through a third');
  });

  it('keys the direct pair’s glyph only when a row draws it, and the middle’s only when a row draws that', async () => {
    const direct = { ...line(1, A, 0), pattern: { loops: 0, pairs: 2, middles: 0, shapes: { ...SHAPES, 'direct-back': 2 } } };
    state.list = [direct];
    const key = (await list()).querySelector('[aria-label=Key]')!;
    expect(key.getAttribute('role')).toBe('group');
    expect(key.textContent).toBe('Linked wallets · the ceilinglinked pair, direct');
    cleanup();
    state.list = [direct, line(2, B, 0)];
    expect((await list()).querySelector('[aria-label=Key]')!.textContent).toBe('Linked wallets · the ceilinglinked pair, through a thirdlinked pair, direct');
    cleanup();
    // A loop's row draws its loop, whatever pairs it also holds: no pair glyph to key.
    state.list = [{ ...line(1), pattern: { loops: 1, pairs: 1, middles: 1, shapes: { ...SHAPES, funder: 1 } } }];
    expect((await list()).querySelector('[aria-label=Key]')!.textContent).toBe('Round trips · the floorloop');
  });

  it('says what ties a ring in a sentence that agrees with itself', async () => {
    const c = await list();
    expect(c.textContent).toContain('Wallets tied together by what Round trips and Linked wallets flag, the most ETH first.');
    expect(c.textContent).not.toContain('ties together');
  });

  it('on a phone each ring is a card with the row’s links, its counts named, and the table is hidden there', async () => {
    const c = await list();
    const cards = [...c.querySelectorAll('ul[aria-label=Rings] > li')];
    expect(c.querySelector('ul[aria-label=Rings]')!.className).toContain('sm:hidden');
    expect(c.querySelector('table')!.parentElement!.className).toMatch(/^hidden .*sm:block/);
    const rows = [...c.querySelectorAll('tbody tr')];
    expect(cards).toHaveLength(rows.length);
    cards.forEach((card, i) => expect(links(card)).toEqual(links(rows[i]!)));
    // The card names its tokens where the table's column does, then counts its sales and ETH.
    const counts = cards[0]!.querySelector('p.tabular-nums')!.textContent!.replace(/\s+/g, ' ');
    expect(counts).toContain('token #114');
    expect(counts).toContain('3 sales');
    expect(counts).toContain('9 ETH');
  });

  it('says 0 for a ring none of whose flagged trades is a counted sale of a token', async () => {
    state.list = [{ ...line(1), tokens: 0, tokenSample: [] }];
    const c = await list();
    expect(c.querySelector('tbody td:nth-child(4)')!.textContent).toBe('0');
    expect(c.querySelector('ul[aria-label=Rings] p.tabular-nums')!.textContent).toContain('tokens 0');
  });

  it('names a ring\'s first tokens in its Tokens cell, each opening its token, and the rest open the ring\'s list of them', async () => {
    state.list = [{ ...line(1), tokens: 6, tokenSample: ['101', '102', '103'] }, line(2, B)];
    const c = await list();
    const [many, one] = [...c.querySelectorAll('tbody tr')].map((r) => r.querySelector('td:nth-child(4)')!);
    expect(many!.textContent!.replace(/\s+/g, ' ')).toBe('#101, #102, #103 +3');
    expect(links(many!)).toEqual([
      ['#101', `${BASE}/t/101`], ['#102', `${BASE}/t/102`], ['#103', `${BASE}/t/103`],
      [' +3', `${BASE}/r/${A}?from=rings#tokens`],
    ]);
    // A ring whose tokens are all named has no "+".
    expect(one!.textContent).toBe('#114');
    expect(links(one!)).toEqual([['#114', `${BASE}/t/114`]]);
  });

  it('marks each sampled wallet with the wallet symbol, as other wallet links are', async () => {
    const c = await list();
    expect([...c.querySelectorAll('tbody tr')][0]!.querySelectorAll('td:nth-child(3) a[href*="/w/"] svg')).toHaveLength(3);
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
  const rails = async (anchor = A) => {
    const { default: P } = await import('@/app/c/[chain]/[address]/r/[anchor]/page');
    const { ConnectedRail } = await import('@/components/connected-rail');
    const found: { props: Record<string, unknown> }[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!isValidElement(n)) return;
      if (n.type === ConnectedRail) found.push(n as { props: Record<string, unknown> });
      Object.values(n.props as Record<string, unknown>).forEach(walk);
    };
    walk(await P({ params: Promise.resolve({ chain: '1', address: ADDR, anchor }) }));
    return found;
  };
  const figure = (c: Element) => c.querySelector('svg[aria-label="Sales and payments among the wallets of Ring 1, in order"]')!;
  const trail = (c: Element) => [...c.querySelectorAll('section[aria-label="In order"] li')];
  const members = (c: Element) => [...c.querySelectorAll('ul[aria-label=Members] > li')].map((li) => [...li.children].map((x) => x.textContent));
  // A sold #114 to B, joined through M by `flows`: by the pair's shape, or none for a witness saved before shapes were.
  const paired = (shape: string | undefined, flows: ReturnType<typeof pay>[]) => {
    const pair = { AC: { kind: 'pair', pair: [A, B], middle: M, flowTx: flows[0]?.txHash ?? '0x', ...(shape === undefined ? {} : { shape }) } };
    Object.assign(state, {
      history: () => [moved(A, B, 5, pair)], flows, members: [member(A, true, 1, 0), member(B, true, 0, 1), member(M, false)],
      floorSales: 0, tokenFloor: false, ringLine: { sales: 1, volumeWei: ETH1 },
    });
  };

  const evidenceOf = async () => {
    const { default: P } = await import('@/app/c/[chain]/[address]/r/[anchor]/page');
    const found: { props: Record<string, unknown> }[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!isValidElement(n)) return;
      if (n.type === EvidenceLine) found.push(n as { props: Record<string, unknown> });
      Object.values(n.props as Record<string, unknown>).forEach(walk);
    };
    walk(await P({ params: Promise.resolve({ chain: '1', address: ADDR, anchor: A }) }));
    return found.map((e) => [e.props.chainId, e.props.home, e.props.wallets, e.props.first]);
  };

  it('ends its answer with the evidence line over its traders alone: an in-between is found in their money, never read itself', async () => {
    Object.assign(state, { members: [member(A, true, 1, 0), member(B, true, 0, 1), member(M, false)] });
    expect(await evidenceOf()).toEqual([[1, ADDR, [A, B], false]]);
  });

  it('a ring past the list\'s cut still gets its line, over the listed traders, saying they are its first', async () => {
    Object.assign(state, { members: [member(A, true, 1, 0), member(B, true, 0, 1)], cut: true, ringLine: { wallets: 900 } });
    expect(await evidenceOf()).toEqual([[1, ADDR, [A, B], true]]);
  });

  it('heads as a ring with its counts and its tier, and names no anchor there, which is the breadcrumb\'s', async () => {
    const c = await one(A);
    expect(c.querySelector('h1')?.textContent).toBe('Ring 1');
    const sub = c.querySelector('header p.mt-1')!;
    // Its Round trips count beside its sales, as a ring with loops has some.
    expect(sub.textContent).toBe('3 wallets · 1 token · 3 sales · 2 round trips · 9 ETH');
    expect(links(sub)).toEqual([
      ['3 sales', tradesHref(BASE, { ring: A })], ['2 round trips', tradesHref(BASE, { ring: A, caught: ['A'] })], ['9 ETH', tradesHref(BASE, { ring: A, sort: 'price', dir: 'desc' })],
    ]);
    expect(c.querySelector('header')!.textContent).toContain('Round trips · the floor');
    expect(c.querySelector('header')!.textContent).not.toContain('named by');
  });

  it('tells a loop\'s story as its answer, and says a ring is not one person once', async () => {
    const c = await one(A);
    const answer = c.querySelector('p.text-lg')!;
    expect(answer.textContent).toBe('#114 went round 2 wallets and back to one that sold it, 2 cycles.');
    // The loop's picture beside it.
    expect(answer.querySelector('svg[role=img]')!.getAttribute('aria-label')).toBe('The token went round 2 wallets, 2 cycles');
    expect(links(answer.nextElementSibling!)).toContainEqual(['Demo Apes’s share', BASE]);
    const text = c.textContent ?? '';
    expect(text.split('not one person').length - 1).toBe(1);
    // The old answer's slips are gone with it: the story says what the counts did.
    expect(text).not.toContain('Every one traded the tokens.');
    expect(text).not.toContain('What this means');
  });

  it('draws what happened in order: its own wallets\' transfers, each opening its trade under Round trips, and no money for a loop, which uses none', async () => {
    const c = await one(A);
    const fig = figure(c);
    expect(fig).toBeTruthy();
    const hrefs = [...fig.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining([`${BASE}/tx/0x${'1'.repeat(64)}?method=A`, `${BASE}/tx/0x${'2'.repeat(64)}?method=A`]));
    expect(hrefs.some((h) => h?.includes('3'.repeat(64)))).toBe(false);
    // The store holds a payment among the wallets, but Round trips used none: it is not drawn as evidence, nor listed.
    expect(fig.querySelectorAll('path[stroke-dasharray]')).toHaveLength(0);
    // Numbered in one sequence by time, as its legend says; a ring has no first holder.
    const legend = fig.closest('figure')!.querySelector('figcaption')!.textContent;
    expect(legend).toContain('numbered in block order');
    expect(legend).not.toContain('first holder');
  });

  it('lists every step in order beside the picture, each with its number and amount, and a tx link under its lens', async () => {
    const c = await one(A);
    const rows = trail(c);
    expect(rows.map((r) => r.querySelector('button')!.textContent)).toEqual([expect.stringContaining('1 · 1 ETH'), expect.stringContaining('2 · 1 ETH')]);
    expect(rows[0]!.querySelector('button')!.textContent).toContain(`Sale of #114${short(A)} → ${short(B)}`);
    expect(links(rows[0]!)).toEqual([['tx ›', `${BASE}/tx/0x${'1'.repeat(64)}?method=A`]]);
    expect(rows[0]!.querySelector('a')!.getAttribute('aria-label')).toBe('Open 1, the sale of #114');
    // The row is a button, never a link, so pressing it keeps the reader here.
    expect(rows[0]!.querySelector('button a')).toBeNull();
    expect(links(c.querySelector('section[aria-label="In order"]')!)).toContainEqual(['All 3 sales on Trades ›', tradesHref(BASE, { ring: A })]);
  });

  it('makes each step a toggle that lights its own arrow (token-graph.test presses them)', async () => {
    const c = await one(A);
    const button = trail(c)[1]!.querySelector('button')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    // Its page's updates wait on the rail's read here, so the lit arrow is looked for once the press lands.
    fireEvent.click(button);
    await waitFor(() => expect([...figure(c).querySelectorAll('g[data-lit]')].map((g) => g.getAttribute('data-edge'))).toEqual(['t1']));
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('lists who is in it once: each wallet\'s mark, role, sides and ETH, and the rail keeps only what it is part of', async () => {
    const c = await one(A);
    expect(members(c)).toEqual([
      ['', short(A), 'seller · buyer', '1 sold · 1 bought', '2 ETH'],
      ['', short(B), 'buyer · seller', '1 sold · 1 bought', '2 ETH'],
      // A loop draws no money, so what a wallet in between paid is not said.
      ['', short(M), 'in between', '—', '—'],
    ]);
    // A member opened from here steps through the ring's wallets, and leads back to it.
    expect(links(c.querySelector('ul[aria-label=Members]')!)).toContainEqual([short(A), `${BASE}/w/${A}?from=${encodeURIComponent(`ring?anchor=${A}&of=wallets`)}`]);
    expect(c.querySelectorAll('ul[aria-label=Members] li circle[stroke-dasharray]')).toHaveLength(1);
    const [rail] = await rails();
    expect(rail!.props.wallets).toBeUndefined();
    expect(rail!.props.salesOf).toBeUndefined();
  });

  it('draws a clean trade between its wallets dimmed, lists it in no step, and names neither side a seller or buyer for it', async () => {
    Object.assign(state, { extra: [moved(M, A, 4)] });
    const c = await one(A);
    const arrow = figure(c).querySelector(`a[href="${BASE}/tx/0x${'4'.repeat(64)}"]`)!;
    expect(arrow).not.toBeNull();
    // In the clean tone, not a verdict's.
    expect(arrow.closest('g')!.querySelector('path[fill=none]')!.getAttribute('class')).toContain('stroke-clean');
    expect(trail(c)).toHaveLength(2);
    expect(members(c)[2]).toEqual(['', short(M), 'in between', '—', '—']);
  });

  it('lists its tokens with their tier and picture, each opening under the lens of its evidence', async () => {
    const c = await one(A);
    const row = c.querySelector('#tokens li')!;
    expect(row.querySelector('i.bg-cycle')).not.toBeNull();
    expect(row.querySelector('svg[role=img]')).not.toBeNull();
    expect(links(row)).toContainEqual(['#114', `${BASE}/t/114?method=A&from=${encodeURIComponent(`ring?anchor=${A}&of=tokens`)}`]);
    expect(c.querySelector('#tokens')!.textContent).toContain('Open it for its own graph.');
  });

  it('gives each token its own short story, from its own evidence and without naming itself again', async () => {
    expect((await one(A)).querySelector('#tokens li p')!.textContent).toBe('Went round 2 wallets and back to one that sold it, 2 cycles.');
    cleanup();
    paired('funder', [pay(M, A, 3), pay(M, B, 4)]);
    expect((await one(A)).querySelector('#tokens li p')!.textContent).toBe('One wallet paid both the seller and the buyer, before the sale.');
    cleanup();
    // A ring not drawn has no evidence to tell: the row says nothing more.
    Object.assign(state, { members: Array.from({ length: 30 }, (_, i) => member('0x' + String(i).padStart(40, '0'), true, 1)), ringLine: { wallets: 30 } });
    expect((await one(A)).querySelector('#tokens li p')).toBeNull();
  });

  it('says no time word when the ring has more payments than its drawing reads', async () => {
    const { RING_FLOWS } = await import('@/lib/views');
    // Every payment read is before the sale, but the read stopped at its cap: a later one may be after it.
    paired('funder', Array.from({ length: RING_FLOWS + 1 }, (_, i) => pay(M, i % 2 === 0 ? A : B, 3)).map((f, i) => ({ ...f, txHash: '0x' + String(i).padStart(64, '0') })));
    const c = await one(A);
    expect(c.querySelector('p.text-lg')!.textContent).toBe('One wallet paid both the seller and the buyer of #114.');
    cleanup();
    paired('funder', Array.from({ length: RING_FLOWS }, (_, i) => pay(M, i % 2 === 0 ? A : B, 3)).map((f, i) => ({ ...f, txHash: '0x' + String(i).padStart(64, '0') })));
    expect((await one(A)).querySelector('p.text-lg')!.textContent).toContain('before the sale');
  });

  it('tells a funded pair\'s story with its time, lists its payments in order, and says what the funder paid', async () => {
    paired('funder', [pay(M, A, 3), pay(M, B, 4)]);
    const c = await one(A);
    expect(c.querySelector('p.text-lg')!.textContent).toBe('One wallet paid both the seller and the buyer of #114, before the sale.');
    const rows = trail(c).map((r) => r.querySelector('button')!.textContent);
    expect(rows).toEqual([expect.stringMatching(/^1 · 1 ETHPayment/), expect.stringMatching(/^2 · 1 ETHPayment/), expect.stringMatching(/^3 · 1 ETHLinked wallets · the ceiling: Sale of #114/)]);
    // A payment opens its own view, as the evidence of a linked pair; so does the sale.
    expect(links(trail(c)[0]!)).toEqual([['tx ›', `${BASE}/tx/${pay(M, A, 3).txHash}?method=AC`]]);
    expect(links(trail(c)[2]!)).toEqual([['tx ›', `${BASE}/tx/0x${'5'.repeat(64)}?method=AC`]]);
    expect(members(c)).toEqual([
      ['', short(A), 'seller', '1 sold', '1 ETH'],
      ['', short(B), 'buyer', '1 bought', '1 ETH'],
      ['', short(M), 'funder', '—', 'paid 2 ETH'],
    ]);
    // What it paid is money, in its hue.
    expect(c.querySelector(`li[data-member="${M}"] .text-flow`)!.textContent).toBe('paid 2 ETH');
    expect(links(c.querySelector('#tokens')!)).toContainEqual(['#114', `${BASE}/t/114?method=AC&from=${encodeURIComponent(`ring?anchor=${A}&of=tokens`)}`]);
    expect(links(c.querySelector('section[aria-label="In order"]')!)).toContainEqual(['Its sale on Trades ›', tradesHref(BASE, { ring: A })]);
    expect(c.textContent).toContain('its sale counts toward');
  });

  it('says no time word for a payment in the sale\'s own block', async () => {
    paired('funder', [pay(M, A, 5), pay(M, B, 4)]);
    expect((await one(A)).querySelector('p.text-lg')!.textContent).toBe('One wallet paid both the seller and the buyer of #114.');
  });

  it('tells an old pair, saved with no shape, as it always did, and calls its middle in between', async () => {
    paired(undefined, [pay(A, M, 6), pay(B, M, 7)]);
    const c = await one(A);
    // Today's wording, with no time word.
    expect(c.querySelector('p.text-lg')!.textContent).toBe('The seller and the buyer of #114 are joined by money through one wallet.');
    expect(c.textContent).not.toContain('undefined');
    expect(members(c)[2]).toEqual(['', short(M), 'in between', '—', 'was paid 2 ETH']);
  });

  it('tells a ring past 25 wallets by its counts, draws none of it, and still lists every member and opens its sales', async () => {
    const many = Array.from({ length: 30 }, (_, i) => member('0x' + String(i).padStart(40, '0'), i < 20, i < 20 ? 1 : 0));
    // A pair can sit on a loop's sale: three sales, two loops and three pairs, and the story says the counts as stored.
    Object.assign(state, { members: many, ringLine: { wallets: 30, pattern: { loops: 2, pairs: 3, middles: 3, shapes: { ...SHAPES, funder: 3 } } } });
    const c = await one(A);
    expect(c.querySelector('p.text-lg')!.textContent).toBe('2 loops and 3 linked pairs among 30 wallets, 3 both funded by a third.');
    expect(c.querySelector('section[aria-label="In order"]')).toBeNull();
    expect(c.querySelector('svg[aria-label^="Sales and payments"]')).toBeNull();
    expect(c.textContent).toContain('30 wallets are more than one picture can show.');
    expect(links(c)).toContainEqual(['All 3 sales on Trades ›', tradesHref(BASE, { ring: A })]);
    const rows = members(c);
    expect(rows).toHaveLength(30);
    expect(rows[0]).toEqual(['', short(many[0]!.address), 'traded', '1 sold', '1 ETH']);
    expect(rows[29]).toEqual(['', short(many[29]!.address), 'in between', '—', '—']);
  });

  it('a ring of linked pairs alone counts no round trip', async () => {
    paired('funder', [pay(M, A, 3), pay(M, B, 4)]);
    expect((await one(A)).querySelector('header p.mt-1')!.textContent).toBe('3 wallets · 1 token · 1 sale · 1 ETH');
  });

  it('shows only the payments Linked wallets used: a Money loops back payment on a loop is neither drawn nor listed', async () => {
    const both = { ...LOOP, AU: { kind: 'scc+flow', wallets: [A, B], cycles: 2, via: [[B, A]] } };
    Object.assign(state, { history: () => [moved(A, B, 1, both), moved(B, A, 2, both)], flows: [pay(B, A, 4)] });
    const c = await one(A);
    expect(figure(c).querySelectorAll('path[stroke-dasharray]')).toHaveLength(0);
    expect(trail(c).map((r) => r.textContent)).not.toContainEqual(expect.stringContaining('Payment'));
    expect(trail(c)).toHaveLength(2);
  });

  it('tells a loop\'s sales that are linked pairs too, among its sales', async () => {
    const both = (n: number) => ({ ...LOOP, AC: { kind: 'pair', pair: n === 1 ? [A, B] : [B, A], middle: M, flowTx: '0x', shape: 'funder' } });
    Object.assign(state, { history: () => [moved(A, B, 1, both(1)), moved(B, A, 2, both(2))], flows: [] });
    expect((await one(A)).querySelector('p.text-lg')!.textContent)
      .toBe('#114 went round 2 wallets and back to one that sold it, 2 cycles; 2 of its sales are linked pairs, both funded by a third.');
  });

  it('says what a funder paid in each unit it paid in, as the drawing does', async () => {
    paired('funder', [pay(M, A, 3), { ...pay(M, B, 4), kind: 'token', token: '0x' + 'e'.repeat(40) }]);
    expect(members(await one(A))[2]).toEqual(['', short(M), 'funder', '—', 'paid 2 ETH and WETH']);
  });

  it('opens a bundle\'s arrow under the lens of the loop it is on, though its first trade is clean', async () => {
    // Eight trades between A and B are past a fan: each way is one arrow. A→B's first is a clean trade.
    const hist = [moved(A, B, 1), ...[2, 3, 4, 5, 6, 7, 8].map((n) => (n % 2 === 0 ? moved(B, A, n, LOOP) : moved(A, B, n, LOOP)))];
    Object.assign(state, { history: () => hist });
    const arrow = figure(await one(A)).querySelector(`g[data-edge="b${A}>${B}"] a`)!;
    expect(arrow.getAttribute('href')).toBe(`${BASE}/tx/0x${'1'.repeat(64)}?method=A`);
  });

  it('says why a ring with sales draws nothing when none of its trades is between two of its wallets', async () => {
    Object.assign(state, { history: () => [moved(A, X, 3)] });
    const c = await one(A);
    expect(c.textContent).toContain('None of its trades is between two of its wallets.');
    expect(c.textContent).not.toContain('Nothing of it is drawn.');
  });

  it('keeps its cards apart', async () => {
    const c = await one(A);
    expect(c.querySelector('p.text-lg')!.closest('.space-y-4')).not.toBeNull();
  });

  it('says when its wallet is in no ring of the latest analysis, and links the list', async () => {
    const c = await one(B);
    expect(c.textContent).toContain(`${short(B)} is in no ring of the latest analysis.`);
    expect(links(c)).toContainEqual(['All rings', `${BASE}/rings`]);
  });

  it('links the ring an old link\'s wallet is in now, so the link is no dead end', async () => {
    const c = await one(M);
    expect(c.textContent).toContain(`Rings changed with the latest analysis: ${short(M)} is now in`);
    expect(links(c)).toContainEqual(['Round trips · the floor: Ring 3 ›', `${BASE}/r/${A}`]);
  });
});

describe('the ring chips', () => {
  it('say each ring a thing is in, by rank, and nothing for a thing in none', async () => {
    const { RingChips } = await import('@/components/rings');
    const c = render(<>{await RingChips({ chainId: 1, address: ADDR, of: { wallet: M } })}</>).container;
    expect(links(c)).toEqual([['Round trips · the floor: Part of Ring 3 ›', `${BASE}/r/${A}`]]);
    cleanup();
    expect(await RingChips({ chainId: 1, address: ADDR, of: { wallet: B } })).toBeNull();
  });
});
