import { Store } from '@washtrace/detect';
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
