import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { EVERY, Store, Worker, messageOf, storeUrl, storedDir, workerConfig } from '@washtrace/detect';

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

// A load of stored data that was running when the last worker died rolled
// back, but the progress it showed was written outside it: clear it, or the
// console says "Loading stored data" for ever. Before the first pass, which
// may start a load of its own.
await store.clearRestoreProgress().catch((err) => console.warn('[worker] stale stored-data progress not cleared: %s', messageOf(err)));
// The same for a download that was running: its part file is kept, and the next pass resumes it.
await store.clearDownloads().catch((err) => console.warn('[worker] stale download progress not cleared: %s', messageOf(err)));

// Stored data is data/stored at the repo root (/app in the image), wherever
// the process was started from: `npm run worker` starts it in apps/worker.
const root = fileURLToPath(new URL('../../..', import.meta.url));

// The environment wins over the console's settings, which each pass re-reads.
const worker = new Worker(store, (s) => workerConfig(process.env, s), url, storedDir(process.env, root));
worker.start();
// A Test asked for in the console is heard at once over LISTEN, not next pass.
void worker.listen();

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
    // A pass still running holds its pool client, and end() waits for it, so
    // it is given a second, not the rest of the pass: an analysis outlasts
    // the SIGKILL. Exiting drops the connection; Postgres rolls the pass back
    // and frees its lock, as a crash would.
    await Promise.race([store.pool.end().catch(() => {}), new Promise((r) => setTimeout(r, 1_000))]);
    process.exit(0);
  });
}
