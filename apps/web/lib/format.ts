/**
 * Display strings, and the lens vocabulary that is this file's main shared
 * data (LENSES: each lens's name, hue and one-line meaning, which the Trades
 * URL, the API and the pages all take as the source of truth for lens
 * identity). It also holds the stored-data size model (StoredSize,
 * storedSizes, storedLine). Amounts stay wei strings until they are drawn;
 * nothing here is summed or compared.
 */

import type { Manifest } from '@washtrace/detect';
import { formatBytes } from '@washtrace/detect/bytes';

/** A count with thousands separators, in the one locale the whole console pins (server and browser agree). */
export function num(n: number | bigint): string {
  return n.toLocaleString('en-US');
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Wei to a readable native amount, to four significant places past the point. */
export function eth(wei: string | null, unit = 'ETH'): string {
  if (wei === null) return '—';
  const n = BigInt(wei);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return `${num(whole)}${frac ? `.${frac}` : ''} ${unit}`;
}

/** A share as a percentage: never "0%" for a share above zero, which would read as clean. */
export function pct(part: number, whole: number): string {
  if (whole === 0) return '—';
  const p = (part / whole) * 100;
  if (p === 0) return '0%';
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(p < 10 ? 1 : 0)}%`;
}

/** "1 wallet", "2 wallets": `many` for a word whose plural is not an added s ("searches"). */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${num(n)} ${n === 1 ? word : many}`;
}

/** How long a wait will take, roughly: a guess is never shown to the minute. "about 40 min left". */
export function eta(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `about ${min} min left`;
  const h = Math.round(min / 60);
  return h < 24 ? `about ${h} h left` : `about ${plural(Math.round(h / 24), 'day')} left`;
}

/**
 * A duration in the unit that reads best: milliseconds under 10 s, whole seconds
 * until the rounded figure reaches two minutes, then minutes to a tenth. The unit
 * switches on the rounded seconds, so 119.9 s reads "2.0 min" and never "120 s".
 */
export function took(ms: number): string {
  if (ms < 10_000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s} s` : `${(ms / 60_000).toFixed(1)} min`;
}

/**
 * How often something repeats: seconds (to a tenth) under two minutes, then
 * minutes. Not took(), which reads a 5 s poll as "5000 ms": took() measures a
 * run, where milliseconds matter, and an interval is set in seconds.
 */
export function interval(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return s < 120 ? `${num(s)} s` : `${num(Math.round(s / 6) / 10)} min`;
}

/** What a trade or transaction no analysis has covered yet is called, wherever it is said. */
export const NOT_JUDGED_YET = 'Not judged yet';

/** A token id shortened to fit a row or heading; the full id is always one click away. */
export function tokenLabel(id: string, max = 20): string {
  return id.length > max ? `${id.slice(0, max - 2)}…` : id;
}

/** The six reading stages' short names, in order: the column heads of the pipeline table. */
export const STAGE_LABELS = ['Download', 'Load', 'Analyze stored', 'Chain', 'Money', 'Re-analyze'] as const;

/** "reading stage 4 (Chain)": a pipeline stage by number and name, so it is not mistaken for the worker's three numbered jobs. */
export function stageName(n: 1 | 2 | 3 | 4 | 5 | 6): string {
  return `reading stage ${n} (${STAGE_LABELS[n - 1]})`;
}

export type TimeStyle = 'datetime' | 'date' | 'time' | 'month';

const STYLES: Record<TimeStyle, Intl.DateTimeFormatOptions> = {
  datetime: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit' },
  month: { year: 'numeric', month: 'short' },
};

/**
 * A clock time in a zone, never "ago": a reading compared across tabs must
 * say when, not how long before some other moment. The zone is the reader's,
 * detected or chosen; called without one it is whatever zone runs it, which
 * on the server is the container's, so the console calls it in the browser.
 * `locale` is the reader's when left out, which on the server is whatever
 * the container has (often none); text built there pins one instead.
 */
export function localTime(ms: number, style: TimeStyle = 'datetime', zone?: string, locale?: string): string {
  const key = `${style}|${zone ?? ''}|${locale ?? ''}`;
  let f = formatters.get(key);
  // One formatter per style and zone: a chart asks for hundreds of labels on every hover.
  if (!f) {
    f = new Intl.DateTimeFormat(locale, zone ? { ...STYLES[style], timeZone: zone } : STYLES[style]);
    formatters.set(key, f);
  }
  return f.format(ms);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The three methods as lenses, in the order they are shown. The paper's names (SCC A, AU,
 * AC) stay in the API and README; a reader sees only these.
 * `tone` is the lens's standing as a hue: the token's own cycle, a link
 * through money, or apart (never counted, so grey everywhere).
 */
export const LENSES = {
  A: { name: 'Round trips', tone: 'cycle', says: 'The token keeps coming back to wallets that already held it.' },
  AU: { name: 'Money loops back', tone: 'apart', says: 'The token goes one way, and the payment finds its way back to the seller through other wallets.' },
  AC: { name: 'Linked wallets', tone: 'money', says: 'A round trip, or a buyer and seller joined by money: one paid the other, or both share a funder.' },
} as const;

/** "Round trips, Money loops back and Linked wallets". */
export function lensList(methods: readonly (keyof typeof LENSES)[]): string {
  const names = methods.map((m) => LENSES[m].name);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What having no Etherscan key means for the money lenses: they do not run,
 * or, while a collection's loaded money trail feeds them, they run on the
 * stored trails alone and newer wallets go unchecked.
 */
export function withoutKey(trailFunded: boolean): string {
  const money = `${LENSES.AU.name} and ${LENSES.AC.name}`;
  return trailFunded ? `${money} run only on stored money trails, and newer wallets go unchecked` : `${money} do not run`;
}

/** A file's size as the Hub shows it. Defined once in the detect package, so the dataset card says the same size (see bytes.ts). */
export { formatBytes };

/** One collection's stored files, sized: what the suggested list and the add form say of it. */
export interface StoredSize { chainId: number; address: string; name: string; transfers: number; trail: number | null }

/** The manifest as sizes, or null when none is cached yet (not the same as a manifest with no collection). */
export function storedSizes(m: Manifest | null): StoredSize[] | null {
  return m === null ? null : m.collections.map((e) => ({ chainId: e.chainId, address: e.address, name: e.name, transfers: e.transfers.bytes, trail: e.trail?.bytes ?? null }));
}

/** "stored data: 12.3 MB transfers + 3.4 GB money trail"; with no trail, the transfers alone. */
export function storedLine(s: Pick<StoredSize, 'transfers' | 'trail'>): string {
  return `stored data: ${formatBytes(s.transfers)} transfers${s.trail === null ? '' : ` + ${formatBytes(s.trail)} money trail`}`;
}
