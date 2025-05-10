/**
 * The reader's time zone: detected in the browser, changeable from the
 * sidebar, and kept in a cookie so the server can bucket a collection's
 * history by the same calendar the browser labels it with. Free of server
 * imports, because both sides read it.
 *
 * The cookie holds an IANA name. `auto:` in front marks one that was
 * detected rather than chosen, so it follows the reader when they travel.
 */

export const ZONE_COOKIE = 'washtrace_tz';

export interface ZoneChoice { zone: string; auto: boolean }

/** A zone the platform knows, by its canonical name, or null. Browsers and Postgres both read IANA names. */
export function validZone(name: string | null | undefined): string | null {
  if (!name || name.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The cookie's value, read; null when it is absent or names no zone. */
export function parseZone(value: string | null | undefined): ZoneChoice | null {
  if (!value) return null;
  const auto = value.startsWith('auto:');
  const zone = validZone(auto ? value.slice(5) : value);
  return zone === null ? null : { zone, auto };
}

export function detectedZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of an instant in a zone. */
function wall(ms: number, zone: string) {
  let f = partsCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    partsCache.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(ms)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year!, m: p.month! - 1, d: p.day!, h: p.hour! % 24, mi: p.minute!, s: p.second! };
}

/** How far a zone's clock is ahead of UTC at an instant, in ms; it moves with daylight saving. */
export function offsetAt(ms: number, zone: string): number {
  const w = wall(ms, zone);
  return Date.UTC(w.y, w.m, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant a zone's clock reads midnight on a date. Month and day overflow as in Date.UTC. */
export function midnight(y: number, m: number, d: number, zone: string): number {
  const guess = Date.UTC(y, m, d);
  const first = guess - offsetAt(guess, zone);
  // Once more, for a date whose offset differs from the guess's across a daylight-saving change.
  return guess - offsetAt(first, zone);
}

/** The calendar date an instant falls on, in a zone. */
export function dateIn(ms: number, zone: string): { y: number; m: number; d: number } {
  const w = wall(ms, zone);
  return { y: w.y, m: w.m, d: w.d };
}
