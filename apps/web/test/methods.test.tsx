import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MethodTotals } from '@washtrace/detect';
import { History, LensStats } from '@/components/methods';
import { tradesHref } from '@/lib/trades-url';

afterEach(cleanup);

const BASE = `/c/1/0x${'b'.repeat(40)}`;
const t = (over: Partial<MethodTotals> = {}): MethodTotals => ({
  transfers: 5000, flagged: 400, sales: 1000, flaggedSales: 41, volumeWei: String(19_032n * 10n ** 18n), flaggedVolumeWei: String(8124n * 10n ** 17n),
  wallets: 1207, tokens: 644, available: true, ...over,
} as MethodTotals);

const draw = (m: 'A' | 'AU' | 'AC', totals: MethodTotals, loops: { loops: number; pairs: number } | null = null, qualifier: 'at least' | 'so far' | null = null) =>
  render(<LensStats m={m} t={totals} loops={loops} base={BASE} qualifier={qualifier} />).container;
const named = (c: Element, text: string) => [...c.querySelectorAll('a')].filter((a) => a.textContent === text).map((a) => a.getAttribute('href'));

describe('the lens stat line', () => {
  it('opens each figure on the list it counts', () => {
    const c = draw('A', t(), { loops: 388, pairs: 0 });
    const caught = tradesHref(BASE, { caught: ['A'] });
    const all = tradesHref(BASE, {});
    expect(named(c, '41')).toEqual([caught]);
    expect(named(c, '1,000')).toEqual([all]);
    expect(named(c, '4.1%')).toEqual([caught]);
    expect(named(c, '812.4 ETH')).toEqual([tradesHref(BASE, { caught: ['A'], sort: 'price', dir: 'desc' })]);
    expect(named(c, '19,032 ETH')).toEqual([tradesHref(BASE, { sort: 'price', dir: 'desc' })]);
    expect(named(c, '644 tokens')).toEqual([`${BASE}/tokens?method=A`]);
    expect(named(c, '1,207 wallets')).toEqual([`${BASE}/wallets?method=A`]);
    expect(named(c, '388 loops')).toEqual([`${BASE}/tokens?method=A`]);
    expect(named(c, '8.0%')).toEqual([tradesHref(BASE, { caught: ['A'], kind: 'all' })]);
    expect(c.textContent).toContain('of every change of owner');
    // A count of sales says sales, as the share before it does.
    expect(c.textContent).toContain('41 sales of 1,000');
    expect(c.textContent).not.toContain('trades of');
  });

  it('says linked pairs beside loops for a lens that counts them, and leaves loops out when none were counted', () => {
    expect(draw('AC', t(), { loops: 120, pairs: 300 }).textContent).toContain('120 loops and 300 linked pairs');
    expect(draw('AC', t(), null).textContent).not.toContain('loop');
  });

  it('says Money loops back is not counted after its share, by name and never by code', () => {
    const text = draw('AU', t()).textContent!;
    expect(text).toContain('4.1% of sales (not counted)');
    expect(text).not.toMatch(/\bAU\b/);
    expect(draw('A', t()).textContent).not.toContain('not counted');
    expect(draw('AU', t()).querySelector('[title^="On real data it flags"]')!.textContent).toBe(' (not counted)');
  });

  it('shows nothing for a lens that did not run', () => {
    expect(draw('AC', t({ available: false })).childElementCount).toBe(0);
  });

  it('says a share is so far while the lens is not final', () => {
    expect(draw('AC', t(), null, 'so far').textContent).toContain('4.1% of sales so far');
  });

  it('puts "at least" before the figure, for a built-in or a lens of yours alike', () => {
    expect(draw('AC', t(), null, 'at least').textContent).toContain('at least 4.1% of sales');
    expect(draw('AC', t(), null, 'at least').textContent).not.toContain('so far');
  });

  it('holds no anchor inside another', () => {
    expect(draw('A', t(), { loops: 1, pairs: 1 }).querySelectorAll('a a').length).toBe(0);
  });
});

// The chart is replaced by a probe of what History hands it: the mapping from the store's counts to a share's part and whole.
const seen = vi.hoisted(() => ({ points: [] as { lens: Record<string, { part: number; whole: number } | null> }[] }));
vi.mock('@/components/trend', () => ({ TimeChart: (p: { points: typeof seen.points }) => { seen.points = p.points; return null; } }));

const on = { available: true } as MethodTotals;
const off = { available: false } as MethodTotals;

describe('History, at the boundary to the chart', () => {
  it('a built-in is flagged of the period\'s sales; a lens of yours is flagged of the sales it has judged', () => {
    render(
      <History
        timeline={{ bucket: 'day', readThrough: null, points: [{ at: 0, transfers: 20, sales: 10, apartSales: 0, flaggedSales: { A: 3, AU: 4, AC: 5, L7: 2 }, judgedSales: { L7: 6 } }] }}
        totals={{ A: on, AU: on, AC: off }} notFinal={[]} funded funding now={0} zone="UTC" base="/c/1/0xabc"
        own={[{ key: 'L7', name: 'Quick flips', qualifier: null }]}
      />,
    );
    const lens = seen.points[0]!.lens;
    expect(lens.A).toEqual({ part: 3, whole: 10 });
    expect(lens.AU).toEqual({ part: 4, whole: 10 });
    expect(lens.AC).toBeNull();
    expect(lens.L7).toEqual({ part: 2, whole: 6 });
  });

  it('a lens of yours with nothing judged in a period has a whole of 0, never the period\'s sales', () => {
    render(
      <History
        timeline={{ bucket: 'day', readThrough: null, points: [{ at: 0, transfers: 20, sales: 10, apartSales: 0, flaggedSales: { A: 0, AU: 0, AC: 0, L7: 0 }, judgedSales: { L7: 0 } }] }}
        totals={{ A: on, AU: on, AC: on }} notFinal={[]} funded funding now={0} zone="UTC" base="/c/1/0xabc"
        own={[{ key: 'L7', name: 'Quick flips', qualifier: null }]}
      />,
    );
    expect(seen.points[0]!.lens.L7).toEqual({ part: 0, whole: 0 });
  });
});
