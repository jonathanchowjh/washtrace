import { ZERO } from './graph.js';
import type { Flow, Transfer } from './types.js';

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
      if (sales.has(f.txHash) || f.from === f.to || f.valueWei === '0') continue;
      if (f.from === ZERO || f.to === ZERO) continue;
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
