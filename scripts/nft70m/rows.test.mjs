import { describe, expect, it } from 'vitest';
import { analyze } from '@washtrace/detect';
import { WETH, byCollection, chainOrder, markdown, summarize, surveyInput, surveyRow, toTransfer, weiOf } from './rows.mjs';

const HEADER = 'contract,token,num_sales,ts,seller,buyer,price,currency';
// num_sales stays in the row as the unused snapshot column.
const row = (contract, token, n, ts, seller, buyer, price = '0.1', currency = 'ETH') =>
  [contract, token, n, ts, seller, buyer, price, currency].join(',');
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
    expect(toTransfer(row(7, 1, 1, 100, 'a', 'b', '2', 'WETH'), 0)).toMatchObject({ priceWei: '2000000000000000000', currency: WETH, marketplace: 'opensea' });
  });

  it('counts a sale in another currency without pricing it', () => {
    expect(toTransfer(row(7, 1, 1, 100, 'a', 'b', '50', 'APE'), 0)).toMatchObject({ priceWei: null, currency: null, marketplace: 'opensea' });
  });

  it('orders sales in the same second by the ownership chain', async () => {
    const [g] = await collect(row(7, 1, 3, 99, 'c', 'a'), row(7, 1, 3, 100, 'b', 'a'), row(7, 1, 3, 100, 'a', 'b'));
    expect(g.transfers.map((t) => [t.from, t.to])).toEqual([['c', 'a'], ['a', 'b'], ['b', 'a']]);
    expect(g.transfers.map((t) => t.logIndex)).toEqual([0, 1, 2]);
    expect(g.transfers.map((t) => t.txHash)).toEqual(['nft70m:7:1:0', 'nft70m:7:1:1', 'nft70m:7:1:2']);
    expect(g.transfers.map((t) => t.blockNumber)).toEqual([99, 100, 100]);
    expect(g.ties).toBe(1);
  });

  it('keeps file order in a second when no chain fits', async () => {
    const [g] = await collect(row(7, 1, 2, 100, 'x', 'y'), row(7, 1, 2, 100, 'p', 'q'));
    expect(g.transfers.map((t) => [t.from, t.to])).toEqual([['x', 'y'], ['p', 'q']]);
    expect(g.ties).toBe(1);
  });

  it('chainOrder leaves distinct seconds alone and counts only tied runs', () => {
    const s = [{ ts: 1, seller: 'a', buyer: 'b' }, { ts: 2, seller: 'b', buyer: 'c' }];
    expect(chainOrder(s)).toEqual({ sales: s, ties: 0 });
  });

  it("numbers each token's sales from 0", async () => {
    const [g] = await collect(row(7, 1, 2, 100, 'a', 'b'), row(7, 1, 2, 101, 'b', 'c'), row(7, 2, 2, 100, 'a', 'b'), row(7, 2, 2, 101, 'b', 'c'));
    expect(g.transfers.map((t) => t.logIndex)).toEqual([0, 1, 0, 1]);
  });

  it('skips a row with no seller and counts it', async () => {
    const [g] = await collect(row(7, 1, 1, 100, '', 'b'), row(7, 1, 2, 101, 'b', 'c'));
    expect(g.transfers.length).toBe(1);
    expect(g.skipped).toBe(1);
    expect(g.transfers[0].logIndex).toBe(0);
  });

  it('yields every collection, the last one too', async () => {
    const gs = await collect(row(7, 1, 1, 1, 'a', 'b'), row(7, 2, 1, 1, 'a', 'b'), row(8, 1, 1, 1, 'a', 'b'));
    expect(gs.map((g) => g.contract)).toEqual(['7', '8']);
    expect(gs.map((g) => g.transfers.length)).toEqual([2, 1]);
  });

  it('throws when a contract comes back', async () => {
    await expect(collect(row(7, 1, 1, 1, 'a', 'b'), row(8, 1, 1, 1, 'a', 'b'), row(7, 1, 1, 1, 'a', 'b'))).rejects.toThrow('input not sorted: contract 7 appears again');
  });

  it('skips a row whose time is not a number and counts it', async () => {
    const [g] = await collect(row(7, 1, 1, 'NaN', 'a', 'b'), row(7, 1, 2, 'NaN', 'b', 'c'), row(7, 1, 3, 101, 'b', 'c'));
    expect(g.transfers.length).toBe(1);
    expect(g.skipped).toBe(2);
  });

  it('throws when a token comes back within a contract', async () => {
    await expect(collect(row(7, 1, 1, 1, 'a', 'b'), row(7, 2, 1, 1, 'a', 'b'), row(7, 1, 1, 2, 'b', 'c'))).rejects.toThrow('input not sorted: token 1 of contract 7 appears again');
  });

  it('lets prev move within a run of three', async () => {
    const [g] = await collect(row(7, 1, 4, 99, 'z', 'a'), row(7, 1, 4, 100, 'x', 'y'), row(7, 1, 4, 100, 'b', 'c'), row(7, 1, 4, 100, 'a', 'b'));
    expect(g.transfers.map((t) => [t.from, t.to])).toEqual([['z', 'a'], ['a', 'b'], ['b', 'c'], ['x', 'y']]);
    expect(g.ties).toBe(1);
  });

  it('reads a collection traded back and forth as all flagged', () => {
    // a→b, b→a, a→b, b→a on one token: one component with three cycles. analyze is the real one.
    const ts = [row(7, 1, 1, 100, 'a', 'b'), row(7, 1, 2, 200, 'b', 'a'), row(7, 1, 3, 300, 'a', 'b'), row(7, 1, 4, 400, 'b', 'a')].map((l, i) => toTransfer(l, i));
    const r = surveyRow('7', ts, analyze(surveyInput(ts)), 5);
    expect(r).toMatchObject({ contract: '7', sales: 4, flagged: 4, flaggedTokens: 1, flaggedWallets: 2, share: 1, missingData: 0, tookMs: 5 });
    expect(r).not.toHaveProperty('tokens');
    expect(r).not.toHaveProperty('wallets');
    expect(r.first).toBe('1970-01-01T00:01:40.000Z');
    expect(r.last).toBe('1970-01-01T00:06:40.000Z');
    expect(r.volumeEth).toBeCloseTo(0.4);
  });

  it('keeps small collections out of the bands but in the totals', () => {
    const s = summarize([{ sales: 10, flaggedSales: 10, share: 1, volumeEth: 1, flaggedVolumeEth: 1, tookMs: 1 }, { sales: 200, flaggedSales: 20, share: 0.1, volumeEth: 9, flaggedVolumeEth: 0, tookMs: 2 }]);
    expect(s).toMatchObject({ collections: 2, eligible: 1, sales: 210, flaggedSales: 30, bands: { high: 0, mid: 1, low: 0 } });
    expect(s.volumeShare).toBeCloseTo(0.1);
  });

  it('writes the summary without calling a share a floor', () => {
    const s = { ...summarize([{ sales: 200, flaggedSales: 20, share: 0.1, volumeEth: 9, flaggedVolumeEth: 0, tookMs: 2 }]), ties: 3 };
    const text = markdown(s, 512);
    expect(text).toContain("Round trips (SCC A) over NFT-70M's OpenSea sales");
    expect(text).toContain('same-second sales ordered by ownership chain: 3 groups');
    expect(text).toContain('MLNTeam-Unical/NFT-70M_transactions');
    expect(text).toContain('an OpenSea-only figure: it is a share of OpenSea\'s sales, not of all sales');
    expect(text.toLowerCase()).not.toContain('floor');
  });

  it('reads the dates of a collection of 200,000 sales', () => {
    const ts = Array.from({ length: 200000 }, (_, i) => ({ blockTime: 1000 + (i % 7919) }));
    const analysis = { totals: { A: { sales: 200000, tokens: 0, wallets: 0, flagged: 0, flaggedSales: 0, volumeWei: '0', flaggedVolumeWei: '0' } }, missingData: 0 };
    const r = surveyRow('7', ts, analysis, 1);
    expect(r.first).toBe(new Date(1000 * 1000).toISOString());
    expect(r.last).toBe(new Date((1000 + 7918) * 1000).toISOString());
  });

  it('skips a row with an empty time and counts it', async () => {
    const [g] = await collect(row(7, 1, 1, '', 'a', 'b'), row(7, 1, 2, 101, 'b', 'c'));
    expect(g.transfers.length).toBe(1);
    expect(g.skipped).toBe(1);
  });
});
