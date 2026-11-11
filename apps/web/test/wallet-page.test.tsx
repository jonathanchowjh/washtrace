import { cleanup, render } from '@testing-library/react';
import { isValidElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlaggedTransfer, Flow, WalletFilter } from '@washtrace/detect';
import { TINT_LEAD } from '@/lib/metrics';
import { short } from '@/lib/format';

let funding: object | null = null;
let trades = 0;
let flaggedTrades = 0;
/** Where the flagged trades start, newest first: past 20, none is on the first page. */
let flaggedFrom = 0;
let moneyOnlyTrades = 0;
let unjudgedTrades = 0;
let counterparties = 0;
/** Payments the wallet sent its first partner, then those it received from it. */
let sentFlows = 0;
let receivedFlows = 0;
/** Trades between the wallet and its first partner. */
let betweenTrades = 0;
let middleTokens: number | null = null;
let ownPairs: { middle: string; shape: string | null }[] = [];
let middles: { tokenId: string; seller: string; buyer: string; ring: string | null; shape: string | null }[] = [];
/** The collections it is a never-traded middle of (Store.middleIn). */
let middleIn: { address: string; name: string | null }[] = [];
const SELF = `0x${'a'.repeat(40)}`;
const COLL = '0x' + 'b'.repeat(40);
const OTHER = '0x' + 'c'.repeat(40);
const partner = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`;
const totals = Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, { available: true }]));

/** The wallet's trades, newest first; the last `unjudgedTrades` are in a collection no analysis has covered. */
function rows(): FlaggedTransfer[] {
  return Array.from({ length: trades }, (_, i) => ({
    txHash: '0x' + i, logIndex: 0, blockNumber: 1, tokenId: String(i), from: '0x1', to: '0x2', blockTime: null, marketplace: null, priceWei: null, currency: null,
    flags: i >= flaggedFrom && i < flaggedFrom + flaggedTrades ? { A: { kind: 'scc', wallets: ['0x1', '0x2'], cycles: 2 } }
      : i >= flaggedFrom + flaggedTrades && i < flaggedFrom + flaggedTrades + moneyOnlyTrades ? { AU: { kind: 'pair', pair: ['0x1', '0x2'], middle: null, flowTx: '0xf' } } : {},
    collection: { chainId: 1, address: i >= trades - unjudgedTrades ? OTHER : COLL, name: null },
  }));
}
/** As the store narrows them; flagged only as the page reads flagged, a counted lens that ran in the row's collection. */
function narrowed(f: WalletFilter = {}): FlaggedTransfer[] {
  if (f.with !== undefined) {
    return Array.from({ length: betweenTrades }, (_, i) => ({ ...rows()[0]!, txHash: '0xb' + i, tokenId: `9${i}`, from: SELF, to: f.with!, flags: {}, collection: { chainId: 1, address: COLL, name: null } }));
  }
  return rows().filter((t) => (f.collection === undefined || t.collection?.address === f.collection)
    && (!f.flaggedOnly || (t.collection?.address !== OTHER && (t.flags.A !== undefined || t.flags.AC !== undefined)))
    && (f.find === undefined || /^\d+$/.test(f.find) && t.tokenId === f.find));
}
function flows(dir: 'sent' | 'received' | 'both'): Flow[] {
  const one = (from: string, to: string, i: number): Flow => ({ txHash: `0xf${from === SELF ? 's' : 'r'}${i}`, kind: 'native', from, to, valueWei: '1000000000000000000', token: '', blockNumber: i, blockTime: 1_700_000_000 + i });
  return [
    ...(dir === 'received' ? [] : Array.from({ length: sentFlows }, (_, i) => one(SELF, partner(0), i))),
    ...(dir === 'sent' ? [] : Array.from({ length: receivedFlows }, (_, i) => one(partner(0), SELF, i))),
  ];
}
vi.mock('@/lib/store', () => ({
  store: () => ({
    wallet: async () => funding,
    collection: async (c: number, a: string) => ({ id: 1, chainId: c, address: a, latest: a === OTHER ? null : { throughBlock: 1000, totals } }),
    counterparties: async (_c: number, _a: string, limit: number, offset: number) => Array.from({ length: counterparties }, (_, i) => ({ address: partner(i), flows: 2, sent: 1, received: 1, watched: false })).slice(offset, offset + limit),
    counterpartyCount: async () => counterparties,
    walletTransfers: async (_c: number, _a: string, limit: number, offset: number, f?: WalletFilter) => narrowed(f).slice(offset, offset + limit),
    walletTradeCount: async (_c: number, _a: string, f?: WalletFilter) => narrowed(f).length,
    middleOf: async () => ({ rows: middles, tokens: middleTokens ?? new Set(middles.map((m) => m.tokenId)).size }),
    middlesOf: async () => ownPairs,
    middleIn: async () => middleIn,
    // As the store groups its trades: a collection it has none in is not one of them.
    walletCollections: async () => [...(trades > unjudgedTrades ? [{ address: COLL, name: 'Bees', trades: trades - unjudgedTrades }] : []), ...(unjudgedTrades > 0 ? [{ address: OTHER, name: null, trades: unjudgedTrades }] : [])],
    flowsBetween: async (_c: number, _a: string, _b: string, dir: 'sent' | 'received' | 'both', limit: number, offset: number) => flows(dir).slice(offset, offset + limit),
    flowsBetweenCount: async (_c: number, _a: string, _b: string, dir: 'sent' | 'received' | 'both') => flows(dir).length,
  }),
}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));

afterEach(() => {
  cleanup();
  trades = 0; flaggedTrades = 0; flaggedFrom = 0; moneyOnlyTrades = 0; unjudgedTrades = 0; counterparties = 0; funding = null;
  sentFlows = 0; receivedFlows = 0; betweenTrades = 0; middles = []; middleTokens = null; ownPairs = []; middleIn = [];
});

const params = Promise.resolve({ chain: '1', address: SELF });
const here = `/w/1/${SELF}`;

async function render_(sp: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: WalletPage } = await import('@/app/w/[chain]/[address]/page');
  return render(await WalletPage({ params, searchParams: Promise.resolve(sp) })).container;
}
async function page(sp: Record<string, string> = {}): Promise<string> {
  return (await render_(sp)).textContent ?? '';
}
const linkTo = (el: HTMLElement, text: string) => [...el.querySelectorAll('a')].find((a) => a.textContent === text)?.getAttribute('href');
/** The pager whose range names `label`, and one of its links. */
function pager(el: HTMLElement, label: string) {
  const nav = [...el.querySelectorAll('nav[aria-label="Pages"]')].find((n) => n.textContent?.includes(label)) as HTMLElement | undefined;
  return { text: nav?.textContent ?? '', link: (text: string) => (nav ? linkTo(nav, text) : undefined) };
}
const tokenShown = (el: HTMLElement, n: number) => [...el.querySelectorAll('a')].some((a) => a.getAttribute('href') === `/c/1/${COLL}/t/${n}`);

describe('the wallet page', () => {
  it('opens the flagged trades on the flagged count, and the whole list on the total, over all its trades', async () => {
    trades = 500; flaggedTrades = 3;
    const el = await render_();
    expect(el.textContent).toContain('In 3 flagged transfers out of 500');
    expect(el.textContent).not.toContain('its latest');
    expect(linkTo(el, '3')).toBe(`${here}?flagged=1`);
    expect(linkTo(el, '500')).toBe(here);
  });

  it('heads with the whole address once: the title holds it, and the line under it does not repeat it', async () => {
    trades = 2;
    const el = await render_();
    expect(el.querySelector('h1')!.textContent).toBe(SELF);
    expect(el.textContent!.split(SELF).length - 1).toBe(1);
  });

  it('the title’s flagged count is what the flagged-only list holds', async () => {
    // Round trips flags 4; Money loops back 2, not counted; and 3 of the 10 in a collection no analysis covered.
    trades = 500; flaggedTrades = 4; moneyOnlyTrades = 2; unjudgedTrades = 10;
    const el = await render_();
    const title = Number(/In (\d+) flagged transfers out of/.exec(el.textContent ?? '')![1]);
    expect(linkTo(el, String(title))).toBe(`${here}?flagged=1`);
    expect(await page({ flagged: '1' })).toContain(`${title} of 500 transfers match`);
  });

  it('a wallet whose flagged trades are all past the first page titles as flagged, and says none is on this page', async () => {
    trades = 150; flaggedFrom = 30; flaggedTrades = 2;
    const el = await render_();
    const text = el.textContent ?? '';
    expect(text).toContain('In 2 flagged transfers out of 150');
    expect(text).not.toContain('Not flagged by any lens');
    expect(text).toContain('None of them is on this page.');
    expect(linkTo(el, 'Show the flagged ones')).toBe(`${here}?flagged=1`);
    // The page that holds them says nothing of the kind.
    expect(await page({ trades: '2' })).not.toContain('None of them');
  });

  it('a flagged wallet never sits in a clean card, and the lead claims no cover for trades it does not hold', async () => {
    trades = 150; flaggedFrom = 30; flaggedTrades = 2;
    const el = await render_();
    const card = [...el.querySelectorAll('p')].find((p) => p.textContent?.startsWith('In 2 flagged transfers'))!.closest('div.rounded-lg')!;
    expect(card.className).toContain('bg-ceiling-surface');
    expect(el.textContent).toContain('Transfers 1–20 of 150 are shown.');
    expect(el.textContent).not.toContain('covers these');
    cleanup();
    // The page that holds them keeps its own verdict's tone, and says the verdict covers them.
    const two = await render_({ trades: '2' });
    const card2 = [...two.querySelectorAll('p')].find((p) => p.textContent?.startsWith('In 2 flagged transfers'))!.closest('div.rounded-lg')!;
    expect(card2.className).toContain('bg-cycle-surface');
    expect(two.textContent).toContain('the verdict above covers these');
  });

  it('a flagged wallet whose filter matches nothing still sits in a flagged card', async () => {
    trades = 50; flaggedTrades = 2;
    const el = await render_({ q: '999' });
    const card = [...el.querySelectorAll('p')].find((p) => p.textContent?.startsWith('In 2 flagged transfers'))!.closest('div.rounded-lg')!;
    expect(card.className).toContain('bg-ceiling-surface');
  });

  it('a filter that holds none of its flagged trades titles as flagged, and says none matches', async () => {
    trades = 50; flaggedTrades = 2;
    const el = await render_({ q: '30' });
    const text = el.textContent ?? '';
    expect(text).toContain('In 2 flagged transfers out of 50');
    expect(text).toContain('None of them matches these filters.');
    expect(linkTo(el, 'Show the flagged ones')).toBe(`${here}?flagged=1`);
    expect(text).toContain('1 of 50 transfers matches “30” · Clear');
  });

  it('a filter that matches nothing still titles a flagged wallet from its counts', async () => {
    trades = 50; flaggedTrades = 2;
    const text = await page({ q: '999' });
    expect(text).toContain('In 2 flagged transfers out of 50');
    expect(text).toContain('None of them matches these filters.');
  });

  it('says a wallet read from stored data was, with no dangling space before the full stop', async () => {
    funding = { status: 'done', transfers: 0, truncated: false, fetchedAt: null, error: null };
    expect(await page()).toContain('Its money was read from stored data.');
  });

  it('a wallet with exactly 20 trades is one page and says nothing about a cut', async () => {
    trades = 20;
    const text = await page();
    expect(text).toContain('Not flagged by any lens');
    expect(text).toContain('Every transfer it sent or received in a watched collection.');
    expect(text).not.toContain('are shown');
  });

  it('a wallet with more than 20 trades names the page shown, and its verdict covers those', async () => {
    trades = 21;
    const text = await page();
    expect(text).toContain('Not flagged by any lens');
    expect(text).toContain('Transfers 1–20 of 21 are shown; the verdict above covers these.');
  });

  it('one flagged trade is singular', async () => {
    trades = 101;
    flaggedTrades = 1;
    expect(await page()).toContain('In 1 flagged transfer out of 101');
  });

  it('?trades=2 shows rows 21–40, with a working Previous', async () => {
    trades = 500;
    const el = await render_({ trades: '2' });
    expect(el.textContent).toContain('Transfers 21–40 of 500 are shown; the verdict above covers these.');
    expect(tokenShown(el, 20)).toBe(true);
    expect(tokenShown(el, 39)).toBe(true);
    expect(tokenShown(el, 19)).toBe(false);
    expect(tokenShown(el, 40)).toBe(false);
    const trades_ = pager(el, 'transfers');
    expect(trades_.text).toContain('21–40 of 500 transfers');
    expect(trades_.link('‹ Previous')).toBe(here);
    expect(trades_.link('Next ›')).toBe(`${here}?trades=3`);
  });

  it('pages its partners on their own param, each pager keeping the other’s page', async () => {
    trades = 500; counterparties = 50;
    const el = await render_({ trades: '2', partners: '3' });
    expect(el.textContent).toContain('41–50 of 50 counterparties');
    expect(pager(el, 'transfers').text).toContain('21–40 of 500 transfers');
    expect(pager(el, 'counterparties').link('‹ Previous')).toBe(`${here}?trades=2&partners=2`);
    expect(pager(el, 'transfers').link('Next ›')).toBe(`${here}?trades=3&partners=3`);
  });

  it('a page past the end is clamped to the last', async () => {
    trades = 500;
    const el = await render_({ trades: '99999' });
    expect(el.textContent).toContain('Transfers 481–500 of 500 are shown');
    expect(tokenShown(el, 499)).toBe(true);
  });

  it('collection= and flagged=1 narrow the trades and say how many match', async () => {
    trades = 500; flaggedTrades = 3; unjudgedTrades = 10;
    const flagged = await render_({ flagged: '1' });
    expect(flagged.textContent).toContain('3 of 500 transfers match');
    expect([0, 1, 2].every((n) => tokenShown(flagged, n))).toBe(true);
    expect(tokenShown(flagged, 3)).toBe(false);
    cleanup();
    const one = await page({ collection: OTHER });
    expect(one).toContain('10 of 500 transfers match');
    expect(one).toContain('Transfers 1–10 of 10 are shown');
  });

  it('a Find that names no token or wallet says it matches nothing', async () => {
    trades = 5;
    const text = await page({ q: 'hello' });
    expect(text).toContain('0 of 5 transfers match');
    expect(text).toContain('“hello” is not a token number, or a wallet address or the start of one, so it matches nothing.');
  });

  it('the match line and the shown line agree in number', async () => {
    trades = 5; flaggedTrades = 2;
    expect(await page({ q: '3' })).toContain('1 of 5 transfers matches');
    cleanup();
    const two = await page({ flagged: '1' });
    expect(two).toContain('2 of 5 transfers match ·');
    expect(two).toContain('Transfers 1–2 of 2 are shown; the verdict above covers these.');
    cleanup();
    trades = 1; flaggedTrades = 1;
    const one = await page({ flagged: '1' });
    expect(one).toContain('1 of 1 transfer matches');
    expect(one).toContain('Transfer 1 of 1 is shown; the verdict above covers it.');
    cleanup();
    // A last page holding one trade reads the same way.
    trades = 21; flaggedTrades = 0;
    expect(await page({ trades: '2' })).toContain('Transfer 21 of 21 is shown; the verdict above covers it.');
  });

  it('sorts its partners by their headers, and each count opens what passed between the two', async () => {
    trades = 500; counterparties = 3;
    const el = await render_({ trades: '2' });
    const header = (text: string) => [...el.querySelectorAll('th a')].find((a) => a.textContent?.startsWith(text))?.getAttribute('href');
    expect(header('Payments sent to it')).toBe(`${here}?trades=2&psort=sent`);
    expect(header('Payments received from it')).toBe(`${here}?trades=2&psort=received`);
    // The default order is by payments in all, and only that head says so.
    expect([...el.querySelectorAll('th[aria-sort]')].map((t) => `${t.textContent}:${t.getAttribute('aria-sort')}`)).toEqual(['Payments in all:descending']);
    const row = [...el.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(short(partner(0))))!;
    const cells = [...row.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(cells).toContain(`${here}?trades=2&with=${partner(0)}&dir=sent#between`);
    expect(cells).toContain(`${here}?trades=2&with=${partner(0)}&dir=received#between`);
  });

  it('a flagged wallet says what it means, as the token page does; a clean one does not', async () => {
    trades = 5; flaggedTrades = 2;
    expect(await page()).toContain('What this means: Tokens it traded came back to a wallet that sold them.');
    cleanup();
    flaggedTrades = 0;
    expect(await page()).not.toContain('What this means');
  });

  it('its payment counts look like the links they are, and the kinds of payment sit in the lead, not floated beside it', async () => {
    trades = 5; counterparties = 1;
    const el = await render_();
    const count = [...el.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(short(partner(0))))!.querySelector('td.text-right a')!;
    expect(count.className).toMatch(/\bunderline\b/);
    const section = [...el.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === 'Who did it move money with?')!;
    expect(section.querySelector('h2')!.nextElementSibling!.textContent).toContain('Payments are native, internal and wrapped-native, both directions.');
  });

  it('with=…&dir=sent lists the payments it sent and the trades between the two', async () => {
    trades = 5; counterparties = 3; sentFlows = 3; receivedFlows = 1; betweenTrades = 2;
    const el = await render_({ with: partner(0), dir: 'sent' });
    const between = el.querySelector('#between') as HTMLElement;
    expect(between.textContent).toContain(`What passed between this wallet and ${short(partner(0))}?`);
    expect(between.textContent).toContain('3 payments');
    expect(between.querySelectorAll('a[href^="https://etherscan.io/tx/0xfs"]')).toHaveLength(3);
    expect(between.querySelectorAll('a[href^="https://etherscan.io/tx/0xfr"]')).toHaveLength(0);
    expect([90, 91].every((n) => [...between.querySelectorAll('a')].some((a) => a.getAttribute('href') === `/c/1/${COLL}/t/${n}`))).toBe(true);
    expect(linkTo(between, 'both ways')).toBe(`${here}?with=${partner(0)}#between`);
  });

  it('more than 20 payments between two wallets page on their own param', async () => {
    sentFlows = 30;
    const el = await render_({ with: partner(0), flows: '2' });
    const flows_ = pager(el, 'payments');
    expect(flows_.text).toContain('21–30 of 30 payments');
    expect(flows_.link('‹ Previous')).toBe(`${here}?with=${partner(0)}#between`);
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
    expect(text).toContain('Its transfers are read, but no analysis has covered them yet. That is not the same as clean.');
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

  it('walletView pages 20 trades and 20 partners, and says each is cut', async () => {
    trades = 21;
    counterparties = 21;
    const { walletView } = await import('@/lib/views');
    const { walletOpts } = await import('@/lib/params');
    const v = await walletView(1, SELF, walletOpts({}));
    expect(v.transfers).toHaveLength(20);
    expect(v.counterparties).toHaveLength(20);
    expect(v.cut).toEqual({ trades: true, counterparties: true });
    expect(v.pages).toEqual({ trades: { page: 1, pages: 2, total: 21 }, partners: { page: 1, pages: 2, total: 21 }, flows: { page: 1, pages: 1, total: 0 } });
    expect(v.between).toBeNull();
  });

  it('the wallets route takes the page’s params, and returns cut, the pages and the verdict fields', async () => {
    trades = 21;
    flaggedTrades = 1;
    const { GET } = await import('@/app/api/wallets/[chain]/[address]/route');
    const body = await (await GET(new Request('http://x/api/wallets/1/a?trades=2&flagged=junk&psort=nope'), { params })).json();
    expect(body).toMatchObject({ cut: { trades: true, counterparties: false }, pages: { trades: { page: 2, pages: 2, total: 21 } }, washTrade: false, judged: true, methods: [] });
    expect(body.transfers).toHaveLength(1);
    expect(body).not.toHaveProperty('by');
  });

  it('the latest-page verdict in the route covers the page asked for', async () => {
    trades = 1;
    flaggedTrades = 1;
    const { GET } = await import('@/app/api/wallets/[chain]/[address]/route');
    const body = await (await GET(new Request('http://x'), { params })).json();
    expect(body).toMatchObject({ cut: { trades: false, counterparties: false }, washTrade: true, judged: true, methods: ['A'], between: null });
  });
});

/** Every element of `type` in a page's tree, through every prop: the panels read in their own Suspense, so the tree is where they show. */
function elementsOf(node: unknown, type: unknown): { props: Record<string, unknown> }[] {
  const out: { props: Record<string, unknown> }[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!isValidElement(n)) return;
    if (n.type === type) out.push(n as { props: Record<string, unknown> });
    Object.values(n.props as Record<string, unknown>).forEach(walk);
  };
  walk(node);
  return out;
}

describe('the wallet outside any collection\'s tabs', () => {
  async function tree() {
    const { default: WalletPage } = await import('@/app/w/[chain]/[address]/page');
    return WalletPage({ params, searchParams: Promise.resolve({}) });
  }

  it('in one collection: its parent line names it after "/", and the page opens under its tabs', async () => {
    trades = 2;
    const el = await render_();
    const line = [...el.querySelectorAll('a')].find((a) => a.textContent === 'Collections')!.parentElement!;
    // The page itself ends the line, as plain text.
    expect(line.textContent).toMatch(/^Collections\/Bees\/0x/);
    expect(line.closest('header')).toBeNull();
    expect(linkTo(el, 'Open in Bees →')).toBe(`/c/1/${COLL}/w/${SELF}`);
  });

  it('in one collection: its ring chips, strip and Connected to are that collection\'s', async () => {
    trades = 2; counterparties = 1;
    const t = await tree();
    const { RingChips } = await import('@/components/rings');
    const { WhereItSits } = await import('@/components/sales-strip');
    const { ConnectedRail } = await import('@/components/connected-rail');
    for (const type of [RingChips, WhereItSits]) expect(elementsOf(t, type).map((e) => [e.props.address, e.props.of])).toEqual([[COLL, { wallet: SELF }]]);
    const rail = elementsOf(t, ConnectedRail);
    expect(rail.map((e) => e.props.address)).toEqual([COLL]);
    expect(rail[0]!.props.wallets).toContainEqual({ address: partner(0), role: 'funder · payee' });
  });

  it('in several collections: no one collection\'s panels, and each collection a link under its tabs', async () => {
    trades = 3; unjudgedTrades = 1;
    const t = await tree();
    const { ConnectedRail } = await import('@/components/connected-rail');
    expect(elementsOf(t, ConnectedRail)).toEqual([]);
    const el = render(t).container;
    const nav = el.querySelector('nav[aria-label="Its collections"]')!;
    expect([...nav.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]))
      .toEqual([['Bees', `/c/1/${COLL}/w/${SELF}`], [short(OTHER), `/c/1/${OTHER}/w/${SELF}`]]);
    expect([...el.querySelectorAll('a')].find((a) => a.textContent === 'Collections')!.parentElement!.textContent).toMatch(/^Collections\/0x/);
  });
});

describe('the wallet under a collection\'s tabs', () => {
  const inColl = `/c/1/${COLL}`;
  async function scoped(sp: Record<string, string> = {}): Promise<HTMLElement> {
    const { default: Page } = await import('@/app/c/[chain]/[address]/w/[wallet]/page');
    return render(await Page({ params: Promise.resolve({ chain: '1', address: COLL, wallet: SELF }), searchParams: Promise.resolve(sp) })).container;
  }

  it('counts and lists only its trades in that collection, whatever ?collection= says', async () => {
    // Ten trades: the last four in another collection, two flagged here.
    trades = 10; unjudgedTrades = 4; flaggedTrades = 2;
    const el = await scoped({ collection: OTHER });
    expect(el.textContent).toContain('In 2 flagged transfers out of 6');
    expect(el.querySelector('select[name="collection"]')).toBeNull();
    // The plain page under the tabs is no filter of the reader's.
    expect(el.textContent).toContain('Every transfer it sent or received in this collection.');
  });

  it('keeps its trades\' links and its money partners\' inside the collection', async () => {
    trades = 2; counterparties = 1;
    const el = await scoped();
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain(`${inColl}/w/0x1`);
    // Each trade still opens its token.
    expect(hrefs).toContain(`/c/1/${COLL}/t/0`);
    // A money partner opens under the collection's tabs too, as every other wallet here does; the wallet's own page says when it never traded.
    expect(hrefs).toContain(`${inColl}/w/${partner(0)}`);
    expect(hrefs).not.toContain(`/w/1/${partner(0)}`);
    expect(linkTo(el, 'in every collection')).toBe(here);
    // Its own links (a sort, a page) stay on this page.
    expect(hrefs.some((h) => h.startsWith(`${inColl}/w/${SELF}?`))).toBe(true);
  });

  it('opened from a list, every link of its own keeps the lens and the list; one to another kind keeps the lens; it draws no Trades link', async () => {
    trades = 2; counterparties = 2; flaggedTrades = 1;
    const from = 'wallets?method=AC';
    const el = await scoped({ method: 'AC', from });
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    const ctx = `method=AC&from=${encodeURIComponent(from)}`;
    // Its own sorts and filters stay the same reading.
    expect(hrefs).toContain(`${inColl}/w/${SELF}?${ctx}`);
    expect(hrefs).toContain(`${inColl}/w/${SELF}?flagged=1&${ctx}`);
    expect(hrefs.some((h) => h.startsWith(`${inColl}/w/${SELF}?psort=`) && h.includes(ctx))).toBe(true);
    // Its partners and tokens are other kinds of item: the lens goes with them, the list does not.
    expect(hrefs).toContain(`${inColl}/w/${partner(0)}?method=AC`);
    expect(hrefs).toContain(`${inColl}/t/0?method=AC`);
    // Its Find form puts both back.
    const hidden = [...el.querySelectorAll('form[role=search] input[type=hidden]')].map((i) => [i.getAttribute('name'), i.getAttribute('value')]);
    expect(hidden).toEqual(expect.arrayContaining([['method', 'AC'], ['from', from]]));
    // R15 for this page: it draws no Trades link of its own (the sales strip's come in a Suspense), so none can gain a list's `from`.
    expect(hrefs.filter((h) => /\/trades\b/.test(h))).toEqual([]);
  });

  it('outside the tabs keeps no lens or list: the page across every collection has neither', async () => {
    trades = 2; counterparties = 1;
    const el = await render_({ method: 'AC', from: 'wallets?method=AC' });
    for (const a of el.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toContain('from=wallets');
      expect(a.getAttribute('href') ?? '').not.toContain('method=');
    }
  });

  it('with no trade in the collection says so, and not that it is in none', async () => {
    trades = 3; unjudgedTrades = 3;
    const text = (await scoped()).textContent ?? '';
    expect(text).toContain(`No transfer of it in ${short(COLL)}`);
    expect(text).not.toContain('Not in any watched collection');
  });

  it('a wallet that never traded here claims no part of it, and its lines agree', async () => {
    const { default: Page } = await import('@/app/c/[chain]/[address]/w/[wallet]/page');
    const t = await Page({ params: Promise.resolve({ chain: '1', address: COLL, wallet: SELF }), searchParams: Promise.resolve({}) });
    const { ConnectedRail } = await import('@/components/connected-rail');
    expect(elementsOf(t, ConnectedRail)).toEqual([]);
    const text = render(t).container.textContent ?? '';
    expect(text).toContain('Its money is not read: no transfer of it is read in a watched collection.');
    expect(text).toContain(`No transfer of it is read in ${short(COLL)}.`);
    expect(text).not.toContain('No transfers read yet');
    expect(text).not.toContain('never traded');
  });

  it('a never-traded middle leads with its role in Linked wallets\' tone, and says whose payments the table reads', async () => {
    counterparties = 2;
    const pair = { seller: partner(0), buyer: partner(1), ring: null };
    middles = [{ ...pair, tokenId: '114', shape: 'funder' }];
    const one = await scoped();
    expect(one.textContent).toContain('Funded the seller and buyer of #114');
    expect(one.textContent).not.toContain('No transfer of it in');
    expect(linkTo(one, '#114')).toBe(`${inColl}/t/114`);
    expect(one.querySelector('p.text-ceiling')?.textContent).toContain('Funded the seller and buyer of #114');
    expect(one.textContent).toContain('The payments below were read from the wallets it paid or was paid by; its own history is not read.');
    expect(one.textContent).not.toContain('Its money is not read');
    // It is the middle of 32 tokens; the store reads 20 rows and counts the rest.
    middles = Array.from({ length: 20 }, (_, i) => ({ ...pair, tokenId: String(114 + i), shape: 'back' }));
    middleTokens = 32;
    expect((await scoped()).textContent).toContain("Passed the buyers' money back to the sellers of #114 and 31 more");
    // A pair stored without a shape says only that it sat between.
    middles = [{ ...pair, tokenId: '114', shape: null }];
    expect((await scoped()).textContent).toContain('Is in between the seller and buyer of #114');
  });

  it('across every collection, a wallet that traded in none but is a middle in one leads with that role in Linked wallets\' tone, and opens it there', async () => {
    counterparties = 2;
    middleIn = [{ address: COLL, name: 'Bees' }];
    const el = await render_();
    expect(el.textContent).not.toContain('Not in any watched collection');
    expect(el.querySelector('p.text-ceiling')?.textContent).toBe('Is in between sellers and buyers in Bees');
    expect(linkTo(el, 'Bees')).toBe(`${inColl}/w/${SELF}`);
    expect(el.textContent).toContain('The payments below were read from the wallets it paid or was paid by; its own history is not read.');
    middleIn = [{ address: COLL, name: 'Bees' }, { address: OTHER, name: null }];
    const two = await render_();
    expect(two.querySelector('p.text-ceiling')?.textContent).toBe(`Is in between sellers and buyers in Bees and ${short(OTHER)}`);
    expect(linkTo(two, short(OTHER))).toBe(`/c/1/${OTHER}/w/${SELF}`);
  });

  it('names the wallet\'s own page as the canonical one', async () => {
    const { generateMetadata } = await import('@/app/c/[chain]/[address]/w/[wallet]/page');
    expect(await generateMetadata({ params: Promise.resolve({ chain: '1', address: COLL, wallet: SELF }), searchParams: Promise.resolve({}) }))
      .toEqual({ title: short(SELF), alternates: { canonical: here } });
  });
});
