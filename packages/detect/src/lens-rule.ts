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
const WEI_FLOOR = '10000000000000000'; // 0.01 ETH
const MAX_HOPS = 6;
// The routes take rules from anyone who may write, so every number and list is bounded.
const MAX_DAYS = 3650;
const MAX_PER_LOOP = 100;
const MAX_OVER = 1_000_000_000;
const MAX_WEI_DIGITS = 78;
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
  // Ruling BB: 20, the built-ins' hubDegree. `over` counts the collection's wallets a wallet is linked to by money.
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
    if (isObject(e) && typeof e.minWei === 'string' && e.minWei.length > MAX_WEI_DIGITS) return { error: `"${label}": the smallest payment has at most ${MAX_WEI_DIGITS} digits in wei.` };
    if (!isObject(e) || typeof e.use !== 'boolean' || !oneOf(e.direction, ['along', 'either']) || !oneOf(e.repeats, ['each', 'once'])
      || !(e.max === null || isCount(e.max)) || !(e.minWei === null || (typeof e.minWei === 'string' && /^\d+$/.test(e.minWei)))) {
      return { error: `"${label}" is not a valid edge rule.` };
    }
    edges[kind] = row(e.use, e.direction, e.max, e.minWei, e.repeats);
  }
  for (const { kind, unavailable } of EDGE_TYPES) if (unavailable && edges[kind].use) return { error: unavailable };
  // T9: a floor in raw units means one thing at 6 decimals and another at 18, and washtrace has no prices.
  // Only with the row on (Ruling P12): off, the value is read by nothing, and a rule saved so must not read as corrupt.
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
 * `Store.fund` stores every flow of a checked wallet and queues only the
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
 * Only the ETH and WETH rows count (T12): other tokens are read by a read of
 * their own, whose coverage the tokens row decides, so a lens using them
 * alone needs no money read.
 */
export function depthNeeded(rule: LensRule): number {
  const money = WALKED.some((k) => rule.edges[k].use);
  return money && rule.hops.max !== null ? Math.max(0, rule.hops.max - 1) : 0;
}

/**
 * How many of a collection's wallets are still to be read at a depth no
 * deeper than `depth` (MoneyRead.pendingByDepth). The editor's money row and
 * moneyShort both ask it, so they cannot disagree on what is pending.
 */
export function pendingUpTo(pendingByDepth: Readonly<Record<number, number>>, depth: number): number {
  return Object.entries(pendingByDepth).reduce((sum, [d, n]) => sum + (Number(d) <= depth ? n : 0), 0);
}

/**
 * Why a collection's money is not yet read as far as `rule` needs (Rulings
 * S25, S31, S36), or null when it is. 'seeding': the walk that finds the
 * wallets past `globalHops` is still running and the rule reaches past them
 * (seeding finds only those, so a lens within the global limit is not held
 * back). 'pending': wallets at a depth the rule needs, or nearer, are still to
 * read. 'limit': the rule needs more hops than the collection is followed to.
 * 'behind': all of it is read, but the lens's run is behind the collection's
 * version (`behind`), so its share is from before the wallets past
 * `globalHops` were; only those are this collection's own, so a lens within
 * the global limit is not held back. The order is the one the editor's row
 * reports them in. `money` is the part of MoneyRead this reads. A rule with
 * no money edge needs depth 0, so it is never short. The money check still
 * running on the traders themselves is not read here: floorCauses' "money is
 * not fully read yet" says it.
 */
export function moneyReason(rule: LensRule, money: MoneyDepths, globalHops: number, behind: boolean): 'seeding' | 'pending' | 'limit' | 'behind' | null {
  const needed = depthNeeded(rule);
  if (money.seeding && needed > globalHops) return 'seeding';
  if (pendingUpTo(money.pendingByDepth, needed) > 0) return 'pending';
  if (needed > money.limit) return 'limit';
  return behind && needed > globalHops ? 'behind' : null;
}

/** The part of MoneyRead that says how far out its money is read, which moneyReason and readThrough read. */
export type MoneyDepths = { limit: number; pendingByDepth: Readonly<Record<number, number>>; seeding: boolean };

/**
 * How many hops out a collection's money is read through, for "Wallets up to
 * L hops out" (Ruling S37): never a depth not read yet. While the walk past
 * `globalHops` is finding wallets, only the global limit is; while wallets
 * are pending, one short of the shallowest of them (all are past the global
 * limit: MoneyRead.pendingByDepth); else its limit.
 */
export function readThrough(money: MoneyDepths, globalHops: number): number {
  if (money.seeding) return globalHops;
  const pending = Object.keys(money.pendingByDepth).map(Number);
  return pending.length > 0 ? Math.min(...pending) - 1 : money.limit;
}

/** Whether a share is a floor for want of money read: any reason of moneyReason. */
export function moneyShort(rule: LensRule, money: MoneyDepths, globalHops: number, behind: boolean): boolean {
  return moneyReason(rule, money, globalHops, behind) !== null;
}

/** The part of TokenCounts that tokensReason reads (Store.countTokens writes the rest). */
type TokenProgress = { wallets: number; read: number; settled: boolean; payees: boolean };

export type TokensReason = 'off' | 'seeding' | 'pending' | 'behind' | 'unreached';

/**
 * Why a collection's other tokens are not read as far as `rule` needs (T11),
 * or null when they are, or when the rule does not use them. One decision for
 * the editor's Other tokens row and for every share's "at least", as
 * moneyReason is for the money row. Checked in this order: 'off' (Start
 * reading was never pressed: `started`); 'seeding' (no count yet, or the walk
 * that finds the set's wallets is not settled, so more may join); 'pending'
 * (fewer wallets read than the set holds; a failed read is not read);
 * 'behind' (all read, but the lens's run took in another count:
 * `runTokensRead`); 'unreached' (all read, yet the rule allows more middle
 * wallets than the read reaches, T7: any length, or one or more).
 *
 * The setting is the count's own `counts.payees`, the tokens.payees it was
 * made under: a count is all 'unreached' is ever judged against, so the
 * setting the worker runs with now is not read here. With payees in, the
 * floor rises to two middles only when every one-middle loop has its middle
 * read (Ruling P13): other tokens followed 'along' (under 'either', a middle
 * that paid both traders is a payer, in no set), no ETH or WETH row on (a
 * buyer -ETH-> M -token-> seller loop's M may be out of reach), and
 * marketplaces and known contracts never middles (they are left out of
 * token_payees). Otherwise one middle is already more than is read.
 */
export function tokensReason(rule: LensRule, started: boolean, counts: TokenProgress | null, runTokensRead: number | null): TokensReason | null {
  const tokens = rule.edges['other-tokens'];
  if (!tokens.use) return null;
  if (!started) return 'off';
  if (counts === null || !counts.settled) return 'seeding';
  if (counts.read < counts.wallets) return 'pending';
  if (counts.read !== runTokensRead) return 'behind';
  const payeesClose = counts.payees && tokens.direction === 'along' && !WALKED.some((k) => rule.edges[k].use) && rule.never.marketplaces;
  const max = rule.hops.max;
  return max === null || max >= (payeesClose ? 2 : 1) ? 'unreached' : null;
}

/**
 * How many more wallets following a collection's money one hop past its
 * limit would read, as the worker last counted it (Store.countNext), for
 * the lens editor's Fetch them. `depth` is the hop counted; `wallets` are
 * the ones there still to read. `growth` is how many wallets the chain
 * holds at a depth for each at the one before, null with nothing to go by.
 * `cut`: the walk stopped short of every wallet and scaled what it found,
 * so even `depth` is about. `within`: the walk's wallets out to the limit
 * itself (depths 0 to depth - 1), scaled as it was cut, which Start reading
 * (other tokens) would read; an estimate stored before it was counted has
 * none, and reads as not counted. `at` is when it was counted.
 */
export interface FollowEstimate { depth: number; wallets: number; growth: number | null; cut: boolean; within: number; at: string }

/**
 * About how many wallets following out to `toDepth` would read, from what
 * was counted: the counted depth, then each level past it the one before
 * times `growth` (none past it when there is no growth to go by), since the
 * deeper ones would need the very reads being priced. `exactTo` is the
 * deepest depth counted exactly, one short of `depth` when the walk was cut.
 * Null with nothing counted, or asked for less than was counted.
 */
export function estimateTo(estimate: FollowEstimate | null, toDepth: number): { wallets: number; exactTo: number } | null {
  if (estimate === null || toDepth < estimate.depth) return null;
  let wallets = estimate.wallets;
  if (estimate.growth !== null) {
    for (let d = estimate.depth + 1, level = estimate.wallets; d <= toDepth; d++) wallets += (level *= estimate.growth);
  }
  return { wallets: Math.round(wallets), exactTo: estimate.cut ? estimate.depth - 1 : estimate.depth };
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
