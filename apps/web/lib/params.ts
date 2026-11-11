/**
 * Reading what a URL, a path or a JSON body says: ids, addresses, pages and
 * Find text, and what a list's or the wallet page's URL asks for. Its only
 * value import is detect's lens-rule, which is client-safe (the rest are
 * types), so a client component, lib/trades-url.ts and lib/search.ts read it
 * as well as the pages and routes, and one rule is written once.
 */

import type { FlowDir, PartnerSort, WalletFilter } from '@washtrace/detect';
import { UINT256_DIGITS } from '@washtrace/detect/lens-rule';

const TOKEN_ID = new RegExp(`^\\d{1,${UINT256_DIGITS}}$`);

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
  return TOKEN_ID.test(raw) ? BigInt(raw).toString() : null;
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

/** Each list's orders, as the URL names them and as its sort links read. */
export const SORTS = {
  tokens: [['caught', 'most flagged'], ['share', 'share'], ['volume', 'volume'], ['newest', 'newest']],
  wallets: [['caught', 'most flagged'], ['share', 'share'], ['volume', 'volume'], ['first', 'first seen']],
} as const;

/** A list's page, order and Find from the URL. Junk is dropped: an unknown order is the default, and a page under 1 is the first. */
export function listView(kind: 'tokens' | 'wallets', raw: { page?: string; sort?: string; find?: string }): { page: number; sort: string; find: string | null } {
  return {
    page: pageOf(raw.page),
    sort: SORTS[kind].some(([s]) => s === raw.sort) ? raw.sort! : 'caught',
    find: findText(raw.find),
  };
}

/**
 * What the wallet page and route ask for: each list's page, the trades' filter, and which payments between it and `filter.with`.
 * `partners` is the page of counterparties; the URL param and `pages.partners` keep that name.
 */
export type WalletOpts = { trades: number; partners: number; flows: number; filter: WalletFilter; dir: FlowDir; psort: PartnerSort };

const PARTNER_SORTS: readonly PartnerSort[] = ['flows', 'sent', 'received', 'watched'];

/**
 * The wallet page's and route's params as one reading. Junk is dropped: a
 * page under 1 or not a number is the first, a collection or `with` that is
 * no address is none, `flagged` is only `1`, and an unknown order or
 * direction is the default.
 */
export function walletOpts(q: Record<string, string | string[] | undefined>): WalletOpts {
  const one = (k: string) => { const v = q[k]; return Array.isArray(v) ? v[0] : v; };
  const filter: WalletFilter = {};
  const collection = addressOf(one('collection') ?? '');
  if (collection !== null) filter.collection = collection;
  if (one('flagged') === '1') filter.flaggedOnly = true;
  const find = findText(one('q'));
  if (find) filter.find = find;
  const other = addressOf(one('with') ?? '');
  if (other !== null) filter.with = other;
  const dir = one('dir');
  const psort = PARTNER_SORTS.find((s) => s === one('psort')) ?? 'flows';
  return { trades: pageOf(one('trades')), partners: pageOf(one('partners')), flows: pageOf(one('flows')), filter, dir: dir === 'sent' || dir === 'received' ? dir : 'both', psort };
}

/**
 * This page with `o`'s lists, filter and pages, defaults left out. Every link
 * and pager here builds on the page as shown, so moving one list keeps the
 * others where they are.
 */
export function hrefOf(base: string, o: WalletOpts): string {
  const sp = new URLSearchParams();
  const f = o.filter;
  if (f.collection !== undefined) sp.set('collection', f.collection);
  if (f.flaggedOnly) sp.set('flagged', '1');
  if (f.find !== undefined) sp.set('q', f.find);
  if (o.trades > 1) sp.set('trades', String(o.trades));
  if (o.psort !== 'flows') sp.set('psort', o.psort);
  if (o.partners > 1) sp.set('partners', String(o.partners));
  if (f.with !== undefined) {
    sp.set('with', f.with);
    if (o.dir !== 'both') sp.set('dir', o.dir);
    if (o.flows > 1) sp.set('flows', String(o.flows));
  }
  const q = sp.toString();
  return q === '' ? base : `${base}?${q}`;
}
