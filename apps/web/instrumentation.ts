/**
 * The api service's start: bring the store's schema up to date, so the API
 * can serve before the worker service has ever run. The polling itself is
 * the worker service's (apps/worker); this process never reads a chain.
 *
 * Next calls `register()` once per server, for the edge runtime as well as
 * Node, so the guard is required and the imports stay inside its branch:
 * `pg` and `worker_threads` must never reach an edge bundle, and the bundler
 * drops only an import written inside the branch itself. Not awaited past the
 * imports: a store still starting must not hold the API down. Migrations are idempotent and run
 * under a lock, so the api and worker services migrating together is safe.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [{ messageOf }, { store }] = await Promise.all([import('@washtrace/detect'), import('./lib/store')]);
    void migrate(store, messageOf);
  }
}

async function migrate(store: typeof import('./lib/store').store, messageOf: (err: unknown) => string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await store().migrate();
      return;
    } catch (err) {
      if (attempt === 1 || attempt % 10 === 0) console.error('[api] store not ready (attempt %d): %s', attempt, messageOf(err));
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * attempt)));
    }
  }
}
