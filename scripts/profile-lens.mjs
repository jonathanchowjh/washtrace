// @ts-check
// Measures one lens run on real data, as the worker runs it: the input is read and
// the search run in a lens thread. For the Round trips copy (A) it also checks the
// flags against the ones the collection's stored analysis holds.
//
// It reads the transfers up to the latest analysis's through block, as the worker's
// lens job does, so A is judged on the same trades as the stored flags and
// transfers ingested since then show no difference.
//
//   npm run --workspace @washtrace/detect build
//   WASHTRACE_STORE_URL=postgres://... node scripts/profile-lens.mjs <collectionId> <A|AU|AC|rule.json|default>
//
// Read-only: it never migrates and calls no Store write. Every connection, the
// thread's too, carries default_transaction_read_only=on, added here to whatever
// URL it is given. The URL holds a password and is never printed.
//
// "Peak" is the process's peak resident memory, sampled every 50 ms: the search
// runs in a thread whose own heap the main thread cannot read, and the resident
// size is what a container's limit is held to and is never below the heap.
import { Store, storeUrl } from '../packages/detect/dist/index.js';
import { runLensInThread } from '../packages/detect/dist/lens-thread.js';
import { FOLLOW_HOPS, PAYEES, readOnly, ruleFor } from './profile-shared.mjs';

const id = Number(process.argv[2]);
const which = process.argv[3];
if (!Number.isInteger(id) || !which) {
  console.error('usage: node scripts/profile-lens.mjs <collectionId> <A|AU|AC|path/to/rule.json|default>');
  process.exit(2);
}

const rule = ruleFor(which);

// Sampled: the main thread is idle while the lens thread works, so the timer keeps running.
let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);

const url = readOnly(storeUrl(process.env));
const store = Store.connect(url);
try {
  // Not store.collections(): it selects columns a later migration adds, and this must run on a store that has not had it.
  const { rows: [c] } = await store.pool.query('SELECT chain_id, address FROM washtrace.collections WHERE id = $1', [id]);
  if (!c) throw new Error(`No collection ${id}.`);
  console.log(`${c.address} (collection ${id}, chain ${c.chain_id}), rule ${which}`);

  const { rows: [a] } = await store.pool.query(
    'SELECT through_block FROM washtrace.analyses WHERE collection_id = $1 ORDER BY ran_at DESC, id DESC LIMIT 1', [id]);
  const through = a?.through_block == null ? null : Number(a.through_block);

  const started = performance.now();
  const { totals, flags } = await runLensInThread(
    { storeUrl: url, lensId: 0, collectionId: id, chainId: c.chain_id, rule, through, followHops: FOLLOW_HOPS, payees: PAYEES },
    () => {},
  );
  const ms = Math.round(performance.now() - started);

  console.table({ [which]: {
    ms, flagged: flags.length, truncated: totals.truncated, untimed: totals.untimed,
    'peak rss MB': Math.round(peakRss / 2 ** 20),
  } });

  if (which === 'A') {
    const { rows } = await store.pool.query(
      `SELECT tx_hash, log_index FROM washtrace.flags WHERE collection_id = $1 AND method = 'A'`, [id]);
    const key = (tx, i) => `${tx}:${i}`;
    const stored = new Set(rows.map((r) => key(r.tx_hash, r.log_index)));
    const lens = new Set(flags.map((f) => key(f.txHash, f.logIndex)));
    const onlyLens = [...lens].filter((k) => !stored.has(k));
    const onlyStored = [...stored].filter((k) => !lens.has(k));
    const { rows: [t] } = await store.pool.query(
      'SELECT max(block_number) AS latest FROM washtrace.transfers WHERE collection_id = $1', [id]);
    console.log(`stored A flags ${stored.size}, lens flags ${lens.size}; only in lens ${onlyLens.length}, only in stored ${onlyStored.length}`);
    console.log(`read through block ${through ?? 'the latest (no analysis yet)'}, latest transfer block ${t?.latest ?? 'none'}`);
    for (const k of onlyLens.slice(0, 10)) console.log(`  only in lens:   ${k}`);
    for (const k of onlyStored.slice(0, 10)) console.log(`  only in stored: ${k}`);
  }
} finally {
  clearInterval(sampler);
  await store.pool.end();
}
