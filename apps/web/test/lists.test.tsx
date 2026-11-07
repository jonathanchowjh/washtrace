import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'b'.repeat(40);
const WAL = '0x' + 'c'.repeat(40);
const BASE = `/c/1/${ADDR}`;

const totals = (m: string) => ({
  transfers: 900, flagged: 200, sales: 800, flaggedSales: 180, volumeWei: '9000000000000000000', flaggedVolumeWei: '2000000000000000000',
  // The analysis also counts a token or wallet whose every flagged trade is uncounted, so its totals run over the lists' own counts.
  wallets: 40, tokens: 700, available: m === 'A' || state.moneyRan,
});
const token = (tokenId: string, over: Record<string, unknown> = {}) => ({
  tokenId, caught: 11, trades: 14, volumeWei: '2500000000000000000', lastAt: 1_680_000_000_000, loops: 1, pairs: 0, wallets: 3, closedByMoney: 0, laps: 2, middles: 0, ...over,
});
const wallet = (address: string, over: Record<string, unknown> = {}) => ({
  address, caught: 5, trades: 9, volumeWei: '0', firstAt: 1_670_000_000_000, loops: 2, pairs: 1, partners: 4, ...over,
});
const tokens = (n: number) => Array.from({ length: n }, (_, i) => token(String(7 + i)));

const fresh = () => ({
  moneyRan: true,
  tokens: { rows: [token('7')], total: 1 } as { rows: ReturnType<typeof token>[]; total: number },
  wallets: { rows: [wallet(WAL)], total: 1 } as { rows: ReturnType<typeof wallet>[]; total: number },
  // What a count alone (a limit of 0) finds: each list without its Find.
  counted: { tokens: 644, wallets: 37 },
  calls: { tokens: [] as unknown[][], wallets: [] as unknown[][], counts: [] as unknown[][] },
});
const state = fresh();

/** A list read: a page goes to its kind's calls, a count alone to `counts`. */
function read(kind: 'tokens' | 'wallets', a: unknown[]) {
  if ((a[2] as { limit: number }).limit === 0) {
    state.calls.counts.push([kind, ...a]);
    return { rows: [], total: state.counted[kind] };
  }
  state.calls[kind].push(a);
  return state[kind];
}

const collection = () => ({
  id: 1, chainId: 1, address: ADDR, name: 'Coll', startBlock: 1, cursorBlock: 10, headBlock: 10, transfers: 900, wallets: 37, fundedWallets: 37,
  error: null, stale: false, pausedAt: null, priority: false, trailProgress: null, analysisError: null, storedThroughTime: null, storedThroughBlock: null,
  downloadFile: null, downloadProgress: null, downloadNote: null, restoreProgress: null, restoreNote: null, trailNote: null, trailImportedSha: null,
  rules: {}, contract: null, addedAt: 0, ingestedAt: 0, servedAt: 0, readRate: null,
  latest: {
    ranAt: 1_700_000_000_000, tookMs: 5, throughBlock: 10, missingData: 0, fundedWallets: 37, wallets: 37, truncatedSearches: 0, loops: null,
    totals: Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, totals(m)])),
  },
});

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => collection(),
    history: async () => [],
    timeline: async () => ({ bucket: 'day', untimed: 0, readThrough: null, points: [] }),
    profile: async () => ({ supply: 644, holders: 300, firstMint: null, firstSale: null, lastSale: null, marketplaces: [] }),
    passes: async () => [],
    collections: async () => [],
    sources: async () => ({}),
    settings: async () => new Map(),
    importedFunding: async () => false,
    lensTokens: async (...a: unknown[]) => read('tokens', a),
    lensWallets: async (...a: unknown[]) => read('wallets', a),
  }),
  storedEntry: async () => null,
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => { cleanup(); Object.assign(state, fresh()); });

async function collectionPage(sp: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: Page } = await import('@/app/c/[chain]/[address]/page');
  return render(await Page({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
async function flaggedPage(sp: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: Page } = await import('@/app/c/[chain]/[address]/flagged/page');
  return render(await Page({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
const links = (c: Element) => [...c.querySelectorAll('a')];
const linkTo = (c: Element, href: string) => links(c).find((a) => a.getAttribute('href') === href);
const named = (c: Element, text: string) => links(c).filter((a) => a.textContent === text).map((a) => a.getAttribute('href'));
const list = (c: Element, kind: 'tokens' | 'wallets') => c.querySelector(`[aria-label="${kind === 'tokens' ? 'Tokens' : 'Wallets'} Round trips flagged"]`)!;

describe('the lens lists on the collection page', () => {
  it('every count opens its trades, the loops open the token page lit, and the wallets open their group', async () => {
    const el = list(await collectionPage({ method: 'A' }), 'tokens');
    expect(named(el, '11')).toEqual([`${BASE}/flagged?kind=trades&caught=A&token=7&all=1`]);
    expect(named(el, '14')).toEqual([`${BASE}/flagged?kind=trades&token=7&all=1`]);
    expect(named(el, '1 loop')).toEqual([`${BASE}/t/7?method=A`]);
    expect(named(el, '3 wallets')).toEqual([`${BASE}/flagged?kind=trades&group=A.t.7&all=1`]);
    expect(linkTo(el, `${BASE}/t/7`)?.textContent).toBe('#7');
    expect(el.textContent).toContain('1 loop among 3 wallets, 2 laps');
    expect(el.textContent).toContain('11 of 14 trades');
    expect(el.textContent).toContain('2.5 ETH');
    expect(el.textContent).toContain('flagged of its counted trades');
  });

  it('a wallet row says why in its own words, and its counts open its trades', async () => {
    const el = list(await collectionPage({ method: 'A' }), 'wallets');
    expect(el.textContent).toContain('in 2 loops and 1 linked pair with 4 wallets');
    expect(named(el, '2 loops and 1 linked pair')).toEqual([`${BASE}/flagged?kind=trades&caught=A&wallet=${WAL}&all=1`]);
    expect(named(el, '4 wallets')).toEqual([`${BASE}/flagged?kind=trades&group=A.w.${WAL}&all=1`]);
    expect(named(el, '5')).toEqual([`${BASE}/flagged?kind=trades&caught=A&wallet=${WAL}&all=1`]);
    expect(named(el, '9')).toEqual([`${BASE}/flagged?kind=trades&wallet=${WAL}&all=1`]);
    expect((el.querySelector('input[name=wq]') as HTMLInputElement).placeholder).toBe('Find a wallet (0x…)');
  });

  it('reads ten a list, with the lenses that ran, the money and the reader zone', async () => {
    state.moneyRan = false;
    await collectionPage({ method: 'A' });
    const [id, method, opts, ctx] = state.calls.tokens[0]!;
    expect([id, method]).toEqual([1, 'A']);
    expect(opts).toEqual({ sort: 'caught', find: null, limit: 10, offset: 0 });
    expect(ctx).toMatchObject({ ran: ['A'], zone: 'UTC' });
    expect((ctx as { money: Set<string> }).money.has('')).toBe(true);
    expect(state.calls.wallets[0]![2]).toEqual({ sort: 'caught', find: null, limit: 10, offset: 0 });
  });

  it('sort links keep the lens and end in #evidence; Next appears past ten', async () => {
    state.tokens = { rows: tokens(10), total: 25 };
    const el = list(await collectionPage({ method: 'A' }), 'tokens');
    expect(named(el, 'share')).toEqual([`${BASE}?method=A&ts=share#evidence`]);
    expect(named(el, 'volume')).toEqual([`${BASE}?method=A&ts=volume#evidence`]);
    expect(named(el, 'newest')).toEqual([`${BASE}?method=A&ts=newest#evidence`]);
    expect(named(el, 'most flagged')).toEqual([`${BASE}?method=A#evidence`]);
    expect(named(el, 'Next ›')).toEqual([`${BASE}?method=A&tp=2#evidence`]);
    expect(named(list(el.ownerDocument.body, 'wallets'), 'first seen')).toEqual([`${BASE}?method=A&ws=first#evidence`]);
  });

  it('the two lists page apart', async () => {
    state.tokens = { rows: tokens(10), total: 25 };
    state.wallets = { rows: Array.from({ length: 10 }, (_, i) => wallet(`0x${String(i).repeat(40)}`)), total: 30 };
    const el = await collectionPage({ method: 'A', tp: '2', ws: 'share' });
    expect(state.calls.tokens[0]![2]).toMatchObject({ offset: 10 });
    expect(state.calls.wallets[0]![2]).toMatchObject({ sort: 'share', offset: 0 });
    expect(named(list(el, 'wallets'), 'Next ›')).toEqual([`${BASE}?method=A&tp=2&ws=share&wp=2#evidence`]);
    expect(named(list(el, 'tokens'), 'Next ›')).toEqual([`${BASE}?method=A&tp=3&ws=share#evidence`]);
    expect(list(el, 'tokens').querySelector('input[name=tp]')).not.toBeNull();
    expect(list(el, 'wallets').querySelector('input[name=wp]')).not.toBeNull();
  });

  it('Find narrows the list, says how many match, and is kept on Next and on the sort links', async () => {
    state.tokens = { rows: tokens(10), total: 12 };
    const el = list(await collectionPage({ method: 'A', tq: '14' }), 'tokens');
    expect(state.calls.tokens[0]![2]).toMatchObject({ find: '14' });
    expect(el.textContent).toContain('12 of 644 tokens match “14”');
    expect(named(el, 'Next ›')).toEqual([`${BASE}?method=A&tq=14&tp=2#evidence`]);
    expect(named(el, 'share')).toEqual([`${BASE}?method=A&ts=share&tq=14#evidence`]);
    expect(named(el, 'Clear')).toEqual([`${BASE}?method=A#evidence`]);
    const form = el.querySelector('form[role=search]')!;
    expect(form.getAttribute('action')).toBe(`${BASE}#evidence`);
    expect((form.querySelector('input[name=tq]') as HTMLInputElement).value).toBe('14');
    expect((form.querySelector('input[name=tq]') as HTMLInputElement).placeholder).toBe('Find a token number');
    expect([...form.querySelectorAll('input[type=hidden]')].map((i) => `${(i as HTMLInputElement).name}=${(i as HTMLInputElement).value}`)).toEqual(['method=A']);
    cleanup();
    state.tokens = { rows: [token('14'), token('140')], total: 2 };
    expect((await collectionPage({ method: 'A', tq: '14' })).textContent).toContain('2 of 644 tokens match “14”');
  });

  it('a Find that is no token number matches nothing, and says so', async () => {
    state.tokens = { rows: [], total: 0 };
    const el = list(await collectionPage({ method: 'A', tq: 'hello' }), 'tokens');
    expect(el.textContent).toContain('0 of 644 tokens match “hello”');
    expect(el.textContent).toContain('“hello” is not a token number.');
  });

  it('beneath each list, all of them on the flagged page, keeping sort and Find', async () => {
    state.wallets = { rows: [wallet(WAL)], total: 37 };
    const el = await collectionPage({ method: 'A', ts: 'share', tq: '14' });
    expect(named(el, 'All 644 tokens →')).toEqual([`${BASE}/flagged?method=A&kind=tokens&sort=share&q=14`]);
    expect(named(el, 'All 37 wallets →')).toEqual([`${BASE}/flagged?method=A&kind=wallets`]);
    // Only the list with a Find is counted again without it.
    expect(state.calls.counts).toEqual([['tokens', 1, 'A', { sort: 'caught', find: null, limit: 0, offset: 0 }, expect.objectContaining({ ran: ['A', 'AU', 'AC'] })]]);
  });

  it('a list says its own count, not the analysis totals, which also count tokens whose every flagged trade is uncounted', async () => {
    state.tokens = { rows: tokens(10), total: 600 };
    state.wallets = { rows: [wallet(WAL)], total: 33 };
    const el = await collectionPage({ method: 'A' });
    expect(list(el, 'tokens').textContent).toContain('1–10 of 600 tokens');
    expect(named(el, 'All 600 tokens →')).toHaveLength(1);
    expect(named(el, 'All 33 wallets →')).toHaveLength(1);
    expect(list(el, 'tokens').textContent).not.toContain('700');
    // With no Find there is nothing more to count.
    expect(state.calls.counts).toHaveLength(0);
    cleanup();
    const flagged = await flaggedPage({ method: 'A', kind: 'tokens' });
    expect(flagged.textContent).toContain('600 in all.');
    expect(flagged.textContent).not.toContain('700');
    cleanup();
    expect((await flaggedPage({ method: 'A', kind: 'tokens', q: '14' })).textContent).toContain('600 of 644 tokens match “14”');
  });

  it('names lenses, never codes, and a lens that did not run lists nothing', async () => {
    expect((await collectionPage({ method: 'A' })).textContent).not.toMatch(/\bAU\b|\bAC\b/);
    cleanup();
    state.moneyRan = false;
    state.calls.tokens.length = 0;
    const el = await collectionPage({ method: 'AU' });
    expect(el.textContent).toContain('Money loops back did not run, so it flags nothing.');
    expect(el.querySelector('[aria-label^="Tokens"]')).toBeNull();
    expect(state.calls.tokens).toHaveLength(0);
  });
});

describe('the lens lists on the flagged page', () => {
  it('reads fifty a page with sort, q and page, and its links keep them', async () => {
    state.tokens = { rows: tokens(50), total: 120 };
    const el = await flaggedPage({ method: 'A', kind: 'tokens', sort: 'volume', q: '1', page: '2' });
    expect(state.calls.tokens[0]![2]).toEqual({ sort: 'volume', find: '1', limit: 50, offset: 50 });
    const l = list(el, 'tokens');
    expect(named(l, 'share')).toEqual([`${BASE}/flagged?method=A&kind=tokens&sort=share&q=1`]);
    expect(named(l, 'Next ›')).toEqual([`${BASE}/flagged?method=A&kind=tokens&sort=volume&q=1&page=3`]);
    expect((l.querySelector('input[name=q]') as HTMLInputElement).value).toBe('1');
    expect(l.textContent).toContain('120 of 644 tokens match “1”');
    // The row numbers go on from the page before.
    expect(l.querySelector('li')?.textContent).toMatch(/^51/);
  });

  it('a wallet list sorts by first seen', async () => {
    const el = await flaggedPage({ method: 'A', kind: 'wallets', sort: 'first' });
    expect(state.calls.wallets[0]![2]).toEqual({ sort: 'first', find: null, limit: 50, offset: 0 });
    expect(list(el, 'wallets').querySelector('[aria-current=true]')?.textContent).toBe('first seen');
  });

  it('a page past the last shows the last page; junk is dropped', async () => {
    state.tokens = { rows: [], total: 120 };
    const el = await flaggedPage({ method: 'A', kind: 'tokens', page: '99999', sort: 'nope' });
    expect(state.calls.tokens.map((c) => (c[2] as { offset: number }).offset)).toEqual([99998 * 50, 100]);
    expect(state.calls.tokens[0]![2]).toMatchObject({ sort: 'caught' });
    expect(el.textContent).toContain('101–120 of 120 tokens');
    cleanup();
    state.calls.tokens.length = 0;
    await flaggedPage({ method: 'A', kind: 'tokens', page: '-2' });
    expect(state.calls.tokens[0]![2]).toMatchObject({ offset: 0 });
  });

  it('a lens that did not run says so and reads nothing', async () => {
    state.moneyRan = false;
    const el = await flaggedPage({ method: 'AC', kind: 'wallets' });
    expect(el.textContent).toContain('Linked wallets has not run on this collection, so it flags nothing yet.');
    expect(state.calls.wallets).toHaveLength(0);
  });

  it('the Tokens and Wallets tabs drop the other list\'s sort and Find', async () => {
    const el = await flaggedPage({ method: 'A', kind: 'tokens', sort: 'share', q: '7' });
    const tab = (name: string) => [...el.querySelectorAll('nav[aria-label="Show tokens, wallets or trades"] a')].find((a) => a.textContent === name)?.getAttribute('href');
    expect(tab('Wallets')).toBe(`${BASE}/flagged?method=A&kind=wallets`);
    expect(tab('Tokens')).toBe(`${BASE}/flagged?method=A&kind=tokens&sort=share&q=7`);
  });

  it('titles its tab with its heading', async () => {
    const { generateMetadata } = await import('@/app/c/[chain]/[address]/flagged/page');
    const title = async (sp: Record<string, string>) => (await generateMetadata({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).title;
    expect(await title({ method: 'A', kind: 'tokens' })).toBe('Tokens flagged by Round trips');
    expect(await title({ method: 'AC', kind: 'wallets' })).toBe('Wallets flagged by Linked wallets');
    expect(await title({ kind: 'trades' })).toBe('Trades in Coll');
  });
});
