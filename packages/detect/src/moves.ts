import { Wallets } from './wallets.js';

/**
 * Which money kind an edge is, as a byte: ETH payments, ETH sent by a
 * contract, WETH-like tokens, and other tokens (TOKENS, read into
 * token_flows). An other-token edge's `eth` is 0: tokens differ in value and
 * washtrace has no prices, so no floor reads it (T9). `otherOneWay` is an
 * other-token edge whose receiver's own read does not pass T6 (Ruling P10):
 * it is never walked against its arrow, else two traders who paid one DEX
 * pool, or a wallet never read, would read as a way back through it.
 */
export const MOVE_KIND = { eth: 0, internal: 1, weth: 2, other: 3, otherOneWay: 4 } as const;

const EMPTY = new Int32Array(0);

/**
 * Edges are added into blocks of this many, never into one array grown by
 * copying: Terraforms' 37M money edges peaked at 3.3 GB while a doubled
 * array and the one it replaced were both alive. A block is one buffer of
 * 46 MB holding every column, big enough that the allocator maps it by
 * itself and gives it back the moment `seal` lets it go: blocks of 256 KB
 * were kept for reuse once freed, and left 0.8 GB resident for nothing. The
 * unfilled end of the last block is never written, so it is never resident.
 */
const BLOCK = 1 << 21;

type Column = Int32Array | Uint8Array | Uint32Array | Float32Array;
type Name = 'from' | 'to' | 'time' | 'block' | 'eth' | 'kind' | 'sale';
type Ctor = { new (n: number): Column; new (buffer: ArrayBuffer, offset: number, length: number): Column; BYTES_PER_ELEMENT: number };
/** The 4-byte columns first, so every column in a block is aligned. */
const COLUMNS: Record<Name, Ctor> = {
  from: Int32Array, to: Int32Array, time: Uint32Array, block: Int32Array, eth: Float32Array, kind: Uint8Array, sale: Uint8Array,
};
const NAMES = Object.keys(COLUMNS) as Name[];
type Block = { buffer: ArrayBuffer } & Record<Name, Column>;

function newBlock(): Block {
  const buffer = new ArrayBuffer(BLOCK * NAMES.reduce((w, c) => w + COLUMNS[c].BYTES_PER_ELEMENT, 0));
  const b = { buffer } as Block;
  let at = 0;
  for (const c of NAMES) {
    b[c] = new COLUMNS[c](buffer, at, BLOCK);
    at += BLOCK * COLUMNS[c].BYTES_PER_ELEMENT;
  }
  return b;
}

/** Frees a buffer now rather than at the next collection: detached, its memory goes back at once. */
function release(buffer: ArrayBuffer): void {
  (buffer as ArrayBuffer & { transfer(length: number): ArrayBuffer }).transfer(0);
}

/**
 * The money edges a lens may follow, held as numbers, the way `Payments` holds
 * the built-ins': an edge is 22 bytes of typed-array cells, and no hash string
 * is kept per edge (a found loop's hashes are read back with `Store.moveTxs`).
 * Unlike `Payments` it keeps every edge, with its kind, amount and time,
 * because a lens's rule judges those; `time` and `sale` are what let a
 * search count only the money that came before a trade and outside the
 * collection's own transactions.
 *
 * A class because adding edges, numbering wallets and building the adjacency
 * all share the same arrays. Add every edge, then `seal()`; the columns and
 * an edge's index, its position in time order, only hold after that.
 */
export class Moves {
  /** The wallets, numbered in the order each was first seen. */
  private readonly wallet = new Wallets();

  from: Int32Array = new Int32Array(0);
  to: Int32Array = new Int32Array(0);
  kind: Uint8Array = new Uint8Array(0);
  /** Seconds since the epoch. */
  time: Uint32Array = new Uint32Array(0);
  block: Int32Array = new Int32Array(0);
  /**
   * The amount in ETH, as a 32-bit float: for comparing against a rule's
   * floor, which SQL has already applied exactly, not for exact sums. Half
   * the size of a double, and seven digits are plenty for that.
   */
  eth: Float32Array = new Float32Array(0);
  /** 1 for an edge paid in a transaction that moves one of the collection's tokens (Ruling K: an NFT's price). */
  sale: Uint8Array = new Uint8Array(0);

  private n = 0;
  private sealed = false;
  private blocks: Block[] = [];
  /** Whether the edges came in time order, as `Store.lensInput` reads them: then `seal` has nothing to sort. */
  private inOrder = true;
  private last = 0;
  private outStart: Int32Array = new Int32Array(1);
  private outList: Int32Array = EMPTY;
  /**
   * The edges into each wallet, built on the first `into`: a rule that only
   * follows money along its arrows, closes at the seller and bars no wallet
   * by its count never asks, and Terraforms' are 160 MB.
   */
  private inbound: [Int32Array, Int32Array] | null = null;

  /** The edges added. */
  get size(): number {
    return this.n;
  }

  /** The wallets numbered. */
  get wallets(): number {
    return this.wallet.size;
  }

  /** A wallet's number, or undefined for one no edge touches. */
  id(address: string): number | undefined {
    const w = this.wallet.find(address);
    return w < 0 ? undefined : w;
  }

  name(w: number): string {
    return this.wallet.name(w);
  }

  add(from: string, to: string, kind: number, time: number, block: number, eth: number, sale: boolean): void {
    if (this.sealed) throw new Error('Moves is sealed: no edge can be added after seal().');
    const at = this.n % BLOCK;
    if (at === 0) this.blocks.push(newBlock());
    const b = this.blocks[this.blocks.length - 1]!;
    b.from[at] = this.wallet.number(from);
    b.to[at] = this.wallet.number(to);
    b.kind[at] = kind;
    b.time[at] = time;
    b.block[at] = block;
    b.eth[at] = eth;
    b.sale[at] = sale ? 1 : 0;
    if (time < this.last) this.inOrder = false;
    this.last = time;
    this.n++;
  }

  /**
   * Sorts the edges by time (ties keep the order added) into one array per
   * column, and builds the adjacency. Each block is freed as soon as it is
   * copied, so the edges are held about once over, not twice. Once only:
   * the blocks are gone after it, so a second call would have nothing to copy.
   */
  seal(): void {
    if (this.sealed) throw new Error('Moves is already sealed: seal() is called once.');
    this.sealed = true;
    const n = this.n;
    const blocks = this.blocks;
    this.blocks = [];
    const out = {} as Record<Name, Column>;
    for (const c of NAMES) out[c] = new COLUMNS[c](n);
    if (this.inOrder) {
      blocks.forEach((b, k) => {
        const len = Math.min(BLOCK, n - k * BLOCK);
        for (const c of NAMES) out[c].set(b[c].subarray(0, len), k * BLOCK);
        release(b.buffer);
      });
    } else {
      const time = (i: number) => blocks[(i / BLOCK) | 0]!.time[i % BLOCK]!;
      const order = new Int32Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => time(a) - time(b) || a - b);
      for (const c of NAMES) {
        const col = out[c];
        for (let i = 0; i < n; i++) col[i] = blocks[(order[i]! / BLOCK) | 0]![c][order[i]! % BLOCK]!;
      }
      for (const b of blocks) release(b.buffer);
    }
    this.from = out.from as Int32Array;
    this.to = out.to as Int32Array;
    this.kind = out.kind as Uint8Array;
    this.time = out.time as Uint32Array;
    this.block = out.block as Int32Array;
    this.eth = out.eth as Float32Array;
    this.sale = out.sale as Uint8Array;
    [this.outStart, this.outList] = adjacency(this.from, this.wallets);
    this.inbound = null;
  }

  /** Edge indexes leaving a wallet, in time order. */
  out(w: number): Int32Array {
    return w < this.wallets ? this.outList.subarray(this.outStart[w]!, this.outStart[w + 1]!) : EMPTY;
  }

  /** Edge indexes entering a wallet, in time order. */
  into(w: number): Int32Array {
    if (w >= this.wallets) return EMPTY;
    const [start, list] = (this.inbound ??= adjacency(this.to, this.wallets));
    return list.subarray(start[w]!, start[w + 1]!);
  }
}

/** Edge indexes grouped by the wallet at `ends[i]`, each group in index order: [starts, list]. */
export function adjacency(ends: Int32Array, wallets: number): [Int32Array, Int32Array] {
  const start = new Int32Array(wallets + 1);
  for (let i = 0; i < ends.length; i++) start[ends[i]! + 1]!++;
  for (let w = 0; w < wallets; w++) start[w + 1]! += start[w]!;
  const next = start.slice(0, wallets);
  const list = new Int32Array(ends.length);
  for (let i = 0; i < ends.length; i++) list[next[ends[i]!]!++] = i;
  return [start, list];
}
