// Reads rows of the NFT-70M sales CSV (see extract.py) as washtrace Transfers,
// one collection at a time, so the survey never holds more than one collection.
// Imported by survey.mjs; unit tested in rows.test.mjs.
import { CUSTODIANS, Payments, contractsFor, moneyFor } from '@washtrace/detect';

/** The WETH contract, which washtrace prices as ETH-equivalent. */
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

/**
 * Converts a decimal price to wei at gwei precision, because the dataset's
 * prices are floats and carry no finer digits. Null when empty or not finite.
 */
export function weiOf(price) {
  const n = Number(price);
  if (price === '' || !Number.isFinite(n)) return null;
  return String(BigInt(Math.round(n * 1e9)) * 1_000_000_000n);
}

function fields(line) {
  const [contract, token, , ts, seller, buyer, price, currency] = line.split(',');
  return { contract, token, ts: ts === '' ? NaN : Number(ts), seller, buyer, price, currency };
}

/**
 * One sale as a Transfer, or null when it has no token, seller or buyer.
 * `i` is the sale's place in its token's ordered sales: the dataset has no
 * block number or log index, and `analyze()` orders by blockNumber then
 * logIndex, so `i` carries the order within a second.
 */
export function toTransfer(line, i) {
  const f = fields(line);
  if (!f.token || !f.seller || !f.buyer) return null;
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
 * Orders one token's sales (already sorted by ts) within each second by who
 * held the token. The dataset's num_sales is the same on every sale of a
 * token, so it cannot order them; the chain of owners can. In a run of equal
 * ts, take the first sale whose seller is the previous buyer, else the first
 * left in file order. `ties` counts runs of two or more, which the survey reports.
 */
export function chainOrder(sales) {
  const out = [];
  let ties = 0;
  let prev = null;
  for (let a = 0; a < sales.length; ) {
    let b = a;
    while (b < sales.length && sales[b].ts === sales[a].ts) b++;
    const rest = sales.slice(a, b);
    if (rest.length > 1) ties++;
    while (rest.length) {
      const k = rest.findIndex((s) => s.seller === prev);
      const [s] = rest.splice(k < 0 ? 0 : k, 1);
      out.push(s);
      prev = s.buyer;
    }
    a = b;
  }
  return { sales: out, ties };
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
    ordered.sales.forEach((s, i) => group.transfers.push(toTransfer(s.line, i)));
    rows = [];
  };

  let header = true;
  for await (const line of lines) {
    if (header) { header = false; continue; }
    if (!line) continue;
    const f = fields(line);
    if (!group || f.contract !== group.contract) {
      if (group) { flush(); yield group; }
      if (seen.has(f.contract)) throw new Error(`input not sorted: contract ${f.contract} appears again`);
      seen.add(f.contract);
      group = { contract: f.contract, transfers: [], skipped: 0, ties: 0 };
      token = null;
      tokens = new Set();
    }
    // A non-finite ts never equals itself, so chainOrder's run scan would not advance.
    if (!f.token || !f.seller || !f.buyer || !Number.isFinite(f.ts)) { group.skipped++; continue; }
    if (f.token !== token) {
      flush();
      // A token seen again would restart at 0 and repeat txHash and logIndex.
      if (tokens.has(f.token)) throw new Error(`input not sorted: token ${f.token} of contract ${f.contract} appears again`);
      tokens.add(f.token);
      token = f.token;
    }
    rows.push({ ts: f.ts, seller: f.seller, buyer: f.buyer, line });
  }
  if (group) { flush(); yield group; }
}

/**
 * The input `analyze()` takes for a bare list of sales. The dataset has no
 * money flows, so only Round trips (SCC A) can run: funding is unavailable.
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
 * console's lens cards show. Dates come from blockTime in seconds.
 */
export function surveyRow(contract, transfers, analysis, tookMs) {
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
    flagged: a.flagged,
    share: a.sales ? a.flaggedSales / a.sales : 0,
    flaggedSales: a.flaggedSales,
    volumeEth: eth(a.volumeWei),
    flaggedVolumeEth: eth(a.flaggedVolumeWei),
    missingData: analysis.missingData,
    tookMs,
  };
}

/**
 * Population figures over all collections. Only collections with at least
 * `minSales` sales go into the bands, because a share of ten sales says little;
 * every collection counts in the totals.
 */
export function summarize(rows, minSales = 100) {
  const eligible = rows.filter((r) => r.sales >= minSales);
  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  const sales = sum('sales');
  const flaggedSales = sum('flaggedSales');
  const volume = sum('volumeEth');
  return {
    collections: rows.length,
    eligible: eligible.length,
    sales,
    flaggedSales,
    salesShare: sales ? flaggedSales / sales : 0,
    volumeShare: volume ? sum('flaggedVolumeEth') / volume : 0,
    bands: {
      high: eligible.filter((r) => r.share >= 0.5).length,
      mid: eligible.filter((r) => r.share >= 0.1 && r.share < 0.5).length,
      low: eligible.filter((r) => r.share < 0.1).length,
    },
    slowest: [...rows].sort((x, y) => y.tookMs - x.tookMs).slice(0, 5),
  };
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;

/**
 * The text of summary.md. It carries the caveats with the numbers, because a
 * share quoted without them reads as a claim about all of Ethereum.
 */
export function markdown(summary, peakRssMb) {
  const s = summary;
  return `# Round trips (SCC A) over NFT-70M's OpenSea sales

Data: MLNTeam-Unical/NFT-70M_transactions (CC BY-NC 4.0), Ethereum ERC-721 simple sales on OpenSea, anonymised.

Every share here is an OpenSea-only figure: it is a share of OpenSea's sales, not of all sales, and sales on Blur, LooksRare and X2Y2 are missing, so round trips through them are not seen. Only Round trips (SCC A) can run: the dataset has no money flows, so Money loops back (SCC AU) and Linked wallets (SCC AC) cannot. Collections are anonymised IDs and cannot be named.

- Collections: ${s.collections} (${s.eligible} with at least 100 sales)
- Sales: ${s.sales}, of which flagged: ${s.flaggedSales} (${pct(s.salesShare)})
- Share of ETH volume flagged: ${pct(s.volumeShare)}
- Collections by share of sales flagged, among those with at least 100 sales: ${s.bands.high} at 50% or more, ${s.bands.mid} from 10% to under 50%, ${s.bands.low} under 10%
- same-second sales ordered by ownership chain: ${s.ties ?? 0} groups
- Peak memory: ${Math.round(peakRssMb)} MB

## Slowest collections

| Contract | Sales | Took (ms) |
|---|---|---|
${s.slowest.map((r) => `| ${r.contract} | ${r.sales} | ${Math.round(r.tookMs)} |`).join('\n')}
`;
}
