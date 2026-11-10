import { toEventSelector, type Log } from 'viem';
import type { Chain } from './chain.js';
import type { Etherscan } from './etherscan.js';
import { ZERO, chainOrder, tokenGraph } from './graph.js';
import { runLens } from './lens.js';
import { WALKED, depthNeeded, type LensRule } from './lens-rule.js';
import { CUSTODIANS, TRANSFER, contractsFor, moneyFor, tagSales } from './marketplaces.js';
import { RULES, analyze } from './methods.js';
import { MOVE_KIND, Moves } from './moves.js';
import { Payments } from './payments.js';
import type { LensFlag, LensInput, Store } from './store.js';
import type { Flow, Transfer, Witness } from './types.js';

/**
 * A spot check: one transaction judged without watching its collection. It
 * reads only what the transaction needs (its receipt, each of its tokens'
 * histories, its sellers' and buyers' money, and the wallets that could join
 * them) and runs the built-ins, or a lens of yours, on that.
 */

/** The most tokens one check reads the history of. A sweep of more is judged on these, and says "at least". */
export const SPOT_TRADES_MAX = 10;
/** The most possible middles one check reads. The rest cannot be judged, so the answer says "at least". */
export const SPOT_MIDDLES = 10;
/** The most transactions one check reads receipts of to find other sales' payments. */
export const SPOT_RECEIPTS_MAX = 200;
/** One deadline for all of a check's Etherscan reads, far inside the fund pass's stuck ceiling. */
export const SPOT_CHECK_MS = 90_000;

const TRANSFER_SINGLE = toEventSelector('event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)');
const TRANSFER_BATCH = toEventSelector('event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)');

/**
 * A spot check's answer for one transaction, and the shape the store's own
 * answer is given in too (source 'watched'), so a caller reads one shape.
 * `washTrade` is false only when every counted method ran on every trade and
 * none flagged; null when something could not be looked at.
 */
export interface SpotResult {
  washTrade: boolean | null;
  /** Every method or lens of yours that flagged a trade in the transaction. */
  methods: string[];
  /** The methods or lens that could not run: AU always, AC without money. */
  notRun: string[];
  /** Some wallets or trades could not be judged, so false would not be honest. */
  atLeast: boolean;
  /** The transaction's block was final when it was read; one that was not is never reused. */
  finalized: boolean;
  source: 'watched' | 'spot';
  transfers: (Transfer & { collection: string; flags: Record<string, Witness | Pick<LensFlag, 'path' | 'wallets'>> })[];
}

/** Why a spot check cannot run `rule`, or null: it reads neither Other tokens nor the collection's other tokens. */
export function lensRefusal(rule: LensRule): string | null {
  if (rule.edges['other-tokens'].use) return 'This lens uses Other tokens, which a spot check does not read.';
  if (rule.edges['nft-collection'].use) return 'This lens follows other tokens in the collection, which a spot check does not read.';
  return null;
}

const topicAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();

/** The ERC-721 transfers in a transaction's logs (an ERC-20 Transfer has 3 topics, not 4), each with its collection, marked as sales. */
export function receiptTrades(tx: string, blockNumber: number, logs: readonly Log[]): (Transfer & { collection: string })[] {
  const out: (Transfer & { collection: string })[] = [];
  for (const l of logs) {
    if (l.topics.length !== 4 || l.topics[0] !== TRANSFER) continue;
    out.push({
      collection: l.address.toLowerCase(), txHash: tx, logIndex: Number(l.logIndex), blockNumber, blockTime: null,
      tokenId: BigInt(l.topics[3]!).toString(), from: topicAddress(l.topics[1]!), to: topicAddress(l.topics[2]!),
      marketplace: null, priceWei: null, currency: null,
    });
  }
  const byTx = new Map([[tx, logs]]);
  for (const c of new Set(out.map((t) => t.collection))) tagSales(out.filter((t) => t.collection === c), byTx, c);
  return out;
}

/** The wallets that moved money with both `seller` and `buyer`: the possible middles of a Linked wallets path. */
export function middlesOf(flows: readonly Flow[], seller: string, buyer: string, skip: ReadonlySet<string>): string[] {
  const near = (me: string) => new Set(flows.flatMap((f) => (f.from === me ? [f.to] : f.to === me ? [f.from] : [])));
  const bySeller = near(seller);
  const byBuyer = near(buyer);
  return [...bySeller].filter((m) => byBuyer.has(m) && m !== seller && m !== buyer && m !== ZERO && !skip.has(m)).sort();
}

/** How many distinct wallets `wallet` moved money with. */
export function counterparties(flows: readonly Flow[], wallet: string): number {
  return new Set(flows.flatMap((f) => (f.from === wallet ? [f.to] : f.to === wallet ? [f.from] : []))).size;
}

/** The money edges a lens may follow among `flows`: the kind and smallest-amount filter Store.lensInput writes in SQL, in memory. */
export function spotMoves(rule: LensRule, flows: readonly Flow[], chainId: number, sales: ReadonlySet<string>): Moves {
  const wrapped = new Set([...moneyFor(chainId)].filter((m) => m !== ''));
  const atLeast = (kind: 'eth' | 'internal' | 'weth', v: bigint) => rule.edges[kind].use && v >= BigInt(rule.edges[kind].minWei ?? '0');
  const moves = new Moves();
  for (const f of flows) {
    const v = BigInt(f.valueWei);
    if (v === 0n || f.from === f.to || f.from === ZERO || f.to === ZERO) continue;
    const kind = f.kind === 'native' && atLeast('eth', v) ? MOVE_KIND.eth
      : f.kind === 'internal' && atLeast('internal', v) ? MOVE_KIND.internal
      : f.kind === 'token' && wrapped.has(f.token) && atLeast('weth', v) ? MOVE_KIND.weth
      : null;
    if (kind === null) continue;
    moves.add(f.from, f.to, kind, f.blockTime ?? 0, f.blockNumber, Number(v) / 1e18, sales.has(f.txHash));
  }
  moves.seal();
  return moves;
}

/** One trade of the checked transaction: a hop of its token's graph, custody collapsed. */
interface Trade { collection: string; ref: number; seller: string; buyer: string }

/**
 * Runs one spot check. A class because the reads share the store, the chain,
 * Etherscan (null without a key: the built-ins then run Round trips alone)
 * and one deadline. Tests override the chain's, Etherscan's and the store's
 * methods on their instances.
 */
export class SpotCheck {
  private deadline = 0;
  private readonly starts = new Map<string, number>();

  constructor(readonly store: Store, readonly chain: Chain, readonly etherscan: Etherscan | null, readonly chainId: number) {}

  /** Judge `tx`, with the built-ins or `lens`. Throws an Error whose message is the sentence a failed check shows. */
  async run(tx: string, lens: { key: string; rule: LensRule } | null): Promise<SpotResult> {
    this.deadline = Date.now() + SPOT_CHECK_MS;
    const { chainId } = this;
    const receipt = await this.chain.receipt(tx);
    if (receipt === null) throw new Error(`No such transaction on chain ${chainId}.`);
    if (receipt.reverted) throw new Error('This transaction reverted.');
    const moved = receiptTrades(tx, receipt.blockNumber, receipt.logs);
    if (moved.length === 0) {
      throw new Error(receipt.logs.some((l) => l.topics[0] === TRANSFER_SINGLE || l.topics[0] === TRANSFER_BATCH)
        ? 'This transaction moved only ERC-1155 tokens, which washtrace does not read.'
        : 'This transaction moved no ERC-721 token.');
    }
    const head = await this.chain.finalized();
    const to = Math.max(head, receipt.blockNumber);
    let atLeast = false;

    // Each token's history, in its own collection: one token id in two collections is two tokens.
    const tokens = [...new Map(moved.map((t) => [`${t.collection}:${t.tokenId}`, t])).values()];
    if (tokens.length > SPOT_TRADES_MAX) atLeast = true;
    const histories = new Map<string, Transfer[]>();
    for (const t of tokens.slice(0, SPOT_TRADES_MAX)) {
      const read = await this.chain.tokenTransfers(t.collection, t.tokenId, await this.startOf(t.collection), to, this.deadline);
      // The checked transfers themselves, should a provider's logs lag its receipts.
      for (const m of moved) {
        if (m.collection === t.collection && m.tokenId === t.tokenId && !read.some((r) => r.txHash === m.txHash && r.logIndex === m.logIndex)) {
          const { collection: _, ...plain } = m;
          read.push(plain);
        }
      }
      histories.set(t.collection, [...(histories.get(t.collection) ?? []), ...read]);
    }

    const custodians = new Set(CUSTODIANS);
    const trades: Trade[] = [];
    for (const [collection, hist] of histories) {
      const order = chainOrder(hist);
      for (const tokenId of new Set(hist.map((t) => t.tokenId))) {
        const graph = tokenGraph(hist, order.filter((i) => hist[i]!.tokenId === tokenId), custodians);
        for (const h of graph.hops) if (h.ref !== null && hist[h.ref]!.txHash === tx) trades.push({ collection, ref: h.ref, seller: h.from, buyer: h.to });
      }
    }
    if (trades.length === 0) throw new Error('This transaction holds no trade: a mint, a burn or a move into or out of custody.');

    // The sellers' and buyers' money: a stored read that reaches the trade is used as it is.
    const contracts = contractsFor(chainId);
    const wallets = [...new Set(trades.flatMap((t) => [t.seller, t.buyer]))];
    const funded = new Set<string>();
    const truncated = new Set<string>();
    let moneyOk = this.etherscan !== null;
    if (this.etherscan !== null) {
      const covering = await this.store.moneyCovering(chainId, wallets, receipt.blockNumber);
      for (const w of wallets) {
        const c = covering.get(w);
        if (c !== undefined && c.from === null) {
          funded.add(w);
          if (c.truncated) truncated.add(w);
          continue;
        }
        try {
          const r = await this.etherscan.flows(chainId, w, this.left(), c?.from ?? undefined);
          // Added only once read: a row whose read failed would wait forever, since no lane serves it.
          await this.store.addWallets(chainId, [w]);
          await this.store.saveMoney(chainId, w, r.flows, r.truncated, undefined, r.through, c !== undefined);
          funded.add(w);
          if (r.truncated) truncated.add(w);
        } catch {
          moneyOk = false;
        }
      }
    }
    const flows = await this.store.flowsOf(chainId, [...funded]);

    // The possible middles, read in memory only: saved, one exchange-like wallet would re-queue every collection it touched.
    const middles = new Map<Trade, string[]>();
    for (const t of trades) middles.set(t, funded.has(t.seller) && funded.has(t.buyer) ? middlesOf(flows, t.seller, t.buyer, contracts) : []);
    const state = new Map<string, 'ok' | 'hub' | 'busy' | 'unread'>();
    for (const m of new Set([...middles.values()].flat())) {
      if (this.etherscan === null || state.size >= SPOT_MIDDLES) { state.set(m, 'unread'); continue; }
      try {
        const r = await this.etherscan.flows(chainId, m, this.left());
        state.set(m, r.truncated ? 'hub' : counterparties(r.flows, m) > RULES.hubDegree ? 'busy' : 'ok');
      } catch {
        state.set(m, 'unread');
      }
    }
    const hubs = new Set([...truncated, ...[...state].filter(([, s]) => s !== 'ok').map(([m]) => m)]);
    const unsure = (t: Trade) => (middles.get(t) ?? []).some((m) => state.get(m) === 'busy' || state.get(m) === 'unread');

    // Another sale's payment between the same wallets is the price of that sale, not a way back: the product leaves
    // out every flow in a transaction of the collection, so read the receipts of the flows that could join a pair.
    const histTxs = new Set([...histories.values()].flat().map((t) => t.txHash));
    const pairs = new Set(wallets);
    const near = new Set([...wallets, ...state.keys()]);
    const legs = [...new Set(flows.filter((f) => (pairs.has(f.from) && near.has(f.to)) || (pairs.has(f.to) && near.has(f.from)))
      .map((f) => f.txHash).filter((h) => !histTxs.has(h)))];
    // A leg whose receipt is not read may be a sale's price, so its flows are dropped: that can only lose a flag.
    const unread = new Set(legs.slice(SPOT_RECEIPTS_MAX));
    if (unread.size > 0) atLeast = true;
    const saleLegs = new Set<string>();
    if (legs.length > 0) {
      for (const [h, logs] of await this.chain.receipts(legs.slice(0, SPOT_RECEIPTS_MAX))) {
        if (logs.some((l) => l.topics.length === 4 && l.topics[0] === TRANSFER && histories.has(l.address.toLowerCase()))) saleLegs.add(h);
      }
    }
    const money = flows.filter((f) => !saleLegs.has(f.txHash) && !unread.has(f.txHash));

    const flags = new Map<string, Record<string, Witness | Pick<LensFlag, 'path' | 'wallets'>>>();
    const flag = (collection: string, logIndex: number, key: string, witness: Witness | Pick<LensFlag, 'path' | 'wallets'>) => {
      const k = `${collection}:${logIndex}`;
      flags.set(k, { ...(flags.get(k) ?? {}), [key]: witness });
    };
    const notRun: string[] = [];
    const methods = new Set<string>();
    if (lens === null) {
      notRun.push('AU');
      if (!moneyOk) notRun.push('AC');
      for (const [collection, hist] of histories) {
        const a = analyze({
          transfers: hist, payments: Payments.from(money, hist), fundingAvailable: moneyOk, funded, truncated: hubs,
          custodians, contracts, money: moneyFor(chainId),
        });
        for (const f of a.flags) {
          if (f.txHash !== tx || f.method === 'AU' || (f.method === 'AC' && !moneyOk)) continue;
          flag(collection, f.logIndex, f.method, f.witness);
          methods.add(f.method);
        }
        if (moneyOk) {
          for (const t of trades.filter((x) => x.collection === collection)) {
            if (!flags.get(`${collection}:${hist[t.ref]!.logIndex}`)?.AC && unsure(t)) atLeast = true;
          }
        }
      }
    } else {
      const usesMoney = WALKED.some((k) => lens.rule.edges[k].use);
      if (usesMoney && !moneyOk) notRun.push(lens.key);
      // Money further out than the pair, or other holders' money beside the token's own moves, is not read.
      if (usesMoney && (depthNeeded(lens.rule) > 0 || lens.rule.edges['nft-token'].use)) atLeast = true;
      for (const [collection, hist] of histories) {
        const tradeTxs = [...new Set(hist.map((t) => t.txHash))];
        const input: LensInput = {
          transfers: hist, through: to, moves: spotMoves(lens.rule, money, chainId, new Set([...tradeTxs, ...saleLegs])),
          contracts, custodians, money: moneyFor(chainId), truncated: hubs, tradeTxs, tokensRead: null,
        };
        const mine = trades.filter((t) => t.collection === collection);
        const r = runLens(lens.rule, input, undefined, new Set(mine.map((t) => `${tx}:${hist[t.ref]!.logIndex}`)));
        // A trade the lens skipped (no marketplace under "judges sales", untimed under a window or loop order) or
        // whose search hit its cap was never judged, so it is never called clean.
        if (r.judged < mine.length || r.totals.truncated > 0) atLeast = true;
        for (const f of r.flags) {
          if (f.txHash !== tx) continue;
          flag(collection, f.logIndex, lens.key, { path: f.path, wallets: f.wallets });
          methods.add(lens.key);
        }
        if (usesMoney && moneyOk) {
          for (const t of mine) if (!flags.get(`${collection}:${hist[t.ref]!.logIndex}`)?.[lens.key] && unsure(t)) atLeast = true;
        }
      }
    }

    const counted = lens === null ? ['A', 'AC'] : [lens.key];
    const flagged = counted.some((m) => methods.has(m));
    const ranAll = counted.every((m) => !notRun.includes(m));
    const transfers = [...histories].flatMap(([collection, hist]) => hist
      .filter((t) => t.txHash === tx)
      .sort((x, y) => x.logIndex - y.logIndex)
      .map((t) => ({ ...t, collection, flags: flags.get(`${collection}:${t.logIndex}`) ?? {} })));
    return {
      washTrade: flagged ? true : ranAll && !atLeast ? false : null,
      methods: counted.filter((m) => methods.has(m)),
      notRun,
      atLeast,
      finalized: receipt.blockNumber <= head,
      source: 'spot',
      transfers,
    };
  }

  /** The block a collection's history is read from: its creation, where Etherscan knows it, else 0. */
  private async startOf(collection: string): Promise<number> {
    const known = this.starts.get(collection);
    if (known !== undefined) return known;
    let start = 0;
    try {
      const made = await this.etherscan?.creation(this.chainId, collection);
      const r = made ? await this.chain.receipt(made.txHash) : null;
      if (r !== null) start = r.blockNumber;
    } catch {
      // Unknown to the explorer, or no explorer: from the chain's start, which only costs a wider query.
    }
    this.starts.set(collection, start);
    return start;
  }

  /** What is left of the check's deadline, for one read's budget. */
  private left(): number {
    return Math.max(0, this.deadline - Date.now());
  }
}
