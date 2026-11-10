import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';
import { parseView } from '@/lib/trades-url';

const ADDR = '0x' + 'b'.repeat(40);
const SELLER = '0x' + '1'.repeat(40);
const BUYER = '0x' + '2'.repeat(40);
const BASE = `/c/1/${ADDR}`;

const row = (hash: string, over: Record<string, unknown> = {}) => ({
  txHash: hash, logIndex: 0, blockNumber: 5, blockTime: 1_680_000_000, tokenId: '7', from: SELLER, to: BUYER, marketplace: 'blur',
  priceWei: '1500000000000000000', currency: '', flags: {}, lenses: ['A'], judged: true, heldS: 7200, buyerAgeS: 86_400 * 3, floorRatio: 1.25, ...over,
});


/** A saved lens of yours and its run on this collection (null: it has none here). */
const ownRun = (id: number, name: string, status: 'done' | 'queued' = 'done', over: Record<string, unknown> = {}) => ({
  lens: { id, key: `L${id}`, name, rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 },
  run: { lensId: id, collectionId: 1, status, progress: null, lensVersion: 1, analysisId: 1, throughBlock: 10, totals: status === 'done' ? { available: true } : null, error: null, retryAt: null, finishedAt: null, tookMs: 1, ...over },
});

const fresh = () => ({
  runs: [] as ReturnType<typeof ownRun>[], moneyRan: true, analysed: true, loops: undefined as object | null | undefined, rows: [row('0xs1'), row('0xs2', { lenses: ['A', 'AU'] })] as ReturnType<typeof row>[], count: { total: 2, unjudged: 0 },
  groups: [{ key: 'blur', trades: 3, caught: { A: 2, AU: 1 } }, { key: '-', trades: 1, caught: {} }],
  calls: { trades: [] as unknown[][], count: [] as unknown[][], groups: [] as unknown[][] },
});
const state = fresh();

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => ({ id: 1, chainId: 1, address: ADDR, name: 'Coll', latest: !state.analysed ? null : { id: 1, throughBlock: 10, loops: state.loops, totals: Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, { available: m === 'A' || state.moneyRan, tokens: 0, wallets: 0 }])) } }),
    lensRuns: async () => state.runs,
    lensTokens: async () => ({ rows: [], total: 0 }),
    lensWallets: async () => ({ rows: [], total: 0 }),
    trades: async (...a: unknown[]) => { state.calls.trades.push(a); return state.rows; },
    tradeCount: async (...a: unknown[]) => { state.calls.count.push(a); return state.count; },
    tradeGroups: async (...a: unknown[]) => { state.calls.groups.push(a); return state.groups; },
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, redirect: (to: string) => { throw new Error(`redirect:${to}`); }, useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => { cleanup(); Object.assign(state, fresh()); });

async function dom(sp: Record<string, string | string[]> = {}): Promise<HTMLElement> {
  const { default: Trades } = await import('@/app/c/[chain]/[address]/trades/page');
  return render(await Trades({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
/** The Tokens or Wallets list for `kind`; any other kind is the old flagged page, which only redirects. */
async function flaggedDom({ kind, ...rest }: Record<string, string | string[]>): Promise<HTMLElement> {
  const params = Promise.resolve({ chain: '1', address: ADDR });
  if (kind !== 'tokens' && kind !== 'wallets') {
    const { default: Old } = await import('@/app/c/[chain]/[address]/flagged/page');
    await Old({ params, searchParams: Promise.resolve({ ...rest, ...(kind === undefined ? {} : { kind }) }) });
    throw new Error('the old flagged page rendered instead of redirecting');
  }
  const { default: List } = kind === 'tokens' ? await import('@/app/c/[chain]/[address]/tokens/page') : await import('@/app/c/[chain]/[address]/wallets/page');
  return render(await List({ params, searchParams: Promise.resolve(rest) })).container;
}
async function page(sp: Record<string, string | string[]> = {}): Promise<string> { return (await dom(sp)).textContent ?? ''; }
// The DOM's selector engine reads `?` and `&` in an attribute value badly, so links are found by comparing the attribute.
/** Every text, aria-label and title in `c`: a lens key may show in none of them. */
const reads = (c: Element) => [c.textContent, ...[...c.querySelectorAll('[aria-label],[title]')].flatMap((e) => [e.getAttribute('aria-label'), e.getAttribute('title')])].join('\n');
const linkTo = (c: HTMLElement, href: string) => [...c.querySelectorAll('a')].find((a) => a.getAttribute('href') === href);
/** A trade's link, whatever list it says it came from (`?from=`, for stepping). */
const tradeLink = (c: HTMLElement, href: string) => [...c.querySelectorAll('a')].find((a) => a.getAttribute('href')?.split('?')[0] === href);
const hrefs = (c: HTMLElement, sel: string) => [...c.querySelectorAll(sel)].map((a) => a.getAttribute('href'));

describe('the trades page', () => {
  it('redirects an old flagged?kind=trades link to /trades, in the order the trades page writes it', async () => {
    const old = { kind: 'trades', caught: 'L3', market: 'blur', page: '2', sort: 'price', dir: 'asc' };
    await expect(flaggedDom({ ...old, caught: 'A' })).rejects.toThrow(`redirect:${BASE}/trades?caught=A&market=blur&sort=price&dir=asc&page=2`);
    // A lens of yours that ran here is kept, in the same place.
    state.runs = [ownRun(3, 'Blur 3-hop')];
    await expect(flaggedDom(old)).rejects.toThrow(`redirect:${BASE}/trades?caught=L3&market=blur&sort=price&dir=asc&page=2`);
  });

  it('links its CSV to the unchanged API route with the same query', async () => {
    const el = await dom({ caught: 'A', market: 'blur', page: '2' });
    expect(el.querySelector('a[href^="/api/"]')?.getAttribute('href')).toBe(`/api/collections/1/${ADDR}/trades?format=csv&caught=A&market=blur`);
    cleanup();
    expect((await dom()).querySelector('a[href^="/api/"]')?.getAttribute('href')).toBe(`/api/collections/1/${ADDR}/trades?format=csv`);
  });

  it('posts its forms to /trades and carries no kind', async () => {
    const el = await dom({ caught: 'A' });
    for (const form of el.querySelectorAll('form')) {
      expect(form.getAttribute('action')).toBe(`${BASE}/trades`);
      expect(form.querySelector('input[name=kind]')).toBeNull();
    }
  });

  it('shows matching trades with a dot per lens that ran, named by lens, and the date opens the trade', async () => {
    const el = await dom({ caught: 'A' });
    expect(el.textContent).toContain('2 trades match');
    expect([...el.querySelectorAll('th')].map((t) => t.textContent)).toEqual(expect.arrayContaining(['Round tripsthe floor', 'Money loops backnot counted', 'Linked walletsthe ceiling']));
    expect(el.querySelector('th [title^="On real data it flags"]')!.textContent).toBe('not counted');
    expect(tradeLink(el, `${BASE}/tx/0xs2`)).not.toBeUndefined();
    expect(el.textContent).not.toMatch(/\bAU\b|\bAC\b/);
  });

  it('reads trades, their count and their groups with the lenses that ran, money and the reader zone', async () => {
    state.moneyRan = false;
    await dom({ by: 'marketplace' });
    const [id, q, ctx, limit, offset] = state.calls.trades[0]!;
    expect(id).toBe(1);
    expect((q as { kind: string }).kind).toBe('sales');
    expect(ctx).toMatchObject({ ran: ['A'], zone: 'UTC' });
    expect((ctx as { money: Set<string> }).money.has('')).toBe(true);
    expect([limit, offset]).toEqual([20, 0]);
    expect(state.calls.count[0]![2]).toBe(ctx);
    expect(state.calls.groups[0]![2]).toBe('marketplace');
    expect(state.calls.groups[0]![3]).toMatchObject({ ran: ['A'] });
  });

  it('draws only the lenses that ran', async () => {
    state.moneyRan = false;
    const th = [...(await dom()).querySelectorAll('thead th')].map((t) => t.textContent);
    expect(th).toContain('Round tripsthe floor');
    expect(th.join()).not.toContain('Linked wallets');
    expect(th.join()).not.toContain('Money loops back');
  });

  it('a caught filter on a lens that did not run says so, and reads no rows', async () => {
    state.moneyRan = false;
    expect(await page({ caught: 'AU' })).toContain('Money loops back did not run in the latest analysis, so it flags nothing.');
    expect(state.calls.trades).toHaveLength(0);
  });

  it('before any analysis a built-in is never said to have missed the latest one: it has not run here at all', async () => {
    state.analysed = false;
    const text = await page({ caught: 'AU' });
    expect(text).toContain('Money loops back has not run on this collection, so it flags nothing yet.');
    expect(text).not.toContain('latest analysis');
    cleanup();
    expect((await flaggedDom({ method: 'A', kind: 'tokens' })).textContent).toContain('Round trips has not run on this collection, so it flags nothing yet.');
  });

  it('says how many matching trades are newer than the latest analysis, and shows them as not judged', async () => {
    Object.assign(state, { count: { total: 3, unjudged: 1 }, rows: [row('0xs1'), row('0xs2', { judged: false, lenses: [] })] });
    const el = await dom();
    expect(el.textContent).toContain('3 trades match');
    expect(el.textContent).toContain(' 1 of them are newer than the latest analysis and not judged yet.');
    const cell = [...el.querySelectorAll('td')].find((td) => td.textContent === 'Not judged yet');
    expect(cell?.getAttribute('colspan')).toBe('3');
  });

  it('a not-caught lens that did not run is left out and said', async () => {
    state.moneyRan = false;
    expect(await page({ not: 'AC' })).toContain('Linked wallets did not run in the latest analysis, so it flags nothing. It is left out of "not flagged by".');
  });

  it('each chip removes its own filter and keeps the grouping; each group row and share cell adds its group', async () => {
    const el = await dom({ caught: 'A', by: 'marketplace' });
    expect(linkTo(el, `${BASE}/trades?by=marketplace`)?.textContent).toContain('Flagged by Round trips');
    const blur = el.querySelector('a[href*="market=blur"][href*="by=marketplace"]');
    expect(blur?.closest('tr')?.textContent).toContain('Blur');
    // Count and share agree: the share adds only the lens.
    const links = hrefs(blur!.closest('tr')!, 'a');
    expect(links).toContain(`${BASE}/trades?caught=A&market=blur&by=marketplace`);
    expect(links).toContain(`${BASE}/trades?caught=AU&market=blur&by=marketplace`);
    expect(blur!.closest('tr')!.textContent).toContain('67%');
  });

  it('the unknown group has no links and says what it is; the Money loops back column says it is not counted', async () => {
    const el = await dom({ by: 'marketplace' });
    const unknown = [...el.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('Not a marketplace sale'));
    expect(unknown).toBeDefined();
    expect(unknown!.querySelectorAll('a')).toHaveLength(0);
    expect([...el.querySelectorAll('th')].filter((t) => t.textContent === 'Money loops backnot counted').length).toBe(2);
  });

  it('every built-in column, in both tables, says its standing under its name', async () => {
    const el = await dom({ by: 'marketplace' });
    const tiers = [...el.querySelectorAll('thead th span.block')].map((s) => s.textContent);
    expect(tiers.filter((t) => t === 'the floor')).toHaveLength(2);
    expect(tiers.filter((t) => t === 'the ceiling')).toHaveLength(2);
    expect(tiers.filter((t) => t === 'not counted')).toHaveLength(2);
  });

  it('a lens that did not run shows not run in a group row', async () => {
    state.moneyRan = false;
    const el = await dom({ by: 'marketplace' });
    const blur = [...el.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('Blur') && r.textContent.includes('not run'));
    expect(blur).toBeDefined();
  });

  it('the Find box keeps the other filters, and an unreadable find says what it takes', async () => {
    const el = await dom({ caught: 'A', market: 'blur', by: 'month' });
    const form = el.querySelector('form[role=search]')!;
    expect((form.querySelector('input[name=q]') as HTMLInputElement).placeholder).toBe('Token number, wallet or tx');
    const kept = Object.fromEntries([...form.querySelectorAll('input[type=hidden]')].map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value]));
    expect(kept).toEqual({ caught: 'A', market: 'blur', by: 'month' });
    cleanup();
    state.calls.trades.length = 0;
    expect(await page({ q: 'hello' })).toContain('“hello” is not a token number, wallet address or transaction hash.');
    expect(state.calls.trades).toHaveLength(0);
    cleanup();
    await dom({ q: '12' });
    expect(state.calls.trades).toHaveLength(1);
  });

  it('the filter form is plain fields, prefilled from the query, with no client component and no page', async () => {
    const el = await dom({ caught: 'A', pmin: '0.5', heldunder: '90m', ageover_n: '2', ageover_u: 'd', from_day: '2023-03-01', market: 'blur', wallet: SELLER, sort: 'price', page: '2' });
    const form = el.querySelector('form[aria-label="Filter trades"]')!;
    const input = (n: string) => form.querySelector(`input[name=${n}], select[name=${n}]`) as HTMLInputElement;
    expect(input('pmin').value).toBe('0.5');
    expect((form.querySelector('input[name=market][value=blur]') as HTMLInputElement).checked).toBe(true);
    expect((form.querySelector('input[name=caught][value=A]') as HTMLInputElement).checked).toBe(true);
    expect([input('heldunder_n').value, input('heldunder_u').value]).toEqual(['90', 'm']);
    expect([input('ageover_n').value, input('ageover_u').value]).toEqual(['2', 'd']);
    expect(input('from_day').value).toBe('2023-03-01');
    expect(input('to_day').value).toBe('');
    expect(input('heldunder_n').getAttribute('min')).toBe('0');
    expect(form.querySelector('input[name=heldunder]')).toBeNull();
    const singles = [...form.querySelectorAll('input[name]:not([type=checkbox])')].map((i) => (i as HTMLInputElement).name);
    expect(new Set(singles).size).toBe(singles.length);
    expect(form.querySelector('input[name=page]')).toBeNull();
    expect(singles).toEqual(expect.arrayContaining(['wallet', 'sort']));
    expect(form.getAttribute('method')).toBe('get');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('apps/web/components/trades.tsx', 'utf8')).not.toMatch(/use client|trade-fields/);
  });

  it('a row with no block time still opens its trade, and the count line comes before the groups', async () => {
    state.rows = [row('0xs1', { blockTime: null })];
    const el = await dom({ by: 'marketplace' });
    expect(tradeLink(el, `${BASE}/tx/0xs1`)?.textContent).toBe('Unknown time');
    const text = el.textContent!;
    expect(text.indexOf('trades match')).toBeLessThan(text.indexOf('Not a marketplace sale'));
  });

  it('with no match, still says a not-caught lens did not run', async () => {
    Object.assign(state, { moneyRan: false, count: { total: 0, unjudged: 0 }, rows: [] });
    const text = await page({ not: 'AC' });
    expect(text).toContain('No trade matches these filters.');
    expect(text).toContain('Linked wallets did not run in the latest analysis, so it flags nothing. It is left out of "not flagged by".');
  });

  it('every header sorts and toggles the direction; a lens column sorts by the lens', async () => {
    const el = await dom({ sort: 'price', dir: 'asc' });
    const link = (name: string) => [...el.querySelectorAll('thead th a')].find((a) => a.textContent === name)?.getAttribute('href');
    expect(link('Price')).toBe(`${BASE}/trades?sort=price`);
    expect(link('Round tripsthe floor')).toBe(`${BASE}/trades?sort=lens-A`);
    expect(link('Seller → buyer')).toContain('sort=seller');
    expect(link('Date')).toBe(`${BASE}/trades`);
  });

  it('a wallet and a token each have a link that narrows the view to them', async () => {
    const el = await dom({ caught: 'A' });
    expect(linkTo(el, `${BASE}/trades?caught=A&wallet=${SELLER}`)?.title).toBe('Only trades with this wallet');
    expect(linkTo(el, `${BASE}/trades?caught=A&token=7`)?.title).toBe('Only trades with this token');
    expect(linkTo(el, `${BASE}/t/7`)).toBeDefined();
  });

  it('a page past the last shows the last page', async () => {
    state.count = { total: 120, unjudged: 0 };
    const el = await dom({ page: '99999' });
    expect(el.textContent).toContain('Page');
    expect(el.textContent).toContain('101–120 of 120 trades');
    expect(state.calls.trades[0]!.slice(3)).toEqual([20, 100]);
  });

  it('junk in the URL is dropped and shows the unfiltered list', async () => {
    const el = await dom({ caught: 'ZZ', pmin: 'abc', page: '-2', by: 'nope' });
    expect(el.textContent).toContain('2 trades match');
    expect(el.querySelectorAll('a[title="Remove this filter"]')).toHaveLength(0);
  });

  it('no match says so, with the chips still shown', async () => {
    Object.assign(state, { count: { total: 0, unjudged: 0 }, rows: [] });
    const el = await dom({ market: 'x2y2' });
    expect(el.textContent).toContain('No trade matches these filters.');
    expect(el.textContent).toContain('Marketplace: X2Y2');
  });

  it('Download CSV links to the export with the same filters, without the page or grouping', async () => {
    const el = await dom({ caught: 'A', by: 'month', page: '2' });
    const a = [...el.querySelectorAll('a')].find((x) => x.textContent === 'Download CSV ↓');
    expect(a?.getAttribute('href')).toBe(`/api/collections/1/${ADDR}/trades?format=csv&caught=A`);
  });

  it('a lens link replaces the caught filter', async () => {
    const el = await dom({ caught: 'AC,A' });
    const lens = [...el.querySelectorAll('nav[aria-label=Lens] a')].find((a) => a.textContent === 'Linked wallets · the ceiling');
    expect(lens?.getAttribute('href')).toBe(`${BASE}/trades?caught=AC`);
  });
  it.each([
    ['marketplace', 'Not a marketplace sale'],
    ['month', 'No block time'],
    ['held', "Not judged yet, its token's first transfer, or no block time"],
    ['buyerAge', 'Not judged yet, or no block time'],
    ['floor', 'Unpriced, not in ETH, WETH or Blur Pool, no priced sale in the 7 days before, no block time, or not judged yet'],
  ])('the unknown %s group says why its trades have no value there', async (by, label) => {
    const el = await dom({ by });
    const rows = [...el.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent);
    expect(rows).toContain(label);
  });

  it('a hold or a buyer age under a minute reads <1 min', async () => {
    state.rows = [row('0xs1', { heldS: 30, buyerAgeS: 0 })];
    const cells = [...(await dom()).querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells.filter((t) => t === '<1 min')).toHaveLength(2);
    expect(cells).not.toContain('1 min');
  });

  it('with no lens run, an unjudged row has as many cells as the header', async () => {
    Object.assign(state, { analysed: false, count: { total: 1, unjudged: 1 }, rows: [row('0xs1', { judged: false, lenses: [] })] });
    const el = await dom();
    const head = el.querySelectorAll('table thead th').length;
    expect(el.querySelector('table tbody tr')!.children).toHaveLength(head);
  });

  it('an hour-period view keeps its hour bounds when a new filter is added', async () => {
    const from = '2023-03-01T05:00Z', to = '2023-03-01T06:00Z';
    const el = await dom({ from, to });
    const form = el.querySelector('form[aria-label="Filter trades"]')!;
    // The form as the browser sends it, with one more filter ticked.
    (form.querySelector('input[name=market][value=blur]') as HTMLInputElement).checked = true;
    const sent: Record<string, string[]> = {};
    for (const i of form.querySelectorAll('input[name], select[name]')) {
      const f = i as HTMLInputElement;
      if (f.type === 'checkbox' && !f.checked) continue;
      (sent[f.name] ??= []).push(f.value);
    }
    expect(sent.from).toEqual([from]);
    expect(sent.to).toEqual([to]);
    const { q } = parseView(sent, 'UTC', new Set());
    expect([q.fromMs, q.toMs]).toEqual([Date.parse(from), Date.parse(to)]);
    expect(q.venues).toEqual(['blur']);
  });

  it('a kept hour bound disables its day field and says how to change it', async () => {
    const el = await dom({ from: '2023-03-01T05:00Z' });
    const form = el.querySelector('form[aria-label="Filter trades"]')!;
    expect((form.querySelector('input[name=from_day]') as HTMLInputElement).disabled).toBe(true);
    expect((form.querySelector('input[name=to_day]') as HTMLInputElement).disabled).toBe(false);
    expect(form.textContent).toContain('remove the date chip to change it.');
  });

  it('a trade row opens its trade on the price; its hold, buyer age and floor are plain measures', async () => {
    state.rows = [row('0xs1')];
    const el = await dom();
    const cells = [...el.querySelectorAll('tbody td[data-measure]')];
    expect(cells.map((td) => td.textContent)).toEqual(['2 h', '3 d', '1.25×']);
    expect(cells.every((td) => td.querySelector('a') === null)).toBe(true);
    expect([...el.querySelectorAll('tbody a')].find((a) => a.textContent === '1.5 ETH')?.getAttribute('href')?.split('?')[0]).toBe(`${BASE}/tx/0xs1`);
  });

  it('a midnight bound goes back as a day field, not a hidden one', async () => {
    const el = await dom({ from: '2023-03-01' });
    const form = el.querySelector('form[aria-label="Filter trades"]')!;
    expect(form.querySelector('input[type=hidden][name=from]')).toBeNull();
    expect((form.querySelector('input[name=from_day]') as HTMLInputElement).value).toBe('2023-03-01');
  });

  it('a group on a lens that did not run says so, and reads no rows', async () => {
    state.moneyRan = false;
    const text = await page({ group: `AU.t.7` });
    expect(text).toContain('Money loops back did not run in the latest analysis, so it flags nothing.');
    expect(text).not.toContain('No trade matches');
    expect(state.calls.trades).toHaveLength(0);
  });

  it('a sort on a lens that did not run says nothing and falls back to newest first', async () => {
    state.moneyRan = false;
    const el = await dom({ sort: 'lens-AU' });
    expect(el.textContent).toContain('2 trades match');
    expect(el.textContent).not.toContain('did not run');
    expect((state.calls.trades[0]![1] as { sort: string }).sort).toBe('date');
    expect([...el.querySelectorAll('thead th')].find((t) => t.textContent === 'Date')?.getAttribute('aria-sort')).toBe('descending');
  });

  it('every change of owner says so in its sub line', async () => {
    expect(await page({ all: '1' })).toContain('Every change of owner, filtered by what you ask');
    cleanup();
    expect(await page()).toContain('Every sale, filtered by what you ask');
  });

  it('an analysis that predates the figures says the collection is queued again, not that its trades are newer', async () => {
    Object.assign(state, { loops: null, count: { total: 2, unjudged: 2 } });
    const text = await page();
    expect(text).toContain('The latest analysis predates these figures; this collection is queued to be analyzed again.');
    expect(text).not.toContain('newer than the latest analysis');
  });

  it('a collection never analysed says so in the count line', async () => {
    Object.assign(state, { analysed: false, count: { total: 2, unjudged: 2 } });
    const text = await page();
    expect(text).toContain('2 trades match · everything is in the address bar, so this view can be shared. Not judged yet.');
    expect(text).not.toContain('newer than the latest analysis');
  });

  describe('with a lens of yours', () => {
    const mine = () => { state.runs = [ownRun(7, 'Blur 3-hop')]; state.rows = [row('0xs1', { lenses: ['A', 'L7'] })]; state.groups = [{ key: 'blur', trades: 3, caught: { L7: 2 } } as never]; };

    it('names it in the lens nav, the Flagged-by boxes, the dot column and the Group by column, and never by its key', async () => {
      mine();
      const el = await dom({ caught: 'L7', by: 'marketplace' });
      expect(el.querySelector('nav[aria-label=Lens]')?.textContent).toContain('Blur 3-hop');
      const boxes = [...el.querySelectorAll('fieldset')].find((f) => f.querySelector('legend')?.textContent === 'Flagged by')!;
      expect([...boxes.querySelectorAll('label')].map((l) => l.textContent)).toEqual(['Round trips', 'Linked wallets', 'Money loops back', 'Blur 3-hop']);
      expect([...el.querySelectorAll('thead th')].map((t) => t.textContent).filter((t) => t === 'Blur 3-hop')).toHaveLength(2);
      expect(el.querySelector('[aria-label="Flagged by Blur 3-hop"] i')?.className).toContain('bg-flow');
      expect(el.textContent).toContain('Flagged by Blur 3-hop');
      expect(reads(el)).not.toMatch(/\bL7\b/);
      expect(state.calls.trades[0]![2]).toMatchObject({ ran: ['A', 'AU', 'AC', 'L7'] });
    });

    it('a filter on a run that is queued says it has not run, in the one sentence every page uses, and reads nothing', async () => {
      state.runs = [ownRun(7, 'Blur 3-hop', 'queued')];
      expect(await page({ caught: 'L7' })).toContain('Blur 3-hop has not run on this collection, so it flags nothing yet.');
      expect(state.calls.trades).toHaveLength(0);
      // A built-in's is about the latest analysis.
      state.moneyRan = false;
      expect(await page({ caught: 'AC' })).toContain('Linked wallets did not run in the latest analysis, so it flags nothing.');
    });

    it('reads every trade list through the block your lens\'s run read, so a newer trade is never judged clean by it', async () => {
      state.runs = [ownRun(7, 'Blur 3-hop', 'done', { throughBlock: 8 })];
      await dom({ not: 'L7', by: 'marketplace' });
      expect(state.calls.trades[0]![2]).toMatchObject({ through: { L7: 8 } });
      expect(state.calls.count[0]![2]).toMatchObject({ through: { L7: 8 } });
      expect(state.calls.groups[0]![3]).toMatchObject({ through: { L7: 8 } });
    });

    it('marks a trade past that block not judged yet in your lens\'s column, as a trade no analysis covered is', async () => {
      state.runs = [ownRun(7, 'Blur 3-hop', 'done', { throughBlock: 8 })];
      state.rows = [row('0xs1', { blockNumber: 8, lenses: ['A', 'L7'] }), row('0xs2', { blockNumber: 9, lenses: ['A'] })];
      const el = await dom();
      const cells = [...el.querySelectorAll('tbody tr')].map((tr) => tr.lastElementChild!);
      expect(cells[0]!.querySelector('[aria-label="Flagged by Blur 3-hop"]')).not.toBeNull();
      expect(cells[1]!.textContent).toBe('Not judged yet');
      expect(cells[1]!.querySelector('[aria-label="Not flagged"]')).toBeNull();
      // The built-ins judged it: their cells read as before.
      expect(el.querySelectorAll('tbody tr')[1]!.querySelector('[aria-label="Flagged by Round trips"]')).not.toBeNull();
    });

    it('takes a group\'s share of your lens over the trades it judged there, not every trade in the group', async () => {
      state.runs = [ownRun(7, 'Blur 3-hop', 'done', { throughBlock: 8 })];
      state.groups = [{ key: 'blur', trades: 4, caught: { A: 2, L7: 1 }, judged: { L7: 2 } } as never];
      const el = await dom({ by: 'marketplace' });
      const cells = [...el.querySelector('section[aria-label="Group by"] tbody tr')!.querySelectorAll('td')].map((td) => td.textContent);
      expect(cells).toEqual(['Blur', '4', '50%', '0%', '0%', '50%']);
    });

    it('says above Trades which lens of yours is behind, and why', async () => {
      state.runs = [ownRun(7, 'Blur 3-hop', 'done', { analysisId: 0 })];
      expect(await page()).toContain('Blur 3-hop shows figures from the run before the latest analysis, so trades after it are not judged by it yet.');
      state.runs = [{ ...ownRun(7, 'Blur 3-hop', 'queued', { totals: { available: true } }), lens: { ...ownRun(7, 'Blur 3-hop').lens, version: 2 } }];
      expect(await page()).toContain("Blur 3-hop shows figures from before its latest edit, so its flags are the old rule's until the new run saves.");
      state.runs = [ownRun(7, 'Blur 3-hop')];
      expect(await page()).not.toContain('shows figures from');
    });

    it('a not-flagged-by on a queued lens is left out and said by name', async () => {
      state.runs = [ownRun(7, 'Blur 3-hop', 'queued')];
      state.count = { total: 0, unjudged: 0 };
      expect(await page({ not: 'L7' })).toContain('Blur 3-hop has not run on this collection, so it flags nothing yet. It is left out of "not flagged by".');
    });

    it('a deleted lens in the URL is dropped: no chip, no failure, every trade listed', async () => {
      mine();
      const el = await dom({ caught: 'L99', not: 'L99', group: 'L99.t.5', sort: 'lens-L99' });
      expect(el.textContent).toContain('2 trades match');
      expect(el.querySelector('a[title="Remove this filter"]')).toBeNull();
      expect(state.calls.trades[0]![1]).toMatchObject({ caught: [], notCaught: [], group: null, sort: 'date' });
    });

    it('a sort on a lens of yours that did not run falls back to newest first', async () => {
      state.runs = [ownRun(7, 'Blur 3-hop', 'queued')];
      await dom({ sort: 'lens-L7' });
      expect(state.calls.trades[0]![1]).toMatchObject({ sort: 'date', dir: 'desc' });
    });

    it('the tokens list of your lens names it in the heading and the tab title', async () => {
      mine();
      const el = await flaggedDom({ kind: 'tokens', method: 'L7' });
      expect(el.textContent).toContain('Tokens flagged by Blur 3-hop');
      const { generateMetadata } = await import('@/app/c/[chain]/[address]/tokens/page');
      expect(el.textContent).toContain('Blur 3-hop · your lens');
      expect(await generateMetadata({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve({ method: 'L7' }) })).toEqual({ title: 'Tokens · Blur 3-hop · Coll' });
    });
  });
});

describe('the trades list on a phone', () => {
  /** Each trade's card and its table row, in the list's order. */
  async function both(sp: Record<string, string> = {}) {
    const el = await dom(sp);
    const cards = [...el.querySelectorAll('ul[aria-label="Trades"] > li')];
    const rows = [...el.querySelectorAll('table tbody tr')];
    return { el, cards, rows };
  }
  const sorted = (c: Element) => hrefs(c as HTMLElement, 'a').sort();

  it('draws the same trades as cards below sm, and the table from sm up', async () => {
    const { el, cards, rows } = await both({ caught: 'A' });
    expect(cards).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(el.querySelector('ul[aria-label="Trades"]')!.classList).toContain('sm:hidden');
    expect(el.querySelector('table')!.parentElement!.classList).toContain('hidden');
    expect(el.querySelector('table')!.parentElement!.classList).toContain('sm:block');
  });

  it('links each card to all its row links to: the trade with the same from, the token, the wallets, the only-this filters', async () => {
    const { cards, rows } = await both({ caught: 'A' });
    cards.forEach((card, i) => expect(sorted(card)).toEqual(sorted(rows[i]!)));
    const opens = hrefs(cards[1] as HTMLElement, 'a').filter((h) => h?.startsWith(`${BASE}/tx/0xs2`));
    // The date and the price both open the trade, as in the row.
    expect(opens).toHaveLength(2);
    expect(opens[0]).toMatch(/\?from=/);
    expect(opens[0]).toBe(hrefs(rows[1] as HTMLElement, 'a').find((h) => h?.startsWith(`${BASE}/tx/0xs2`)));
  });

  it('keeps the wallets\' hover cards: the seller and buyer are the row\'s own markup', async () => {
    const { cards, rows } = await both();
    const parties = (c: Element) => [...c.querySelectorAll('a')].filter((a) => a.getAttribute('title') === SELLER || a.getAttribute('title') === BUYER);
    cards.forEach((card, i) => {
      expect(parties(card)).toHaveLength(2);
      expect(parties(card).map((a) => a.parentElement!.outerHTML)).toEqual(parties(rows[i]!).map((a) => a.parentElement!.outerHTML));
    });
  });

  it('puts the token and date first, then the lenses that flagged it, then the facts the row has', async () => {
    const { cards } = await both();
    const card = cards[1]!;
    expect(card.firstElementChild!.textContent).toMatch(/^#7⊕/);
    expect(card.firstElementChild!.querySelector('time')).not.toBeNull();
    expect([...card.querySelectorAll('[role="img"]')].map((m) => m.getAttribute('aria-label'))).toEqual(['Flagged by Round trips', 'Flagged by Money loops back']);
    expect(card.textContent).toContain('1.5 ETH');
    expect(card.textContent).toContain('Blur');
    expect(card.textContent).toContain('Held 2 h · buyer age 3 d · 1.25× vs 7-day median');
  });

  it('says a trade no lens flagged is not flagged, and one no analysis covered is not judged yet', async () => {
    state.rows = [row('0xs1', { lenses: [] }), row('0xs2', { judged: false, lenses: [] })];
    const { cards } = await both();
    expect(cards[0]!.textContent).toContain('Not flagged');
    expect(cards[0]!.querySelector('[role="img"]')).toBeNull();
    expect(cards[1]!.textContent).toContain('Not judged yet');
  });

  it('says a trade past the block your lens\'s run read is not judged yet by it', async () => {
    state.runs = [ownRun(7, 'Blur 3-hop', 'done', { throughBlock: 8 })];
    state.rows = [row('0xs2', { blockNumber: 9, lenses: ['A'] })];
    const { cards } = await both();
    const later = cards[0]!.querySelector('[title^="Newer than the block Blur 3-hop"]');
    expect(later!.closest('.chip')!.textContent).toBe('Not judged yetBlur 3-hop');
  });
});
