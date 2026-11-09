import { AddressGraph, chainOrder, tokenGraph } from './graph.js';
import { EDGE_TYPES, type EdgeKind, type LensRule } from './lens-rule.js';
import { methodTotals } from './methods.js';
import { MOVE_KIND, adjacency, type Moves } from './moves.js';
import type { LensFlag, LensInput, LensTotals, LoopEdge } from './store.js';

/**
 * The most edges one trade's search may read, every edge it examines
 * counted. A dense money graph has more simple paths of six
 * wallets than any run could walk; a search stopped here is counted in
 * `totals.truncated`, so the share reads "at least", and the trade is never
 * called clean for it.
 */
export const SEARCH_CAP = 5000;

/** A found loop's money edge, by where it sits in `flags`, with what `Store.moveTxs` finds its hash by. */
export interface MoneyEdge { flag: number; edge: number; from: string; to: string; kind: EdgeKind; block: number }

const DAY = 86_400;
const KINDS: readonly EdgeKind[] = EDGE_TYPES.map((e) => e.kind);
const TOKEN = KINDS.indexOf('nft-token');
const COLLECTION = KINDS.indexOf('nft-collection');
/** The money kinds by their `MOVE_KIND` byte: both other-token bytes are the one row. */
const MONEY: readonly EdgeKind[] = ['eth', 'internal', 'weth', 'other-tokens', 'other-tokens'];
const MONEY_AT = MONEY.map((k) => KINDS.indexOf(k));
const NONE: readonly number[] = [];
/** The funding edge `accept` and `record` get for a loop closed at the seller: there is no funder, so no edge. */
const SELLER = -1;

/**
 * Judges every trade of a collection by the owner's own rule: is there a way
 * back from the buyer to the seller, over the edges the rule follows, that
 * closes the trade into a loop? The first loop that passes is kept, as the
 * flag's path. A money edge's hash is not held here; `moneyEdges` says which
 * to look up with `Store.moveTxs`.
 *
 * `only`, Preview's sample, holds `${txHash}:${logIndex}` keys: a trade
 * outside it is not judged, and the totals count only those judged. Every
 * other transfer still makes the token graph, so a sampled trade's loop is
 * found through the same hops as in a full run.
 */
export function runLens(
  rule: LensRule, input: LensInput, onProgress?: (share: number) => void, only?: ReadonlySet<string>,
): { totals: LensTotals; flags: LensFlag[]; moneyEdges: MoneyEdge[]; judged: number; hops: number } {
  return new LensSearch(rule, input).run(onProgress, only);
}

/** The positions in `into`, a wallet's incoming edges by time, whose payments may fund a trade at `at`: [from, past]. */
function fundingSpan(into: Int32Array, at: number, w: LensRule['window'], moves: Moves): [number, number] {
  // An untimed trade (NaN) has no "before", and an after-only window no before side.
  if (Number.isNaN(at) || w?.side === 'after') return [0, 0];
  return [w ? firstAt(into, moves.time, at - w.days * DAY) : 0, firstAt(into, moves.time, at)];
}

/** The first position in `edges`, ascending by time, whose time is at least `t`. */
function firstAt(edges: Int32Array, time: Uint32Array, t: number): number {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (time[edges[mid]!]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The rule's money rows by `MOVE_KIND` byte, and whether one edge passes them. */
function moneyRows(rule: LensRule) {
  const on = MONEY.map((k) => rule.edges[k].use);
  // A token edge whose receiver washtrace cannot judge is walked along its arrow only.
  const either = MONEY.map((k, b) => b !== MOVE_KIND.otherOneWay && rule.edges[k].direction === 'either');
  // SQL already dropped what is under each floor, exactly; this float check is
  // the engine's own, so the tolerance only keeps it from dropping an edge at the
  // floor, which Moves holds as a 32-bit float (within 6e-8 of it).
  const minEth = MONEY.map((k) => {
    const wei = rule.edges[k].minWei;
    return wei === null ? -Infinity : (Number(wei) / 1e18) * (1 - 1e-6);
  });
  return {
    on, either, any: on.some(Boolean), anyEither: on.some((o, k) => o && either[k]),
    // Money paid in any of this collection's transactions is an NFT's price, as the built-ins read it,
    // not a way back: else a buyer whose offers a seller took twice would close each sale with the other's payment.
    followable: (e: number, moves: Moves): boolean => {
      const k = moves.kind[e]!;
      return on[k]! && moves.amountEth[e]! >= minEth[k]! && moves.sale[e] === 0;
    },
  };
}

/**
 * One lens run. A class because every trade's search reads the same indexes
 * (the hops of every token, the money, each wallet's number and whether it
 * may be a middle) and grows the same path.
 *
 * Wallets are numbered as `Moves` numbers them, then the NFT-only ones after,
 * so a money edge's ends need no lookup. Hops are numbered across all tokens
 * in the order `analyze` builds them.
 */
class LensSearch {
  private readonly transfers: LensInput['transfers'];
  private readonly moves: Moves;
  private readonly money: ReturnType<typeof moneyRows>;
  private readonly maxOf: (number | null)[];
  private readonly once: boolean[];
  private readonly loopOrder: boolean;

  /** Wallets past the money's, by number less `moves.wallets`. */
  private readonly extraNames: string[] = [];
  private readonly tokens: { tokenId: string; start: number; end: number }[] = [];
  private readonly hopFrom: Int32Array;
  private readonly hopTo: Int32Array;
  /** The transfer a hop stands for, or -1 for a bridge. */
  private readonly hopRef: Int32Array;
  private readonly hopToken: Int32Array;
  /** Seconds, or NaN for a bridge or an untimed transfer: no window or loop order passes it. */
  private readonly hopTime: Float64Array;
  /** A hop's index in `tradeTxs`, or -1. */
  private readonly hopTx: Int32Array;
  /** Every token's hops by wallet, for "other tokens in this collection": [starts, hops]. */
  private readonly colOut: [Int32Array, Int32Array] | null = null;
  private readonly colIn: [Int32Array, Int32Array] | null = null;
  /** 1 for a wallet `never` keeps from being a middle. */
  private readonly barred: Uint8Array;
  private readonly onPath: Uint8Array;

  // The token being judged: its hops by wallet, and its components when asked.
  private token = -1;
  private tokOutOf: Map<number, number[]> | null = null;
  private tokInOf: Map<number, number[]> | null = null;
  private tokComps: { comp: Map<number, number>; cycles: number[] } | null = null;

  // The trade being judged, and the way back grown so far.
  private tradeHop = -1;
  private seller = -1;
  private buyer = -1;
  private at = NaN;
  private tradeTx = -1;
  /** By wallet: the funder's last payment to this trade's seller, or -1; `funders` lists the wallets set, to clear. */
  private readonly fundingEdgeOf: Int32Array;
  private readonly funders: number[] = [];
  private readonly stepKind: number[] = [];
  private readonly stepId: number[] = [];
  private readonly stepTo: number[] = [];
  private readonly stepRev: boolean[] = [];
  private readonly used: Int32Array;
  private states = 0;
  private capped = false;
  private found = false;

  private readonly flags: LensFlag[] = [];
  private readonly flagged = new Map<number, LensFlag>();
  private readonly moneyEdges: MoneyEdge[] = [];
  private truncated = 0;
  private untimed = 0;

  constructor(
    private readonly rule: LensRule,
    private readonly input: LensInput,
  ) {
    const { transfers, moves } = input;
    this.transfers = transfers;
    this.moves = moves;
    this.money = moneyRows(rule);
    this.maxOf = KINDS.map((k) => rule.edges[k].max);
    this.once = KINDS.map((k) => rule.edges[k].repeats === 'once');
    this.loopOrder = rule.order === 'loop';
    this.used = new Int32Array(KINDS.length);

    const M = moves.wallets;
    const extra = new Map<string, number>();
    const id = (address: string): number => {
      const known = moves.id(address) ?? extra.get(address);
      if (known !== undefined) return known;
      extra.set(address, M + this.extraNames.length);
      return M + this.extraNames.push(address) - 1;
    };

    // Chain order and tokens exactly as analyze takes them, so Round trips' copy sees the same hops.
    const order = chainOrder(transfers);
    const byToken = new Map<string, number[]>();
    for (const i of order) {
      const list = byToken.get(transfers[i]!.tokenId);
      if (list) list.push(i);
      else byToken.set(transfers[i]!.tokenId, [i]);
    }
    const from: number[] = [], to: number[] = [], ref: number[] = [], tok: number[] = [];
    for (const [tokenId, idx] of byToken) {
      const start = from.length;
      for (const h of tokenGraph(transfers, idx, input.custodians).hops) {
        from.push(id(h.from));
        to.push(id(h.to));
        ref.push(h.ref ?? -1);
        tok.push(this.tokens.length);
      }
      this.tokens.push({ tokenId, start, end: from.length });
    }
    const N = M + this.extraNames.length;

    const txAt = new Map<string, number>();
    input.tradeTxs.forEach((tx, i) => txAt.set(tx, i));
    this.hopFrom = Int32Array.from(from);
    this.hopTo = Int32Array.from(to);
    this.hopRef = Int32Array.from(ref);
    this.hopToken = Int32Array.from(tok);
    this.hopTime = Float64Array.from(ref, (r) => (r < 0 ? NaN : transfers[r]!.blockTime ?? NaN));
    this.hopTx = Int32Array.from(ref, (r) => (r < 0 ? -1 : txAt.get(transfers[r]!.txHash) ?? -1));
    if (rule.edges['nft-collection'].use) {
      this.colOut = adjacency(this.hopFrom, N);
      this.colIn = adjacency(this.hopTo, N);
    }

    const { never } = rule;
    this.barred = new Uint8Array(N);
    // By the few addresses named, not by every wallet's name: Moves keeps no string per wallet. A
    // wallet whose funding history was cut short is a go-between to a money lens, as to the built-ins.
    // One whose token list was cut short is not a sender washtrace can judge: its own token edges are never loaded, which is all it
    // could not be judged on, and barring it would lose an ETH loop through it.
    const named = [...(never.marketplaces ? input.contracts : []), ...never.addresses, ...(this.money.any ? input.truncated : [])];
    for (const address of named) {
      const v = moves.id(address) ?? extra.get(address);
      if (v !== undefined) this.barred[v] = 1;
    }
    if (never.over !== null) this.barHubs(never.over, N);
    this.onPath = new Uint8Array(N);
    this.fundingEdgeOf = new Int32Array(N).fill(-1);
  }

  /**
   * Bars each wallet linked by money to more than `over` of this
   * collection's wallets (the ends of its hops), counted as the built-ins'
   * hubDegree counts them: distinct wallets, either way, and no money paid in
   * one of the collection's own transactions. An exchange's hot
   * wallet is never followed, so only its payments to this collection's
   * wallets are loaded; counting those payments missed it on all but the
   * biggest collections, and two of its customers' sale read as a loop. One
   * pass over each wallet's edges, stamped by wallet instead of cleared.
   */
  private barHubs(over: number, wallets: number): void {
    const { moves, hopFrom, hopTo, barred } = this;
    const member = new Uint8Array(wallets);
    for (let h = 0; h < hopFrom.length; h++) member[hopFrom[h]!] = member[hopTo[h]!] = 1;
    const seen = new Int32Array(moves.wallets).fill(-1);
    for (let v = 0; v < moves.wallets; v++) {
      let linked = 0;
      for (const e of moves.out(v)) {
        const u = moves.to[e]!;
        if (moves.sale[e] === 0 && member[u] && seen[u] !== v) { seen[u] = v; linked += 1; }
      }
      for (const e of moves.into(v)) {
        const u = moves.from[e]!;
        if (moves.sale[e] === 0 && member[u] && seen[u] !== v) { seen[u] = v; linked += 1; }
      }
      if (linked > over) barred[v] = 1;
    }
  }

  run(onProgress?: (share: number) => void, only?: ReadonlySet<string>): { totals: LensTotals; flags: LensFlag[]; moneyEdges: MoneyEdge[]; judged: number; hops: number } {
    const sampled = (r: number) => only === undefined || only.has(`${this.transfers[r]!.txHash}:${this.transfers[r]!.logIndex}`);
    const judges = (r: number) => this.rule.judges === 'owners' || this.transfers[r]!.marketplace !== null;
    let salesWithHop = 0;
    for (const r of this.hopRef) if (r >= 0 && sampled(r) && judges(r)) salesWithHop += 1;
    const moved: number[] = [];
    let done = 0;
    let shown = 0;
    for (let t = 0; t < this.tokens.length; t++) {
      this.enter(t);
      const { start, end } = this.tokens[t]!;
      for (let h = start; h < end; h++) {
        const r = this.hopRef[h]!;
        if (r < 0 || !sampled(r)) continue;
        moved.push(r);
        if (!judges(r)) continue;
        this.judge(h, r);
        const share = Math.floor((++done * 100) / salesWithHop);
        if (share > shown) {
          shown = share;
          onProgress?.(share / 100);
        }
      }
    }
    if (shown < 100) onProgress?.(1);
    const totals = { ...methodTotals(this.transfers, moved, this.flagged, this.input.money, true), truncated: this.truncated, untimed: this.untimed };
    // `judged` leaves out an untimed trade; `hops` keeps it.
    return { totals, flags: this.flags, moneyEdges: this.moneyEdges, judged: salesWithHop - this.untimed, hops: salesWithHop };
  }

  private name(v: number): string {
    const M = this.moves.wallets;
    return v < M ? this.moves.name(v) : this.extraNames[v - M]!;
  }

  private enter(token: number): void {
    this.token = token;
    this.tokOutOf = this.tokInOf = null;
    this.tokComps = null;
  }

  /** The current token's hops leaving `u`, built on first use. */
  private tokOut(u: number): readonly number[] {
    if (!this.tokOutOf) this.indexToken();
    return this.tokOutOf!.get(u) ?? NONE;
  }

  private tokIn(u: number): readonly number[] {
    if (!this.tokInOf) this.indexToken();
    return this.tokInOf!.get(u) ?? NONE;
  }

  private indexToken(): void {
    const out = new Map<number, number[]>();
    const into = new Map<number, number[]>();
    const { start, end } = this.tokens[this.token]!;
    for (let h = start; h < end; h++) {
      const f = this.hopFrom[h]!, t = this.hopTo[h]!;
      (out.get(f) ?? out.set(f, []).get(f)!).push(h);
      (into.get(t) ?? into.set(t, []).get(t)!).push(h);
    }
    this.tokOutOf = out;
    this.tokInOf = into;
  }

  private judge(h: number, r: number): void {
    const t = this.transfers[r]!;
    // A window or loop order is measured from the trade, which an untimed one cannot give.
    if (t.blockTime === null && (this.rule.window !== null || this.loopOrder)) {
      this.untimed += 1;
      return;
    }
    this.tradeHop = h;
    this.seller = this.hopFrom[h]!;
    this.buyer = this.hopTo[h]!;
    this.at = t.blockTime ?? NaN;
    this.tradeTx = this.hopTx[h]!;
    this.states = 0;
    this.capped = this.found = false;
    this.clear();

    // A wallet selling to itself is a loop already, with no way back to find.
    if (this.seller === this.buyer) {
      if (this.rule.hops.min === 0) this.accept(SELLER);
      return;
    }
    if (this.rule.hops.max === null) {
      this.searchAnyLength();
      return;
    }
    if (this.rule.closes === 'seller-or-funder' && this.money.any) this.collectFunders();
    // The buyer is checked as a funder first, at k = 0, as `arrive` checks every other wallet. It reads
    // the rule literally: closes 'seller' already closes on a buyer's payment to the seller outside a sale.
    // `never` does not hold it: the buyer is never checked against it.
    const own = this.fundingEdgeOf[this.buyer]!;
    if (!(own >= 0 && this.rule.hops.min === 0 && this.accept(own))) {
      this.onPath[this.buyer] = 1;
      this.walk(this.buyer, this.at, 0);
      this.onPath[this.buyer] = 0;
    }
    for (const v of this.funders) this.fundingEdgeOf[v] = -1;
    this.funders.length = 0;
    if (!this.found && this.capped) this.truncated += 1;
  }

  /**
   * The wallets that funded this trade's seller, into `fundingEdgeOf`, each
   * keeping its last payment. A funder sent the seller money over a money row
   * the rule has on, strictly before the trade, within the window's before
   * side when the rule has a window (an "after" window leaves none), and never
   * in a transaction of this collection's transfers: a sale's
   * payment legs, such as Seaport's internal ETH to the seller, are an NFT's
   * price, and reading them as funding would catch every honest sale. The
   * search then holds a funder to `never` as it holds a middle.
   */
  private collectFunders(): void {
    const { moves } = this;
    const into = moves.into(this.seller);
    const [lo, hi] = fundingSpan(into, this.at, this.rule.window, moves);
    for (let i = lo; i < hi; i++) {
      const e = into[i]!;
      if (!this.money.followable(e, moves)) continue;
      const v = moves.from[e]!;
      if (this.fundingEdgeOf[v]! < 0) this.funders.push(v);
      this.fundingEdgeOf[v] = e;
    }
  }

  /** One more edge read, and true once that is past the cap (every edge read counts, so no wide middle runs on). */
  private spend(): boolean {
    if (++this.states <= SEARCH_CAP) return false;
    this.capped = true;
    return true;
  }

  /**
   * A depth-first search of the simple paths from the buyer, `k` edges grown,
   * the last at time `prev`. True once it should stop: a loop was kept, or the
   * cap was reached.
   */
  private walk(u: number, prev: number, k: number): boolean {
    const { edges } = this.rule;
    const { hopFrom, hopTo, hopTime } = this;
    if (edges['nft-token'].use) {
      for (const h of this.tokOut(u)) {
        if (this.spend() || (h !== this.tradeHop && this.step(TOKEN, h, false, hopTo[h]!, hopTime[h]!, prev, k))) return true;
      }
      if (edges['nft-token'].direction === 'either') {
        for (const h of this.tokIn(u)) {
          if (this.spend() || (h !== this.tradeHop && this.step(TOKEN, h, true, hopFrom[h]!, hopTime[h]!, prev, k))) return true;
        }
      }
    }
    const { colOut, colIn } = this;
    if (colOut && colIn) {
      const either = edges['nft-collection'].direction === 'either';
      for (const rev of either ? [false, true] : [false]) {
        const [start, list] = rev ? colIn : colOut;
        for (let i = start[u]!, end = start[u + 1]!; i < end; i++) {
          const h: number = list[i]!;
          if (this.spend()) return true;
          // Another token's hop, and not one of the trade's own: a bundle's other tokens went the same way as this one.
          if (this.hopToken[h] === this.token || (this.tradeTx >= 0 && this.hopTx[h] === this.tradeTx)) continue;
          // Nor a priced sale. A token bought at a price is not value handed back, as a sale's payment is no way back.
          if (this.hopRef[h]! >= 0 && this.transfers[this.hopRef[h]!]!.marketplace !== null) continue;
          if (this.step(COLLECTION, h, rev, rev ? hopFrom[h]! : hopTo[h]!, hopTime[h]!, prev, k)) return true;
        }
      }
    }
    if (this.money.any) {
      const { moves, money } = this;
      for (const e of moves.out(u)) {
        if (this.spend()) return true;
        if (money.followable(e, moves) && this.step(MONEY_AT[moves.kind[e]!]!, e, false, moves.to[e]!, moves.time[e]!, prev, k)) return true;
      }
      if (money.anyEither) {
        for (const e of moves.into(u)) {
          if (this.spend()) return true;
          if (!money.either[moves.kind[e]!] || !money.followable(e, moves)) continue;
          if (this.step(MONEY_AT[moves.kind[e]!]!, e, true, moves.from[e]!, moves.time[e]!, prev, k)) return true;
        }
      }
    }
    return false;
  }

  /** One edge onto the path, if its row, the window and the order let it, and the search from there. */
  private step(kind: number, id: number, rev: boolean, v: number, time: number, prev: number, k: number): boolean {
    if (this.onPath[v]) return false;
    // Past here only the seller closes: a wallet at k + 1 would be one middle too many.
    if (v !== this.seller && k + 1 > this.rule.hops.max!) return false;
    const max = this.maxOf[kind]!;
    if (max !== null && this.used[kind]! >= max) return false;
    if (!this.inWindow(time) || (this.loopOrder && !(time >= prev))) return false;
    this.push(kind, id, rev, v);
    const stop = this.arrive(v, time, k + 1);
    this.pop(kind);
    return stop;
  }

  /** At `v` after `k` edges back: close at the seller or a funder, or go on through `v` as a middle. */
  private arrive(v: number, time: number, k: number): boolean {
    const { min, max } = this.rule.hops;
    // The middles are the wallets after the buyer, so closing at the seller passed k - 1, and at a funder k.
    if (v === this.seller) return k - 1 >= min && this.accept(SELLER);
    // `never` holds for a funder as for a middle, else Seaport or an exchange that once paid the seller closes every sale.
    if (this.barred[v]) return false;
    const fundingEdge = this.fundingEdgeOf[v]!;
    if (fundingEdge >= 0 && k >= min && k <= max! && this.accept(fundingEdge)) return true;
    this.onPath[v] = 1;
    const stop = this.walk(v, time, k);
    this.onPath[v] = 0;
    return stop;
  }

  /**
   * The "any" length: only the token's own hops are on, so this is a
   * breadth-first search of the token's graph, and the way back judged is
   * the first found layer by layer, which is exact because `checkRule` keeps
   * `hops.min` at 0 here. A wallet is entered again only at an earlier time,
   * which loop order makes better; otherwise once. No cap: it is bounded by
   * the token's own hops, and Round trips' copy runs here, so it stays exact.
   */
  private searchAnyLength(): void {
    const row = this.rule.edges['nft-token'];
    // Along the arrows, a way back exists only inside one strongly connected component.
    if (row.direction === 'along') {
      const { comp } = this.components();
      const c = comp.get(this.seller);
      if (c === undefined || c !== comp.get(this.buyer)) return;
    }
    const at = [this.buyer], parent = [-1], via = [-1], rev = [false], time = [this.at];
    const best = new Map<number, number>([[this.buyer, this.loopOrder ? this.at : 0]]);
    const limit = row.max ?? Infinity;
    let frontier = [0];
    for (let depth = 1; depth <= limit && frontier.length > 0; depth++) {
      const next: number[] = [];
      for (const p of frontier) {
        for (const back of row.direction === 'either' ? [false, true] : [false]) {
          for (const h of back ? this.tokIn(at[p]!) : this.tokOut(at[p]!)) {
            if (h === this.tradeHop) continue;
            const t = this.hopTime[h]!;
            if (!this.inWindow(t) || (this.loopOrder && !(t >= time[p]!))) continue;
            const v = back ? this.hopFrom[h]! : this.hopTo[h]!;
            if (v === this.seller) {
              this.trace(at, parent, via, rev, p);
              this.push(TOKEN, h, back, v);
              if (this.accept(SELLER)) return;
              this.clear();
              continue;
            }
            if (v === this.buyer || this.barred[v]) continue;
            const arrival = this.loopOrder ? t : 0;
            const seen = best.get(v);
            if (seen !== undefined && seen <= arrival) continue;
            best.set(v, arrival);
            next.push(at.push(v) - 1);
            parent.push(p);
            via.push(h);
            rev.push(back);
            time.push(t);
          }
        }
      }
      frontier = next;
    }
  }

  /** The steps from the buyer to entry `p` of a breadth-first search, onto the path. */
  private trace(at: number[], parent: number[], via: number[], rev: boolean[], p: number): void {
    const chain: number[] = [];
    for (let q = p; parent[q]! >= 0; q = parent[q]!) chain.push(q);
    for (const q of chain.reverse()) this.push(TOKEN, via[q]!, rev[q]!, at[q]!);
  }

  /** An empty way back, with no row's edges used. */
  private clear(): void {
    this.stepKind.length = this.stepId.length = this.stepTo.length = this.stepRev.length = 0;
    this.used.fill(0);
  }

  private push(kind: number, id: number, rev: boolean, v: number): void {
    this.stepKind.push(kind);
    this.stepId.push(id);
    this.stepRev.push(rev);
    this.stepTo.push(v);
    this.used[kind]! += 1;
  }

  private pop(kind: number): void {
    this.stepKind.pop();
    this.stepId.pop();
    this.stepRev.pop();
    this.stepTo.pop();
    this.used[kind]! -= 1;
  }

  /** Within `days` of the trade on the window's side; any time without one. NaN never is. */
  private inWindow(time: number): boolean {
    const w = this.rule.window;
    if (!w) return true;
    const d = time - this.at;
    const span = w.days * DAY;
    return w.side === 'after' ? d >= 0 && d <= span : w.side === 'before' ? d <= 0 && d >= -span : Math.abs(d) <= span;
  }

  /**
   * The loop on the path (closed at the funder whose edge is `fundingEdge`, or at
   * the seller for SELLER), kept if it closes at least `rule.minCycles` loops.
   * The funding edge counts
   * against no row's `max` and is exempt from loop order: it is not a step
   * of the way back but what made F the seller's funder, and it is
   * always before the trade, where loop order (which starts at the trade)
   * could never place it.
   */
  private accept(fundingEdge: number): boolean {
    if (this.rule.minCycles > 1 && this.cyclesOf(fundingEdge) < this.rule.minCycles) return false;
    this.record(fundingEdge);
    this.found = true;
    return true;
  }

  /**
   * The cycles of the strongly connected component holding the trade, in
   * the token's own hops plus the loop's other edges, each as walked. A row
   * whose repeats are `once` adds one edge per wallet pair.
   */
  private cyclesOf(fundingEdge: number): number {
    // A way back of the token's own hops, along their arrows, adds nothing to the token's graph.
    if (fundingEdge === SELLER && this.stepKind.every((k, i) => k === TOKEN && !this.stepRev[i])) {
      const { comp, cycles } = this.components();
      const c = comp.get(this.seller);
      return c !== undefined && c === comp.get(this.buyer) ? cycles[c]! : 0;
    }
    const { g, add } = this.baseGraph();
    let u = this.buyer;
    this.stepTo.forEach((v, i) => {
      if (this.stepKind[i] !== TOKEN || this.stepRev[i]) add(this.stepKind[i]!, u, v);
      u = v;
    });
    if (fundingEdge !== SELLER) add(MONEY_AT[this.moves.kind[fundingEdge]!]!, u, this.seller);
    const s = g.ids.get(String(this.seller))!, b = g.ids.get(String(this.buyer))!;
    for (const c of g.components()) if (c.nodes.includes(s) && c.nodes.includes(b)) return c.cycles;
    return 0;
  }

  /** The current token's components with a cycle: each wallet's, and each one's cycles. */
  private components(): { comp: Map<number, number>; cycles: number[] } {
    if (!this.tokComps) {
      const { g } = this.baseGraph();
      const comp = new Map<number, number>();
      const cycles: number[] = [];
      for (const c of g.components()) {
        for (const n of c.nodes) comp.set(Number(g.names[n]), cycles.length);
        cycles.push(c.cycles);
      }
      this.tokComps = { comp, cycles };
    }
    return this.tokComps;
  }

  /** The current token's hops as a graph, bridges included, and how to add an edge of a row to it. */
  private baseGraph(): { g: AddressGraph; add: (kind: number, from: number, to: number) => void } {
    // The names in this graph are wallet numbers, as strings.
    const g = new AddressGraph();
    const pairs = new Set<string>();
    const add = (kind: number, from: number, to: number) => {
      if (this.once[kind]) {
        const key = `${kind}:${from}:${to}`;
        if (pairs.has(key)) return;
        pairs.add(key);
      }
      g.edge(String(from), String(to), null, false);
    };
    const { start, end } = this.tokens[this.token]!;
    for (let h = start; h < end; h++) add(TOKEN, this.hopFrom[h]!, this.hopTo[h]!);
    return { g, add };
  }

  /** The loop as its edges, each as it happened (one walked against its arrow reads backwards), and its wallets in loop order. */
  private record(fundingEdge: number): void {
    const flag = this.flags.length;
    const path: LoopEdge[] = [this.hopEdge(this.tradeHop, 'nft-token')];
    const wallets = [this.name(this.seller), this.name(this.buyer)];
    this.stepKind.forEach((kind, i) => {
      const id = this.stepId[i]!;
      path.push(kind === TOKEN || kind === COLLECTION ? this.hopEdge(id, KINDS[kind]!) : this.moneyEdge(id, KINDS[kind]!, flag, path.length));
      if (this.stepTo[i] !== this.seller) wallets.push(this.name(this.stepTo[i]!));
    });
    if (fundingEdge !== SELLER) path.push(this.moneyEdge(fundingEdge, 'funds', flag, path.length));
    const t = this.transfers[this.hopRef[this.tradeHop]!]!;
    const out: LensFlag = { txHash: t.txHash, logIndex: t.logIndex, path, wallets };
    this.flags.push(out);
    this.flagged.set(this.hopRef[this.tradeHop]!, out);
  }

  private hopEdge(h: number, kind: EdgeKind): LoopEdge {
    const r = this.hopRef[h]!;
    const t = r < 0 ? null : this.transfers[r]!;
    return {
      from: this.name(this.hopFrom[h]!), to: this.name(this.hopTo[h]!), kind,
      tx: t?.txHash ?? null, time: t?.blockTime ?? null, amountWei: t?.priceWei ?? null, tokenId: this.tokens[this.hopToken[h]!]!.tokenId, token: null,
    };
  }

  /**
   * A money edge of the loop, its hash, amount and token left null: the
   * engine holds none of them per edge (the amount only as a float, and an
   * other token's not at all), and `Store.moveTxs` finds them from the
   * `moneyEdges` entry this adds.
   */
  private moneyEdge(e: number, kind: EdgeKind | 'funds', flag: number, edge: number): LoopEdge {
    const { moves } = this;
    const from = moves.name(moves.from[e]!), to = moves.name(moves.to[e]!);
    this.moneyEdges.push({ flag, edge, from, to, kind: MONEY[moves.kind[e]!]!, block: moves.block[e]! });
    return { from, to, kind, tx: null, time: moves.time[e]!, amountWei: null, tokenId: null, token: null };
  }
}
