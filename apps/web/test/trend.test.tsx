import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TimeChart, type TimePoint } from '@/components/trend';

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
