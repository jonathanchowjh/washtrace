import { STORED_REPO, Store, messageOf } from '@washtrace/detect';
import { Publisher } from './publish.js';

/**
 * Publishes stored data to the Hugging Face dataset, for the maintainer:
 *
 *   npm run publish:hub -- --store <url> [--dry-run] [<chainId>/<address> ...]
 *
 * `--store` is required and is the throwaway scripts/publish-prep.sh printed:
 * the store environment variable is never used here, so a live store is
 * never cut by accident. The token is HF_TOKEN (from .env or the
 * environment); it is never printed.
 */

let dryRun = false;
let url: string | undefined;
const names: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--store') url = args[++i];
  else names.push(args[i]!);
}

if (!url || url.startsWith('--') || names.some((n) => n.startsWith('--'))) {
  console.error('usage: npm run publish:hub -- --store <url> [--dry-run] [<chainId>/<address> ...]');
  process.exit(2);
}

const store = Store.connect(url);
try {
  const publisher = new Publisher(store, process.env.HF_TOKEN?.trim() || undefined, process.env.WASHTRACE_STORED_REPO?.trim() || STORED_REPO);
  const result = await publisher.run(names, { dryRun });
  console.info(dryRun ? '[publish] dry run written to %s' : '[publish] %s', result);
} catch (err) {
  console.error('[publish] %s', messageOf(err));
  process.exitCode = 1;
} finally {
  await store.pool.end().catch(() => {});
}
