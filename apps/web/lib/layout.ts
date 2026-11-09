import { METHODS, TOKENS, ZERO, type FlaggedTransfer, type Flow, type LoopEdge, type Method, type OwnFlag, type Witness } from '@washtrace/detect';
import type { LensKey } from '@washtrace/detect/trades';
import { LENSES, andList, type Lenses } from './format';
import { toneOf, type Tone } from './metrics';
import { weiToEth } from './trades-url';

/** Two witnesses that would read as the same sentence share a key. */
function witnessKey(w: Witness): string {
  if (w.kind === 'pair') return `pair|${w.pair.join(',')}|${w.middle}|${w.flowTx}`;
  const base = `${[...w.wallets].sort().join(',')}|${w.cycles}`;
  return w.kind === 'scc' ? `scc|${base}` : `flow|${base}|${w.via.length}`;
}

export interface Reason { witness: Witness; methods: Method[]; rows: number[] }

/**
 * A token's flags grouped by reason, so a pattern that four transfers share
 * is said once with the four rows it covers, and the lenses that agree on it
 * are named together. Rows are 1-based, as the graph labels them.
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
  return [...by.values()];
}

/** Unordered: A→B and B→A are one pair, and share one fan. */
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Past this many transfers between one pair, the fan's arcs leave the drawing and stop being countable. */
const FAN_MAX = 6;

/** `lx`, `ly`: where its label goes, outward from the centre, clear of the arrows arriving at it. */
export interface DrawnNode { id: string; x: number; y: number; lx: number; ly: number; middle: boolean; first: boolean }
/**
 * `tx` and `row` are the transfer an asset arrow opens and numbers (a bundle's
 * first), and null for money. `from` and `to` are the wallets it joins. Tone
 * `own` is an arrow only a lens of yours drew: `token` is then the other token
 * of the collection it moved, for its label to open. It is also a trade of
 * this token no built-in flagged that a loop of yours lights: `yours` then
 * names those lenses, so the arrow is never drawn or called "not flagged".
 */
export interface DrawnEdge { key: string; d: string; kind: 'asset' | 'money'; tone: Tone | 'own'; title: string; from: string; to: string; tx: string | null; row: number | null; lx: number; ly: number; label: string; token?: string; yours?: string[] }
/** One reason a token was flagged: the arrows and wallets that make it, for the graph to light together. A lens of yours's loop is one reason, of its one lens. */
export interface DrawnLoop { key: string; methods: LensKey[]; edges: string[]; nodes: string[] }
export interface Drawing { size: number; nodes: DrawnNode[]; edges: DrawnEdge[]; loops: DrawnLoop[] }

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
 * edge: its token is on the edge (T10), since its kind ('funds' too) does
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
 */
export function layout(transfers: readonly FlaggedTransfer[], flows: readonly Flow[], middles: readonly string[], own: readonly OwnFlag[] = [], names: Lenses = {}, size = 560): Drawing {
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
  const ring = (list: readonly string[], r: number, middle: boolean): DrawnNode[] =>
    list.map((id, i) => {
      const start = !middle && list.length === 2 ? Math.PI : -Math.PI / 2;
      const angle = start + (2 * Math.PI * i) / Math.max(1, list.length);
      const lone = list.length === 1 && !middle;
      const x = lone ? c : c + r * Math.cos(angle);
      const y = lone ? c : c + r * Math.sin(angle);
      const out = lone ? 0 : middle ? -Math.PI / 2 : angle;
      const gap = lone ? 0 : 26;
      return { id, x, y, lx: x + gap * Math.cos(out), ly: (lone ? y + 24 : y + gap * Math.sin(out)), middle, first: !middle && i === 0 };
    });
  // Room past the ring for a label set outward: an address is about 70 px of mono text.
  const r = c - 100;
  const nodes = [...ring(holders, r, false), ...ring(inner, r * 0.42, true)];
  const at = new Map(nodes.map((n) => [n.id, n]));

  // Edges grouped by unordered pair, so A→B and B→A share one fan.
  const fans = new Map<string, number>();
  const nextIn = (a: string, b: string) => {
    const key = pairKey(a, b);
    const k = fans.get(key) ?? 0;
    fans.set(key, k + 1);
    return k;
  };

  // A pair traded more often than a fan can show, as a wash pair often is,
  // is drawn as one arrow per direction carrying its count; the table keeps
  // every row. The arrow points at the first of them.
  const pairCount = new Map<string, number>();
  for (const t of transfers) {
    if (t.from === ZERO || t.to === ZERO) continue;
    const key = pairKey(t.from, t.to);
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }
  const bundles = new Map<string, { first: number; rows: number[]; tone: Tone }>();
  const RANK: Record<Tone, number> = { clean: 0, apart: 1, money: 2, cycle: 3 };

  const edges: DrawnEdge[] = [];
  /** Which arrow draws each transfer (by index), so a reason can name its arrows. */
  const edgeOf = new Map<number, string>();
  transfers.forEach((t, i) => {
    if (t.from === ZERO || t.to === ZERO) return;
    if (pairCount.get(pairKey(t.from, t.to))! > FAN_MAX) {
      const b = bundles.get(`${t.from}>${t.to}`) ?? { first: i, rows: [], tone: 'clean' as Tone };
      b.rows.push(i + 1);
      const v = toneOf(t);
      if (RANK[v] > RANK[b.tone]) b.tone = v;
      bundles.set(`${t.from}>${t.to}`, b);
      edgeOf.set(i, `b${t.from}>${t.to}`);
      return;
    }
    const k = nextIn(t.from, t.to);
    const tone = toneOf(t);
    edges.push({
      key: `t${i}`, kind: 'asset', tone, from: t.from, to: t.to, tx: t.txHash, row: i + 1, label: String(i + 1),
      title: `#${i + 1} ${t.marketplace ? `sale on ${t.marketplace}` : 'transfer'}${flaggedNote(tone)}`,
      ...curve(at.get(t.from)!, at.get(t.to)!, k, c),
    });
    edgeOf.set(i, `t${i}`);
  });

  for (const [key, b] of bundles) {
    const [from, to] = key.split('>') as [string, string];
    // A bundled pair has only its two arrows, so each takes the same wide
    // bow, which curve() puts on opposite sides for opposite directions.
    // Money between the pair keeps the fan, and starts in the middle.
    const k = from < to ? 1 : 2;
    edges.push({
      key: `b${key}`, kind: 'asset', tone: b.tone, from, to, tx: transfers[b.first]!.txHash, row: b.first + 1, label: `×${b.rows.length}`,
      title: `${b.rows.length} transfers this way, rows ${b.rows[0]} to ${b.rows[b.rows.length - 1]}${flaggedNote(b.tone)}`,
      ...curve(at.get(from)!, at.get(to)!, k, c),
    });
  }

  const seen = new Map<string, number>();
  for (const f of flows) {
    if (!at.has(f.from) || !at.has(f.to)) continue;
    const key = `${f.from}>${f.to}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    const [from, to] = key.split('>') as [string, string];
    const k = nextIn(from, to);
    edges.push({
      key: `m${key}`, kind: 'money', tone: 'money', from, to, tx: null, row: null, label: count > 1 ? `×${count}` : '',
      title: `${count} money ${count === 1 ? 'flow' : 'flows'}`, ...curve(at.get(from)!, at.get(to)!, k, c),
    });
  }

  const loops = reasons(transfers).map((r, i): DrawnLoop => {
    const w = r.witness;
    const wallets = w.kind === 'pair' ? [...w.pair, ...(w.middle === null ? [] : [w.middle])] : [...w.wallets];
    const own = new Set(wallets);
    const assets = r.rows.flatMap((n) => edgeOf.get(n - 1) ?? []);
    const money = edges.filter((e) => e.kind === 'money' && own.has(e.from) && own.has(e.to)).map((e) => e.key);
    return { key: `r${i}`, methods: r.methods, edges: [...new Set([...assets, ...money])], nodes: wallets };
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
      edges.push({
        key, kind: asset ? 'asset' : 'money', tone: 'own', from: e.from, to: e.to, tx: asset ? e.tx : null, row: null,
        label: asset ? (e.kind === 'nft-collection' && e.tokenId !== null ? `#${e.tokenId}` : '') : tokenPaid(e) ?? amount(e.amountWei),
        title: ownTitle(e), ...(e.kind === 'nft-collection' && e.tokenId !== null ? { token: e.tokenId } : {}),
        ...curve(at.get(e.from)!, at.get(e.to)!, nextIn(e.from, e.to), c),
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
  return { size, nodes, edges, loops };
}

/** A quadratic arc from a to b, bowed by `k` steps; a self-loop is a teardrop pointing away from the centre. */
function curve(a: DrawnNode, b: DrawnNode, k: number, c: number): { d: string; lx: number; ly: number } {
  if (a.id === b.id) {
    const ox = a.x - c, oy = a.y - c;
    const len = Math.hypot(ox, oy) || 1;
    const ux = ox / len, uy = oy / len;
    const reach = 34 + 10 * k;
    const tip = { x: a.x + ux * reach, y: a.y + uy * reach };
    const d = `M ${a.x} ${a.y} C ${tip.x - uy * 18} ${tip.y + ux * 18}, ${tip.x + uy * 18} ${tip.y - ux * 18}, ${a.x} ${a.y}`;
    return { d, lx: tip.x, ly: tip.y };
  }
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Alternate sides: 0 straight-ish, then +1, −1, +2, −2… One direction's
  // first edge and the other's both bow, opposite ways, by the sign of the order.
  const step = Math.ceil(k / 2) * (k % 2 === 0 ? -1 : 1);
  const bow = 16 + 34 * step * (a.id < b.id ? 1 : -1);
  const mx = (a.x + b.x) / 2 - (dy / len) * bow;
  const my = (a.y + b.y) / 2 + (dx / len) * bow;
  // Stop short of the node so the arrowhead is not under its circle.
  const ex = b.x - ((b.x - mx) / Math.hypot(b.x - mx, b.y - my)) * 13;
  const ey = b.y - ((b.y - my) / Math.hypot(b.x - mx, b.y - my)) * 13;
  return { d: `M ${a.x} ${a.y} Q ${mx} ${my} ${ex} ${ey}`, lx: (a.x + 2 * mx + b.x) / 4, ly: (a.y + 2 * my + b.y) / 4 };
}
