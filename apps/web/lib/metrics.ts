import { BEHIND_BLOCKS, METHODS, type CollectionRow, type Method, type MethodTotals, type PassRow } from '@washtrace/detect';
import { localTime, pct, plural } from './format';

/**
 * The analysis, said the way a reader asks it. The three methods are three
 * lenses from strictest to widest, so one collection's answer is a range: the
 * share the strictest lens that ran finds, up to the share the widest finds.
 * A lens that did not run is left out of the range, never read as 0%.
 */

export type Measure = 'sales' | 'volume' | 'owners';

/** One lens's share of one measure. Volume in micro-ETH: enough for a share, and it fits a number. */
export function part(t: MethodTotals, measure: Measure): { part: number; whole: number } {
  if (measure === 'sales') return { part: t.flaggedSales, whole: t.sales };
  if (measure === 'owners') return { part: t.flagged, whole: t.transfers };
  return { part: Number(BigInt(t.flaggedVolumeWei) / 10n ** 12n), whole: Number(BigInt(t.volumeWei) / 10n ** 12n) };
}

export interface Range { low: Method; high: Method; lowShare: number; highShare: number }

/** Null when no lens ran or there is nothing to divide by, such as a collection with no priced sale. */
export function range(totals: Record<Method, MethodTotals>, measure: Measure): Range | null {
  const read = METHODS.filter((m) => totals[m].available)
    .map((m) => ({ m, ...part(totals[m], measure) }))
    .filter((r) => r.whole > 0)
    .map((r) => ({ m: r.m, share: r.part / r.whole }));
  if (read.length === 0) return null;
  // Stable over METHODS' order, so a tie keeps the stricter lens low and the wider high.
  const sorted = [...read].sort((a, b) => a.share - b.share);
  const low = sorted[0]!, high = sorted[sorted.length - 1]!;
  return { low: low.m, high: high.m, lowShare: low.share, highShare: high.share };
}

/** "18–25%", or "18%" when the lenses agree. */
export function rangeText(r: Range): string {
  const lo = pct(r.lowShare, 1), hi = pct(r.highShare, 1);
  return lo === hi ? hi : `${lo.replace('%', '')}–${hi}`;
}

/** The range in a sentence: what the strictest lens counts, and what following the money adds. */
export function summary(totals: Record<Method, MethodTotals>): string {
  const a = totals.A;
  if (a.sales === 0) return `No sale read yet, so there is no share of sales. ${a.flagged.toLocaleString('en-US')} of ${a.transfers.toLocaleString('en-US')} changes of owner are round trips.`;
  const strict = a.flaggedSales === 0
    ? `None of the ${a.sales.toLocaleString('en-US')} sales is a round trip between the same wallets.`
    : `${a.flaggedSales.toLocaleString('en-US')} of ${a.sales.toLocaleString('en-US')} sales are round trips between the same wallets.`;
  const money = (['AU', 'AC'] as const).filter((m) => totals[m].available);
  if (money.length === 0) return `${strict} Money links between buyers and sellers were not checked, so this is the strict count alone.`;
  const wide = Math.max(...money.map((m) => totals[m].flaggedSales));
  return wide > a.flaggedSales
    ? `${strict} Counting buyers and sellers linked by money, up to ${wide.toLocaleString('en-US')} are.`
    : `${strict} Following the money adds none.`;
}

/** A share of progress: "100%" only when it is done, so 99.98% of history reads as unfinished. */
export function progress(share: number): string {
  const text = pct(share, 1);
  return share < 1 && text === '100%' ? '>99%' : text;
}

export type Reading = 'restoring' | 'stored-only' | 'starting' | 'catching-up' | 'checking' | 'complete' | 'paused';

export interface Coverage {
  reading: Reading;
  /** Share of the collection's blocks read, 0 to 1. Null until its deployment block is known. */
  blocks: number | null;
  behind: number | null;
  wallets: { checked: number; of: number };
  /** False when the money lenses did not run: no wallet is waiting to be checked. */
  money: boolean;
  /** Lenses whose shares can only rise as the reading completes. */
  floor: Method[];
  /** How far a load of stored data has got, 0 to 1, while one runs; else null. */
  restore: number | null;
  /** When the stored data stops, while it is all there is (stored-only); else null. */
  stops: number | null;
  /** How long ago that was, "9 days unsynced", while stored-only; else null. */
  unsynced: string | null;
  label: string;
}

/**
 * Whether a collection shows stored data only: its stored data has loaded
 * (the cursor sits past its start), and its chain has no RPC to read on
 * from there. Not a fault, and not starting: the numbers are all there, they
 * just stop where the stored data was cut.
 */
export function storedOnly(c: Pick<CollectionRow, 'chainId' | 'startBlock' | 'cursorBlock'> & Partial<Pick<CollectionRow, 'storedThroughTime'>>, rpcChains: ReadonlySet<number>): boolean {
  return !rpcChains.has(c.chainId) && (c.storedThroughTime ?? null) !== null && c.cursorBlock !== null && c.startBlock !== null && c.cursorBlock >= c.startBlock;
}

/** How long stored data has gone unread, as the owner put it: "9 days unsynced". With no RPC there is no head to count blocks to, only time. */
function unsyncedFor(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'up to date with its stored data';
  return hours < 24 ? `${plural(hours, 'hour')} unsynced` : `${plural(Math.floor(hours / 24), 'day')} unsynced`;
}

/**
 * How far the reading the numbers rest on has got. History comes first: with
 * blocks unread, any share can still move either way. Then wallets: with
 * money unread, the money lenses have missed links but not invented any, so
 * their shares are floors. Before either, stored data may be loading: the
 * history it holds arrives at once, when the load commits. A paused
 * collection is none of these: its head stops moving, so "up to date" would
 * be a claim nobody is keeping true. Nor is one showing stored data with no
 * RPC: its numbers stop at the stored date, said in `zone` (the reader's;
 * the console draws that date with Time).
 */
export function coverage(
  c: Pick<CollectionRow, 'chainId' | 'pausedAt' | 'startBlock' | 'cursorBlock' | 'headBlock' | 'wallets' | 'fundedWallets' | 'latest'> & Partial<Pick<CollectionRow, 'restoreProgress' | 'storedThroughTime'>>,
  rpcChains: ReadonlySet<number>, now: number, zone = 'UTC',
): Coverage {
  const money = c.latest === null ? true : c.latest.totals.AU.available || c.latest.totals.AC.available;
  const wallets = { checked: c.fundedWallets, of: c.wallets };
  const behind = c.headBlock === null || c.cursorBlock === null ? null : Math.max(0, c.headBlock - c.cursorBlock);
  const span = c.headBlock === null || c.startBlock === null ? null : c.headBlock - c.startBlock;
  const blocks = span === null || c.cursorBlock === null || c.startBlock === null ? null : span <= 0 ? 1 : Math.max(0, Math.min(1, (c.cursorBlock - c.startBlock) / span));
  const unchecked = money && wallets.checked < wallets.of;
  const floor: Method[] = unchecked ? METHODS.filter((m) => m !== 'A' && (c.latest?.totals[m].available ?? true)) : [];
  // A load is never resumed after a pause, so progress left on a paused collection is stale.
  // Never shown as done: the data is not there until the load commits, and then the progress is gone.
  const restore = c.pausedAt === null && (c.restoreProgress ?? null) !== null ? Math.min(c.restoreProgress!, 0.99) : null;
  const stops = c.pausedAt === null && restore === null && storedOnly(c, rpcChains) ? c.storedThroughTime! : null;
  const unsynced = stops === null ? null : unsyncedFor(now - stops);
  const base = { blocks, behind, wallets, money, floor, restore, stops, unsynced };
  if (restore !== null) return { ...base, reading: 'restoring', label: `Loading stored data · ${progress(restore)}` };
  if (c.pausedAt !== null) return { ...base, reading: 'paused', label: c.cursorBlock === null || (c.startBlock !== null && c.cursorBlock < c.startBlock) ? 'Paused · not read yet' : `Paused · read to block ${c.cursorBlock.toLocaleString('en-US')}` };
  // Before 'starting': with no RPC the head is never known, and the stored numbers are all there is.
  if (stops !== null) return { ...base, reading: 'stored-only', label: `Stored data · stops ${localTime(stops, 'date', zone)} · ${unsynced}` };
  // An unknown head cannot be caught up to.
  if (c.cursorBlock === null || c.startBlock === null || c.headBlock === null) return { ...base, reading: 'starting', label: 'Starting' };
  if (behind !== null && behind > BEHIND_BLOCKS) return { ...base, reading: 'catching-up', label: `Reading history · ${blocks === null ? '…' : progress(blocks)}` };
  if (unchecked) return { ...base, reading: 'checking', label: `Checking wallets · ${progress(wallets.of === 0 ? 0 : wallets.checked / wallets.of)}` };
  return { ...base, reading: 'complete', label: 'Up to date' };
}

/**
 * The collections tabs' counts. "Behind" is the In sync collections showing
 * stored data only: in sync by choice, but nothing reads them on until their
 * chain has an RPC.
 */
export function tabCounts(rows: readonly CollectionRow[], rpcChains: ReadonlySet<number>): { sync: number; paused: number; all: number; behind: number } {
  const sync = rows.filter((c) => c.pausedAt === null);
  return { sync: sync.length, paused: rows.length - sync.length, all: rows.length, behind: sync.filter((c) => storedOnly(c, rpcChains)).length };
}

/** Whether history is still unread, paused or not: a pause does not read what was left. The history chart shades that stretch. */
export function unread(cov: Pick<Coverage, 'behind'>): boolean {
  return cov.behind !== null && cov.behind > BEHIND_BLOCKS;
}

/** A pass is running from when it starts until it finishes. The status route and the pages both decide it here. */
export function isRunning(p: PassRow): boolean {
  return p.finishedAt === null || p.finishedAt < p.startedAt;
}

/**
 * Why a collection has no analysis yet, from what the worker is doing now.
 * Analysis runs one collection per pass, so a new one may be queued behind
 * another that takes a while.
 */
export function waiting(c: CollectionRow, analyzePass: PassRow | undefined, names: ReadonlyMap<number, string>, now: number): string {
  // Never analysed while paused, so promise nothing.
  if (c.pausedAt !== null) return 'Paused · it is not analysed until you resume it.';
  // Its transfers arrive all at once when the load commits; until then there is nothing to analyse.
  if ((c.restoreProgress ?? null) !== null) return 'Loading stored data · it is analysed once it has loaded.';
  if (c.transfers === 0) return 'Waiting for its first transfers.';
  const running = analyzePass && isRunning(analyzePass) && analyzePass.subjectId !== null ? analyzePass : null;
  if (running === null) return 'Waiting for its first analysis · the next pass starts within a minute.';
  const min = `${Math.floor((now - running.startedAt) / 60_000)} min`;
  if (running.subjectId === c.id) return `First analysis running · started ${min} ago.`;
  return `Waiting for its first analysis · queued behind ${names.get(running.subjectId!) ?? 'another collection'} (running ${min}).`;
}
