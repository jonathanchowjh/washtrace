import type { ReactNode } from 'react';
import { HEADLINE, METHODS, type AnalysisRow, type FlaggedTransfer, type Method, type MethodTotals, type Transfer } from '@washtrace/detect';
import { LENSES, NOT_JUDGED_YET, pct, num } from './format';

/**
 * The analysis, said the way a reader asks it. One collection's answer is a
 * range from Round trips to Linked wallets. Money loops back is left out, for
 * the reason APART_WHY gives. A lens that did not run is left out of the
 * range, never read as 0%.
 *
 * It also decides, once, whether a trade is flagged and counted and how a
 * page titles it (toneOf, counted, verdict, answer): the transaction, token
 * and wallet pages and their routes all read it, and none decides it again.
 */

export type Measure = 'sales' | 'volume' | 'owners';

/** One lens's share of one measure. Volume in micro-ETH: enough for a share, and it fits a number. */
export function part(t: MethodTotals, measure: Measure): { part: number; whole: number } {
  if (measure === 'sales') return { part: t.flaggedSales, whole: t.sales };
  if (measure === 'owners') return { part: t.flagged, whole: t.transfers };
  return { part: Number(BigInt(t.flaggedVolumeWei) / 10n ** 12n), whole: Number(BigInt(t.volumeWei) / 10n ** 12n) };
}

/** The lenses the headline range reads, Round trips to Linked wallets. Money loops back runs and keeps its card, but is not counted. */
export { HEADLINE };

/** The lenses that run and are shown but never counted: all but HEADLINE. */
export const APART: readonly Method[] = METHODS.filter((m) => !HEADLINE.includes(m));

/** Why they are not counted, said wherever a page names one. */
export const APART_WHY = 'on real data it flags as many sales as it does with buyers relabelled at random among wallets of similar activity, so it is not counted';

/** What a page says of a trade no analysis has covered: unread is not clean. */
export const NOT_JUDGED = 'Its transfers are read, but no analysis has covered them yet. That is not the same as clean.';

/** The lead of any table of trades, saying what the row tints mean. */
export const TINT_LEAD = `Rows tinted for ${LENSES.A.name} or ${LENSES.AC.name} are flagged; grey rows are flagged only by ${LENSES.AU.name}, which is not counted.`;

/** How a trade, or a whole page, reads: the hue of the strongest counted lens, grey for an apart lens alone. */
export type Tone = 'cycle' | 'money' | 'apart' | 'clean';

/** A trade's tone from flags already passed through ranFlags. Round trips outranks the other counted lens. */
export function toneOf(t: Pick<FlaggedTransfer, 'flags'>): Tone {
  if (t.flags.A) return 'cycle';
  if (HEADLINE.some((m) => t.flags[m])) return 'money';
  return APART.some((m) => t.flags[m]) ? 'apart' : 'clean';
}

/** Whether a trade counts toward the verdict: a counted lens flags it. One flagged only by an apart lens is shown grey, and not counted. */
export function counted(t: Pick<FlaggedTransfer, 'flags'>): boolean {
  const tone = toneOf(t);
  return tone === 'cycle' || tone === 'money';
}

/** Whether an analysis covers a transfer: only one that ran through the transfer's block can have judged it. */
export function judged(t: Pick<Transfer, 'blockNumber'>, latest: Pick<AnalysisRow, 'throughBlock'> | null): boolean {
  return latest !== null && latest.throughBlock !== null && t.blockNumber <= latest.throughBlock;
}

/**
 * The transfer with only the flags of lenses that ran in its collection's
 * latest analysis. When no funding ran the engine copies Round trips' flags
 * into the money lenses, so those copies must never be shown or counted. With
 * no analysis (null) nothing is known to have run, so no flag is kept; such a
 * transfer is not judged anyway.
 */
export function ranFlags<T extends Pick<FlaggedTransfer, 'flags'>>(t: T, latest: Pick<AnalysisRow, 'totals'> | null): T {
  const flags = Object.fromEntries(Object.entries(t.flags).filter(([m, w]) => w && latest?.totals[m as Method]?.available === true));
  return { ...t, flags };
}

/**
 * The lenses that ran in a collection's latest analysis, for a Trades read's
 * `ctx.ran`: the store reads no other lens's flags, for the reason ranFlags
 * gives. None without an analysis.
 */
export function lensesRan(latest: Pick<AnalysisRow, 'totals'> | null): Method[] {
  return METHODS.filter((m) => latest?.totals[m]?.available === true);
}

export interface Verdict {
  judged: boolean;
  /** True when a headline lens that ran flags a transfer; null when none does but some transfer is not judged; else false. */
  washTrade: boolean | null;
  /** The lenses that flag any transfer and ran. The engine copies Round trips' flags into the money lenses when no funding ran, so a lens that did not run never counts. */
  by: Method[];
  /** Money loops back alone flags it: shown, but not counted. */
  apartOnly: boolean;
  /** The lenses that did not run in at least one of the analyses. */
  notRun: Method[];
}

/** One answer for a set of transfers and the latest analysis of each one's collection (null: none yet). The tx, token and wallet pages and their routes all read it. */
export function verdict(rows: readonly { t: FlaggedTransfer; latest: AnalysisRow | null }[]): Verdict {
  const by = METHODS.filter((m) => rows.some((r) => ranFlags(r.t, r.latest).flags[m]));
  const notRun = METHODS.filter((m) => rows.some((r) => r.latest !== null && !r.latest.totals[m].available));
  const all = rows.length > 0 && rows.every((r) => judged(r.t, r.latest));
  const washTrade = by.some((m) => HEADLINE.includes(m)) ? true : all ? false : null;
  return { judged: all, washTrade, by, apartOnly: by.length > 0 && by.every((m) => APART.includes(m)), notRun };
}

/** The title and tone every page gives a verdict. `flagged` is the page's own title for a wash trade. */
export function answer(v: Verdict, flagged: ReactNode): { title: ReactNode; tone: Tone } {
  if (v.washTrade === true) return { title: flagged, tone: v.by.includes('A') ? 'cycle' : 'money' };
  if (v.washTrade === null) return { title: NOT_JUDGED_YET, tone: 'clean' };
  if (v.apartOnly) return { title: `Flagged only by ${LENSES.AU.name}, which is not counted`, tone: 'apart' };
  return { title: v.notRun.length === 0 ? 'Not flagged by any lens' : 'Not flagged by the lenses that ran', tone: 'clean' };
}

/** The one API shape of a verdict: `by` is published as `methods`. The tx, token and wallet routes spread it. */
export function verdictFields(v: Verdict): { washTrade: boolean | null; judged: boolean; methods: Method[]; apartOnly: boolean; notRun: Method[] } {
  return { washTrade: v.washTrade, judged: v.judged, methods: v.by, apartOnly: v.apartOnly, notRun: v.notRun };
}

export interface Range { low: Method; high: Method; lowShare: number; highShare: number }

/** Null when no lens ran or there is nothing to divide by, such as a collection with no priced sale. */
export function range(totals: Record<Method, MethodTotals>, measure: Measure): Range | null {
  const read = HEADLINE.filter((m) => totals[m].available)
    .map((m) => ({ m, ...part(totals[m], measure) }))
    .filter((r) => r.whole > 0)
    .map((r) => ({ m: r.m, share: r.part / r.whole }));
  if (read.length === 0) return null;
  // Stable over HEADLINE's order, so a tie keeps Round trips low and Linked wallets high.
  const sorted = [...read].sort((a, b) => a.share - b.share);
  const low = sorted[0]!, high = sorted[sorted.length - 1]!;
  return { low: low.m, high: high.m, lowShare: low.share, highShare: high.share };
}

/** The two ends as drawn: "18" and "25%", or one "18%" when the lenses agree. */
export function rangeEnds(r: Range): { low: string; high: string; same: boolean } {
  const lo = pct(r.lowShare, 1), hi = pct(r.highShare, 1);
  return { low: lo.replace('%', ''), high: hi, same: lo === hi };
}

/** The range in a sentence: what Round trips counts, and what Linked wallets adds. */
export function summary(totals: Record<Method, MethodTotals>): string {
  const a = totals.A;
  if (a.sales === 0) return `No sale read yet, so there is no share of sales. ${num(a.flagged)} of ${num(a.transfers)} changes of owner are round trips.`;
  const strict = a.flaggedSales === 0
    ? `None of the ${num(a.sales)} sales is a round trip between the same wallets.`
    : `${num(a.flaggedSales)} of ${num(a.sales)} sales are round trips between the same wallets.`;
  if (!totals.AC.available) return `${strict} Money links between buyers and sellers were not checked, so this is the strict count alone.`;
  const wide = totals.AC.flaggedSales;
  return wide > a.flaggedSales
    ? `${strict} Counting buyers and sellers linked by money, up to ${num(wide)} are.`
    : `${strict} Following the money adds none.`;
}

/** The lead of "How was it found?": which lenses make the range above, and why Money loops back is shown apart. Linked wallets not run leaves Round trips as the whole range. */
export function evidenceLead(totals: Record<Method, MethodTotals>): string {
  const apart = `${LENSES.AU.name} is shown apart: ${APART_WHY}. Choose a lens to see the tokens and wallets it flags.`;
  return totals.AC.available
    ? `${LENSES.A.name} and ${LENSES.AC.name} are the two ends of the range above. Between a third and a half of what ${LENSES.AC.name} adds over ${LENSES.A.name} is chance. ${apart}`
    : `${LENSES.A.name} is the whole range above: ${LENSES.AC.name} has not run. ${apart}`;
}
