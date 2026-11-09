import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRAIL_NOTES, type CollectionRow, type StoredEntry } from '@washtrace/detect';
import { ReadingPill, ReadingSummary, trust } from '@/components/coverage';
import { Pipeline, PipelineErrors, PipelineTable } from '@/components/pipeline';
import { localTime, short } from '@/lib/format';
import { TRAIL_LOADING, coverage, progress } from '@/lib/coverage';
import { APART_WHY } from '@/lib/metrics';
import { pipeline, STATE_WORDS } from '@/lib/pipeline';
import { LensTabs } from '@/components/lens-tabs';
import { TimeChart } from '@/components/trend';

// The chart opens a period through the router.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

type Totals = NonNullable<CollectionRow['latest']>['totals'];
/** The lens tabs of a collection with no lens of yours, the chosen built-in's panel under them. */
const lensTabs = (totals: Totals, selected: 'A' | 'AU' | 'AC', more: { notFinal?: ('A' | 'AU' | 'AC')[]; trail?: boolean; funded?: boolean; coming?: boolean; silent?: boolean } = {}) =>
  render(
    <LensTabs base="/c/1/0xabc" chainId={1} address="0xabc" selected={selected} totals={totals} latestId={1} paused={false} runs={[]} notFinal={more.notFinal ?? []} moneyShort={{}} tokens={{}}
      coverage={{ trail: more.trail ?? false, funded: more.funded ?? false, coming: more.coming ?? false, silent: more.silent ?? false }} writable>{null}</LensTabs>,
  ).container;

/** Ethereum has an RPC, so only the stored-data tests see the stored-only reading. */
const ON = new Set([1]);

const row = (more: Partial<CollectionRow> = {}) => ({
  id: 1, chainId: 1, address: '0xabc', name: 'Demo', startBlock: 1, cursorBlock: 10, headBlock: 10, transfers: 5,
  wallets: 0, fundedWallets: 0, latest: null, error: null, stale: false, pausedAt: null, priority: false, trailProgress: null, analysisError: null,
  storedThroughTime: null, storedThroughBlock: null, downloadFile: null, downloadProgress: null, downloadNote: null,
  restoreProgress: null, restoreNote: null, trailNote: null, trailImportedSha: null, ...more,
}) as unknown as CollectionRow;

/** The manifest's entry for the stored data, as the worker would find it. */
const entry = (more: Partial<StoredEntry> = {}) => ({
  chainId: 1, address: '0xabc', name: 'Demo', startBlock: 1, throughBlock: 500, throughTime: 1,
  transfers: { file: 'transfers.parquet', rows: 5, bytes: 2_000_000_000, sha256: 'abc' }, trail: null, ...more,
}) as StoredEntry;
const TRAIL = { file: 'trail.parquet', rows: 3, bytes: 3_400_000_000, sha256: 'feed', checked: 1_612, of: 11_259, files: { wallets: { bytes: 1, sha256: 'w' }, flows: { bytes: 2, sha256: 'f' } } } as unknown as StoredEntry['trail'];
/** Stored data the chain was read past (cursor 10) with a trail on top: stages 1 and 2 have the trail to do, if any. */
const withTrail = () => entry({ throughBlock: 10, trail: TRAIL });

interface View {
  entry?: StoredEntry | null; rpc?: ReadonlySet<number>; funding?: boolean; funded?: boolean; trail?: { checked: number; of: number } | null;
  trailBytes?: number | null; transfersBytes?: number | null; trailComing?: boolean; now?: number; analyzing?: boolean; silent?: boolean;
  /** What coverage() is told: the pill's clock, and whether a key is set (it says true unless told). */
  covNow?: number; covFunding?: boolean;
}

/** The collection page's six stages for `c`, built the way the page builds them. */
function view(c: CollectionRow, o: View = {}) {
  const rpc = o.rpc ?? ON;
  const funding = o.funding ?? true;
  const stages = pipeline({ c, entry: o.entry ?? null, rpcChains: rpc, funding, analyzing: o.analyzing ?? false, silent: o.silent ?? false });
  return render(
    <Pipeline c={c} stages={stages} cov={coverage(c, rpc, o.covNow ?? 0, 'UTC', o.covFunding ?? true, o.silent ?? false)} why="Waiting" rpcChains={rpc} funding={funding} funded={o.funded}
      trail={o.trail} trailBytes={o.trailBytes} transfersBytes={o.transfersBytes} trailComing={o.trailComing} now={o.now} />,
  ).container;
}

function panel(c: CollectionRow, e: StoredEntry | null = null) {
  return view(c, { entry: e });
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

describe('Pipeline stage 4', () => {
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
    expect(panel(c, entry()).textContent).toContain('Loading stored data · 42%');
  });

  const NOTE = 'Stored data could not be loaded: its file does not match the manifest.';
  const said = (el: HTMLElement) => [...el.querySelectorAll('p')].find((p) => p.textContent!.startsWith(NOTE))!;

  it('says why stored data was not loaded beside stage 2, as information and not a fault, and that the chain is read meanwhile', () => {
    const line = said(panel(row({ restoreNote: NOTE }), entry()));
    expect(line.textContent).toBe(`${NOTE} Reading from the chain instead; it is tried again when its stored file or its manifest entry changes.`);
    expect(line.className).not.toContain('text-fault');
  });

  it('never claims the chain is read when its chain has no RPC: says what will make the stored data load', () => {
    const NONE = new Set<number>();
    const c = row({ cursorBlock: null, startBlock: null, headBlock: null, transfers: 0, restoreNote: NOTE });
    const line = said(view(c, { entry: entry(), rpc: NONE }));
    expect(line.textContent).toBe(`${NOTE} It is tried again when its stored file or its manifest entry changes.`);
    expect(line.textContent).not.toContain('chain');
  });

  it('says when a load the store failed is tried again, in the reader\'s zone', () => {
    document.cookie = 'washtrace_tz=UTC; path=/';
    const at = Date.UTC(2026, 9, 23, 14, 35);
    const c = row({ restoreNote: 'Stored data could not be loaded.', restoreRetryAt: at });
    const lineAt = (now: number) => [...view(c, { entry: entry(), now }).querySelectorAll('p')]
      .find((p) => p.textContent!.startsWith('Stored data could not'))!;
    expect(lineAt(at - 20 * 60_000).textContent).toBe(`Stored data could not be loaded. Reading from the chain instead; it is tried again after ${localTime(at, 'time', 'UTC')}.`);
    // Past that time, before the worker's next pass: not a time already gone.
    expect(lineAt(at + 60_000).textContent).toBe('Stored data could not be loaded. Reading from the chain instead; it is due to be tried again.');
  });

  it('says nothing of the last failure while the load is tried again: the progress says it', () => {
    const text = panel(row({ restoreNote: NOTE, restoreRetryAt: 5, restoreProgress: 0.1 }), entry()).textContent!;
    expect(text).toContain('Loading stored data · 10%');
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain('Reading from the chain instead');
  });

  it('says only why on a paused collection: nothing is read or tried until it is resumed', () => {
    expect(said(panel(row({ restoreNote: NOTE, pausedAt: 5 }), entry())).textContent).toBe(NOTE);
  });
});

describe('a collection whose latest analysis failed', () => {
  beforeEach(() => { document.cookie = 'washtrace_tz=UTC; path=/'; });
  const NOW = Date.UTC(2026, 9, 23, 14, 15);
  const at = NOW + 20 * 60_000;
  const analysed = { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 0, wallets: 0, truncatedSearches: 0 } as unknown as CollectionRow['latest'];
  const stage6 = (c: CollectionRow) => view(c, { covNow: NOW, now: NOW }).querySelectorAll('li')[5]!;
  it('stage 6 says the analysis runs again once the trail is in, not that nothing is new', () => {
    const loading = stage6(row({ latest: analysed, trailProgress: 0.3 })).textContent!;
    expect(loading).toContain('· money trail loading; analyzed again once it has');
    expect(loading).not.toContain('nothing new since');
    cleanup();
    expect(stage6(row({ latest: analysed })).textContent).toContain('· nothing new since');
  });
  it('stage 6 of a paused collection says nothing of a trail loading', () => {
    const text = stage6(row({ latest: analysed, trailProgress: 0.4, pausedAt: 1 })).textContent!;
    expect(text).not.toContain('money trail loading');
    expect(text).toContain('· nothing new since');
  });
  const failed = (el: Element) => [...el.querySelectorAll('p')].find((p) => /^(Latest analysis|Paused · latest analysis)/.test(p.textContent!))!;

  it('says the numbers shown stand, that the latest run failed and why, and when it is tried again, as a fault', () => {
    const li = stage6(row({ latest: analysed, stale: true, analysisError: 'out of memory', analysisRetryAt: at }));
    expect(li.textContent).not.toContain('new data waiting for the next run');
    expect(li.textContent).toContain('took 1 ms · still shown: the latest analysis failed');
    const line = failed(li);
    expect(line.textContent).toBe(`Latest analysis failed: out of memory · tried again after ${localTime(at, 'time', 'UTC')}.`);
    expect(line.className).toContain('text-fault');
  });

  it('says it is due once its wait is over, and promises no retry while paused', () => {
    expect(failed(stage6(row({ latest: analysed, stale: true, analysisError: 'out of memory', analysisRetryAt: NOW - 1 }))).textContent)
      .toBe('Latest analysis failed: out of memory · due to be tried again.');
    cleanup();
    const paused = failed(stage6(row({ latest: analysed, stale: true, analysisError: 'out of memory', analysisRetryAt: at, pausedAt: 5 })));
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
    const a = panel(c);
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
  const panelOf = (c: CollectionRow) => view(c, { rpc: NONE, covNow: NOW });

  it('leads the page with where the data stops, never with finding where it begins', () => {
    const text = summaryOf(stored({ latest: analysed }));
    expect(text).toContain('Stored data');
    expect(text).toContain(`stops ${DAY}`);
    expect(text).toContain('9 days unsynced');
    expect(text).not.toContain('Finding where the collection begins');
    expect(text).not.toContain('no numbers yet');
  });

  it('says in stage 4 how many transfers came from stored data and through which block, with no fault', () => {
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
  const panelOf = (c: CollectionRow, funding: boolean, trail: { checked: number; of: number } | null) => view(c, { entry: withTrail(), funding, trail });

  it('says in stage 2 that the trail loaded, and how many traders it checked', () => {
    const text = panelOf(loaded(), true, { checked: 1_612, of: 11_259 }).textContent!;
    expect(text).toContain('Money trail loaded from stored data · 1,612 of 11,259 traders in the trail checked');
  });

  it('says how many money searches stopped at the visit cap, in plain English', () => {
    expect(panelOf(loaded({ latest: { ...analysed(true)!, truncatedSearches: 18_482 } }), true, null).textContent)
      .toContain('18,482 money searches stopped at the visit cap');
    cleanup();
    expect(panelOf(loaded({ latest: { ...analysed(true)!, truncatedSearches: 1 } }), true, null).textContent)
      .toContain('1 money search stopped at the visit cap');
  });

  it('leaves the numbers out when the manifest no longer describes the trail that loaded', () => {
    const text = panelOf(loaded(), true, null).textContent!;
    expect(text).toContain('Money trail loaded from stored data');
    expect(text).not.toContain('traders in the trail checked');
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

  it('tells the lens cards\' story in stage 5 when the trail checked no wallet and there is no key: not run, not a bar at 0', () => {
    const c = loaded({ latest: analysed(false), fundedWallets: 0 });
    const text = view(c, { entry: withTrail(), funding: false, funded: false }).textContent!;
    expect(text).toContain('Needs a key');
    expect(text).not.toContain('Off');
    expect(text).toContain('The stored money trail checked no wallet, and no funding source is set (WASHTRACE_ETHERSCAN_KEY).');
    expect(text).not.toContain('0 of 11,259');
    expect(text).not.toContain('Using the stored money trail');
    // Funded by the trail: the count and the bar, as before.
    const ok = view(loaded(), { entry: withTrail(), funding: false, funded: true }).textContent!;
    expect(ok).toContain('1,612 of 11,259 wallets that traded it, busiest first');
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

  it('trust says the money lenses are not final while wallets are checked, never floors', () => {
    const lens = (available: boolean) => ({ available, sales: 10, flaggedSales: 2, flaggedVolumeWei: '0', volumeWei: '0', tokens: 1, wallets: 1, transfers: 10, flagged: 2 });
    const latest = { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: lens(true), AU: lens(true), AC: lens(true) }, missingData: 0, fundedWallets: 20, wallets: 80, truncatedSearches: 0 } as unknown as CollectionRow['latest'];
    const c = row({ latest, wallets: 80, fundedWallets: 20 });
    const checking = trust(c, coverage(c, ON, 0))!;
    expect(checking).toBe('25% of wallets that traded it checked for money so far, so Money loops back and Linked wallets are not final: checking the rest can move them either way.');
    expect(checking).not.toMatch(/floors|rise|at least/);
    const idle = trust(c, coverage(c, ON, 0, 'UTC', false))!;
    expect(idle).toBe('25% of wallets that traded it were checked for money, so Money loops back and Linked wallets are not final: with no Etherscan key the rest go unchecked.');
    expect(idle).not.toMatch(/floors|rise|at least/);
    // The summary names the same set as stage 5.
    expect(render(<ReadingSummary c={c} cov={coverage(c, ON, 0)} href="#reading" />).container.textContent).toContain('25%of wallets that traded it checked for money');
  });

  it("trust says each wallet's money is checked once", () => {
    const lens = (available: boolean) => ({ available, sales: 10, flaggedSales: 2, flaggedVolumeWei: '0', volumeWei: '0', tokens: 1, wallets: 1, transfers: 10, flagged: 2 });
    const latest = { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: lens(true), AU: lens(true), AC: lens(true) }, missingData: 0, fundedWallets: 80, wallets: 80, truncatedSearches: 0 } as unknown as CollectionRow['latest'];
    const c = row({ latest, wallets: 80, fundedWallets: 80 });
    expect(trust(c, coverage(c, ON, 0))).toBe("Every transfer to the finalized head is read, and every trading wallet checked for money once: a payment made after a wallet's check is not seen.");
  });

  it('the tabs say shares are so far, and the panel says why Money loops back is not in the range', () => {
    const t = (flaggedSales: number) => ({ available: true, sales: 100, flaggedSales, flaggedVolumeWei: '0', volumeWei: '0', tokens: 1, wallets: 1, transfers: 100, flagged: flaggedSales });
    const all = { A: t(10), AU: t(25), AC: t(30) } as unknown as Totals;
    const c = lensTabs(all, 'AU', { notFinal: ['AU', 'AC'] });
    expect(c.textContent).not.toContain('at least');
    const tabs = [...c.querySelector('nav')!.children].map((x) => x.textContent);
    expect(tabs).toEqual(['Round trips 10.0%', 'Money loops back 25.0% so far', 'Linked wallets 30.0% so far', '+ New lens', 'Compare']);
    expect(c.textContent).toContain(`Not in the range above: ${APART_WHY}.`);
  });

  it('keeps a money lens that has not run on the trail yet from saying no funding source is set', () => {
    const t = (available: boolean) => ({ available, sales: 0, flaggedSales: 0, flaggedVolumeWei: '0', volumeWei: '0', tokens: 0, wallets: 0, transfers: 0, flagged: 0, owners: 0, flaggedOwners: 0 });
    const all = { A: t(true), AU: t(false), AC: t(false) } as unknown as NonNullable<CollectionRow['latest']>['totals'];
    const cards = (trail: boolean, funded: boolean) => lensTabs(all, 'AU', { trail, funded }).textContent!;
    expect(cards(true, true)).not.toMatch(/no funding source/i);
    expect(cards(true, true)).toContain('The stored money trail is loaded');
    expect(cards(true, true)).toContain('the next analysis runs this lens');
    expect(cards(false, false)).toMatch(/it needs a key/i);
  });

  it('promises a money lens a run only when the next analysis will have funding for it, and otherwise says what is missing', () => {
    const t = (available: boolean) => ({ available, sales: 0, flaggedSales: 0, flaggedVolumeWei: '0', volumeWei: '0', tokens: 0, wallets: 0, transfers: 0, flagged: 0, owners: 0, flaggedOwners: 0 });
    const all = { A: t(true), AU: t(false), AC: t(false) } as unknown as NonNullable<CollectionRow['latest']>['totals'];
    const cards = (trail: boolean, funded: boolean) => lensTabs(all, 'AU', { trail, funded }).textContent!;
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

  it('says a collection waiting its turn waits, in the pill, the summary and stage 1, never "Finding the deployment block"', () => {
    const c = down({ downloadProgress: null });
    const cov = coverage(c, ON, 0);
    const pill = render(<ReadingPill cov={cov} />).container;
    expect(pill.textContent).toBe('Waiting to download stored data');
    expect(pill.querySelector('.text-fault')).toBeNull();
    cleanup();
    const summary = render(<ReadingSummary c={c} cov={cov} href="#reading" />).container.textContent!;
    expect(summary).toContain('to download its stored data from Hugging Face');
    expect(summary).not.toContain('still finding where this collection begins');
    cleanup();
    const stages = view(c, { entry: entry() }).textContent!;
    expect(stages).toContain('Waiting to download stored data');
    expect(stages).not.toContain('Finding the deployment block');
  });

  it('a collection waiting its turn, with an analysis on screen, says its shares can move, not that it has none', () => {
    const latest = { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 0, wallets: 0, truncatedSearches: 0 } as unknown as CollectionRow['latest'];
    const c = down({ downloadProgress: null, latest });
    const said = trust(c, coverage(c, ON, 0))!;
    expect(said).toContain('every share can move either way');
    expect(said).not.toContain('no numbers');
  });

  it('a trail download shows on stage 1, not as the reading', () => {
    const c = row({ downloadFile: 'trail', downloadProgress: 0.416 });
    const cov = coverage(c, ON, 0);
    expect(cov.reading).not.toBe('downloading');
    const text = view(c, { entry: withTrail(), trailBytes: 3_400_000_000 }).textContent!;
    expect(text).toContain('Money trail downloading from stored data · 41% of 3.4 GB');
    cleanup();
    // Without the manifest's size, no size is guessed.
    const bare = view(c, { entry: withTrail() }).textContent!;
    expect(bare).toContain('Money trail downloading from stored data · 41%');
    expect(bare).not.toContain(' GB');
  });

  it('a trail loading in the background shows on stage 2 with its progress', () => {
    const c = row({ trailProgress: 0.416 });
    const text = panel(c, withTrail()).textContent!;
    expect(text).toContain('Money trail loading from stored data · 41%');
    cleanup();
    expect(panel(row(), withTrail()).textContent).not.toContain('Money trail loading');
  });

  it('the note that a trail import failed shows only while it is tried again, the notes about the file always', () => {
    const failedNote = TRAIL_NOTES.failed;
    const mismatch = TRAIL_NOTES.mismatch;
    const text = (c: CollectionRow) => panel(c, withTrail()).textContent!;
    expect(text(row({ trailNote: failedNote }))).toContain(failedNote);
    cleanup();
    expect(text(row({ trailNote: failedNote, pausedAt: 1 }))).not.toContain(failedNote);
    cleanup();
    expect(text(row({ trailNote: mismatch, pausedAt: 1 }))).toContain(mismatch);
  });

  it('with no key, stage 5 waits for a trail on its way that checked wallets, instead of saying it needs a key', () => {
    // Analysed on the transfers alone, as a fresh install is before its trail is in: the money lenses did not run.
    const latest = { ranAt: 0, tookMs: 1, throughBlock: 10, missingData: 0, fundedWallets: 0, wallets: 9, truncatedSearches: 0,
      totals: { A: { available: true }, AU: { available: false }, AC: { available: false } } } as unknown as CollectionRow['latest'];
    const step2 = (more: Partial<CollectionRow>, trailComing: boolean) => {
      const c = row({ latest, ...more });
      return [...view(c, { entry: withTrail(), funding: false, covFunding: false, trailComing }).querySelectorAll('li')][4]!.textContent!;
    };
    // A trail queued but not yet downloading waits for it too.
    for (const c of [{ trailProgress: 0.41 }, { downloadFile: 'trail' as const, downloadProgress: 0.2 }, {}]) {
      const text = step2(c, true);
      expect(text).toContain('Waiting');
      expect(text).not.toContain('Off');
      expect(text).toContain('Funded by the stored money trail once it has loaded');
      // Blocked all the same, with the line beneath its link and the figure saying it waits.
      expect(text).toContain('Needs a key');
      expect(text).toContain('Add an Etherscan key in Settings →');
      expect(text.indexOf('Add an Etherscan key in Settings →')).toBeLessThan(text.indexOf('Funded by the stored money trail'));
      expect(text).toContain('Waiting');
      cleanup();
    }
    // Nothing on its way, a trail that checked no wallet, or paused: it needs a key, never "Off".
    for (const [more, coming] of [[{}, false], [{ trailProgress: 0.41 }, false], [{ trailProgress: 0.41, pausedAt: 1 }, false]] as const) {
      const text = step2(more, coming);
      expect(text).toContain('pausedAt' in more ? 'Paused' : 'Needs a key');
      expect(text).not.toContain('Off');
      expect(text).not.toContain('Funded by the stored money trail once it has loaded');
      cleanup();
    }
  });

  it('a paused collection shows no trail loading', () => {
    expect(panel(row({ trailProgress: 0.4, pausedAt: 1 }), withTrail()).textContent).not.toContain('Money trail loading');
  });

  it('says nothing is downloading when paused, and the note only while it is tried again', () => {
    const note = 'Stored data could not be downloaded. Tried again later.';
    const paused = row({ downloadFile: 'trail', downloadProgress: 0.4, downloadNote: note, pausedAt: 1 });
    const text = panel(paused, withTrail()).textContent!;
    expect(text).not.toContain('downloading');
    expect(text).not.toContain(note);
    cleanup();
    const failed = row({ downloadNote: note });
    const el = panel(failed, entry());
    expect(el.textContent).toContain(note);
    // The stage's chip says Failed in the fault colour; the note itself is information, as before.
    expect(el.querySelectorAll('li')[0]!.textContent).toContain('Failed');
    expect([...el.querySelectorAll('p')].find((p) => p.textContent === note)!.className).not.toContain('text-fault');
  });
});

const TITLES6 = ['Download stored data', 'Load it into the database', 'Analyze the stored data', 'Read new transfers from the chain', 'Check wallets for money', 'Re-analyze with everything'];

describe('the six stages', () => {
  const NONE = new Set<number>();
  const TITLES = ['Download stored data', 'Load it into the database', 'Analyze the stored data', 'Read new transfers from the chain', 'Check wallets for money', 'Re-analyze with everything'];

  it('shows the six stages in order, each with its state and what it feeds', () => {
    const c = row();
    const lis = [...panel(c).querySelectorAll('li')];
    const stages = pipeline({ c, entry: null, rpcChains: ON, funding: true, analyzing: false, silent: false });
    expect(lis).toHaveLength(6);
    lis.forEach((li, i) => {
      expect(li.textContent).toContain(TITLES[i]);
      expect(li.textContent).toContain('Feeds');
      expect(li.textContent).not.toContain('Affects');
      expect(li.textContent).toContain(STATE_WORDS[stages[i]!.state]);
    });
    // Each title sits in its own place: the second stage's is not in the first.
    expect(lis[0]!.textContent).not.toContain(TITLES[1]);
  });

  it('a stage missing its key says so and links to Settings, never "Off"', () => {
    const c = row();
    const el = view(c, { rpc: NONE, funding: false });
    const links = [...el.querySelectorAll('a')];
    expect(links.find((a) => a.textContent === 'Add an RPC URL in Settings →')?.getAttribute('href')).toBe('/settings#rpc.1');
    expect(links.find((a) => a.textContent === 'Add an Etherscan key in Settings →')?.getAttribute('href')).toBe('/settings#etherscan.key');
    // The chip's word, once per blocked stage, and never repeated by a figure.
    expect(el.textContent!.split('Needs a key')).toHaveLength(3);
    expect(el.textContent).not.toMatch(/\bOff\b/);
  });

  it('a chain Settings does not offer names its variable, with no link', () => {
    const c = row({ chainId: 8453 });
    const el = view(c);
    expect(el.textContent).toContain('Set WASHTRACE_RPC_8453 for the worker to read this chain.');
    expect(el.querySelector('a[href^="/settings#rpc"]')).toBeNull();
  });

  it('stages 1–3 say there is no stored data when there is none', () => {
    const lis = [...panel(row()).querySelectorAll('li')];
    for (const li of lis.slice(0, 3)) expect(li.textContent).toContain('No stored data for this collection.');
    expect(lis[3]!.textContent).not.toContain('No stored data for this collection.');
  });

  it('stages 1–3 say the chain was read past stored data it never needed', () => {
    const lis = [...panel(row({ cursorBlock: 900 }), entry({ throughBlock: 500 })).querySelectorAll('li')];
    for (const li of lis.slice(0, 3)) expect(li.textContent).toContain('Read past its stored data from the chain, so it was not needed.');
    cleanup();
    const early = [...panel(row({ cursorBlock: 5 }), entry({ startBlock: 100 })).querySelectorAll('li')];
    for (const li of early.slice(0, 3)) expect(li.textContent).toContain('Its reading started before its stored data, so it was not needed.');
  });

  it('a live collection follows new blocks, never "done" on stage 4', () => {
    const stage4 = panel(row()).querySelectorAll('li')[3]!;
    expect(stage4.textContent).toContain('Following');
    expect(stage4.textContent).toContain('Up to date · following new blocks');
    expect(stage4.textContent).not.toContain('Done');
  });

  it('a stage that is waiting says on what, and one that is running says how far', () => {
    const waiting = [...panel(row({ cursorBlock: null, startBlock: null, downloadFile: 'transfers' }), entry()).querySelectorAll('li')];
    expect(waiting[1]!.textContent).toContain('Waiting for the stored data to download');
    expect(waiting[3]!.textContent).toContain('Waiting for the stored data to load');
    cleanup();
    const running = [...panel(row({ cursorBlock: 251, headBlock: 1001 })).querySelectorAll('li')];
    expect(running[3]!.textContent).toContain('blocks to go');
  });

  it('stage 3 says when the stored data was analysed, through which block, and how long it took', () => {
    const latest = { ranAt: Date.UTC(2026, 9, 14, 8), tookMs: 25_000, throughBlock: 500, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 0, wallets: 0, truncatedSearches: 0 } as unknown as CollectionRow['latest'];
    const c = row({ storedThroughTime: 1, storedThroughBlock: 500, cursorBlock: 500, latest });
    const li = panel(c, entry()).querySelectorAll('li')[2]!;
    expect(li.textContent).toContain('Analyzed');
    expect(li.textContent).toContain('through block 500');
    expect(li.textContent).toContain('took 25 s');
  });

  it('the bar is green only for done and live', () => {
    const bar = (li: Element) => li.querySelector('[data-bar="stage"] i');
    const lis = [...panel(row({ fundedWallets: 0, wallets: 4, latest: { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 0, wallets: 4, truncatedSearches: 0 } as unknown as CollectionRow['latest'] })).querySelectorAll('li')];
    // Stage 4 is live (full, green); stage 5 is running at 0 (not green).
    expect(bar(lis[3]!)!.className).toContain('bg-ok');
    expect(bar(lis[4]!)!.className).not.toContain('bg-ok');
    cleanup();
    // Blocked is never green, even at a full share.
    const stored = [...view(row({ storedThroughTime: 1, storedThroughBlock: 10, headBlock: null }), { rpc: NONE }).querySelectorAll('li')];
    expect(bar(stored[3]!)?.className ?? '').not.toContain('bg-ok');
  });

  it('a running download and a running load each show their bar', () => {
    const down = [...panel(row({ cursorBlock: null, startBlock: null, downloadFile: 'transfers', downloadProgress: 0.4 }), entry()).querySelectorAll('li')];
    expect(down[0]!.querySelector('[data-bar="stage"]')).not.toBeNull();
    cleanup();
    const load = [...panel(row({ cursorBlock: null, startBlock: null, restoreProgress: 0.5 }), entry()).querySelectorAll('li')];
    expect(load[1]!.querySelector('[data-bar="stage"]')).not.toBeNull();
  });

  it('a missing RPC with no stored data is a limit to lift, never a fault', () => {
    const c = row({ cursorBlock: null, startBlock: null, headBlock: null, transfers: 0, error: 'No RPC is configured for chain 1. Set it in Settings, or WASHTRACE_RPC_1 for the worker.' });
    const li = view(c, { rpc: NONE }).querySelectorAll('li')[3]!;
    expect(li.textContent).toContain('Needs a key');
    expect(li.textContent).toContain('No RPC is set for Ethereum');
    expect(li.textContent).not.toContain('Last read failed');
    expect(li.textContent).not.toContain('Finding the deployment block');
    expect(li.querySelector('.text-fault')).toBeNull();
  });

  it('stage 4 waits on stored data only while it is to load: after a failed load its own line returns', () => {
    const failedLoad = row({ cursorBlock: null, startBlock: null, headBlock: null, restoreNote: 'Stored data could not be loaded.' });
    const withRpc = view(failedLoad, { entry: entry() }).querySelectorAll('li')[3]!.textContent!;
    expect(withRpc).not.toContain('Waiting for the stored data to load');
    expect(withRpc).toContain('Finding the deployment block');
    cleanup();
    const noRpc = view(failedLoad, { entry: entry(), rpc: NONE }).querySelectorAll('li')[3]!.textContent!;
    expect(noRpc).not.toContain('Waiting for the stored data to load');
    expect(noRpc).toContain('No RPC is set for Ethereum');
  });

  it('a blocked stage 5 shows a dash unless a trail funds it or is on its way', () => {
    const fig = (c: CollectionRow) => view(c, { funding: false, covFunding: false }).querySelectorAll('li')[4]!.querySelector('p.text-xl')!.textContent;
    expect(fig(row({ latest: null }))).toBe('—');
    cleanup();
    expect(fig(row({ wallets: 9, fundedWallets: 3, latest: { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 3, wallets: 9, truncatedSearches: 0 } as unknown as CollectionRow['latest'] }))).toBe('—');
  });

  it('the summary says what blocks the reading, with the link', () => {
    const c = row();
    const stages = pipeline({ c, entry: null, rpcChains: NONE, funding: false, analyzing: false, silent: false });
    const el = render(<ReadingSummary c={c} cov={coverage(c, NONE, 0)} href="#reading" stages={stages} />).container;
    expect(el.textContent).toContain('Add an RPC URL in Settings →');
    expect([...el.querySelectorAll('a')].map((a) => a.textContent)).toContain('The six stages ↓');
    expect(el.textContent).not.toContain('The three steps');
    cleanup();
    // Nothing blocked, nothing said; and a paused collection is blocked by nothing.
    const free = render(<ReadingSummary c={c} cov={coverage(c, ON, 0)} href="#reading" stages={pipeline({ c, entry: null, rpcChains: ON, funding: true, analyzing: false, silent: false })} />).container;
    expect(free.textContent).not.toContain('Blocked');
    cleanup();
    const paused = row({ pausedAt: 5 });
    const pausedEl = render(<ReadingSummary c={paused} cov={coverage(paused, NONE, 0)} href="#reading" stages={pipeline({ c: paused, entry: null, rpcChains: NONE, funding: false, analyzing: false, silent: false })} />).container;
    expect(pausedEl.textContent).not.toContain('Blocked');
  });
});

describe('the reading, said once and truthfully', () => {
  const NONE = new Set<number>();
  const analysed = { ranAt: 0, tookMs: 1, throughBlock: 10, totals: { A: {}, AU: {}, AC: {} }, missingData: 0, fundedWallets: 0, wallets: 0, truncatedSearches: 0 } as unknown as CollectionRow['latest'];
  const summary = (c: CollectionRow, o: { rpc?: ReadonlySet<number>; funding?: boolean; analyzing?: boolean } = {}) => {
    const rpc = o.rpc ?? ON;
    const stages = pipeline({ c, entry: null, rpcChains: rpc, funding: o.funding ?? true, analyzing: o.analyzing ?? false, silent: false });
    return render(<ReadingSummary c={c} cov={coverage(c, rpc, 0)} href="#reading" stages={stages} />).container.textContent!;
  };

  it('everything read, no key, and no analysis of money: the summary says the wallets wait for a key', () => {
    const text = summary(row({ latest: analysed }), { funding: false });
    expect(text).toContain('of transfers read. Wallets not yet checked for money wait for an Etherscan key');
    cleanup();
    // A key just added is also without money lenses: that is not waiting for a key.
    expect(summary(row({ latest: analysed }), { funding: true })).toContain('read: every transfer, and every wallet the lenses need');
  });

  it('a chain with no RPC and nothing read says so, not "Finding where the collection begins"', () => {
    const c = row({ cursorBlock: null, startBlock: null, headBlock: null, transfers: 0 });
    const text = summary(c, { rpc: NONE });
    expect(text).toContain('No RPC');
    expect(text).toContain('Nothing is read until its chain has an RPC.');
    expect(text).not.toContain('Finding where the collection begins');
    cleanup();
    expect(render(<ReadingPill cov={coverage(c, NONE, 0)} />).container.textContent).toBe('No RPC for its chain');
  });

  it('a chain read before its RPC went says where it was read to, never that nothing is read', () => {
    const c = row({ startBlock: 1, cursorBlock: 700, headBlock: 1000, transfers: 5 });
    expect(coverage(c, NONE, 0).readTo).toBe(700);
    const text = summary(c, { rpc: NONE });
    expect(text).toContain('Read to block 700. No newer block is read until its chain has an RPC.');
    expect(text).not.toContain('Nothing is read');
  });

  it('a first analysis being tried again reads Analyzing, not Failed', () => {
    const c = row({ latest: null, analysisError: 'Ran out of memory.', wallets: 4 });
    expect(summary(c)).toContain('Failed');
    cleanup();
    const text = summary(c, { analyzing: true });
    expect(text).toContain('Analyzing');
    expect(text).not.toContain('Failed');
  });

  it('stage 6 over a failed analysis says it is trying again now, and otherwise when it is due', () => {
    const c = row({ latest: analysed, analysisError: 'Ran out of memory.', analysisRetryAt: 5 });
    const six = (o: View) => view(c, o).querySelectorAll('li')[5]!.textContent!;
    expect(six({ analyzing: true, now: 10 })).toContain('trying again now.');
    expect(six({ analyzing: true, now: 10 })).not.toContain('due to be tried again');
    cleanup();
    expect(six({ now: 10 })).toContain('due to be tried again.');
  });

  it('transfers in with the money trail still to come: stage 1 says the trail is next', () => {
    const loaded = row({ storedThroughTime: 1, storedThroughBlock: 500 });
    const text = (c: CollectionRow) => view(c, { entry: entry({ trail: TRAIL }) }).querySelectorAll('li')[0]!.textContent!;
    expect(text(loaded)).toContain('Transfers downloaded; the money trail is next.');
    cleanup();
    expect(text(row({ cursorBlock: null, startBlock: null, restoreProgress: 0.4 }))).toContain('Transfers downloaded; the money trail is next.');
    cleanup();
    expect(text(row({ cursorBlock: null, startBlock: null }))).toContain('Waiting to download stored data');
    cleanup();
    expect(text(row({ storedThroughTime: 1, storedThroughBlock: 500, downloadFile: 'transfers' }))).toContain('Waiting to download stored data');
  });

  it('a paused collection with no RPC says that, in stage 4 and under the table, not "last error"', () => {
    const c = row({ pausedAt: 5, error: 'No RPC is configured for chain 1.', cursorBlock: 5, startBlock: 1 });
    const four = view(c, { rpc: NONE }).querySelectorAll('li')[3]!.textContent!;
    expect(four).toContain('Paused · no RPC is set for Ethereum.');
    expect(four).not.toContain('last error');
    cleanup();
    const rows = [{ chainId: 1, address: '0xa1', name: 'Demo', error: 'No RPC is configured for chain 1.', storedOnly: false, paused: true, rpc: false, stages: pipeline({ c, entry: null, rpcChains: NONE, funding: true, analyzing: false, silent: false }) }];
    const el = render(<PipelineErrors rows={rows} />).container;
    expect(el.textContent).toContain('Paused · no RPC is set for Ethereum.');
    expect(el.textContent).not.toContain('last error');
  });

  it('the table shows a running download rounded down, and its name cell opens the row from its whole width', () => {
    const c = row({ cursorBlock: null, startBlock: null, downloadFile: 'transfers', downloadProgress: 0.416 });
    const stages = pipeline({ c, entry: entry(), rpcChains: ON, funding: true, analyzing: false, silent: false });
    const el = render(<PipelineTable rows={[{ chainId: 1, address: '0xabc', name: 'Demo', stages }]} />).container;
    expect(el.querySelector('tbody tr')!.textContent).toContain('41%');
    expect(el.querySelector('tbody tr')!.textContent).not.toContain('42%');
    const name = el.querySelector('tbody td')!;
    expect(name.className).toContain('p-0');
    expect(name.querySelector('a')!.className).toContain('block');
  });
});

describe('the worker page\'s stages', () => {
  const stages = (c: CollectionRow, o: { rpc?: ReadonlySet<number>; funding?: boolean } = {}) =>
    pipeline({ c, entry: null, rpcChains: o.rpc ?? ON, funding: o.funding ?? true, analyzing: false, silent: false });

  it('PipelineTable shows one row per collection, a column per stage, each cell its state, the name linking to its stages', () => {
    const running = pipeline({ c: row({ restoreProgress: 0.5, storedThroughTime: null }), entry: entry(), rpcChains: ON, funding: true, analyzing: false, silent: false });
    const rows = [
      { chainId: 1, address: '0xabc', name: 'Demo', stages: running },
      { chainId: 1, address: '0xdef', name: null, stages: stages(row()) },
    ];
    const el = render(<PipelineTable rows={rows} />).container;
    expect(el.querySelector('.overflow-x-auto table')).not.toBeNull();
    const heads = [...el.querySelectorAll('thead th')];
    // The first column is the collection; then one per stage, its title on hover.
    expect(heads.slice(1).map((h) => h.getAttribute('title'))).toEqual(TITLES6);
    const body = [...el.querySelectorAll('tbody tr')];
    expect(body).toHaveLength(2);
    body.forEach((tr, i) => {
      const cells = [...tr.querySelectorAll('td')].slice(1);
      expect(cells).toHaveLength(6);
      cells.forEach((td, j) => expect(td.textContent).toContain(STATE_WORDS[rows[i]!.stages[j]!.state]));
    });
    const running2 = rows[0]!.stages.find((s) => s.state === 'running')!;
    expect(body[0]!.textContent).toContain(progress(running2.share!));
    expect(body[0]!.querySelector('a')!.getAttribute('href')).toBe('/c/1/0xabc#reading');
    // The whole row opens: every stage cell links to the same place, out of the tab order.
    const cellLinks = [...body[0]!.querySelectorAll('td')].slice(1).map((td) => td.querySelector('a')!);
    expect(cellLinks).toHaveLength(6);
    cellLinks.forEach((a) => {
      expect(a.getAttribute('href')).toBe('/c/1/0xabc#reading');
      expect(a.getAttribute('tabindex')).toBe('-1');
    });
    // A collection with no name shows its short address.
    expect(body[1]!.querySelector('a')!.textContent).toBe(short('0xdef'));
  });

  it('PipelineErrors lists a fault, a paused collection\'s error as information, and never a missing key as an error', () => {
    const base = { chainId: 1, name: 'Demo', storedOnly: false, paused: false, rpc: true };
    const blocked = stages(row(), { rpc: new Set() });
    expect(blocked[3]!.state).toBe('blocked');
    const rows = [
      { ...base, address: '0xa1', error: 'boom', stages: stages(row()) },
      { ...base, address: '0xa2', error: 'No RPC is configured for chain 1', stages: blocked },
      { ...base, address: '0xa3', error: 'old', paused: true, stages: stages(row()) },
      { ...base, address: '0xa4', error: 'No RPC', storedOnly: true, stages: stages(row()) },
      { ...base, address: '0xa5', error: null, stages: stages(row()) },
    ];
    const el = render(<PipelineErrors rows={rows} />).container;
    const items = [...el.querySelectorAll('li')];
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Last read failed: boom · the worker tries again on its next pass.');
    expect(items[0]!.className).toContain('text-fault');
    expect(items[0]!.querySelector('a')!.getAttribute('href')).toBe('/c/1/0xa1#reading');
    expect(items[1]!.textContent).toContain('Paused · last error before the pause: old');
    expect(items[1]!.className).not.toContain('text-fault');
    expect(el.textContent).not.toContain('No RPC is configured');
  });
});

describe('a silent worker', () => {
  const silent = (c: CollectionRow) => coverage(c, ON, 0, 'UTC', true, true);
  const latest = { ranAt: 0, tookMs: 1, throughBlock: 10, missingData: 0, fundedWallets: 4, wallets: 4, truncatedSearches: 0,
    totals: { A: { available: true }, AU: { available: true }, AC: { available: true } } } as unknown as CollectionRow['latest'];

  it('the summary says Silent, with its own sentences, and none of the progress ones', () => {
    const c = row({ latest, wallets: 4, fundedWallets: 4, cursorBlock: null, startBlock: null });
    const text = render(<ReadingSummary c={c} cov={silent(c)} href="#reading" />).container.textContent!;
    expect(text).toContain('Silent');
    expect(text).toContain('The worker is not reporting, so nothing here is kept current');
    expect(text).toContain('The worker is not reporting, so these numbers rest on what it had read before it went silent, not on the chain as it is now.');
    expect(text).not.toContain('Finding where the collection begins');
    expect(text).not.toContain('Every transfer to the finalized head is read');
  });

  it('the stages show no chip reading Running or Following, and no up-to-date line', () => {
    const c = row({ latest, wallets: 4, fundedWallets: 2 });
    const el = view(c, { silent: true });
    const chips = [...el.querySelectorAll('li > p > span.ml-auto')].map((x) => x.textContent);
    expect(chips).toContain('Worker silent');
    expect(chips).not.toContain('Running');
    expect(chips).not.toContain('Following');
    expect(el.textContent).not.toContain('Up to date · following new blocks');
  });

  it('a silent load still says the chain waits on it, and stages 1 to 3 each give a sentence', () => {
    const c = row({ cursorBlock: null, startBlock: null, latest: null, restoreProgress: 0.5 });
    const items = [...view(c, { entry: entry(), silent: true }).querySelectorAll('li')].map((x) => x.textContent!);
    expect(items.join()).not.toContain('Finding the deployment block');
    expect(items[3]).toContain('Waiting for the stored data to load');
    expect(items[1]).toContain('Load stopped reporting · the worker is silent');
    expect(items[1]).not.toContain('Loading');
    expect(items[0]).toContain('Downloaded from stored data.');
    const down = row({ cursorBlock: null, startBlock: null, latest: null, downloadFile: 'transfers', downloadProgress: 0.4 });
    const first = [...view(down, { entry: entry(), silent: true }).querySelectorAll('li')][0]!.textContent!;
    expect(first).toContain('Download stopped reporting · the worker is silent');
    expect(first).not.toContain('Downloading');
    cleanup();
    const third = [...view(row({ latest: { ...latest!, throughBlock: 3 }, storedThroughTime: 1, storedThroughBlock: 5, wallets: 4, fundedWallets: 4 }), { entry: entry(), silent: true, analyzing: true }).querySelectorAll('li')][2]!.textContent!;
    expect(third).toContain('Analysis stopped reporting · the worker is silent');
    expect(third).not.toContain('Analysing');
  });

  it('a caught-up stage 4 says what was read, not that it is the finalized head; stage 6 does not say nothing is new', () => {
    const el = view(row({ latest, wallets: 4, fundedWallets: 4 }), { silent: true, analyzing: true });
    const items = [...el.querySelectorAll('li')].map((x) => x.textContent!);
    expect(items[3]).toContain('5 transfers read, to block 10, before the worker went silent');
    expect(items[3]).not.toContain('finalized head');
    expect(items[5]).toContain('the worker is silent, so nothing new is read');
    expect(items[5]).not.toContain('nothing new since');
  });

  it('the pill says it, and its dot does not pulse', () => {
    const c = row({ latest, wallets: 4, fundedWallets: 4 });
    const el = render(<ReadingPill cov={silent(c)} />).container;
    expect(el.textContent).toBe('Worker silent · not kept current');
    expect(el.querySelector('.animate-pulse')).toBeNull();
  });
});

describe('a money trail on its way', () => {
  it('the pill of a stored-only collection ends money trail loading', () => {
    const c = row({ startBlock: 100, cursorBlock: 900, headBlock: null, storedThroughTime: Date.UTC(2026, 9, 14), storedThroughBlock: 900, trailProgress: 0.3 });
    const text = render(<ReadingPill cov={coverage(c, new Set(), Date.UTC(2026, 9, 23))} />).container.textContent!;
    expect(text).toBe(`Stored data · 9 days unsynced${TRAIL_LOADING}`);
    expect(text.endsWith('money trail loading')).toBe(true);
  });

  it('the lens panel of a collection with no funding say it is on its way, never that a key is needed', () => {
    const t = (available: boolean) => ({ available, sales: 0, flaggedSales: 0, flaggedVolumeWei: '0', volumeWei: '0', tokens: 0, wallets: 0, transfers: 0, flagged: 0, owners: 0, flaggedOwners: 0 });
    const all = { A: t(true), AU: t(false), AC: t(false) } as unknown as NonNullable<CollectionRow['latest']>['totals'];
    const text = lensTabs(all, 'AU', { coming: true }).textContent!;
    expect(text).toContain('Not run yet. A stored money trail is on its way, and the first analysis after it loads runs this lens on it.');
    expect(text).not.toContain('once the worker reports again');
    expect(text).not.toMatch(/needs a key/i);
  });

  it('the lens panel says the trail waits on the worker while it is silent', () => {
    const t = (available: boolean) => ({ available, sales: 0, flaggedSales: 0, flaggedVolumeWei: '0', volumeWei: '0', tokens: 0, wallets: 0, transfers: 0, flagged: 0, owners: 0, flaggedOwners: 0 });
    const all = { A: t(true), AU: t(false), AC: t(false) } as unknown as NonNullable<CollectionRow['latest']>['totals'];
    const text = lensTabs(all, 'AU', { coming: true, silent: true }).textContent!;
    expect(text).toContain('Not run yet. A stored money trail is on its way, and the first analysis after it loads runs this lens on it, once the worker reports again.');
  });
});

describe('the time chart', () => {
  it('draws Money loops back grey, as it is everywhere it is shown apart, keeping its dash and its square', () => {
    const point = (at: number) => ({ at, lens: { A: { part: 1, whole: 10 }, AU: { part: 2, whole: 10 }, AC: { part: 3, whole: 10 } }, sales: 10, transfers: 10 });
    const el = render(<TimeChart kind="analyses" points={[point(0), point(86_400_000)]} zone="UTC" />).container;
    expect(el.querySelector('.stroke-money, .fill-money')).toBeNull();
    expect(el.querySelector('polyline.stroke-muted-foreground')?.getAttribute('stroke-dasharray')).toBe('5 3');
    expect(el.querySelector('rect.fill-muted-foreground')).not.toBeNull();
  });
});
