import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'b'.repeat(40);
const ran = (m: string) => ({ available: m === 'A' || state.moneyRan });
// `each`, when set, gives each transfer its own flags in place of `flagged`.
const state = { moneyRan: true, throughBlock: 10 as number | null, blocks: [5], flagged: [] as string[], each: null as string[][] | null, latestNull: false, sales: [] as number[] };

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => ({ id: 1, chainId: 1, address: ADDR, name: 'Coll', latest: state.latestNull ? null : { throughBlock: state.throughBlock, totals: Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, ran(m)])) } }),
    token: async () => state.blocks.map((b, i) => ({
      txHash: '0x' + i, logIndex: 0, blockNumber: b, blockTime: null, tokenId: '7', from: '0x1', to: '0x2', marketplace: state.sales.includes(i) ? 'Seaport' : null, priceWei: null, currency: null,
      flags: Object.fromEntries((state.each?.[i] ?? state.flagged).map((m) => [m, { kind: 'scc', wallets: ['0x1', '0x2'], cycles: 2 }])),
    })),
    flowsAmong: async () => [],
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => { cleanup(); Object.assign(state, { moneyRan: true, throughBlock: 10, blocks: [5], flagged: [], each: null, latestNull: false, sales: [] }); });

async function dom(sp: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: TokenPage } = await import('@/app/c/[chain]/[address]/t/[tokenId]/page');
  return render(await TokenPage({ params: Promise.resolve({ chain: '1', address: ADDR, tokenId: '7' }), searchParams: Promise.resolve(sp) })).container;
}
async function page(): Promise<string> { return (await dom()).textContent ?? ''; }

describe('the token page when not everything is judged', () => {
  it('a token with newer transfers and an older Money loops back flag says no analysis covered them, and that the flag is not counted', async () => {
    Object.assign(state, { blocks: [5, 20], flagged: ['AU'] });
    const text = await page();
    expect(text).toContain('Not judged yet');
    expect(text).toContain('no analysis has covered them yet. That is not the same as clean.');
    expect(text).toContain('2 of 2 transfers are flagged only by Money loops back, which is not counted.');
    expect(text).not.toContain('count toward');
    expect(text).not.toContain('What this means');
  });

  it('a token with a Round trips transfer and a transfer flagged only by Money loops back counts the one, and says the other is not counted', async () => {
    Object.assign(state, { blocks: [5, 6], each: [['A'], ['AU']] });
    const text = await page();
    expect(text).toContain('1 of 2 transfers flagged, by Round trips. They count toward');
    expect(text).not.toContain('by Round trips and Money loops back');
    expect(text).toContain('1 more is flagged only by Money loops back, which is not counted.');
  });

  it('names a money swatch in the legend only when a money arrow is drawn', async () => {
    Object.assign(state, { flagged: ['A'] });
    const legend = [...(await dom()).querySelectorAll('figcaption > span')].map((s) => s.textContent);
    expect(legend).toContain('Round trips');
    expect(legend).toContain('first holder');
    expect(legend).not.toContain('money');
  });

  it('a token with no analysis does not say no pattern was found', async () => {
    Object.assign(state, { latestNull: true });
    const text = await page();
    expect(text).toContain('Its transfers are read, but no analysis has covered them yet. That is not the same as clean.');
    expect(text).not.toContain('No lens found a pattern');
  });

  it('a judged token flagged only by Money loops back says it is not counted', async () => {
    Object.assign(state, { flagged: ['AU'] });
    const text = await page();
    expect(text).toContain('Flagged only by Money loops back, which is not counted');
    expect(text).not.toContain('count toward');
  });

  it('a judged token flagged only by Money loops back is grey throughout, and says why it is not counted', async () => {
    Object.assign(state, { flagged: ['AU'] });
    const { APART_WHY, TINT_LEAD } = await import('@/lib/metrics');
    const c = await dom();
    const text = c.textContent ?? '';
    expect(c.querySelector('p.text-lg')?.textContent).toBe('Flagged only by Money loops back, which is not counted');
    expect(c.querySelector('.bg-money, .bg-money-surface\\/70, .text-money')?.outerHTML).toBeUndefined();
    expect(text).toContain('Why Money loops back flags it');
    expect(text).not.toContain('Why it was flagged');
    expect(text).toContain('Money loops back only, not counted');
    expect(text).toContain(TINT_LEAD);
    expect(text).toContain(APART_WHY);
  });

  it('copies of Round trips in lenses that did not run are not named', async () => {
    Object.assign(state, { moneyRan: false, flagged: ['A', 'AU', 'AC'] });
    const text = await page();
    expect(text).toContain('flagged, by Round trips.');
    expect(text).not.toContain('Linked wallets found');
  });
});

describe('the token page paging and filter', () => {
  const T = `/c/1/${ADDR}/t/7`;
  const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const ids = (c: HTMLElement) => [...c.querySelectorAll('tbody tr')].map((r) => r.id);
  const hrefOf = (c: HTMLElement, text: string) => [...c.querySelectorAll('a')].find((a) => a.textContent === text)?.getAttribute('href');

  // The "Why it was flagged" list only: the graph's labels and the table also carry row numbers.
  const whyLinks = (c: HTMLElement) => [...c.querySelectorAll('ul.space-y-2 a[href*="#t"]')];
  const whyHref = (c: HTMLElement, text: string) => whyLinks(c).find((a) => a.textContent === text)?.getAttribute('href');

  it('links every trade of this token, every change of owner included, in the Trades view', async () => {
    const c = await dom();
    const a = [...c.querySelectorAll('a')].find((x) => x.textContent === 'Every trade of this token →');
    expect(a?.getAttribute('href')).toBe(`/c/1/${ADDR}/flagged?kind=trades&token=7&all=1`);
  });

  it('a token of one page shows no pager under its table', async () => {
    Object.assign(state, { blocks: many(5) });
    const c = await dom();
    expect(c.querySelector('nav[aria-label=Pages]')).toBeNull();
    expect(c.textContent).toContain('Showing 1–5 of 5 transfers');
    expect(c.textContent).not.toContain('5 transfers5 transfers');
  });

  it('shows a hundred rows of 250, and Next links to page 2', async () => {
    Object.assign(state, { blocks: many(250) });
    const c = await dom();
    const rows = ids(c);
    expect(rows).toHaveLength(100);
    expect(rows[0]).toBe('t1');
    expect(rows[99]).toBe('t100');
    expect(c.textContent).toContain('1–100 of 250 transfers');
    expect(c.textContent).not.toContain('Showing');
    expect(hrefOf(c, 'Next ›')).toBe(`${T}?page=2`);
  });

  it("keeps a row's position as its number and id on whichever page holds it", async () => {
    Object.assign(state, { blocks: many(250) });
    const c = await dom({ page: '2' });
    const rows = ids(c);
    expect(rows[0]).toBe('t101');
    expect(rows).toContain('t150');
    expect(c.querySelector('#t150 td')?.textContent).toBe('150');
    expect(c.textContent).toContain('101–200 of 250 transfers');
  });

  it('clamps a page past the end and ignores junk', async () => {
    Object.assign(state, { blocks: many(250) });
    expect(ids(await dom({ page: '99999' }))[0]).toBe('t201');
    cleanup();
    expect(ids(await dom({ page: '-2' }))[0]).toBe('t1');
    cleanup();
    expect(ids(await dom({ page: 'abc', show: 'nonsense' }))).toHaveLength(100);
  });

  it('show=flagged lists only the flagged rows and keeps their numbers', async () => {
    const each = many(250).map((n) => (n === 3 || n === 150 || n === 200 ? ['A'] : []));
    Object.assign(state, { blocks: many(250), each });
    const c = await dom({ show: 'flagged' });
    expect(ids(c)).toEqual(['t3', 't150', 't200']);
    expect(c.textContent).toContain('Showing 1–3 of 3 transfers');
    expect(c.textContent).toContain('· 3 flagged');
  });

  it('show=sales lists only marketplace fills', async () => {
    Object.assign(state, { blocks: many(250), sales: [4, 120] });
    expect(ids(await dom({ show: 'sales' }))).toEqual(['t5', 't121']);
  });

  it('says so when a filter leaves nothing', async () => {
    Object.assign(state, { blocks: many(5) });
    expect((await dom({ show: 'flagged' })).textContent).toContain('None of its transfers is flagged.');
    cleanup();
    expect((await dom({ show: 'sales' })).textContent).toContain('None of its transfers is a sale.');
  });

  it('links the why line of row 150 to its page', async () => {
    const each = many(250).map((n) => (n === 150 ? ['A'] : []));
    Object.assign(state, { blocks: many(250), each });
    expect(whyHref(await dom(), '150')).toBe('?page=2#t150');
  });

  it('a run of three or more rows in one pattern is one link to its first row', async () => {
    const each = many(250).map((n) => (n >= 10 && n <= 12 ? ['A'] : []));
    Object.assign(state, { blocks: many(250), each });
    const c = await dom();
    expect(whyHref(c, '10–12')).toBe('#t10');
    expect(whyLinks(c)).toHaveLength(1);
  });

  it('a graph arrow label links through rowHref too', async () => {
    // All rows run 0x1 to 0x2, so the arrows are one bundle pointing at row 1, drawn from page 2.
    Object.assign(state, { blocks: many(250) });
    const label = [...(await dom({ page: '2' })).querySelectorAll('svg a')].find((a) => a.textContent === '×250');
    expect(label?.getAttribute('href')).toBe('?page=1#t1');
  });

  it('a graph arrow label for a single transfer links to its row', async () => {
    Object.assign(state, { blocks: [5, 6, 7] });
    const label = [...(await dom()).querySelectorAll('svg a')].find((a) => a.textContent === '2');
    expect(label?.getAttribute('href')).toBe('#t2');
  });

  it('links a row the filter keeps with the filter and its place in the filtered list', async () => {
    const each = many(250).map((n) => (n === 150 ? ['A'] : []));
    Object.assign(state, { blocks: many(250), each });
    expect(whyHref(await dom({ show: 'flagged' }), '150')).toBe('?show=flagged#t150');
  });

  it('links a row the filter hides without the filter', async () => {
    const each = many(250).map((n) => (n === 150 || n === 3 ? ['A'] : []));
    // Row 1 is the only sale, so rows 3 and 150, though flagged, are hidden by show=sales.
    Object.assign(state, { blocks: many(250), each, sales: [0] });
    const c = await dom({ show: 'sales' });
    expect(whyHref(c, '3')).toBe('?page=1#t3');
    expect(whyHref(c, '150')).toBe('?page=2#t150');
  });

  it('the filter links drop the page and keep nothing but their own show', async () => {
    Object.assign(state, { blocks: many(250) });
    const c = await dom({ page: '2' });
    expect(hrefOf(c, 'All')).toBe(T);
    expect(hrefOf(c, 'Flagged')).toBe(`${T}?show=flagged`);
    expect(hrefOf(c, 'Sales')).toBe(`${T}?show=sales`);
  });

  const label = (c: HTMLElement, n: string) => [...c.querySelectorAll('svg a')].find((a) => a.textContent === n)?.getAttribute('href');

  it('a graph number the filter keeps links with the filter, as the table does', async () => {
    Object.assign(state, { blocks: many(3), each: [[], ['A'], []] });
    expect(label(await dom({ show: 'flagged' }), '2')).toBe('?show=flagged#t2');
  });

  it('a graph number the filter hides links without the filter', async () => {
    Object.assign(state, { blocks: many(3), each: [[], ['A'], []], sales: [0] });
    expect(label(await dom({ show: 'sales' }), '2')).toBe('?page=1#t2');
  });

  it('?method lights the loops of that lens on arrival, and ?loop that loop, and junk lights none', async () => {
    Object.assign(state, { blocks: many(3), each: [[], ['A'], ['A']] });
    const lit = (c: HTMLElement) => c.querySelectorAll('[data-lit]').length;
    expect(lit(await dom({ method: 'A' }))).toBeGreaterThan(0);
    cleanup();
    expect(lit(await dom({ loop: 'r0' }))).toBeGreaterThan(0);
    cleanup();
    expect(lit(await dom({ method: 'AC' }))).toBe(0);
    cleanup();
    expect(lit(await dom({ method: 'zzz', loop: 'r9' }))).toBe(0);
  });
});
