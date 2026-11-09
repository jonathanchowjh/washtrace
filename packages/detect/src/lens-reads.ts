/**
 * What a collection has read for a rule: whether its money, other tokens and
 * follow estimate cover what the rule needs. Apart from lens-rule.ts so that
 * file keeps the rule's shape alone; the editor and every share's "at least"
 * read these, so it imports only types and lens-rule, and the client can take it.
 */

import { WALKED, depthNeeded, type LensRule } from './lens-rule.js';

// ---- money ------------------------------------------------------------------

/**
 * How many of a collection's wallets are still to be read at a depth no
 * deeper than `depth` (MoneyRead.pendingByDepth). The editor's money row and
 * moneyReason both ask it, so they cannot disagree on what is pending.
 */
export function pendingUpTo(pendingByDepth: Readonly<Record<number, number>>, depth: number): number {
  return Object.entries(pendingByDepth).reduce((sum, [d, n]) => sum + (Number(d) <= depth ? n : 0), 0);
}

/**
 * Why a collection's money is not yet read as far as `rule` needs, or
 * null when it is. 'seeding': the walk that finds the
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
 * running on the traders themselves is not read here: shareCauses' "money is
 * not fully read yet" says it.
 */
export function moneyReason(rule: LensRule, money: MoneyDepths, globalHops: number, behind: boolean): MoneyReason | null {
  const needed = depthNeeded(rule);
  if (money.seeding && needed > globalHops) return 'seeding';
  if (pendingUpTo(money.pendingByDepth, needed) > 0) return 'pending';
  if (needed > money.limit) return 'limit';
  return behind && needed > globalHops ? 'behind' : null;
}

/** Why a lens's money is not read as far as it needs; the order is moneyReason's. */
export type MoneyReason = 'seeding' | 'pending' | 'limit' | 'behind';

/** The part of MoneyRead that says how far out its money is read, which moneyReason and readThrough read. */
type MoneyDepths = { limit: number; pendingByDepth: Readonly<Record<number, number>>; seeding: boolean };

/**
 * How many hops out a collection's money is read through, for "Wallets up to
 * L hops out": never a depth not read yet. While the walk past
 * `globalHops` is finding wallets, only the global limit is; while wallets
 * are pending, one short of the shallowest of them (all are past the global
 * limit: MoneyRead.pendingByDepth); else its limit.
 */
export function readThrough(money: MoneyDepths, globalHops: number): number {
  if (money.seeding) return globalHops;
  const pending = Object.keys(money.pendingByDepth).map(Number);
  return pending.length > 0 ? Math.min(...pending) - 1 : money.limit;
}

/** The part of TokenCounts that tokensReason reads (Store.countTokens writes the rest). */
type TokenProgress = { wallets: number; read: number; settled: boolean; payees: boolean };

export type TokensReason = 'off' | 'seeding' | 'pending' | 'behind' | 'unreached';

/**
 * Why a collection's other tokens are not read as far as `rule` needs,
 * or null when they are, or when the rule does not use them. One decision for
 * the editor's Other tokens row and for every share's "at least", as
 * moneyReason is for the money row. Checked in this order: 'off' (Start
 * reading was never pressed: `started`); 'seeding' (no count yet, or the walk
 * that finds the set's wallets is not settled, so more may join); 'pending'
 * (fewer wallets read than the set holds; a failed read is not read);
 * 'behind' (all read, but the lens's run took in another count:
 * `runTokensRead`); 'unreached' (all read, yet the rule allows more middle
 * wallets than the read reaches: any length, or one or more).
 *
 * The setting is the count's own `counts.payees`, the tokens.payees it was
 * made under: a count is all 'unreached' is ever judged against, so the
 * setting the worker runs with now is not read here. With payees in, the
 * floor rises to two middles only when every one-middle loop has its middle
 * read: other tokens followed 'along' (under 'either', a middle
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
