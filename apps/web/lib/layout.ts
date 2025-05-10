import { ZERO, type FlaggedTransfer, type Flow } from '@washtrace/detect';

export type Verdict = 'cycle' | 'money' | 'clean';

/** Unordered: A→B and B→A are one pair, and share one fan. */
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Past this many transfers between one pair, the fan's arcs leave the drawing and stop being countable. */
const FAN_MAX = 6;

/** `lx`, `ly`: where its label goes, outward from the centre, clear of the arrows arriving at it. */
export interface DrawnNode { id: string; x: number; y: number; lx: number; ly: number; middle: boolean; first: boolean }
export interface DrawnEdge { key: string; d: string; kind: 'asset' | 'money'; verdict: Verdict; title: string; ref: number | null; lx: number; ly: number; label: string }
export interface Drawing { size: number; nodes: DrawnNode[]; edges: DrawnEdge[] }

/** Which verdict a transfer's flags amount to. A cycle of the token itself outranks a link through money. */
export function verdictOf(t: Pick<FlaggedTransfer, 'flags'>): Verdict {
  if (t.flags.A) return 'cycle';
  if (t.flags.AU || t.flags.AC) return 'money';
  return 'clean';
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
 */
export function layout(transfers: readonly FlaggedTransfer[], flows: readonly Flow[], middles: readonly string[], size = 560): Drawing {
  const holders: string[] = [];
  for (const t of transfers) for (const a of [t.from, t.to]) if (a !== ZERO && !holders.includes(a)) holders.push(a);
  const inner = middles.filter((m) => !holders.includes(m));
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
  const bundles = new Map<string, { first: number; rows: number[]; verdict: Verdict }>();
  const RANK: Record<Verdict, number> = { clean: 0, money: 1, cycle: 2 };

  const edges: DrawnEdge[] = [];
  transfers.forEach((t, i) => {
    if (t.from === ZERO || t.to === ZERO) return;
    if (pairCount.get(pairKey(t.from, t.to))! > FAN_MAX) {
      const b = bundles.get(`${t.from}>${t.to}`) ?? { first: i, rows: [], verdict: 'clean' as Verdict };
      b.rows.push(i + 1);
      const v = verdictOf(t);
      if (RANK[v] > RANK[b.verdict]) b.verdict = v;
      bundles.set(`${t.from}>${t.to}`, b);
      return;
    }
    const k = nextIn(t.from, t.to);
    const verdict = verdictOf(t);
    edges.push({
      key: `t${i}`, kind: 'asset', verdict, ref: i, label: String(i + 1),
      title: `#${i + 1} ${t.marketplace ? `sale on ${t.marketplace}` : 'transfer'}${verdict === 'clean' ? '' : ' · flagged'}`,
      ...curve(at.get(t.from)!, at.get(t.to)!, k, c),
    });
  });

  for (const [key, b] of bundles) {
    const [from, to] = key.split('>') as [string, string];
    // A bundled pair has only its two arrows, so each takes the same wide
    // bow, which curve() puts on opposite sides for opposite directions.
    // Money between the pair keeps the fan, and starts in the middle.
    const k = from < to ? 1 : 2;
    edges.push({
      key: `b${key}`, kind: 'asset', verdict: b.verdict, ref: b.first, label: `×${b.rows.length}`,
      title: `${b.rows.length} transfers this way, rows ${b.rows[0]} to ${b.rows[b.rows.length - 1]}${b.verdict === 'clean' ? '' : ' · flagged'}`,
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
      key: `m${key}`, kind: 'money', verdict: 'money', ref: null, label: count > 1 ? `×${count}` : '',
      title: `${count} money ${count === 1 ? 'flow' : 'flows'}`, ...curve(at.get(from)!, at.get(to)!, k, c),
    });
  }
  return { size, nodes, edges };
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
