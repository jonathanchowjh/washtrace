import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tradesHref } from '@/lib/trades-url';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;

// Round trips flags 41 of 1,000 sales, Money loops back 300, Linked wallets 120.
const FLAGGED = { A: 41, AU: 300, AC: 120 } as const;
const state = { moneyRan: true, loops: true, lensRuns: [] as unknown[], history: [] as unknown[], rings: 0, missing: false };
const totals = (m: 'A' | 'AU' | 'AC') => ({
  transfers: 5000, flagged: 400, sales: 1000, flaggedSales: FLAGGED[m], volumeWei: String(19_032n * 10n ** 18n),
  flaggedVolumeWei: String(BigInt(FLAGGED[m]) * 20n * 10n ** 18n), wallets: 1207, tokens: 644, available: m === 'A' || state.moneyRan,
});

const collection = () => ({
  id: 1, chainId: 1, address: ADDR, name: 'Coll', startBlock: 1, cursorBlock: 10, headBlock: 10, transfers: 5000, wallets: 37, fundedWallets: 37,
  error: null, stale: false, pausedAt: null, priority: false, trailProgress: null, analysisError: null, storedThroughTime: null, storedThroughBlock: null,
  downloadFile: null, downloadProgress: null, downloadNote: null, restoreProgress: null, restoreNote: null, trailNote: null, trailImportedSha: null,
  rules: {}, contract: null, addedAt: 0, ingestedAt: 0, servedAt: 0, readRate: null,
  latest: {
    ranAt: 1_700_000_000_000, tookMs: 5, throughBlock: 10, missingData: 0, fundedWallets: 37, wallets: 37, truncatedSearches: 0, rings: state.rings,
    // A lens that did not run carries Round trips' copy, as the engine writes it.
    loops: state.loops ? { A: { loops: 388, pairs: 0 }, AU: { loops: 388, pairs: 0 }, AC: { loops: 120, pairs: 300 } } : null,
    totals: { A: totals('A'), AU: totals('AU'), AC: totals('AC') },
  },
});

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => (state.missing ? null : collection()),
    lensRuns: async () => state.lensRuns ?? [],
    history: async () => state.history,
    timeline: async () => ({ bucket: 'day', untimed: 0, readThrough: null, points: [] }),
    profile: async () => ({
      supply: 644, holders: 300, firstMint: null, firstSale: 1_600_000_000_000, lastSale: 1_680_000_000_000,
      marketplaces: [{ name: 'seaport-1.5', sales: 600 }, { name: 'blur', sales: 300 }, { name: 'seaport-1.4', sales: 50 }],
    }),
    passes: async () => [],
    collections: async () => [],
    sources: async () => ({}),
    settings: async () => new Map(),
    importedMoney: async () => false,
    lensTokens: async () => ({ rows: [], total: 0 }),
    lensWallets: async () => ({ rows: [], total: 0 }),
    rings: async () => ({ rows: [{ anchor: ADDR, rank: 1, wallets: 2, sample: [], sales: 3, floorSales: 1, tokens: 1, volumeWei: '0', firstAt: null, lastAt: null, tokenSample: ['5'] }], total: state.rings }),
  }),
  storedEntry: async () => null,
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => { cleanup(); state.moneyRan = true; state.loops = true; state.history = []; state.rings = 0; });

async function draw(sp: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: Page } = await import('@/app/c/[chain]/[address]/page');
  return render(await Page({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
/** The Methods page, where the lens panel is. */
async function methods(sp: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: Page } = await import('@/app/c/[chain]/[address]/methods/page');
  return render(await Page({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
const named = (c: Element, text: string) => [...c.querySelectorAll('a')].filter((a) => a.textContent === text).map((a) => a.getAttribute('href'));
const answer = (c: Element) => c.querySelector('[aria-label="The answer"]')!;

describe('the answer on the collection page', () => {
  it('opens each end of the sales range, and N, M and S of its detail', async () => {
    const a = answer(await draw());
    const low = tradesHref(BASE, { caught: ['A'] }), high = tradesHref(BASE, { caught: ['AC'] });
    expect(named(a, '4.1')).toEqual([low]);
    expect(named(a, '12%')).toEqual([high]);
    expect(named(a, '41')).toEqual([low]);
    expect(named(a, '120')).toEqual([high]);
    expect(named(a, '1,000')).toEqual([tradesHref(BASE, {})]);
    expect(a.textContent).toContain('41–120 of 1,000 sales');
  });

  it('opens each end of the volume range sorted by price, biggest first', async () => {
    const hrefs = [...answer(await draw()).querySelectorAll('a')].map((x) => x.getAttribute('href'));
    expect(hrefs).toContain(tradesHref(BASE, { caught: ['A'], sort: 'price', dir: 'desc' }));
    expect(hrefs).toContain(tradesHref(BASE, { caught: ['AC'], sort: 'price', dir: 'desc' }));
  });

  it('offers the whole sales list under the headline', async () => {
    const dig = [...answer(await draw()).querySelectorAll('a')].find((x) => x.textContent === 'All 1,000 sales ›');
    expect(dig?.getAttribute('href')).toBe(tradesHref(BASE, {}));
  });
});

describe('the lens panel on the collection page', () => {
  it('puts the stat line at the top of the panel, outside every card', async () => {
    const stats = (await methods({ method: 'AC' })).querySelector('[aria-label="Linked wallets in numbers"]')!;
    expect(stats).not.toBeNull();
    expect(stats.closest('nav')).toBeNull();
    expect(named(stats, '120 loops and 300 linked pairs')).toEqual([`${BASE}/tokens?method=AC`]);
    expect(named(stats, '644 tokens')).toEqual([`${BASE}/tokens?method=AC`]);
  });

  it('leaves the loops out of the stat line for an analysis that did not count them', async () => {
    state.loops = false;
    const stats = (await methods({ method: 'AC' })).querySelector('[aria-label="Linked wallets in numbers"]')!;
    expect(stats.textContent).not.toContain('loop');
    expect(stats.textContent).toContain('644 tokens');
  });

  it('says Money loops back is not counted in its stat line, and gives a lens that did not run none', async () => {
    expect((await methods({ method: 'AU' })).querySelector('[aria-label="Money loops back in numbers"]')!.textContent).toContain('(not counted)');
    cleanup();
    state.moneyRan = false;
    const c = await methods({ method: 'AU' });
    expect(c.querySelector('[aria-label="Money loops back in numbers"]')).toBeNull();
    expect(c.textContent).toContain('Money loops back did not run in the latest analysis, so it flags nothing.');
  });

  it('a built-in that ran in an earlier analysis but not the latest says it did not run in the latest analysis, never that it has not run here', async () => {
    // The owner analysed with a key, then cleared it: the earlier analysis ran Money loops back, the latest did not.
    const earlier = { ...collection().latest, id: 1, ranAt: 1_690_000_000_000 };
    state.moneyRan = false;
    state.history = [{ ...collection().latest, id: 2 }, earlier];
    const c = await methods({ method: 'AU' });
    expect(c.textContent).toContain('How the answer settled as the reading filled in, at each of 2 analyses');
    expect(c.textContent).toContain('Money loops back did not run in the latest analysis, so it flags nothing. Choose another lens above.');
    expect(c.textContent).not.toContain('has not run on this collection');
  });
});

describe('its facts line', () => {
  it('opens each marketplace on its sales, and the sales count on all of them, newest first, as every other count of them does', async () => {
    const about = (await draw()).querySelector('[aria-label="The collection"]')!;
    expect(named(about, '650')).toEqual([tradesHref(BASE, { venues: ['opensea'] })]);
    expect(named(about, '300')).toEqual([tradesHref(BASE, { venues: ['blur'] })]);
    const hrefs = [...about.querySelectorAll('a')].map((x) => x.getAttribute('href'));
    expect(hrefs).toContain(tradesHref(BASE, {}));
  });
});

describe('links never sit inside links', () => {
  it('no link is nested in another, whichever method is chosen', async () => {
    expect((await draw()).querySelectorAll('a a').length).toBe(0);
    cleanup();
    for (const method of ['A', 'AU', 'AC']) {
      const c = await methods({ method });
      expect(c.querySelectorAll('a a').length).toBe(0);
      cleanup();
    }
  });
});

describe('the overview on a phone', () => {
  it('stacks Who did it over its caption, and gives the live stamp room under the address', async () => {
    state.rings = 1;
    const c = await draw();
    const h = c.querySelector('section[aria-label="Who did it"] h2')!;
    expect(h.className).toMatch(/(^| )flex-col( |$)/);
    expect(h.className).toContain('sm:flex-row');
    const live = [...c.querySelectorAll('header span')].find((x) => x.textContent?.startsWith('live · every'))!;
    expect(live.parentElement!.className).toMatch(/(^| )pt-2( |$)/);
  });
});

describe('the tab title', () => {
  it('names the collection, and says Not watched for one nobody watches', async () => {
    const { generateMetadata } = await import('@/app/c/[chain]/[address]/page');
    const title = async () => (await generateMetadata({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve({}) })).title;
    expect(await title()).toBe('Coll');
    state.missing = true;
    try { expect(await title()).toBe('Not watched'); } finally { state.missing = false; }
  });
});
