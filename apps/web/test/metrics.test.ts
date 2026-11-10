import { describe, expect, it } from 'vitest';
import type { CollectionRow, LensRun, Method, MethodTotals, PassRow } from '@washtrace/detect';
import { TRAIL_LOADING, analyzingOn, coverage, unread, isRunning, progress, tabCounts, analysisWaitText } from '@/lib/coverage';
import { DEFAULT_RULE, ruleLine } from '@washtrace/detect/lens-rule';
import { APART_WHY, judged, judgedBy, chartLenses, lensContext, lensesRan, ownLenses, ownRan, ranFlags, evidenceLead, range, rangeEnds, summary } from '@/lib/metrics';
import { formatBytes, localTime } from '@/lib/format';

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
    expect(rangeEnds(r)).toEqual({ low: '18', high: '25%', same: false });
  });

  it('says an exact zero as 0, not 0.0', () => {
    const r = range({ ...DEMO, A: totals({ flaggedVolumeWei: '0' }) }, 'volume')!;
    expect(rangeEnds(r)).toEqual({ low: '0', high: '63%', same: false });
  });

  it('prices volume from wei', () => {
    expect(rangeEnds(range(DEMO, 'volume')!)).toEqual({ low: '35', high: '63%', same: false });
  });

  it('leaves out a lens that did not run, rather than reading it as 0%', () => {
    const r = range(OFF, 'sales')!;
    expect([r.low, r.high]).toEqual(['A', 'A']);
    expect(rangeEnds(r)).toEqual({ low: '18', high: '18%', same: true });
  });

  it('leaves Money loops back out: its top is Linked wallets even when Money loops back flags more', () => {
    const t = { A: totals({ sales: 100, flaggedSales: 10 }), AU: totals({ sales: 100, flaggedSales: 70 }), AC: totals({ sales: 100, flaggedSales: 40 }) };
    expect(range(t, 'sales')).toEqual({ low: 'A', high: 'AC', lowShare: 0.1, highShare: 0.4 });
  });

  it('with Linked wallets not run is Round trips alone, never Money loops back', () => {
    const t = { A: totals({ sales: 100, flaggedSales: 10 }), AU: totals({ sales: 100, flaggedSales: 70 }), AC: totals({ available: false, sales: 100, flaggedSales: 0 }) };
    const r = range(t, 'sales')!;
    expect([r.low, r.high]).toEqual(['A', 'A']);
  });

  it('is null when there is nothing to divide by', () => {
    const none = { A: totals({ sales: 0, flaggedSales: 0 }), AU: totals({ sales: 0, flaggedSales: 0 }), AC: totals({ sales: 0, flaggedSales: 0 }) };
    expect(range(none, 'sales')).toBeNull();
    expect(range(DEMO, 'volume')).not.toBeNull();
  });
});

describe('evidenceLead', () => {
  const apart = `Money loops back is shown apart: ${APART_WHY}. Choose a lens to see the tokens and wallets it flags.`;
  it('names Round trips and Linked wallets as the two ends when both ran', () => {
    expect(evidenceLead(DEMO)).toBe(`Round trips and Linked wallets are the two ends of the range above. Between a third and a half of what Linked wallets adds over Round trips is chance. ${apart}`);
  });
  it('says Round trips is the whole range when Linked wallets has not run', () => {
    expect(evidenceLead(OFF)).toBe(`Round trips is the whole range above: Linked wallets has not run. ${apart}`);
  });
});

describe('summary', () => {
  it('states the strict count, then what following the money adds', () => {
    expect(summary(DEMO)).toBe('10 of 56 sales are round trips between the same wallets. Counting buyers and sellers linked by money, up to 14 are.');
  });

  it('counts Linked wallets only in its money sentence', () => {
    const t = { A: totals({ sales: 100, flaggedSales: 10 }), AU: totals({ sales: 100, flaggedSales: 70 }), AC: totals({ sales: 100, flaggedSales: 40 }) };
    const said = summary(t);
    expect(said).toContain('up to 40 are');
    expect(said).not.toContain('70');
  });

  it('says money links were not checked when no money lens ran', () => {
    expect(summary(OFF)).toMatch(/not checked/);
  });
});

function row(more: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1, chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, cursorBlock: 1_000, headBlock: 1_000,
    addedAt: 0, ingestedAt: 0, error: null, errorAt: null, transfers: 10, wallets: 80, fundedWallets: 80, stale: false,
    latest: { id: 1, ranAt: 0, tookMs: 1, throughBlock: 1_000, totals: DEMO, missingData: 0, fundedWallets: 80, wallets: 80, truncatedSearches: 0, loops: null, rings: null },
    servedAt: null, readRate: null, priority: false, pausedAt: null, rules: {}, contract: null,
    restoreProgress: null, restoreNote: null, restoreNoteKey: null, restoreRetryAt: null, analysisError: null, analysisRetryAt: null, storedThroughTime: null, storedThroughBlock: null, trailImportedSha: null, trailNote: null, trailProgress: null,
    downloadFile: null, downloadProgress: null, downloadNote: null, downloadRetryAt: null, downloadMismatch: null, readTokens: false, ...more,
  };
}

/** Coverage of a row on Ethereum with an RPC set, so the stored-only reading never applies. */
const ON = new Set([1]);
const cov = (c: CollectionRow) => coverage(c, ON, 0);

describe('coverage', () => {
  it('is complete at the finalized head with every wallet checked', () => {
    const c = cov(row());
    expect(c.reading).toBe('complete');
    expect(c.notFinal).toEqual([]);
  });

  it('marks the money lenses as floors while wallets are still being checked', () => {
    const c = cov(row({ fundedWallets: 20 }));
    expect(c.reading).toBe('checking');
    expect(c.notFinal).toEqual(['AU', 'AC']);
  });

  it('is loading stored data while a load runs, with how far it has got', () => {
    const c = cov(row({ cursorBlock: null, startBlock: null, restoreProgress: 0.42 }));
    expect(c.reading).toBe('restoring');
    expect(c.label).toBe('Loading stored data · 42%');
    expect(cov(row({ restoreProgress: 0.42, pausedAt: 5 })).reading).toBe('paused');
  });

  it('reads downloading while its transfers download, before restoring', () => {
    const c = cov(row({ cursorBlock: null, startBlock: null, downloadFile: 'transfers', downloadProgress: 0.416, restoreProgress: 0.1 }));
    expect(c.reading).toBe('downloading');
    expect(c.label).toBe('Downloading stored data · 41%');
    expect(c.download).toBe(0.416);
  });

  it('a paused collection never reads downloading', () => {
    expect(cov(row({ downloadFile: 'transfers', downloadProgress: 0.4, pausedAt: 5 })).reading).toBe('paused');
    expect(cov(row({ downloadFile: 'transfers', downloadProgress: 0.4, pausedAt: 5 })).download).toBeNull();
  });

  it('reads a collection held for a download that has not started as waiting, not as starting', () => {
    // The worker marks it with the file and no progress; its start block is not known, as it is read from the stored data.
    const c = cov(row({ cursorBlock: null, startBlock: null, downloadFile: 'transfers', downloadProgress: null }));
    expect(c.reading).toBe('queued');
    expect(c.label).toBe('Waiting to download stored data');
    expect(c.download).toBeNull();
    expect(cov(row({ downloadFile: 'transfers', downloadProgress: null, pausedAt: 5 })).reading).toBe('paused');
    expect(cov(row({ downloadFile: 'trail', downloadProgress: null })).reading).not.toBe('queued');
    expect(analysisWaitText(row({ latest: null, transfers: 0, downloadFile: 'transfers', downloadProgress: null }), undefined, new Map(), ON, 0)).toBe('Waiting to download stored data · it is analyzed once it has loaded.');
  });

  it('a trail download is no reading of its own', () => {
    const c = cov(row({ downloadFile: 'trail', downloadProgress: 0.4 }));
    expect(c.reading).toBe('complete');
    expect(c.download).toBeNull();
  });

  it('says it waits for a download before the first analysis', () => {
    expect(analysisWaitText(row({ latest: null, transfers: 0, downloadFile: 'transfers', downloadProgress: 0.1 }), undefined, new Map(), ON, 0)).toBe('Downloading stored data · it is analyzed once it has loaded.');
  });

  it('never shows a load as done before it has committed', () => {
    const c = cov(row({ restoreProgress: 1 }));
    expect(c.restore).toBe(0.99);
    expect(c.label).toBe('Loading stored data · 99%');
  });

  it('is catching up when far behind the head, whatever the wallets', () => {
    expect(cov(row({ cursorBlock: 500, fundedWallets: 20 })).reading).toBe('catching-up');
  });

  it('is analyzing, not up to date, once every transfer is read but before the first analysis counts the wallets', () => {
    const c = cov(row({ latest: null, wallets: 0, fundedWallets: 0 }));
    expect([c.reading, c.label, c.notFinal]).toEqual(['analyzing', 'Analyzing', []]);
    expect(cov(row({ latest: null, analysisError: 'out of memory' })).label).toBe('First analysis failed');
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
      expect(idle.notFinal).toEqual(['AU', 'AC']);
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

describe('coverage of a silent worker', () => {
  const silent = (c: CollectionRow, rpc: ReadonlySet<number> = ON) => coverage(c, rpc, 0, 'UTC', true, true);

  it('reads a complete collection as silent, never as up to date', () => {
    const c = silent(row());
    expect(c).toMatchObject({ reading: 'silent', label: 'Worker silent · not kept current' });
  });

  it('reads a download as silent and draws no bar for it', () => {
    const c = silent(row({ cursorBlock: null, startBlock: null, downloadFile: 'transfers', downloadProgress: 0.4 }));
    expect(c.reading).toBe('silent');
    expect(c.download).toBeNull();
    expect(silent(row({ restoreProgress: 0.4 })).restore).toBeNull();
  });

  it('keeps the readings that claim no progress', () => {
    expect(silent(row({ pausedAt: 5 })).reading).toBe('paused');
    const stored = row({ startBlock: 100, cursorBlock: 900, headBlock: null, storedThroughTime: Date.UTC(2026, 9, 14), storedThroughBlock: 900, trailProgress: 0.3 });
    const c = silent(stored, new Set());
    expect(c.reading).toBe('stored-only');
    expect(c.label).toMatch(/^Stored data · stops /);
    expect(c.trail).toBeNull();
    expect(c.label).not.toContain(TRAIL_LOADING);
  });
});

describe('coverage of a money trail on its way', () => {
  const stored = (more: Partial<CollectionRow> = {}) => row({ startBlock: 100, cursorBlock: 900, headBlock: null, storedThroughTime: Date.UTC(2026, 9, 14), storedThroughBlock: 900, ...more });

  it('carries the trail share and says so on a stored-only label', () => {
    const c = coverage(stored({ trailProgress: 0.3 }), new Set(), 0);
    expect(c.trail).toBe(0.3);
    expect(c.label.endsWith(TRAIL_LOADING)).toBe(true);
  });

  it('reads a trail download too, and caps it below done', () => {
    expect(cov(row({ downloadFile: 'trail', downloadProgress: 0.4 })).trail).toBe(0.4);
    expect(cov(row({ trailProgress: 1 })).trail).toBe(0.99);
    expect(cov(row({ downloadFile: 'trail', downloadProgress: 0.4 })).label).toBe(`Up to date${TRAIL_LOADING}`);
  });

  it('is null with no trail, for a transfers download, and when paused', () => {
    expect(cov(row()).trail).toBeNull();
    expect(cov(row({ downloadFile: 'transfers', downloadProgress: 0.4 })).trail).toBeNull();
    expect(cov(row({ trailProgress: 0.3, pausedAt: 5 })).trail).toBeNull();
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
    expect(coverage(stored({ cursorBlock: null }), ON, NOW).reading).toBe('starting');
    expect(coverage(stored({ storedThroughTime: null, transfers: 0, cursorBlock: null }), ON, NOW).reading).toBe('starting');
    expect(coverage(stored(), new Set([1]), NOW).stops).toBeNull();
  });
});

describe('coverage of a chain with no RPC, whatever it has read', () => {
  const NONE = new Set<number>();
  const NOW = Date.UTC(2026, 9, 23);
  const bare = (more: Partial<CollectionRow> = {}) => row({ headBlock: null, ...more });

  it('reads stored-only with nothing read, with no stops and no readTo', () => {
    for (const c of [bare({ cursorBlock: null, startBlock: null, transfers: 0, latest: null }), bare({ storedThroughTime: null, transfers: 0, cursorBlock: 99 })]) {
      const v = coverage(c, NONE, NOW);
      expect([v.reading, v.stops, v.readTo, v.label]).toEqual(['stored-only', null, null, 'No RPC for its chain']);
    }
  });
  it('reads stored-only before head-unknown and before catching-up, for history read from the chain', () => {
    expect(coverage(bare({ cursorBlock: 900, transfers: 10 }), NONE, NOW).reading).toBe('stored-only');
    expect(coverage(row({ cursorBlock: 500, headBlock: 1_000_000 }), NONE, NOW).reading).toBe('stored-only');
    expect(coverage(row({ cursorBlock: 500, headBlock: 1_000_000 }), ON, NOW).reading).toBe('catching-up');
  });
  it('still gives way to paused, a load and a download', () => {
    expect(coverage(bare({ pausedAt: 5 }), NONE, NOW).reading).toBe('paused');
    expect(coverage(bare({ restoreProgress: 0.3 }), NONE, NOW).reading).toBe('restoring');
    expect(coverage(bare({ downloadFile: 'transfers', downloadProgress: 0.3 }), NONE, NOW).reading).toBe('downloading');
    expect(coverage(bare({ downloadFile: 'transfers', downloadProgress: null }), NONE, NOW).reading).toBe('queued');
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

describe('analysisWaitText', () => {
  const NOW = 100 * 60_000;
  const pass = (more: Partial<PassRow> = {}): PassRow => ({
    job: 'analyze', startedAt: NOW - 2 * 60_000, finishedAt: null, tookMs: null, outcome: null, detail: null, heartbeatAt: NOW, doing: 'Analyzing', subjectId: 1, ...more,
  });
  const names = new Map([[7, 'Terraforms']]);
  const fresh = row({ latest: null });

  it('promises nothing for a paused collection', () => {
    expect(analysisWaitText(row({ latest: null, pausedAt: 1 }), pass(), names, ON, NOW)).toBe('Paused · it is not analyzed until you resume it.');
  });

  it('waits for stored data to load, not for transfers to be read', () => {
    expect(analysisWaitText(row({ latest: null, transfers: 0, restoreProgress: 0.1 }), undefined, names, ON, NOW)).toBe('Loading stored data · it is analyzed once it has loaded.');
  });

  it('waits for transfers when none are read', () => {
    expect(analysisWaitText(row({ latest: null, transfers: 0 }), undefined, names, ON, NOW)).toBe('Waiting for its first transfers.');
  });

  it('says nothing is read while its chain has no RPC, but not once it has transfers', () => {
    expect(analysisWaitText(row({ latest: null, transfers: 0 }), undefined, names, new Set(), NOW)).toBe('Nothing is read until its chain has an RPC.');
    expect(analysisWaitText(row({ latest: null, transfers: 5 }), undefined, names, new Set(), NOW)).toBe('Waiting for its first analysis · the next pass starts within a minute.');
  });

  it('says its own first analysis is running', () => {
    expect(analysisWaitText(fresh, pass(), names, ON, NOW)).toBe('First analysis running · started 2 min ago.');
  });

  it('names the collection it is queued behind', () => {
    expect(analysisWaitText(fresh, pass({ subjectId: 7, startedAt: NOW - 14 * 60_000 }), names, ON, NOW))
      .toBe('Waiting for its first analysis · queued behind Terraforms (running 14 min).');
  });

  it('says the next pass is near when none is running', () => {
    expect(analysisWaitText(fresh, undefined, names, ON, NOW)).toBe('Waiting for its first analysis · the next pass starts within a minute.');
    expect(analysisWaitText(fresh, pass({ finishedAt: NOW - 1_000 }), names, ON, NOW)).toBe('Waiting for its first analysis · the next pass starts within a minute.');
  });

  it('says its analysis failed and when it is tried again, never that the next pass is near', () => {
    const at = NOW + 20 * 60_000;
    const failing = row({ latest: null, analysisError: 'out of memory', analysisRetryAt: at });
    const said = `Its analysis failed: out of memory · it is tried again after ${localTime(at, 'time', 'Asia/Tokyo', 'en-GB')}.`;
    expect(analysisWaitText(failing, undefined, names, ON, NOW, 'Asia/Tokyo')).toBe(said);
    // Queued behind another collection, the failure is still what holds it.
    expect(analysisWaitText(failing, pass({ subjectId: 7 }), names, ON, NOW, 'Asia/Tokyo')).toBe(said);
    expect(analysisWaitText(row({ latest: null, analysisError: 'out of memory', analysisRetryAt: NOW - 1 }), undefined, names, ON, NOW)).toBe('Its analysis failed: out of memory · it is due to be tried again.');
    // Being tried again now.
    expect(analysisWaitText(failing, pass(), names, ON, NOW)).toBe('First analysis running · started 2 min ago.');
  });

  it('claims no download, load or analysis while the worker is silent, but still says a pause', () => {
    const said = 'Not analyzed yet · the worker is silent, so nothing is read or analyzed until it reports again.';
    expect(analysisWaitText(row({ latest: null, transfers: 0, downloadFile: 'transfers', downloadProgress: 0.4 }), undefined, names, ON, NOW, 'UTC', true)).toBe(said);
    expect(analysisWaitText(row({ latest: null, transfers: 0, restoreProgress: 0.1 }), undefined, names, ON, NOW, 'UTC', true)).toBe(said);
    // A stalled pass on it is not an analysis running.
    expect(analysisWaitText(fresh, pass({ startedAt: NOW - 47 * 60_000, heartbeatAt: NOW - 40 * 60_000 }), names, ON, NOW, 'UTC', true)).toBe(said);
    expect(analysisWaitText(fresh, undefined, names, ON, NOW, 'UTC', true)).toBe(said);
    expect(analysisWaitText(row({ latest: null, pausedAt: 1 }), undefined, names, ON, NOW, 'UTC', true)).toBe('Paused · it is not analyzed until you resume it.');
  });

  it('knows which collection the running analyze pass is on', () => {
    const other = pass({ job: 'ingest', subjectId: 9 });
    expect(analyzingOn([other, pass({ subjectId: 3 })], 3)).toBe(true);
    expect(analyzingOn([pass({ subjectId: 3 })], 4)).toBe(false);
    expect(analyzingOn([pass({ subjectId: 3, finishedAt: NOW })], 3)).toBe(false);
    expect(analyzingOn([pass({ job: 'ingest', subjectId: 3 })], 3)).toBe(false);
    expect(analyzingOn([], 3)).toBe(false);
  });

  it('knows a pass is running only until it finishes', () => {
    expect(isRunning(pass())).toBe(true);
    expect(isRunning(pass({ finishedAt: NOW }))).toBe(false);
    expect(isRunning(pass({ finishedAt: NOW - 10 * 60_000 }))).toBe(true);
  });
});

describe('formatBytes', () => {
  it('says 12.3 MB and 3.4 GB', () => {
    expect(formatBytes(12_300_000)).toBe('12.3 MB');
    expect(formatBytes(3_400_000_000)).toBe('3.4 GB');
    expect(formatBytes(999_000_000)).toBe('999.0 MB');
  });

  it('never says 0.0 MB for a file that is there', () => {
    expect(formatBytes(4_000)).toBe('<0.1 MB');
  });
});

describe('judged', () => {
  it('is true only for a transfer an analysis ran through', () => {
    expect(judged({ blockNumber: 10 }, { throughBlock: 10 })).toBe(true);
    expect(judged({ blockNumber: 11 }, { throughBlock: 10 })).toBe(false);
    expect(judged({ blockNumber: 1 }, null)).toBe(false);
    expect(judged({ blockNumber: 1 }, { throughBlock: null })).toBe(false);
  });
});

describe('ranFlags', () => {
  const w = { kind: 'scc', wallets: [], cycles: 2 } as never;
  const t = { flags: { A: w, AU: w, AC: w } };
  const latest = (ran: Method[]) => ({ totals: Object.fromEntries((['A', 'AU', 'AC'] as Method[]).map((m) => [m, totals({ available: ran.includes(m) })])) as Record<Method, MethodTotals> });

  it('drops flags copied into lenses that did not run', () => {
    expect(Object.keys(ranFlags(t, latest(['A'])).flags)).toEqual(['A']);
  });
  it('leaves flags alone when every lens ran', () => {
    expect(ranFlags(t, latest(['A', 'AU', 'AC'])).flags).toEqual(t.flags);
  });
  it('keeps none without an analysis', () => {
    expect(ranFlags(t, null).flags).toEqual({});
  });
});

describe('lensesRan', () => {
  it('is the lenses whose totals ran, in lens order', () => {
    expect(lensesRan({ totals: OFF } as never)).toEqual(['A']);
    expect(lensesRan({ totals: DEMO } as never)).toEqual(['A', 'AU', 'AC']);
  });
  it('is none without an analysis', () => {
    expect(lensesRan(null)).toEqual([]);
  });
});

describe('your lenses', () => {
  const lens = (id: number, name: string) => ({ id, key: `L${id}` as const, name, rule: DEFAULT_RULE, version: 1, createdAt: 0, updatedAt: 0 });
  const run = (totals: object | null) => ({ lensId: 1, collectionId: 1, status: 'done', totals }) as unknown as LensRun;
  const runs = [{ lens: lens(7, 'Blur 3-hop'), run: run({}) }, { lens: lens(9, 'Slow flips'), run: run(null) }, { lens: lens(11, 'Never run'), run: null }];

  it('ownRan keeps only the keys with a finished run', () => {
    expect(ownRan(runs)).toEqual(['L7']);
  });

  it('ownLenses names every lens, in the own hue, with its rule in words', () => {
    expect(ownLenses(runs)).toEqual({
      L7: { name: 'Blur 3-hop', tone: 'own', says: ruleLine(DEFAULT_RULE) },
      L9: { name: 'Slow flips', tone: 'own', says: ruleLine(DEFAULT_RULE) },
      L11: { name: 'Never run', tone: 'own', says: ruleLine(DEFAULT_RULE) },
    });
  });

  it('lensContext reads the lenses that ran and, for each of yours with figures, the block its run read through', () => {
    const latest = { totals: { A: { available: true }, AU: { available: false }, AC: { available: true } } } as never;
    const through = [{ lens: lens(7, 'Blur 3-hop'), run: { ...run({}), throughBlock: 90 } }, { lens: lens(8, 'Whole'), run: { ...run({}), throughBlock: null } }, ...runs.slice(1)];
    expect(lensContext(latest, through)).toEqual({ ran: ['A', 'AC', 'L7', 'L8'], through: { L7: 90, L8: null } });
    expect(lensContext(null, [])).toEqual({ ran: [], through: {} });
  });

  describe('chartLenses (the over-time chart draws at most three of yours)', () => {
    const at = (id: number, finishedAt: number | null, totals: object | null = {}) => ({ lens: lens(id, `Lens ${id}`), run: { ...run(totals), finishedAt, throughBlock: 100 } });
    const five = [at(1, 10), at(2, 50), at(3, 30), at(4, 40), at(5, 20)];

    it('takes the most recently run three, and names the rest as left out', () => {
      const { drawn, left } = chartLenses(five, 'A');
      expect(drawn.map((o) => o.lens.key)).toEqual(['L2', 'L4', 'L3']);
      expect(left.map((o) => o.lens.key)).toEqual(['L5', 'L1']);
    });

    it('puts the selected lens first, whatever its age', () => {
      expect(chartLenses(five, 'L1').drawn.map((o) => o.lens.key)).toEqual(['L1', 'L2', 'L4']);
    });

    it('a lens with no figures is neither drawn nor left out: it is not run', () => {
      const { drawn, left, notRun } = chartLenses([at(1, null, null), at(2, 5)], 'L1');
      expect(drawn.map((o) => o.lens.key)).toEqual(['L2']);
      expect(left).toEqual([]);
      expect(notRun.map((o) => o.lens.key)).toEqual(['L1']);
    });
  });
});

describe('judgedBy', () => {
  it('judgedBy: a lens of yours judged a trade only through its run\'s block; a built-in, every trade the analysis judged', () => {
    const row = (blockNumber: number, judged = true) => ({ blockNumber, judged });
    expect(judgedBy(row(10), 'L7', { L7: 10 })).toBe(true);
    expect(judgedBy(row(11), 'L7', { L7: 10 })).toBe(false);
    expect(judgedBy(row(11), 'L7', { L7: null })).toBe(true);
    expect(judgedBy(row(11), 'L7', {})).toBe(true);
    expect(judgedBy(row(11), 'A', { L7: 10 })).toBe(true);
    expect(judgedBy(row(5, false), 'L7', { L7: 10 })).toBe(false);
    expect(judgedBy(row(5, false), 'A', {})).toBe(false);
  });
});
