/**
 * A lens's rule: which edges it follows, how far, and what it never flags. The
 * editor draws it and the engine runs it, so both read the one shape, and the
 * routes check it here before it is stored. It imports only types, so the
 * client can take it without the engine.
 */

import type { Method } from './types.js';

export type EdgeKind = 'nft-token' | 'nft-collection' | 'nft-watched' | 'eth' | 'internal' | 'weth' | 'other-tokens';

export interface EdgeRule {
  use: boolean;
  direction: 'along' | 'either';
  /** Most edges of this type in one loop; null is no limit. */
  max: number | null;
  /** Smallest money edge counted, in wei; null is any. Unused by NFT rows. */
  minWei: string | null;
  repeats: 'each' | 'once';
}

export interface LensRule {
  edges: Record<EdgeKind, EdgeRule>;
  /** Wallets passed through between seller and buyer; max null is "any". */
  hops: { min: number; max: number | null };
  closes: 'seller' | 'seller-or-funder';
  /** Edges count when their time is within `days` of the trade; null is any time. */
  window: { days: number; side: 'after' | 'before' | 'either' } | null;
  order: 'loop' | 'any';
  never: { marketplaces: boolean; over: number | null; addresses: string[] };
  judges: 'sales' | 'owners';
  minCycles: number;
}

export const EDGE_TYPES: readonly { kind: EdgeKind; label: string; money: boolean; unavailable: string | null }[] = [
  { kind: 'nft-token', label: 'NFT: same token', money: false, unavailable: null },
  { kind: 'nft-collection', label: 'NFT: other tokens in this collection', money: false, unavailable: null },
  { kind: 'nft-watched', label: 'NFT: other watched collections', money: false, unavailable: "Not in this version: a lens reads this collection's transfers." },
  { kind: 'eth', label: 'ETH payment', money: true, unavailable: null },
  { kind: 'internal', label: 'ETH sent by a contract (internal)', money: true, unavailable: null },
  { kind: 'weth', label: 'WETH (Blur Pool included)', money: true, unavailable: null },
  { kind: 'other-tokens', label: 'Other tokens', money: true, unavailable: null },
];

/**
 * A wallet that sent money to more wallets than this is not followed. Mule
 * wallets in a wash ring pay a handful; a wallet paying dozens is a business,
 * a bot or a person with a life, and following it reads half the chain. It
 * lives here, not in the store that follows by it, so the client can say it.
 */
export const FOLLOW_FANOUT = 25;

/** The money rows the money check reads (flows): the ETH and WETH walk. Other tokens have a read of their own (token_flows). */
export const WALKED: readonly EdgeKind[] = ['eth', 'internal', 'weth'];

const KINDS = EDGE_TYPES.map((e) => e.kind);
/** The digits of the largest uint256: the most a wei amount or a token id has. */
export const UINT256_DIGITS = 78;
const WEI_FLOOR = '10000000000000000'; // 0.01 ETH
const MAX_HOPS = 6;
/** The most hops the follow.hops setting allows (env.ts hops()): the console's Settings check, a collection's own limit (follow route) and a lens's need (data-needs) are all bounded by it. Here, not in env.ts, so the console's client components can import it. */
export const MOST_HOPS = 10;
// The routes take rules from anyone who may write, so every number and list is bounded.
const MAX_DAYS = 3650;
const MAX_PER_LOOP = 100;
const MAX_OVER = 1_000_000_000;
const MAX_ADDRESSES = 200;

const row = (use: boolean, direction: EdgeRule['direction'], max: number | null, minWei: string | null, repeats: EdgeRule['repeats']): EdgeRule =>
  ({ use, direction, max, minWei, repeats });

export const DEFAULT_RULE: LensRule = {
  edges: {
    'nft-token': row(true, 'along', null, null, 'each'),
    'nft-collection': row(true, 'along', 2, null, 'once'),
    'nft-watched': row(false, 'along', null, null, 'each'),
    eth: row(true, 'either', 2, WEI_FLOOR, 'each'),
    internal: row(true, 'either', 1, WEI_FLOOR, 'each'),
    weth: row(true, 'along', 2, WEI_FLOOR, 'each'),
    'other-tokens': row(false, 'along', null, null, 'each'),
  },
  hops: { min: 1, max: 3 },
  closes: 'seller',
  window: { days: 30, side: 'either' },
  order: 'any',
  // 20, the built-ins' hubDegree. `over` counts the collection's wallets a wallet is linked to by money.
  never: { marketplaces: true, over: 20, addresses: [] },
  judges: 'sales',
  minCycles: 1,
};

// ---- checking ---------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T => allowed.includes(v as T);

/**
 * The rule as the engine may run it, or the first reason it may not. Anything
 * unknown at the top level is dropped; anything wrong inside is refused.
 */
export function checkRule(raw: unknown): { rule: LensRule } | { error: string } {
  if (!isObject(raw) || !isObject(raw.edges) || !isObject(raw.hops) || !isObject(raw.never)) return { error: 'Not a lens rule.' };

  for (const k of Object.keys(raw.edges)) if (!KINDS.includes(k as EdgeKind)) return { error: `Unknown edge type: ${k}.` };
  const edges = {} as Record<EdgeKind, EdgeRule>;
  for (const { kind, label } of EDGE_TYPES) {
    const e = raw.edges[kind];
    if (e === undefined) { edges[kind] = row(false, 'along', null, null, 'each'); continue; }
    if (isObject(e) && isCount(e.max) && e.max > MAX_PER_LOOP) return { error: `"${label}": at most ${MAX_PER_LOOP} in a loop.` };
    if (isObject(e) && typeof e.minWei === 'string' && e.minWei.length > UINT256_DIGITS) return { error: `"${label}": the smallest payment has at most ${UINT256_DIGITS} digits in wei.` };
    if (!isObject(e) || typeof e.use !== 'boolean' || !oneOf(e.direction, ['along', 'either']) || !oneOf(e.repeats, ['each', 'once'])
      || !(e.max === null || isCount(e.max)) || !(e.minWei === null || (typeof e.minWei === 'string' && /^\d+$/.test(e.minWei)))) {
      return { error: `"${label}" is not a valid edge rule.` };
    }
    edges[kind] = row(e.use, e.direction, e.max, e.minWei, e.repeats);
  }
  for (const { kind, unavailable } of EDGE_TYPES) if (unavailable && edges[kind].use) return { error: unavailable };
  // No smallest amount on other tokens: a floor in raw units means one thing at 6 decimals and another at 18, and washtrace has no prices.
  // Only with the row on: off, the value is read by nothing, and a rule saved so must not read as corrupt.
  if (edges['other-tokens'].use && edges['other-tokens'].minWei !== null) return { error: 'Other tokens take no smallest amount: tokens differ in value.' };
  if (!KINDS.some((k) => edges[k].use)) return { error: 'Switch on at least one edge type.' };

  const { min, max } = raw.hops;
  if (!isCount(min) || !(max === null || isCount(max))) return { error: 'Not a lens rule.' };
  if (max !== null && min > max) return { error: 'Hops: "from" is more than "to".' };
  const onlySameToken = KINDS.every((k) => (k === 'nft-token') === edges[k].use);
  if (min > MAX_HOPS || (max === null ? !onlySameToken : max > MAX_HOPS)) {
    return { error: 'Hops go from 0 to 6, or "any" when only "NFT: same token" is on.' };
  }
  // "Any" is reachability, judged by the first way back found breadth first: exact only from 0.
  if (max === null && min > 0) return { error: 'With "any" length, the fewest wallets between must be 0.' };

  if (!oneOf(raw.closes, ['seller', 'seller-or-funder']) || !oneOf(raw.order, ['loop', 'any']) || !oneOf(raw.judges, ['sales', 'owners'])) {
    return { error: 'Not a lens rule.' };
  }

  const minCycles = raw.minCycles;
  if (!isCount(minCycles) || minCycles < 1) return { error: 'Loops: a whole number, 1 or more.' };
  if (minCycles > 1 && !edges['nft-token'].use) return { error: `At least ${minCycles} loops needs "NFT: same token" switched on.` };

  let window: LensRule['window'] = null;
  if (raw.window !== null) {
    const w = raw.window;
    if (!isObject(w) || !isCount(w.days) || w.days < 1 || !oneOf(w.side, ['after', 'before', 'either'])) return { error: 'Window: days from 1, and a side.' };
    if (w.days > MAX_DAYS) return { error: `Window: at most ${MAX_DAYS} days.` };
    window = { days: w.days, side: w.side };
  }
  if (raw.order === 'loop' && window?.side === 'before') return { error: 'Edges in loop order cannot all be before the trade.' };

  const { marketplaces, over, addresses } = raw.never;
  if (typeof marketplaces !== 'boolean' || !(over === null || isCount(over)) || !Array.isArray(addresses)) return { error: 'Not a lens rule.' };
  if (over !== null && over > MAX_OVER) return { error: `Never pass through: linked wallets at most ${MAX_OVER.toLocaleString('en-US')}.` };
  if (addresses.length > MAX_ADDRESSES) return { error: `Never pass through: at most ${MAX_ADDRESSES} addresses.` };
  const clean = new Set<string>();
  for (const a of addresses) {
    if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) return { error: `Not an address: ${String(a)}.` };
    clean.add(a.toLowerCase());
  }

  return {
    rule: {
      edges,
      hops: { min, max },
      closes: raw.closes,
      window,
      order: raw.order,
      never: { marketplaces, over, addresses: [...clean] },
      judges: raw.judges,
      minCycles,
    },
  };
}

// ---- the data a rule needs ----------------------------------------------------

/**
 * How many hops out from a trader the money check must have read for every
 * money path the rule can find to be in the flows: 0 is the traders alone.
 *
 * `Store.saveMoney` stores every flow of a checked wallet and queues only the
 * wallets it sent to, one hop further out, so an edge is stored when one end is
 * checked. Take buyer → w1 → … → wk → seller. The buyer's and the seller's own
 * lists hold the first and last edge, and wi → wi+1 needs wi checked, which
 * wallet w(k-1) at hop k - 1 settles: `hops.max` k needs max(0, k - 1).
 *
 * Both `closes` give that. A funder is the k-th wallet, one of the k middles,
 * and the edge it paid the seller is in the seller's own list. Counting the
 * funder one hop further (k) would ask for a depth the engine never needs: it
 * closes at a funder after k edges grown, and the funding edge, in the
 * seller's own list, is not one of them.
 *
 * `direction: 'either'` does not raise it. A path walked against the money
 * (w sent to the wallet before it) is stored only when one end is checked, and
 * the follow reaches wallets only along sent money, so a path whose middle
 * edge runs against it, between two wallets nobody checked sent to, is in no
 * depth's flows. No depth completes it; the number is the worst the follow can
 * reach. Money reached by an NFT hop restarts at a trader (hop 0), so it needs
 * less. With `hops.max` null only the token's own hops are read: no money.
 *
 * Only the ETH and WETH rows count: other tokens are read by a read of
 * their own, whose coverage the tokens row decides, so a lens using them
 * alone needs no money read.
 */
export function depthNeeded(rule: LensRule): number {
  const money = WALKED.some((k) => rule.edges[k].use);
  return money && rule.hops.max !== null ? Math.max(0, rule.hops.max - 1) : 0;
}

// ---- names and ids -----------------------------------------------------------

/** The most characters a lens's name has, trimmed: it heads a tab, a chip and a CSV column. */
export const NAME_MAX = 60;

/** Postgres int4's top: a lens id past it would reach a bound int4 parameter and fail the query. */
export const INT4_MAX = 2_147_483_647;

/** Why `raw`, trimmed, cannot name a lens, or null when it can; it is stored trimmed. The routes and the editor both ask. */
export function nameError(raw: string): string | null {
  const name = raw.trim();
  if (name === '') return 'Give the lens a name.';
  if (name.length > NAME_MAX) return `A name is at most ${NAME_MAX} characters.`;
  // A NUL would reach Postgres and 500; a newline or tab would break a tab, a chip and a CSV header.
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'A name cannot hold control characters.';
  return null;
}

// ---- saying ------------------------------------------------------------------

/** The rule folded into one sentence, for a tab's header and a list's chip. */
export function ruleLine(rule: LensRule): string {
  const on = EDGE_TYPES.filter((e) => rule.edges[e.kind].use);
  const nft = on.some((e) => !e.money);
  const money = on.some((e) => e.money);
  const parts = [nft && money ? 'NFT and money' : money ? 'Money only' : 'NFT only'];
  parts.push(on.every((e) => rule.edges[e.kind].direction === 'along') ? 'follows arrows' : 'either way where allowed');
  if (nft) parts.push(rule.edges['nft-collection'].use ? 'any token of this collection' : 'same token');
  const { min, max } = rule.hops;
  parts.push(max === null ? 'any length' : `${min}–${max} wallets between`);
  if (rule.window) parts.push(`within ${rule.window.days} days ${rule.window.side === 'either' ? 'either side' : rule.window.side}`);
  parts.push(on.every((e) => rule.edges[e.kind].repeats === 'each') ? 'repeats count each' : 'repeats once');
  return parts.join(', ');
}

// ---- the built-ins' closest copies --------------------------------------------

const off = row(false, 'along', null, null, 'each');
const offEdges = (): Record<EdgeKind, EdgeRule> =>
  Object.fromEntries(KINDS.map((k) => [k, { ...off }])) as Record<EdgeKind, EdgeRule>;

function copy(edges: Partial<Record<EdgeKind, EdgeRule>>, rest: Omit<LensRule, 'edges' | 'closes' | 'order'>): LensRule {
  return { edges: { ...offEdges(), ...edges }, closes: 'seller', order: 'any', ...rest };
}

const moneyAlong = row(true, 'along', null, null, 'once');
const moneyEither = row(true, 'either', null, null, 'once');

/** What the editor fills in for "copy this built-in", and how far the copy is from it. */
export const COPIES: Record<Method, { rule: LensRule; differs: string | null }> = {
  A: {
    rule: copy({ 'nft-token': row(true, 'along', null, null, 'each') }, {
      hops: { min: 0, max: null }, window: null, never: { marketplaces: false, over: null, addresses: [] }, judges: 'owners', minCycles: 2,
    }),
    differs: null,
  },
  AU: {
    rule: copy({ 'nft-token': row(true, 'along', null, null, 'each'), eth: moneyAlong, internal: moneyAlong, weth: moneyAlong }, {
      hops: { min: 0, max: 6 }, window: null, never: { marketplaces: true, over: 20, addresses: [] }, judges: 'owners', minCycles: 1,
    }),
    differs: 'Money loops back also needs two laps when no money is involved, and follows money through up to 30 wallets; this copy is as close as the editor can say.',
  },
  AC: {
    rule: copy({ eth: moneyEither, internal: moneyEither, weth: moneyEither }, {
      hops: { min: 0, max: 1 }, window: null, never: { marketplaces: true, over: 20, addresses: [] }, judges: 'owners', minCycles: 1,
    }),
    differs: 'Linked wallets also counts every round trip; this copy finds only the money link.',
  },
};
