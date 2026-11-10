import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionNav, lensOf, tabOf } from '@/components/collection-nav';
import { listHref } from '@/lib/links';

const BASE = `/c/1/0x${'b'.repeat(40)}`;
const at = { path: BASE, search: '' };
const LENSES = ['A', 'AU', 'AC', 'L7'];
vi.mock('next/navigation', () => ({ usePathname: () => at.path, useSearchParams: () => new URLSearchParams(at.search) }));

afterEach(() => { cleanup(); Object.assign(at, { path: BASE, search: '' }); });

function nav(path: string, search = '', counts = {}) {
  Object.assign(at, { path, search });
  const el = render(<CollectionNav base={BASE} name="Coll" analysedAt={null} lenses={LENSES} counts={counts} />).container;
  const tab = (label: string) => [...el.querySelectorAll('nav a')].find((a) => a.textContent?.startsWith(label))!;
  return { el, tab };
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
    // A caught filter means nothing off Trades.
    expect(of('caught=A', 'tokens')).toBeNull();
    const { tab } = nav(`${BASE}/trades`, 'caught=AC,A');
    expect(tab('Tokens').getAttribute('href')).toBe(`${BASE}/tokens?method=A`);
    expect(tab('Wallets').getAttribute('href')).toBe(`${BASE}/wallets?method=A`);
  });

  it('carries no lens that is not one: the overview\'s Compare tab, a deleted lens, junk', () => {
    const of = (q: string, tab: Parameters<typeof lensOf>[1]) => lensOf(new URLSearchParams(q), tab, LENSES);
    expect([of('method=compare', 'overview'), of('method=L9', 'tokens'), of('caught=L9,nope', 'trades')]).toEqual([null, null, null]);
    // So the default lens's counts stay, as its list is what the tabs open.
    const { tab } = nav(BASE, 'method=compare', { tokens: <b>6</b> });
    expect(tab('Tokens').textContent).toBe('Tokens6');
    expect(tab('Tokens').getAttribute('href')).toBe(`${BASE}/tokens`);
  });

  it('drops a list\'s order and Find on the way to another tab', () => {
    const { tab } = nav(`${BASE}/tokens`, 'method=A&sort=share&q=7');
    expect(tab('Wallets').getAttribute('href')).toBe(`${BASE}/wallets?method=A`);
    expect(tab('Trades').getAttribute('href')).toBe(`${BASE}/trades`);
    expect(tab('Overview').getAttribute('href')).toBe(BASE);
  });

  it('shows the default lens\'s counts only while that lens is in view; the trades count always', () => {
    const counts = { rings: <b>6</b>, tokens: <b>6</b>, wallets: <b>13</b>, trades: <b>56</b> };
    const plain = nav(BASE, '', counts);
    expect(['Rings', 'Tokens', 'Wallets', 'Trades'].map((t) => plain.tab(t).textContent)).toEqual(['Rings6', 'Tokens6', 'Wallets13', 'Trades56']);
    cleanup();
    // Rings are no lens's list: their count stands whatever lens is chosen.
    const other = nav(`${BASE}/tokens`, 'method=A', counts);
    expect(['Rings', 'Tokens', 'Wallets', 'Trades'].map((t) => other.tab(t).textContent)).toEqual(['Rings6', 'Tokens', 'Wallets', 'Trades56']);
  });

  it('on the Methods page, lights Overview, which it is under, and says Methods in the parent line', () => {
    const { el, tab } = nav(`${BASE}/methods`);
    expect(tab('Overview').getAttribute('aria-current')).toBe('page');
    expect(el.querySelector('p')!.textContent).toContain('Coll›Methods');
    cleanup();
    expect(nav(`${BASE}/t/14`).el.querySelector('p')!.textContent).not.toContain('Methods');
  });

  it('names the collection it belongs to, linked to its overview', () => {
    const { el } = nav(`${BASE}/t/14`);
    const up = [...el.querySelectorAll('p a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(up).toEqual([['Collections', '/'], ['Coll', BASE]]);
  });
});

describe('a list link', () => {
  it('always names its lens and leaves the defaults out', () => {
    expect(listHref(BASE, 'tokens', { method: 'AC' })).toBe(`${BASE}/tokens?method=AC`);
    expect(listHref(BASE, 'wallets', { method: 'L7', sort: 'caught', q: null, page: 1 })).toBe(`${BASE}/wallets?method=L7`);
    expect(listHref(BASE, 'tokens', { method: 'A', sort: 'share', q: '1 2', page: 3 })).toBe(`${BASE}/tokens?method=A&sort=share&q=1%202&page=3`);
  });
});
