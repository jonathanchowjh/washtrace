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

describe('a collection read before whose head is not known now', () => {
  // Restored, and its chain's RPC failed before saying where the head is.
  const c = row({ startBlock: 100, cursorBlock: 900, headBlock: null, transfers: 10, storedThroughTime: Date.UTC(2026, 9, 14), error: 'HTTP request failed. Status: 429' });

  it('says what was read, never that it is starting or has no numbers', () => {
    const summary = render(<ReadingSummary c={c} cov={coverage(c, ON, 0)} href="#reading" />).container.textContent!;
    const panelText = panel(c).textContent!;
    for (const text of [summary, panelText]) {
      expect(text).not.toContain('Finding where the collection begins');
      expect(text).not.toContain('no numbers yet');
      expect(text).toContain('block 900');
    }
    // The error says why.
    expect(panelText).toContain('Last read failed: HTTP request failed. Status: 429');
    expect(render(<ReadingPill cov={coverage(c, ON, 0)} />).container.textContent).toBe('Read to block 900');
  });
});

describe('ReadingPanel step 1', () => {
  it('says the error of a paused collection as information, from before the pause', () => {
    const el = panel(row({ pausedAt: 5, error: 'RPC timed out' }));
    expect(el.textContent).toContain('Paused · last error before the pause: RPC timed out');
    expect(el.querySelector('.text-fault')).toBeNull();
  });

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

  const NOTE = 'Stored data could not be loaded: its file does not match the manifest.';
  const said = (el: HTMLElement) => [...el.querySelectorAll('p')].find((p) => p.textContent!.startsWith(NOTE))!;

  it('says why stored data was not loaded beside step 1, as information and not a fault, and that the chain is read meanwhile', () => {
    const line = said(panel(row({ restoreNote: NOTE })));
    expect(line.textContent).toBe(`${NOTE} Reading from the chain instead; it is tried again when its stored file or the manifest changes.`);
    expect(line.className).not.toContain('text-fault');
  });

  it('never claims the chain is read when its chain has no RPC: says what will make the stored data load', () => {
    const NONE = new Set<number>();
    const c = row({ cursorBlock: null, startBlock: null, headBlock: null, transfers: 0, restoreNote: NOTE });
    const line = said(render(<ReadingPanel c={c} cov={coverage(c, NONE, 0)} why="Waiting" rpcChains={NONE} />).container);
    expect(line.textContent).toBe(`${NOTE} It is tried again when its stored file or the manifest changes.`);
    expect(line.textContent).not.toContain('chain');
  });

  it('says when a load the store failed is tried again, in the reader\'s zone', () => {
    document.cookie = 'washtrace_tz=UTC; path=/';
    const at = Date.UTC(2026, 9, 23, 14, 35);
    const line = [...panel(row({ restoreNote: 'Stored data could not be loaded.', restoreRetryAt: at })).querySelectorAll('p')].find((p) => p.textContent!.startsWith('Stored data could not'))!;
    expect(line.textContent).toBe(`Stored data could not be loaded. Reading from the chain instead; it is tried again after ${localTime(at, 'time', 'UTC')}.`);
  });

  it('says only why on a paused collection: nothing is read or tried until it is resumed', () => {
    expect(said(panel(row({ restoreNote: NOTE, pausedAt: 5 }))).textContent).toBe(NOTE);
  });
});

describe('a collection whose latest analysis failed', () => {
  beforeEach(() => { document.cookie = 'washtrace_tz=UTC; path=/'; });
  const NOW = Date.UTC(2026, 9, 23, 14, 15);
  const at = NOW + 20 * 60_000;
  const analysed = { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 0, wallets: 0, truncatedSearches: 0 } as unknown as CollectionRow['latest'];
  const step3 = (c: CollectionRow) => {
    const el = render(<ReadingPanel c={c} cov={coverage(c, ON, NOW)} why="Waiting" rpcChains={ON} now={NOW} />).container;
    return el.querySelectorAll('li')[2]!;
  };
  const failed = (el: Element) => [...el.querySelectorAll('p')].find((p) => /^(Latest analysis|Paused · latest analysis)/.test(p.textContent!))!;

  it('says the numbers shown stand, that the latest run failed and why, and when it is tried again, as a fault', () => {
    const li = step3(row({ latest: analysed, stale: true, analysisError: 'out of memory', analysisRetryAt: at }));
    expect(li.textContent).not.toContain('new data waiting for the next run');
    expect(li.textContent).toContain('took 1 ms · still shown: the latest analysis failed');
    const line = failed(li);
    expect(line.textContent).toBe(`Latest analysis failed: out of memory · tried again after ${localTime(at, 'time', 'UTC')}.`);
    expect(line.className).toContain('text-fault');
  });

  it('says it is due once its wait is over, and promises no retry while paused', () => {
    expect(failed(step3(row({ latest: analysed, stale: true, analysisError: 'out of memory', analysisRetryAt: NOW - 1 }))).textContent)
      .toBe('Latest analysis failed: out of memory · due to be tried again.');
    cleanup();
    const paused = failed(step3(row({ latest: analysed, stale: true, analysisError: 'out of memory', analysisRetryAt: at, pausedAt: 5 })));
    expect(paused.textContent).toBe('Paused · latest analysis before the pause failed: out of memory');
    expect(paused.className).not.toContain('text-fault');
  });
});

describe('a collection read to its head before its first analysis', () => {
  it('is analyzing, its wallets not yet counted', () => {
    const c = row();
    const summary = render(<ReadingSummary c={c} cov={coverage(c, ON, 0)} href="#reading" />).container.textContent!;
    expect(summary).toContain('Analyzing');
    expect(panel(c).textContent).toContain('Counted by the first analysis.');
  });

  it('says a failed first analysis failed, never that it is analyzing', () => {
    const c = row({ analysisError: 'out of memory' });
    const cov = coverage(c, ON, 0);
    expect(cov.label).toBe('First analysis failed');
    const summary = render(<ReadingSummary c={c} cov={cov} href="#reading" />).container.textContent!;
    expect(summary).toContain('Failed');
    expect(summary).not.toContain('Analyzing');
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

  it('are green once a live collection is fully read and analysed', () => {
    const c = row({ latest: { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 0, wallets: 0, truncatedSearches: 0 } as unknown as CollectionRow['latest'] });
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

  it('tells the lens cards\' story in step 2 when the trail checked no wallet and there is no key: not run, not a bar at 0', () => {
    const c = loaded({ latest: analysed(false), fundedWallets: 0 });
    const el = render(<ReadingPanel c={c} cov={coverage(c, ON, 0)} why="Waiting" rpcChains={ON} funding={false} funded={false} trail={null} />).container;
    const text = el.textContent!;
    expect(text).toContain('Off');
    expect(text).toContain('The stored money trail checked no wallet, and no funding source is set (WASHTRACE_ETHERSCAN_KEY).');
    expect(text).not.toContain('0 of 11,259');
    expect(text).not.toContain('Using the stored money trail');
    // Funded by the trail: the count and the bar, as before.
    const ok = render(<ReadingPanel c={loaded()} cov={coverage(loaded(), ON, 0)} why="Waiting" rpcChains={ON} funding={false} funded trail={null} />).container.textContent!;
    expect(ok).toContain('1,612 of 11,259 trading wallets');
  });

  it('never says wallets are being checked when nothing checks them', () => {
    const c = loaded();
    const cov = coverage(c, ON, 0, 'UTC', false);
    const pill = render(<ReadingPill cov={cov} />).container;
    expect(pill.querySelector('.animate-pulse')).toBeNull();
    const text = render(<ReadingSummary c={c} cov={cov} href="#reading" />).container.textContent!;
    expect(text).not.toContain('so far');
    expect(text).not.toContain('every wallet the lenses need');
    expect(text).toContain('Etherscan key');
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
    const cards = (trail: boolean, funded: boolean) =>
      render(<LensCards totals={all} selected="A" href={() => '#'} floor={[]} trail={trail} funded={funded}>{null}</LensCards>).container.textContent!;
    expect(cards(true, true)).not.toMatch(/no funding source/i);
    expect(cards(true, true)).toContain('The stored money trail is loaded');
    expect(cards(true, true)).toContain('the next analysis runs this lens');
    expect(cards(false, false)).toMatch(/no funding source is set/i);
  });

  it('promises a money lens a run only when the next analysis will have funding for it, and otherwise says what is missing', () => {
    const t = (available: boolean) => ({ available, sales: 0, flaggedSales: 0, flaggedVolumeWei: '0', volumeWei: '0', tokens: 0, wallets: 0, transfers: 0, flagged: 0, owners: 0, flaggedOwners: 0 });
    const all = { A: t(true), AU: t(false), AC: t(false) } as unknown as NonNullable<CollectionRow['latest']>['totals'];
    const cards = (trail: boolean, funded: boolean) =>
      render(<LensCards totals={all} selected="A" href={() => '#'} floor={[]} trail={trail} funded={funded}>{null}</LensCards>).container.textContent!;
    // Its trail checked no wallet, and there is no key: nothing to run on.
    const empty = cards(true, false);
    expect(empty).not.toContain('next analysis');
    expect(empty).toContain('The stored money trail checked no wallet');
    expect(empty).toContain('WASHTRACE_ETHERSCAN_KEY');
    // A key set since the last analysis: the next one runs it.
    expect(cards(false, true)).toContain('the next analysis runs this lens');
  });
});

describe('downloading stored data', () => {
  const down = (more: Partial<CollectionRow> = {}) => row({ cursorBlock: null, startBlock: null, downloadFile: 'transfers', downloadProgress: 0.416, ...more });

  it('says it in the pill and the summary, in the working colour', () => {
    const c = down();
    const cov = coverage(c, ON, 0);
    const pill = render(<ReadingPill cov={cov} />).container;
    expect(pill.textContent).toBe('Downloading stored data · 41%');
    expect(pill.querySelector('.text-focus')).not.toBeNull();
    expect(pill.querySelector('.text-fault')).toBeNull();
    expect(pill.querySelector('.animate-pulse')).not.toBeNull();
    const text = render(<ReadingSummary c={c} cov={cov} href="#reading" />).container.textContent!;
    expect(text).toContain('41%');
    expect(text).toContain('of its stored data downloaded from Hugging Face');
  });

  it('a trail download shows on the funding step, not as the reading', () => {
    const c = row({ downloadFile: 'trail', downloadProgress: 0.416 });
    const cov = coverage(c, ON, 0);
    expect(cov.reading).not.toBe('downloading');
    const text = render(<ReadingPanel c={c} cov={cov} why="Waiting" rpcChains={ON} trailBytes={3_400_000_000} />).container.textContent!;
    expect(text).toContain('Money trail downloading from stored data · 41% of 3.4 GB');
    // Without the manifest's size, no size is guessed.
    expect(render(<ReadingPanel c={c} cov={cov} why="Waiting" rpcChains={ON} />).container.textContent).toContain('Money trail downloading from stored data · 41%');
  });

  it('says nothing is downloading when paused, and the note only while it is tried again', () => {
    const note = 'Stored data could not be downloaded. Tried again later.';
    const paused = row({ downloadFile: 'trail', downloadProgress: 0.4, downloadNote: note, pausedAt: 1 });
    const text = render(<ReadingPanel c={paused} cov={coverage(paused, ON, 0)} why="Waiting" rpcChains={ON} />).container.textContent!;
    expect(text).not.toContain('downloading');
    expect(text).not.toContain(note);
    cleanup();
    const failed = row({ downloadNote: note });
    const el = render(<ReadingPanel c={failed} cov={coverage(failed, ON, 0)} why="Waiting" rpcChains={ON} />).container;
    expect(el.textContent).toContain(note);
    expect(el.querySelector('.text-fault')).toBeNull();
  });
});
