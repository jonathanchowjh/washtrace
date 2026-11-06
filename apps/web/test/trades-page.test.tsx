import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseView } from '@/lib/trades';

const ADDR = '0x' + 'b'.repeat(40);
const SELLER = '0x' + '1'.repeat(40);
const BUYER = '0x' + '2'.repeat(40);
const BASE = `/c/1/${ADDR}`;

const row = (hash: string, over: Record<string, unknown> = {}) => ({
  txHash: hash, logIndex: 0, blockNumber: 5, blockTime: 1_680_000_000, tokenId: '7', from: SELLER, to: BUYER, marketplace: 'blur',
  priceWei: '1500000000000000000', currency: '', flags: {}, lenses: ['A'], judged: true, heldS: 7200, buyerAgeS: 86_400 * 3, floorRatio: 1.25, ...over,
});

const fresh = () => ({
  moneyRan: true, analysed: true, loops: undefined as object | null | undefined, rows: [row('0xs1'), row('0xs2', { lenses: ['A', 'AU'] })] as ReturnType<typeof row>[], count: { total: 2, unjudged: 0 },
  groups: [{ key: 'blur', trades: 3, caught: { A: 2, AU: 1 } }, { key: '-', trades: 1, caught: {} }],
  calls: { trades: [] as unknown[][], count: [] as unknown[][], groups: [] as unknown[][] },
});
const state = fresh();

vi.mock('@/lib/store', () => ({
  store: () => ({
    collection: async () => ({ id: 1, chainId: 1, address: ADDR, name: 'Coll', latest: !state.analysed ? null : { throughBlock: 10, loops: state.loops, totals: Object.fromEntries(['A', 'AU', 'AC'].map((m) => [m, { available: m === 'A' || state.moneyRan, tokens: 0, wallets: 0 }])) } }),
    trades: async (...a: unknown[]) => { state.calls.trades.push(a); return state.rows; },
    tradeCount: async (...a: unknown[]) => { state.calls.count.push(a); return state.count; },
    tradeGroups: async (...a: unknown[]) => { state.calls.groups.push(a); return state.groups; },
  }),
}));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); }, useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => { cleanup(); Object.assign(state, fresh()); });

async function dom(sp: Record<string, string | string[]> = {}): Promise<HTMLElement> {
  const { default: Flagged } = await import('@/app/c/[chain]/[address]/flagged/page');
  return render(await Flagged({ params: Promise.resolve({ chain: '1', address: ADDR }), searchParams: Promise.resolve(sp) })).container;
}
async function page(sp: Record<string, string | string[]> = {}): Promise<string> { return (await dom(sp)).textContent ?? ''; }
// The DOM's selector engine reads `?` and `&` in an attribute value badly, so links are found by comparing the attribute.
const linkTo = (c: HTMLElement, href: string) => [...c.querySelectorAll('a')].find((a) => a.getAttribute('href') === href);
const hrefs = (c: HTMLElement, sel: string) => [...c.querySelectorAll(sel)].map((a) => a.getAttribute('href'));

describe('the flagged page, Trades view', () => {
  it('shows matching trades with a dot per lens that ran, named by lens, and the date opens the trade', async () => {
    const el = await dom({ kind: 'trades', caught: 'A' });
    expect(el.textContent).toContain('2 trades match');
    expect([...el.querySelectorAll('th')].map((t) => t.textContent)).toEqual(expect.arrayContaining(['Round trips', 'Money loops back (not counted)', 'Linked wallets']));
    expect(el.querySelector('a[href="/tx/1/0xs2"]')).not.toBeNull();
    expect(el.textContent).not.toMatch(/\bAU\b|\bAC\b/);
  });

  it('reads trades, their count and their groups with the lenses that ran, money and the reader zone', async () => {
    state.moneyRan = false;
    await dom({ kind: 'trades', by: 'marketplace' });
    const [id, q, ctx, limit, offset] = state.calls.trades[0]!;
    expect(id).toBe(1);
    expect((q as { kind: string }).kind).toBe('sales');
    expect(ctx).toMatchObject({ ran: ['A'], zone: 'UTC' });
    expect((ctx as { money: Set<string> }).money.has('')).toBe(true);
    expect([limit, offset]).toEqual([50, 0]);
    expect(state.calls.count[0]![2]).toBe(ctx);
    expect(state.calls.groups[0]![2]).toBe('marketplace');
    expect(state.calls.groups[0]![3]).toMatchObject({ ran: ['A'] });
  });

  it('draws only the lenses that ran', async () => {
    state.moneyRan = false;
    const th = [...(await dom({ kind: 'trades' })).querySelectorAll('thead th')].map((t) => t.textContent);
    expect(th).toContain('Round trips');
    expect(th).not.toContain('Linked wallets');
    expect(th.join()).not.toContain('Money loops back');
  });

  it('a caught filter on a lens that did not run says so, and reads no rows', async () => {
    state.moneyRan = false;
    expect(await page({ kind: 'trades', caught: 'AU' })).toContain('Money loops back did not run on this collection, so it catches nothing yet.');
    expect(state.calls.trades).toHaveLength(0);
  });

  it('says how many matching trades are newer than the latest analysis, and shows them as not judged', async () => {
    Object.assign(state, { count: { total: 3, unjudged: 1 }, rows: [row('0xs1'), row('0xs2', { judged: false, lenses: [] })] });
    const el = await dom({ kind: 'trades' });
    expect(el.textContent).toContain('3 trades match');
    expect(el.textContent).toContain(' 1 of them are newer than the latest analysis and not judged yet.');
    const cell = [...el.querySelectorAll('td')].find((td) => td.textContent === 'not judged yet');
    expect(cell?.getAttribute('colspan')).toBe('3');
  });

  it('a not-caught lens that did not run is left out and said', async () => {
    state.moneyRan = false;
    expect(await page({ kind: 'trades', not: 'AC' })).toContain('Linked wallets did not run, so "not caught by" it is left out.');
  });

  it('each chip removes its own filter and keeps the grouping; each group row and share cell adds its group', async () => {
    const el = await dom({ kind: 'trades', caught: 'A', by: 'marketplace' });
    expect(linkTo(el, `${BASE}/flagged?kind=trades&by=marketplace`)?.textContent).toContain('Caught by Round trips');
    const blur = el.querySelector('a[href*="market=blur"][href*="by=marketplace"]');
    expect(blur?.closest('tr')?.textContent).toContain('Blur');
    // Count and share agree: the share adds only the lens.
    const links = hrefs(blur!.closest('tr')!, 'a');
    expect(links).toContain(`${BASE}/flagged?kind=trades&caught=A&market=blur&by=marketplace`);
    expect(links).toContain(`${BASE}/flagged?kind=trades&caught=AU&market=blur&by=marketplace`);
    expect(blur!.closest('tr')!.textContent).toContain('67%');
  });

  it('the unknown group has no links and says what it is; the Money loops back column says it is not counted', async () => {
    const el = await dom({ kind: 'trades', by: 'marketplace' });
    const unknown = [...el.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('Not a marketplace sale'));
    expect(unknown).toBeDefined();
    expect(unknown!.querySelectorAll('a')).toHaveLength(0);
    expect([...el.querySelectorAll('th')].filter((t) => t.textContent === 'Money loops back (not counted)').length).toBe(2);
  });

  it('a lens that did not run shows did not run in a group row', async () => {
    state.moneyRan = false;
    const el = await dom({ kind: 'trades', by: 'marketplace' });
    const blur = [...el.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('Blur') && r.textContent.includes('did not run'));
    expect(blur).toBeDefined();
  });

  it('the Find box keeps the other filters, and an unreadable find says what it takes', async () => {
    const el = await dom({ kind: 'trades', caught: 'A', market: 'blur', by: 'month' });
    const form = el.querySelector('form[role=search]')!;
    expect((form.querySelector('input[name=q]') as HTMLInputElement).placeholder).toBe('Token number, wallet or tx');
    const kept = Object.fromEntries([...form.querySelectorAll('input[type=hidden]')].map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value]));
    expect(kept).toEqual({ kind: 'trades', caught: 'A', market: 'blur', by: 'month' });
    cleanup();
    state.calls.trades.length = 0;
    expect(await page({ kind: 'trades', q: 'hello' })).toContain('“hello” is not a token number, wallet address or transaction hash.');
    expect(state.calls.trades).toHaveLength(0);
    cleanup();
    await dom({ kind: 'trades', q: '12' });
    expect(state.calls.trades).toHaveLength(1);
  });

  it('the filter form is plain fields, prefilled from the query, with no client component and no page', async () => {
    const el = await dom({ kind: 'trades', caught: 'A', pmin: '0.5', heldunder: '90m', ageover_n: '2', ageover_u: 'd', from_day: '2023-03-01', market: 'blur', wallet: SELLER, sort: 'price', page: '2' });
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
    expect(singles).toEqual(expect.arrayContaining(['kind', 'wallet', 'sort']));
    expect(form.getAttribute('method')).toBe('get');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('apps/web/components/trades.tsx', 'utf8')).not.toMatch(/use client|trade-fields/);
  });

  it('a row with no block time still opens its trade, and the count line comes before the groups', async () => {
    state.rows = [row('0xs1', { blockTime: null })];
    const el = await dom({ kind: 'trades', by: 'marketplace' });
    expect(linkTo(el, '/tx/1/0xs1')?.textContent).toBe('Unknown time');
    const text = el.textContent!;
    expect(text.indexOf('trades match')).toBeLessThan(text.indexOf('Not a marketplace sale'));
  });

  it('with no match, still says a not-caught lens did not run', async () => {
    Object.assign(state, { moneyRan: false, count: { total: 0, unjudged: 0 }, rows: [] });
    const text = await page({ kind: 'trades', not: 'AC' });
    expect(text).toContain('No trade matches these filters.');
    expect(text).toContain('Linked wallets did not run, so "not caught by" it is left out.');
  });

  it('every header sorts and toggles the direction; a lens column sorts by the lens', async () => {
    const el = await dom({ kind: 'trades', sort: 'price', dir: 'asc' });
    const link = (name: string) => [...el.querySelectorAll('thead th a')].find((a) => a.textContent === name)?.getAttribute('href');
    expect(link('Price')).toBe(`${BASE}/flagged?kind=trades&sort=price`);
    expect(link('Round trips')).toBe(`${BASE}/flagged?kind=trades&sort=lens-A`);
    expect(link('Seller → Buyer')).toContain('sort=seller');
    expect(link('Date')).toBe(`${BASE}/flagged?kind=trades`);
  });

  it('a wallet and a token each have a link that narrows the view to them', async () => {
    const el = await dom({ kind: 'trades', caught: 'A' });
    expect(linkTo(el, `${BASE}/flagged?kind=trades&caught=A&wallet=${SELLER}`)?.title).toBe('Only trades with this wallet');
    expect(linkTo(el, `${BASE}/flagged?kind=trades&caught=A&token=7`)?.title).toBe('Only trades with this token');
    expect(linkTo(el, `${BASE}/t/7`)).toBeDefined();
  });

  it('a page past the last shows the last page', async () => {
    state.count = { total: 120, unjudged: 0 };
    const el = await dom({ kind: 'trades', page: '99999' });
    expect(el.textContent).toContain('Page');
    expect(el.textContent).toContain('101–120 of 120 trades');
    expect(state.calls.trades[0]!.slice(3)).toEqual([50, 100]);
  });

  it('junk in the URL is dropped and shows the unfiltered list', async () => {
    const el = await dom({ kind: 'trades', caught: 'ZZ', pmin: 'abc', page: '-2', by: 'nope' });
    expect(el.textContent).toContain('2 trades match');
    expect(el.querySelectorAll('a[title="Remove this filter"]')).toHaveLength(0);
  });

  it('no match says so, with the chips still shown', async () => {
    Object.assign(state, { count: { total: 0, unjudged: 0 }, rows: [] });
    const el = await dom({ kind: 'trades', market: 'x2y2' });
    expect(el.textContent).toContain('No trade matches these filters.');
    expect(el.textContent).toContain('Marketplace: X2Y2');
  });

  it('Download CSV links to the export with the same filters, without the page or grouping', async () => {
    const el = await dom({ kind: 'trades', caught: 'A', by: 'month', page: '2' });
    const a = [...el.querySelectorAll('a')].find((x) => x.textContent === 'Download CSV ↓');
    expect(a?.getAttribute('href')).toBe(`/api/collections/1/${ADDR}/trades?format=csv&caught=A`);
  });

  it('the Tokens and Wallets tabs carry the first caught lens; a lens link replaces the caught filter', async () => {
    const el = await dom({ kind: 'trades', caught: 'AC,A' });
    const tab = (name: string) => [...el.querySelectorAll('nav[aria-label=Show] a')].find((a) => a.textContent === name)?.getAttribute('href');
    expect(tab('Tokens')).toBe(`${BASE}/flagged?method=A&kind=tokens`);
    expect(tab('Wallets')).toBe(`${BASE}/flagged?method=A&kind=wallets`);
    const lens = [...el.querySelectorAll('nav[aria-label=Lens] a')].find((a) => a.textContent === 'Linked wallets');
    expect(lens?.getAttribute('href')).toBe(`${BASE}/flagged?kind=trades&caught=AC`);
  });
  it.each([
    ['marketplace', 'Not a marketplace sale'],
    ['month', 'No block time'],
    ['held', "Not judged yet, its token's first transfer, or no block time"],
    ['buyerAge', 'Not judged yet, or no block time'],
    ['floor', 'Unpriced, not in ETH, WETH or Blur Pool, no priced sale in the 7 days before, no block time, or not judged yet'],
  ])('the unknown %s group says why its trades have no value there', async (by, label) => {
    const el = await dom({ kind: 'trades', by });
    const rows = [...el.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent);
    expect(rows).toContain(label);
  });

  it('a hold or a buyer age under a minute reads <1 min', async () => {
    state.rows = [row('0xs1', { heldS: 30, buyerAgeS: 0 })];
    const cells = [...(await dom({ kind: 'trades' })).querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells.filter((t) => t === '<1 min')).toHaveLength(2);
    expect(cells).not.toContain('1 min');
  });

  it('with no lens run, an unjudged row has as many cells as the header', async () => {
    Object.assign(state, { analysed: false, count: { total: 1, unjudged: 1 }, rows: [row('0xs1', { judged: false, lenses: [] })] });
    const el = await dom({ kind: 'trades' });
    const head = el.querySelectorAll('table thead th').length;
    expect(el.querySelector('table tbody tr')!.children).toHaveLength(head);
  });

  it('an hour-period view keeps its hour bounds when a new filter is added', async () => {
    const from = '2023-03-01T05:00Z', to = '2023-03-01T06:00Z';
    const el = await dom({ kind: 'trades', from, to });
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
    const { q } = parseView(sent, 'UTC');
    expect([q.fromMs, q.toMs]).toEqual([Date.parse(from), Date.parse(to)]);
    expect(q.venues).toEqual(['blur']);
  });

  it('a kept hour bound disables its day field and says how to change it', async () => {
    const el = await dom({ kind: 'trades', from: '2023-03-01T05:00Z' });
    const form = el.querySelector('form[aria-label="Filter trades"]')!;
    expect((form.querySelector('input[name=from_day]') as HTMLInputElement).disabled).toBe(true);
    expect((form.querySelector('input[name=to_day]') as HTMLInputElement).disabled).toBe(false);
    expect(form.textContent).toContain('remove the date chip to change it.');
  });

  it('a trade row opens its trade on the price; its hold, buyer age and floor are plain measures', async () => {
    state.rows = [row('0xs1')];
    const el = await dom({ kind: 'trades' });
    const cells = [...el.querySelectorAll('tbody td[data-measure]')];
    expect(cells.map((td) => td.textContent)).toEqual(['2 h', '3 d', '1.25×']);
    expect(cells.every((td) => td.querySelector('a') === null)).toBe(true);
    expect([...el.querySelectorAll('tbody a')].find((a) => a.textContent === '1.5 ETH')?.getAttribute('href')).toBe('/tx/1/0xs1');
  });

  it('a midnight bound goes back as a day field, not a hidden one', async () => {
    const el = await dom({ kind: 'trades', from: '2023-03-01' });
    const form = el.querySelector('form[aria-label="Filter trades"]')!;
    expect(form.querySelector('input[type=hidden][name=from]')).toBeNull();
    expect((form.querySelector('input[name=from_day]') as HTMLInputElement).value).toBe('2023-03-01');
  });

  it('a group on a lens that did not run says so, and reads no rows', async () => {
    state.moneyRan = false;
    const text = await page({ kind: 'trades', group: `AU.t.7` });
    expect(text).toContain('Money loops back did not run on this collection, so it catches nothing yet.');
    expect(text).not.toContain('No trade matches');
    expect(state.calls.trades).toHaveLength(0);
  });

  it('a sort on a lens that did not run says nothing and falls back to newest first', async () => {
    state.moneyRan = false;
    const el = await dom({ kind: 'trades', sort: 'lens-AU' });
    expect(el.textContent).toContain('2 trades match');
    expect(el.textContent).not.toContain('did not run');
    expect((state.calls.trades[0]![1] as { sort: string }).sort).toBe('date');
    expect([...el.querySelectorAll('thead th')].find((t) => t.textContent === 'Date')?.getAttribute('aria-sort')).toBe('descending');
  });

  it('every change of owner says so in its sub line', async () => {
    expect(await page({ kind: 'trades', all: '1' })).toContain('Every change of owner, filtered by what you ask');
    cleanup();
    expect(await page({ kind: 'trades' })).toContain('Every sale, filtered by what you ask');
  });

  it('an analysis that predates the figures says the collection is queued again, not that its trades are newer', async () => {
    Object.assign(state, { loops: null, count: { total: 2, unjudged: 2 } });
    const text = await page({ kind: 'trades' });
    expect(text).toContain('The latest analysis predates these figures; this collection is queued to be analysed again.');
    expect(text).not.toContain('newer than the latest analysis');
  });

  it('a collection never analysed says so in the count line', async () => {
    Object.assign(state, { analysed: false, count: { total: 2, unjudged: 2 } });
    const text = await page({ kind: 'trades' });
    expect(text).toContain('2 trades match · everything is in the address bar, so this view can be shared. Not analysed yet.');
    expect(text).not.toContain('newer than the latest analysis');
  });
});
