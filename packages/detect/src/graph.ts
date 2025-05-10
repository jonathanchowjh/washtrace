import type { Transfer } from './types.js';

export const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * One edge of an asset transfer graph: a change of who holds the token.
 *
 * `ref` indexes the transfer this edge stands for. Null marks a bridge: the
 * paper's fix for missing data, an edge from the last known holder to the
 * next sender when the two disagree. A bridge closes the graph but was never
 * observed, so it is never flagged and never counted.
 */
export interface Hop {
  from: string;
  to: string;
  ref: number | null;
}

export interface TokenGraph {
  hops: Hop[];
  /** Real ownership changes: hops with a ref. */
  moves: number;
  /** Bridges inserted. Over `moves`, this is the paper's missing-data share. */
  gaps: number;
}

/**
 * The asset transfer graph of one token, from its transfers in chain order.
 *
 * Paper §4.3: sort by block, connect sender to receiver, and bridge from the
 * previous receiver when it is not the next sender.
 *
 * Added since: `custodians` are addresses that hold a token without owning
 * it, such as a lending escrow. Blur's Blend moves a token A → Blend → A for
 * every loan, which the 2023 method would read as a back-and-forth trade.
 * Custody is collapsed: A → custodian → B is one hop A → B, and a round trip
 * back to A is no hop at all. The zero address is a custodian too: a mint is
 * the first holder taking the token, not an edge from nobody, and a burn
 * then re-mint is custody through the zero address.
 */
export function tokenGraph(
  transfers: readonly Transfer[],
  order: readonly number[],
  custodians: ReadonlySet<string>,
): TokenGraph {
  const hops: Hop[] = [];
  let moves = 0;
  let gaps = 0;
  // `holder` owns the token now. `parked` owned it before it went into custody.
  let holder: string | null = null;
  let parked: string | null = null;
  for (const i of order) {
    const t = transfers[i]!;
    const fromHeld = isCustodian(t.from, custodians);
    const toHeld = isCustodian(t.to, custodians);
    if (fromHeld && toHeld) continue;
    if (!fromHeld) {
      const expected: string | null = holder ?? parked;
      if (expected !== null && expected !== t.from) {
        hops.push({ from: expected, to: t.from, ref: null });
        gaps += 1;
      }
    }
    const source: string | null = fromHeld ? parked : t.from;
    if (toHeld) {
      parked = source;
      holder = null;
      continue;
    }
    holder = t.to;
    parked = null;
    // A mint, or a token handed back to the wallet that parked it.
    if (source === null || (fromHeld && source === t.to)) continue;
    hops.push({ from: source, to: t.to, ref: i });
    moves += 1;
  }
  return { hops, moves, gaps };
}

function isCustodian(address: string, custodians: ReadonlySet<string>): boolean {
  return address === ZERO || custodians.has(address);
}

/**
 * Strongly connected components by Tarjan's algorithm (paper Figure 7).
 *
 * Iterative, not recursive: a token traded back and forth ten thousand
 * times is a ten-thousand-deep DFS, past what V8's stack allows. `adjacent`
 * lists each node's out-neighbours by node index. Components come back as
 * node index lists in reverse topological order, singletons included.
 */
export function tarjan(adjacent: readonly (readonly number[])[]): number[][] {
  const n = adjacent.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const components: number[][] = [];
  let next = 0;

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    // Each frame is a node and how far through its neighbours it has got.
    const frames: [number, number][] = [[root, 0]];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = 1;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const [v, at] = frame;
      const out = adjacent[v]!;
      if (at < out.length) {
        frame[1] = at + 1;
        const w = out[at]!;
        if (index[w] === -1) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = 1;
          frames.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v]!, index[w]!);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low[parent[0]] = Math.min(low[parent[0]]!, low[v]!);
      if (low[v] === index[v]) {
        const component: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = 0;
          component.push(w);
        } while (w !== v);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * The independent cycles in a strongly connected multigraph: E − V + 1.
 *
 * The paper counted back-edges against low-link values for this. The
 * cyclomatic number is the same count for a strongly connected component,
 * exact under parallel edges and self-loops, and needs no change to Tarjan.
 * One edge A→B and one B→A is one cycle; a second A→B makes two.
 */
export function cycles(nodes: number, edges: number): number {
  return edges === 0 ? 0 : edges - nodes + 1;
}

/** Nodes and edges by index, for a graph whose nodes are addresses. */
export class AddressGraph {
  readonly ids = new Map<string, number>();
  readonly names: string[] = [];
  readonly edges: { from: number; to: number; ref: number | null; flow: boolean }[] = [];

  node(address: string): number {
    let id = this.ids.get(address);
    if (id === undefined) {
      id = this.names.length;
      this.ids.set(address, id);
      this.names.push(address);
    }
    return id;
  }

  edge(from: string, to: string, ref: number | null, flow: boolean): void {
    this.edges.push({ from: this.node(from), to: this.node(to), ref, flow });
  }

  /**
   * Every component that holds at least one cycle, with the edges inside it.
   * A singleton with no self-loop is not one.
   */
  components(): { nodes: number[]; edges: number[]; cycles: number }[] {
    const adjacent: number[][] = this.names.map(() => []);
    for (const e of this.edges) adjacent[e.from]!.push(e.to);
    const member = new Int32Array(this.names.length);
    const found = tarjan(adjacent);
    found.forEach((c, k) => { for (const v of c) member[v] = k; });
    const inside: number[][] = found.map(() => []);
    this.edges.forEach((e, k) => { if (member[e.from] === member[e.to]) inside[member[e.from]!]!.push(k); });
    return found
      .map((nodes, k) => ({ nodes, edges: inside[k]!, cycles: cycles(nodes.length, inside[k]!.length) }))
      .filter((c) => c.cycles > 0);
  }
}
