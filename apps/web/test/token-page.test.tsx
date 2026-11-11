import { cleanup, render } from '@testing-library/react';
import { isValidElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvidenceLine } from '@/components/coverage';
import type { Flow, LoopEdge, OwnFlag, Witness } from '@washtrace/detect';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';

const ADDR = '0x' + 'b'.repeat(40);
const ran = (m: string) => ({ available: m === 'A' || state.moneyRan });
// `each`, when set, gives each transfer its own flags in place of `flagged`.
const state = { missing: false, empty: false, behind: false, moneyRan: true, throughBlock: 10 as number | null, blocks: [5], flagged: [] as string[], each: null as string[][] | null, latestNull: false, sales: [] as number[], runs: [] as ReturnType<typeof lensRun>[], own: [] as OwnFlag[], moves: null as [string, string][] | null, witness: null as Witness | null, flows: [] as Flow[], asked: null as (readonly (readonly [string, string])[]) | null };

/** A lens of yours and its run here: a done run has figures, so it is in `ctx.ran`; a queued one has none yet. */
function lensRun(id: number, name: string, done = true) {
  return {
    lens: { id, key: `L${id}` as const, name, rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 },
    run: { lensId: id, collectionId: 1, status: done ? 'done' as const : 'queued' as const, progress: null, lensVersion: 1, analysisId: 1, throughBlock: 10, totals: done ? { transfers: 1, flagged: 1, sales: 1, flaggedSales: 1, volumeWei: '0', flaggedVolumeWei: '0', wallets: 2, tokens: 1, available: true, truncated: 0, untimed: 0 } : null, error: null, retryAt: null, finishedAt: 1, tookMs: 1 },
  };
}

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => state.missing ? null : ({ id: 1, chainId: 1, address: ADDR, name: 'Coll', startBlock: 0, cursorBlock: state.behind ? 640 : 1000, headBlock: 1000, latest: state.latestNull ? null : { throughBlock: state.throughBlock, totals: Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, ran(m)])) } }),
    token: async () => (state.empty ? [] : state.blocks).map((b, i) => ({
      txHash: '0x' + i, logIndex: 0, blockNumber: b, blockTime: null, tokenId: '7', from: state.moves?.[i]?.[0] ?? '0x1', to: state.moves?.[i]?.[1] ?? '0x2', marketplace: state.sales.includes(i) ? 'Seaport' : null, priceWei: null, currency: null,
      flags: Object.fromEntries((state.each?.[i] ?? state.flagged).map((m) => [m, state.witness ?? { kind: 'scc', wallets: ['0x1', '0x2'], cycles: 2 }])),
    })),
    flowsAmong: async (_chain: number, _id: number, legs: readonly (readonly [string, string])[]) => { state.asked = legs; return state.flows; },
    lensRuns: async () => state.runs,
    passes: async () => [],
    sources: async () => ({}),
    settings: async () => new Map(),
    lensFlagsOfToken: async (_id: number, _token: string, ids: readonly number[]) => state.own.filter((f) => ids.includes(f.lensId)),
  }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => { cleanup(); Object.assign(state, { missing: false, empty: false, behind: false, moneyRan: true, throughBlock: 10, blocks: [5], flagged: [], each: null, latestNull: false, sales: [], runs: [], own: [], moves: null, witness: null, flows: [], asked: null }); });

async function dom(sp: Record<string, string> = {}): Promise<HTMLElement> {
  const { default: TokenPage } = await import('@/app/c/[chain]/[address]/t/[tokenId]/page');
  return render(await TokenPage({ params: Promise.resolve({ chain: '1', address: ADDR, tokenId: '7' }), searchParams: Promise.resolve(sp) })).container;
}
async function page(): Promise<string> { return (await dom()).textContent ?? ''; }
/** Every element of `type` in a page's tree, through every prop: the line reads in its own Suspense, so the tree is where it shows. */
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

  it('names the lenses that agree on a pattern floor, ceiling, then the one not counted', async () => {
    Object.assign(state, { flagged: ['A', 'AU', 'AC'] });
    const names = [...(await dom()).querySelectorAll('a[title^="Open the evidence for"]')].map((a) => a.textContent);
    // The why line's chips come first, then the table row's: both in the same order.
    expect(names.slice(0, 3)).toEqual(['Round trips', 'Linked wallets', 'Money loops back']);
  });

  it('names a money swatch in the legend only when a money arrow is drawn', async () => {
    Object.assign(state, { flagged: ['A'] });
    const legend = [...(await dom()).querySelectorAll('figcaption > span')].map((s) => s.textContent);
    expect(legend).toContain('Round trips · the floor');
    expect(legend).toContain('first holder');
    expect(legend).not.toContain('payment a lens used');
    cleanup();
    // A direct pair's payment back is drawn, and keyed.
    Object.assign(state, { flagged: ['AC'], witness: { kind: 'pair', pair: ['0x1', '0x2'], middle: null, flowTx: '0xp' },
      flows: [{ txHash: '0xp', kind: 'native', from: '0x2', to: '0x1', valueWei: '1000000000000000000', token: '', blockNumber: 6, blockTime: 1 }] });
    expect([...(await dom()).querySelectorAll('figcaption > span')].map((s) => s.textContent)).toContain('payment a lens used');
  });

  it('a token with no analysis does not say no pattern was found', async () => {
    Object.assign(state, { latestNull: true });
    const text = await page();
    expect(text).toContain('Its transfers are read, but no analysis has covered them yet. That is not the same as clean.');
    expect(text).not.toContain('No lens found a pattern');
  });

  it('an unflagged token that came back once says so against what Round trips needs, in a section titled for what happened', async () => {
    const A = '0x' + 'a'.repeat(40), B = '0x' + 'c'.repeat(40);
    Object.assign(state, { blocks: [5, 6], moves: [[A, B], [B, A]] });
    const text = await page();
    expect(text).toContain('Why it was not flagged');
    expect(text).not.toContain('Why it was flagged');
    expect(text).toMatch(/Round trips: it came back to 0xaaaa…aaaa once; a pattern needs 2 cycles\./);
    expect(text).not.toContain('never comes back to a wallet that held it');
    expect(text).toContain('Linked wallets: ');
  });

  it('an unflagged token held in Blur Blend custody names the custodian and labels the wallet in the graph', async () => {
    const BLEND = '0x29469395eaf6f95920e59f858042f0e28d98a20b', A = '0x' + 'a'.repeat(40);
    Object.assign(state, { blocks: [5, 6], moves: [[A, BLEND], [BLEND, A]] });
    const c = await dom();
    const text = c.textContent ?? '';
    expect(text).toContain('loans held in custody (Blur Blend), not sales: no lens judges them.');
    expect(text).toContain('the token never comes back to a wallet that held it');
    expect([...c.querySelectorAll('figcaption > span')].map((s) => s.textContent).join('|')).toContain('custody (Blur Blend)');
    expect(c.querySelector('figure svg')?.textContent).toContain('Blur Blend');
  });

  it('an unflagged token whose lens did not run says so instead of finding nothing', async () => {
    Object.assign(state, { moneyRan: false });
    const text = await page();
    expect(text).toContain('Why it was not flagged');
    expect(text).toContain('Money loops back did not run in the latest analysis');
    expect(text).not.toContain('Money loops back: ');
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
    expect(c.querySelector('.bg-ceiling, .bg-ceiling-surface\\/70, .text-ceiling')?.outerHTML).toBeUndefined();
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
    expect(a?.getAttribute('href')).toBe(`/c/1/${ADDR}/trades?token=7&all=1`);
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

  it('opened from a list, the filter links keep its lens and the list; none to Trades gains that from', async () => {
    Object.assign(state, { blocks: many(250), each: many(250).map((n) => (n === 150 ? ['A'] : [])) });
    const from = 'tokens?method=AC&page=3';
    const c = await dom({ page: '2', method: 'AC', from });
    const ctx = `method=AC&from=${encodeURIComponent(from)}`;
    expect(hrefOf(c, 'All')).toBe(`${T}?${ctx}`);
    expect(hrefOf(c, 'Flagged')).toBe(`${T}?show=flagged&${ctx}`);
    expect(whyHref(c, '150')).toBe(`?page=2&${ctx}#t150`);
    // R15: Trades reads `from` as its date filter, so a list's `from` never rides on its links.
    const toTrades = [...c.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '').filter((h) => /\/trades\b/.test(h));
    expect(toTrades.length).toBeGreaterThan(0);
    for (const h of toTrades) expect(h).not.toContain('from=');
  });

  it('opened with a lens, its links to a wallet or a trade keep the lens', async () => {
    const c = await dom({ method: 'AC' });
    const inside = [...c.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '').filter((h) => /^\/c\/.*\/(w|tx)\//.test(h));
    expect(inside.length).toBeGreaterThan(0);
    for (const h of inside) expect(h).toContain('method=AC');
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

describe('the token page of a loop Money loops back closed by a path', () => {
  // #113's shape: 0x1 sold to 0x2, and 0x2 paid 0x1 back through two other wallets.
  const H1 = '0x' + 'a'.repeat(40), H2 = '0x' + 'c'.repeat(40);
  const pay = (txHash: string, from: string, to: string): Flow => ({ txHash, kind: 'native', from, to, valueWei: '1000000000000000000', token: '', blockNumber: 6, blockTime: 1 });
  const loop = (paths?: { wallets: string[]; txs: string[] }[]): Witness => ({ kind: 'scc+flow', wallets: ['0x1', '0x2'], cycles: 1, via: [['0x2', '0x1']], ...(paths ? { paths } : {}) });
  const setUp = (paths = true) => Object.assign(state, {
    flagged: ['AU'], witness: loop(paths ? [{ wallets: ['0x2', H1, H2, '0x1'], txs: ['0xp1', '0xp2', '0xp3'] }] : undefined),
    // Its three steps, and a payment back along one of them that is no step of it.
    flows: [pay('0xp1', '0x2', H1), pay('0xp2', H1, H2), pay('0xp3', H2, '0x1'), pay('0xp4', H2, H1)],
  });
  const lit = (c: HTMLElement) => [...c.querySelectorAll('[data-lit]')].map((e) => e.getAttribute('data-edge')).sort();

  it('asks for the payments along the path, draws its wallets, and says who paid whom back through how many', async () => {
    setUp();
    const c = await dom();
    expect(state.asked).toEqual(expect.arrayContaining([['0x2', '0x1'], ['0x2', H1], [H1, H2], [H2, '0x1']]));
    expect(state.asked).not.toContainEqual([H2, H1]);
    for (const h of [H1, H2]) expect(c.querySelector(`[aria-label="Wallet ${h}"]`)).not.toBeNull();
    expect(c.querySelector('#why')?.textContent).toContain('paid 0x1…0x1 back through 2 other wallets, closing a loop of 2 wallets');
    // In between, keyed so.
    expect([...c.querySelectorAll('figcaption > span')].map((s) => s.textContent)).toContain('in between, funder or payee: joined by money only');
  });

  it('Show in graph lights the path: its sale and its steps’ payments, not another payment among its wallets', async () => {
    setUp();
    // The fourth payment is no step, so the page never draws it: only evidence is drawn.
    const c = await dom({ loop: 'r0' });
    expect(lit(c)).toEqual(['p0', 'p1', 'p2', 't0']);
    expect(c.querySelector('[data-edge="p3"]')).toBeNull();
  });

  it('keeps today’s drawing and words for a loop saved before paths were: the sale, and no wallet beyond its two', async () => {
    setUp(false);
    const c = await dom({ loop: 'r0' });
    expect(c.querySelector(`[aria-label="Wallet ${H1}"]`)).toBeNull();
    expect(lit(c)).toEqual(['t0']);
    expect(c.querySelector('#why')?.textContent).toContain('2 wallets in a loop closed by a payment back');
  });
});

describe('the token page with lenses of yours', () => {
  const W = '0x' + '9'.repeat(40), F = '0x' + 'f'.repeat(40);
  const edge = (kind: LoopEdge['kind'], from: string, to: string, more: Partial<LoopEdge> = {}): LoopEdge =>
    ({ from, to, kind, tx: null, time: null, amountWei: null, tokenId: null, token: null, ...more });
  /** Row i's transfer (0x1 → 0x2, tx 0x<i>), caught by lens `id` back through a money middle, or through a funder. */
  const caught = (id: number, i: number, funder = false): OwnFlag => ({
    lensId: id, collectionId: 1, txHash: '0x' + i, logIndex: 0, wallets: ['0x1', '0x2', funder ? F : W],
    path: funder
      ? [edge('nft-token', '0x1', '0x2', { tx: '0x' + i, tokenId: '7' }), edge('eth', '0x2', F, { amountWei: '1000000000000000000' }), edge('funds', F, '0x1', { amountWei: '2000000000000000000' })]
      : [edge('nft-token', '0x1', '0x2', { tx: '0x' + i, tokenId: '7' }), edge('eth', '0x2', W, { amountWei: '500000000000000000' }), edge('weth', W, '0x1')],
  });
  const setUp = () => Object.assign(state, {
    blocks: [5, 6], each: [['A'], ['A']],
    runs: [lensRun(7, 'Fast flips'), lensRun(8, 'Slow loops'), lensRun(9, 'Not yet', false)],
    own: [caught(7, 0), caught(7, 1, true), caught(8, 1), caught(9, 0)],
  });
  const whyItems = (c: HTMLElement) => [...c.querySelectorAll('#why li')];

  it('Why it was flagged lists one line per loop of a lens of yours, named, with Show in graph', async () => {
    setUp();
    const c = await dom();
    const items = whyItems(c);
    // One built-in pattern (both rows), then the three loops of the lenses that ran; the queued lens's flag is not read.
    expect(items).toHaveLength(4);
    const own = items.slice(1).map((li) => li.textContent);
    expect(own[0]).toContain('Back to the seller through 1 wallet, 2 by money');
    expect(own[0]).toContain('Fast flips');
    expect(own[1]).toContain('Back to the seller through 1 wallet, 1 by money, closed at a funder');
    expect(own[2]).toContain('Slow loops');
    expect(c.textContent).not.toContain('Not yet');
    for (const li of items.slice(1)) expect(li.querySelector('button')?.textContent).toBe('Show in graph');
    const lens = [...items[1]!.querySelectorAll('a')].find((a) => a.textContent === 'Fast flips');
    expect(lens?.getAttribute('href')).toBe(`/c/1/${ADDR}/methods?method=L7#evidence`);
    expect([...items[1]!.querySelectorAll('a')].find((a) => a.textContent === '1')?.getAttribute('href')).toBe('#t1');
  });

  it('says a loop that closes at the buyer goes back through no wallet', async () => {
    Object.assign(state, {
      runs: [lensRun(7, 'Fast flips')],
      own: [{ lensId: 7, collectionId: 1, txHash: '0x0', logIndex: 0, wallets: ['0x1', '0x2'], path: [edge('nft-token', '0x1', '0x2', { tx: '0x0', tokenId: '7' }), edge('eth', '0x2', '0x1')] }],
    });
    expect(whyItems(await dom())[0]?.textContent).toContain('Back to the seller through no wallet, 1 by money');
  });

  it('?method=L7 lights that lens’s loops', async () => {
    setUp();
    const lit = (c: HTMLElement) => [...c.querySelectorAll('[data-lit]')].map((e) => e.getAttribute('data-edge')).sort();
    const c = await dom({ method: 'L7' });
    // Its two loops, each its trade's arrow and its own way back; Slow loops' (o2) and the built-in's stay dark.
    expect(lit(c)).toEqual(['o0e1', 'o0e2', 'o1e1', 'o1e2', 't0', 't1']);
    expect(whyItems(c).filter((li) => li.querySelector('button[aria-pressed="true"]')).length).toBe(2);
    cleanup();
    // A lens that has not run here has no loops to light.
    expect((await dom({ method: 'L9' })).querySelectorAll('[data-lit]')).toHaveLength(0);
  });

  it('the verdict stays built-ins only and adds the trades your lenses also catch', async () => {
    setUp();
    const answer = (await dom()).querySelector('p.text-lg')!.parentElement!.textContent ?? '';
    expect(answer).toContain('2 of 2 transfers flagged, by Round trips.');
    expect(answer).toContain('Your lenses also catch 2 of its trades: Fast flips and Slow loops.');
  });

  it('says only your lenses catch a token the built-ins do not flag', async () => {
    Object.assign(state, { runs: [lensRun(7, 'Fast flips')], own: [caught(7, 0)] });
    const title = (await dom()).querySelector('p.text-lg')!;
    // The title is the built-ins' verdict, and says whose, so it does not read as no lens at all.
    expect(title.textContent).toBe('Not flagged by the built-in lenses');
    const answer = title.parentElement!.textContent ?? '';
    expect(answer).toContain('None of its 1 transfers is flagged by the built-in lenses.');
    expect(answer).toContain('Your lenses also catch 1 of its trades: Fast flips.');
  });

  it('a transfer row’s chips include a lens of yours', async () => {
    setUp();
    const c = await dom();
    // The fifth column, "Lenses that flag it".
    const chips = (id: string) => [...c.querySelectorAll(`#${id} td:nth-child(5) a`)].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(chips('t1')).toEqual([['Round trips', `/c/1/${ADDR}/methods?method=A#evidence`], ['Fast flips', `/c/1/${ADDR}/methods?method=L7#evidence`]]);
    expect(chips('t2')).toEqual([['Round trips', `/c/1/${ADDR}/methods?method=A#evidence`], ['Fast flips', `/c/1/${ADDR}/methods?method=L7#evidence`], ['Slow loops', `/c/1/${ADDR}/methods?method=L8#evidence`]]);
  });

  it('no lens code in text, aria-label or title', async () => {
    setUp();
    const c = await dom({ method: 'L7' });
    const said = [
      c.textContent ?? '',
      ...[...c.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')!),
      ...[...c.querySelectorAll('[title]')].map((e) => e.getAttribute('title')!),
      ...[...c.querySelectorAll('title')].map((e) => e.textContent ?? ''),
    ];
    for (const s of said) expect(s).not.toMatch(/\bL[789]\b/);
  });
});

describe('the token page for a watched collection with no transfer of the token', () => {
  it('says the history is still being read, with its share, and links back, without a 404', async () => {
    Object.assign(state, { empty: true, behind: true });
    const el = await dom();
    expect(el.textContent).toContain('No transfer of #7 is read yet · history 64% read');
    expect([...el.querySelectorAll('a')].find((a) => a.textContent === 'Back to Coll')!.getAttribute('href')).toBe(`/c/1/${ADDR}`);
  });

  it('says the token is not in the history once the history is read', async () => {
    Object.assign(state, { empty: true });
    const text = await page();
    expect(text).toContain("No transfer of #7 is in Coll's history.");
    expect(text).not.toContain('read yet');
  });

  it('heads as any token page: a Not judged yet chip, an answer with what it means, and a button back', async () => {
    Object.assign(state, { empty: true });
    const el = await dom();
    expect(el.querySelector('header .chip')?.textContent).toBe('Not judged yet');
    expect(el.querySelector('p.text-lg')?.textContent).toBe('No transfer of this token is read');
    expect(el.textContent).toContain('What this means: It may not be minted');
    const back = [...el.querySelectorAll('a')].find((a) => a.textContent === 'Back to Coll')!;
    expect(back.className).toMatch(/\bbtn\b/);
    expect(back.className).toMatch(/\bmt-4\b/);
  });

  it('still answers not found for a collection that is not watched', async () => {
    Object.assign(state, { missing: true });
    await expect(dom()).rejects.toThrow('not found');
  });
});

describe('the token page\'s evidence line', () => {
  it('stands on the wallets that held the token, never a mint, a burn or an escrow, and sits in the token\'s collection', async () => {
    const BURN = '0x' + '0'.repeat(40);
    Object.assign(state, { blocks: [5, 6, 7], moves: [[BURN, '0x1'], ['0x1', '0x2'], ['0x2', BURN]] });
    const { default: TokenPage } = await import('@/app/c/[chain]/[address]/t/[tokenId]/page');
    const tree = await TokenPage({ params: Promise.resolve({ chain: '1', address: ADDR, tokenId: '7' }), searchParams: Promise.resolve({}) });
    expect(elementsOf(tree, EvidenceLine).map((e) => [e.props.chainId, e.props.home, e.props.wallets])).toEqual([[1, ADDR, ['0x1', '0x2']]]);
  });

  it('leaves out a marketplace contract that held it, as the engine does: only real traders have money to read', async () => {
    const CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71';
    Object.assign(state, { blocks: [5, 6], moves: [['0x1', CONDUIT], [CONDUIT, '0x2']] });
    const { default: TokenPage } = await import('@/app/c/[chain]/[address]/t/[tokenId]/page');
    const tree = await TokenPage({ params: Promise.resolve({ chain: '1', address: ADDR, tokenId: '7' }), searchParams: Promise.resolve({}) });
    expect(elementsOf(tree, EvidenceLine).map((e) => e.props.wallets)).toEqual([['0x1', '0x2']]);
  });
});
