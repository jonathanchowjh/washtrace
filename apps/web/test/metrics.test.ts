import { describe, expect, it } from 'vitest';
import type { CollectionRow, Method, MethodTotals, PassRow } from '@washtrace/detect';
import { coverage, isRunning, progress, range, rangeText, summary, waiting } from '@/lib/metrics';

function totals(m: Partial<MethodTotals> = {}): MethodTotals {
  return {
    transfers: 56, flagged: 10, sales: 56, flaggedSales: 10, volumeWei: '98700000000000000000', flaggedVolumeWei: '35000000000000000000',
    wallets: 5, tokens: 2, available: true, ...m,
  };
}

const DEMO: Record<Method, MethodTotals> = {
  A: totals(),
  AU: totals({ flagged: 12, flaggedSales: 12, flaggedVolumeWei: '50000000000000000000' }),
  AC: totals({ flagged: 14, flaggedSales: 14, flaggedVolumeWei: '62000000000000000000' }),
};

const OFF = { ...DEMO, AU: totals({ available: false, flagged: 0, flaggedSales: 0 }), AC: totals({ available: false, flagged: 0, flaggedSales: 0 }) };

describe('range', () => {
  it('runs from the strictest lens to the widest', () => {
    const r = range(DEMO, 'sales')!;
    expect([r.low, r.high]).toEqual(['A', 'AC']);
    expect(rangeText(r)).toBe('18–25%');
  });

  it('says an exact zero as 0, not 0.0', () => {
    const r = range({ ...DEMO, A: totals({ flaggedVolumeWei: '0' }) }, 'volume')!;
    expect(rangeText(r)).toBe('0–63%');
  });

  it('prices volume from wei', () => {
    expect(rangeText(range(DEMO, 'volume')!)).toBe('35–63%');
  });

  it('leaves out a lens that did not run, rather than reading it as 0%', () => {
    const r = range(OFF, 'sales')!;
    expect([r.low, r.high]).toEqual(['A', 'A']);
    expect(rangeText(r)).toBe('18%');
  });

  it('is null when there is nothing to divide by', () => {
    const none = { A: totals({ sales: 0, flaggedSales: 0 }), AU: totals({ sales: 0, flaggedSales: 0 }), AC: totals({ sales: 0, flaggedSales: 0 }) };
    expect(range(none, 'sales')).toBeNull();
    expect(range(DEMO, 'volume')).not.toBeNull();
  });
});

describe('summary', () => {
  it('states the strict count, then what following the money adds', () => {
    expect(summary(DEMO)).toBe('10 of 56 sales are round trips between the same wallets. Counting buyers and sellers linked by money, up to 14 are.');
  });

  it('says money links were not checked when no money lens ran', () => {
    expect(summary(OFF)).toMatch(/not checked/);
  });
});

function row(more: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1, chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, cursorBlock: 1_000, headBlock: 1_000,
    addedAt: 0, ingestedAt: 0, error: null, errorAt: null, transfers: 10, wallets: 80, fundedWallets: 80, stale: false,
    latest: { ranAt: 0, tookMs: 1, throughBlock: 1_000, totals: DEMO, missingData: 0, fundedWallets: 80, wallets: 80, truncatedSearches: 0 },
    servedAt: null, readRate: null, priority: false, pausedAt: null, rules: {}, contract: null, ...more,
  };
}

describe('coverage', () => {
  it('is complete at the finalized head with every wallet checked', () => {
    const c = coverage(row());
    expect(c.reading).toBe('complete');
    expect(c.floor).toEqual([]);
  });

  it('marks the money lenses as floors while wallets are still being checked', () => {
    const c = coverage(row({ fundedWallets: 20 }));
    expect(c.reading).toBe('checking');
    expect(c.floor).toEqual(['AU', 'AC']);
  });

  it('is catching up when far behind the head, whatever the wallets', () => {
    expect(coverage(row({ cursorBlock: 500, fundedWallets: 20 })).reading).toBe('catching-up');
  });

  it('does not wait on wallets when no funding source is configured', () => {
    const c = coverage(row({ fundedWallets: 0, latest: { ...row().latest!, totals: OFF } }));
    expect(c.reading).toBe('complete');
    expect(c.money).toBe(false);
  });

  it('never says 100% of history read while still behind the head', () => {
    const c = coverage(row({ startBlock: 12_000_000, cursorBlock: 20_999_800, headBlock: 21_000_000 }));
    expect(c.reading).toBe('catching-up');
    expect(c.label).toBe('Reading history · >99%');
    expect(progress(1)).toBe('100%');
  });

  it('is starting before the deployment block is known', () => {
    expect(coverage(row({ startBlock: null, cursorBlock: null })).reading).toBe('starting');
  });
});

describe('waiting', () => {
  const NOW = 100 * 60_000;
  const pass = (more: Partial<PassRow> = {}): PassRow => ({
    job: 'analyze', startedAt: NOW - 2 * 60_000, finishedAt: null, tookMs: null, outcome: null, detail: null, heartbeatAt: NOW, doing: 'Analyzing', subjectId: 1, ...more,
  });
  const names = new Map([[7, 'Terraforms']]);
  const fresh = row({ latest: null });

  it('waits for transfers when none are read', () => {
    expect(waiting(row({ latest: null, transfers: 0 }), undefined, names, NOW)).toBe('Waiting for its first transfers.');
  });

  it('says its own first analysis is running', () => {
    expect(waiting(fresh, pass(), names, NOW)).toBe('First analysis running · started 2 min ago.');
  });

  it('names the collection it is queued behind', () => {
    expect(waiting(fresh, pass({ subjectId: 7, startedAt: NOW - 14 * 60_000 }), names, NOW))
      .toBe('Waiting for its first analysis · queued behind Terraforms (running 14 min).');
  });

  it('says the next pass is near when none is running', () => {
    expect(waiting(fresh, undefined, names, NOW)).toBe('Waiting for its first analysis · the next pass starts within a minute.');
    expect(waiting(fresh, pass({ finishedAt: NOW - 1_000 }), names, NOW)).toBe('Waiting for its first analysis · the next pass starts within a minute.');
  });

  it('knows a pass is running only until it finishes', () => {
    expect(isRunning(pass())).toBe(true);
    expect(isRunning(pass({ finishedAt: NOW }))).toBe(false);
    expect(isRunning(pass({ finishedAt: NOW - 10 * 60_000 }))).toBe(true);
  });
});
