import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';

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


/** A saved lens of yours and its run on this collection (null: it has none here). */
const ownRun = (id: number, name: string, status: 'done' | 'queued' = 'done', over: Record<string, unknown> = {}) => ({
  lens: { id, key: `L${id}`, name, rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 },
  run: { lensId: id, collectionId: 1, status, progress: null, lensVersion: 1, analysisId: 1, throughBlock: 10, totals: status === 'done' ? { available: true } : null, error: null, retryAt: null, finishedAt: null, tookMs: 1, ...over },
});

const fresh = () => ({
  runs: [] as ReturnType<typeof ownRun>[], moneyRan: true,
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
    id: 1, ranAt: 1_700_000_000_000, tookMs: 5, throughBlock: 10, missingData: 0, fundedWallets: 37, wallets: 37, truncatedSearches: 0, loops: null,
    totals: Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, totals(m)])),
  },
});

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => collection(),
    lensRuns: async () => state.runs,
    moneyRead: async () => ({ traders: { checked: 0, of: 0 }, limit: 3, ownLimit: null, pendingByDepth: {}, estimate: null, seeding: false }),
    history: async () => [],
    timeline: async () => ({ bucket: 'day', untimed: 0, readThrough: null, points: [] }),
    profile: async () => ({ supply: 644, holders: 300, firstMint: null, firstSale: null, lastSale: null, marketplaces: [] }),
    passes: async () => [],
    collections: async () => [],
    sources: async () => ({}),
    settings: async () => new Map(),
    importedMoney: async () => false,
    lensTokens: async (...a: unknown[]) => read('tokens', a),
    lensWallets: async (...a: unknown[]) => read('wallets', a),
  }),
  storedEntry: async () => null,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, redirect: (to: string) => { throw new Error(`redirect:${to}`); }, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => { cleanup(); Object.assign(state, fresh()); });

async function collectionPage(sp: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: Page } = await import('@/app/c/[chain]/[address]/methods/page');
  return render(await Page({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
/** The Tokens or Wallets list, as `kind` picks, with the rest of `sp` as its address bar. */
async function flaggedPage({ kind, ...sp }: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: Page } = kind === 'wallets' ? await import('@/app/c/[chain]/[address]/wallets/page') : await import('@/app/c/[chain]/[address]/tokens/page');
  return render(await Page({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
const links = (c: Element) => [...c.querySelectorAll('a')];
/** Every text, aria-label and title in `c`: a lens key may show in none of them. */
const reads = (c: Element) => [c.textContent, ...[...c.querySelectorAll('[aria-label],[title]')].flatMap((e) => [e.getAttribute('aria-label'), e.getAttribute('title')])].join('\n');
const linkTo = (c: Element, href: string) => links(c).find((a) => a.getAttribute('href') === href);
const named = (c: Element, text: string) => links(c).filter((a) => a.textContent === text).map((a) => a.getAttribute('href'));
const list = (c: Element, kind: 'tokens' | 'wallets') => c.querySelector(`[aria-label="${kind === 'tokens' ? 'Tokens' : 'Wallets'} Round trips flagged"]`)!;

describe('the lens lists on the collection page', () => {
  it('every count opens its trades, the loops open the token page lit, and the wallets open their group', async () => {
    const el = list(await collectionPage({ method: 'A' }), 'tokens');
    expect(named(el, '11')).toEqual([`${BASE}/trades?caught=A&token=7&all=1`]);
    expect(named(el, '14')).toEqual([`${BASE}/trades?token=7&all=1`]);
    expect(named(el, '1 loop')).toEqual([`${BASE}/t/7?method=A`]);
    expect(named(el, '3 wallets')).toEqual([`${BASE}/trades?group=A.t.7&all=1`]);
    expect(linkTo(el, `${BASE}/t/7`)?.textContent).toBe('#7');
    expect(el.textContent).toContain('1 loop among 3 wallets, 2 cycles');
    expect(el.textContent).toContain('11 of 14 trades');
    expect(el.textContent).toContain('2.5 ETH');
    expect(el.textContent).toContain('flagged of its counted trades');
  });

  it('a wallet row says why in its own words, and its counts open its trades', async () => {
    const el = list(await collectionPage({ method: 'A' }), 'wallets');
    expect(el.textContent).toContain('in 2 loops and 1 linked pair with 4 wallets');
    expect(named(el, '2 loops and 1 linked pair')).toEqual([`${BASE}/trades?caught=A&wallet=${WAL}&all=1`]);
    expect(named(el, '4 wallets')).toEqual([`${BASE}/trades?group=A.w.${WAL}&all=1`]);
    expect(named(el, '5')).toEqual([`${BASE}/trades?caught=A&wallet=${WAL}&all=1`]);
    expect(named(el, '9')).toEqual([`${BASE}/trades?wallet=${WAL}&all=1`]);
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
    expect(named(el, 'share')).toEqual([`${BASE}/methods?method=A&ts=share#evidence`]);
    expect(named(el, 'volume')).toEqual([`${BASE}/methods?method=A&ts=volume#evidence`]);
    expect(named(el, 'newest')).toEqual([`${BASE}/methods?method=A&ts=newest#evidence`]);
    expect(named(el, 'most flagged')).toEqual([`${BASE}/methods?method=A#evidence`]);
    expect(named(el, 'Next ›')).toEqual([`${BASE}/methods?method=A&tp=2#evidence`]);
    expect(named(list(el.ownerDocument.body, 'wallets'), 'first seen')).toEqual([`${BASE}/methods?method=A&ws=first#evidence`]);
  });

  it('the two lists page apart', async () => {
    state.tokens = { rows: tokens(10), total: 25 };
    state.wallets = { rows: Array.from({ length: 10 }, (_, i) => wallet(`0x${String(i).repeat(40)}`)), total: 30 };
    const el = await collectionPage({ method: 'A', tp: '2', ws: 'share' });
    expect(state.calls.tokens[0]![2]).toMatchObject({ offset: 10 });
    expect(state.calls.wallets[0]![2]).toMatchObject({ sort: 'share', offset: 0 });
    expect(named(list(el, 'wallets'), 'Next ›')).toEqual([`${BASE}/methods?method=A&tp=2&ws=share&wp=2#evidence`]);
    expect(named(list(el, 'tokens'), 'Next ›')).toEqual([`${BASE}/methods?method=A&tp=3&ws=share#evidence`]);
    expect(list(el, 'tokens').querySelector('input[name=tp]')).not.toBeNull();
    expect(list(el, 'wallets').querySelector('input[name=wp]')).not.toBeNull();
  });

  it('Find narrows the list, says how many match, and is kept on Next and on the sort links', async () => {
    state.tokens = { rows: tokens(10), total: 12 };
    const el = list(await collectionPage({ method: 'A', tq: '14' }), 'tokens');
    expect(state.calls.tokens[0]![2]).toMatchObject({ find: '14' });
    expect(el.textContent).toContain('12 of 644 tokens match “14”');
    expect(named(el, 'Next ›')).toEqual([`${BASE}/methods?method=A&tq=14&tp=2#evidence`]);
    expect(named(el, 'share')).toEqual([`${BASE}/methods?method=A&ts=share&tq=14#evidence`]);
    expect(named(el, 'Clear')).toEqual([`${BASE}/methods?method=A#evidence`]);
    const form = el.querySelector('form[role=search]')!;
    expect(form.getAttribute('action')).toBe(`${BASE}/methods#evidence`);
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
    expect(named(el, 'All 644 tokens ›')).toEqual([`${BASE}/tokens?method=A&sort=share&q=14`]);
    expect(named(el, 'All 37 wallets ›')).toEqual([`${BASE}/wallets?method=A`]);
    // Only the list with a Find is counted again without it.
    expect(state.calls.counts).toEqual([['tokens', 1, 'A', { sort: 'caught', find: null, limit: 0, offset: 0 }, expect.objectContaining({ ran: ['A', 'AU', 'AC'] })]]);
  });

  it('a list says its own count, not the analysis totals, which also count tokens whose every flagged trade is uncounted', async () => {
    state.tokens = { rows: tokens(10), total: 600 };
    state.wallets = { rows: [wallet(WAL)], total: 33 };
    const el = await collectionPage({ method: 'A' });
    expect(list(el, 'tokens').textContent).toContain('1–10 of 600 tokens');
    expect(named(el, 'All 600 tokens ›')).toHaveLength(1);
    expect(named(el, 'All 33 wallets ›')).toHaveLength(1);
    expect(list(el, 'tokens').textContent).not.toContain('700');
    // With no Find there is nothing more to count.
    expect(state.calls.counts).toHaveLength(0);
    cleanup();
    const flagged = await flaggedPage({ method: 'A', kind: 'tokens' });
    // Said once, by the pager: the heading no longer repeats it.
    expect(flagged.textContent).toContain('1–20 of 600 tokens');
    expect(flagged.textContent).not.toContain('600 in all');
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
    expect(el.textContent).toContain('Money loops back did not run in the latest analysis, so it flags nothing. Choose another lens above.');
    expect(el.querySelector('[aria-label^="Tokens"]')).toBeNull();
    expect(state.calls.tokens).toHaveLength(0);
  });
});

describe('the lens lists on the flagged page', () => {
  it('reads twenty a page with sort, q and page, and its links keep them', async () => {
    state.tokens = { rows: tokens(20), total: 120 };
    const el = await flaggedPage({ method: 'A', kind: 'tokens', sort: 'volume', q: '1', page: '2' });
    expect(state.calls.tokens[0]![2]).toEqual({ sort: 'volume', find: '1', limit: 20, offset: 20 });
    const l = list(el, 'tokens');
    expect(named(l, 'share')).toEqual([`${BASE}/tokens?method=A&sort=share&q=1`]);
    expect(named(l, 'Next ›')).toEqual([`${BASE}/tokens?method=A&sort=volume&q=1&page=3`]);
    expect((l.querySelector('input[name=q]') as HTMLInputElement).value).toBe('1');
    expect(l.textContent).toContain('120 of 644 tokens match “1”');
    // The row numbers go on from the page before.
    expect(l.querySelector('li')?.textContent).toMatch(/^21/);
  });

  it('a wallet list sorts by first seen', async () => {
    const el = await flaggedPage({ method: 'A', kind: 'wallets', sort: 'first' });
    expect(state.calls.wallets[0]![2]).toEqual({ sort: 'first', find: null, limit: 20, offset: 0 });
    expect(list(el, 'wallets').querySelector('[aria-current=true]')?.textContent).toBe('first seen');
  });

  it('a page past the last shows the last page; junk is dropped', async () => {
    state.tokens = { rows: [], total: 120 };
    const el = await flaggedPage({ method: 'A', kind: 'tokens', page: '99999', sort: 'nope' });
    expect(state.calls.tokens.map((c) => (c[2] as { offset: number }).offset)).toEqual([99998 * 20, 100]);
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
    expect(el.textContent).toContain('Linked wallets did not run in the latest analysis, so it flags nothing.');
    expect(state.calls.wallets).toHaveLength(0);
  });

  it('sends an old link into the overview\'s lens panel on to Methods, with its lens and list', async () => {
    const { default: Overview } = await import('@/app/c/[chain]/[address]/page');
    await expect(Overview({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve({ method: 'A', tp: '2', other: 'x' }) }))
      .rejects.toThrow(`redirect:${BASE}/methods?method=A&tp=2`);
  });

  it('sends an old flagged link on to its list, with its lens, order, Find and page', async () => {
    const { default: Old } = await import('@/app/c/[chain]/[address]/flagged/page');
    const old = (sp: Record<string, string>) => Old({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) });
    await expect(old({ method: 'A', kind: 'tokens', sort: 'share', q: '7', page: '2' })).rejects.toThrow(`redirect:${BASE}/tokens?method=A&sort=share&q=7&page=2`);
    await expect(old({ kind: 'wallets' })).rejects.toThrow(`redirect:${BASE}/wallets?method=AC`);
  });

  it('titles its tab "<Page> · <Collection>", with a lens other than the one it opens on between', async () => {
    const title = async ({ kind, ...sp }: Record<string, string>) => {
      const { generateMetadata } = kind === 'wallets' ? await import('@/app/c/[chain]/[address]/wallets/page') : await import('@/app/c/[chain]/[address]/tokens/page');
      return (await generateMetadata({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).title;
    };
    expect(await title({ method: 'A', kind: 'tokens' })).toBe('Tokens · Round trips · Coll');
    expect(await title({ method: 'AC', kind: 'wallets' })).toBe('Wallets · Coll');
    expect(await title({ kind: 'tokens' })).toBe('Tokens · Coll');
    const { generateMetadata: tradesTitle } = await import('@/app/c/[chain]/[address]/trades/page');
    expect((await tradesTitle({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve({}) })).title).toBe('Trades · Coll');
    const { generateMetadata: methodsTitle } = await import('@/app/c/[chain]/[address]/methods/page');
    expect((await methodsTitle({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve({}) })).title).toBe('Methods · Coll');
    // No such collection: each page keeps its own word.
    const missing = { params: Promise.resolve({ chain: '1', address: 'nope' }), searchParams: Promise.resolve({}) };
    expect((await tradesTitle(missing)).title).toBe('Trades');
    const { generateMetadata: tokensTitle } = await import('@/app/c/[chain]/[address]/tokens/page');
    expect((await tokensTitle(missing)).title).toBe('Tokens');
  });

  it('names its lens twice: in the heading, and on its chip in the switch, which gives every lens\'s tier', async () => {
    const el = await flaggedPage({ kind: 'wallets' });
    const head = el.querySelector('header')!;
    expect(head.querySelector('h1')?.textContent).toBe('Wallets flagged by Linked wallets');
    expect(head.textContent).not.toContain('the ceiling');
    const lenses = [...el.querySelectorAll('nav[aria-label=Lens] a')].map((a) => a.textContent);
    expect(lenses).toEqual(['Round trips · the floor', 'Linked wallets · the ceiling', 'Money loops back · not counted']);
    expect(el.querySelector('nav[aria-label=Lens] a[aria-current=page]')?.textContent).toBe('Linked wallets · the ceiling');
    expect((el.textContent ?? '').split('Linked wallets · the ceiling').length - 1).toBe(1);
  });

  it('marks each row with its kind, and spans the page as the tab bar does', async () => {
    const tokensEl = await flaggedPage({ method: 'A', kind: 'tokens' });
    expect(linkTo(tokensEl, `${BASE}/t/7`)?.querySelector('svg')).not.toBeNull();
    expect(list(tokensEl, 'tokens').closest('.max-w-3xl')).toBeNull();
    cleanup();
    const walletsEl = await flaggedPage({ method: 'A', kind: 'wallets' });
    expect(list(walletsEl, 'wallets').querySelector('li svg')).not.toBeNull();
  });
});

describe('the list of a lens of yours', () => {
  const NONE = { loops: null, pairs: null, wallets: null, partners: null, closedByMoney: null, laps: null, middles: null };

  it('draws its name and the bg-flow dot, links by its key, and says nothing of loops it has none of', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop')];
    state.tokens = { rows: [token('7', NONE)], total: 1 };
    const el = await flaggedPage({ method: 'L7', kind: 'tokens' });
    const section = el.querySelector('section[aria-label="Tokens Blur 3-hop flagged"]')!;
    expect(section.textContent).toContain('Which tokens did Blur 3-hop flag?');
    expect(section.querySelector('.bg-flow')).not.toBeNull();
    expect(named(section, '11')).toEqual([`${BASE}/trades?caught=L7&token=7&all=1`]);
    expect(section.textContent).toContain('11 of 14 trades');
    expect(section.textContent).not.toMatch(/loop|0 /);
    expect(reads(el)).not.toMatch(/\bL7\b/);
    expect(state.calls.tokens[0]![1]).toBe('L7');
  });

  it('opens a token as its page with the lens\'s loops lit, says why in the built-ins\' words, and promises what a built-in does', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop', 'done', { totals: { ...totals('A'), truncated: 0, untimed: 0 } })];
    state.tokens = { rows: [token('7', { loops: 3, wallets: 4, closedByMoney: 2, middles: 1, laps: 3, pairs: 0 })], total: 1 };
    // The full list's links also say which list they came from, for stepping (lib/step.ts).
    for (const [page, from] of [[() => collectionPage({ method: 'L7' }), ''], [() => flaggedPage({ method: 'L7', kind: 'tokens' }), '&from=tokens%3Fmethod%3DL7']] as const) {
      const el = await page();
      const page7 = `${BASE}/t/7?method=L7${from}#why`;
      const section = el.querySelector('section[aria-label="Tokens Blur 3-hop flagged"]')!;
      expect(named(section, '#7')).toEqual([page7]);
      expect(named(section, '3 loops')).toEqual([page7]);
      expect(section.textContent).toContain('3 loops among 4 wallets, 2 closed by money, 1 through a middle wallet');
      expect(reads(el)).not.toMatch(/\bL7\b/);
      cleanup();
    }
    const sentence = 'Open a token to see why each trade was flagged.';
    expect((await flaggedPage({ method: 'L7', kind: 'tokens' })).textContent).toContain(sentence);
    cleanup();
    expect((await flaggedPage({ method: 'A', kind: 'tokens' })).textContent).toContain(sentence);
  });

  it('its wallets list links by key and has no loop line', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop')];
    state.wallets = { rows: [wallet(WAL, NONE)], total: 1 };
    const el = await flaggedPage({ method: 'L7', kind: 'wallets' });
    expect(named(el, '5')).toEqual([`${BASE}/trades?caught=L7&wallet=${WAL}&all=1`]);
    expect(el.querySelector('section[aria-label="Wallets Blur 3-hop flagged"]')?.textContent).not.toMatch(/loop/);
  });

  it('reads your lens\'s lists through the block its run read, on the collection page and the flagged page', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop', 'done', { throughBlock: 8, totals: { ...totals('A'), truncated: 0, untimed: 0 } })];
    await collectionPage({ method: 'L7' });
    expect(state.calls.tokens[0]![3]).toMatchObject({ through: { L7: 8 } });
    expect(state.calls.wallets[0]![3]).toMatchObject({ through: { L7: 8 } });
    cleanup();
    state.calls.tokens.length = 0;
    await flaggedPage({ method: 'L7', kind: 'tokens' });
    expect(state.calls.tokens[0]![3]).toMatchObject({ through: { L7: 8 } });
  });

  it('says above the flagged list when your lens is behind, and why, and says nothing when it is not', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop', 'done', { analysisId: 0 })];
    expect((await flaggedPage({ method: 'L7', kind: 'wallets' })).textContent)
      .toContain('Blur 3-hop shows figures from the run before the latest analysis, so trades after it are not judged by it yet.');
    cleanup();
    state.runs = [ownRun(7, 'Blur 3-hop')];
    expect((await flaggedPage({ method: 'L7', kind: 'wallets' })).textContent).not.toContain('shows figures from');
    cleanup();
    // Only the lens in view: a built-in's list says nothing of yours.
    state.runs = [ownRun(7, 'Blur 3-hop', 'done', { analysisId: 0 })];
    expect((await flaggedPage({ method: 'A', kind: 'tokens' })).textContent).not.toContain('shows figures from');
  });

  it('a lens of yours that has not run says so by name and reads no list', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop', 'queued')];
    const el = await flaggedPage({ method: 'L7', kind: 'tokens' });
    expect(el.textContent).toContain('Blur 3-hop has not run on this collection, so it flags nothing yet.');
    expect(state.calls.tokens).toEqual([]);
  });
});
