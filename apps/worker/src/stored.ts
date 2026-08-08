import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, type StoredEntry, cutCollection, entryFor, messageOf, parseTarget, readManifest, storeUrl, storedDir, upsertEntry, writeManifest } from '@washtrace/detect';

/**
 * Cuts a collection's stored data from the local store, for the maintainer:
 *
 *   npm run stored -- <chainId>/<address> [--trail]
 *
 * Writes data/stored/<chainId>-<address>.transfers.csv.zst (committed), and
 * with --trail the money trail beside it (gitignored: it stays on this
 * machine, and a worker here loads it), then the collection's manifest
 * entry. Without --trail an existing trail entry is kept: the base data and
 * the trail are re-cut on their own schedules. Only reads the store; never
 * writes it.
 */

const [target, ...flags] = process.argv.slice(2);
const parsed = parseTarget(target);
const unknown = flags.filter((f) => f !== '--trail');
if (!parsed || unknown.length > 0) {
  console.error('usage: npm run stored -- <chainId>/<address> [--trail]');
  process.exit(2);
}
const { chainId, address } = parsed;
const withTrail = flags.includes('--trail');

let store: Store | undefined;
try {
  // The same store the worker reads, found the same way. Its URL holds a password: never printed.
  store = Store.connect(storeUrl(process.env));
  const dir = storedDir(process.env);
  await mkdir(dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const previous = entryFor(await readManifest(manifestPath), chainId, address);

  const cut = await cutCollection(store, dir, chainId, address, { trail: withTrail });
  const entry: StoredEntry = withTrail ? cut : { ...cut, trail: previous?.trail ?? null };
  await writeManifest(manifestPath, upsertEntry(await readManifest(manifestPath), entry));
  console.info('[stored] %s: manifest entry for %s written', manifestPath, entry.name);
} catch (err) {
  console.error('[stored] %s', messageOf(err));
  process.exitCode = 1;
} finally {
  await store?.pool.end().catch(() => {});
}
