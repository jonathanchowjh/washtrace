/** Display only. Nothing here is summed or compared; amounts stay wei strings until they are drawn. */

import type { Manifest } from '@washtrace/detect';
import { formatBytes } from '@washtrace/detect/bytes';
import { EXPLORERS } from './links';

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Wei to a readable native amount, to four significant places past the point. */
export function eth(wei: string | null, unit = 'ETH'): string {
  if (wei === null) return '—';
  const n = BigInt(wei);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''} ${unit}`;
}

/** A share as a percentage: never "0%" for a share above zero, which would read as clean. */
export function pct(part: number, whole: number): string {
  if (whole === 0) return '—';
  const p = (part / whole) * 100;
  if (p === 0) return '0%';
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(p < 10 ? 1 : 0)}%`;
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** How long a wait will take, roughly: a guess is never shown to the minute. "about 40 min left". */
export function eta(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `about ${min} min left`;
  const h = Math.round(min / 60);
  return h < 24 ? `about ${h} h left` : `about ${plural(Math.round(h / 24), 'day')} left`;
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
 * The three methods as lenses, strictest first. The paper's names (SCC A, AU,
 * AC) stay in the API and README; a reader sees only these.
 * `tone` is the verdict hue: the token's own cycle, or a link through money.
 */
export const LENSES = {
  A: { name: 'Round trips', tone: 'cycle', says: 'The token keeps coming back to wallets that already held it.' },
  AU: { name: 'Money loops back', tone: 'money', says: 'The token goes one way, and the payment finds its way back to the seller through other wallets.' },
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

export function explorer(chainId: number): string {
  return EXPLORERS[chainId]?.host ?? 'https://etherscan.io';
}

/** "35–62 ETH", or "35 ETH" when both ends agree. */
export function ethRange(lowWei: string, highWei: string): string {
  return lowWei === highWei ? eth(lowWei) : `${eth(lowWei, '').trim()}–${eth(highWei)}`;
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
