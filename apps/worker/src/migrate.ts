import { Store, messageOf } from '@washtrace/detect';

/**
 * Migrates the store at the URL given on the command line, and only that
 * one: no environment fallback, so it cannot reach a live store by accident.
 * Used by scripts/publish-prep.sh on its throwaway.
 *
 *   npm run migrate -- <store url>
 */

const url = process.argv[2];
if (!url) {
  console.error('usage: npm run migrate -- <store url>');
  process.exit(2);
}

const store = Store.connect(url);
try {
  console.info('[migrate] store is at schema version %d', await store.migrate());
} catch (err) {
  console.error('[migrate] %s', messageOf(err));
  process.exitCode = 1;
} finally {
  await store.pool.end().catch(() => {});
}
