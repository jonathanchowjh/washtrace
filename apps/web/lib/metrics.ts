import { METHODS, type CollectionRow, type Method, type MethodTotals } from '@washtrace/detect';
import { BEHIND_BLOCKS } from './status';
import { pct } from './format';

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

export type Reading = 'starting' | 'catching-up' | 'analyzing' | 'checking' | 'complete';

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
  label: string;
}

/**
 * How far the reading the numbers rest on has got. History comes first: with
 * blocks unread, any share can still move either way. Then wallets: with
 * money unread, the money lenses have missed links but not invented any, so
 * their shares are floors.
 */
export function coverage(c: Pick<CollectionRow, 'startBlock' | 'cursorBlock' | 'headBlock' | 'wallets' | 'fundedWallets' | 'latest'>): Coverage {
  const money = c.latest === null ? true : c.latest.totals.AU.available || c.latest.totals.AC.available;
  const wallets = { checked: c.fundedWallets, of: c.wallets };
  const behind = c.headBlock === null || c.cursorBlock === null ? null : Math.max(0, c.headBlock - c.cursorBlock);
  const span = c.headBlock === null || c.startBlock === null ? null : c.headBlock - c.startBlock;
  const blocks = span === null || c.cursorBlock === null || c.startBlock === null ? null : span <= 0 ? 1 : Math.min(1, (c.cursorBlock - c.startBlock) / span);
  const unchecked = money && wallets.checked < wallets.of;
  const floor: Method[] = unchecked ? METHODS.filter((m) => m !== 'A' && (c.latest?.totals[m].available ?? true)) : [];
  const base = { blocks, behind, wallets, money, floor };
  if (c.cursorBlock === null || c.startBlock === null) return { ...base, reading: 'starting', label: 'Starting' };
  if (behind !== null && behind > BEHIND_BLOCKS) return { ...base, reading: 'catching-up', label: `Reading history · ${blocks === null ? '…' : progress(blocks)}` };
  // The wallet counts come from an analysis, so until the first one they are not zero but unknown.
  if (c.latest === null) return { ...base, reading: 'analyzing', label: 'Analyzing' };
  if (unchecked) return { ...base, reading: 'checking', label: `Checking wallets · ${progress(wallets.of === 0 ? 0 : wallets.checked / wallets.of)}` };
  return { ...base, reading: 'complete', label: 'Up to date' };
}
