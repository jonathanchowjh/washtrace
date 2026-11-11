/**
 * Why a token or wallet is in a lens's list, in words: the loops and linked
 * pairs its caught trades point at, and the wallets in them. One form for
 * every lens, so a reader learns it once. Each part says what it opens, if
 * anything; the list turns those parts into links.
 */

import type { Flow, Method, MiddleRow, PairShape, RingLine, TokenLine, Transfer, WalletLine, Witness } from '@washtrace/detect';
import type { LensKey } from '@washtrace/detect/trades';
import { LENSES, SHOWN, TOKEN_NOT_CAUGHT, andList, notRunAll, plural, num, short, tokenLabel } from './format';

export type WhyPart = { text: string; opens?: 'loops' | 'wallets' };

/** "1 loop and 2 linked pairs", the zero kinds left out; empty when there are neither. */
function counts(loops: number, pairs: number): string {
  return [loops > 0 ? plural(loops, 'loop') : null, pairs > 0 ? plural(pairs, 'linked pair') : null].filter((s) => s !== null).join(' and ');
}

/**
 * A row's loop counts. A built-in's analysis fills them in and a lens of
 * yours's run fills them from its flags (laps = loops, pairs = 0), so one
 * form reads both. A count that is missing (null) silences only its own part,
 * never the line, and a zero count is left out, so nothing reads "0 loops".
 */
type Counts<K extends string> = Record<K, number>;

/**
 * A linked pair's shape in a list: who paid whom, the middle left unnamed. In
 * PAIR_SHAPES' order, which is the order a row's tails come in.
 */
const SHAPE_TAIL: Record<PairShape, string> = {
  funder: 'both funded by a third',
  payee: 'both paid a third',
  back: 'paid back through a third',
  forward: 'paid through a third',
  'direct-back': 'paid back directly',
  'direct-forward': 'paid directly',
  both: 'paid each other directly',
};
/** The shapes that have a middle wallet: a pair stored without a shape and with one is counted among these. */
const MIDDLE_SHAPES: readonly PairShape[] = ['funder', 'payee', 'back', 'forward'];

/** "both funded by a third": a row of one pair says it bare, else each shape counts its own. A shape `shapes` leaves out counts none. */
function shapeTails(l: { pairs: number; middles: number; shapes: Partial<Record<PairShape, number>> | null }): string[] {
  const shapes = l.shapes;
  if (shapes === null) return l.middles > 0 ? [`${num(l.middles)} through a middle wallet`] : [];
  const named = (Object.keys(SHAPE_TAIL) as PairShape[]).flatMap((x) => {
    const k = shapes[x] ?? 0;
    return k === 0 ? [] : [l.pairs === 1 ? SHAPE_TAIL[x] : `${num(k)} ${SHAPE_TAIL[x]}`];
  });
  // A pair stored before shapes were recorded has none, and says what it always did.
  const unnamed = l.middles - MIDDLE_SHAPES.reduce((n, x) => n + (shapes[x] ?? 0), 0);
  return unnamed > 0 ? [...named, `${num(unnamed)} through a middle wallet`] : named;
}

/** "3 loops among 4 wallets, 5 cycles, 2 closed by money, 1 both funded by a third". */
export function tokenWhy(_method: LensKey, line: TokenLine): WhyPart[] {
  const l = line as TokenLine & Counts<'loops' | 'pairs' | 'wallets' | 'laps' | 'closedByMoney' | 'middles'>;
  const what = counts(l.loops, l.pairs);
  if (what === '') return [];
  const parts: WhyPart[] = [{ text: what, opens: 'loops' }];
  if (l.wallets > 0) parts.push({ text: ' among ' }, { text: plural(l.wallets, 'wallet'), opens: 'wallets' });
  // Cycles only when some loop has more than one: one cycle a loop says nothing the loops did not.
  const tails = [
    l.laps > l.loops ? plural(l.laps, 'cycle') : null,
    l.closedByMoney > 0 ? `${num(l.closedByMoney)} closed by money` : null,
    ...shapeTails(l),
  ].filter((s) => s !== null);
  if (tails.length > 0) parts.push({ text: tails.map((t) => `, ${t}`).join('') });
  return parts;
}

/** What a ring's witnesses are, counted: loops, pairs, those through a middle, and each pair's shape. */
export type RingPattern = RingLine['pattern'];

/**
 * One piece of a ring's evidence, as its story reads it: a loop of Round
 * trips, of `token` round `wallets` wallets; or a linked pair of Linked
 * wallets, one flagged sale of `token` in block `sale`, with its pair's shape
 * (none for a witness saved before shapes were), its middle wallet, and the
 * blocks of the evidence payments of its pair that the page read (`paid`).
 */
export type RingEvidence =
  | { kind: 'loop'; token: string; wallets: number; cycles: number }
  | { kind: 'pair'; token: string; shape?: PairShape | null; middle: string | null; sale: number; paid: readonly number[] };

/**
 * When a pair's payments were, against its sale: before or after only when
 * every one is in a block strictly before or after the sale's. The engine
 * reads who paid whom, not when, and a payment has no place in its block, so
 * one in the sale's own block, or none read, says nothing of order.
 */
function timing(sale: number, paid: readonly number[]): 'before' | 'after' | null {
  if (paid.length === 0) return null;
  if (paid.every((b) => b < sale)) return 'before';
  return paid.every((b) => b > sale) ? 'after' : null;
}

/** "#114, #115 and #117", each token once; past three the rest counted: "#1, #2, #3 and 2 more". */
function tokenList(tokens: readonly string[]): string {
  const named = [...new Set(tokens)].map((t) => `#${tokenLabel(t)}`);
  return named.length <= 3 ? andList(named) : `${named.slice(0, 3).join(', ')} and ${num(named.length - 3)} more`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * What a pair's (or pairs') shape says happened: `of` names the sale after
 * its seller or buyer (" of #114"), `who` the middle ("one wallet"), `many`
 * the sellers and buyers of several sales, and `when` the timing tail. A
 * direct payment is said to be outside the sale when no time word says so:
 * the engine never counts a sale's own payment, so it is not the price.
 */
function shapeClause(shape: PairShape | null, middle: boolean, o: { of: string; who: string; many: boolean; when: 'before' | 'after' | null }): string {
  const [seller, buyer] = o.many ? ['sellers', 'buyers'] : ['seller', 'buyer'];
  const whose = o.many ? "buyers'" : "buyer's", sellers = o.many ? "sellers'" : "seller's";
  const q = o.when === null ? '' : o.many ? `, each ${o.when} its sale` : `, ${o.when} the sale`;
  const outside = o.when === null ? ', outside the sale' : q;
  if (shape === 'funder') return `${o.who} paid both the ${seller} and the ${buyer}${o.of}${q}`;
  if (shape === 'payee') return `the ${seller} and the ${buyer}${o.of} ${o.many ? 'all' : 'both'} paid ${o.who}${q}`;
  if (shape === 'back') return `the ${whose} money went back to the ${seller}${o.of} through ${o.who}${q}`;
  if (shape === 'forward') return `the ${sellers} money went to the ${buyer}${o.of} through ${o.who}${q}`;
  // "back" only when it is after: before the sale it is no paying back.
  if (shape === 'direct-back') return o.when === 'after' ? `the ${buyer}${o.of} paid the ${seller} back directly, after the sale` : `the ${buyer}${o.of} also paid the ${seller} directly${outside}`;
  if (shape === 'direct-forward') return `the ${seller}${o.of} also paid the ${buyer} directly${outside}`;
  if (shape === 'both') return `the ${seller} and the ${buyer}${o.of} paid each other directly${outside}`;
  // A pair stored before shapes were recorded says what it always did, with no time word.
  return `the ${seller} and the ${buyer}${o.of} are joined by money${middle ? ` through ${o.who}` : ''}`;
}

type Pair = Extract<RingEvidence, { kind: 'pair' }>;

/** A pair's shape for telling pairs apart: one stored without a shape is either through a middle or direct, and the two are never told as one. */
const shapeOf = (p: Pair): PairShape | 'middle' | 'direct' => p.shape ?? (p.middle === null ? 'direct' : 'middle');

/**
 * One shape's pairs: the one wallet when every pair has the same middle, else
 * each sale in turn. `named` says the tokens ("of #114"); a token's own row
 * has named it already.
 */
function pairsOfOneShape(pairs: readonly Pair[], named = true): string {
  const p = pairs[0]!, shape = p.shape ?? null;
  const times = pairs.map((x) => timing(x.sale, x.paid));
  const when = times.every((t) => t === times[0]) ? times[0]! : null;
  const of = (tokens: readonly string[]) => (named ? ` of ${tokenList(tokens)}` : '');
  if (pairs.length === 1) return `${cap(shapeClause(shape, p.middle !== null, { of: of([p.token]), who: 'one wallet', many: false, when }))}.`;
  // "One wallet" only when it is one: the engine names one middle a pair, and several pairs may name several.
  const same = p.middle !== null && pairs.every((x) => x.middle === p.middle);
  if (same && named) return `${cap(shapeClause(shape, true, { of: of(pairs.map((x) => x.token)), who: 'one wallet', many: true, when }))}.`;
  return `In each of ${num(pairs.length)} sales${of(pairs.map((x) => x.token))}, ${shapeClause(shape, p.middle !== null, { of: '', who: same ? 'one wallet' : 'a third wallet', many: false, when })}.`;
}

/** A loop of Round trips in a clause: "went round 2 wallets and back to one that sold it, 2 cycles". */
const wentRound = (l: { wallets: number; cycles: number }) => `went round ${plural(l.wallets, 'wallet')} and back to one that sold it${l.cycles > 1 ? `, ${plural(l.cycles, 'cycle')}` : ''}`;

/** Pairs' shapes as the lists count them (shapeTails): bare when they share one, else each counted. */
function pairTails(pairs: readonly Pair[]): string[] {
  if (new Set(pairs.map(shapeOf)).size === 1) {
    const p = pairs[0]!;
    return p.shape ? [SHAPE_TAIL[p.shape]] : p.middle !== null ? ['through a middle wallet'] : [];
  }
  const counts: Partial<Record<PairShape, number>> = {};
  for (const p of pairs) if (p.shape) counts[p.shape] = (counts[p.shape] ?? 0) + 1;
  return shapeTails({ pairs: pairs.length, middles: pairs.filter((p) => p.middle !== null).length, shapes: counts });
}

/**
 * A ring's story in a sentence or two, from its evidence: its loops first,
 * as the lenses are shown (floor, then ceiling), then its linked pairs by
 * shape, naming the tokens and, for one shape, when its payments were
 * (timing). A ring not drawn (`evidence` null), or with no counted evidence
 * drawn, says its `line`'s counts alone, with no time word.
 */
export function ringStory(line: { wallets: number; sales: number; pattern: RingPattern }, evidence: readonly RingEvidence[] | null): string {
  const loops = (evidence ?? []).filter((e) => e.kind === 'loop');
  const pairs = (evidence ?? []).filter((e): e is Pair => e.kind === 'pair');
  if (loops.length === 0 && pairs.length === 0) {
    if (line.sales === 0) return 'None of its flagged trades is a counted sale.';
    // The stored counts, as a token's row says them: a pair can sit on a loop's sale, so none is taken from what the loops leave.
    const what = counts(line.pattern.loops, line.pattern.pairs);
    return `${what === '' ? 'Among' : `${what} among`} ${plural(line.wallets, 'wallet')}${shapeTails(line.pattern).map((t) => `, ${t}`).join('')}.`;
  }
  const one = loops[0];
  const round = one === undefined ? null
    : loops.length === 1 ? `#${tokenLabel(one.token)} ${wentRound(one)}`
    : `${tokenList(loops.map((l) => l.token))} went round among these wallets`;
  if (round === null) {
    if (new Set(pairs.map(shapeOf)).size === 1) return pairsOfOneShape(pairs);
    const tails = pairTails(pairs);
    return `${num(pairs.length)} of its sales are linked pairs${tails.length === 0 ? '' : `: ${tails.join(', ')}`}.`;
  }
  if (pairs.length === 0) return `${round}.`;
  // A sale a loop flagged can be a linked pair too: the pairs are counted among all its sales, never as more of them.
  const tails = pairTails(pairs);
  return `${round}; ${num(pairs.length)} of its sales ${pairs.length === 1 ? 'is a linked pair' : 'are linked pairs'}${tails.map((t) => `, ${t}`).join('')}.`;
}

/**
 * One token's own story in its ring, from its evidence alone: the sentence
 * ringStory tells, without the token or the other tokens named, since its
 * row names it. Empty for a token with none drawn.
 */
export function tokenStory(evidence: readonly RingEvidence[]): string {
  const loops = evidence.filter((e) => e.kind === 'loop');
  const pairs = evidence.filter((e): e is Pair => e.kind === 'pair');
  const round = loops.length === 0 ? null : loops.length === 1 ? `${cap(wentRound(loops[0]!))}.` : `Went round in ${num(loops.length)} loops.`;
  const tails = pairTails(pairs);
  const linked = pairs.length === 0 ? null : new Set(pairs.map(shapeOf)).size === 1 ? pairsOfOneShape(pairs, false)
    : `${num(pairs.length)} sales are linked pairs${tails.length === 0 ? '' : `: ${tails.join(', ')}`}.`;
  return [round, linked].filter((s) => s !== null).join(' ');
}

/**
 * A ring's pattern in a few words, for the rings list: one shape bare ("Both
 * funded by a third"), loops alone by their wallets, a ring saved before
 * shapes as the lists say it, and any mix by its counts. Empty for none.
 */
export function ringPattern(p: RingPattern, wallets: number): string {
  if (p.pairs === 0) return p.loops === 0 ? '' : `${LENSES.A.name} among ${plural(wallets, 'wallet')}`;
  if (p.loops === 0) {
    const shape = (Object.keys(SHAPE_TAIL) as PairShape[]).find((x) => p.shapes[x] === p.pairs);
    if (shape !== undefined) return cap(SHAPE_TAIL[shape]);
    // Saved before shapes: all through a middle, or none.
    if (Object.values(p.shapes).every((n) => n === 0)) {
      if (p.middles === p.pairs) return 'Through a middle wallet';
      if (p.middles === 0) return 'Joined by money';
    }
  }
  return cap(counts(p.loops, p.pairs));
}

/** "in 41 loops and 2 linked pairs with 6 other wallets". */
export function walletWhy(_method: LensKey, line: WalletLine): WhyPart[] {
  const l = line as WalletLine & Counts<'loops' | 'pairs' | 'partners'>;
  const what = counts(l.loops, l.pairs);
  if (what === '') return [];
  const parts: WhyPart[] = [{ text: 'in ' }, { text: what, opens: 'loops' }];
  if (l.partners > 0) parts.push({ text: ' with ' }, { text: plural(l.partners, 'other wallet'), opens: 'wallets' });
  return parts;
}

/** One wallet on a Connected-to rail, with what it did here. */
export type RailWallet = { address: string; role: string };
/** One transaction on the rail: a sale of a token, or a payment. */
export type RailTx = { hash: string; block: number; what: string };

const ZERO = '0x' + '0'.repeat(40);
/** A transfer as read, with the witnesses of the lenses that flagged it when it has them. */
type Moved = Transfer & { flags?: Partial<Record<Method, Witness>> };

/**
 * The one role a linked pair's middle has, from its pair's shape: the wallet
 * that paid both is their funder, the one both paid their payee, and one the
 * money passed through, or a pair stored without a shape, is in between.
 */
function middleRole(shape: PairShape | undefined): string {
  return shape === 'funder' ? 'funder' : shape === 'payee' ? 'payee' : 'in between';
}

/**
 * Each wallet with its role here, in the order they first appear: the seller
 * and buyer of a sale (a transfer that was no sale: sent it, got it), then the
 * middles of linked pairs, each by its pair's shape (those in `middles` with no
 * pair of their own are in between). Only what a lens used is a member: a
 * wallet that merely moved money with the holders is not. `self`, the page's
 * own wallet, is left out.
 */
export function walletRoles(transfers: readonly Moved[], middles: readonly string[], self?: string): RailWallet[] {
  const roles = new Map<string, string[]>();
  const add = (a: string, role: string) => {
    if (a === ZERO || a === self) return;
    const r = roles.get(a) ?? [];
    if (!r.includes(role)) r.push(role);
    roles.set(a, r);
  };
  for (const t of transfers) {
    add(t.from, t.marketplace ? 'seller' : 'sent it');
    add(t.to, t.marketplace ? 'buyer' : 'got it');
  }
  const between = new Set<string>();
  for (const t of transfers) {
    const w = t.flags?.AC;
    if (w?.kind !== 'pair' || w.middle === null) continue;
    between.add(w.middle);
    add(w.middle, middleRole(w.shape));
  }
  for (const m of middles) if (!between.has(m)) add(m, 'in between');
  return [...roles].map(([address, r]) => ({ address, role: r.join(' · ') }));
}

/**
 * A wallet's page: those it traded with, then its money partners not among
 * them: a funder paid it, a payee was paid by it. `middles` are the middles of
 * every pair it is the seller or buyer of, whatever page or filter shows its
 * transfers; each has the role its pair's shape gives it, as on the other
 * pages, and money's direction names only a partner that is no such middle.
 */
export function partnersOf(
  transfers: readonly Moved[], partners: readonly { address: string; sent: number; received: number }[], self: string,
  middles: readonly { middle: string; shape: PairShape | null }[] = [],
): RailWallet[] {
  const roleOf = new Map<string, string[]>();
  for (const m of middles) {
    const r = roleOf.get(m.middle) ?? [];
    const role = middleRole(m.shape ?? undefined);
    if (!r.includes(role)) r.push(role);
    roleOf.set(m.middle, r);
  }
  const traded = walletRoles(transfers, [], self).map((w) => {
    const more = (roleOf.get(w.address) ?? []).filter((r) => !w.role.split(' · ').includes(r));
    return { address: w.address, role: [w.role, ...more].join(' · ') };
  });
  const seen = new Set(traded.map((w) => w.address));
  const money = partners.filter((p) => !seen.has(p.address) && p.address !== self).map((p) => {
    const r = roleOf.get(p.address);
    return { address: p.address, role: r !== undefined ? r.join(' · ') : p.sent > 0 && p.received > 0 ? 'funder · payee' : p.received > 0 ? 'funder' : 'payee' };
  });
  // A middle it has no money with or trade of here is still in its pair: listed as the token page lists it.
  const listed = new Set([...seen, ...money.map((w) => w.address)]);
  const rest = [...roleOf].filter(([a]) => !listed.has(a) && a !== self).map(([address, r]) => ({ address, role: r.join(' · ') }));
  return [...traded, ...money, ...rest];
}

/** The sales and payments that tie them, by block: one line a transaction, its sales named first. */
export function railTxs(transfers: readonly Transfer[], flows: readonly Flow[]): RailTx[] {
  const out = new Map<string, RailTx>();
  for (const t of transfers) {
    if (!out.has(t.txHash)) out.set(t.txHash, { hash: t.txHash, block: t.blockNumber, what: `${t.marketplace ? 'Sale' : 'Transfer'} of #${tokenLabel(t.tokenId)}` });
  }
  for (const f of flows) if (!out.has(f.txHash)) out.set(f.txHash, { hash: f.txHash, block: f.blockNumber, what: 'Payment' });
  return [...out.values()].sort((a, b) => a.block - b.block || a.hash.localeCompare(b.hash));
}

/**
 * A never-traded wallet's lead, up to the tokens it names: what it did as the
 * middle of the linked pairs `rows` are, by their shape. Pairs of one shape
 * say it; mixed shapes, or pairs stored without one, say it is in between.
 */
export function middleWords(rows: readonly Pick<MiddleRow, 'shape'>[]): string {
  const many = rows.length > 1;
  const shape = rows.every((r) => r.shape === rows[0]?.shape) ? rows[0]?.shape ?? null : null;
  const sides = many ? 'sellers and buyers' : 'seller and buyer';
  if (shape === 'funder') return `Funded the ${sides} of`;
  if (shape === 'payee') return `Was paid by the ${sides} of`;
  if (shape === 'back') return many ? "Passed the buyers' money back to the sellers of" : "Passed the buyer's money back to the seller of";
  if (shape === 'forward') return many ? "Passed the sellers' money to the buyers of" : "Passed the seller's money to the buyer of";
  return `Is in between the ${sides} of`;
}

/**
 * Why a token that no lens flagged was not: a line per lens that ran, floor
 * then ceiling then not counted, and one for each lens that did not, so a lens
 * that never ran is never said to have found nothing. `near` is what the
 * engine counted (tokenCycles): the most cycles one loop of the token closes
 * against the `minCycles` Round trips needs, and the escrows it touches.
 */
export function notFlaggedLines(near: { cycles: number; wallets: readonly string[]; minCycles: number; custody: readonly { address: string; name: string }[] }, notRun: readonly Method[]): string[] {
  const ran = SHOWN.filter((m) => !notRun.includes(m));
  const lines: string[] = [];
  if (ran.includes('A')) {
    if (near.cycles === 0) lines.push(`${LENSES.A.name}: the token never comes back to a wallet that held it.`);
    else if (near.cycles < near.minCycles) lines.push(`${LENSES.A.name}: it came back to ${short(near.wallets[0]!)} ${near.cycles === 1 ? 'once' : `${near.cycles} times`}; a pattern needs ${near.minCycles} cycles.`);
  }
  for (const c of near.custody) lines.push(`Its moves to ${short(c.address)} are loans held in custody (${c.name}), not sales: no lens judges them.`);
  for (const m of ran) if (m !== 'A') lines.push(`${LENSES[m].name}: ${TOKEN_NOT_CAUGHT[m]}`);
  if (notRun.length > 0) lines.push(notRunAll(notRun));
  return lines;
}
