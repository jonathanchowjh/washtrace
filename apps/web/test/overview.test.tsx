import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MethodTotals, TimelinePoint, TokenLine, TradeRow } from '@washtrace/detect';
import { HowSure, NotCounted, SalesStrip, TopList, saleStanding, standing, stepOf } from '@/components/overview';
import type { Stage } from '@/lib/pipeline';
import { tradesHref } from '@/lib/trades-url';

afterEach(cleanup);

const BASE = `/c/1/0x${'b'.repeat(40)}`;
const stage = (key: Stage['key'], state: Stage['state']): Stage => ({ key, n: 1, title: key, state, share: null, file: null, feeds: '', needs: null, skipped: null });
const totals = (a: number, ac: number, au: number, on = { A: true, AC: true, AU: true }): Record<'A' | 'AC' | 'AU', MethodTotals> => {
  const t = (n: number, available: boolean): MethodTotals => ({ transfers: 100, flagged: n, sales: 100, flaggedSales: n, volumeWei: '0', flaggedVolumeWei: '0', wallets: 0, tokens: 0, available });
  return { A: t(a, on.A), AC: t(ac, on.AC), AU: t(au, on.AU) };
};
const point = (at: number, sales: number, A: number, AC: number, AU: number, apartSales: number): TimelinePoint => ({ at, transfers: sales, sales, apartSales, flaggedSales: { A, AC, AU } });
const links = (c: Element) => [...c.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

describe('the reading in four steps', () => {
  it('reads each step as the worst of its stages, so a failure is never behind one that is done', () => {
    const stages = [stage('download', 'done'), stage('load', 'failed'), stage('stored-analysis', 'running')];
    expect(stepOf(stages, ['download', 'load', 'stored-analysis'])?.state).toBe('failed');
  });

  it('calls a step not needed only when every stage of it is', () => {
    expect(stepOf([stage('download', 'not-needed'), stage('load', 'not-needed')], ['download', 'load'])?.state).toBe('not-needed');
    expect(stepOf([stage('download', 'not-needed'), stage('load', 'done')], ['download', 'load'])?.state).toBe('done');
  });
});

describe('how sure', () => {
  it('climbs from the floor to what the ceiling adds, and keeps Money loops back apart', () => {
    const c = render(<HowSure totals={totals(10, 14, 30)} base={BASE} />).container;
    expect([...c.querySelectorAll('[data-rung]')].map((r) => r.getAttribute('data-rung'))).toEqual(['A', 'AC', 'AU']);
    const rung = (m: string) => c.querySelector(`[data-rung="${m}"]`)!;
    expect(rung('A').textContent).toContain('10.0%');
    // The ceiling's rung is what it adds over the floor, never its whole share.
    expect(rung('AC').textContent).toContain('+4.0%');
    expect(rung('AC').textContent).toContain('+4 sales');
    expect(links(rung('AC'))).toContainEqual(['+4 sales', tradesHref(BASE, { caught: ['AC'], notCaught: ['A'] })]);
    expect(rung('AU').textContent).toContain('fails the placebo test');
  });

  it('says a lens that did not run did not, with no share', () => {
    const c = render(<HowSure totals={totals(10, 10, 0, { A: true, AC: false, AU: false })} base={BASE} />).container;
    expect(c.querySelector('[data-rung="AC"]')!.textContent).not.toMatch(/%/);
    expect(c.querySelector('[data-rung="AC"]')!.textContent).toContain('not run');
  });

  it('links on to the Methods page', () => {
    const c = render(<HowSure totals={totals(1, 2, 3)} base={BASE} />).container;
    expect(links(c)).toContainEqual(['Methods, numbers and your lenses ›', `${BASE}/methods`]);
  });
});

describe('every sale, in order', () => {
  it('splits a period into the floor, what the ceiling adds, those apart, and the rest, which add up to its sales', () => {
    const s = standing(point(0, 20, 5, 8, 9, 3));
    expect(s).toEqual({ floor: 5, ceiling: 3, apart: 3, clean: 9 });
    expect(s.floor + s.ceiling + s.apart + s.clean).toBe(20);
  });

  it('draws a column per period that sold, each opening that period\'s trades, and keys the totals', () => {
    const hour = 3_600_000;
    const c = render(<SalesStrip timeline={{ bucket: 'hour', points: [point(0, 4, 1, 2, 1, 1), point(hour, 0, 0, 0, 0, 0), point(2 * hour, 6, 0, 0, 0, 0)] }} base={BASE} zone="UTC" chainId={1} />).container;
    const cols = [...c.querySelectorAll('a[aria-label]')];
    expect(cols.map((a) => a.getAttribute('href'))).toEqual([tradesHref(BASE, { fromMs: 0, toMs: hour }), tradesHref(BASE, { fromMs: 2 * hour, toMs: 3 * hour })]);
    expect(c.textContent).toContain('All 10 sales, in order');
    expect(links(c)).toContainEqual(['1 not counted', tradesHref(BASE, { caught: ['AU'], notCaught: ['A', 'AC'] })]);
    expect(links(c)).toContainEqual(['7 clean', tradesHref(BASE, { notCaught: ['A', 'AC', 'AU'] })]);
  });

  it('colours a sale by the strongest lens that caught it', () => {
    expect([['A', 'AC', 'AU'], ['AC', 'AU'], ['AU'], [], ['L7']].map(saleStanding)).toEqual(['floor', 'ceiling', 'apart', 'clean', 'clean']);
  });

  it('is a square per sale, oldest first, each opening its trade, when it holds every sale; else it keeps the columns', () => {
    const row = (n: number, lenses: string[]) => ({ txHash: `0x${n}`, logIndex: 0, lenses }) as unknown as TradeRow;
    const timeline = { bucket: 'hour' as const, points: [point(0, 3, 1, 2, 1, 0)] };
    const c = render(<SalesStrip timeline={timeline} base={BASE} zone="UTC" chainId={1} sales={[row(1, ['A', 'AC']), row(2, ['AC']), row(3, [])]} />).container;
    const squares = [...c.querySelectorAll('ol[aria-label="Each sale, oldest first"] a')];
    expect(squares.map((a) => a.getAttribute('title'))).toEqual(['Sale 1 of 3: round trip (floor)', 'Sale 2 of 3: linked by money (ceiling)', 'Sale 3 of 3: not flagged']);
    expect(squares[0]!.getAttribute('href')).toBe(`${BASE}/tx/0x1`);
    cleanup();
    // One sale short (an untimed one, say): the squares would not be every sale, so it draws the periods.
    const short = render(<SalesStrip timeline={timeline} base={BASE} zone="UTC" chainId={1} sales={[row(1, ['A'])]} />).container;
    expect(short.querySelector('ol[aria-label="Each sale, oldest first"]')).toBeNull();
  });

  it('outlines an item\'s own sales on its page, says where they sit, and lists them', () => {
    const row = (n: number, lenses: string[]) => ({ txHash: `0x${n}`, logIndex: 0, lenses }) as unknown as TradeRow;
    const timeline = { bucket: 'hour' as const, points: [point(0, 3, 1, 2, 1, 0)] };
    const mine = { keys: new Set(['0x2:0']), times: [0], label: 'this token\'s', href: tradesHref(BASE, { token: '7' }) };
    const c = render(<SalesStrip timeline={timeline} base={BASE} zone="UTC" chainId={1} sales={[row(1, ['A']), row(2, ['AC']), row(3, [])]} mine={mine} />).container;
    const squares = [...c.querySelectorAll('ol[aria-label="Each sale, oldest first"] a')];
    expect(squares.map((a) => a.className.includes('ring-2'))).toEqual([false, true, false]);
    expect(squares[1]!.getAttribute('title')).toBe('Sale 2 of 3: linked by money (ceiling), this token\'s');
    expect(c.textContent).toContain('Where this token\'s sales sit among all 3');
    expect(links(c)).toContainEqual(['1 this token\'s', tradesHref(BASE, { token: '7' })]);
  });

  it('outlines the columns an item\'s sales fall in, when the strip is a column per period', () => {
    const hour = 3_600_000;
    const timeline = { bucket: 'hour' as const, points: [point(0, 4, 1, 2, 1, 1), point(2 * hour, 6, 0, 0, 0, 0)] };
    const mine = { keys: new Set(['0x9:0']), times: [2 * hour + 60_000], label: 'this wallet\'s', href: '/x' };
    const c = render(<SalesStrip timeline={timeline} base={BASE} zone="UTC" chainId={1} mine={mine} />).container;
    expect([...c.querySelectorAll('a[aria-label]')].map((a) => a.className.includes('ring-2'))).toEqual([false, true]);
  });

  it('draws nothing for a collection with no sale', () => {
    expect(render(<SalesStrip timeline={{ bucket: 'day', points: [] }} base={BASE} zone="UTC" chainId={1} />).container.innerHTML).toBe('');
  });
});

describe('the top lists', () => {
  const token = (tokenId: string, loops: number): TokenLine => ({ tokenId, caught: 1, trades: 1, volumeWei: '1000000000000000000', lastAt: null, loops, pairs: loops === 0 ? 1 : 0, wallets: 2, closedByMoney: 0, laps: 0, middles: 0 });

  it('marks a token with a loop as a round trip, and one linked only by money as the ceiling\'s', () => {
    const c = render(<TopList kind="tokens" rows={[token('1', 1), token('2', 0)]} total={6} base={BASE} chainId={1} />).container;
    const marks = [...c.querySelectorAll('li i')].map((i) => i.className);
    expect(marks[0]).toContain('bg-cycle');
    expect(marks[1]).toContain('repeating-linear-gradient');
    expect(links(c)).toContainEqual(['All 6 tokens ›', `${BASE}/tokens?method=AC&sort=volume`]);
  });
});

describe('looks suspicious, not counted', () => {
  it('says nothing when nothing is apart, and opens what is', () => {
    expect(render(<NotCounted apart={0} base={BASE} />).container.innerHTML).toBe('');
    cleanup();
    const c = render(<NotCounted apart={3} base={BASE} />).container;
    expect(c.textContent).toContain('3 sales: money went back to the seller');
    expect(c.querySelector('a')?.getAttribute('href')).toBe(tradesHref(BASE, { caught: ['AU'], notCaught: ['A', 'AC'] }));
  });
});
