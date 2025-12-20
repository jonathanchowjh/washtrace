import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Store, entryFor, messageOf, readManifest, storeUrl, storedDir, storedFile, upsertEntry, writeManifest, writeTransfers, writeTrail,
  type StoredEntry,
} from '@washtrace/detect';

/**
 * Cuts a collection's stored data from the local store, for the maintainer:
 *
 *   npm run stored -- <chainId>/<address> [--trail]
 *
 * Writes data/stored/<chainId>-<address>.transfers.csv.zst (committed), and
 * with --trail the money trail beside it (gitignored: upload it with
 * `gh release upload`), then the collection's manifest entry. Without
 * --trail an existing trail entry is kept: the base data and the trail are
 * re-cut on their own schedules. Only reads the store; never writes it.
 */

/** Where trail files are published: one release per cut day, as `stored-data-YYYY-MM-DD`. */
const RELEASES = 'https://github.com/jonathanchowjh/opensea-fraud-detector/releases/download';

const [target, ...flags] = process.argv.slice(2);
const match = /^(\d+)\/(0x[0-9a-fA-F]{40})$/.exec(target ?? '');
const unknown = flags.filter((f) => f !== '--trail');
if (!match || unknown.length > 0) {
  console.error('usage: npm run stored -- <chainId>/<address> [--trail]');
  process.exit(2);
}
const chainId = Number(match[1]);
const address = match[2]!.toLowerCase();
const withTrail = flags.includes('--trail');

// The same store the worker reads, found the same way. Its URL holds a password: never printed.
const store = Store.connect(storeUrl(process.env));
try {
  const head = await store.storedHeader(chainId, address);
  if (head === null) throw new Error(`${chainId}/${address} is not watched in this store`);
  if (head.startBlock === null || head.throughBlock === null) throw new Error(`${head.name} has not read any blocks yet`);
  if (head.throughTime === null) throw new Error(`${head.name} has no transfer with a block time at or below block ${head.throughBlock}`);

  const dir = storedDir(process.env);
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const previous = entryFor(await readManifest(manifestPath), chainId, address);

  const file = storedFile(chainId, address, 'transfers');
  const started = Date.now();
  const transfers = await writeTransfers(join(dir, file), store.storedTransfers(head.id, head.throughBlock));
  console.info('[stored] %s: %d transfers through block %d, %s, in %ds', file, transfers.rows, head.throughBlock, size(transfers.bytes), seconds(started));

  let trail: StoredEntry['trail'] = previous?.trail ?? null;
  if (withTrail) {
    const trailFile = storedFile(chainId, address, 'trail');
    const begun = Date.now();
    const { checked, of, wallets, flows } = await store.trail(head.id, chainId);
    const written = await writeTrail(join(dir, trailFile), { wallets, flows });
    const tag = `stored-data-${new Date().toISOString().slice(0, 10)}`;
    trail = { url: `${RELEASES}/${tag}/${trailFile}`, rows: written.rows, wallets: written.wallets, checked, of, bytes: written.bytes, sha256: written.sha256 };
    console.info('[stored] %s: %d wallets, %d flows, %d of %d traders checked, %s, in %ds', trailFile, written.wallets, written.rows, checked, of, size(written.bytes), seconds(begun));
    console.info('[stored] publish it with: gh release upload %s %s (create the release first if it does not exist)', tag, join(dir, trailFile));
  }

  const entry: StoredEntry = {
    chainId, address, name: head.name, startBlock: head.startBlock, throughBlock: head.throughBlock, throughTime: head.throughTime,
    transfers: { file, ...transfers }, trail,
  };
  await writeManifest(manifestPath, upsertEntry(await readManifest(manifestPath), entry));
  console.info('[stored] %s: manifest entry for %s written', manifestPath, head.name);
} catch (err) {
  console.error('[stored] %s', messageOf(err));
  process.exitCode = 1;
} finally {
  await store.pool.end().catch(() => {});
}

function size(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} MB`;
}

function seconds(since: number): number {
  return Math.round((Date.now() - since) / 1000);
}
