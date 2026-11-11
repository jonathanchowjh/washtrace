import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BUILT_INS, TimeChart, type TimePoint } from '@/components/trend';
import { SHOWN } from '@/lib/metrics';

// The chart opens a period through the router.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

const DAY = 86_400_000;
const frac = (part: number, whole = 10) => ({ part, whole });
const point = (at: number, own: TimePoint['lens'] = {}): TimePoint => ({
  at, lens: { A: frac(1), AU: frac(2), AC: frac(3), ...own }, sales: 10, transfers: 10,
});
const ONE = { key: 'L7', name: 'Quick flips', qualifier: null } as const;
const TWO = { key: 'L8', name: 'Washed twice', qualifier: 'at least' } as const;
const history = (own: { key: `L${number}`; name: string; qualifier: 'at least' | 'so far' | null; floorWhy?: string }[], ownLeft: { key: string; name: string }[] = [], perLens: TimePoint['lens'] = { L7: frac(4), L8: frac(5) }) =>
  render(
    <TimeChart kind="history" bucket="day" readThrough={null} now={2 * DAY} notFinal={[]} funded funding zone="UTC" own={own} ownLeft={ownLeft} ownNotRun={[]}
      points={[point(0, perLens), point(DAY, perLens)]} lensHrefs={[{ L7: '/c/1/0xabc/trades?caught=L7' }, {}]} />,
  ).container;

describe('the time chart, with lenses of yours', () => {
  it('draws a series per lens of yours, named in the legend and the table', () => {
    const el = history([ONE, TWO]);
    const legend = el.querySelector('figcaption')!;
    expect(legend.textContent).toContain('Quick flips');
    expect(legend.textContent).toContain('Washed twice');
    const table = el.querySelector('table')!;
    const heads = [...table.querySelectorAll('th')].map((h) => h.textContent);
    expect(heads.some((h) => h?.includes('Quick flips'))).toBe(true);
    expect(heads.some((h) => h?.includes('Washed twice'))).toBe(true);
    // The flow colour, told apart by dash and never by hue alone.
    const lines = [...el.querySelectorAll('polyline.stroke-flow')].map((l) => l.getAttribute('stroke-dasharray'));
    expect(lines).toEqual(['2 2', '6 2']);
    // Its table cell opens what it caught.
    expect(within(table).getAllByRole('link', { name: '40%' })[0]!.getAttribute('href')).toBe('/c/1/0xabc/trades?caught=L7');
    // Never its code.
    expect(el.textContent).not.toMatch(/\bL[78]\b/);
  });

  it('an at-least lens says "at least" in its legend and tooltip', () => {
    const el = history([ONE, TWO]);
    const legend = el.querySelector('figcaption')!;
    const entry = (name: string) => [...legend.querySelectorAll('span.flex')].find((e) => e.textContent?.startsWith(name))!.textContent;
    expect(entry('Washed twice')).toMatch(/at least/);
    expect(entry('Quick flips')).not.toMatch(/at least/);
    fireEvent.focus(el.querySelector('[role="group"]')!);
    const tip = screen.getByRole('status').textContent!;
    expect(tip).toMatch(/at least\s*50%\s*Washed twice/);
    expect(tip).not.toMatch(/at least\s*40%/);
  });

  it('past 3, the line under the chart names the rest, each linking to its tab', () => {
    const el = history([ONE], [{ key: 'L9', name: 'Ring sales' }, { key: 'L10', name: 'Late dumps' }]);
    const rest = el.querySelector('[data-own-left]') as HTMLElement;
    expect(rest.textContent).toContain('not drawn');
    expect(within(rest).getByRole('link', { name: 'Ring sales' }).getAttribute('href')).toBe('?method=L9');
    expect(within(rest).getByRole('link', { name: 'Late dumps' }).getAttribute('href')).toBe('?method=L10');
  });

  it('every dash of yours keeps its gaps: a butt cap in the lines and the legend, never a round one that closes them', () => {
    const el = history([ONE, TWO]);
    const drawn = [...el.querySelectorAll('polyline.stroke-flow'), ...el.querySelectorAll('figcaption line.stroke-flow')];
    expect(drawn.map((l) => l.getAttribute('stroke-dasharray'))).toEqual(['2 2', '6 2', '2 2', '6 2']);
    for (const l of drawn) expect(l.getAttribute('stroke-linecap')).toBe('butt');
    // The built-ins keep their round caps.
    expect(el.querySelector('polyline.stroke-cycle')!.getAttribute('stroke-linecap')).toBe('round');
  });

  it('a period past what the lens has judged says "not judged yet", never "no sale"', () => {
    const el = render(
      <TimeChart kind="history" bucket="day" readThrough={null} now={2 * DAY} notFinal={[]} funded funding zone="UTC" own={[ONE]} ownLeft={[]} ownNotRun={[]}
        points={[point(0, { L7: frac(4, 10) }), point(DAY, { L7: frac(0, 0) })]} />,
    ).container;
    const row = [...el.querySelectorAll('tbody tr')].find((r) => r.textContent?.startsWith('2 Jan'))!;
    expect(row.textContent).toContain('not judged yet');
    expect(row.textContent).toContain('its run has not read this far yet');
    fireEvent.focus(el.querySelector('[role="group"]')!);
    expect(screen.getByRole('status').textContent).toMatch(/not judged yet\s*Quick flips/);
    expect(screen.getByRole('status').textContent).toContain('its run has not read this far yet');
    expect(screen.getByRole('status').textContent).not.toMatch(/no sale\s*Quick flips/);
  });

  it('names a lens of yours with no finished run, beside those left out, in Compare’s words for why', () => {
    const el = render(
      <TimeChart kind="history" bucket="day" readThrough={null} now={2 * DAY} notFinal={[]} funded funding zone="UTC" own={[ONE]} ownLeft={[]}
        ownNotRun={[{ key: 'L12', name: 'Fresh lens', why: 'has no figures: its last run failed.' }, { key: 'L13', name: 'New lens', why: 'has not run on this collection, so it flags nothing yet.' }]}
        points={[point(0), point(DAY)]} />,
    ).container;
    const line = el.querySelector('[data-own-left]') as HTMLElement;
    expect(line.textContent).toBe('No line for these lenses of yours: Fresh lens has no figures: its last run failed. New lens has not run on this collection, so it flags nothing yet.');
    expect(within(line).getByRole('link', { name: 'Fresh lens' }).getAttribute('href')).toBe('?method=L12');
  });

  it('the hover never reads "not run" with "has not read this far": a lens with no figures has no run to have read', () => {
    const el = render(
      <TimeChart kind="history" bucket="day" readThrough={null} now={2 * DAY} notFinal={[]} funded funding zone="UTC" own={[ONE]} ownLeft={[]} ownNotRun={[]}
        points={[point(0, { L7: null }), point(DAY, { L7: null })]} />,
    ).container;
    fireEvent.focus(el.querySelector('[role="group"]')!);
    const tip = screen.getByRole('status').textContent!;
    expect(tip).toMatch(/not run\s*Quick flips/);
    expect(tip).not.toContain('has not read this far');
  });

  it('the (at least) title names why the share is a floor, from the causes it is given', () => {
    const own = [{ key: 'L8', name: 'Washed twice', qualifier: 'at least', floorWhy: 'some trades have no block time to judge them by' }] as const;
    const el = history([...own]);
    expect(el.querySelector('[title^="Washed twice"]')!.getAttribute('title')).toBe("Washed twice's share is a floor: some trades have no block time to judge them by");
    expect(el.innerHTML).not.toContain('not fully read yet');
  });

  it('says nothing about left-out lenses when none was left out', () => {
    expect(history([ONE]).querySelector('[data-own-left]')).toBeNull();
  });

  it('the analyses chart\'s lead says it shows the built-in lenses only, because a lens of yours keeps only its latest run', () => {
    const el = render(<TimeChart kind="analyses" points={[point(0), point(DAY)]} zone="UTC" />).container;
    expect(el.textContent).toMatch(/built-in lenses only/i);
    expect(el.textContent).toMatch(/keeps only its latest run/i);
  });
});

describe('the time chart, for a history in one period', () => {
  const HOUR = 3_600_000;
  const at = Date.UTC(2023, 3, 3, 14);
  const one = (q: TimePoint, more: { periodHrefs?: string[]; lensHrefs?: Partial<Record<string, string>>[]; readThrough?: number } = {}) => render(
    <TimeChart kind="history" bucket="hour" readThrough={more.readThrough ?? null} now={at + 400 * DAY} notFinal={[]} funded funding zone="UTC" own={[]} ownLeft={[]} ownNotRun={[]}
      points={[q]} periodHrefs={more.periodHrefs} lensHrefs={more.lensHrefs} />,
  ).container;

  it('says all its sales fell in one hour, and when, with each lens\'s share of them, in place of a near-empty chart', () => {
    const el = one({ ...point(at), sales: 12, lens: { A: frac(3, 12), AU: frac(1, 12), AC: frac(6, 12) } }, { periodHrefs: ['/c/1/0xabc/trades?from=1'], lensHrefs: [{ A: '/c/1/0xabc/trades?caught=A' }] });
    const fig = el.querySelector<HTMLElement>('figure[data-one-period]')!;
    expect(fig.querySelector('p')!.textContent).toMatch(/^All 12 sales in one hour, .*2023/);
    expect(within(fig).getByRole('link', { name: /^All 12 sales/ }).getAttribute('href')).toBe('/c/1/0xabc/trades?from=1');
    expect(within(fig).getByRole('link', { name: '25%' }).getAttribute('href')).toBe('/c/1/0xabc/trades?caught=A');
    expect(fig.textContent).toContain('6 of 12 sales');
    expect(fig.textContent).toContain('Linked wallets');
    expect(el.querySelector('polyline')).toBeNull();
    expect(el.textContent).not.toMatch(/hours? with trades/);
  });

  it('lists the lenses in the order every page does, each in its own lens\'s hue', () => {
    expect(BUILT_INS).toEqual(SHOWN);
    const el = one({ ...point(at), sales: 12, lens: { A: frac(3, 12), AU: frac(1, 12), AC: frac(6, 12) } });
    const items = [...el.querySelectorAll('figure[data-one-period] li')];
    expect(items.map((li) => li.textContent?.match(/Round trips|Linked wallets|Money loops back/)?.[0])).toEqual(['Round trips', 'Linked wallets', 'Money loops back']);
    expect(items[1]!.querySelector('line')!.getAttribute('class')).toContain('stroke-money');
  });

  it('says one sale as one, and a period read only part way says how far the chain is read', () => {
    const el = one({ ...point(at), sales: 1, lens: { A: frac(1, 1), AU: frac(0, 1), AC: frac(1, 1) } }, { readThrough: at + HOUR });
    const fig = el.querySelector('figure[data-one-period]')!;
    expect(fig.querySelector('p')!.textContent).toMatch(/^One sale, /);
    expect(fig.textContent).toContain('anything later is not read yet');
  });
});

describe('the time chart\'s axis', () => {
  const spread = () => render(
    <TimeChart kind="history" bucket="day" readThrough={null} now={60 * DAY} notFinal={[]} funded funding zone="UTC" own={[]} ownLeft={[]} ownNotRun={[]}
      points={[point(0), point(20 * DAY), point(40 * DAY), point(59 * DAY)]} />,
  ).container;
  // The x axis's labels sit just under the plot: H - B + 17.
  const ticks = (c: Element) => c.querySelectorAll('svg text[y="217"]').length;

  it('counts its periods in words, "4 days with trades"', () => {
    expect(spread().querySelector('figcaption')!.textContent).toContain('4 days with trades');
  });

  it('on a phone draws as wide as it is shown, so its labels stay 11px, and with fewer ticks', () => {
    const wide = ticks(spread());
    cleanup();
    const was = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => 340 });
    try {
      const el = spread();
      expect(el.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 340 230');
      expect(ticks(el)).toBeLessThanOrEqual(3);
      expect(ticks(el)).toBeLessThan(wide);
    } finally {
      Object.defineProperty(Element.prototype, 'clientWidth', was);
    }
  });
});
