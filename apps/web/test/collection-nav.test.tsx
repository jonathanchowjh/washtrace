import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionNav, lensOf, revealTab, tabOf } from '@/components/collection-nav';
import { caughtLens } from '@/lib/params';
import { listHref } from '@/lib/links';

const BASE = `/c/1/0x${'b'.repeat(40)}`;
const at = { path: BASE, search: '' };
const LENSES = ['A', 'AU', 'AC', 'L7'];
vi.mock('next/navigation', () => ({ usePathname: () => at.path, useSearchParams: () => new URLSearchParams(at.search) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.assign(at, { path: BASE, search: '' }); });

/** Each lens's counts URL, as the layout makes them; `n` makes each one unique to a test, as the shared answers are kept a page. */
const srcs = (n: string) => Object.fromEntries(LENSES.map((m) => [m, `/counts?method=${m}&t=${n}`]));

function nav(path: string, search = '', o: { counts?: Record<string, string>; rings?: number | null } = {}) {
  Object.assign(at, { path, search });
  const el = render(<CollectionNav base={BASE} name="Coll" analyzedAt={null} lenses={LENSES} opensOn="AC" counts={o.counts ?? {}} rings={o.rings ?? null} />).container;
  const tab = (label: string) => [...el.querySelectorAll('nav a')].find((a) => a.textContent?.startsWith(label))!;
  return { el, tab };
}

/** The counts route, answering each lens's counts; a lens set to null has not run. */
function answering(by: Record<string, { tokens: number | null; wallets: number | null }>) {
  const fetchMock = vi.fn(async (src: string) => {
    const m = new URL(src, 'http://x').searchParams.get('method')!;
    return { ok: true, json: async () => ({ trades: 56, ...by[m] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the collection tab bar', () => {
  it('lights the list a page belongs to, a thing from it included', () => {
    expect(tabOf(BASE, BASE)).toBe('overview');
    expect(tabOf(BASE, `${BASE}/tokens`)).toBe('tokens');
    expect(tabOf(BASE, `${BASE}/t/14`)).toBe('tokens');
    expect(tabOf(BASE, `${BASE}/wallets`)).toBe('wallets');
    expect(tabOf(BASE, `${BASE}/trades`)).toBe('trades');
    expect(tabOf(BASE, `${BASE}/rings`)).toBe('rings');
    expect(tabOf(BASE, `${BASE}/r/0xabc`)).toBe('rings');
    // The old flagged page only redirects; it lights nothing of its own.
    expect(tabOf(BASE, `${BASE}/flagged`)).toBe('overview');
  });

  it('marks the lit tab as the current page, and only it', () => {
    const { el, tab } = nav(`${BASE}/t/14`);
    expect(tab('Tokens').getAttribute('aria-current')).toBe('page');
    expect(el.querySelectorAll('[aria-current]')).toHaveLength(1);
  });

  it('carries the chosen lens to Tokens and Wallets, and on Trades the first lens it is filtered by, a built-in first', () => {
    const of = (q: string, tab: Parameters<typeof lensOf>[1]) => lensOf(new URLSearchParams(q), tab, LENSES);
    expect(of('method=A', 'overview')).toBe('A');
    expect(of('caught=L7,AC,A', 'trades')).toBe('A');
    expect(of('caught=L7', 'trades')).toBe('L7');
    // Floor, ceiling, then not counted: the order every page names them in, not the engine's.
    expect(of('caught=AU,AC', 'trades')).toBe('AC');
    expect(caughtLens(['AU', 'AC'])).toBe('AC');
    expect(caughtLens(['L7', 'AU'])).toBe('AU');
    expect(caughtLens([])).toBeUndefined();
    // A caught filter means nothing off Trades.
    expect(of('caught=A', 'tokens')).toBeNull();
    const { tab } = nav(`${BASE}/trades`, 'caught=AC,A');
    expect(tab('Tokens').getAttribute('href')).toBe(`${BASE}/tokens?method=A`);
    expect(tab('Wallets').getAttribute('href')).toBe(`${BASE}/wallets?method=A`);
  });

  it('carries no lens that is not one: the overview\'s Compare tab, a deleted lens, junk', async () => {
    const of = (q: string, tab: Parameters<typeof lensOf>[1]) => lensOf(new URLSearchParams(q), tab, LENSES);
    expect([of('method=compare', 'overview'), of('method=L9', 'tokens'), of('caught=L9,nope', 'trades')]).toEqual([null, null, null]);
    // So the default lens's counts stay, as its list is what the tabs open.
    const fetchMock = answering({ AC: { tokens: 6, wallets: 13 } });
    const { tab } = nav(BASE, 'method=compare', { counts: srcs('compare') });
    await waitFor(() => expect(tab('Tokens').textContent).toBe('Tokens6'));
    expect(fetchMock.mock.calls[0]![0]).toBe('/counts?method=AC&t=compare');
    expect(tab('Tokens').getAttribute('href')).toBe(`${BASE}/tokens`);
  });

  it('drops a list\'s order and Find on the way to another tab', () => {
    const { tab } = nav(`${BASE}/tokens`, 'method=A&sort=share&q=7');
    expect(tab('Wallets').getAttribute('href')).toBe(`${BASE}/wallets?method=A`);
    expect(tab('Trades').getAttribute('href')).toBe(`${BASE}/trades`);
    expect(tab('Overview').getAttribute('href')).toBe(BASE);
  });

  it('counts the lists of the lens in view, so the bar keeps its shape as the lens changes; rings and trades whatever the lens', async () => {
    const fetchMock = answering({ AC: { tokens: 6, wallets: 13 }, A: { tokens: 2, wallets: 5 }, AU: { tokens: 4, wallets: 9 } });
    const counted = (n: ReturnType<typeof nav>) => ['Rings', 'Tokens', 'Wallets', 'Trades'].map((t) => n.tab(t).textContent);
    const plain = nav(BASE, '', { counts: srcs('shape'), rings: 6 });
    await waitFor(() => expect(counted(plain)).toEqual(['Rings6', 'Tokens6', 'Wallets13', 'Trades56']));
    cleanup();
    const other = nav(`${BASE}/tokens`, 'method=A', { counts: srcs('shape'), rings: 6 });
    await waitFor(() => expect(counted(other)).toEqual(['Rings6', 'Tokens2', 'Wallets5', 'Trades56']));
    cleanup();
    // On Trades, the lens its filter holds: the one the Tokens and Wallets tabs open.
    const trades = nav(`${BASE}/trades`, 'caught=AU', { counts: srcs('shape'), rings: 6 });
    await waitFor(() => expect(counted(trades)).toEqual(['Rings6', 'Tokens4', 'Wallets9', 'Trades56']));
    // One read a lens, however many tabs show its counts.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/counts?method=AC&t=shape', '/counts?method=A&t=shape', '/counts?method=AU&t=shape']);
  });

  it('says a lens has not run where its counts would be, rather than leaving the tabs bare', async () => {
    answering({ L7: { tokens: null, wallets: null } });
    const { tab } = nav(`${BASE}/wallets`, 'method=L7', { counts: srcs('unrun') });
    await waitFor(() => expect(tab('Tokens').textContent).toBe('Tokensnot run'));
    expect(tab('Wallets').textContent).toBe('Walletsnot run');
    expect(tab('Trades').textContent).toBe('Trades56');
  });

  it('shows no count it could not read', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const { tab } = nav(BASE, '', { counts: srcs('down') });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(['Tokens', 'Wallets', 'Trades'].map((t) => tab(t).textContent)).toEqual(['Tokens', 'Wallets', 'Trades']);
  });

  it('forgets a read that failed, so the next page asks again and shows the counts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const first = nav(BASE, '', { counts: srcs('retry') });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(first.tab('Tokens').textContent).toBe('Tokens');
    cleanup();
    const fetchMock = answering({ AC: { tokens: 6, wallets: 13 } });
    const { tab } = nav(BASE, '', { counts: srcs('retry') });
    await waitFor(() => expect(tab('Tokens').textContent).toBe('Tokens6'));
    expect(fetchMock).toHaveBeenCalledWith('/counts?method=AC&t=retry');
  });

  it('keeps one answer per lens: a newer analysis\'s read replaces the older one rather than piling up', async () => {
    const fetchMock = answering({ AC: { tokens: 6, wallets: 13 } });
    const page = (src: string) => { const { tab } = nav(BASE, '', { counts: { AC: src } }); return tab; };
    for (const src of ['/counts?method=AC&t=old', '/counts?method=AC&t=new', '/counts?method=AC&t=old']) {
      const tab = page(src);
      await waitFor(() => expect(tab('Tokens').textContent).toBe('Tokens6'));
      cleanup();
    }
    // The old answer was dropped when the new one came, so going back to it reads again.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/counts?method=AC&t=old', '/counts?method=AC&t=new', '/counts?method=AC&t=old']);
  });

  it('lights Methods on the Methods page, a tab of its own beside the lists, and carries the chosen lens there', () => {
    const { el, tab } = nav(`${BASE}/methods`, 'method=A');
    expect(tab('Methods').getAttribute('aria-current')).toBe('page');
    expect(el.querySelectorAll('[aria-current]')).toHaveLength(1);
    expect([...el.querySelectorAll('nav a')].map((x) => x.textContent?.replace(/\d+$/, ''))).toEqual(['Overview', 'Methods', 'Rings', 'Tokens', 'Wallets', 'Trades']);
    expect(tab('Methods').getAttribute('href')).toBe(`${BASE}/methods?method=A`);
    cleanup();
    expect(nav(BASE).tab('Methods').getAttribute('href')).toBe(`${BASE}/methods`);
  });

  it('says when it was analyzed, spelled as Collections and Worker spell it', () => {
    Object.assign(at, { path: BASE, search: '' });
    const el = render(<CollectionNav base={BASE} name="Coll" analyzedAt={1_700_000_000_000} lenses={LENSES} opensOn="AC" counts={{}} rings={null} />).container;
    expect(el.querySelector('p')!.textContent).toMatch(/· analyzed /);
  });

  it('ends its parent line in a plain-text leaf naming the item page: a token, a wallet, a trade, a ring', () => {
    const leaf = (path: string) => nav(path).el.querySelector('p')!.textContent;
    expect(leaf(`${BASE}/t/14`)).toMatch(/^Collections\/Coll\/#14$/);
    expect(leaf(`${BASE}/w/0x${'a'.repeat(40)}`)).toMatch(/^Collections\/Coll\/0xaaaa…aaaa$/);
    expect(leaf(`${BASE}/tx/0x${'c'.repeat(64)}`)).toMatch(/^Collections\/Coll\/0xcccc…cccc$/);
    expect(leaf(`${BASE}/r/0x28ed${'0'.repeat(36)}`)).toMatch(/^Collections\/Coll\/Ring 0x28ed…$/);
    // The leaf is not a link, and a list or overview page has none.
    expect(nav(`${BASE}/t/14`).el.querySelectorAll('p a')).toHaveLength(2);
    expect(leaf(`${BASE}/tokens`)).toBe('Collections/Coll');
    expect(leaf(BASE)).toBe('Collections/Coll');
  });

  it('wraps its tabs below md, with no edge fades', () => {
    const { el } = nav(BASE);
    expect(el.querySelector('nav')!.className).toContain('max-md:flex-wrap');
    for (const f of el.querySelectorAll('[data-more]')) expect(f.className).toContain('max-md:hidden');
  });

  it('names the collection it belongs to, linked to its overview', () => {
    const { el } = nav(`${BASE}/t/14`);
    const up = [...el.querySelectorAll('p a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(up).toEqual([['Collections', '/'], ['Coll', BASE]]);
  });
});

// jsdom lays nothing out: each tab is given a box 100px wide, side by side in
// TABS' order, inside a bar 250px wide, so only two and a half of its 600px show.
function laidOut() {
  const left = (el: HTMLElement) => (el.tagName === 'A' ? [...el.parentElement!.children].indexOf(el) * 100 : 0);
  const width = (el: HTMLElement) => (el.tagName === 'NAV' ? 250 : 100);
  const scrollWidth = (el: HTMLElement) => (el.tagName === 'NAV' ? 600 : 100);
  const sizes: Record<string, (el: HTMLElement) => number> = { offsetLeft: left, offsetWidth: width, clientWidth: width, scrollWidth };
  const own = Object.keys(sizes).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);
  for (const [k, size] of Object.entries(sizes)) {
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get(this: HTMLElement) { return size(this); } });
  }
  return () => {
    for (const [k, d] of own) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
    }
  };
}

describe('the lit tab on a narrow screen', () => {
  it('scrolls the bar sideways so the lit tab shows, on mount and when it changes', () => {
    const restore = laidOut();
    try {
      at.path = `${BASE}/trades`;
      const page = () => <CollectionNav base={BASE} name="Coll" analyzedAt={null} lenses={LENSES} opensOn="AC" counts={{}} rings={null} />;
      const { container, rerender } = render(page());
      const bar = container.querySelector('nav')!;
      // Trades sits at 500-600px: the bar scrolls until its right edge shows, and no further than its end.
      expect(bar.scrollLeft).toBe(350);
      // Off to Overview, at 0-100px: the bar scrolls back to show it.
      at.path = BASE;
      rerender(page());
      expect(bar.querySelector('[aria-current]')!.textContent).toBe('Overview');
      expect(bar.scrollLeft).toBe(0);
      // Tokens, at 300-400px, is scrolled clear of the right edge's 32px fade.
      at.path = `${BASE}/tokens`;
      rerender(page());
      expect(bar.scrollLeft).toBe(182);
    } finally {
      restore();
    }
  });

  it('fades each edge while tabs are past it, so a cut tab says the bar scrolls', () => {
    const restore = laidOut();
    try {
      const { el } = nav(BASE);
      const bar = el.querySelector('nav')!;
      const fades = () => [...el.querySelectorAll<HTMLElement>('[data-more]')].filter((f) => !f.hidden).map((f) => f.dataset.more);
      // At the start, more lies to the right only.
      expect(fades()).toEqual(['right']);
      act(() => { bar.scrollLeft = 100; bar.dispatchEvent(new Event('scroll')); });
      expect(fades()).toEqual(['left', 'right']);
      act(() => { bar.scrollLeft = 350; bar.dispatchEvent(new Event('scroll')); });
      expect(fades()).toEqual(['left']);
    } finally {
      restore();
    }
  });

  it('moves the bar no further than it must, and not at all for a tab already in view', () => {
    const restore = laidOut();
    try {
      const { el, tab } = nav(BASE);
      const bar = el.querySelector('nav')!;
      expect(bar.scrollLeft).toBe(0);
      // Scrolled past Rings, at 200-300px, the bar comes back just to its left edge;
      // Tokens, then in view, moves nothing.
      bar.scrollLeft = 400;
      revealTab(bar, tab('Rings') as HTMLElement);
      expect(bar.scrollLeft).toBe(200);
      revealTab(bar, tab('Tokens') as HTMLElement);
      expect(bar.scrollLeft).toBe(200);
    } finally {
      restore();
    }
  });
});

describe('a list link', () => {
  it('always names its lens and leaves the defaults out', () => {
    expect(listHref(BASE, 'tokens', { method: 'AC' })).toBe(`${BASE}/tokens?method=AC`);
    expect(listHref(BASE, 'wallets', { method: 'L7', sort: 'caught', q: null, page: 1 })).toBe(`${BASE}/wallets?method=L7`);
    expect(listHref(BASE, 'tokens', { method: 'A', sort: 'share', q: '1 2', page: 3 })).toBe(`${BASE}/tokens?method=A&sort=share&q=1%202&page=3`);
  });
});
