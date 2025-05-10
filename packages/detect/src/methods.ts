import { AddressGraph, ZERO, tokenGraph, type Hop } from './graph.js';
import type { Analysis, Flag, Flow, Method, MethodTotals, Transfer, Witness } from './types.js';

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
  /** Money flows touching the collection's wallets, from the funding source. */
  flows: readonly Flow[];
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

  const byToken = new Map<string, number[]>();
  transfers.forEach((t, i) => {
    const list = byToken.get(t.tokenId);
    if (list) list.push(i);
    else byToken.set(t.tokenId, [i]);
  });
  const tokens = [...byToken.entries()].map(([tokenId, idx]) => {
    idx.sort((a, b) => transfers[a]!.blockNumber - transfers[b]!.blockNumber || transfers[a]!.logIndex - transfers[b]!.logIndex);
    return { tokenId, graph: tokenGraph(transfers, idx, input.custodians) };
  });

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
 * A class because every question it answers needs the same four indexes.
 */
class MoneyGraph {
  /** Undirected: wallet → neighbour → one transaction that joins them. */
  private readonly near = new Map<string, Map<string, string>>();
  /** Directed: wallet → the wallets it sent money to. */
  private readonly out = new Map<string, Set<string>>();
  private readonly hubs = new Set<string>();
  private readonly reached = new Map<string, Set<string>>();
  truncatedSearches = 0;

  constructor(
    input: Input,
    private readonly wallets: ReadonlySet<string>,
    private readonly rules: Rules,
  ) {
    // The payment leg of a sale is a flow from buyer to seller in the same
    // transaction as the transfer: with a WETH bid it is a direct transfer
    // between the two. Left in, every honest bid sale would close its own
    // cycle. The 2023 data never showed this because it read ETH only, and
    // Seaport routes ETH through itself; WETH, Blur Pool and every ERC-20
    // payment do not.
    const sales = new Set(input.transfers.map((t) => t.txHash));
    for (const f of input.flows) {
      if (sales.has(f.txHash) || f.from === f.to || f.valueWei === '0') continue;
      if (f.from === ZERO || f.to === ZERO) continue;
      this.join(f.from, f.to, f.txHash);
      this.join(f.to, f.from, f.txHash);
      let sent = this.out.get(f.from);
      if (!sent) this.out.set(f.from, (sent = new Set()));
      sent.add(f.to);
    }
    for (const c of input.contracts) this.hubs.add(c);
    for (const t of input.truncated) this.hubs.add(t);
    for (const [x, around] of this.near) {
      let degree = 0;
      for (const y of around.keys()) if (wallets.has(y)) degree += 1;
      if (degree > rules.hubDegree) this.hubs.add(x);
    }
  }

  private join(a: string, b: string, tx: string): void {
    let m = this.near.get(a);
    if (!m) this.near.set(a, (m = new Map()));
    if (!m.has(b)) m.set(b, tx);
  }

  /**
   * SCC AC's question, paper §4.4: are `a` and `b` joined by money within two
   * hops, ignoring direction? Direct, or through one middle that is not a
   * hub. Figure 8's six cycles are exactly these: three directions of a
   * direct flow and the middle's four, less the two AU already finds.
   */
  link(a: string, b: string): { middle: string | null; tx: string } | null {
    const na = this.near.get(a);
    const nb = this.near.get(b);
    if (!na || !nb) return null;
    const direct = na.get(b);
    if (direct !== undefined) return { middle: null, tx: direct };
    const [small, large] = na.size <= nb.size ? [na, nb] : [nb, na];
    for (const [x, tx] of small) {
      if (x === a || x === b || this.hubs.has(x)) continue;
      if (large.has(x)) return { middle: x, tx };
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
    if (this.hubs.has(from)) return found;
    const seen = new Set([from]);
    let frontier = [from];
    for (let depth = 0; depth < this.rules.reachDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const v of frontier) {
        for (const w of this.out.get(v) ?? []) {
          if (seen.has(w)) continue;
          if (seen.size >= this.rules.visitCap) { this.truncatedSearches += 1; return found; }
          seen.add(w);
          if (this.wallets.has(w)) found.add(w);
          if (!this.hubs.has(w)) next.push(w);
        }
      }
      frontier = next;
    }
    return found;
  }
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
