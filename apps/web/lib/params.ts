/**
 * Reading what a URL, a path or a JSON body says: ids, addresses, pages and
 * Find text. Import-free, so a client component, lib/trades-url.ts and
 * lib/search.ts read it as well as the pages and routes, and one rule is
 * written once. lib/api.ts re-exports the id readers for the routes.
 */

export function chainOf(raw: string): number | null {
  return /^\d{1,10}$/.test(raw) ? Number(raw) : null;
}

/** A chain id in a JSON body: the same range a path accepts, and not 0. */
export function chainIdOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e10 ? v : null;
}

/** A row id in a path, such as a Test's: digits a double holds exactly. */
export function idOf(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

/** Lowercased, because every address in the store is. */
export function addressOf(raw: string): string | null {
  const a = raw.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
}

export function txOf(raw: string): string | null {
  const t = raw.toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(t) ? t : null;
}

export function tokenIdOf(raw: string): string | null {
  return /^\d{1,78}$/.test(raw) ? BigInt(raw).toString() : null;
}

/** Longest Find text kept; a name is never longer, and a URL can carry anything. */
export const MAX_TEXT = 100;

/** The Find text of a URL: trimmed and cut, or null when nothing is left. */
export function findText(raw: string | undefined): string | null {
  return raw?.trim().slice(0, MAX_TEXT) || null;
}

/** A page number from a URL: a whole number from 1, else the first. */
export function pageOf(raw: string | undefined): number {
  const n = Number(raw ?? '1');
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

/** How many pages `total` rows make at `size` a page: at least one, so an empty list still has a first. */
export function pages(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}
