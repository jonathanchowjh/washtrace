/**
 * Why a token or wallet is in a lens's list, in words: the loops and linked
 * pairs its caught trades point at, and the wallets in them. One form for
 * every lens, so a reader learns it once. Each part says what it opens, if
 * anything; the list turns those parts into links.
 */

import type { Flow, Method, MiddleRow, PairShape, TokenLine, Transfer, WalletLine, Witness } from '@washtrace/detect';
import type { LensKey } from '@washtrace/detect/trades';
import { LENSES, SHOWN, TOKEN_NOT_CAUGHT, notRunAll, plural, num, short, tokenLabel } from './format';

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

/** "both funded by a third": a row of one pair says it bare, else each shape counts its own. */
function shapeTails(l: TokenLine & Counts<'pairs' | 'middles'>): string[] {
  const shapes = l.shapes;
  if (shapes === null) return l.middles > 0 ? [`${num(l.middles)} through a middle wallet`] : [];
  const named = (Object.keys(SHAPE_TAIL) as PairShape[]).filter((x) => shapes[x] > 0)
    .map((x) => l.pairs === 1 ? SHAPE_TAIL[x] : `${num(shapes[x])} ${SHAPE_TAIL[x]}`);
  // A pair stored before shapes were recorded has none, and says what it always did.
  const unnamed = l.middles - MIDDLE_SHAPES.reduce((n, x) => n + shapes[x], 0);
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
 * pair of their own are in between), then any that only moved money between
 * the holders, a funder paying one and a payee paid by one. `self`, the page's
 * own wallet, is left out.
 */
export function walletRoles(transfers: readonly Moved[], flows: readonly Flow[], middles: readonly string[], self?: string): RailWallet[] {
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
  const held = new Set(transfers.flatMap((t) => [t.from, t.to]));
  const between = new Set<string>();
  for (const t of transfers) {
    const w = t.flags?.AC;
    if (w?.kind !== 'pair' || w.middle === null) continue;
    between.add(w.middle);
    add(w.middle, middleRole(w.shape));
  }
  for (const m of middles) if (!between.has(m)) add(m, 'in between');
  for (const m of middles) between.add(m);
  // A middle has its one role from its pair; the money that made it the funder or payee is not said twice.
  for (const f of flows) {
    if (held.has(f.to) && !held.has(f.from) && !between.has(f.from)) add(f.from, 'funder');
    if (held.has(f.from) && !held.has(f.to) && !between.has(f.to)) add(f.to, 'payee');
  }
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
  const traded = walletRoles(transfers, [], [], self).map((w) => {
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
