import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionRow } from '@washtrace/detect';
import { ReadingPanel, ReadingPill, ReadingSummary } from '@/components/coverage';
import { coverage } from '@/lib/metrics';

afterEach(cleanup);

/** Ethereum has an RPC, so only the stored-data tests see the stored-only reading. */
const ON = new Set([1]);

const row = (more: Partial<CollectionRow> = {}) => ({
  id: 1, chainId: 1, address: '0xabc', name: 'Demo', startBlock: 1, cursorBlock: 10, headBlock: 10, transfers: 5,
  wallets: 0, fundedWallets: 0, latest: null, error: null, stale: false, pausedAt: null, priority: false, ...more,
}) as unknown as CollectionRow;

function panel(c: CollectionRow) {
  return render(<ReadingPanel c={c} cov={coverage(c, ON, 0)} why="Waiting" />).container;
}

describe('ReadingPanel step 1', () => {
  it('says a caught-up paused collection was read when paused', () => {
    expect(panel(row({ pausedAt: 5 })).textContent).toContain('5 transfers · read to block 10 when paused');
  });

  it('says a never-read paused collection is not read yet', () => {
    const text = panel(row({ pausedAt: 5, transfers: 0, cursorBlock: 0 })).textContent!;
    expect(text).toContain('Not read yet · paused');
    expect(text).not.toContain('unread');
  });

  it('never prints "0 blocks unread" when the head is unknown', () => {
    const text = panel(row({ headBlock: null, transfers: 0, cursorBlock: 0 })).textContent!;
    expect(text).toContain('head not known yet');
    expect(text).not.toContain('0 blocks');
  });
});

describe('loading stored data', () => {
  it('leads the page with how far the load has got, as a bar', () => {
    const c = row({ cursorBlock: null, startBlock: null, restoreProgress: 0.42 });
    const text = render(<ReadingSummary c={c} cov={coverage(c, ON, 0)} href="#reading" />).container.textContent!;
    expect(text).toContain('42%');
    expect(text).toContain('Loading stored data');
    expect(panel(c).textContent).toContain('Loading stored data · 42%');
  });

  it('says why stored data was not loaded beside step 1, as information and not a fault', () => {
    const note = 'Stored data could not be loaded (checksum differs); reading from the chain instead.';
    const el = panel(row({ restoreNote: note }));
    const line = [...el.querySelectorAll('p')].find((p) => p.textContent === note)!;
    expect(line).toBeTruthy();
    expect(line.className).not.toContain('text-fault');
  });
});

describe('bars', () => {
  it('are never green for a paused collection, whatever the share', () => {
    const c = row({ pausedAt: 5 });
    const a = render(<ReadingPanel c={c} cov={coverage(c, ON, 0)} why="Waiting" />).container;
    const b = render(<ReadingSummary c={c} cov={coverage(c, ON, 0)} href="#reading" />).container;
    expect(a.querySelector('.bg-ok')).toBeNull();
    expect(b.querySelector('.bg-ok')).toBeNull();
  });

  it('are green once a live collection is fully read', () => {
    const c = row();
    expect(render(<ReadingSummary c={c} cov={coverage(c, ON, 0)} href="#reading" />).container.querySelector('i.bg-ok')).not.toBeNull();
  });
});

describe('stored data with no RPC', () => {
  const NOW = Date.UTC(2026, 9, 23);
  // The reader's zone, pinned so the date reads the same anywhere.
  beforeEach(() => { document.cookie = 'washtrace_tz=UTC; path=/'; });
  // Restored with no RPC: a cursor at the stored throughBlock, no head, and the worker's old "No RPC" error.
  const stored = (more: Partial<CollectionRow> = {}) => row({
    startBlock: 100, cursorBlock: 900, headBlock: null, transfers: 76_054, storedThroughTime: Date.UTC(2026, 9, 14),
    error: 'No RPC is configured for chain 1. Set it in Settings, or WASHTRACE_RPC_1 for the worker.', ...more,
  });
  const analysed = { ranAt: 0, tookMs: 1, throughBlock: 900, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 0, wallets: 0, truncatedSearches: 0 } as unknown as CollectionRow['latest'];

  it('leads the page with where the data stops, never with finding where it begins', () => {
    const c = stored({ latest: analysed });
    const text = render(<ReadingSummary c={c} cov={coverage(c, new Set(), NOW)} href="#reading" />).container.textContent!;
    expect(text).toContain('Stored data');
    expect(text).toContain('stops 14 Oct 2026');
    expect(text).toContain('9 days unsynced');
    expect(text).not.toContain('Finding where the collection begins');
    expect(text).not.toContain('no numbers yet');
  });

  it('says in step 1 how many transfers came from stored data and through which block, with no fault', () => {
    const c = stored();
    const el = render(<ReadingPanel c={c} cov={coverage(c, new Set(), NOW)} why="Waiting" />).container;
    expect(el.textContent).toContain('76,054 transfers from stored data, through block 900 (14 Oct 2026)');
    expect(el.textContent).not.toContain('Last read failed');
    expect(el.textContent).not.toContain('head not known yet');
    expect(el.textContent).not.toContain('Finding');
    expect(el.querySelector('.text-fault')).toBeNull();
  });

  it('shows a neutral pill with the stop date', () => {
    const el = render(<ReadingPill cov={coverage(stored(), new Set(), NOW)} />).container;
    expect(el.textContent).toBe('Stored data · stops 14 Oct 2026 · 9 days unsynced');
    const pill = el.firstElementChild!;
    expect(pill.className).toContain('text-muted-foreground');
    expect(pill.className).not.toMatch(/text-(fault|ok|focus)/);
  });
});
