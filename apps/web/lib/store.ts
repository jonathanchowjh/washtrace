import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, entryFor, parseManifest, storedDir, type Manifest, type StoredEntry } from '@washtrace/detect';
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
 * The stored-data manifest the worker fetched and cached, or null when there
 * is none yet or it cannot be read: the console then says "not checked yet"
 * and never fails over it. It is data/stored at the repo root, two up from
 * where Next runs (apps/web, in dev and in the image alike), unless
 * WASHTRACE_STORED_DIR says otherwise, as for the worker. A missing file is
 * null, not an empty manifest (readManifest's reading): the two differ for a
 * reader, "none checked yet" against "none has stored data".
 */
export async function storedManifest(): Promise<Manifest | null> {
  try {
    return parseManifest(await readFile(join(storedDir(process.env, join(process.cwd(), '..', '..')), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** A collection's entry in the manifest, or null: what the console says of its stored data, such as how many traders its money trail checked. */
export async function storedEntry(chainId: number, address: string): Promise<StoredEntry | null> {
  const m = await storedManifest();
  return m === null ? null : entryFor(m, chainId, address);
}
