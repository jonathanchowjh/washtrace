import { createServer } from 'node:http';
import { EVERY, Store, Worker, messageOf, storeUrl, workerConfig } from '@washtrace/detect';

/**
 * The worker service: the polling half of washtrace, as its own process.
 *
 * It reads chains and Etherscan on timers and writes the store. It serves no
 * API; the api service reads what it wrote. Run one, or several: each pass
 * takes its job's advisory lock without waiting, so N replicas do one
 * worker's work, and a replica that dies mid-pass leaves the lock to the next.
 *
 * Its only port is a health check, for the orchestrator.
 */

const PORT = Number(process.env.WASHTRACE_WORKER_PORT ?? 8081);

const url = storeUrl(process.env);
const store = Store.connect(url);

// The store may still be starting (an ordinary compose or k8s ordering):
// keep trying rather than crash-looping.
for (let attempt = 1; ; attempt++) {
  try {
    await store.migrate();
    break;
  } catch (err) {
    if (attempt === 1 || attempt % 10 === 0) console.error('[worker] store not ready (attempt %d): %s', attempt, messageOf(err));
    await new Promise((r) => setTimeout(r, Math.min(30_000, 1_000 * attempt)));
  }
}

// The environment wins over the console's settings, which each pass re-reads.
const worker = new Worker(store, (s) => workerConfig(process.env, s), url);
worker.start();

// Chain ids and on/off only: never an RPC URL or the key.
const config = workerConfig(process.env, await store.settings().catch(() => new Map<string, string>()));
console.info(
  '[worker] started: ingest every %ds, fund every %ds, analyze every %ds; RPC for %s; funding %s; following money %d hops out.',
  EVERY.ingest / 1000, EVERY.fund / 1000, EVERY.analyze / 1000,
  config.rpc.size === 0 ? 'no chain (set WASHTRACE_RPC_<chainId> or an RPC in Settings)' : `chain ${[...config.rpc.keys()].join(', ')}`,
  config.etherscanKey === null ? 'off (set WASHTRACE_ETHERSCAN_KEY or the key in Settings), so SCC AU and AC are unavailable' : 'from Etherscan',
  config.followHops,
);

// GET /health: 200 while the store answers. Also what holds the process
// open: the worker's own timers are unref'd, so a worker embedded in another
// process never keeps that process alive by itself.
const health = createServer(async (req, res) => {
  if (req.url !== '/health') { res.writeHead(404).end(); return; }
  let ok = true;
  try { await store.pool.query('SELECT 1'); } catch { ok = false; }
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok, busy: worker.busy }));
});
health.listen(PORT, () => console.info('[worker] health on :%d/health', PORT));

// docker stop sends SIGTERM, then SIGKILL ten seconds later.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.info('[worker] %s: finishing passes in flight (%s)', signal, worker.busy.join(', ') || 'none');
    worker.stop();
    health.close();
    await worker.drain(8_000);
    await store.pool.end().catch(() => {});
    process.exit(0);
  });
}
