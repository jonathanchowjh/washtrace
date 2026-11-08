/**
 * Wallet addresses by number, and numbers by address, held as bytes: every
 * address's characters in one array, and an open-addressed table of numbers
 * hashed by them. It exists for `Moves`, whose lens runs number millions of
 * wallets: Terraforms' 2.9M in a Map and an array of strings were 370 MB of
 * heap, which the heap then grew to 820 MB around, enough on its own to put
 * a run past the worker's memory; this is 180 MB. Addresses are ASCII, so a
 * character is a byte. A class because the bytes, their starts, their hashes
 * and the table are kept in step.
 */
export class Wallets {
  size = 0;
  private chars = new Uint8Array(1 << 12);
  private used = 0;
  /** Where each wallet's characters start in `chars`; the next one's start is its end. */
  private starts = new Int32Array(1 << 8);
  /** Each wallet's `hash`, kept so a bigger table is filled without hashing again. */
  private hashes = new Int32Array(1 << 8);
  /** Wallet number + 1 by hash, 0 for empty: always under half full. */
  private table = new Int32Array(1 << 9);

  /** The wallet's number, given one if it has none. */
  number(address: string): number {
    const h = hash(address);
    const at = this.slot(address, h);
    const known = this.table[at]!;
    if (known > 0) return known - 1;
    const w = this.size++;
    if (this.used + address.length > this.chars.length) this.chars = grown(this.chars, this.used + address.length);
    for (let i = 0; i < address.length; i++) this.chars[this.used + i] = address.charCodeAt(i);
    if (w + 2 > this.starts.length) this.starts = grown(this.starts, w + 2);
    if (w + 1 > this.hashes.length) this.hashes = grown(this.hashes, w + 1);
    this.starts[w] = this.used;
    this.used += address.length;
    this.starts[w + 1] = this.used;
    this.hashes[w] = h;
    this.table[at] = w + 1;
    if (2 * this.size > this.table.length) this.rehash();
    return w;
  }

  /** The wallet's number, or -1. */
  find(address: string): number {
    return this.table[this.slot(address, hash(address))]! - 1;
  }

  name(w: number): string {
    let out = '';
    for (let i = this.starts[w]!, end = this.starts[w + 1]!; i < end; i++) out += String.fromCharCode(this.chars[i]!);
    return out;
  }

  /** Where `address`, whose hash is `h`, is in the table, or the empty slot it would take. */
  private slot(address: string, h: number): number {
    const mask = this.table.length - 1;
    for (let at = h & mask; ; at = (at + 1) & mask) {
      const w = this.table[at]! - 1;
      if (w < 0 || this.is(w, address)) return at;
    }
  }

  private is(w: number, address: string): boolean {
    const start = this.starts[w]!;
    if (this.starts[w + 1]! - start !== address.length) return false;
    for (let i = 0; i < address.length; i++) if (this.chars[start + i] !== address.charCodeAt(i)) return false;
    return true;
  }

  private rehash(): void {
    const table = new Int32Array(2 * this.table.length);
    const mask = table.length - 1;
    for (let w = 0; w < this.size; w++) {
      let at = this.hashes[w]! & mask;
      while (table[at] !== 0) at = (at + 1) & mask;
      table[at] = w + 1;
    }
    this.table = table;
  }
}

/** FNV-1a over the characters. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h;
}

/** A copy of `arr` with room for at least `need`, doubled. */
function grown<T extends Int32Array | Uint8Array>(arr: T, need: number): T {
  let size = arr.length;
  while (size < need) size *= 2;
  const out = new (arr.constructor as new (n: number) => T)(size);
  out.set(arr);
  return out;
}
