import { ZERO } from './graph.js';
import type { Flow, Method, PaymentUse, Transfer, Witness } from './types.js';

/**
 * Whether a payment may be evidence: not the payment leg of a sale (`sales`
 * holds the hashes of the transactions that moved tokens), not a wallet
 * paying itself, not a zero value, and not a mint or a burn. The one rule the
 * engine builds its money graph by and every page draws or lists evidence by.
 * Its mirror in SQL is the WHERE of Store's money read, which Store.flowsAmong
 * repeats with the collection's own sales: change them together.
 */
export function isEvidencePayment(f: Flow, sales: ReadonlySet<string>): boolean {
  if (sales.has(f.txHash) || f.from === f.to || f.valueWei === '0') return false;
  return f.from !== ZERO && f.to !== ZERO;
}

/** A transfer as the pages hold it: with the witnesses of the lenses that flagged it, when it has them. */
type Flagged = Pick<Transfer, 'txHash'> & { flags?: Partial<Record<Method, Witness>> };

/** A payment's place in the legs of a witness: `from|to`. */
const leg = (from: string, to: string): string => `${from}|${to}`;

/**
 * The legs, each as [from, to], whose payments a witness uses as evidence:
 * - Linked wallets joins a seller and a buyer through a middle wallet (or
 *   directly): the legs between the middle and either side, or between the
 *   seller and buyer when the pair is direct, either way round.
 * - Money loops back closes a loop by money back: each `via` pair's first
 *   wallet to its second, which is the payment back when it was direct, and
 *   each step of its `paths`, from one wallet to the next. A witness saved
 *   before paths were recorded has only the first.
 * - Round trips names no payment.
 * The one rule of which payments are used; a payment must also pass isEvidencePayment.
 */
function legsOf(w: Witness): [string, string][] {
  if (w.kind === 'scc+flow') {
    return [
      ...w.via.map(([from, to]): [string, string] => [from, to]),
      ...(w.paths ?? []).flatMap((p) => p.wallets.slice(1).map((to, i): [string, string] => [p.wallets[i]!, to])),
    ];
  }
  if (w.kind !== 'pair') return [];
  const [seller, buyer] = w.pair;
  const sides: [string, string][] = w.middle === null ? [[seller, buyer]] : [[seller, w.middle], [buyer, w.middle]];
  return sides.flatMap(([x, y]): [string, string][] => [[x, y], [y, x]]);
}

/**
 * How a witness uses one payment: Linked wallets with `named` when the
 * witness's `flowTx` is this payment's hash, or Money loops back with the
 * money back it is on, from `back[0]` to `back[1]`: the payment back itself
 * when it was direct, else the ends of the path it is a step of. Null when
 * the witness does not use it. Whether a payment may be evidence at all is
 * isEvidencePayment's.
 */
export function useOf(w: Witness, f: Pick<Flow, 'txHash' | 'from' | 'to'>): PaymentUse | null {
  if (!legsOf(w).some(([from, to]) => from === f.from && to === f.to)) return null;
  if (w.kind === 'pair') return { method: 'AC', named: w.flowTx === f.txHash };
  if (w.kind !== 'scc+flow') return null;
  const direct = w.via.some(([from, to]) => from === f.from && to === f.to);
  const path = w.paths?.find((p) => p.wallets.some((x, i) => x === f.from && p.wallets[i + 1] === f.to));
  return { method: 'AU', back: direct || path === undefined ? [f.from, f.to] : [path.wallets[0]!, path.wallets[path.wallets.length - 1]!] };
}

/** Every leg the witnesses on `transfers` use, by its `from|to`, each lens by its own kind of witness; Round trips' names no payment. */
function legsAll(transfers: readonly Flagged[]): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  for (const { flags: { AC, AU } = {} } of transfers) {
    for (const [from, to] of [...(AC?.kind === 'pair' ? legsOf(AC) : []), ...(AU?.kind === 'scc+flow' ? legsOf(AU) : [])]) out.set(leg(from, to), [from, to]);
  }
  return out;
}

/**
 * The legs, each as [from, to] and once, whose payments the witnesses on
 * `transfers` may use (see legsOf): what a page asks Store.flowsAmong for, so
 * its cap is spent on evidence alone, never on other payments among the same
 * wallets. evidencePayments still keeps only those that pass isEvidencePayment.
 */
export function evidenceLegs(transfers: readonly Flagged[]): [string, string][] {
  return [...legsAll(transfers).values()];
}

/**
 * The payments among `flows` that the analysis used as evidence, and no
 * others, given the witnesses on `transfers` (see legsOf).
 * Each must also pass isEvidencePayment against the sales among `transfers`.
 * Earliest first, as `flows` came.
 */
export function evidencePayments(flows: readonly Flow[], transfers: readonly Flagged[]): Flow[] {
  const sales = new Set(transfers.map((t) => t.txHash));
  const legs = legsAll(transfers);
  return flows.filter((f) => legs.has(leg(f.from, f.to)) && isEvidencePayment(f, sales));
}

/**
 * The payments the money graph is built from, held as numbers.
 *
 * Terraforms' 2.83M payments as `Flow` objects took 1.2 GB of heap, past
 * half of Node's default. Here a payment is two wallet numbers in a typed
 * array and a reference to its hash: no object per payment. Each wallet's
 * address is kept once, and numbered in the order it was first seen.
 *
 * A class because adding a payment, numbering its wallets and growing the
 * arrays all share the same state.
 */
export class Payments {
  /** Each wallet's address, by number. */
  private readonly addresses: string[] = [];
  private readonly ids = new Map<string, number>();
  /** Payer and payee numbers, two per payment: payment i is ends[2i] → ends[2i + 1]. */
  private both = new Int32Array(1024);
  /** Hashes stay strings: nothing here may assume their format. */
  private readonly txs: string[] = [];

  /**
   * The payments among `flows` the money graph reads, and no others.
   *
   * The payment leg of a sale is a flow from buyer to seller in the same
   * transaction as the transfer: with a WETH bid it is a direct transfer
   * between the two. Left in, every honest bid sale would close its own
   * cycle. The 2023 data never showed this because it read ETH only, and
   * Seaport routes ETH through itself; WETH, Blur Pool and every ERC-20
   * payment do not. A wallet paying itself, a zero value, and a mint or a
   * burn join no two wallets.
   */
  static from(flows: readonly Flow[], transfers: readonly Transfer[]): Payments {
    const sales = new Set(transfers.map((t) => t.txHash));
    const out = new Payments();
    for (const f of flows) {
      if (!isEvidencePayment(f, sales)) continue;
      out.add(f.from, f.to, f.txHash);
    }
    return out;
  }

  /** One payment, already filtered: `from` sees to that, and so must any other caller. */
  add(from: string, to: string, tx: string): void {
    const at = 2 * this.txs.length;
    if (at === this.both.length) {
      const grown = new Int32Array(2 * this.both.length);
      grown.set(this.both);
      this.both = grown;
    }
    this.both[at] = this.number(from) ?? this.assign(from);
    this.both[at + 1] = this.number(to) ?? this.assign(to);
    this.txs.push(tx);
  }

  /** The payments added. */
  get size(): number {
    return this.txs.length;
  }

  /** Each wallet's address, by number. */
  get names(): readonly string[] {
    return this.addresses;
  }

  /** Payer and payee numbers, two per payment. A view: it goes stale when a payment is added. */
  get ends(): Int32Array {
    return this.both.subarray(0, 2 * this.txs.length);
  }

  /** The hash of payment `i`. */
  tx(i: number): string {
    return this.txs[i]!;
  }

  /** The number of the wallet at `address`, if it is in any payment. */
  number(address: string): number | undefined {
    return this.ids.get(address);
  }

  private assign(address: string): number {
    const id = this.addresses.length;
    this.ids.set(address, id);
    this.addresses.push(address);
    return id;
  }
}
