// Times one collection's analysis stage by stage: reading its input, running
// the three methods, and saving the result. The worker does the same three
// in a row; this says which of them a slow analysis is spending its time in.
//
//   npm run --workspace @washtrace/detect build
//   WASHTRACE_STORE_URL=postgres://... node scripts/profile-analysis.mjs <collectionId>
//
// It saves the analysis, as the worker would: point it at a store you may write to.
// The methods run in this process rather than a thread, so a --cpu-prof sees them.
import { Store, analyze, storeUrl, CUSTODIANS, contractsFor, moneyFor } from '../packages/detect/dist/index.js';

const id = Number(process.argv[2]);
if (!Number.isInteger(id)) {
  console.error('usage: node scripts/profile-analysis.mjs <collectionId>');
  process.exit(2);
}

const store = Store.connect(storeUrl(process.env));
try {
  const c = (await store.collections()).find((x) => x.id === id);
  if (!c) throw new Error(`No collection ${id}.`);
  const { rows } = await store.pool.query('SELECT version FROM washtrace.collections WHERE id = $1', [id]);
  const version = Number(rows[0].version);
  console.log(`${c.name ?? c.address} (collection ${id}, chain ${c.chainId})`);

  const time = async (fn) => {
    const started = performance.now();
    const value = await fn();
    return [value, Math.round(performance.now() - started)];
  };

  const [input, inputMs] = await time(() => store.analysisInput(id, c.chainId));
  const [result, analyzeMs] = await time(() => analyze({
    ...input,
    fundingAvailable: true,
    custodians: new Set(CUSTODIANS),
    contracts: contractsFor(c.chainId),
    money: moneyFor(c.chainId),
    rules: c.rules,
  }));
  const [, saveMs] = await time(() => store.saveAnalysis(id, version, result, inputMs + analyzeMs, input.through));

  const count = (method) => result.flags.filter((f) => f.method === method).length;
  console.table({
    analysisInput: { ms: inputMs, rows: `${input.transfers.length} transfers, ${input.flows.length} flows, ${input.funded.size} funded, ${input.truncated.size} truncated` },
    analyze: { ms: analyzeMs, rows: `${result.wallets} wallets, ${result.truncatedSearches} truncated searches` },
    saveAnalysis: { ms: saveMs, rows: `${result.flags.length} flags (A ${count('A')}, AU ${count('AU')}, AC ${count('AC')})` },
    total: { ms: inputMs + analyzeMs + saveMs, rows: '' },
  });
  console.log(`heap used ${Math.round(process.memoryUsage().heapUsed / 2 ** 20)} MB`);
} finally {
  await store.pool.end();
}
