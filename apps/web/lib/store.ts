import { join } from 'node:path';
import { Store, entryFor, readManifest, storedDir, type StoredEntry } from '@washtrace/detect';
import { storeUrl } from './config';

/**
 * One Store per process, kept on globalThis: the dev server re-evaluates
 * modules on every edit, and each evaluation would otherwise open a new
 * pool and strand the last one's connections.
 */
const HELD = globalThis as unknown as { washtraceStore?: { url: string; store: Store } };

export function store(): Store {
  const url = storeUrl(process.env);
  if (HELD.washtraceStore?.url !== url) {
    void HELD.washtraceStore?.store.pool.end().catch(() => {});
    HELD.washtraceStore = { url, store: Store.connect(url) };
  }
  return HELD.washtraceStore.store;
}

/**
 * A collection's entry in the stored-data manifest, or null: what the
 * console says of its stored data, such as how many traders its money trail
 * checked. The manifest is data/stored at the repo root, two up from where
 * Next runs (apps/web, in dev and in the image alike), unless
 * WASHTRACE_STORED_DIR says otherwise, as for the worker. One that cannot be
 * read is no entry: the page says less, and never fails over it.
 */
export async function storedEntry(chainId: number, address: string): Promise<StoredEntry | null> {
  try {
    return entryFor(await readManifest(join(storedDir(process.env, join(process.cwd(), '..', '..')), 'manifest.json')), chainId, address);
  } catch {
    return null;
  }
}
