/**
 * The click map: a number opens the list it counts, a name its page, a chip
 * its lens's tab, a date its trade, a link out ends in ↗.
 *
 * The sweep below guards only figures that carry the `tabular-nums` class (the
 * console's class for a figure). A new figure that is a count should carry it,
 * so the sweep sees it and it has to be a link.
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlaggedTransfer } from '@washtrace/detect';
import { tradesHref } from '@/lib/trades-url';

const ADDR = '0x' + 'b'.repeat(40);
const SELF = '0x' + 'a'.repeat(40);
const BASE = `/c/1/${ADDR}`;
const TX = '0x' + 'e'.repeat(64);
const push = vi.hoisted(() => vi.fn());

const totals = (m: 'A' | 'AU' | 'AC') => ({
  transfers: 5000, flagged: 400, sales: 1000, flaggedSales: { A: 41, AU: 300, AC: 120 }[m], volumeWei: String(19_032n * 10n ** 18n),
  flaggedVolumeWei: String(BigInt({ A: 41, AU: 300, AC: 120 }[m]) * 20n * 10n ** 18n), wallets: 1207, tokens: 644, available: true,
});
const latest = (ranAt: number) => ({
  ranAt, tookMs: 5, throughBlock: 10, missingData: 0, fundedWallets: 37, wallets: 37, truncatedSearches: 0,
  loops: { A: { loops: 388, pairs: 0 }, AU: { loops: 388, pairs: 0 }, AC: { loops: 120, pairs: 300 } },
  totals: { A: totals('A'), AU: totals('AU'), AC: totals('AC') },
});
const collection = () => ({
  id: 1, chainId: 1, address: ADDR, name: 'Coll', startBlock: 1, cursorBlock: 10, headBlock: 10, transfers: 5000, wallets: 37, fundedWallets: 37,
  error: null, stale: false, pausedAt: null, priority: false, trailProgress: null, analysisError: null, storedThroughTime: null, storedThroughBlock: null,
  downloadFile: null, downloadProgress: null, downloadNote: null, restoreProgress: null, restoreNote: null, trailNote: null, trailImportedSha: null,
  rules: {}, contract: null, addedAt: 0, ingestedAt: 0, servedAt: 0, readRate: null,
  latest: latest(1_700_000_000_000),
});
/** Flagged by Round trips and Money loops back both: two chips, two tones. */
const trade = (i: number): FlaggedTransfer => ({
  txHash: i === 0 ? TX : '0x' + i, logIndex: 0, blockNumber: 5, blockTime: 1_680_000_000, tokenId: '7', from: '0x1', to: '0x2', marketplace: 'Seaport', priceWei: String(10n ** 18n), currency: '',
  flags: {
    A: { kind: 'scc', wallets: ['0x1', '0x2'], cycles: 2 },
    AU: { kind: 'pair', pair: ['0x1', '0x2'], middle: null, flowTx: '0x' + 'f'.repeat(64) },
  },
  collection: { chainId: 1, address: ADDR, name: 'Coll' },
});
const JAN = Date.UTC(2023, 0, 1);

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => collection(),
    lensRuns: async () => [],
    collections: async () => [collection()],
    history: async () => [latest(1_690_000_000_000), latest(1_700_000_000_000)].map((a) => ({ ...a, id: 1 })),
    timeline: async () => ({
      bucket: 'month', untimed: 0, readThrough: null,
      points: [JAN, Date.UTC(2023, 1, 1)].map((at) => ({ at, transfers: 90, sales: 80, flaggedSales: { A: 4, AU: 20, AC: 9 } })),
    }),
    profile: async () => ({ supply: 644, holders: 300, firstMint: null, firstSale: 1_600_000_000_000, lastSale: 1_680_000_000_000, marketplaces: [{ name: 'seaport-1.5', sales: 600 }, { name: 'blur', sales: 300 }] }),
    passes: async () => [],
    sources: async () => ({}),
    settings: async () => new Map(),
    importedMoney: async () => false,
    lensTokens: async () => ({ rows: [{ tokenId: '7', trades: 5, caught: 3, volumeWei: String(10n ** 18n), loops: 2 }], total: 1 }),
    lensWallets: async () => ({ rows: [{ address: SELF, trades: 5, caught: 3, volumeWei: String(10n ** 18n), loops: 2 }], total: 1 }),
    token: async () => [trade(1), trade(2)],
    flowsAmong: async () => [],
    lensFlagsOfToken: async () => [],
    lensFlagsOfTx: async () => [],
    transaction: async () => [trade(0)],
    wallet: async () => null,
    counterparties: async () => [{ address: '0x' + '9'.repeat(40), flows: 2, sent: 1, received: 1, watched: false }],
    counterpartyCount: async () => 1,
    walletTransfers: async () => [trade(1), trade(2)],
    walletTradeCount: async () => 2,
    walletCollections: async () => [{ address: ADDR, name: 'Coll', trades: 2 }],
    flowsBetween: async () => [],
    flowsBetweenCount: async () => 0,
    trades: async () => [1, 2].map((i) => ({ ...trade(i), lenses: ['A', 'AU'], judged: true, heldS: 7200, buyerAgeS: 86_400 * 3, floorRatio: 1.25 })),
    tradeCount: async () => ({ total: 2, unjudged: 0 }),
    tradeGroups: async () => [{ key: 'blur', trades: 3, caught: { A: 2, AU: 1, AC: 1 } }, { key: '-', trades: 1, caught: {} }],
  }),
  storedEntry: async () => null,
  storedManifest: async () => null,
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers({ host: 'example.com' }) }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('not found'); },
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => { cleanup(); push.mockClear(); });

type Draw = () => Promise<HTMLElement>;
const PAGES: Record<string, Draw> = {
  collection: async () => {
    const { default: P } = await import('@/app/c/[chain]/[address]/page');
    return render(await P({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve({}) })).container;
  },
  methods: async () => {
    const { default: P } = await import('@/app/c/[chain]/[address]/methods/page');
    return render(await P({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve({ method: 'A' }) })).container;
  },
  home: async () => {
    const { default: P } = await import('@/app/page');
    return render(await P({ searchParams: Promise.resolve({}) })).container;
  },
  token: async () => {
    const { default: P } = await import('@/app/c/[chain]/[address]/t/[tokenId]/page');
    return render(await P({ params: Promise.resolve({ chain: '1', address: ADDR, tokenId: '7' }), searchParams: Promise.resolve({}) })).container;
  },
  trade: async () => {
    const { default: P } = await import('@/app/tx/[chain]/[hash]/page');
    return render(await P({ params: Promise.resolve({ chain: '1', hash: TX }) })).container;
  },
  wallet: async () => {
    const { default: P } = await import('@/app/w/[chain]/[address]/page');
    return render(await P({ params: Promise.resolve({ chain: '1', address: SELF }), searchParams: Promise.resolve({}) })).container;
  },
  'flagged Trades': async () => {
    const { default: P } = await import('@/app/c/[chain]/[address]/trades/page');
    return render(await P({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve({ by: 'marketplace' }) })).container;
  },
  'flagged Tokens': () => flagged({ method: 'A', kind: 'tokens' }),
  'flagged Wallets': () => flagged({ method: 'A', kind: 'wallets' }),
};
async function flagged({ kind, ...sp }: Record<string, string>): Promise<HTMLElement> {
  const { default: P } = kind === 'wallets' ? await import('@/app/c/[chain]/[address]/wallets/page') : await import('@/app/c/[chain]/[address]/tokens/page');
  return render(await P({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
const hrefs = (c: Element) => [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));

describe('lens names and chips', () => {
  it('the token page’s lens name opens that lens’s tab', async () => {
    const c = await PAGES.token!();
    const link = [...c.querySelectorAll('a')].find((a) => a.textContent === 'Round trips' && a.closest('li, [class*="inline-flex"]'));
    expect(link?.getAttribute('href')).toBe(`${BASE}/methods?method=A#evidence`);
  });

  it('a row’s date opens the trade page, and its explorer link is a separate ↗', async () => {
    const c = await PAGES.trade!();
    expect(hrefs(c)).toContain(`/tx/1/${TX}`);
    const out = [...c.querySelectorAll('a[target=_blank]')].filter((a) => a.getAttribute('href')?.includes(`/tx/${TX}`));
    expect(out.length).toBeGreaterThan(0);
  });

  it('on a row both lenses flag, each chip wears its own lens’s colour and opens its tab', async () => {
    const c = await PAGES.trade!();
    const chip = (name: string) => [...c.querySelectorAll('tbody a')].find((a) => a.textContent === name)!;
    // The colour is the chip's tier mark, as on every other page's lens tags.
    expect(chip('Money loops back').querySelector('i')!.className).toContain('border-muted-foreground');
    expect(chip('Round trips').querySelector('i')!.className).toContain('bg-cycle');
    expect(chip('Round trips').getAttribute('href')).toBe(`${BASE}/methods?method=A#evidence`);
    expect(chip('Money loops back').getAttribute('href')).toBe(`${BASE}/methods?method=AU#evidence`);
  });
});

describe('links out', () => {
  it.each(Object.keys(PAGES))('on the %s page every link that leaves the app ends in ↗ and is noopener', async (name) => {
    const c = await PAGES[name]!();
    for (const a of c.querySelectorAll('a[target=_blank]')) {
      expect(a.textContent, a.outerHTML).toMatch(/↗$/);
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });
});

describe('a period opens its trades', () => {
  it('the history table’s first period links to that month’s trades, as instants', async () => {
    const c = await PAGES.methods!();
    const first = [...c.querySelectorAll('details table a')].find((a) => a.textContent === 'Jan 2023');
    expect(first?.getAttribute('href')).toBe(`${BASE}/trades?from=2023-01-01&to=2023-02-01`);
    expect(first?.getAttribute('href')).toBe(tradesHref(BASE, { fromMs: JAN, toMs: Date.UTC(2023, 1, 1) }));
  });

  it('the last period ends where one more period would start', async () => {
    const c = await PAGES.methods!();
    expect(hrefs(c)).toContain(`${BASE}/trades?from=2023-02-01&to=2023-03-01`);
  });

  it('a click near the right edge pushes the last period’s link, near the left the first', async () => {
    // jsdom has no layout: give the chart a width, so the pointer's place picks the period.
    const box = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    const c = await PAGES.methods!();
    const overlay = c.querySelector('svg rect[fill=transparent]')!;
    fireEvent.click(overlay, { clientX: 199 });
    expect(push).toHaveBeenLastCalledWith(`${BASE}/trades?from=2023-02-01&to=2023-03-01`);
    fireEvent.click(overlay, { clientX: 1 });
    expect(push).toHaveBeenLastCalledWith(`${BASE}/trades?from=2023-01-01&to=2023-02-01`);
    box.mockRestore();
  });

  it('a lens’s share in a period opens what that lens caught in it', async () => {
    const c = await PAGES.methods!();
    const row = [...c.querySelectorAll('details table tbody tr')].find((tr) => tr.textContent?.startsWith('Jan 2023'))!;
    const to = [...row.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    for (const m of ['A', 'AU', 'AC'] as const) expect(to).toContain(tradesHref(BASE, { fromMs: JAN, toMs: Date.UTC(2023, 1, 1), caught: [m] }));
  });

  it('Enter on the focused chart opens the current period', async () => {
    const c = await PAGES.methods!();
    const chart = c.querySelector('[role=group][tabindex="0"]')!;
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith(`${BASE}/trades?from=2023-02-01&to=2023-03-01`);
  });
});

describe('the volume headline', () => {
  it('opens each end caught by that lens and the total, biggest sale first', async () => {
    const c = await PAGES.collection!();
    const a = c.querySelector('[aria-label="The answer"]')!;
    const priciest = { sort: 'price', dir: 'desc' } as const;
    const all = hrefs(a);
    expect(all).toContain(tradesHref(BASE, { caught: ['A'], ...priciest }));
    expect(all).toContain(tradesHref(BASE, { caught: ['AC'], ...priciest }));
    expect(all).toContain(tradesHref(BASE, priciest));
    expect(a.textContent).toContain('820–2,400 ETH of 19,032 ETH');
  });
});

// A figure counts a list, so it opens that list. What counts no list is here, each with why.
const ALLOWED: { why: string; test: (el: Element) => boolean }[] = [
  { why: 'an analysis’s share of sales as it was then: the sales it counted are the ones of that run, and no list holds them now', test: (el) => el.closest('[data-snapshot]') !== null },
  { why: 'an analysis’s time, written out as text in the analyses table', test: (el) => el.closest('[data-time]') !== null },
  { why: 'a time, which is a <Time>', test: (el) => { const t = el.querySelector('time'); return t !== null && el.textContent === t.textContent; } },
  { why: 'a chart axis or tick label: a scale mark, in an aria-hidden drawing', test: (el) => el.closest('svg') !== null },
  { why: 'a row number: a place in the list, not a count of anything', test: (el) => el.hasAttribute('data-row-number') },
  { why: 'a collection’s supply and its holders: no page lists every token or every holder', test: (el) => el.closest('[data-supply]') !== null },
  { why: 'the range a table page shows, as a pager says it: the list is already open', test: (el) => /^Showing /.test(el.textContent ?? '') },
  { why: 'the pipeline’s progress figures: how far a stage has read, not a list', test: (el) => el.closest('[data-progress]') !== null },
  { why: 'a Group by row no filter can hold, such as the unknown group: its trades are in the list below, but no list holds only them', test: (el) => el.closest('tr[data-unlisted]') !== null },
  { why: "a trade's own measure, in its row or its card: it counts no list, and the trade's date opens the trade", test: (el) => el.closest('[data-measure]') !== null },
  { why: 'a pager label: the range of the list already open', test: (el) => el.closest('nav[aria-label="Pages"]') !== null || /^[\d,]+ (trades|transfers|results|tokens|wallets)$/.test(el.textContent ?? '') && el.tagName === 'P' },
];

/** Every figure outside a link, a time or an allowed place: the text itself, not its wrapper, so one loose digit among links still counts. */
function loose(c: Element): string[] {
  const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
  const out = new Set<string>();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const host = n.parentElement!.closest('.tabular-nums');
    if (host === null || !/\d/.test(n.textContent ?? '') || n.parentElement!.closest('a') !== null) continue;
    if (!ALLOWED.some((a) => a.test(host) || a.test(n.parentElement!))) out.add(host.outerHTML.slice(0, 200));
  }
  return [...out];
}

describe('the home page’s volume', () => {
  it('opens each end caught by that lens and the total, biggest sale first, with no link inside a link', async () => {
    const c = await PAGES.home!();
    const priciest = { sort: 'price', dir: 'desc' } as const;
    const all = hrefs(c);
    expect(all).toContain(tradesHref(BASE, { caught: ['A'], ...priciest }));
    expect(all).toContain(tradesHref(BASE, { caught: ['AC'], ...priciest }));
    expect(all).toContain(tradesHref(BASE, priciest));
    expect(c.textContent).toContain('820–2,400 ETH of 19,032 ETH');
    expect(c.querySelectorAll('a a').length).toBe(0);
  });
});

describe('the token page’s flagged count', () => {
  const flagged = (c: Element) => [...c.querySelectorAll('p.tabular-nums')].find((p) => p.textContent?.startsWith('Showing'))!;

  it('is a link to the Flagged view when every transfer is shown', async () => {
    const link = flagged(await PAGES.token!()).querySelector('a');
    expect(link?.textContent).toBe('2 flagged');
    expect(link?.getAttribute('href')).toContain('show=flagged');
  });

  it.each(['sales', 'flagged'])('is plain text under the %s view', async (show) => {
    const { default: P } = await import('@/app/c/[chain]/[address]/t/[tokenId]/page');
    const c = render(await P({ params: Promise.resolve({ chain: '1', address: ADDR, tokenId: '7' }), searchParams: Promise.resolve({ show }) })).container;
    expect(flagged(c).textContent).toContain('2 flagged');
    expect(flagged(c).querySelector('a')).toBeNull();
  });
});

describe('the click map', () => {
  it.each(Object.keys(PAGES))('on the %s page every figure is a link, or is allowed and says why', async (name) => {
    expect(loose(await PAGES[name]!())).toEqual([]);
  });

  it('fails on a plain figure, in a chart table as anywhere', async () => {
    const c = await PAGES.methods!();
    const cell = c.querySelector('details table td.text-right a')!;
    cell.replaceWith(document.createTextNode('7.5%'));
    expect(loose(c).length).toBeGreaterThan(0);
  });

  it.each(Object.keys(PAGES))('on the %s page no link holds a link', async (name) => {
    expect((await PAGES[name]!()).querySelectorAll('a a').length).toBe(0);
  });
});
