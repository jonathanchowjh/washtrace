import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { EVERY, Store, Worker, storeUrl, storedDir, workerConfig } from '@washtrace/detect';
import { Migrating } from './migrating.js';

/**
 * The worker service: the polling half of washtrace, as its own process.
 *
 * It reads chains and Etherscan on timers and writes the store, and runs the
 * console's Tests of an RPC or a key when asked. It serves no API; the api
 * service reads what it wrote. Run one, or several: each pass
 * takes its job's advisory lock without waiting, so N replicas do one
 * worker's work, and a replica that dies mid-pass leaves the lock to the next.
 *
 * Its only port is a health check, for the orchestrator.
 */

const PORT = Number(process.env.WASHTRACE_WORKER_PORT ?? 8081);

const url = storeUrl(process.env);
const store = Store.connect(url);

/** The worker once it has started; null while the store is still migrating. */
let started: Worker | null = null;
const migrating = new Migrating(store, url);

// GET /health: 200 while the store answers. Listening before the store is
// migrated, and answering `migrating` meanwhile, 200 until an attempt fails
// (see Migrating.health). The image's HEALTHCHECK passes on any 2xx. Also what
// holds the process open: the worker's own timers are unref'd, so a worker
// embedded in another process never keeps that process alive by itself.
const health = createServer(async (req, res) => {
  if (req.url !== '/health') { res.writeHead(404).end(); return; }
  if (started === null) {
    const { status, body } = migrating.health();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  let ok = true;
  try { await store.pool.query('SELECT 1'); } catch { ok = false; }
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok, busy: started.busy }));
});
health.listen(PORT, () => console.info('[worker] health on :%d/health', PORT));

await migrating.run();

// Stored data is data/stored at the repo root (/app in the image), wherever
// the process was started from: `npm run worker` starts it in apps/worker.
const root = fileURLToPath(new URL('../../..', import.meta.url));

// A value saved in the console wins over the environment; each pass re-reads the console's settings.
const worker = new Worker(store, (s) => workerConfig(process.env, s), url, storedDir(process.env, root));
// Before the first pass, which may start a load of its own.
await worker.sync.clearStaleProgress();
worker.start();
started = worker;
// A Test asked for in the console is heard at once over LISTEN, not next pass.
void worker.checks.listen();

// Chain ids and on/off only: never an RPC URL or the key.
const config = workerConfig(process.env, await store.settings().catch(() => new Map<string, string>()));
console.info(
  '[worker] started: ingest every %ds, fund every %ds, analyze every %ds; RPC for %s; funding %s; following money %d hops out.',
  EVERY.ingest / 1000, EVERY.fund / 1000, EVERY.analyze / 1000,
  config.rpc.size === 0 ? 'no chain (set WASHTRACE_RPC_<chainId> or an RPC in Settings)' : `chain ${[...config.rpc.keys()].join(', ')}`,
  config.etherscanKey === null ? 'off (set WASHTRACE_ETHERSCAN_KEY or the key in Settings), so Linked wallets and Money loops back are unavailable' : 'from Etherscan',
  config.followHops,
);

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
    // A pass still running holds its pool client, and end() waits for it, so
    // it is given a second, not the rest of the pass: an analysis outlasts
    // the SIGKILL. Exiting drops the connection; Postgres rolls the pass back
    // and frees its lock, as a crash would.
    await Promise.race([store.pool.end().catch(() => {}), new Promise((r) => setTimeout(r, 1_000))]);
    process.exit(0);
  });
}
