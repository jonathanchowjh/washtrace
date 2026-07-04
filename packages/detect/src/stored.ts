import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdCompress, createZstdDecompress } from 'node:zlib';
import type { Flow, FlowKind, Transfer } from './types.js';

/**
 * Stored data: a collection's transfers, and its money trail, cut from a
 * store that has read them and shipped as files, so a fresh install starts
 * from them instead of from the deploy block.
 *
 * A file is CSV compressed with zstd (Node 22.15+ has it in node:zlib). Its
 * columns are the table's, in migrations.ts order, without the store's own
 * keys (collection_id, chain_id): the manifest says which collection and
 * chain. Null is an empty field. No value ever holds a comma or a line
 * break (hex, numbers, marketplace slugs), so writing asserts that rather
 * than quoting. Writing and reading both stream: a big collection is
 * millions of rows.
 */

/** One collection's stored data, as the manifest lists it. */
export interface StoredEntry {
  chainId: number;
  address: string;
  name: string;
  startBlock: number;
  /** The collection's cursor when it was cut: the snapshot holds every transfer up to this block. */
  throughBlock: number;
  /** Milliseconds. The time of the latest transfer at or below `throughBlock`. */
  throughTime: number;
  /** Committed beside the manifest; `file` is relative to it. */
  transfers: { file: string; rows: number; bytes: number; sha256: string };
  /**
   * The money trail: too big to commit, so it stays local and gitignored,
   * beside the manifest, and is loaded when it is there and matches
   * `sha256`. It holds chain data only (the wallets read to the end, and the
   * flows they found), so it is published like the transfers. `rows` counts
   * flows, `wallets` the checked list's length. `checked` of `of` is how many
   * of the collection's traders are on that list.
   */
  trail: { rows: number; wallets: number; checked: number; of: number; bytes: number; sha256: string } | null;
}

/** Every collection with stored data. In the repo at data/stored/manifest.json. */
export interface Manifest {
  /** 2: the trail carries chain data only. A version 1 manifest (wallet bookkeeping in the trail) is not read. */
  version: 2;
  /** The Hub commit (a 40-hex sha, as it goes into download URLs) this manifest was fetched at, so what is fetched next stays on it. Absent in a manifest cut here. */
  revision?: string;
  collections: StoredEntry[];
}

/**
 * Which way stored data is bad, for a reader who needs it in a few words.
 * `disk` is the machine, not the data: a write that found the disk full or
 * failing. It is noted like `unreadable`, but says nothing against the file.
 */
export type StoredDataFault = 'missing' | 'mismatch' | 'unreadable' | 'disk';

/** Stored data that is missing, changed or malformed. Callers fall back to reading the chain. */
export class StoredDataError extends Error {
  constructor(message: string, readonly kind: StoredDataFault = 'unreadable') {
    super(message);
  }
}

/** Rows to write: an array, or a store's cursor as it streams. */
type Rows<T> = AsyncIterable<T> | Iterable<T>;

/** What a written file is, for the manifest. */
export interface Written { rows: number; bytes: number; sha256: string }

const BATCH = 5_000;
/** Lines joined into one chunk for the compressor: one write per line was most of the time. */
const CHUNK_LINES = 1_000;
const ZSTD_LEVEL = 19;

const TRANSFER_COLUMNS = ['tx_hash', 'log_index', 'block_number', 'block_time', 'token_id', 'from_address', 'to_address', 'marketplace', 'price_wei', 'currency'];
const CHECKED_COLUMNS = ['address'];
const FLOW_COLUMNS = ['tx_hash', 'kind', 'from_address', 'to_address', 'value_wei', 'token', 'block_number', 'block_time'];

/** Errors of the process, not of the file (out of descriptors or memory): a load that meets one backs off, and is not noted as bad stored data. */
const PROCESS_FAULTS = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM']);

/** The trail's two sections, each a marker line then its header. */
const CHECKED = '#checked';
const FLOWS = '#flows';

/** The stored-data folder: `WASHTRACE_STORED_DIR`, else data/stored under the working directory (the repo root, or /app in the image). */
export function storedDir(env: Record<string, string | undefined>, cwd = process.cwd()): string {
  return env.WASHTRACE_STORED_DIR?.trim() || join(cwd, 'data', 'stored');
}

/** A stored file's name. Lowercase, so a checksummed address names the same file. */
export function storedFile(chainId: number, address: string, part: 'transfers' | 'trail'): string {
  return `${chainId}-${address.toLowerCase()}.${part}.csv.zst`;
}

/**
 * Where a collection's money trail is on disk: beside the manifest, under
 * the name the cut gave it. The manifest names no trail file, since the
 * trail is never committed; only its sha256 says which file it is.
 */
export function trailPath(dir: string, e: Pick<StoredEntry, 'chainId' | 'address'>): string {
  return join(dir, storedFile(e.chainId, e.address, 'trail'));
}

/** The manifest's entry for a collection. Addresses compare case-insensitively: a URL may carry a checksummed one. */
export function entryFor(m: Manifest, chainId: number, address: string): StoredEntry | null {
  const a = address.toLowerCase();
  return m.collections.find((e) => e.chainId === chainId && e.address.toLowerCase() === a) ?? null;
}

/** The manifest with `e` in place of any entry for the same collection, in a stable order so a re-cut diffs as one entry. */
export function upsertEntry(m: Manifest, e: StoredEntry): Manifest {
  const others = m.collections.filter((x) => !(x.chainId === e.chainId && x.address.toLowerCase() === e.address.toLowerCase()));
  const collections = [...others, e].sort((x, y) => x.chainId - y.chainId || x.address.toLowerCase().localeCompare(y.address.toLowerCase()));
  return { version: 2, collections };
}

/** The manifest at `path`. A missing one is empty: an install with no stored data reads the chain as before. */
export async function readManifest(path: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, collections: [] };
    throw err;
  }
  try {
    return parseManifest(text);
  } catch (err) {
    throw err instanceof StoredDataError ? new StoredDataError(`${path}: ${err.message}`, err.kind) : err;
  }
}

/**
 * A manifest from its JSON, or StoredDataError('unreadable'). The manifest
 * names files that are fetched and opened by path, and may come from the
 * network, so each value that ends up in a path, a query or a count is
 * checked rather than trusted: a file is only ever the name `storedFile`
 * gives, and an address is lowercase hex.
 */
export function parseManifest(text: string): Manifest {
  const bad = (what: string): never => { throw new StoredDataError(`not a version 2 manifest: ${what}`); };
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad('it is not JSON');
  }
  if (raw === null || typeof raw !== 'object' || raw.version !== 2 || !Array.isArray(raw.collections)) return bad('its version is not 2');
  if (raw.revision !== undefined && (typeof raw.revision !== 'string' || !/^[0-9a-f]{40}$/.test(raw.revision))) bad('its revision is not a commit sha');
  const count = (v: unknown, what: string): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : bad(what));
  const sha = (v: unknown, what: string): string => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : bad(what));
  const collections = raw.collections.map((e: any): StoredEntry => {
    if (e === null || typeof e !== 'object' || e.transfers === null || typeof e.transfers !== 'object') return bad('an entry is not an object');
    if (!Number.isInteger(e.chainId) || e.chainId <= 0) bad('a chainId is not a positive integer');
    if (typeof e.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(e.address)) bad('an address is not lowercase hex');
    if (typeof e.name !== 'string') bad('a name is not text');
    if (e.transfers.file !== storedFile(e.chainId, e.address, 'transfers')) bad('a transfers file is not named for its collection');
    const t = e.trail;
    if (t !== null && typeof t !== 'object') bad('a trail is neither an object nor null');
    return {
      chainId: e.chainId, address: e.address, name: e.name,
      startBlock: count(e.startBlock, 'a startBlock is not a count'), throughBlock: count(e.throughBlock, 'a throughBlock is not a count'),
      // Milliseconds, taken from a float of seconds: whole in practice, but only required to be a time.
      throughTime: typeof e.throughTime === 'number' && e.throughTime >= 0 ? e.throughTime : bad('a throughTime is not a time'),
      transfers: {
        file: e.transfers.file, rows: count(e.transfers.rows, 'a transfers row count is not a count'),
        bytes: count(e.transfers.bytes, 'a transfers size is not a count'), sha256: sha(e.transfers.sha256, 'a transfers sha256 is not a sha256'),
      },
      trail: t === null ? null : {
        rows: count(t.rows, 'a trail row count is not a count'), wallets: count(t.wallets, 'a trail wallet count is not a count'),
        checked: count(t.checked, 'a trail checked count is not a count'), of: count(t.of, 'a trail trader count is not a count'),
        bytes: count(t.bytes, 'a trail size is not a count'), sha256: sha(t.sha256, 'a trail sha256 is not a sha256'),
      },
    };
  });
  return raw.revision === undefined ? { version: 2, collections } : { version: 2, revision: raw.revision, collections };
}

/** Write the manifest whole, through a temporary file, so a reader never sees half of one. */
export async function writeManifest(path: string, m: Manifest): Promise<void> {
  await writeFile(`${path}.part`, `${JSON.stringify(m, null, 2)}\n`);
  await rename(`${path}.part`, path);
}

/**
 * The sha256 of a file, streamed. What the manifest records and every read
 * checks first. A file that is not there is missing; one the system will not
 * read (its permissions, a directory in its place, a disk error) is
 * unreadable: bad stored data either way, noted once, not a failure retried
 * every pass. A fault of the process (PROCESS_FAULTS) is thrown as it is.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new StoredDataError(`${path} is missing`, 'missing');
    if (typeof code === 'string' && !PROCESS_FAULTS.has(code)) throw new StoredDataError(`${path} could not be read: ${(err as Error).message}`, 'unreadable');
    throw err;
  }
  return hash.digest('hex');
}

/**
 * What a load of stored data that failed on the data was about: the
 * manifest's sha256 and the file as it stands (size, modified and changed
 * times), or `absent` when there is no file to stat. A new cut, the file put
 * back, or its permissions fixed (which moves only its ctime) changes it, so
 * the load is tried again then and not every pass before.
 */
export async function storedKey(path: string, sha256: string): Promise<string> {
  try {
    const s = await stat(path);
    return `${sha256}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch {
    // Not there, or a folder above it that will not open: either way nothing to read, until it changes.
    return `${sha256}:absent`;
  }
}

/** Write a collection's transfers to `path`, compressed, and say what was written. */
export async function writeTransfers(path: string, rows: Rows<Transfer>): Promise<Written> {
  let count = 0;
  async function* lines(): AsyncIterable<string> {
    yield TRANSFER_COLUMNS.join(',');
    for await (const t of rows) {
      // A native-token price is currency '', and an empty field reads back as
      // null; so it is read back from the price, and the two must agree.
      if ((t.currency === null) !== (t.priceWei === null)) {
        throw new StoredDataError(`transfer ${t.txHash}:${t.logIndex} has a currency without a price, or a price without one`);
      }
      count++;
      yield line(TRANSFER_COLUMNS, [t.txHash, t.logIndex, t.blockNumber, t.blockTime, t.tokenId, t.from, t.to, t.marketplace, t.priceWei, t.currency]);
    }
  }
  const { bytes, sha256 } = await writeCompressed(path, lines());
  return { rows: count, bytes, sha256 };
}

/**
 * A collection's transfers from `path`, in batches of 5,000. The whole file's
 * sha256 is checked against `sha256` before the first batch, so a caller
 * never stores half of a file that turns out to be wrong.
 */
export async function* readTransfers(path: string, sha256: string): AsyncIterable<Transfer[]> {
  let batch: Transfer[] = [];
  let header = true;
  for await (const text of readLines(path, sha256)) {
    if (header) {
      expectHeader(path, text, TRANSFER_COLUMNS);
      header = false;
      continue;
    }
    const f = fields(path, text, TRANSFER_COLUMNS.length);
    const priceWei = f[8] || null;
    batch.push({
      txHash: f[0]!, logIndex: Number(f[1]), blockNumber: Number(f[2]), blockTime: f[3] ? Number(f[3]) : null,
      tokenId: f[4]!, from: f[5]!, to: f[6]!, marketplace: f[7] || null, priceWei,
      currency: priceWei === null ? null : f[9]!,
    });
    if (batch.length === BATCH) {
      yield batch;
      batch = [];
    }
  }
  if (header) throw new StoredDataError(`${path} is empty`);
  if (batch.length > 0) yield batch;
}

/**
 * Write a collection's money trail to `path`: the wallets checked to the end
 * (addresses only), then every flow those checks found, as two sections of
 * one file. Nothing of how a wallet was read goes in (its status, depth,
 * time or errors): the file holds what the chain says, so it can be
 * published. The addresses are read to the end before the flows are started.
 */
export async function writeTrail(path: string, trail: { checked: Rows<string>; flows: Rows<Flow> }): Promise<Written & { wallets: number }> {
  let wallets = 0;
  let flows = 0;
  async function* lines(): AsyncIterable<string> {
    yield CHECKED;
    yield CHECKED_COLUMNS.join(',');
    for await (const address of trail.checked) {
      wallets++;
      yield line(CHECKED_COLUMNS, [address]);
    }
    yield FLOWS;
    yield FLOW_COLUMNS.join(',');
    for await (const r of trail.flows) {
      flows++;
      yield line(FLOW_COLUMNS, [r.txHash, r.kind, r.from, r.to, r.valueWei, r.token, r.blockNumber, r.blockTime]);
    }
  }
  const { bytes, sha256 } = await writeCompressed(path, lines());
  return { rows: flows, wallets, bytes, sha256 };
}

/**
 * A money trail from `path`, in batches of up to 5,000 rows, checked
 * addresses first. Checked against `sha256` before the first batch, as
 * `readTransfers` is.
 */
export async function* readTrail(path: string, sha256: string): AsyncIterable<{ checked: string[]; flows: Flow[] }> {
  let checked: string[] = [];
  let flows: Flow[] = [];
  // Where in the file: before a section, at its header, or in its rows.
  let section: typeof CHECKED | typeof FLOWS | null = null;
  let header = false;
  for await (const text of readLines(path, sha256)) {
    if (text === CHECKED || text === FLOWS) {
      if (text === FLOWS && checked.length > 0) {
        yield { checked, flows: [] };
        checked = [];
      }
      section = text;
      header = true;
      continue;
    }
    if (section === null) throw new StoredDataError(`${path} does not start with ${CHECKED}`);
    if (header) {
      expectHeader(path, text, section === CHECKED ? CHECKED_COLUMNS : FLOW_COLUMNS);
      header = false;
      continue;
    }
    if (section === CHECKED) {
      checked.push(fields(path, text, CHECKED_COLUMNS.length)[0]!);
    } else {
      const f = fields(path, text, FLOW_COLUMNS.length);
      flows.push({
        txHash: f[0]!, kind: f[1] as FlowKind, from: f[2]!, to: f[3]!, valueWei: f[4]!, token: f[5]!,
        blockNumber: Number(f[6]), blockTime: Number(f[7]),
      });
    }
    if (checked.length + flows.length === BATCH) {
      yield { checked, flows };
      checked = [];
      flows = [];
    }
  }
  if (section !== FLOWS) throw new StoredDataError(`${path} has no ${FLOWS} section`);
  if (checked.length + flows.length > 0) yield { checked, flows };
}

/** One CSV line. Throws on a comma or a line break, which would shift or split the row on read. */
function line(columns: readonly string[], values: readonly (string | number | boolean | null)[]): string {
  return values.map((v, i) => {
    const s = v === null ? '' : String(v);
    if (/[,\r\n]/.test(s)) throw new StoredDataError(`${columns[i]} holds a comma or a line break: ${JSON.stringify(s.slice(0, 80))}`);
    return s;
  }).join(',');
}

/**
 * Compress `lines` into `path`, hashing and counting the compressed bytes on
 * the way to disk. Written to `<path>.part` and renamed at the end, so a cut
 * that fails leaves nothing behind and never replaces a good file with half
 * of one.
 */
async function writeCompressed(path: string, lines: AsyncIterable<string>): Promise<{ bytes: number; sha256: string }> {
  const part = `${path}.part`;
  const hash = createHash('sha256');
  let bytes = 0;
  async function* chunks(): AsyncIterable<string> {
    let buf: string[] = [];
    for await (const l of lines) {
      buf.push(l);
      if (buf.length === CHUNK_LINES) {
        yield `${buf.join('\n')}\n`;
        buf = [];
      }
    }
    if (buf.length > 0) yield `${buf.join('\n')}\n`;
  }
  try {
    await pipeline(
      Readable.from(chunks()),
      createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }),
      async function* (compressed: AsyncIterable<Buffer>) {
        for await (const c of compressed) {
          hash.update(c);
          bytes += c.length;
          yield c;
        }
      },
      createWriteStream(part),
    );
    await rename(part, path);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** The decompressed lines of `path`, after its sha256 is checked. Empty lines (the last newline) are skipped. */
async function* readLines(path: string, sha256: string): AsyncIterable<string> {
  const actual = await sha256File(path);
  if (actual !== sha256) throw new StoredDataError(`${path} does not match its checksum (sha256 ${actual}, expected ${sha256})`, 'mismatch');
  const decompress = createZstdDecompress();
  const source = createReadStream(path);
  source.on('error', (err) => decompress.destroy(err));
  try {
    for await (const text of createInterface({ input: source.pipe(decompress), crlfDelay: Infinity })) {
      if (text !== '') yield text;
    }
  } catch (err) {
    if (err instanceof StoredDataError || PROCESS_FAULTS.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
    throw new StoredDataError(`${path} could not be read: ${(err as Error).message}`);
  } finally {
    source.destroy();
    decompress.destroy();
  }
}

function expectHeader(path: string, text: string, columns: readonly string[]): void {
  if (text !== columns.join(',')) throw new StoredDataError(`${path} has columns ${text}, expected ${columns.join(',')}`);
}

function fields(path: string, text: string, n: number): string[] {
  const f = text.split(',');
  if (f.length !== n) throw new StoredDataError(`${path} has a row of ${f.length} fields, expected ${n}`);
  return f;
}
