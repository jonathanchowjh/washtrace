// Times one collection's analysis stage by stage: reading its input, running
// the three methods, and saving the result. The worker does the same three
// in a row; this says which of them a slow analysis is spending its time in.
//
//   npm run --workspace @washtrace/detect build
//   WASHTRACE_STORE_URL=postgres://... node scripts/profile-analysis.mjs <collectionId> [--thread]
//
// It saves the analysis, as the worker would: point it at a store you may write to.
// The methods run in this process rather than a thread, so a --cpu-prof sees them.
// With --thread they run as the worker runs them instead: in the analysis
// thread, which reads its own input. Reading and the methods are then one
// stage, and the peak resident memory of the whole process is what to watch,
// since that is what a container's memory limit is held to.
import { Store, analyze, analyzeInThread, storeUrl, CUSTODIANS, contractsFor, moneyFor } from '../packages/detect/dist/index.js';

const id = Number(process.argv[2]);
const thread = process.argv.includes('--thread');
if (!Number.isInteger(id)) {
  console.error('usage: node scripts/profile-analysis.mjs <collectionId> [--thread]');
  process.exit(2);
}

// Sampled: the main thread is idle while the analysis thread works, so the timer keeps running.
let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);

const url = storeUrl(process.env);
const store = Store.connect(url);
try {
  const c = (await store.collections()).find((x) => x.id === id);
  if (!c) throw new Error(`No collection ${id}.`);
  const { rows } = await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id]);
  const version = Number(rows[0].version);
  console.log(`${c.name ?? c.address} (collection ${id}, chain ${c.chainId})${thread ? ', in the analysis thread' : ''}`);

  const time = async (fn) => {
    const started = performance.now();
    const value = await fn();
    return [value, Math.round(performance.now() - started)];
  };
  const settings = {
    fundingAvailable: true,
    custodians: new Set(CUSTODIANS),
    contracts: contractsFor(c.chainId),
    money: moneyFor(c.chainId),
    rules: c.rules,
  };
  const count = (result, method) => result.flags.filter((f) => f.method === method).length;
  const flagged = (result) => `${result.flags.length} flags (A ${count(result, 'A')}, AU ${count(result, 'AU')}, AC ${count(result, 'AC')})`;

  if (thread) {
    const [{ analysis, through }, threadMs] = await time(() => analyzeInThread({ storeUrl: url, id, chainId: c.chainId, ...settings }));
    const [, saveMs] = await time(() => store.saveAnalysis(id, version, analysis, threadMs, through));
    console.table({
      'analysisInput + analyze, in the thread': { ms: threadMs, rows: `${analysis.wallets} wallets, ${analysis.truncatedSearches} truncated searches` },
      saveAnalysis: { ms: saveMs, rows: flagged(analysis) },
      total: { ms: threadMs + saveMs, rows: '' },
    });
  } else {
    const [input, inputMs] = await time(() => store.analysisInput(id, c.chainId));
    const [result, analyzeMs] = await time(() => analyze({ ...input, ...settings }));
    const [, saveMs] = await time(() => store.saveAnalysis(id, version, result, inputMs + analyzeMs, input.through));
    console.table({
      analysisInput: { ms: inputMs, rows: `${input.transfers.length} transfers, ${input.payments.size} payments, ${input.funded.size} funded, ${input.truncated.size} truncated` },
      analyze: { ms: analyzeMs, rows: `${result.wallets} wallets, ${result.truncatedSearches} truncated searches` },
      saveAnalysis: { ms: saveMs, rows: flagged(result) },
      total: { ms: inputMs + analyzeMs + saveMs, rows: '' },
    });
  }
  console.log(`heap used ${Math.round(process.memoryUsage().heapUsed / 2 ** 20)} MB, peak rss ${Math.round(peakRss / 2 ** 20)} MB (sampled every 50 ms)`);
} finally {
  clearInterval(sampler);
  await store.pool.end();
}
