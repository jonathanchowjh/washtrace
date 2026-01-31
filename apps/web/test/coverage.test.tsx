import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CollectionRow } from '@washtrace/detect';
import { ReadingPanel, ReadingPill, ReadingSummary } from '@/components/coverage';
import { localTime } from '@/lib/format';
import { coverage } from '@/lib/metrics';
import { LensCards } from '@/components/methods';

afterEach(cleanup);

/** Ethereum has an RPC, so only the stored-data tests see the stored-only reading. */
const ON = new Set([1]);

const row = (more: Partial<CollectionRow> = {}) => ({
  id: 1, chainId: 1, address: '0xabc', name: 'Demo', startBlock: 1, cursorBlock: 10, headBlock: 10, transfers: 5,
  wallets: 0, fundedWallets: 0, latest: null, error: null, stale: false, pausedAt: null, priority: false, ...more,
}) as unknown as CollectionRow;

function panel(c: CollectionRow) {
  return render(<ReadingPanel c={c} cov={coverage(c, ON, 0)} why="Waiting" rpcChains={ON} />).container;
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
    const a = render(<ReadingPanel c={c} cov={coverage(c, ON, 0)} why="Waiting" rpcChains={ON} />).container;
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
  const NONE = new Set<number>();
  // The reader's zone, pinned so the date reads the same anywhere.
  beforeEach(() => { document.cookie = 'washtrace_tz=UTC; path=/'; });
  // Drawn by Time in the reader's locale, so the date comes from the same formatter, never hard-coded.
  const DAY = localTime(Date.UTC(2026, 9, 14), 'date', 'UTC');
  // Restored with no RPC: a cursor at the stored throughBlock, no head, and the worker's old "No RPC" error.
  const stored = (more: Partial<CollectionRow> = {}) => row({
    startBlock: 100, cursorBlock: 900, headBlock: null, transfers: 76_054, storedThroughTime: Date.UTC(2026, 9, 14), storedThroughBlock: 900,
    error: 'No RPC is configured for chain 1. Set it in Settings, or WASHTRACE_RPC_1 for the worker.', ...more,
  });
  const analysed = { ranAt: 0, tookMs: 1, throughBlock: 900, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 0, wallets: 0, truncatedSearches: 0 } as unknown as CollectionRow['latest'];
  const summaryOf = (c: CollectionRow) => render(<ReadingSummary c={c} cov={coverage(c, NONE, NOW)} href="#reading" />).container.textContent!;
  const panelOf = (c: CollectionRow) => render(<ReadingPanel c={c} cov={coverage(c, NONE, NOW)} why="Waiting" rpcChains={NONE} />).container;

  it('leads the page with where the data stops, never with finding where it begins', () => {
    const text = summaryOf(stored({ latest: analysed }));
    expect(text).toContain('Stored data');
    expect(text).toContain(`stops ${DAY}`);
    expect(text).toContain('9 days unsynced');
    expect(text).not.toContain('Finding where the collection begins');
    expect(text).not.toContain('no numbers yet');
  });

  it('says in step 1 how many transfers came from stored data and through which block, with no fault', () => {
    const el = panelOf(stored());
    expect(el.textContent).toContain(`76,054 transfers from stored data, through block 900 (${DAY})`);
    expect(el.textContent).not.toContain('Last read failed');
    expect(el.textContent).not.toContain('head not known yet');
    expect(el.textContent).not.toContain('Finding');
    expect(el.querySelector('.text-fault')).toBeNull();
  });

  it('shows no fault for a paused one either', () => {
    const el = panelOf(stored({ pausedAt: 5 }));
    expect(el.textContent).not.toContain('Last read failed');
    expect(el.querySelector('.text-fault')).toBeNull();
  });

  it('keeps the pill short and neutral, its words one piece with single spaces', () => {
    const el = render(<ReadingPill cov={coverage(stored(), NONE, NOW)} />).container;
    const pill = el.firstElementChild!;
    expect(pill.textContent).toBe('Stored data · 9 days unsynced');
    expect(pill.className).toContain('text-muted-foreground');
    expect(pill.className).not.toMatch(/text-(fault|ok|focus)/);
    // One text item beside the dot: an inline-flex gap between pieces read as a double space.
    expect(pill.children).toHaveLength(2);
  });

  it('says the block it was read to, with no stored date, once read past the stored data', () => {
    const past = stored({ cursorBlock: 1_250_000, latest: analysed });
    const text = summaryOf(past);
    expect(text).toContain('Read to block 1,250,000');
    expect(text).not.toContain('stops');
    expect(text).not.toContain(DAY);
    const panelText = panelOf(past).textContent!;
    expect(panelText).toContain('76,054 transfers · read to block 1,250,000 · no RPC for its chain');
    expect(panelText).not.toContain(DAY);
    expect(render(<ReadingPill cov={coverage(past, NONE, NOW)} />).container.textContent).toBe('No RPC for its chain');
  });
});

describe('ReadingPill layout', () => {
  it('wraps within its column rather than running past it, the dot on the first line', () => {
    const labels = [
      row({ cursorBlock: null, startBlock: null, restoreProgress: 0.42 }),
      row({ pausedAt: 5, cursorBlock: 1_234_567 }),
      row({ startBlock: 100, cursorBlock: 900, headBlock: null, storedThroughTime: Date.UTC(2025, 9, 9), storedThroughBlock: 900 }),
      row({ startBlock: 100, cursorBlock: 1_250_000, headBlock: null, storedThroughTime: Date.UTC(2025, 9, 9), storedThroughBlock: 900 }),
    ];
    for (const c of labels) {
      const pill = render(<ReadingPill cov={coverage(c, new Set(), Date.UTC(2026, 9, 24))} />).container.firstElementChild!;
      expect(pill.className).not.toContain('whitespace-nowrap');
      expect(pill.className).toContain('max-w-full');
      expect(pill.className).toContain('items-start');
      cleanup();
    }
  });
});

describe('a money trail loaded from stored data', () => {
  const totals = (available: boolean) => ({
    A: { available: true }, AU: { available }, AC: { available },
  }) as unknown as NonNullable<CollectionRow['latest']>['totals'];
  const analysed = (available: boolean) => ({
    ranAt: 0, tookMs: 1, throughBlock: 10, totals: totals(available), missingData: 0, fundedWallets: 1_612, wallets: 11_259, truncatedSearches: 0,
  }) as unknown as CollectionRow['latest'];
  const loaded = (more: Partial<CollectionRow> = {}) => row({ trailImportedSha: 'feed', wallets: 11_259, fundedWallets: 1_612, latest: analysed(true), ...more });
  const panelOf = (c: CollectionRow, funding: boolean, trail: { checked: number; of: number } | null) =>
    render(<ReadingPanel c={c} cov={coverage(c, ON, 0)} why="Waiting" rpcChains={ON} funding={funding} trail={trail} />).container;

  it('says in step 2 that the trail loaded, and how many traders it checked', () => {
    const text = panelOf(loaded(), true, { checked: 1_612, of: 11_259 }).textContent!;
    expect(text).toContain('Money trail loaded from stored data · 1,612 of 11,259 traders checked');
  });

  it('leaves the numbers out when the manifest no longer describes the trail that loaded', () => {
    const text = panelOf(loaded(), true, null).textContent!;
    expect(text).toContain('Money trail loaded from stored data');
    expect(text).not.toContain('traders checked');
  });

  it('never says no funding source is set while the trail feeds the money lenses, and says what a key adds', () => {
    for (const c of [loaded(), loaded({ latest: analysed(false) })]) {
      const text = panelOf(c, false, { checked: 1_612, of: 11_259 }).textContent!;
      expect(text).not.toMatch(/no funding source/i);
      expect(text).toContain('Using the stored money trail; add an Etherscan key to check newer wallets');
    }
    const link = [...panelOf(loaded(), false, null).querySelectorAll('a')].find((a) => a.textContent!.includes('Etherscan key'));
    expect(link?.getAttribute('href')).toBe('/settings#etherscan.key');
  });

  it('says nothing of a trail when none loaded', () => {
    const text = panelOf(row({ latest: analysed(false) }), false, null).textContent!;
    expect(text).not.toContain('Money trail');
    expect(text).toContain('No funding source is set');
  });

  it('shows why a trail on disk was not loaded as information, not a fault', () => {
    const note = 'Money trail on disk does not match the stored data, so it was not loaded.';
    const el = panelOf(row({ trailNote: note }), true, null);
    const line = [...el.querySelectorAll('p')].find((p) => p.textContent === note)!;
    expect(line).toBeTruthy();
    expect(line.className).toContain('text-muted-foreground');
    expect(line.className).not.toContain('text-fault');
  });

  it('keeps a money lens that has not run on the trail yet from saying no funding source is set', () => {
    const t = (available: boolean) => ({ available, sales: 0, flaggedSales: 0, flaggedVolumeWei: '0', volumeWei: '0', tokens: 0, wallets: 0, transfers: 0, flagged: 0, owners: 0, flaggedOwners: 0 });
    const all = { A: t(true), AU: t(false), AC: t(false) } as unknown as NonNullable<CollectionRow['latest']>['totals'];
    const cards = (trail: boolean) => render(<LensCards totals={all} selected="A" href={() => '#'} floor={[]} trail={trail}>{null}</LensCards>).container.textContent!;
    expect(cards(true)).not.toMatch(/no funding source/i);
    expect(cards(true)).toContain('The stored money trail is loaded');
    expect(cards(false)).toMatch(/no funding source is set/i);
  });
});
