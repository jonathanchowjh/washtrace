import { describe, expect, it } from 'vitest';
import type { CollectionRow, Method, MethodTotals, PassRow } from '@washtrace/detect';
import { coverage, unread, isRunning, progress, range, rangeText, summary, tabCounts, waiting } from '@/lib/metrics';
import { localTime } from '@/lib/format';

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
    servedAt: null, readRate: null, priority: false, pausedAt: null, rules: {}, contract: null,
    restoreProgress: null, restoreNote: null, restoreNoteKey: null, restoreRetryAt: null, analysisError: null, analysisRetryAt: null, storedThroughTime: null, storedThroughBlock: null, trailImportedSha: null, trailNote: null, ...more,
  };
}

/** Coverage of a row on Ethereum with an RPC set, so the stored-only reading never applies. */
const cov = (c: CollectionRow) => coverage(c, new Set([1]), 0);

describe('coverage', () => {
  it('is complete at the finalized head with every wallet checked', () => {
    const c = cov(row());
    expect(c.reading).toBe('complete');
    expect(c.floor).toEqual([]);
  });

  it('marks the money lenses as floors while wallets are still being checked', () => {
    const c = cov(row({ fundedWallets: 20 }));
    expect(c.reading).toBe('checking');
    expect(c.floor).toEqual(['AU', 'AC']);
  });

  it('is loading stored data while a load runs, with how far it has got', () => {
    const c = cov(row({ cursorBlock: null, startBlock: null, restoreProgress: 0.42 }));
    expect(c.reading).toBe('restoring');
    expect(c.label).toBe('Loading stored data · 42%');
    expect(cov(row({ restoreProgress: 0.42, pausedAt: 5 })).reading).toBe('paused');
  });

  it('never shows a load as done before it has committed', () => {
    const c = cov(row({ restoreProgress: 1 }));
    expect(c.restore).toBe(0.99);
    expect(c.label).toBe('Loading stored data · 99%');
  });

  it('is catching up when far behind the head, whatever the wallets', () => {
    expect(cov(row({ cursorBlock: 500, fundedWallets: 20 })).reading).toBe('catching-up');
  });

  it('does not wait on wallets when no funding source is configured', () => {
    const c = cov(row({ fundedWallets: 0, latest: { ...row().latest!, totals: OFF } }));
    expect(c.reading).toBe('complete');
    expect(c.money).toBe(false);
  });

  it('never says 100% of history read while still behind the head', () => {
    const c = cov(row({ startBlock: 12_000_000, cursorBlock: 20_999_800, headBlock: 21_000_000 }));
    expect(c.reading).toBe('catching-up');
    expect(c.label).toBe('Reading history · >99%');
    expect(progress(1)).toBe('100%');
  });

  it('is starting, never complete, while the head is unknown', () => {
    const c = cov(row({ headBlock: null, cursorBlock: null, transfers: 0, wallets: 0, fundedWallets: 0, latest: null }));
    expect(c.reading).toBe('starting');
    expect(c.label).toBe('Starting');
    expect(cov(row({ headBlock: null, transfers: 0, wallets: 0, fundedWallets: 0 })).reading).toBe('starting');
  });

  it('labels a paused collection paused, even with its cursor at its head', () => {
    const c = cov(row({ pausedAt: 5 }));
    expect(c.reading).toBe('paused');
    expect(c.label).toBe('Paused · read to block 1,000');
    expect(cov(row({ pausedAt: 5, cursorBlock: null, startBlock: null })).label).toBe('Paused · not read yet');
    expect(cov(row({ pausedAt: 5, startBlock: 1, cursorBlock: 0 })).label).toBe('Paused · not read yet');
  });

  it('keeps the unread stretch of history unread when paused, and only then', () => {
    const far = { startBlock: 100, cursorBlock: 500, headBlock: 1_000_000 };
    expect(unread(cov(row({ ...far, pausedAt: 5 })))).toBe(true);
    expect(unread(cov(row({ ...far })))).toBe(true);
    expect(unread(cov(row({ pausedAt: 5 })))).toBe(false);
  });

  it('is not checking wallets while nothing checks them: a money trail with no Etherscan key, or a key just removed', () => {
    for (const c of [row({ fundedWallets: 20, trailImportedSha: 'feed' }), row({ fundedWallets: 20 })]) {
      const idle = coverage(c, new Set([1]), 0, 'UTC', false);
      expect(idle.reading).toBe('complete');
      expect(idle.label).toBe('Up to date');
      // Still floors: an unchecked wallet hides links, key or not.
      expect(idle.floor).toEqual(['AU', 'AC']);
    }
    expect(coverage(row({ fundedWallets: 20 }), new Set([1]), 0, 'UTC', true).reading).toBe('checking');
  });

  it('says how far it was read when its chain has an RPC that has not given the head, never that it is starting', () => {
    // Restored, then the RPC failed (a typo, a rate limit) before the head was known.
    const restored = row({ startBlock: 100, cursorBlock: 900, headBlock: null, storedThroughTime: Date.UTC(2026, 9, 14), transfers: 10 });
    expect(cov(restored).reading).toBe('head-unknown');
    expect(cov(restored).label).toBe('Read to block 900');
    // Read from the chain before, with no stored data: the same.
    expect(cov(row({ headBlock: null, cursorBlock: 900, transfers: 10 })).reading).toBe('head-unknown');
    // Nothing read yet: starting, as before.
    expect(cov(row({ headBlock: null, cursorBlock: 99, transfers: 0 })).reading).toBe('starting');
  });

  it('is starting before the deployment block is known', () => {
    expect(cov(row({ startBlock: null, cursorBlock: null })).reading).toBe('starting');
  });
});

describe('coverage of stored data with no RPC', () => {
  const NONE = new Set<number>();
  const STOPS = Date.UTC(2026, 9, 14);
  const NOW = Date.UTC(2026, 9, 23);
  const HOUR = 3_600_000;
  // Built on the server, so in a pinned locale; the date from the app's own formatter, never hard-coded.
  const DAY = localTime(STOPS, 'date', 'UTC', 'en-GB');
  // Restored: start at the deploy block, cursor at the stored throughBlock, and no head without an RPC.
  const stored = (more: Partial<CollectionRow> = {}) => row({ startBlock: 100, cursorBlock: 900, headBlock: null, storedThroughTime: STOPS, storedThroughBlock: 900, ...more });

  it('says where the stored data stops and how long ago, never that it is starting', () => {
    const c = coverage(stored(), NONE, NOW);
    expect(c.reading).toBe('stored-only');
    expect(c.label).toBe(`Stored data · stops ${DAY} · 9 days unsynced`);
    expect(c.stops).toBe(STOPS);
  });

  it('dates it in a pinned locale, whatever the server runs in', () => {
    expect(DAY).toBe('14 Oct 2026');
  });

  it('counts hours under a day, says up to date under an hour, and says 1 day', () => {
    expect(coverage(stored(), NONE, STOPS + 5 * HOUR).unsynced).toBe('5 hours unsynced');
    expect(coverage(stored(), NONE, STOPS + HOUR).unsynced).toBe('1 hour unsynced');
    expect(coverage(stored(), NONE, STOPS + 59 * 60_000).unsynced).toBe('up to date with its stored data');
    expect(coverage(stored(), NONE, STOPS + 30 * HOUR).label).toBe(`Stored data · stops ${DAY} · 1 day unsynced`);
  });

  it('says how far it was read, with no stored date, once read past the stored data', () => {
    const c = coverage(stored({ cursorBlock: 1_250_000 }), NONE, NOW);
    expect(c.reading).toBe('stored-only');
    expect(c.label).toBe('Read to block 1,250,000 · no RPC for its chain');
    expect(c.stops).toBeNull();
    expect(c.unsynced).toBeNull();
  });

  it('gives way to paused and to a load in progress', () => {
    expect(coverage(stored({ pausedAt: 5 }), NONE, NOW).reading).toBe('paused');
    expect(coverage(stored({ restoreProgress: 0.4 }), NONE, NOW).reading).toBe('restoring');
  });

  it('is not stored-only once the chain has an RPC, or before stored data has landed', () => {
    expect(coverage(stored(), new Set([1]), NOW).reading).toBe('head-unknown');
    expect(coverage(stored({ cursorBlock: null }), NONE, NOW).reading).toBe('starting');
    expect(coverage(stored({ storedThroughTime: null, transfers: 0 }), NONE, NOW).reading).toBe('starting');
    expect(coverage(stored(), new Set([1]), NOW).stops).toBeNull();
  });
});

describe('tabCounts', () => {
  it('counts the stored-only collections in In sync as behind, paused ones not', () => {
    const NONE = new Set<number>();
    const stored = { startBlock: 100, cursorBlock: 900, headBlock: null, storedThroughTime: Date.UTC(2026, 9, 14) };
    const rows = [row({ id: 1, ...stored }), row({ id: 2, ...stored, pausedAt: 5 }), row({ id: 3 }), row({ id: 4, chainId: 8453, ...stored })];
    expect(tabCounts(rows, NONE)).toEqual({ sync: 3, paused: 1, all: 4, behind: 2 });
    expect(tabCounts(rows, new Set([1]))).toEqual({ sync: 3, paused: 1, all: 4, behind: 1 });
  });
});

describe('waiting', () => {
  const NOW = 100 * 60_000;
  const pass = (more: Partial<PassRow> = {}): PassRow => ({
    job: 'analyze', startedAt: NOW - 2 * 60_000, finishedAt: null, tookMs: null, outcome: null, detail: null, heartbeatAt: NOW, doing: 'Analyzing', subjectId: 1, ...more,
  });
  const names = new Map([[7, 'Terraforms']]);
  const fresh = row({ latest: null });

  it('promises nothing for a paused collection', () => {
    expect(waiting(row({ latest: null, pausedAt: 1 }), pass(), names, NOW)).toBe('Paused · it is not analysed until you resume it.');
  });

  it('waits for stored data to load, not for transfers to be read', () => {
    expect(waiting(row({ latest: null, transfers: 0, restoreProgress: 0.1 }), undefined, names, NOW)).toBe('Loading stored data · it is analysed once it has loaded.');
  });

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

  it('says its analysis failed and when it is tried again, never that the next pass is near', () => {
    const at = NOW + 20 * 60_000;
    const failing = row({ latest: null, analysisError: 'out of memory', analysisRetryAt: at });
    const said = `Its analysis failed: out of memory · it is tried again after ${localTime(at, 'time', 'Asia/Tokyo', 'en-GB')}.`;
    expect(waiting(failing, undefined, names, NOW, 'Asia/Tokyo')).toBe(said);
    // Queued behind another collection, the failure is still what holds it.
    expect(waiting(failing, pass({ subjectId: 7 }), names, NOW, 'Asia/Tokyo')).toBe(said);
    expect(waiting(row({ latest: null, analysisError: 'out of memory', analysisRetryAt: NOW - 1 }), undefined, names, NOW)).toBe('Its analysis failed: out of memory · it is due to be tried again.');
    // Being tried again now.
    expect(waiting(failing, pass(), names, NOW)).toBe('First analysis running · started 2 min ago.');
  });

  it('knows a pass is running only until it finishes', () => {
    expect(isRunning(pass())).toBe(true);
    expect(isRunning(pass({ finishedAt: NOW }))).toBe(false);
    expect(isRunning(pass({ finishedAt: NOW - 10 * 60_000 }))).toBe(true);
  });
});
