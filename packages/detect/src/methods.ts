import { AddressGraph, tokenGraph, type Hop } from './graph.js';
import type { Payments } from './payments.js';
import type { Analysis, Flag, Method, MethodTotals, Transfer, Witness } from './types.js';

/**
 * The numbers the methods turn on. Each is data, with the sentence that
 * justifies it, so a reader can disagree with one without reading the code.
 */
export const RULES = {
  /**
   * Paper §4.3: an SCC needs at least two cycles to be a wash trade. One
   * cycle is a token sold and bought back once, which honest collectors do;
   * two is a pattern.
   */
  minCycles: 2,
  /**
   * Paper §4.4, SCC AU: a branch of ETH transfers alone is cut at depth 30.
   * Money laundered through thirty wallets is past what one trader masks.
   */
  reachDepth: 30,
  /**
   * Not in the paper. A wallet joined to more than this many of the
   * collection's wallets by money is an exchange, a bridge or a router, and
   * as the middle of a path it would join every customer to every other.
   * It stays a wallet in its own right; it only stops being a middle.
   */
  hubDegree: 20,
  /** A reach search stops after this many wallets, and is counted as truncated. */
  visitCap: 20_000,
} as const;

export type Rules = { readonly [K in keyof typeof RULES]: number };

export interface Input {
  transfers: readonly Transfer[];
  /**
   * Payments touching the collection's wallets, from the funding source:
   * already filtered (see Payments.from), and held as numbers, not as Flows.
   */
  payments: Payments;
  /** False when no funding source is configured: AU and AC report themselves unavailable. */
  fundingAvailable: boolean;
  /** Wallets whose funding was read. */
  funded: ReadonlySet<string>;
  /** Wallets with more history than the funding source would page through. Never a middle. */
  truncated: ReadonlySet<string>;
  /** Addresses that hold tokens without owning them. See tokenGraph. */
  custodians: ReadonlySet<string>;
  /** Contracts never treated as a middle: marketplaces, wrapped-ETH contracts, conduits. */
  contracts: ReadonlySet<string>;
  /** Currencies whose amounts are summed as volume: '' for native, and its wrappers. */
  money: ReadonlySet<string>;
  rules?: Partial<Rules>;
}

export function analyze(input: Input): Analysis {
  const rules: Rules = { ...RULES, ...input.rules };
  const { transfers } = input;

  // Chain order, and a total one: the store keys a transfer by its tx and
  // log, so no two tie. The store returns rows in no set order, and the
  // tokens, their hops and so the flags must come out the same whatever it was.
  const order = transfers.map((_, i) => i).sort((i, j) => {
    const x = transfers[i]!, y = transfers[j]!;
    return x.blockNumber - y.blockNumber || x.logIndex - y.logIndex || compare(x.txHash, y.txHash);
  });
  const byToken = new Map<string, number[]>();
  for (const i of order) {
    const list = byToken.get(transfers[i]!.tokenId);
    if (list) list.push(i);
    else byToken.set(transfers[i]!.tokenId, [i]);
  }
  const tokens = [...byToken.entries()].map(([tokenId, idx]) => ({ tokenId, graph: tokenGraph(transfers, idx, input.custodians) }));

  const wallets = new Set<string>();
  for (const { graph } of tokens) for (const h of graph.hops) { wallets.add(h.from); wallets.add(h.to); }

  const money = new MoneyGraph(input, wallets, rules);
  const flagged: Record<Method, Map<number, Witness>> = { A: new Map(), AU: new Map(), AC: new Map() };

  let moves = 0;
  let gaps = 0;
  for (const { graph } of tokens) {
    moves += graph.moves;
    gaps += graph.gaps;
    const real = graph.hops.filter((h) => h.ref !== null);
    if (real.length === 0) continue;

    for (const [ref, w] of sccFlags(graph.hops, [], rules.minCycles)) {
      flagged.A.set(ref, w);
      flagged.AU.set(ref, w);
      flagged.AC.set(ref, w);
    }
    // One sale can still be a wash trade when money closes it: Figure 8's cycle 1.
    if (!input.fundingAvailable) continue;

    const holders = new Set<string>();
    for (const h of graph.hops) { holders.add(h.from); holders.add(h.to); }
    const via: [string, string][] = [];
    for (const u of holders) for (const v of money.reach(u)) if (v !== u && holders.has(v)) via.push([u, v]);
    for (const [ref, w] of sccFlags(graph.hops, via, rules.minCycles)) if (!flagged.AU.has(ref)) flagged.AU.set(ref, w);

    for (const h of real) {
      if (h.from === h.to || flagged.AC.has(h.ref!)) continue;
      const link = money.link(h.from, h.to);
      if (link) flagged.AC.set(h.ref!, { kind: 'pair', pair: [h.from, h.to], middle: link.middle, flowTx: link.tx });
    }
  }

  const flags: Flag[] = [];
  const totals = {} as Record<Method, MethodTotals>;
  const moved = tokens.flatMap(({ graph }) => graph.hops.flatMap((h) => (h.ref === null ? [] : [h.ref])));
  for (const method of ['A', 'AU', 'AC'] as const) {
    const available = method === 'A' || input.fundingAvailable;
    for (const [ref, witness] of flagged[method]) {
      flags.push({ txHash: transfers[ref]!.txHash, logIndex: transfers[ref]!.logIndex, method, witness });
    }
    totals[method] = sum(transfers, moved, flagged[method], input.money, available);
  }

  return {
    totals,
    flags,
    missingData: moves + gaps === 0 ? 0 : gaps / (moves + gaps),
    fundedWallets: [...wallets].filter((w) => input.funded.has(w)).length,
    wallets: wallets.size,
    truncatedSearches: money.truncatedSearches,
  };
}

/**
 * Every observed hop inside a flagged component, with why.
 *
 * Asset hops alone (`via` empty) is SCC A. With `via`, the money edges that
 * join the token's holders, it is SCC AU: one combined graph, so a component
 * can be closed by money. A component closed by money is flagged on one
 * cycle: buying a token and paying the seller back is a wash trade the first
 * time. A component of asset hops alone still needs `minCycles`, so AU
 * flags everything A does.
 */
function sccFlags(hops: readonly Hop[], via: readonly [string, string][], minCycles: number): Map<number, Witness> {
  const g = new AddressGraph();
  for (const h of hops) g.edge(h.from, h.to, h.ref, false);
  for (const [u, v] of via) g.edge(u, v, null, true);
  const out = new Map<number, Witness>();
  for (const c of g.components()) {
    const edges = c.edges.map((k) => g.edges[k]!);
    const closedByMoney = edges.some((e) => e.flow);
    if (!edges.some((e) => e.ref !== null)) continue;
    if (c.cycles < minCycles && !closedByMoney) continue;
    const walletsIn = c.nodes.map((n) => g.names[n]!);
    const witness: Witness = closedByMoney
      ? { kind: 'scc+flow', wallets: walletsIn, cycles: c.cycles,
          via: edges.filter((e) => e.flow).map((e) => [g.names[e.from]!, g.names[e.to]!]) }
      : { kind: 'scc', wallets: walletsIn, cycles: c.cycles };
    for (const e of edges) if (e.ref !== null) out.set(e.ref, witness);
  }
  return out;
}

/**
 * The user transaction graph, built once per analysis and read per token.
 * A class because every question it answers needs the same indexes.
 *
 * Its answers never depend on the order of the payments. The store returns
 * them in no set order, and a search cut short at visitCap (22% of
 * Terraforms') reaches whichever wallets it meets first: so each wallet's
 * payees are searched by address, a pair keeps its smallest tx, and a link
 * names its smallest middle.
 *
 * Wallets are numbered here in address order, so "by address" is "by
 * number", and each wallet's neighbours are a run of one sorted typed array:
 * wallet v's are `near[nearStart[v]]` up to `near[nearStart[v + 1]]`. As
 * maps of maps keyed by address, Terraforms' graph took 1.1 GB on top of its
 * flows, and the analysis ran out of heap.
 */
class MoneyGraph {
  /** By number: each wallet's address. */
  private readonly names: string[];
  /** The Payments number of a wallet → its number here. */
  private readonly rank: Int32Array;
  /** Undirected, by number: each wallet's neighbours, ascending. */
  private readonly nearStart: Int32Array;
  private readonly near: Int32Array;
  /** Beside `near`: the payment with the smallest hash of those that join the two, either way. */
  private readonly nearTx: Int32Array;
  /** Directed, by number: the wallets each sent money to, ascending, so by address. */
  private readonly outStart: Int32Array;
  private readonly out: Int32Array;
  /** By number: 1 for a hub, and 1 for one of the collection's wallets. */
  private readonly hub: Uint8Array;
  private readonly member: Uint8Array;
  /**
   * By number: the search that last saw it, so a search starts without
   * clearing anything. Terraforms' 11,072 wallets are each searched up to
   * 20,000 wallets deep; by address, with a Set per search, that was 29 s of
   * the analysis's 39.
   */
  private readonly seen: Int32Array;
  private searches = 0;
  private readonly reached = new Map<string, Set<string>>();
  private readonly payments: Payments;
  truncatedSearches = 0;

  constructor(
    input: Input,
    wallets: ReadonlySet<string>,
    private readonly rules: Rules,
  ) {
    const { payments } = input;
    this.payments = payments;
    const { names, rank } = byAddress(payments.names);
    this.names = names;
    this.rank = rank;
    const n = names.length;
    const ends = payments.ends;
    const { start, run } = runs(ends, rank);

    // One entry per pair: of the payments that join two wallets, either
    // way, the one with the smallest hash, and whether this wallet paid.
    const nearStart = new Int32Array(n + 1);
    const near = new Int32Array(run.length);
    const nearTx = new Int32Array(run.length);
    const outStart = new Int32Array(n + 1);
    const out = new Int32Array(run.length / 2);
    let m = 0;
    let o = 0;
    for (let v = 0; v < n; v++) {
      nearStart[v] = m;
      outStart[v] = o;
      for (let i = start[v]!, end = start[v + 1]!; i < end;) {
        const y = rank[ends[run[i]! ^ 1]!]!;
        let p = run[i]! >> 1;
        let paid = (run[i]! & 1) === 0;
        for (i++; i < end && rank[ends[run[i]! ^ 1]!] === y; i++) {
          const q = run[i]! >> 1;
          if (payments.tx(q) < payments.tx(p)) p = q;
          if ((run[i]! & 1) === 0) paid = true;
        }
        near[m] = y;
        nearTx[m++] = p;
        if (paid) out[o++] = y;
      }
    }
    nearStart[n] = m;
    outStart[n] = o;
    // Copies cut to size: the buffers sized for every payment are dropped with this constructor.
    this.nearStart = nearStart;
    this.near = near.slice(0, m);
    this.nearTx = nearTx.slice(0, m);
    this.outStart = outStart;
    this.out = out.slice(0, o);

    this.member = Uint8Array.from(names, (a) => (wallets.has(a) ? 1 : 0));
    this.hub = new Uint8Array(n);
    for (let v = 0; v < n; v++) {
      if (input.contracts.has(names[v]!) || input.truncated.has(names[v]!)) { this.hub[v] = 1; continue; }
      let degree = 0;
      for (let i = nearStart[v]!; i < nearStart[v + 1]!; i++) degree += this.member[this.near[i]!]!;
      if (degree > rules.hubDegree) this.hub[v] = 1;
    }
    this.seen = new Int32Array(n);
  }

  /** The number here of the wallet at `address`, or -1 for one in no payment. */
  private id(address: string): number {
    const id = this.payments.number(address);
    return id === undefined ? -1 : this.rank[id]!;
  }

  /** Where `y` is among `v`'s neighbours, or -1. */
  private find(v: number, y: number): number {
    const { near } = this;
    let lo = this.nearStart[v]!;
    let hi = this.nearStart[v + 1]! - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = near[mid]!;
      if (at === y) return mid;
      if (at < y) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * SCC AC's question, paper §4.4: are `a` and `b` joined by money within two
   * hops, ignoring direction? Direct, or through one middle that is not a
   * hub. Figure 8's six cycles are exactly these: three directions of a
   * direct flow and the middle's four, less the two AU already finds.
   * Of several middles, the smallest address, named with the payment that
   * joins it to whichever of `a` and `b` has fewer neighbours.
   */
  link(a: string, b: string): { middle: string | null; tx: string } | null {
    const va = this.id(a);
    const vb = this.id(b);
    if (va < 0 || vb < 0) return null;
    const { near, nearStart, nearTx, hub, payments } = this;
    const direct = this.find(va, vb);
    if (direct >= 0) return { middle: null, tx: payments.tx(nearTx[direct]!) };
    const [small, large] = nearStart[va + 1]! - nearStart[va]! <= nearStart[vb + 1]! - nearStart[vb]! ? [va, vb] : [vb, va];
    // Ascending, so the first middle found is the smallest.
    for (let i = nearStart[small]!; i < nearStart[small + 1]!; i++) {
      const x = near[i]!;
      if (x === va || x === vb || hub[x] || this.find(large, x) < 0) continue;
      return { middle: this.names[x]!, tx: payments.tx(nearTx[i]!) };
    }
    return null;
  }

  /**
   * SCC AU's money edges: the collection's wallets `from` reaches by sending
   * money, through wallets that are not hubs, within `reachDepth` hops.
   * Memoised: a wallet in a thousand tokens is searched once.
   */
  reach(from: string): ReadonlySet<string> {
    const known = this.reached.get(from);
    if (known) return known;
    const found = new Set<string>();
    this.reached.set(from, found);
    const start = this.id(from);
    // A wallet in no payment sends nowhere.
    if (start < 0 || this.hub[start]) return found;
    const search = ++this.searches;
    const { seen, out, outStart, hub, member, names } = this;
    seen[start] = search;
    let visited = 1;
    let frontier = [start];
    for (let depth = 0; depth < this.rules.reachDepth && frontier.length > 0; depth++) {
      const next: number[] = [];
      for (const v of frontier) {
        for (let i = outStart[v]!, end = outStart[v + 1]!; i < end; i++) {
          const w = out[i]!;
          if (seen[w] === search) continue;
          if (visited >= this.rules.visitCap) { this.truncatedSearches += 1; return found; }
          seen[w] = search;
          visited += 1;
          if (member[w]) found.add(names[w]!);
          if (!hub[w]) next.push(w);
        }
      }
      frontier = next;
    }
    return found;
  }
}

/** Wallets numbered in address order: their addresses so, and each Payments number's new number. */
function byAddress(addresses: readonly string[]): { names: string[]; rank: Int32Array } {
  const order = new Int32Array(addresses.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((x, y) => compare(addresses[x]!, addresses[y]!));
  const rank = new Int32Array(order.length);
  for (let r = 0; r < order.length; r++) rank[order[r]!] = r;
  return { names: Array.from(order, (i) => addresses[i]!), rank };
}

/**
 * Each wallet's payments, as a run of `run` from `start[v]` to `start[v + 1]`
 * ordered by the wallet at the other end. Entry k stands for payment k >> 1
 * seen from `ends[k]`: even k from its payer, odd from its payee, so
 * `ends[k ^ 1]` is the other end. Two counting sorts, by the other end and
 * then stably by this one, order every run at once with no comparisons, and
 * the first's buffer is dropped on return.
 */
function runs(ends: Int32Array, rank: Int32Array): { start: Int32Array; run: Int32Array } {
  const n = rank.length;
  // Each payment is one entry at each end whichever end is counted, so one count serves both sorts.
  const start = new Int32Array(n + 1);
  for (let k = 0; k < ends.length; k++) start[rank[ends[k]!]! + 1]! += 1;
  for (let v = 0; v < n; v++) start[v + 1]! += start[v]!;
  const fill = start.slice(0, n);
  const byOther = new Int32Array(ends.length);
  for (let k = 0; k < ends.length; k++) byOther[fill[rank[ends[k ^ 1]!]!]!++] = k;
  fill.set(start.subarray(0, n));
  const run = new Int32Array(ends.length);
  for (const k of byOther) run[fill[rank[ends[k]!]!]!++] = k;
  return { start, run };
}

/** Code-unit order: a total order on addresses and hashes, and unlike localeCompare, fast. */
function compare(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

function sum(
  transfers: readonly Transfer[],
  moved: readonly number[],
  flagged: ReadonlyMap<number, Witness>,
  money: ReadonlySet<string>,
  available: boolean,
): MethodTotals {
  let sales = 0;
  let flaggedSales = 0;
  let volume = 0n;
  let flaggedVolume = 0n;
  const walletsFlagged = new Set<string>();
  const tokensFlagged = new Set<string>();
  for (const ref of moved) {
    const t = transfers[ref]!;
    const hit = available && flagged.has(ref);
    if (hit) { walletsFlagged.add(t.from); walletsFlagged.add(t.to); tokensFlagged.add(t.tokenId); }
    if (t.marketplace === null) continue;
    sales += 1;
    if (hit) flaggedSales += 1;
    if (t.priceWei === null || t.currency === null || !money.has(t.currency)) continue;
    const price = BigInt(t.priceWei);
    volume += price;
    if (hit) flaggedVolume += price;
  }
  return {
    transfers: moved.length,
    flagged: available ? flagged.size : 0,
    sales,
    flaggedSales,
    volumeWei: volume.toString(),
    flaggedVolumeWei: flaggedVolume.toString(),
    wallets: walletsFlagged.size,
    tokens: tokensFlagged.size,
    available,
  };
}
