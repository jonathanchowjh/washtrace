/**
 * The bands a trade's facts fall into, and the words a Trades list is asked
 * in, shared by the store that reads them and the console that filters on
 * them. It imports only types, so the client can take it without the engine.
 */

import type { Method } from './types.js';

/** Band = count of edges at or below the value: 0 <1 h, 1 1 h–1 d, 2 1–30 d, 3 >30 d. */
export const HELD_BANDS = [3_600, 86_400, 30 * 86_400] as const;
/** 0 <1 d, 1 1–30 d, 2 >30 d. */
export const AGE_BANDS = [86_400, 30 * 86_400] as const;
/** 0 <0.5×, 1 0.5–0.9×, 2 0.9–1.1×, 3 1.1–2×, 4 >2×. */
export const FLOOR_BANDS = [0.5, 0.9, 1.1, 2] as const;
/** How many UTC days before a sale its floor looks back over. */
export const FLOOR_DAYS = 7;

/** The band a value falls in, or null when it has no value. */
export function band(edges: readonly number[], value: number | null): number | null {
  if (value === null) return null;
  let n = 0;
  for (const e of edges) if (e <= value) n += 1;
  return n;
}

// ---- which trades a list holds ----------------------------------------------

/**
 * Marketplaces by the name a reader knows them by, each with every raw string
 * a sale can be tagged with: every Seaport, and Wyvern before it, is OpenSea's.
 * The raw lists are what MARKETPLACES in marketplaces.ts can produce; a test
 * holds the two together, so a new contract is named here when it is added.
 */
export const VENUES: Readonly<Record<string, { name: string; raw: readonly string[] }>> = {
  opensea: { name: 'OpenSea', raw: ['seaport-1.1', 'seaport-1.4', 'seaport-1.5', 'seaport-1.6', 'wyvern-1', 'wyvern-2'] },
  blur: { name: 'Blur', raw: ['blur', 'blur-v2'] },
  looksrare: { name: 'LooksRare', raw: ['looksrare', 'looksrare-v2'] },
  x2y2: { name: 'X2Y2', raw: ['x2y2'] },
};

const VENUE_OF: ReadonlyMap<string, string> = new Map(Object.entries(VENUES).flatMap(([key, v]) => v.raw.map((r) => [r, key] as const)));

/** A raw marketplace string's VENUES key; a string no venue lists is its own key. */
export function venueOf(raw: string): string {
  return VENUE_OF.get(raw) ?? raw;
}

export type TradeSort = 'date' | 'price' | 'held' | 'buyerAge' | 'floor' | 'token' | 'marketplace' | 'seller' | `lens-${Method}`;
/** The wallets in one lens's loops: those on a token, or those sharing a loop with a wallet. */
export type GroupRef = { method: Method; token: string } | { method: Method; wallet: string };
export type TradeGroupBy = 'marketplace' | 'month' | 'held' | 'floor' | 'buyerAge';

/**
 * What a Trades list asks for. The store reads it in one place, so the page,
 * its count, its groups and its CSV always hold the same trades. Price bounds
 * take both ends. The fact bounds are [over, under), as the bands read them,
 * so a band's two edges give exactly its trades.
 */
export interface TradeQuery {
  kind: 'sales' | 'all';
  caught: Method[]; notCaught: Method[];
  /** VENUES keys. */
  venues: string[];
  priceMinWei: string | null; priceMaxWei: string | null;
  heldOverS: number | null; heldUnderS: number | null;
  buyerAgeOverS: number | null; buyerAgeUnderS: number | null;
  floorMin: number | null; floorMax: number | null;
  /** [from, to), instants. */
  fromMs: number | null; toMs: number | null;
  wallet: string | null; group: GroupRef | null; token: string | null;
  /** Read as findOf reads it: a token number, a tx hash, a wallet, or the start of one. */
  find: string | null;
  sort: TradeSort; dir: 'asc' | 'desc';
}

export const NO_FILTER: TradeQuery = {
  kind: 'sales', caught: [], notCaught: [], venues: [], priceMinWei: null, priceMaxWei: null,
  heldOverS: null, heldUnderS: null, buyerAgeOverS: null, buyerAgeUnderS: null, floorMin: null, floorMax: null,
  fromMs: null, toMs: null, wallet: null, group: null, token: null, find: null, sort: 'date', dir: 'desc',
};

/**
 * What a list is read against: what counts as money on its chain, the lenses
 * that ran in its latest analysis (the engine copies Round trips' flags into
 * the money lenses when no funding ran, so no other lens's flags are read),
 * and the reader's time zone, for months.
 */
export interface TradeContext { money: ReadonlySet<string>; ran: readonly Method[]; zone: string }

export type Find =
  | { kind: 'token'; tokenId: string } | { kind: 'tx'; tx: string } | { kind: 'address'; address: string }
  | { kind: 'prefix'; prefix: string } | { kind: 'none' };

/**
 * What a Find box's text names, by the rules of parseSearch in
 * apps/web/lib/search.ts, its twin: detect cannot import the console, so a
 * change to one is made to both. One difference: inside one collection any
 * number is a token, where search wants three digits or a '#' before it reads
 * every collection's tokens.
 */
export function findOf(raw: string): Find {
  const typed = raw.trim();
  const hashed = typed.startsWith('#');
  const text = (hashed ? typed.slice(1) : typed).trim();
  if (/^0x[0-9a-f]+$/i.test(text) && !hashed) {
    const hex = text.toLowerCase();
    if (hex.length === 66) return { kind: 'tx', tx: hex };
    if (hex.length === 42) return { kind: 'address', address: hex };
    if (hex.length >= 6 && hex.length < 42) return { kind: 'prefix', prefix: hex };
  }
  if (/^\d{1,78}$/.test(text)) return { kind: 'token', tokenId: BigInt(text).toString() };
  return { kind: 'none' };
}
