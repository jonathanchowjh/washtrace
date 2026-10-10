import { STORED_REPO, Store, messageOf } from '@washtrace/detect';
import { PUBLISH_USAGE, Publisher, parsePublishArgs } from './publish.js';

/**
 * Publishes stored data to the Hugging Face dataset, for the maintainer:
 *
 *   npm run publish:hub -- --store <url> [--dry-run] [<chainId>/<address> ...]
 *
 * `--store` is required and is the throwaway scripts/publish-prep.sh printed:
 * the store environment variable is never used here, so a live store is
 * never cut by accident. The token is HF_TOKEN (from .env or the
 * environment); it is never printed.
 *
 *   npm run publish:hub -- --from <dir> [--check]
 *
 * uploads a folder a dry run wrote, as it stands, after reading every row of
 * it against its manifest. `--check` only verifies, and needs no token. A
 * store is not used, so `--from` refuses `--store`, `--dry-run` and names.
 */

const parsed = parsePublishArgs(process.argv.slice(2));
if (!parsed) {
  console.error(PUBLISH_USAGE);
  process.exit(2);
}
const { dryRun, check, url, from, names } = parsed;

const token = process.env.HF_TOKEN?.trim() || undefined;
const repo = process.env.WASHTRACE_STORED_REPO?.trim() || STORED_REPO;
if (from !== undefined) {
  try {
    console.info('[publish] %s', await new Publisher(null, token, repo).runFrom(from, { check }));
  } catch (err) {
    console.error('[publish] %s', messageOf(err));
    process.exitCode = 1;
  }
} else {
  const store = Store.connect(url!);
  try {
    const result = await new Publisher(store, token, repo).run(names, { dryRun });
    console.info(dryRun ? '[publish] dry run written to %s' : '[publish] %s', result);
  } catch (err) {
    console.error('[publish] %s', messageOf(err));
    process.exitCode = 1;
  } finally {
    await store.pool.end().catch(() => {});
  }
}
