import { describe, expect, it } from 'vitest';
import { analyze } from '@washtrace/detect';
import { HEADER, WETH, byCollection, chainOrder, markdown, parse, summarize, surveyInput, surveyRow, toTransfer, weiOf } from './rows.mjs';

const row = (contract, token, ts, seller, buyer, price = '0.1', currency = 'ETH') =>
  [contract, token, ts, seller, buyer, price, currency].join(',');
const tr = (line, i = 0) => toTransfer(parse(line), i);
const grp = (transfers, extra = {}) => ({ contract: '7', transfers, skipped: 0, ties: 0, guessed: 0, ...extra });
const pairs = (g) => g.transfers.map((t) => [t.from, t.to]);
async function* lines(...xs) { yield* xs; }
async function collect(...xs) {
  const out = [];
  for await (const g of byCollection(lines(HEADER, ...xs))) out.push(g);
  return out;
}

describe('rows', () => {
  it('prices ETH and WETH in wei, at gwei precision', () => {
    expect(weiOf('0.035')).toBe('35000000000000000');
    expect(weiOf('1.2e-05')).toBe('12000000000000');
    expect(weiOf('')).toBeNull();
    expect(tr(row(7, 1, 100, 'a', 'b', '2', 'WETH'), 0)).toMatchObject({ priceWei: '2000000000000000000', currency: WETH, marketplace: 'opensea' });
  });

  it('counts a sale in another currency without pricing it', () => {
    expect(tr(row(7, 1, 100, 'a', 'b', '50', 'APE'), 0)).toMatchObject({ priceWei: null, currency: null, marketplace: 'opensea' });
  });

  it('orders sales in the same second by the ownership chain', async () => {
    const [g] = await collect(row(7, 1, 99, 'c', 'a'), row(7, 1, 100, 'b', 'a'), row(7, 1, 100, 'a', 'b'));
    expect(g.transfers.map((t) => [t.from, t.to])).toEqual([['c', 'a'], ['a', 'b'], ['b', 'a']]);
    expect(g.transfers.map((t) => t.logIndex)).toEqual([0, 1, 2]);
    expect(g.transfers.map((t) => t.txHash)).toEqual(['nft70m:7:1:0', 'nft70m:7:1:1', 'nft70m:7:1:2']);
    expect(g.transfers.map((t) => t.blockNumber)).toEqual([99, 100, 100]);
    expect(g.ties).toBe(1);
  });

  it('guesses the first sale when two chains share a second', async () => {
    const [g] = await collect(row(7, 1, 100, 'x', 'y'), row(7, 1, 100, 'p', 'q'));
    expect(g.transfers.map((t) => [t.from, t.to])).toEqual([['x', 'y'], ['p', 'q']]);
    expect(g.ties).toBe(1);
    expect(g.guessed).toBe(1);
  });

  it('chainOrder leaves distinct seconds alone and counts only tied runs', () => {
    const s = [{ ts: 1, seller: 'a', buyer: 'b' }, { ts: 2, seller: 'b', buyer: 'c' }];
    expect(chainOrder(s)).toEqual({ sales: s, ties: 0, guessed: 0 });
  });

  it("numbers each token's sales from 0", async () => {
    const [g] = await collect(row(7, 1, 100, 'a', 'b'), row(7, 1, 101, 'b', 'c'), row(7, 2, 100, 'a', 'b'), row(7, 2, 101, 'b', 'c'));
    expect(g.transfers.map((t) => t.logIndex)).toEqual([0, 1, 0, 1]);
  });

  it('skips a row with no seller and counts it', async () => {
    const [g] = await collect(row(7, 1, 100, '', 'b'), row(7, 1, 101, 'b', 'c'));
    expect(g.transfers.length).toBe(1);
    expect(g.skipped).toBe(1);
    expect(g.transfers[0].logIndex).toBe(0);
  });

  it('yields every collection, the last one too', async () => {
    const gs = await collect(row(7, 1, 1, 'a', 'b'), row(7, 2, 1, 'a', 'b'), row(8, 1, 1, 'a', 'b'));
    expect(gs.map((g) => g.contract)).toEqual(['7', '8']);
    expect(gs.map((g) => g.transfers.length)).toEqual([2, 1]);
  });

  it('throws when a contract comes back', async () => {
    await expect(collect(row(7, 1, 1, 'a', 'b'), row(8, 1, 1, 'a', 'b'), row(7, 1, 1, 'a', 'b'))).rejects.toThrow('input not sorted: contract 7 appears again');
  });

  it('throws when a token comes back within a contract', async () => {
    await expect(collect(row(7, 1, 1, 'a', 'b'), row(7, 2, 1, 'a', 'b'), row(7, 1, 2, 'b', 'c'))).rejects.toThrow('input not sorted: token 1 of contract 7 appears again');
  });

  it('lets prev move within a run of three', async () => {
    const [g] = await collect(row(7, 1, 99, 'z', 'a'), row(7, 1, 100, 'x', 'y'), row(7, 1, 100, 'b', 'c'), row(7, 1, 100, 'a', 'b'));
    expect(g.transfers.map((t) => [t.from, t.to])).toEqual([['z', 'a'], ['a', 'b'], ['b', 'c'], ['x', 'y']]);
    expect(g.ties).toBe(1);
  });

  it('reads a collection traded back and forth as all flagged', () => {
    // a→b, b→a, a→b, b→a on one token: one component with three cycles. analyze is the real one.
    const ts = [row(7, 1, 100, 'a', 'b'), row(7, 1, 200, 'b', 'a'), row(7, 1, 300, 'a', 'b'), row(7, 1, 400, 'b', 'a')].map((l, i) => tr(l, i));
    const r = surveyRow(grp(ts), analyze(surveyInput(ts)), 5);
    expect(r).toMatchObject({ contract: '7', sales: 4, flaggedSales: 4, flaggedTokens: 1, flaggedWallets: 2, share: 1, missingData: 0, tookMs: 5 });
    expect(r.first).toBe('1970-01-01T00:01:40.000Z');
    expect(r.last).toBe('1970-01-01T00:06:40.000Z');
    expect(r.volumeEth).toBeCloseTo(0.4);
  });

  const R = (o) => ({ contract: 'c', sales: 100, flaggedSales: 0, share: 0, volumeEth: 0, flaggedVolumeEth: 0, missingData: 0, tookMs: 1, ties: 0, guessed: 0, skipped: 0, ...o });

  it('keeps small collections out of the bands but in the totals', () => {
    const s = summarize([R({ sales: 10, flaggedSales: 10, share: 1, volumeEth: 1, flaggedVolumeEth: 1, tookMs: 1 }), R({ sales: 200, flaggedSales: 20, share: 0.1, volumeEth: 9, flaggedVolumeEth: 0, tookMs: 2 })]);
    expect(s).toMatchObject({ collections: 2, eligible: 1, sales: 210, flaggedSales: 30, ties: 0, guessed: 0, skipped: 0, missingShare: 0, bands: { high: 0, mid: 1, low: 0 } });
    expect(s.volumeShare).toBeCloseTo(0.1);
  });

  it('sums ties, guessed and skipped, weights missing data by sales, and finds the concentration', () => {
    const rows = [
      R({ contract: 'a', sales: 100, missingData: 0.5, ties: 3, guessed: 1, skipped: 2, flaggedSales: 50, share: 0.5, volumeEth: 10, flaggedVolumeEth: 6 }),
      R({ contract: 'b', sales: 300, missingData: 0.1, ties: 1, guessed: 1, skipped: 0, flaggedVolumeEth: 4 }),
      R({ contract: 'z', sales: 0 }),
    ];
    const s = summarize(rows);
    expect(s).toMatchObject({ collections: 2, ties: 4, guessed: 2, skipped: 2 });
    expect(s.missingShare).toBeCloseTo((100 * 0.5 + 300 * 0.1) / 400);
    expect(s.top5VolumeShare).toBe(1);
    // 'z' flagged no volume, so it is not among the largest.
    expect(s.largest.map((r) => r.contract)).toEqual(['a', 'b']);
  });

  it('measures the top five against all flagged volume', () => {
    const rows = Array.from({ length: 7 }, (_, i) => R({ contract: String(i), flaggedVolumeEth: 1 + i }));
    const s = summarize(rows);
    expect(s.largest).toHaveLength(5);
    expect(s.top5VolumeShare).toBeCloseTo((7 + 6 + 5 + 4 + 3) / 28);
  });

  it('writes the summary with its caveats', () => {
    const text = markdown(summarize([R({ sales: 200, flaggedSales: 20, share: 0.1, volumeEth: 9, ties: 3, guessed: 2, skipped: 4 })]), 512);
    expect(text).toContain("Round trips (SCC A) over NFT-70M's OpenSea sales");
    expect(text).toContain("Every share here is an OpenSea-only figure: it is a share of OpenSea's sales, not of all sales. Sales on Blur, LooksRare and X2Y2 are missing, and the engine bridges each gap from the last buyer to the next seller, so a missing sale can hide a round trip or make one: a share can be off in either direction. Volume counts ETH and WETH sales only; a sale in another currency counts in sales but not in volume. Only Round trips (SCC A) can run: the dataset has no money flows, so Money loops back (SCC AU) and Linked wallets (SCC AC) cannot. Collections are anonymised IDs and cannot be named.");
    expect(text).toContain('Same-second runs: 3, of which 2 had no ownership chain to order them');
    expect(text).toContain('Rows skipped (no token, seller, buyer or time): 4');
    expect(text).toContain('- Changes of owner that are bridged gaps, averaged over collections weighted by sales: 0.00%');
    expect(text).toContain('Share of flagged ETH volume in the five collections with the most: ');
    expect(text).toContain('## Largest flagged ETH volume');
    expect(text).toContain('| Contract | Sales | Share flagged | Flagged ETH |');
    expect(text).toContain('MLNTeam-Unical/NFT-70M_transactions');
  });

  it('gives surveyRow the group counts and no duplicate flagged column', () => {
    const ts = [tr(row(7, 1, 100, 'a', 'b'), 0)];
    const r = surveyRow(grp(ts, { ties: 2, guessed: 1, skipped: 3 }), analyze(surveyInput(ts)), 1);
    expect(r).not.toHaveProperty('flagged');
    expect(r).toMatchObject({ ties: 2, guessed: 1, skipped: 3 });
  });

  it('flags a missing resale: a bridged gap can make a round trip', () => {
    // a→b twice, so b→a was never seen; the engine bridges it and reads a cycle.
    const ts = [tr(row(7, 1, 100, 'a', 'b'), 0), tr(row(7, 1, 200, 'a', 'b'), 1)];
    expect(analyze(surveyInput(ts)).totals.A.flaggedSales).toBe(2);
  });

  it('reads the dates of a collection of 200,000 sales', () => {
    const ts = Array.from({ length: 200000 }, (_, i) => ({ blockTime: 1000 + (i % 7919) }));
    const analysis = { totals: { A: { sales: 200000, tokens: 0, wallets: 0, flagged: 0, flaggedSales: 0, volumeWei: '0', flaggedVolumeWei: '0' } }, missingData: 0 };
    const r = surveyRow(grp(ts), analysis, 1);
    expect(r.first).toBe(new Date(1000 * 1000).toISOString());
    expect(r.last).toBe(new Date((1000 + 7918) * 1000).toISOString());
  });

  it('skips rows with an empty time and counts them', async () => {
    const [g] = await collect(row(7, 1, '', 'a', 'b'), row(7, 1, '', 'b', 'c'), row(7, 1, 101, 'b', 'c'));
    expect(g.transfers.length).toBe(1);
    expect(g.skipped).toBe(2);
  });

  it('puts a sale behind a gap after the sale that fills it', async () => {
    const [g] = await collect(row(7, 1, 99, 'z', 'p'), row(7, 1, 100, 'd', 'e'), row(7, 1, 100, 'x', 'd'));
    expect(pairs(g)).toEqual([['z', 'p'], ['x', 'd'], ['d', 'e']]);
    expect([g.ties, g.guessed]).toEqual([1, 0]);
  });

  it('keeps both sales of two chains in one second', async () => {
    const [g] = await collect(row(7, 1, 99, 'z', 'y'), row(7, 1, 100, 'a', 'b'), row(7, 1, 100, 'c', 'd'));
    expect(g.transfers.length).toBe(3);
    expect(g.guessed).toBe(1);
  });

  it('finishes a loop in one second', async () => {
    const [g] = await collect(row(7, 1, 99, 'z', 'y'), row(7, 1, 100, 'a', 'b'), row(7, 1, 100, 'b', 'a'));
    expect(pairs(g)).toEqual([['z', 'y'], ['a', 'b'], ['b', 'a']]);
    expect(g.guessed).toBe(1);
  });

  it('does not end the chain early when the previous buyer sells twice', async () => {
    const [g] = await collect(row(7, 1, 99, 'z', 'a'), row(7, 1, 100, 'a', 'b'), row(7, 1, 100, 'a', 'c'), row(7, 1, 100, 'c', 'a'));
    expect(pairs(g)).toEqual([['z', 'a'], ['a', 'c'], ['c', 'a'], ['a', 'b']]);
    expect(g.guessed).toBe(0);
  });

  it('does not count a lone self-sale as a tie', async () => {
    const [g] = await collect(row(7, 1, 100, 'x', 'x'));
    expect([g.transfers.length, g.ties, g.guessed]).toEqual([1, 0, 0]);
  });

  it('rejects a file with the old header', async () => {
    const old = 'contract,token,num_sales,ts,seller,buyer,price,currency';
    await expect((async () => { for await (const _ of byCollection(lines(old, '7,1,2,100,a,b,0.1,ETH'))) { /* drain */ } })()).rejects.toThrow('Rerun extract.py.');
  });

  it('rejects an empty sales file rather than summarise nothing', async () => {
    await expect((async () => { for await (const _ of byCollection(lines())) { /* drain */ } })()).rejects.toThrow(`sales file is empty; expected header "${HEADER}". Rerun extract.py.`);
  });

  it('flags a same-second repeat, which is why the extract removes identical rows', () => {
    const ts = [tr(row(7, 1, 100, 'a', 'b'), 0), tr(row(7, 1, 100, 'a', 'b'), 1)];
    expect(analyze(surveyInput(ts)).totals.A.flaggedSales).toBe(2);
  });

  it('adds up WETH volume', () => {
    const ts = [tr(row(7, 1, 100, 'a', 'b', '1', 'WETH'), 0), tr(row(7, 1, 200, 'b', 'a', '1', 'WETH'), 1)];
    expect(surveyRow(grp(ts), analyze(surveyInput(ts)), 1).volumeEth).toBeCloseTo(2);
  });
});
