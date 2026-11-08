import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';
import { Compare } from '@/components/compare';
import { leftOut } from '@/lib/metrics';

const ADDR = '0x' + 'b'.repeat(40);
const BASE = `/c/1/${ADDR}`;
const own = { L7: { name: 'Blur 3-hop', tone: 'own' as const, says: 'x' } };

/**
 * Round trips, Linked wallets and Blur 3-hop ran. Round trips caught 40, Linked wallets 100, Blur 3-hop 30.
 * Blur 3-hop's run is behind: of Round trips' 40, 25 are Blur 3-hop's and 5 are judged clean by it, so
 * "Round trips not Blur 3-hop" is 5 where diag - cell would say 15.
 */
const both = {
  A: { A: 40, AC: 40, L7: 25 }, AC: { A: 40, AC: 100, L7: 28 }, L7: { A: 25, AC: 28, L7: 30 },
};
const not = {
  A: { A: 0, AC: 0, L7: 5 }, AC: { A: 60, AC: 0, L7: 50 }, L7: { A: 5, AC: 2, L7: 0 },
};
const props = { base: BASE, both, not, keys: ['A', 'AC', 'L7'] as const, own, left: [] as { key: 'AU'; why: string }[] };

afterEach(cleanup);
const cell = (c: Element, r: string, col: string) => c.querySelector(`[data-cell="${r}.${col}"]`)!;
const reads = (c: Element) => [c.textContent, ...[...c.querySelectorAll('[aria-label],[title]')].flatMap((e) => [e.getAttribute('aria-label'), e.getAttribute('title')])].join('\n');

describe('Compare', () => {
  it('links every cell per P10: number to caught=r,c, "N not" to caught=r&not=c, diagonal to caught=r', () => {
    const { container: c } = render(<Compare {...props} />);
    const num = cell(c, 'A', 'L7').querySelectorAll('a');
    expect(num[0]!.textContent).toBe('25');
    expect(num[0]!.getAttribute('href')).toBe(`${BASE}/flagged?kind=trades&caught=A,L7`);
    expect(num[1]!.textContent).toBe('5 not');
    expect(num[1]!.getAttribute('href')).toBe(`${BASE}/flagged?kind=trades&caught=A&not=L7`);
    const diag = cell(c, 'AC', 'AC').querySelectorAll('a');
    expect(diag).toHaveLength(1);
    expect(diag[0]!.textContent).toBe('100');
    expect(diag[0]!.getAttribute('href')).toBe(`${BASE}/flagged?kind=trades&caught=AC`);
  });

  it('shows not[r][c] for a lens whose run is behind, never the diagonal minus the cell', () => {
    const { container: c } = render(<Compare {...props} />);
    expect(cell(c, 'A', 'L7').textContent).toContain('5 not');
    expect(cell(c, 'A', 'L7').textContent).not.toContain('15 not');
  });

  it('shades a cell by its share of the row, in words in its title', () => {
    const { container: c } = render(<Compare {...props} />);
    expect(cell(c, 'A', 'L7').className).toContain('bg-flow/');
    expect(cell(c, 'A', 'L7').getAttribute('title')).toBe('Of the 40 sales Round trips caught, Blur 3-hop also caught 25 (63%).');
  });

  it('names a lens that did not run and says why, with no row of zeros', () => {
    const { container: c } = render(<Compare {...props} left={[{ key: 'AU', why: 'it needs a funding source' }]} />);
    expect(c.textContent).toContain('Money loops back');
    expect(c.textContent).toContain('it needs a funding source');
    expect(c.querySelector('[data-cell^="AU."]')).toBeNull();
  });

  it('says there is nothing to compare yet with one lens ran', () => {
    const { container: c } = render(<Compare {...props} keys={['A']} both={{ A: { A: 40 } }} not={{ A: { A: 0 } }} />);
    expect(c.textContent).toContain('nothing to compare yet');
    expect(c.querySelector('table')).toBeNull();
  });

  it('uses lens names only', () => {
    const { container: c } = render(<Compare {...props} left={[{ key: 'AU', why: 'it needs a funding source' }]} />);
    expect(reads(c)).not.toMatch(/\b(AU|AC|L7)\b/);
    expect(reads(c)).not.toMatch(/(^|[^A-Za-z])A([^A-Za-z]|$)/);
    expect(reads(c)).toContain('Linked wallets');
  });
});

// ---- the page ---------------------------------------------------------------

const totals = (flaggedSales: number, available = true) => ({
  transfers: 5000, flagged: 400, sales: 1000, flaggedSales, volumeWei: '0', flaggedVolumeWei: '0', wallets: 1, tokens: 1, available, truncated: 0, untimed: 0,
});
const lens = (id: number, name: string) => ({ id, key: `L${id}`, name, rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 });
const push = vi.fn();
const state = { runs: [] as unknown[], compare: vi.fn() };

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => ({
      id: 1, chainId: 1, address: ADDR, name: 'Coll', startBlock: 1, cursorBlock: 10, headBlock: 10, transfers: 5000, wallets: 37, fundedWallets: 0,
      error: null, stale: false, pausedAt: null, priority: false, trailProgress: null, analysisError: null, storedThroughTime: null, storedThroughBlock: null,
      downloadFile: null, downloadProgress: null, downloadNote: null, restoreProgress: null, restoreNote: null, trailNote: null, trailImportedSha: null,
      rules: {}, contract: null, addedAt: 0, ingestedAt: 0, servedAt: 0, readRate: null,
      latest: { id: 1, ranAt: 1, tookMs: 5, throughBlock: 10, missingData: 0, fundedWallets: 0, wallets: 37, truncatedSearches: 0, loops: null,
        totals: { A: totals(40), AU: totals(0, false), AC: totals(0, false) } },
    }),
    lensRuns: async () => state.runs,
    compare: (...a: unknown[]) => state.compare(...a),
    history: async () => [],
    timeline: async () => ({ bucket: 'day', untimed: 0, readThrough: null, points: [] }),
    profile: async () => ({ supply: 1, holders: 1, firstMint: null, firstSale: null, lastSale: null, marketplaces: [] }),
    passes: async () => [], collections: async () => [], sources: async () => ({}), settings: async () => new Map(),
    importedFunding: async () => false,
    lensTokens: async () => ({ rows: [], total: 0 }), lensWallets: async () => ({ rows: [], total: 0 }),
  }),
  storedEntry: async () => null,
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers({ host: 'localhost:3000' }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, useRouter: () => ({ push, refresh: vi.fn() }) }));

async function draw(sp: Record<string, string>): Promise<HTMLElement> {
  const { default: Page } = await import('@/app/c/[chain]/[address]/page');
  return render(await Page({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
const done = { lensId: 7, collectionId: 1, status: 'done', progress: null, lensVersion: 1, analysisId: 1, throughBlock: 5, totals: totals(30), error: null, retryAt: null, finishedAt: 1, tookMs: 1 };
const GRID = { both: { A: { A: 40, L7: 25 }, L7: { A: 25, L7: 30 } }, not: { A: { A: 0, L7: 5 }, L7: { A: 5, L7: 0 } } };

describe('the Compare tab on the collection page', () => {
  it('is the last tab, selected at ?method=compare, and the lens tabs are not', async () => {
    state.runs = [{ lens: lens(7, 'Blur 3-hop'), run: done }];
    state.compare.mockResolvedValue(GRID);
    const c = await draw({ method: 'compare' });
    const nav = c.querySelector('nav[aria-label="Lens"]')!;
    const on = [...nav.querySelectorAll('[aria-current="page"]')];
    expect(on.map((a) => a.textContent)).toEqual(['Compare']);
    expect(on[0]!.getAttribute('href')).toBe(`${BASE}?method=compare`);
    expect([...nav.children].at(-1)!.textContent).toBe('Compare');
  });

  it('shows not[r][c] from the store, and names the money lenses that did not run', async () => {
    state.runs = [{ lens: lens(7, 'Blur 3-hop'), run: done }];
    state.compare.mockResolvedValue(GRID);
    const c = await draw({ method: 'compare' });
    expect(cell(c, 'A', 'L7').textContent).toContain('5 not');
    const p = c.querySelector('[data-lens-panel]')!.textContent!;
    expect(p).toContain('Money loops back');
    expect(p).toContain('Linked wallets');
    expect(state.compare).toHaveBeenCalledWith(1, expect.objectContaining({ ran: ['A', 'L7'] }));
  });

  it('names a lens of yours with no run, with why', async () => {
    state.runs = [{ lens: lens(7, 'Blur 3-hop'), run: null }];
    state.compare.mockResolvedValue({ both: { A: { A: 40 } }, not: { A: { A: 0 } } });
    const c = await draw({ method: 'compare' });
    const p = c.querySelector('[data-lens-panel]')!.textContent!;
    expect(p).toContain('Blur 3-hop has not run on this collection');
    expect(p).toContain('nothing to compare yet');
  });

  it('heads the left-out list in words true of a first run in progress or failed, not only one that never ran', async () => {
    state.runs = [{ lens: lens(7, 'Blur 3-hop'), run: { ...done, status: 'running', progress: 0.4, totals: null } },
      { lens: lens(8, 'Broke'), run: { ...done, status: 'failed', totals: null, error: 'x' } }];
    state.compare.mockResolvedValue({ both: { A: { A: 40 } }, not: { A: { A: 0 } } });
    const p = (await draw({ method: 'compare' })).querySelector('[data-lens-panel]')!.textContent!;
    expect(p).toContain('Left out, because they have no figures here to compare:');
    expect(p).not.toContain('because they did not run');
    expect(p).toContain('Blur 3-hop has no figures yet: its first run has not finished.');
    expect(p).toContain('Broke has no figures: its last run failed.');
  });
});

describe('Compare, fix round 1', () => {
  it('says what "N not" opens, by lens names', () => {
    const { container: c } = render(<Compare {...props} />);
    const a = cell(c, 'A', 'L7').querySelectorAll('a')[1]!;
    expect(a.getAttribute('title')).toBe('Sales Round trips caught that Blur 3-hop judged and did not flag');
  });

  it('with no lens ran, says so', () => {
    const { container: c } = render(<Compare {...props} keys={[]} both={{}} not={{}} />);
    expect(c.textContent).toContain('No lens has run on this collection, so there is nothing to compare yet.');
  });

  it('Cancel from Compare goes back to Compare', async () => {
    state.runs = [];
    state.compare.mockResolvedValue({ both: {}, not: {} });
    const c = await draw({ method: 'compare', lens: 'new' });
    fireEvent.click([...c.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!);
    expect(push).toHaveBeenCalledWith(`${BASE}?method=compare`);
  });
});

describe('leftOut', () => {
  const latest = { totals: { A: totals(40), AU: totals(0, false), AC: totals(0, false) } };
  const why = (funding: Partial<{ trail: boolean; funded: boolean; coming: boolean; silent: boolean }>) =>
    leftOut(latest as never, [], ['A'], { trail: false, funded: false, coming: false, silent: false, ...funding }).map((l) => `${l.key}: ${l.why}`);
  it('says the next analysis runs a money lens when funding is set', () => {
    expect(why({ funded: true })).toEqual([
      'AU: has not run yet: funding is set, and the next analysis runs it.',
      'AC: has not run yet: funding is set, and the next analysis runs it.',
    ]);
  });
  it('says a stored trail is on its way', () => {
    expect(why({ coming: true })[0]).toBe('AU: has not run yet: a stored money trail is on its way, and the first analysis after it loads runs it.');
  });
  it('adds "once the worker reports again" when the worker is silent, as the tab does', () => {
    expect(why({ coming: true, silent: true })[0]).toBe('AU: has not run yet: a stored money trail is on its way, and the first analysis after it loads runs it, once the worker reports again.');
  });
  it('says it needs funding only when there is none', () => {
    expect(why({})[0]).toBe('AU: did not run: it needs to know who paid whom, and a key: add an Etherscan key in Settings.');
  });
  it('names the trail that checked no wallet, in the tab\'s words', () => {
    expect(why({ trail: true })[0]).toBe('AU: did not run: the stored money trail checked no wallet, and it needs a key: add an Etherscan key in Settings.');
  });
});
