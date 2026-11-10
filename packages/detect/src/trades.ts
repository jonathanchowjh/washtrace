/**
 * The bands a trade's facts fall into, and the words a Trades list is asked
 * in, shared by the store that reads them and the console that filters on
 * them. It imports only types.ts and lens-rule.ts, which hold no server code,
 * so the client can take it without the engine.
 */

import { INT4_MAX, UINT256_DIGITS } from './lens-rule.js';
import { METHODS, type Method } from './types.js';

/**
 * A lens a list can be read by: a built-in method, or `L<id>` for a saved lens
 * of yours. The id is the lens's row, so a key can outlive the lens it named.
 */
export type LensKey = Method | `L${number}`;

const TOKEN_ID = new RegExp(`^\\d{1,${UINT256_DIGITS}}$`);
const OWN_KEY = /^L[1-9]\d{0,9}$/;

const ownId = (s: string): number | null => (OWN_KEY.test(s) && Number(s.slice(1)) <= INT4_MAX ? Number(s.slice(1)) : null);

/** Whether `s` is a built-in's key or `L` and a positive whole number that fits int4: L0, L01, Lx and L2147483648 are junk. */
export function isLensKey(s: string): s is LensKey {
  return (METHODS as readonly string[]).includes(s) || ownId(s) !== null;
}

/** The saved lens a key names, or null for a built-in. */
export function lensIdOf(k: LensKey): number | null {
  return ownId(k);
}

/** Whether `s` is the key of a lens of yours (`L` and an int4 id): the one test of it, for the store, its SQL and the console alike. */
export function isOwnKey(s: string): s is `L${number}` {
  return ownId(s) !== null;
}

/** Band = count of edges at or below the value: 0 <1 h, 1 1 h–1 d, 2 1–30 d, 3 >30 d. */
export const HELD_BANDS = [3_600, 86_400, 30 * 86_400] as const;
/** 0 <1 d, 1 1–30 d, 2 >30 d. */
export const AGE_BANDS = [86_400, 30 * 86_400] as const;
/** 0 <0.5×, 1 0.5–0.9×, 2 0.9–1.1×, 3 1.1–2×, 4 >2×. */
export const FLOOR_BANDS = [0.5, 0.9, 1.1, 2] as const;

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

export type TradeSort = 'date' | 'price' | 'held' | 'buyerAge' | 'floor' | 'token' | 'marketplace' | 'seller' | `lens-${LensKey}`;
/** The wallets in one lens's loops: those on a token, or those sharing a loop with a wallet. */
export type GroupRef = { method: LensKey; token: string } | { method: LensKey; wallet: string };
export type TradeGroupBy = 'marketplace' | 'month' | 'held' | 'floor' | 'buyerAge';

/**
 * What a Trades list asks for. The store reads it in one place, so the page,
 * its count, its groups and its CSV always hold the same trades. Price bounds
 * take both ends. The fact bounds are [over, under), as the bands read them,
 * so a band's two edges give exactly its trades.
 */
export interface TradeQuery {
  kind: 'sales' | 'all';
  caught: LensKey[]; notCaught: LensKey[];
  /** VENUES keys. */
  venues: string[];
  priceMinWei: string | null; priceMaxWei: string | null;
  heldOverS: number | null; heldUnderS: number | null;
  buyerAgeOverS: number | null; buyerAgeUnderS: number | null;
  floorMin: number | null; floorMax: number | null;
  /** [from, to), instants. */
  fromMs: number | null; toMs: number | null;
  wallet: string | null; group: GroupRef | null; token: string | null;
  /** A ring's anchor (rings.ts): the trades its counted evidence flags. */
  ring: string | null;
  /** Read as findOf reads it: a token number, a tx hash, a wallet, or the start of one. */
  find: string | null;
  sort: TradeSort; dir: 'asc' | 'desc';
}

export const NO_FILTER: TradeQuery = {
  kind: 'sales', caught: [], notCaught: [], venues: [], priceMinWei: null, priceMaxWei: null,
  heldOverS: null, heldUnderS: null, buyerAgeOverS: null, buyerAgeUnderS: null, floorMin: null, floorMax: null,
  fromMs: null, toMs: null, wallet: null, group: null, token: null, ring: null, find: null, sort: 'date', dir: 'desc',
};

/**
 * What a list is read against: what counts as money on its chain, the lenses
 * that ran in its latest analysis (the engine copies Round trips' flags into
 * the money lenses when no funding ran, so no other lens's flags are read; a
 * saved lens is there when it has a finished run),
 * and the reader's time zone, for months.
 *
 * `through` is, for each lens of yours in `ran`, the block its run read
 * through (`LensRun.throughBlock`): it judged nothing past it, so a trade past
 * it is "not judged yet" by that lens, neither caught nor "not flagged by",
 * and no denominator of it counts the trade. A lens with no entry,
 * or a null one, read every trade. Built-ins take none: their flags and facts
 * are written together.
 */
export interface TradeContext {
  money: ReadonlySet<string>; ran: readonly LensKey[]; zone: string;
  through?: Readonly<Partial<Record<LensKey, number | null>>>;
}

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
  if (TOKEN_ID.test(text)) return { kind: 'token', tokenId: BigInt(text).toString() };
  return { kind: 'none' };
}
