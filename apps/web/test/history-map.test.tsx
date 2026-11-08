import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { MethodTotals } from '@washtrace/detect';

// The chart is replaced by a probe of what History hands it: the mapping from the store's counts to a share's part and whole.
const seen = vi.hoisted(() => ({ points: [] as { lens: Record<string, { part: number; whole: number } | null> }[] }));
vi.mock('@/components/trend', () => ({ TimeChart: (p: { points: typeof seen.points }) => { seen.points = p.points; return null; } }));

import { History } from '@/components/methods';

const on = { available: true } as MethodTotals;
const off = { available: false } as MethodTotals;

describe('History, at the boundary to the chart (Ruling S6)', () => {
  it('a built-in is flagged of the period\'s sales; a lens of yours is flagged of the sales it has judged', () => {
    render(
      <History
        timeline={{ bucket: 'day', readThrough: null, points: [{ at: 0, transfers: 20, sales: 10, flaggedSales: { A: 3, AU: 4, AC: 5, L7: 2 }, judgedSales: { L7: 6 } }] }}
        totals={{ A: on, AU: on, AC: off }} notFinal={[]} now={0} zone="UTC" base="/c/1/0xabc"
        own={[{ key: 'L7', name: 'Quick flips', atLeast: false }]}
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
        timeline={{ bucket: 'day', readThrough: null, points: [{ at: 0, transfers: 20, sales: 10, flaggedSales: { A: 0, AU: 0, AC: 0, L7: 0 }, judgedSales: { L7: 0 } }] }}
        totals={{ A: on, AU: on, AC: on }} notFinal={[]} now={0} zone="UTC" base="/c/1/0xabc"
        own={[{ key: 'L7', name: 'Quick flips', atLeast: false }]}
      />,
    );
    expect(seen.points[0]!.lens.L7).toEqual({ part: 0, whole: 0 });
  });
});
