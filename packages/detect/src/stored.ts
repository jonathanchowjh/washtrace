import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdCompress, createZstdDecompress } from 'node:zlib';
import { formatBytes } from './bytes.js';
import type { Store } from './store.js';
import type { Flow, FlowKind, Transfer } from './types.js';

/**
 * Stored data: a collection's transfers, and its money trail, cut from a
 * store that has read them and shipped as files, so a fresh install starts
 * from them instead of from the deploy block.
 *
 * A file is CSV compressed with zstd (Node 22.15+ has it in node:zlib). A
 * collection has three: its transfers, the wallets its trail checked, and the
 * flows those checks found, each a plain table the Hub's dataset viewer reads.
 * Its columns are the table's, in migrations.ts order, without the store's own
 * keys (collection_id, chain_id): the manifest says which collection and
 * chain. Null is an empty field. No value ever holds a comma or a line
 * break (hex, numbers, marketplace slugs), so writing asserts that rather
 * than quoting. Writing and reading both stream: a big collection is
 * millions of rows.
 */

/** What a stored file is, for the manifest: its size on disk and the sha256 of those bytes. */
export interface StoredFileMeta { bytes: number; sha256: string }

/** The two files of a money trail. */
export interface TrailFiles { wallets: StoredFileMeta; flows: StoredFileMeta }

/** The three tables a collection's stored data has, each its own file. */
export type StoredPart = 'transfers' | 'wallets' | 'flows';

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
  /** Published to the Hub and cached beside the manifest; `file` is relative to it. */
  transfers: { file: string; rows: number; bytes: number; sha256: string };
  /**
   * The money trail: published beside the transfers, downloaded next to the
   * manifest, and loaded when both files are there and match `files`. It
   * holds chain data only (the wallets read to the end, and the flows they
   * found). `rows` counts flows, `wallets` the checked list's length.
   * `checked` of `of` is how many of the collection's traders are on that
   * list. `bytes` is the two files' sizes added, and `sha256` is `trailSha`
   * of them: what a load records as the trail it holds.
   */
  trail: { rows: number; wallets: number; checked: number; of: number; bytes: number; sha256: string; files: TrailFiles } | null;
}

/** Every collection with stored data. Fetched from Hugging Face, and cached in the stored folder as manifest.json. */
export interface Manifest {
  /** 3: a trail is two files. Version 1 and 2 manifests are not read. */
  version: 3;
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

/**
 * Why a collection's stored data was not downloaded, in the words the console
 * shows. Only why, and that the download is tried again: what happens
 * meanwhile (the chain read, or nothing) depends on the chain's RPC, which
 * the console knows. The full error goes to the log.
 */
export const DOWNLOAD_NOTES = {
  failed: 'Stored data could not be downloaded. Tried again later.',
  disk: 'Not enough disk space to download its stored data. Tried again later.',
  mismatch: 'Stored data on Hugging Face does not match its manifest. Tried again once it is published again.',
} as const;

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

export const TRANSFER_COLUMNS = ['tx_hash', 'log_index', 'block_number', 'block_time', 'token_id', 'from_address', 'to_address', 'marketplace', 'price_wei', 'currency'];
export const CHECKED_COLUMNS = ['address'];
export const FLOW_COLUMNS = ['tx_hash', 'kind', 'from_address', 'to_address', 'value_wei', 'token', 'block_number', 'block_time'];

/** Errors of the process, not of the file (out of descriptors or memory): a load that meets one backs off, and is not noted as bad stored data. */
const PROCESS_FAULTS = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'ENOMEM']);

/** The stored-data folder: `WASHTRACE_STORED_DIR`, else data/stored under the working directory (the repo root, or /app in the image). */
export function storedDir(env: Record<string, string | undefined>, cwd = process.cwd()): string {
  return env.WASHTRACE_STORED_DIR?.trim() || join(cwd, 'data', 'stored');
}

/** A stored file's name. Lowercase, so a checksummed address names the same file. */
export function storedFile(chainId: number, address: string, part: StoredPart): string {
  return `${chainId}-${address.toLowerCase()}.${part}.csv.zst`;
}

/**
 * Where a collection's money trail is on disk: its two files beside the
 * manifest, under the names the cut gave them. The manifest names no trail
 * file; only its sha256s say which files they are.
 */
export function trailPaths(dir: string, e: Pick<StoredEntry, 'chainId' | 'address'>): { wallets: string; flows: string } {
  return { wallets: join(dir, storedFile(e.chainId, e.address, 'wallets')), flows: join(dir, storedFile(e.chainId, e.address, 'flows')) };
}

/** What identifies a trail as a whole: the sha256 of its two files' sha256s joined by a colon. */
export function trailSha(files: TrailFiles): string {
  return createHash('sha256').update(`${files.wallets.sha256}:${files.flows.sha256}`).digest('hex');
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
  return { version: 3, collections };
}

/**
 * The manifest a publish commits: what the Hub already lists, with the
 * collections just cut in place of their old entries. A publish of one
 * collection must not drop the others, so it starts from the remote's list.
 * The remote's `revision` is dropped: it names the commit this one follows.
 */
export function mergeManifest(remote: Manifest | null, cut: StoredEntry[]): Manifest {
  let m: Manifest = { version: 3, collections: remote?.collections ?? [] };
  for (const e of cut) m = upsertEntry(m, e);
  return m;
}

/**
 * The dataset's README on the Hub: front matter declaring its tables, what the
 * files hold and how to read them. Built from the manifest, so it can never
 * list a collection the manifest does not, nor columns other than the ones
 * written here. `repo` is the dataset's own name, for the example that loads
 * it.
 */
export function datasetCard(m: Manifest, repo: string): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const rows = m.collections.map((e) =>
    `| ${cell(e.name)} | ${e.address} | ${e.chainId} | ${e.throughBlock} | ${new Date(e.throughTime).toISOString().slice(0, 10)} | ${e.trail ? e.trail.wallets : '—'} | ${formatBytes(e.transfers.bytes)} | ${e.trail ? formatBytes(e.trail.bytes) : 'none'} |`);
  const splits = splitNames(m);
  const withTrail = m.collections.filter((e) => e.trail !== null);
  const tables: [StoredPart, readonly string[], StoredEntry[]][] = [
    ['transfers', TRANSFER_COLUMNS, m.collections], ['wallets', CHECKED_COLUMNS, withTrail], ['flows', FLOW_COLUMNS, withTrail],
  ];
  const used = tables.filter(([, , entries]) => entries.length > 0);
  const configs = used.map(([part, , entries]) =>
    `- config_name: ${part}\n  data_files:\n${entries.map((e) => `  - split: "${splits.get(e)}"\n    path: "${storedFile(e.chainId, e.address, part)}"`).join('\n')}`);
  const infos = used.map(([part, columns]) =>
    `- config_name: ${part}\n  features:\n${columns.map((c) => `  - name: ${c}\n    dtype: string`).join('\n')}`);
  const example = withTrail[0] ?? m.collections[0];
  const table = withTrail.length > 0 ? 'flows' : 'transfers';
  const loadExample = example === undefined ? '' : `

The tables load through the \`datasets\` library, one config per table and one split per collection:

\`\`\`python
from datasets import load_dataset

data = load_dataset("${repo}", "${table}", split="${splits.get(example)}")
\`\`\``;
  return `---
license: cc-by-4.0
pretty_name: washtrace data
tags: [ethereum, nft, wash-trading]${used.length > 0 ? `
configs:
${configs.join('\n')}
dataset_info:
${infos.join('\n')}` : ''}
---

# washtrace data

Transfers of NFT collections, and the money trail of the wallets that traded them, read from the chain. The data
is made for [washtrace](https://github.com/jonathanchowjh/washtrace), an NFT wash-trading detector that follows the
money between wallets (Chow, 2023): a washtrace install downloads these files instead of reading each collection
from its deploy block.

Only data that can be read from the chain is included. Nothing about how it was collected, and no labels or
settings, are in the files.

## Collections

| Name | Address | Chain id | Through block | Last transfer (UTC) | Checked wallets | Transfers file | Trail file |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

Through block is where the read stops; last transfer is the date of the newest transfer at or below it.

The name is the contract's own \`name()\`, or its address when it has none. \`manifest.json\` lists each file with
its row count, size and sha256.

## Files

Each file is CSV compressed with zstd. Null is an empty field. A collection has up to three, one per table.

\`<chainId>-<address>.transfers.csv.zst\` has the collection's transfers, with the columns

\`\`\`
${TRANSFER_COLUMNS.join(',')}
\`\`\`

\`<chainId>-<address>.wallets.csv.zst\` has the wallets whose payments were read to the end of
their history when checked, with the column

\`\`\`
${CHECKED_COLUMNS.join(',')}
\`\`\`

\`<chainId>-<address>.flows.csv.zst\` has the payments those wallets made or received, with the columns

\`\`\`
${FLOW_COLUMNS.join(',')}
\`\`\`

## Reading them

\`\`\`
pip install pandas zstandard
\`\`\`

\`\`\`python
import pandas as pd

transfers = pd.read_csv("1-0x....transfers.csv.zst", compression='zstd', dtype=str)
wallets = pd.read_csv("1-0x....wallets.csv.zst", compression='zstd', dtype=str)
flows = pd.read_csv("1-0x....flows.csv.zst", compression='zstd', dtype=str)
\`\`\`

pandas decompresses as it reads, so a file is never held whole as text; the largest trails hold tens of millions of
flows: pass \`chunksize=\` to read them in parts.

\`dtype=str\` keeps \`price_wei\`, \`value_wei\` and \`token_id\` at full precision, which a number column would round.${loadExample}

Licence: CC-BY-4.0. How to cite the data, and the paper, is in the washtrace README under
[Citing](https://github.com/jonathanchowjh/washtrace#citing).
`;
}

/**
 * Each collection's split name on the card: its name lowercased, with runs of
 * other characters made one underscore. A name that leaves nothing, or that
 * another collection's leaves too, falls back to `c<chainId>_<address>`, so
 * two collections never share a split.
 */
function splitNames(m: Manifest): Map<StoredEntry, string> {
  const named = m.collections.map((e) => ({ e, name: e.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') }));
  const count = new Map<string, number>();
  for (const { name } of named) count.set(name, (count.get(name) ?? 0) + 1);
  return new Map(named.map(({ e, name }) => [e, name === '' || count.get(name)! > 1 ? `c${e.chainId}_${e.address}` : name]));
}

/** `<chainId>/<address>` as the maintainer's commands take it, the address lowercased; null when it is not one. */
export function parseTarget(text: string | undefined): { chainId: number; address: string } | null {
  const m = /^(\d+)\/(0x[0-9a-fA-F]{40})$/.exec(text ?? '');
  return m ? { chainId: Number(m[1]), address: m[2]!.toLowerCase() } : null;
}

/**
 * Cut one collection's stored data from `store` into `dir`: its transfers,
 * and with `trail` its money trail, and the manifest entry that describes
 * them. The entry's trail is null without `trail`; a caller that keeps an
 * earlier one says so. Shared by `npm run stored` and the publisher so the
 * two cut the same way. Only reads the store.
 */
export async function cutCollection(store: Store, dir: string, chainId: number, address: string, { trail }: { trail: boolean }): Promise<StoredEntry> {
  const head = await store.storedHeader(chainId, address);
  if (head === null) throw new Error(`${chainId}/${address} is not watched in this store`);
  if (head.startBlock === null || head.throughBlock === null) throw new Error(`${head.name} has not read any blocks yet`);
  if (head.throughTime === null) throw new Error(`${head.name} has no transfer with a block time at or below block ${head.throughBlock}`);

  const file = storedFile(chainId, address, 'transfers');
  const started = Date.now();
  const transfers = await writeTransfers(join(dir, file), store.storedTransfers(head.id, head.throughBlock));
  console.info('[stored] %s: %d transfers through block %d, %s, in %ds', file, transfers.rows, head.throughBlock, formatBytes(transfers.bytes), seconds(started));

  let cutTrail: StoredEntry['trail'] = null;
  if (trail) {
    const begun = Date.now();
    const { checked, of, addresses, flows } = await store.trail(head.id, chainId);
    const written = await writeTrail(trailPaths(dir, { chainId, address }), { checked: addresses, flows });
    const bytes = written.files.wallets.bytes + written.files.flows.bytes;
    cutTrail = { rows: written.rows, wallets: written.wallets, checked, of, bytes, sha256: trailSha(written.files), files: written.files };
    console.info('[stored] %s and %s: %d wallets, %d flows, %d of %d traders checked, %s, in %ds',
      storedFile(chainId, address, 'wallets'), storedFile(chainId, address, 'flows'), written.wallets, written.rows, checked, of, formatBytes(bytes), seconds(begun));
  }
  return {
    chainId, address,
    // The contract's own name, never the console label (collections.name), which is the maintainer's. `||`: an empty name() is no name.
    name: head.contractName || address,
    startBlock: head.startBlock, throughBlock: head.throughBlock, throughTime: head.throughTime,
    transfers: { file, ...transfers }, trail: cutTrail,
  };
}

function seconds(since: number): number {
  return Math.round((Date.now() - since) / 1000);
}

/** The manifest at `path`. A missing one is empty: an install with no stored data reads the chain as before. */
export async function readManifest(path: string): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 3, collections: [] };
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
  const bad = (what: string): never => { throw new StoredDataError(`not a version 3 manifest: ${what}`); };
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad('it is not JSON');
  }
  if (raw === null || typeof raw !== 'object' || raw.version !== 3 || !Array.isArray(raw.collections)) return bad('its version is not 3');
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
      trail: t === null ? null : parseTrail(t, count, sha),
    };
  });
  return raw.revision === undefined ? { version: 3, collections } : { version: 3, revision: raw.revision, collections };
}

/** A manifest's trail: its counts, and its two files, whose sizes and checksum the trail's own must add up to. */
function parseTrail(t: any, count: (v: unknown, what: string) => number, sha: (v: unknown, what: string) => string): NonNullable<StoredEntry['trail']> {
  const bad = (what: string): never => { throw new StoredDataError(`not a version 3 manifest: ${what}`); };
  if (t.files === null || typeof t.files !== 'object') bad('a trail has no files');
  const file = (f: any, which: string): StoredFileMeta => {
    if (f === null || typeof f !== 'object') return bad(`a trail's ${which} file is not an object`);
    return { bytes: count(f.bytes, `a trail ${which} file size is not a count`), sha256: sha(f.sha256, `a trail ${which} file sha256 is not a sha256`) };
  };
  const files = { wallets: file(t.files.wallets, 'wallets'), flows: file(t.files.flows, 'flows') };
  const trail = {
    rows: count(t.rows, 'a trail row count is not a count'), wallets: count(t.wallets, 'a trail wallet count is not a count'),
    checked: count(t.checked, 'a trail checked count is not a count'), of: count(t.of, 'a trail trader count is not a count'),
    bytes: count(t.bytes, 'a trail size is not a count'), sha256: sha(t.sha256, 'a trail sha256 is not a sha256'), files,
  };
  if (trail.bytes !== files.wallets.bytes + files.flows.bytes) bad("a trail size is not its files'");
  if (trail.sha256 !== trailSha(files)) bad("a trail sha256 is not its files'");
  return trail;
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
 * Write a collection's money trail as two files: the wallets checked to the
 * end (addresses only) at `paths.wallets`, then every flow those checks found
 * at `paths.flows`. Nothing of how a wallet was read goes in (its status,
 * depth, time or errors): the files hold what the chain says, so they can be
 * published. The addresses are read to the end before the flows are started.
 */
export async function writeTrail(paths: { wallets: string; flows: string }, trail: { checked: Rows<string>; flows: Rows<Flow> }): Promise<{ rows: number; wallets: number; files: TrailFiles }> {
  let wallets = 0;
  let flows = 0;
  async function* walletLines(): AsyncIterable<string> {
    yield CHECKED_COLUMNS.join(',');
    for await (const address of trail.checked) {
      wallets++;
      yield line(CHECKED_COLUMNS, [address]);
    }
  }
  async function* flowLines(): AsyncIterable<string> {
    yield FLOW_COLUMNS.join(',');
    for await (const r of trail.flows) {
      flows++;
      yield line(FLOW_COLUMNS, [r.txHash, r.kind, r.from, r.to, r.valueWei, r.token, r.blockNumber, r.blockTime]);
    }
  }
  const walletsFile = await writeCompressed(paths.wallets, walletLines());
  let flowsFile: { bytes: number; sha256: string };
  try {
    flowsFile = await writeCompressed(paths.flows, flowLines());
  } catch (err) {
    // A trail is both files or neither: the wallets alone would read as a trail with no flows.
    await rm(paths.wallets, { force: true });
    throw err;
  }
  return { rows: flows, wallets, files: { wallets: walletsFile, flows: flowsFile } };
}

/**
 * A money trail from its two files, in batches of up to 5,000 rows, checked
 * addresses first. Both files are checked against `files` before the first
 * batch, as `readTransfers` checks its file, unless `verify` is false: the
 * caller found them matching already, and knows they have not changed since.
 */
export async function* readTrail(paths: { wallets: string; flows: string }, files: TrailFiles, verify = true): AsyncIterable<{ checked: string[]; flows: Flow[] }> {
  if (verify) {
    for (const which of ['wallets', 'flows'] as const) {
      const actual = await sha256File(paths[which]);
      if (actual !== files[which].sha256) throw mismatch(paths[which], actual, files[which].sha256);
    }
  }
  let checked: string[] = [];
  let header = true;
  for await (const text of readLines(paths.wallets, files.wallets.sha256, false)) {
    if (header) {
      expectHeader(paths.wallets, text, CHECKED_COLUMNS);
      header = false;
      continue;
    }
    checked.push(fields(paths.wallets, text, CHECKED_COLUMNS.length)[0]!);
    if (checked.length === BATCH) {
      yield { checked, flows: [] };
      checked = [];
    }
  }
  if (header) throw new StoredDataError(`${paths.wallets} is empty`);
  if (checked.length > 0) yield { checked, flows: [] };

  let flows: Flow[] = [];
  header = true;
  for await (const text of readLines(paths.flows, files.flows.sha256, false)) {
    if (header) {
      expectHeader(paths.flows, text, FLOW_COLUMNS);
      header = false;
      continue;
    }
    const f = fields(paths.flows, text, FLOW_COLUMNS.length);
    flows.push({
      txHash: f[0]!, kind: f[1] as FlowKind, from: f[2]!, to: f[3]!, valueWei: f[4]!, token: f[5]!,
      blockNumber: Number(f[6]), blockTime: Number(f[7]),
    });
    if (flows.length === BATCH) {
      yield { checked: [], flows };
      flows = [];
    }
  }
  if (header) throw new StoredDataError(`${paths.flows} is empty`);
  if (flows.length > 0) yield { checked: [], flows };
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

/** The decompressed lines of `path`, after its sha256 is checked (unless `verify` is false). Empty lines (the last newline) are skipped. */
async function* readLines(path: string, sha256: string, verify = true): AsyncIterable<string> {
  const actual = verify ? await sha256File(path) : sha256;
  if (actual !== sha256) throw mismatch(path, actual, sha256);
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

function mismatch(path: string, actual: string, expected: string): StoredDataError {
  return new StoredDataError(`${path} does not match its checksum (sha256 ${actual}, expected ${expected})`, 'mismatch');
}

function expectHeader(path: string, text: string, columns: readonly string[]): void {
  if (text !== columns.join(',')) throw new StoredDataError(`${path} has columns ${text}, expected ${columns.join(',')}`);
}

function fields(path: string, text: string, n: number): string[] {
  const f = text.split(',');
  if (f.length !== n) throw new StoredDataError(`${path} has a row of ${f.length} fields, expected ${n}`);
  return f;
}
