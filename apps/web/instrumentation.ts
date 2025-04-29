/**
 * The polling half of the service, started inside the API's own process.
 * Next calls `register()` once per server, for the edge runtime as well as
 * Node, so the guard is required and the imports stay inside it: `pg` and
 * viem must never reach an edge bundle.
 *
 * Not awaited past the first line: `register()` must finish before the server
 * takes requests, and a store still starting (an ordinary compose ordering)
 * must not hold the API down. Boot retries until the store answers.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  void boot();
}

async function boot(): Promise<void> {
  const [{ Worker, messageOf }, { store }, { workerConfig, workerEnabled }] = await Promise.all([
    import('@washtrace/detect'),
    import('./lib/store'),
    import('./lib/config'),
  ]);
  for (let attempt = 1; ; attempt++) {
    try {
      await store().migrate();
      break;
    } catch (err) {
      if (attempt === 1 || attempt % 10 === 0) console.error('[washtrace] store not ready (attempt %d): %s', attempt, messageOf(err));
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * attempt)));
    }
  }
  if (!workerEnabled(process.env)) {
    console.info('[washtrace] WASHTRACE_WORKER=off: serving the API only.');
    return;
  }
  const worker = new Worker(store(), () => workerConfig(process.env));
  worker.start();
  const config = workerConfig(process.env);
  console.info(
    '[washtrace] worker started: RPC for %s; funding %s.',
    config.rpc.size === 0 ? 'no chain (set WASHTRACE_RPC_<chainId>)' : `chain ${[...config.rpc.keys()].join(', ')}`,
    config.etherscanKey === null ? 'off (set WASHTRACE_ETHERSCAN_KEY), so SCC AU and AC are unavailable' : 'from Etherscan',
  );
}
