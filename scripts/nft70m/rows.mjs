// Reads the rows of the NFT-70M sales CSV (see extract.py) as washtrace
// Transfers, one collection at a time, so the survey never holds more than one
// collection, and builds the survey's rows and summary.
// Imported by survey.mjs; unit tested in rows.test.mjs.
import { CUSTODIANS, Payments, WRAPPED, contractsFor, moneyFor } from '@washtrace/detect';

/** The WETH contract, which washtrace prices as ETH-equivalent. */
export const WETH = WRAPPED[1][0];

/** The extract's header; a file with any other was made by another extract.py. */
export const HEADER = 'contract,token,ts,seller,buyer,price,currency';

/**
 * Converts a decimal price to wei at gwei precision, because the dataset's
 * prices are floats and carry no finer digits. Null when empty or not finite.
 */
export function weiOf(price) {
  const n = Number(price);
  if (price === '' || !Number.isFinite(n)) return null;
  return String(BigInt(Math.round(n * 1e9)) * 1_000_000_000n);
}

/**
 * One CSV line as a row. `ts` is NaN when empty; `ok` says the row has what a
 * Transfer needs (a token, a seller, a buyer and a time).
 */
export function parse(line) {
  const [contract, token, ts, seller, buyer, price, currency] = line.split(',');
  const t = ts === '' ? NaN : Number(ts);
  return { contract, token, ts: t, seller, buyer, price, currency, ok: !!token && !!seller && !!buyer && Number.isFinite(t) };
}

/**
 * A parsed row with `ok` true as a Transfer. `i` is the sale's place in its
 * token's ordered sales: the dataset has no block number or log index, and
 * `analyze()` orders by blockNumber then logIndex, so `i` carries the order
 * within a second.
 */
export function toTransfer(f, i) {
  const priced = f.currency === 'ETH' || f.currency === 'WETH';
  return {
    txHash: `nft70m:${f.contract}:${f.token}:${i}`,
    logIndex: i,
    blockNumber: f.ts,
    blockTime: f.ts,
    tokenId: f.token,
    from: f.seller,
    to: f.buyer,
    marketplace: 'opensea',
    priceWei: priced ? weiOf(f.price) : null,
    currency: priced ? (f.currency === 'WETH' ? WETH : '') : null,
  };
}

/**
 * Orders sales (sorted by token, then ts) within each second by who held the
 * token; the dataset has no block number or log index, so the chain of owners
 * is the only order there is, and this is the only place that decides it.
 * In a run of one token and one ts, take in turn:
 *  1. a sale whose seller is the previous buyer; among several, one whose buyer
 *     sells again in the run, so the chain is not ended early (a->b then a->c,
 *     c->a leaves a b->a gap the engine bridges as a false cycle); then file order.
 *  2. else the run's single head: the one sale whose seller is no other
 *     remaining sale's buyer.
 *  3. else the first left, a guess.
 * `ties` counts runs of two or more, `guessed` those that needed rule 3 (at
 * most once per run), so guessed <= ties. Every sale is kept.
 */
export function chainOrder(sales) {
  const out = [];
  let ties = 0;
  let guessed = 0;
  let prev = null;
  for (let a = 0; a < sales.length; ) {
    let b = a + 1;
    while (b < sales.length && sales[b].ts === sales[a].ts && sales[b].token === sales[a].token) b++;
    if (sales[a].token !== sales[a - 1]?.token) prev = null;
    const rest = sales.slice(a, b);
    let guessedHere = false;
    if (rest.length > 1) ties++;
    while (rest.length) {
      let k = -1;
      const fits = rest.map((s, i) => i).filter((i) => rest[i].seller === prev);
      if (fits.length) {
        k = fits.find((i) => rest.some((s, j) => j !== i && s.seller === rest[i].buyer)) ?? fits[0];
      } else if (rest.length > 1) {
        const heads = rest.map((s, i) => i).filter((i) => !rest.some((s, j) => j !== i && s.buyer === rest[i].seller));
        if (heads.length === 1) k = heads[0];
        else { k = 0; guessedHere = true; }
      } else {
        k = 0;
      }
      const [s] = rest.splice(k, 1);
      out.push(s);
      prev = s.buyer;
    }
    if (guessedHere) guessed++;
    a = b;
  }
  return { sales: out, ties, guessed };
}

/**
 * Yields one group per contract, the last included. The file is sorted by
 * contract, so a contract that returns after ending means unsorted input; that
 * throws rather than split a collection in two and halve its share.
 */
export async function* byCollection(lines) {
  const seen = new Set();
  let group = null;
  let token = null;
  let tokens = new Set();
  let rows = [];

  const flush = () => {
    const ordered = chainOrder(rows);
    group.ties += ordered.ties;
    group.guessed += ordered.guessed;
    ordered.sales.forEach((f, i) => group.transfers.push(toTransfer(f, i)));
    rows = [];
  };

  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      if (line !== HEADER) throw new Error(`sales file has header "${line}"; expected "${HEADER}". Rerun extract.py.`);
      continue;
    }
    if (!line) continue;
    const f = parse(line);
    if (!group || f.contract !== group.contract) {
      if (group) { flush(); yield group; }
      if (seen.has(f.contract)) throw new Error(`input not sorted: contract ${f.contract} appears again`);
      seen.add(f.contract);
      group = { contract: f.contract, transfers: [], skipped: 0, ties: 0, guessed: 0 };
      token = null;
      tokens = new Set();
    }
    if (!f.ok) { group.skipped++; continue; }
    if (f.token !== token) {
      flush();
      // A token seen again would restart at 0 and repeat txHash and logIndex.
      if (tokens.has(f.token)) throw new Error(`input not sorted: token ${f.token} of contract ${f.contract} appears again`);
      tokens.add(f.token);
      token = f.token;
    }
    rows.push(f);
  }
  // No line at all: an empty or cut-off download would otherwise summarise to zeros that read like a result.
  if (header) throw new Error(`sales file is empty; expected header "${HEADER}". Rerun extract.py.`);
  if (group) { flush(); yield group; }
}

/**
 * The input `analyze()` takes for a bare list of sales. The dataset has no
 * money flows, so only Round trips (SCC A) can run: funding is unavailable.
 * Custodians and contracts are passed because the `Input` type requires them;
 * they are inert on anonymised IDs, which match no address.
 */
export function surveyInput(transfers) {
  return {
    transfers,
    payments: new Payments(),
    fundingAvailable: false,
    funded: new Set(),
    truncated: new Set(),
    custodians: new Set(CUSTODIANS),
    contracts: contractsFor(1),
    money: moneyFor(1),
  };
}

const eth = (wei) => Number(BigInt(wei)) / 1e18;

/**
 * One CSV row per collection. `share` is flaggedSales / sales, the share the
 * console's lens cards show. Dates come from blockTime in seconds. `ties`,
 * `guessed` and `skipped` come from the group, so a collection's ordering and
 * dropped rows can be read beside its share.
 */
export function surveyRow(group, analysis, tookMs) {
  const { contract, transfers } = group;
  const a = analysis.totals.A;
  // A loop, not Math.min(...times): spreading 150,000+ values overflows the stack.
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of transfers) {
    if (t.blockTime < lo) lo = t.blockTime;
    if (t.blockTime > hi) hi = t.blockTime;
  }
  const iso = (sec) => new Date(sec * 1000).toISOString();
  return {
    contract,
    sales: a.sales,
    // The flagged sets, not the collection's: analyze() counts only what a cycle touched.
    flaggedTokens: a.tokens,
    flaggedWallets: a.wallets,
    first: transfers.length ? iso(lo) : '',
    last: transfers.length ? iso(hi) : '',
    share: a.sales ? a.flaggedSales / a.sales : 0,
    flaggedSales: a.flaggedSales,
    volumeEth: eth(a.volumeWei),
    flaggedVolumeEth: eth(a.flaggedVolumeWei),
    missingData: analysis.missingData,
    ties: group.ties,
    guessed: group.guessed,
    skipped: group.skipped,
    tookMs,
  };
}

/** Collections with fewer sales stay out of the bands: a share of ten sales says little. */
export const MIN_SALES = 100;

/** The shares of sales flagged at which a collection counts as high or mid. */
export const BANDS = { high: 0.5, mid: 0.1 };

/**
 * Population figures over all collections. Only collections with at least
 * MIN_SALES sales go into the bands; every collection counts in the totals.
 * `missingShare` weights each collection's missingData by its sales (in the
 * survey sales equal moves), and `top5VolumeShare` says how much of the flagged
 * ETH sits in a few collections, which the totals alone hide.
 */
export function summarize(rows) {
  const eligible = rows.filter((r) => r.sales >= MIN_SALES);
  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  const sales = sum('sales');
  const flaggedSales = sum('flaggedSales');
  const volume = sum('volumeEth');
  const flaggedVolume = sum('flaggedVolumeEth');
  // Only collections with flagged volume: with fewer than five, a zero would read as one of the largest.
  const largest = rows.filter((r) => r.flaggedVolumeEth > 0).sort((x, y) => y.flaggedVolumeEth - x.flaggedVolumeEth).slice(0, 5);
  const top5 = largest.reduce((n, r) => n + r.flaggedVolumeEth, 0);
  return {
    collections: rows.filter((r) => r.sales > 0).length,
    eligible: eligible.length,
    sales,
    flaggedSales,
    salesShare: sales ? flaggedSales / sales : 0,
    volumeShare: volume ? flaggedVolume / volume : 0,
    missingShare: sales ? rows.reduce((n, r) => n + r.sales * r.missingData, 0) / sales : 0,
    top5VolumeShare: flaggedVolume ? top5 / flaggedVolume : 0,
    ties: sum('ties'),
    guessed: sum('guessed'),
    skipped: sum('skipped'),
    bands: {
      high: eligible.filter((r) => r.share >= BANDS.high).length,
      mid: eligible.filter((r) => r.share >= BANDS.mid && r.share < BANDS.high).length,
      low: eligible.filter((r) => r.share < BANDS.mid).length,
    },
    largest,
    slowest: [...rows].sort((x, y) => y.tookMs - x.tookMs).slice(0, 5),
  };
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const whole = (x) => `${Math.round(x * 100)}%`;

/**
 * The text of summary.md. It carries the caveats with the numbers, because a
 * share quoted without them reads as a claim about all of Ethereum.
 */
export function markdown(summary, peakRssMb) {
  const s = summary;
  return `# Round trips (SCC A) over NFT-70M's OpenSea sales

Data: MLNTeam-Unical/NFT-70M_transactions (CC BY-NC 4.0), Ethereum ERC-721 simple sales on OpenSea, anonymised.

Every share here is an OpenSea-only figure: it is a share of OpenSea's sales, not of all sales. Sales on Blur, LooksRare and X2Y2 are missing, and the engine bridges each gap from the last buyer to the next seller, so a missing sale can hide a round trip or make one: a share can be off in either direction. Volume counts ETH and WETH sales only; a sale in another currency counts in sales but not in volume. Only Round trips (SCC A) can run: the dataset has no money flows, so Money loops back (SCC AU) and Linked wallets (SCC AC) cannot. Collections are anonymised IDs and cannot be named.

- Collections: ${s.collections} (${s.eligible} with at least ${MIN_SALES} sales)
- Sales: ${s.sales}, of which flagged: ${s.flaggedSales} (${pct(s.salesShare)})
- Share of ETH volume flagged: ${pct(s.volumeShare)}
- Share of flagged ETH volume in the five collections with the most: ${pct(s.top5VolumeShare)}
- Changes of owner that are bridged gaps, averaged over collections weighted by sales: ${pct(s.missingShare)}
- Collections by share of sales flagged, among those with at least ${MIN_SALES} sales: ${s.bands.high} at ${whole(BANDS.high)} or more, ${s.bands.mid} from ${whole(BANDS.mid)} to under ${whole(BANDS.high)}, ${s.bands.low} under ${whole(BANDS.mid)}
- Same-second runs: ${s.ties}, of which ${s.guessed} had no ownership chain to order them
- Rows skipped (no token, seller, buyer or time): ${s.skipped}
- Peak memory: ${Math.round(peakRssMb)} MB

## Slowest collections

| Contract | Sales | Took (ms) |
|---|---|---|
${s.slowest.map((r) => `| ${r.contract} | ${r.sales} | ${Math.round(r.tookMs)} |`).join('\n')}

## Largest flagged ETH volume

| Contract | Sales | Share flagged | Flagged ETH |
|---|---|---|---|
${s.largest.map((r) => `| ${r.contract} | ${r.sales} | ${pct(r.share)} | ${r.flaggedVolumeEth.toFixed(2)} |`).join('\n')}
`;
}
