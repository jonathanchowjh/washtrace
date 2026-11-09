// Measures one Preview on real data, as the worker runs it: the run's full input
// is read, then the lens judges a seeded sample of 2,000 sales. It prints the
// sample's search time, the load time, the total, the peak and the result.
//
// It reads the transfers up to the latest analysis's through block, as the worker's
// preview job does, and runs `previewStored` in this process, not in a thread: the
// body is the same, and the memory this process reaches is then the memory measured.
//
//   npm run --workspace @washtrace/detect build
//   WASHTRACE_STORE_URL=postgres://... node scripts/profile-preview.mjs <collectionId> <A|AU|AC|rule.json|default>
//
// Read-only: it never migrates and calls no Store write. `previewStored` saves
// nothing and needs no `lens_previews` row, only a number to seed the sample, so
// a fixed one is given (Preview's own seed is its row's id). Every connection
// carries default_transaction_read_only=on, added here to whatever URL it is
// given. The URL holds a password and is never printed.
//
// "Peak" is the process's peak resident memory and peak heap, sampled every 50 ms
// and once at the first progress report and at the end. The search is synchronous
// and holds the timer for its length, so a sample inside it is missed; the peak is
// then what the load and the search's edges reached, and a lower bound on it.
import { readFileSync } from 'node:fs';
import { Store, storeUrl } from '../packages/detect/dist/index.js';
import { previewStored } from '../packages/detect/dist/lens-thread.js';
import { COPIES, DEFAULT_RULE, checkRule } from '../packages/detect/dist/lens-rule.js';
import { PREVIEW_SAMPLE } from '../packages/detect/dist/store.js';

const SEED = 1;

const id = Number(process.argv[2]);
const which = process.argv[3];
if (!Number.isInteger(id) || !which) {
  console.error('usage: node scripts/profile-preview.mjs <collectionId> <A|AU|AC|path/to/rule.json|default>');
  process.exit(2);
}

function ruleFor(arg) {
  if (arg === 'default') return DEFAULT_RULE;
  if (COPIES[arg]) return COPIES[arg].rule;
  const checked = checkRule(JSON.parse(readFileSync(arg, 'utf8')));
  if ('error' in checked) throw new Error(`${arg}: ${checked.error}`);
  return checked.rule;
}

function readOnly(raw) {
  const url = new URL(raw);
  const options = url.searchParams.get('options');
  url.searchParams.set('options', `${options ? `${options} ` : ''}-c default_transaction_read_only=on`);
  return url.toString();
}

const rule = ruleFor(which);
const MB = (bytes) => Math.round(bytes / 2 ** 20);

let peakRss = 0;
let peakHeap = 0;
function measure() {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  peakHeap = Math.max(peakHeap, m.heapUsed);
}
const sampler = setInterval(measure, 50);

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

  // The sample alone, as previewStored asks for it: the one query that orders every sale by a hash.
  const sampling = performance.now();
  const keys = await store.previewSample(id, SEED, through);
  const sampleMs = Math.round(performance.now() - sampling);
  console.log(`sample of ${keys.length} sales (at most ${PREVIEW_SAMPLE}), read through block ${through ?? 'the latest (no analysis yet)'}`);

  // The search reports progress only once it starts, so the first report ends the load.
  const started = performance.now();
  let loadMs = null;
  const result = await previewStored(
    store,
    { storeUrl: url, previewId: SEED, collectionId: id, chainId: c.chain_id, rule, through },
    () => { if (loadMs === null) { loadMs = Math.round(performance.now() - started); measure(); } },
  );
  measure();
  const totalMs = Math.round(performance.now() - started);

  console.table({ [which]: {
    'sample ms': sampleMs, 'load ms': loadMs ?? 'n/a', 'total ms': totalMs,
    'peak rss MB': MB(peakRss), 'peak heap MB': MB(peakHeap),
  } });
  console.log(result);
} finally {
  clearInterval(sampler);
  await store.pool.end();
}
