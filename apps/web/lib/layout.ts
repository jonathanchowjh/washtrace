import { CUSTODIANS, METHODS, TOKENS, WRAPPED, ZERO, type FlaggedTransfer, type Flow, type LoopEdge, type Method, type OwnFlag, type Witness, useOf } from '@washtrace/detect';
import { venueName, type LensKey } from '@washtrace/detect/trades';
import { LABELLED_MAX, LABEL_SEP, LENSES, SHOWN, andList, tokenLabel, weiToEth, type Lenses } from './format';
import { toneOf, type Tone } from './metrics';

/** Two witnesses that would read as the same sentence share a key. */
function witnessKey(w: Witness): string {
  if (w.kind === 'pair') return `pair|${w.pair.join(',')}|${w.middle}|${w.flowTx}`;
  const base = `${[...w.wallets].sort().join(',')}|${w.cycles}`;
  return w.kind === 'scc' ? `scc|${base}` : `flow|${base}|${w.via.length}`;
}

interface Reason { witness: Witness; methods: Method[]; rows: number[] }

/**
 * A token's flags grouped by reason, so a pattern that four transfers share
 * is said once with the four rows it covers, and the lenses that agree on it
 * are named together. Rows are 1-based, as the graph labels them. They are
 * ordered as the lenses are shown (floor, ceiling, not counted), by each
 * reason's first lens; layout() and the pages all read this one order.
 */
export function reasons(transfers: readonly FlaggedTransfer[]): Reason[] {
  const by = new Map<string, Reason>();
  transfers.forEach((t, i) => {
    for (const m of METHODS) {
      const w = t.flags[m];
      if (!w) continue;
      const key = witnessKey(w);
      const r = by.get(key) ?? { witness: w, methods: [], rows: [] };
      if (!r.methods.includes(m)) r.methods.push(m);
      if (!r.rows.includes(i + 1)) r.rows.push(i + 1);
      by.set(key, r);
    }
  });
  const rank = (r: Reason) => Math.min(...r.methods.map((m) => SHOWN.indexOf(m)));
  return [...by.values()].sort((x, y) => rank(x) - rank(y));
}

/** Unordered: A→B and B→A are one pair, and share one fan. */
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Past this many transfers between one pair, the fan's arcs leave the drawing and stop being countable. */
export const FAN_MAX = 6;

/** Between two neighbouring wallets on the ring, in px: room for a fan of FAN_MAX arcs and their numbers. */
const SPACING = 160;

/** How much further each arc of a fan sits at its middle than the one before it on its side, in px: room for a label between two arcs. */
const FAN_STEP = 44;

/** How far a fan's first arc sits off the line at its middle, toward the fan's side, in px: a bow, so it is told from a straight line. */
const MID_BOW = 8;

/**
 * How far a middle sits off the line between a pair, at least: past a fan of
 * one or two arcs. A pair with more sits its middles past its own fan's
 * furthest arc (fanReach), so a full fan's arcs, out to about 140 px, never run through one.
 */
const FAN_CLEAR = 76;

/** How far round each next self-loop of one wallet points from the last, in radians. */
const SELF_TURN = (55 * Math.PI) / 180;

/** How far the furthest arc of a fan of `n` sits from its line at its middle, either side, in px. */
const fanReach = (n: number) => Math.max(MID_BOW + FAN_STEP * Math.ceil((n - 1) / 2), FAN_STEP * Math.floor((n - 1) / 2) - MID_BOW, 0);

/** Between middles set in a row, in px: a label (NAME_W) and room between labels. */
const ROW_GAP = 90;

/**
 * `lx`, `ly`: where its label goes, outward from the centre, clear of the arrows arriving at it (a ring's middle's: round it, where no arc runs); `anchor`, which end of the label sits there.
 * `first` is the token's first holder; a drawing numbered by time has none, being of a ring's several tokens.
 */
interface DrawnNode { id: string; x: number; y: number; lx: number; ly: number; anchor: 'start' | 'middle' | 'end'; middle: boolean; first: boolean;
  /** The escrow's name (Blur Blend) when this wallet holds tokens in custody, else null. */
  custody: string | null }
/**
 * `tx` is what an arrow opens: an asset arrow's transfer, a payment's own
 * hash (a bundle's first), or null for a step of a lens of yours that is no
 * payment the console stores. `row` is the transfer an asset arrow numbers
 * (a bundle's first), null for money. `from` and `to` are the wallets it
 * joins. Tone `own` is an arrow only a lens of yours drew: `token` is then the
 * other token of the collection it moved, for its label to open. It is also a
 * trade of this token no built-in flagged that a loop of yours lights: `yours`
 * then names those lenses, so the arrow is never drawn or called "not flagged".
 *
 * Its label has two parts, drawn as "2 · 9 ETH" (labelText): `label`, its
 * number by the drawing's Numbering, a bundle's count ("×7") or another
 * token's ("#9"), '' for none; and `amount`, what it paid ("9 ETH", "0.5
 * WETH"), '' for a transfer no one paid for. `lx`, `ly` is the label's centre,
 * set off the line on the outside of its bow so the line never strikes it.
 */
export interface DrawnEdge { key: string; d: string; kind: 'asset' | 'money'; tone: Tone | 'own'; title: string; from: string; to: string; tx: string | null; row: number | null; lx: number; ly: number; label: string; amount: string; token?: string; yours?: string[];
  /** The amount is not drawn: no spot beside its own arc fits the whole label, and its number alone does (layout's clearLabels). Its title then says the amount. */
  amountHidden?: true;
  /** The transfers of the drawing it draws, each as `txHash:logIndex` (a bundle all of its own), so a page can mark the one it is about; none for money or another token. */
  ids: string[] }
/** One reason a token was flagged: the arrows and wallets that make it, for the graph to light together. A lens of yours's loop is one reason, of its one lens. */
export interface DrawnLoop { key: string; methods: LensKey[]; edges: string[]; nodes: string[] }
/**
 * A transfer as layout() takes it. `n` is its place in its token's history, 1
 * the first, a mint included: what its arrow is numbered, so a sale has one
 * number in every graph that draws it and in its token's table. Left out, it
 * is the transfer's place in the list given, which is that history when the
 * list is one token's every transfer, as on a token or trade page.
 */
export type Numbered = FlaggedTransfer & { n?: number };

/**
 * How a drawing numbers its arrows:
 * - 'history', a token page's: each transfer by its place in its token's
 *   history (Numbered), as the table numbers its rows; payments unnumbered,
 *   since no table there lists them.
 * - 'time', a ring's: its flagged transfers and its payments in one sequence
 *   by block (timeOrder, `steps`). A clean trade is drawn unnumbered: it is no
 *   part of what the sequence tells.
 */
export type Numbering = 'history' | 'time';

/**
 * One numbered thing of a drawing numbered by time: `n` its place, `edge` the
 * arrow that draws it, which of the transfers or payments given it is, by
 * index, and `amount`, what it paid as its arrow says it ('' for a transfer no
 * one paid for). A bundle's arrow says its sum; each of its steps its own.
 */
export interface Step { n: number; edge: string; of: 'transfer' | 'payment'; index: number; amount: string }

/**
 * `view`: the part of the `size` square the drawing covers, its labels included, so a small graph is not drawn in a mostly empty square.
 * `steps`, in order of `n`, only when it is numbered by time.
 */
export interface Drawing { size: number; numbering: Numbering; view: { x: number; y: number; w: number; h: number }; nodes: DrawnNode[]; edges: DrawnEdge[]; loops: DrawnLoop[]; steps?: Step[] }

/** What an edge's title says of its flags: nothing for a clean one, and that an apart lens alone does not count. */
const flaggedNote = (tone: Tone) => (tone === 'clean' ? '' : tone === 'apart' ? ` · flagged only by ${LENSES.AU.name}, not counted` : ' · flagged');

/** An amount on a money arrow: ETH to 4 places, never 0 for a payment above it; "?" when the amount was not read. */
function amount(wei: string | null): string {
  if (wei === null) return '?';
  const [whole, frac = ''] = weiToEth(wei).split('.');
  const cut = frac.slice(0, 4).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : frac ? '<0.0001' : whole!;
}

/** The listed tokens by address, every chain's: no two chains share one. The symbol and decimals are ours, never a token's own (TOKENS). */
const LISTED = new Map(Object.values(TOKENS).flat().map((t) => [t.address, t]));

/** Every chain's wrapped ETH, which an arrow reads as WETH, as the tables do: no two chains share an address. */
const WRAPPED_ANY = new Set(Object.values(WRAPPED).flat());

/** What a sale paid, as its arrow says it: in ETH, WETH or a listed token's symbol, "? token" in another; '' for a transfer no one paid for. */
function salePaid(t: FlaggedTransfer): string {
  if (t.priceWei === null || t.currency === null) return '';
  if (t.currency === '') return `${amount(t.priceWei)} ETH`;
  if (WRAPPED_ANY.has(t.currency)) return `${amount(t.priceWei)} WETH`;
  const listed = LISTED.get(t.currency);
  return listed === undefined ? '? token' : `${tokenAmount(t.priceWei, listed.decimals)} ${listed.symbol}`;
}

/** The unit a payment is in, as its table says it: wrapped ETH is WETH, the rest ETH. */
const unitOf = (f: Flow) => (f.kind === 'token' ? 'WETH' : 'ETH');

/** What one payment paid, as its arrow says it: "1 ETH". */
const flowPaid = (f: Flow) => `${amount(f.valueWei)} ${unitOf(f)}`;

/** What some payments came to in all, in their one unit, or naming both when they mix. */
export function paidInAll(fs: readonly Flow[]): string {
  const units = [...new Set(fs.map(unitOf))];
  return `${amount(fs.reduce((sum, f) => sum + BigInt(f.valueWei), 0n).toString())} ${units.length === 1 ? units[0] : 'ETH and WETH'}`;
}

/**
 * Transfers and payments, by their index in the lists given, in one sequence
 * by block. washtrace reads no place for a payment within its block (a flow
 * has no log index), so one rule orders a block: its transfers first, by log
 * index, then its payments by hash, payer and payee. Two numbers within one
 * block are that rule, not a time order: no copy may say "before" of them.
 */
function timeOrder(transfers: readonly FlaggedTransfer[], ti: readonly number[], flows: readonly Flow[], fi: readonly number[]): Pick<Step, 'of' | 'index'>[] {
  const items = [...ti.map((index) => ({ of: 'transfer' as const, index })), ...fi.map((index) => ({ of: 'payment' as const, index }))];
  const block = (s: Pick<Step, 'of' | 'index'>) => (s.of === 'transfer' ? transfers[s.index]!.blockNumber : flows[s.index]!.blockNumber);
  const flowKey = (f: Flow) => `${f.txHash}|${f.from}|${f.to}`;
  return items.sort((x, y) => block(x) - block(y)
    || (x.of !== y.of ? (x.of === 'transfer' ? -1 : 1)
      : x.of === 'transfer' ? transfers[x.index]!.logIndex - transfers[y.index]!.logIndex
      : flowKey(flows[x.index]!).localeCompare(flowKey(flows[y.index]!))));
}

/** A raw token amount scaled by its decimals: to 4 places with thousands marked, never 0 for an amount above it. */
function tokenAmount(raw: string, decimals: number): string {
  const v = BigInt(raw), unit = 10n ** BigInt(decimals);
  const whole = v / unit, rest = v % unit;
  const cut = rest.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  if (cut) return `${whole.toLocaleString('en-US')}.${cut}`;
  return whole === 0n && rest > 0n ? '<0.0001' : whole.toLocaleString('en-US');
}

/**
 * What an other-token edge paid, with its symbol, or null for any other
 * edge: its token is on the edge, since its kind ('funds' too) does
 * not say. A path stored before edges carried a token has none, so it reads
 * as it always did.
 */
function tokenPaid(e: LoopEdge): string | null {
  if (e.token == null) return null;
  const t = LISTED.get(e.token);
  if (t === undefined) return '? of a token no longer listed';
  return `${e.amountWei === null ? '?' : tokenAmount(e.amountWei, t.decimals)} ${t.symbol}`;
}

/** What an arrow only a lens of yours drew says on hover. */
function ownTitle(e: LoopEdge): string {
  if (e.kind === 'nft-collection' || e.kind === 'nft-token') return `${e.tokenId === null ? 'A token' : `#${e.tokenId}`} of this collection changing hands, on a loop of a lens of yours`;
  const paid = tokenPaid(e) ?? (e.amountWei === null ? 'An amount not read' : `${amount(e.amountWei)} ${e.kind === 'weth' ? 'WETH' : 'ETH'}`);
  return e.kind === 'funds' ? `${paid} funding the seller before the trade, on a loop of a lens of yours` : `${paid} paid, on a loop of a lens of yours`;
}

/**
 * One token's graph, as the paper draws it in Figure 8: wallets as nodes,
 * transfers as solid arrows, money as dashed ones. Holders sit on a circle
 * in the order they first held the token, clockwise from the top, so the
 * token's life reads around the ring. Middles, wallets that only joined two
 * holders by money, sit inside it.
 *
 * Parallel edges between one pair bow apart by their index so each stays
 * visible; that is the whole of the layout's cleverness, and a token traded
 * a few hundred times is still legible because only the pairs fan out.
 *
 * `own` are your lenses' flags of the token, each the concrete path its lens
 * found, drawn after everything above so a built-in drawing is the same with
 * or without them. A transfer of this token on a path lights its arrow; every
 * other step is a new arrow of tone `own`, and a wallet on a path that never
 * held the token (a money middle, a funder, the far end of another token's
 * transfer) joins the middles inside the ring.
 *
 * Each payment is its own dashed arrow with its amount. `numbering` (see
 * Numbering) is how the arrows are numbered: a token page's history, the
 * default, or a ring's one sequence by time, which also draws no first holder.
 */
export function layout(transfers: readonly Numbered[], flows: readonly Flow[], middles: readonly string[], own: readonly OwnFlag[] = [], names: Lenses = {},
  { numbering = 'history', size = 560 }: { numbering?: Numbering; size?: number } = {}): Drawing {
  const byTime = numbering === 'time';
  const holders: string[] = [];
  for (const t of transfers) for (const a of [t.from, t.to]) if (a !== ZERO && !holders.includes(a)) holders.push(a);
  const inner = middles.filter((m) => !holders.includes(m));
  for (const f of own) {
    for (const a of [...f.wallets, ...f.path.flatMap((e) => [e.from, e.to])]) if (a !== ZERO && !holders.includes(a) && !inner.includes(a)) inner.push(a);
  }
  const c = size / 2;
  // Two holders sit left and right rather than top and bottom: a middle
  // starts at the top of its own ring, and would otherwise sit on the line
  // between them, under the very arrow it explains.
  const ring = (list: readonly string[], r: number, middle: boolean, offset = 0): DrawnNode[] =>
    list.map((id, i) => {
      const pair = !middle && list.length === 2;
      const start = (pair ? Math.PI : -Math.PI / 2) + offset;
      const angle = start + (2 * Math.PI * i) / Math.max(1, list.length);
      const lone = list.length === 1 && !middle;
      const x = lone ? c : c + r * Math.cos(angle);
      const y = lone ? c : c + r * Math.sin(angle);
      // A pair's labels hang under their wallets, reaching outward from just inside them: set beside, each would add its
      // whole width to the strip's, and a phone would have to shrink the strip's text below reading to show it.
      if (pair) return { id, x, y, lx: x + (i === 0 ? 10 : -10), ly: y + 24, anchor: i === 0 ? 'end' : 'start', middle, first: !byTime && i === 0, custody: CUSTODIANS[id] ?? null };
      const out = lone ? 0 : middle ? -Math.PI / 2 : angle;
      const gap = lone ? 0 : 26;
      const lx = x + gap * Math.cos(out);
      return { id, x, y, lx, ly: (lone ? y + 24 : y + gap * Math.sin(out)), anchor: lx < x - 4 ? 'end' : lx > x + 4 ? 'start' : 'middle', middle, first: !byTime && !middle && i === 0, custody: CUSTODIANS[id] ?? null };
    });
  // Neighbours on the ring sit SPACING apart, so a loop of a few wallets is drawn small, not on the big ring a crowd needs;
  // past six the ring stops growing, leaving room in the square for a label set outward (an address is about 70 px of mono text).
  // One wallet, or two, is spaced as a pair is.
  const around = (n: number) => Math.min(c - 100, SPACING / (2 * Math.sin(Math.PI / Math.max(2, n))));
  // A ring with wallets inside is spaced as a ring of six at least: a smaller one's sides close in on its middles'
  // payments, so an amount set beside one (up to "12.3456 ETH") is struck by a side, or sits nearer it.
  const r = holders.length < 2 ? 0 : around(holders.length > 2 && inner.length > 0 ? Math.max(6, holders.length) : holders.length);
  // A pair's middles sit above and below the line between them, past the highest of its fan of arrows; any other ring's, inside it.
  // A lone holder sits at the centre with no ring to be inside, so its middles ring it, spaced as holders are: at 0.42 of a radius of 0 each would sit on it.
  // Past two, as a loop's path through three wallets is, a pair's ring would set some beside the pair, their labels on its own:
  // they sit in a row above the line instead, in the order given (a path's, from its first step), each label clear of the next,
  // starting over the holder the first pays or is paid by, so a path reads across without doubling back.
  /**
   * Which ways round a ring's middle its name may go, best first; the first spot no arc runs through, and no other wallet
   * or name sits in, is taken once the arcs are drawn. A lone middle sits at the centre, its payments running out to the
   * holders like spokes: its name goes in a gap between two spokes, the one nearest straight down first, not above it,
   * where the spoke to the ring's first holder runs. Several sit between the holders' ways, and their names go above
   * them first, then round them.
   */
  const gaps = Array.from({ length: holders.length }, (_, i) => -Math.PI / 2 + Math.PI / holders.length + (2 * Math.PI * i) / holders.length);
  const apart = (g: number, to: number) => Math.abs(Math.atan2(Math.sin(g - to), Math.cos(g - to)));
  const nameWays = inner.length === 1 ? [...gaps].sort((p, q) => apart(p, Math.PI / 2) - apart(q, Math.PI / 2))
    : Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4).sort((p, q) => apart(p, -Math.PI / 2) - apart(q, -Math.PI / 2));
  const namesRound = (x: number, y: number) => nameWays.flatMap((g) => [34, 44, 26, 54].map((d): Pick<DrawnNode, 'lx' | 'ly' | 'anchor'> => {
    const lx = x + d * Math.cos(g);
    return { lx, ly: y + d * Math.sin(g), anchor: lx < x - 4 ? 'end' : lx > x + 4 ? 'start' : 'middle' };
  }));
  const centreMiddle = (id: string): DrawnNode => ({ id, x: c, y: c, ...namesRound(c, c)[0]!, middle: true, first: false, custody: CUSTODIANS[id] ?? null });
  const row = holders.length === 2 && inner.length > 2;
  const fromRight = row && flows.some((f) => (f.from === holders[1] && f.to === inner[0]) || (f.to === holders[1] && f.from === inner[0]));

  // A pair traded more often than a fan can show, as a wash pair often is,
  // is drawn as one arrow per direction carrying its count; the table keeps
  // every row. The arrow points at the first of them.
  const pairCount = new Map<string, number>();
  for (const t of transfers) {
    if (t.from === ZERO || t.to === ZERO) continue;
    const key = pairKey(t.from, t.to);
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }
  // The payments drawn: those between two wallets on the drawing.
  const onDrawing = new Set([...holders, ...inner]);
  const paid = flows.flatMap((f, j) => (onDrawing.has(f.from) && onDrawing.has(f.to) ? [j] : []));
  // One arrow a payment, with its amount, opening it. A pair whose transfers and payments together are more than a fan
  // can show draws each way's payments as one arrow, with their count and what they came to, opening the first of them.
  const slots = (pair: string) => { const n = pairCount.get(pair) ?? 0; return n > FAN_MAX ? 2 : n; };
  const onPair = new Map<string, number>(), ways = new Map<string, number[]>();
  for (const j of paid) {
    const f = flows[j]!, pair = pairKey(f.from, f.to), way = `${f.from}>${f.to}`;
    onPair.set(pair, (onPair.get(pair) ?? 0) + 1);
    ways.set(way, [...(ways.get(way) ?? []), j]);
  }
  /** Whether a way's `n` payments on `pair` are drawn as one arrow. */
  const bundled = (pair: string, n: number) => slots(pair) + onPair.get(pair)! > FAN_MAX && n > 1;
  /** How many arcs the fan between two wallets has: its transfers' (two bundles past FAN_MAX) and its payments', a bundled way's one. */
  const arcsOn = (a: string, b: string) => slots(pairKey(a, b)) + [`${a}>${b}`, `${b}>${a}`].reduce((sum, way) => {
    const n = ways.get(way)?.length ?? 0;
    return sum + (n > 0 && bundled(pairKey(a, b), n) ? 1 : n);
  }, 0);
  // Past the pair's own fan.
  const clearOfFan = holders.length === 2 ? Math.max(FAN_CLEAR, fanReach(arcsOn(holders[0]!, holders[1]!)) + 24) : FAN_CLEAR;
  const nodes = [...ring(holders, r, false), ...(row
    ? inner.map((id, i): DrawnNode => {
      const x = c + (i - (inner.length - 1) / 2) * ROW_GAP * (fromRight ? -1 : 1), y = c - clearOfFan;
      // Higher than a ring's labels: the arrows between them bow up, their amounts above them.
      return { id, x, y, lx: x, ly: y - 36, anchor: 'middle', middle: true, first: false, custody: CUSTODIANS[id] ?? null };
    })
    // Inside a ring of three or more, a lone middle sits at the centre, its payments spokes apart from every side; more sit between the holders' ways, never on one's.
    : holders.length > 2 ? (inner.length === 1 ? [centreMiddle(inner[0]!)] : ring(inner, r * 0.42, true, Math.PI / holders.length))
    : ring(inner, holders.length === 2 ? clearOfFan : around(inner.length), true))];
  const at = new Map(nodes.map((n) => [n.id, n]));
  // A ring with wallets inside grows its sides' fans outward only, clear of them and their payments (curve's `inside`).
  const inside = holders.length > 2 && inner.length > 0 ? Infinity : 0;
  const arcOf = (from: string, to: string, k: number) => curve(at.get(from)!, at.get(to)!, k, c, inside);

  // Edges grouped by unordered pair, so A→B and B→A share one fan.
  const fans = new Map<string, number>();
  const nextIn = (a: string, b: string) => {
    const key = pairKey(a, b);
    const k = fans.get(key) ?? 0;
    fans.set(key, k + 1);
    return k;
  };

  const bundles = new Map<string, { first: number; rows: number[]; tone: Tone; ids: string[] }>();
  const RANK: Record<Tone, number> = { clean: 0, apart: 1, ceiling: 2, cycle: 3 };

  // By time, one sequence of the flagged transfers drawn and the payments (timeOrder); by history, none.
  const order = !byTime ? [] : timeOrder(transfers, transfers.flatMap((t, i) => (t.from === ZERO || t.to === ZERO || toneOf(t) === 'clean' ? [] : [i])), flows, paid);
  const placeOf = new Map(order.map((s, k) => [`${s.of}${s.index}`, k + 1]));
  // Each arrow's number (Numbered). A drawing of several tokens, as a ring's, puts each number under its token: two tokens both have a sale 2.
  // By time the number is the drawing's own sequence, and the title names the token instead.
  const several = new Set(transfers.map((t) => t.tokenId)).size > 1;
  const numberOf = (i: number) => {
    if (byTime) return String(placeOf.get(`transfer${i}`) ?? '');
    const t = transfers[i]!, n = String(t.n ?? i + 1);
    return several ? `#${tokenLabel(t.tokenId, 8)}·${n}` : n;
  };
  /** The number as a title says it: "#2", or "#114·2" already marked. */
  const named = (i: number) => (several ? numberOf(i) : `#${numberOf(i)}`);
  /** An asset arrow's title up to its flags: by history its number and what it was; by time its place, then what it was, of which token. */
  const what = (i: number) => {
    const t = transfers[i]!, n = numberOf(i), token = `#${tokenLabel(t.tokenId, 8)}`;
    if (!byTime) return `${named(i)} ${t.marketplace ? `sale on ${venueName(t.marketplace)}` : 'transfer'}`;
    return `${n === '' ? '' : `${n}: `}${t.marketplace ? `sale of ${token} on ${venueName(t.marketplace)}` : `transfer of ${token}`}`;
  };
  const idOf = (t: FlaggedTransfer) => `${t.txHash}:${t.logIndex}`;

  const edges: DrawnEdge[] = [];
  /** Which arrow draws each transfer (by index), so a reason can name its arrows. */
  const edgeOf = new Map<number, string>();
  transfers.forEach((t, i) => {
    if (t.from === ZERO || t.to === ZERO) return;
    if (pairCount.get(pairKey(t.from, t.to))! > FAN_MAX) {
      const b = bundles.get(`${t.from}>${t.to}`) ?? { first: i, rows: [], tone: 'clean' as Tone, ids: [] };
      b.rows.push(i + 1);
      b.ids.push(idOf(t));
      const v = toneOf(t);
      if (RANK[v] > RANK[b.tone]) b.tone = v;
      bundles.set(`${t.from}>${t.to}`, b);
      edgeOf.set(i, `b${t.from}>${t.to}`);
      return;
    }
    const k = nextIn(t.from, t.to);
    const tone = toneOf(t);
    const label = numberOf(i), sum = salePaid(t);
    edges.push({
      key: `t${i}`, kind: 'asset', tone, from: t.from, to: t.to, tx: t.txHash, row: i + 1, label, amount: sum, ids: [idOf(t)],
      title: `${what(i)}${flaggedNote(tone)}`,
      ...beside(arcOf(t.from, t.to, k), label, sum),
    });
    edgeOf.set(i, `t${i}`);
  });

  for (const [key, b] of bundles) {
    const [from, to] = key.split('>') as [string, string];
    // A bundled pair has only its two arrows, so each takes the same wide
    // bow, which curve() puts on opposite sides for opposite directions.
    // Money between the pair keeps the fan, and starts in the middle.
    const k = from < to ? 1 : 2;
    const label = `×${b.rows.length}`;
    // By time the bundle's transfers have no numbers of their own on the drawing; by history its first and last are said.
    const span = byTime ? '' : `, ${named(b.rows[0]! - 1)} to ${named(b.rows[b.rows.length - 1]! - 1)}`;
    edges.push({
      key: `b${key}`, kind: 'asset', tone: b.tone, from, to, tx: transfers[b.first]!.txHash, row: b.first + 1, label, amount: '', ids: b.ids,
      title: `${b.rows.length} transfers this way${span}${flaggedNote(b.tone)}`,
      ...beside(arcOf(from, to, k), label, ''),
    });
  }

  /** Which arrow draws each payment (by index), so a step can name it. */
  const moneyOf = new Map<number, string>();
  for (const j of paid) {
    const f = flows[j]!, all = ways.get(`${f.from}>${f.to}`)!;
    if (bundled(pairKey(f.from, f.to), all.length)) {
      const key = `m${f.from}>${f.to}`;
      moneyOf.set(j, key);
      if (all[0] !== j) continue;
      const label = `×${all.length}`, sum = paidInAll(all.map((x) => flows[x]!));
      edges.push({
        key, kind: 'money', tone: 'clean', from: f.from, to: f.to, tx: f.txHash, row: null, label, amount: sum, ids: [],
        title: `${all.length} payments this way, ${sum} in all`, ...beside(arcOf(f.from, f.to, nextIn(f.from, f.to)), label, sum),
      });
      continue;
    }
    const label = String(placeOf.get(`payment${j}`) ?? ''), sum = flowPaid(f);
    moneyOf.set(j, `p${j}`);
    edges.push({
      key: `p${j}`, kind: 'money', tone: 'clean', from: f.from, to: f.to, tx: f.txHash, row: null, label, amount: sum, ids: [],
      title: `${label === '' ? '' : `${label}: `}${sum} paid`, ...beside(arcOf(f.from, f.to, nextIn(f.from, f.to)), label, sum),
    });
  }

  const loops = reasons(transfers).map((reason, i): DrawnLoop => {
    const w = reason.witness;
    // A payment lights when the witness used it, by the engine's own rule (useOf), so the lit money is what its card lists:
    // a pair's legs through its middle (or direct), Money loops back's via legs and the steps of its paths. The wallets
    // its paths pass through join the loop. A witness saved before paths lights only its via legs.
    const paths = w.kind === 'scc+flow' ? w.paths ?? [] : [];
    const wallets = w.kind === 'pair' ? [...w.pair, ...(w.middle === null ? [] : [w.middle])] : [...new Set([...w.wallets, ...paths.flatMap((p) => p.wallets)])];
    const lit = (e: DrawnEdge) => e.tx !== null && useOf(w, { from: e.from, to: e.to, txHash: e.tx }) !== null;
    const assets = reason.rows.flatMap((n) => edgeOf.get(n - 1) ?? []);
    const money = edges.filter((e) => e.kind === 'money' && lit(e)).map((e) => e.key);
    return { key: `r${i}`, methods: reason.methods, edges: [...new Set([...assets, ...money])], nodes: wallets };
  });

  /** The row of a transfer of this token on a path: the flag's own trade exactly, any other by its hash and its two wallets, else its hash alone (custody folds A → escrow → B into one step). */
  const rowOf = (e: LoopEdge, f: OwnFlag, j: number): number => {
    if (j === 0) return transfers.findIndex((t) => t.txHash === f.txHash && t.logIndex === f.logIndex);
    if (e.tx === null) return -1;
    const exact = transfers.findIndex((t) => t.txHash === e.tx && t.from === e.from && t.to === e.to);
    return exact >= 0 ? exact : transfers.findIndex((t) => t.txHash === e.tx);
  };
  own.forEach((f, i) => {
    const keys: string[] = [];
    f.path.forEach((e, j) => {
      const row = e.kind === 'nft-token' ? rowOf(e, f, j) : -1;
      const drawn = row < 0 ? undefined : edgeOf.get(row);
      if (drawn !== undefined) { keys.push(drawn); return; }
      // A mint or a burn is no wallet to draw an arrow to.
      if (!at.has(e.from) || !at.has(e.to)) return;
      const asset = e.kind === 'nft-token' || e.kind === 'nft-collection';
      const key = `o${i}e${j}`;
      const label = asset && e.kind === 'nft-collection' && e.tokenId !== null ? `#${e.tokenId}` : '';
      const sum = asset ? '' : tokenPaid(e) ?? `${amount(e.amountWei)} ${e.kind === 'weth' ? 'WETH' : 'ETH'}`;
      edges.push({
        key, kind: asset ? 'asset' : 'money', tone: 'own', from: e.from, to: e.to, tx: asset || e.kind === 'eth' || e.kind === 'internal' || e.kind === 'weth' ? e.tx : null, row: null, ids: [],
        label, amount: sum, title: ownTitle(e), ...(e.kind === 'nft-collection' && e.tokenId !== null ? { token: e.tokenId } : {}),
        ...beside(arcOf(e.from, e.to, nextIn(e.from, e.to)), label, sum),
      });
      keys.push(key);
    });
    const wallets = [...new Set([...f.wallets, ...f.path.flatMap((e) => [e.from, e.to])])].filter((a) => a !== ZERO);
    loops.push({ key: `o${i}`, methods: [`L${f.lensId}`], edges: [...new Set(keys)], nodes: wallets });
  });
  // A trade the built-ins left clean that a loop of yours lights takes your lenses' hue and names them (`names`, else "a lens of yours"):
  // drawn in the clean hue, the legend would call a caught trade "not flagged".
  const ownLoops = loops.slice(loops.length - own.length);
  for (const e of edges) {
    if (e.kind !== 'asset' || e.tone !== 'clean') continue;
    const by = [...new Set(ownLoops.filter((l) => l.edges.includes(e.key)).flatMap((l) => l.methods.map((k) => names[k]?.name ?? 'a lens of yours')))];
    if (by.length === 0) continue;
    Object.assign(e, { tone: 'own', yours: by, title: `${e.title} · not flagged by a built-in lens; on a loop of ${andList(by)}` });
  }
  // A graph past LABELLED_MAX draws no label, so places none and keeps no room for them.
  const labelled = nodes.length <= LABELLED_MAX;
  // A ring's middle takes the first of its name's spots (namesRound) that no arc runs through and no other wallet or
  // name sits in; with none, the best of them.
  if (labelled && holders.length > 2 && inner.length > 0) {
    const paths = edges.map((e) => pathPoints(e.d));
    for (const m of nodes.filter((n) => n.middle)) {
      const others = nodes.filter((n) => n !== m).flatMap((n) => [walletBox(n), nameBox(n)]);
      const clear = namesRound(m.x, m.y).find((s) => {
        // A couple of px wider for the arcs: their points are that far apart, and one between two could clip a corner.
        const b = nameBox(s), near = { x0: b.x0 - 2, x1: b.x1 + 2, y0: b.y0 - 2, y1: b.y1 + 2 };
        return !others.some((o) => meets(o, b)) && !paths.some((pts) => pts.some(([x, y]) => inBox(near, x, y)));
      });
      if (clear !== undefined) Object.assign(m, clear);
    }
  }
  if (labelled) clearLabels(nodes, edges);
  const steps = order.map((s, k): Step => ({
    n: k + 1, edge: (s.of === 'transfer' ? edgeOf.get(s.index) : moneyOf.get(s.index))!, ...s,
    amount: s.of === 'transfer' ? salePaid(transfers[s.index]!) : flowPaid(flows[s.index]!),
  }));
  return { size, numbering, view: viewOf(nodes, edges, size, labelled), nodes, edges, loops, ...(byTime ? { steps } : {}) };
}

/** A label's glyph band, its text's half-height and a little, in px: no arc, wallet or other label may come inside it. */
const BAND = 6;

type Box = { x0: number; x1: number; y0: number; y1: number };
const meets = (p: Box, q: Box) => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;
const inBox = (b: Box, x: number, y: number) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;
/** A wallet's circle and a little: where no label may sit. */
const walletBox = (n: Pick<DrawnNode, 'x' | 'y'>): Box => ({ x0: n.x - 11, x1: n.x + 11, y0: n.y - 11, y1: n.y + 11 });

/** The numbers of an arrow's path, as curve() writes it: M x0 y0 Q cx cy x1 y1, or a self-loop's M x y C c1, c2, x y. */
const numbersOf = (d: string) => (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number);

/** Points along an arrow's path, a couple of px apart: enough to tell what it runs through. */
function pathPoints(d: string): [number, number][] {
  const v = numbersOf(d), cubic = d.includes('C');
  return Array.from({ length: 97 }, (_, i): [number, number] => {
    const s = i / 96, u = 1 - s;
    if (!cubic) return [u * u * v[0]! + 2 * u * s * v[2]! + s * s * v[4]!, u * u * v[1]! + 2 * u * s * v[3]! + s * s * v[5]!];
    return [u ** 3 * v[0]! + 3 * u * u * s * v[2]! + 3 * u * s * s * v[4]! + s ** 3 * v[6]!, u ** 3 * v[1]! + 3 * u * u * s * v[3]! + 3 * u * s * s * v[5]! + s ** 3 * v[7]!];
  });
}

/** The box round an arrow's curve as drawn: a quadratic's ends and, each way, its turning point between them; a self-loop's points. */
function pathBox(d: string): Box {
  if (d.includes('C')) {
    const pts = pathPoints(d), xs = pts.map(([x]) => x), ys = pts.map(([, y]) => y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }
  const v = numbersOf(d);
  /** Where the curve turns back on one axis between its ends, given its end, control and end there; else its first end. */
  const turn = (a: number, ctl: number, b: number) => {
    const s = (a - ctl) / (a - 2 * ctl + b);
    return s > 0 && s < 1 ? (1 - s) ** 2 * a + 2 * (1 - s) * s * ctl + s * s * b : a;
  };
  const xs = [v[0]!, v[4]!, turn(v[0]!, v[2]!, v[4]!)], ys = [v[1]!, v[5]!, turn(v[1]!, v[3]!, v[5]!)];
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/**
 * Where else a label of half-width `hw` may go beside its arc: at a few
 * places along it, on its own side first, then the other, a little further
 * out each time; the nearest first. None for a self-loop, whose label is at its tip.
 */
function spotsBeside(e: DrawnEdge, hw: number): { x: number; y: number }[] {
  if (e.d.includes('C')) return [];
  const v = numbersOf(e.d), [x0, y0, cx, cy, x1, y1] = [v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!];
  const at = (s: number) => ({ x: (1 - s) ** 2 * x0 + 2 * (1 - s) * s * cx + s * s * x1, y: (1 - s) ** 2 * y0 + 2 * (1 - s) * s * cy + s * s * y1 });
  const mid = at(0.5);
  const out: { x: number; y: number }[] = [];
  for (const extra of [0, 8, 16, 24, 36, 48, 64]) {
    for (const s of [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74]) {
      // The curve's normal at s, turned to the label's own side (where beside() set it) for `own`.
      const tx = 2 * (1 - s) * (cx - x0) + 2 * s * (x1 - cx), ty = 2 * (1 - s) * (cy - y0) + 2 * s * (y1 - cy);
      const tl = Math.hypot(tx, ty) || 1;
      let nx = -ty / tl, ny = tx / tl;
      if ((e.lx - mid.x) * nx + (e.ly - mid.y) * ny < 0) { nx = -nx; ny = -ny; }
      const p = at(s), gap = hw * Math.abs(nx) + (LABEL_H / 2) * Math.abs(ny) + LABEL_GAP + extra;
      for (const side of [1, -1]) out.push({ x: p.x + nx * side * gap, y: p.y + ny * side * gap });
    }
  }
  return out;
}

/** How much nearer its own arc a moved label must be than any other, in px, to its box and to its centre: read beside the nearest line, a label names that line's amount. */
export const OWN_MARGIN = 3;

/** How far a box is from a point, 0 inside it. */
const boxGap = (b: Box, [x, y]: readonly [number, number]) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));

/**
 * Every arrow's label where it is read as its own: its own spot beside its
 * arc's middle when that spot is fit, else the first fit one of spotsBeside.
 * A spot is fit when no arc runs through it, no wallet, wallet's name or
 * earlier label sits there, and its own arc is nearer it than any other by
 * OWN_MARGIN, to its box and to its centre. A fan's arcs nest, and a long
 * label between two of them would be struck by the next one out; moved to
 * any clear spot, it could sit by a neighbour and name the neighbour's
 * amount. Attribution comes first: a label with no fit spot tries its number
 * alone (amountHidden, its amount said in its title), which is narrow enough
 * to sit by its own arc where the whole is not; one that finds none either
 * keeps its own spot, beside its own arc, where its halo (drawn over every
 * line) keeps it legible. It is never moved nearer a neighbour.
 */
function clearLabels(nodes: readonly DrawnNode[], edges: readonly DrawnEdge[]): void {
  const arcs = edges.map((e) => {
    const pts = pathPoints(e.d), xs = pts.map(([x]) => x), ys = pts.map(([, y]) => y);
    return { key: e.key, pts, box: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } };
  });
  const taken: Box[] = nodes.flatMap((n) => [walletBox(n), nameBox(n)]);
  const struck = (b: Box) => arcs.some((a) => meets(a.box, b) && a.pts.some(([x, y]) => inBox(b, x, y)));
  // A drawn path as sampled here; not the module's Arc, which curve() returns.
  type Path = (typeof arcs)[number];
  type Spot = { x: number; y: number };
  const boxAt = (p: Spot, hw: number): Box => ({ x0: p.x - hw, x1: p.x + hw, y0: p.y - BAND, y1: p.y + BAND });
  /** Whether `mine` is nearer a label (box `b`, centre `p`) than any other arc, by OWN_MARGIN to its box and to its centre. */
  const own = (mine: Path, p: Spot, b: Box, hw: number) => {
    const near = (pts: readonly [number, number][]) => ({ box: Math.min(...pts.map((q) => boxGap(b, q))), centre: Math.min(...pts.map(([x, y]) => Math.hypot(x - p.x, y - p.y))) });
    const ours = near(mine.pts);
    // An arc whose bounds are this far from the label's centre is never nearer it than its own: only the rest are measured.
    const reach = ours.centre + OWN_MARGIN + hw + BAND;
    return arcs.every((a) => {
      if (a === mine || boxGap(a.box, [p.x, p.y]) >= reach) return true;
      const theirs = near(a.pts);
      return theirs.box >= ours.box + OWN_MARGIN && theirs.centre >= ours.centre + OWN_MARGIN;
    });
  };
  const fit = (mine: Path, p: Spot, hw: number) => {
    const b = boxAt(p, hw);
    return !taken.some((t) => meets(t, b)) && !struck(b) && own(mine, p, b, hw);
  };
  for (const e of edges) {
    const text = labelText(e.label, e.amount);
    if (text === '') continue;
    const mine = arcs.find((a) => a.key === e.key)!;
    /** A label of `chars` characters' first fit spot, `first` before those beside its arc. */
    const fitFor = (chars: number, first: Spot[]) => {
      const hw = (chars * CHAR_W) / 2;
      return { hw, spot: [...first, ...spotsBeside(e, hw)].find((p) => fit(mine, p, hw)) };
    };
    const whole = fitFor(text.length, [{ x: e.lx, y: e.ly }]);
    // No fit spot for the whole of it, as beside a steep side of a busy ring, where a wide label sits far off its own line:
    // its number alone is narrow enough to sit by its own arc. What it paid moves to its title, and its row says it too.
    const number = whole.spot !== undefined || e.label === '' || e.amount === '' ? null : fitFor(e.label.length, []);
    if (whole.spot !== undefined) Object.assign(e, { lx: whole.spot.x, ly: whole.spot.y });
    else if (number?.spot !== undefined) Object.assign(e, { lx: number.spot.x, ly: number.spot.y, amountHidden: true, title: `${e.title} · ${e.amount}` });
    taken.push(boxAt({ x: e.lx, y: e.ly }, e.amountHidden ? number!.hw : whole.hw));
  }
}

/** A wallet's label, short(address) in 10 px mono, and one character of an arrow's, in px: enough to keep them inside the view. */
const NAME_W = 68, CHAR_W = 6;

/** A wallet's label as drawn, NAME_W wide from its anchor, `half` px above and below its line: where no arc or other label may come. */
function nameBox(n: Pick<DrawnNode, 'lx' | 'ly' | 'anchor'>, half = BAND + 1): Box {
  const x0 = n.anchor === 'end' ? n.lx - NAME_W : n.anchor === 'start' ? n.lx : n.lx - NAME_W / 2;
  return { x0, x1: x0 + NAME_W, y0: n.ly - half, y1: n.ly + half };
}
/** An arrow label's height, and the room left between it and its line, in px. */
const LABEL_H = 14, LABEL_GAP = 3;

/** An arrow's label as LoopFigure draws it (DrawnEdge): its number, then what it paid, as "2 · 9 ETH". Its width keeps the label clear of its line and inside the view. */
const labelText = (label: string, paid: string): string => (label && paid ? `${label}${LABEL_SEP}${paid}` : label || paid);

/**
 * The box round everything drawn: each wallet and its label, and each arrow by
 * its curve as drawn (pathBox) and its label, padded. Not by its control
 * points: a fan's outer arc has its control point twice as far out as the
 * curve reaches, and boxing that would leave a band of empty card. With
 * nothing drawn, the whole square.
 */
function viewOf(nodes: readonly DrawnNode[], edges: readonly DrawnEdge[], size: number, labelled: boolean): Drawing['view'] {
  const all: Box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
  const box = (x0: number, x1: number, y0: number, y1: number) => {
    all.x0 = Math.min(all.x0, x0); all.x1 = Math.max(all.x1, x1); all.y0 = Math.min(all.y0, y0); all.y1 = Math.max(all.y1, y1);
  };
  for (const n of nodes) {
    box(n.x - 10, n.x + 10, n.y - 10, n.y + 10);
    const name = nameBox(n, LABEL_H / 2 + 1);
    box(name.x0, name.x1, name.y0, name.y1);
  }
  for (const e of edges) {
    const b = pathBox(e.d);
    box(b.x0, b.x1, b.y0, b.y1);
    const half = labelled ? (labelText(e.label, e.amountHidden ? '' : e.amount).length * CHAR_W) / 2 : 0;
    if (half > 0) box(e.lx - half, e.lx + half, e.ly - LABEL_H / 2, e.ly + LABEL_H / 2);
  }
  if (all.x0 === Infinity) return { x: 0, y: 0, w: size, h: size };
  const pad = 12;
  const x = all.x0 - pad, y = all.y0 - pad;
  return { x, y, w: all.x1 + pad - x, h: all.y1 + pad - y };
}

/** An arc's path, its middle (`x`, `y`), and the side its label goes there (`nx`, `ny`, a unit vector; see curve). */
type Arc = { d: string; x: number; y: number; nx: number; ny: number };

/**
 * An arc with its label set beside its middle, on its label's side (curve),
 * clear of the line by the label's own half-extent that way plus LABEL_GAP:
 * a long label beside a steep arc goes further out than a short one. An arrow
 * with no label keeps its middle, which a page scrolls to.
 */
function beside(a: Arc, label: string, paid: string): { d: string; lx: number; ly: number } {
  const chars = labelText(label, paid).length;
  if (chars === 0) return { d: a.d, lx: a.x, ly: a.y };
  const out = ((chars * CHAR_W) / 2) * Math.abs(a.nx) + (LABEL_H / 2) * Math.abs(a.ny) + LABEL_GAP;
  return { d: a.d, lx: a.x + a.nx * out, ly: a.y + a.ny * out };
}

/**
 * A quadratic arc from a to b, bowed by `k` steps; a self-loop is a teardrop pointing away from the centre, each next one
 * of a wallet turned aside. `inside` is how near the centre the middle of an arc off it may come, bowing toward it: 0 on
 * an empty ring, so no arc crosses the middle to tangle with the far sides' fans; Infinity on a ring with wallets inside,
 * so no sale runs over one or through their payments.
 */
function curve(a: DrawnNode, b: DrawnNode, k: number, centre: number, inside: number): Arc {
  if (a.id === b.id) {
    const ox = a.x - centre, oy = a.y - centre;
    const len = Math.hypot(ox, oy) || 1;
    // Each next self-loop of a wallet points SELF_TURN further round, by turns either side: a longer one would hold the
    // last one inside it, its label with it.
    const turn = Math.ceil(k / 2) * (k % 2 === 0 ? -1 : 1) * SELF_TURN;
    const [bx, by] = len > 1 ? [ox / len, oy / len] : [0, -1];
    const ux = bx * Math.cos(turn) - by * Math.sin(turn), uy = bx * Math.sin(turn) + by * Math.cos(turn);
    const reach = 34;
    const tip = { x: a.x + ux * reach, y: a.y + uy * reach };
    const d = `M ${a.x} ${a.y} C ${tip.x - uy * 18} ${tip.y + ux * 18}, ${tip.x + uy * 18} ${tip.y - ux * 18}, ${a.x} ${a.y}`;
    return { d, x: tip.x, y: tip.y, nx: ux, ny: uy };
  }
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // The side a pair's fan grows toward, the same whichever way an arc runs: away from the centre for a pair off it, as a
  // ring's side is, where there is room for a fan and its labels, so its first arc's label goes inside; for a pair through it, the left of the lower address's way.
  const turn = a.id < b.id ? 1 : -1;
  let nx = (-dy / len) * turn, ny = (dx / len) * turn;
  const inward = (centre - (a.x + b.x) / 2) * nx + (centre - (a.y + b.y) / 2) * ny;
  if (inward > 4) { nx = -nx; ny = -ny; }
  // The first arc bows a little toward the fan's side, then each next one FAN_STEP further at its middle, by turns: +1, −1, +2, −2…
  // A quadratic's middle sits halfway out to its control point, so the control point moves twice that: measured at the
  // control point, neighbouring arcs' middles would be half FAN_STEP apart, and a label beside one as near the next.
  // A pair off the centre bows toward it only as far as `inside` leaves room (a px over, for a square's side, whose
  // second arc in reaches the centre exactly); the arcs past that grow its fan outward: +1, −1, +2, +3…
  const inwards = Math.abs(inward) <= 4 ? Infinity : Math.max(0, Math.floor((Math.abs(inward) - inside + 1 + MID_BOW) / FAN_STEP));
  const step = k <= 2 * inwards ? Math.ceil(k / 2) * (k % 2 === 0 ? -1 : 1) : inwards + k - 2 * inwards;
  const bow = 2 * (MID_BOW + FAN_STEP * step);
  const mx = (a.x + b.x) / 2 + nx * bow;
  const my = (a.y + b.y) / 2 + ny * bow;
  // Stop short of the node so the arrowhead is not under its circle.
  const ex = b.x - ((b.x - mx) / Math.hypot(b.x - mx, b.y - my)) * 13;
  const ey = b.y - ((b.y - my) / Math.hypot(b.x - mx, b.y - my)) * 13;
  // Its label's side: the first arc's, the side the fan does not grow toward, where no arc of its fan is near;
  // each later one's, the outer side of its bow, beyond its arc, where the next arc out is a full FAN_STEP away.
  const side = k === 0 ? -1 : Math.sign(bow);
  return { d: `M ${a.x} ${a.y} Q ${mx} ${my} ${ex} ${ey}`, x: (a.x + 2 * mx + b.x) / 4, y: (a.y + 2 * my + b.y) / 4, nx: nx * side, ny: ny * side };
}
