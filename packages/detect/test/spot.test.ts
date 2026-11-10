import { describe, expect, it } from 'vitest';
import { toEventSelector, type Log } from 'viem';
import type pg from 'pg';
import { SPOT_TRADES_MAX, SpotCheck, counterparties, lensRefusal, middlesOf, receiptTrades } from '../src/spot.js';
import { Store } from '../src/store.js';
import { Chain } from '../src/chain.js';
import { Etherscan } from '../src/etherscan.js';
import { TRANSFER } from '../src/marketplaces.js';
import { COPIES, DEFAULT_RULE, type LensRule } from '../src/lens-rule.js';
import { ZERO } from '../src/graph.js';
import { flow, transfer, w } from './fixtures.js';
import type { Flow, Transfer } from '../src/types.js';

const COLL = w('c0111');
const OTHER = w('c0222');
const TX = `0x${'7'.repeat(64)}`;
const BLOCK = 500;
const S = w('5e11e5'), B = w('b0e5'), F = w('f0d5'), X = w('e1');
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const pad = (hex: string) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;

/** An ERC-721 Transfer log as a receipt holds it. */
function nftLog(t: Transfer & { collection?: string }, tx = t.txHash): Log {
  return {
    address: t.collection ?? COLL, topics: [TRANSFER, pad(t.from), pad(t.to), pad(BigInt(t.tokenId).toString(16))], data: '0x',
    blockNumber: BigInt(t.blockNumber), transactionHash: tx, logIndex: t.logIndex, blockHash: pad('1'), transactionIndex: 0, removed: false,
  } as unknown as Log;
}

/** A sale of `id` in TX, at BLOCK. */
const sold = (id: string, from: string, to: string, more: Partial<Transfer> = {}) => transfer(id, from, to, { txHash: TX, blockNumber: BLOCK, ...more });

interface Setup {
  /** Each collection's transfers, as the chain holds them. */
  history: Record<string, Transfer[]>;
  /** The checked transaction's logs; by default the ERC-721 logs of every transfer in `history` with hash TX. */
  logs?: Log[];
  missing?: boolean;
  reverted?: boolean;
  /** Money as Etherscan answers it, per wallet; an Error is thrown. */
  money?: Record<string, { flows: Flow[]; truncated?: boolean } | Error>;
  /** Wallets whose read is already stored: their coverage, and their stored flows. */
  stored?: Record<string, { from: number | null; truncated?: boolean; flows: Flow[] }>;
  /** Receipts of other transactions, for the sale-leg check. */
  legs?: Record<string, Log[]>;
  etherscan?: boolean;
}

/** A SpotCheck over a chain, an Etherscan and a store that answer from `s`, recording what was asked. */
function setup(s: Setup) {
  const asked = { read: [] as [string, number | undefined][], added: [] as string[], saved: [] as string[], histories: [] as string[] };
  const db = new Map<string, Flow[]>(Object.entries(s.stored ?? {}).map(([a, r]) => [a, r.flows]));

  const store = new Store(null as unknown as pg.Pool);
  store.moneyCovering = async (_c, wallets) => new Map(wallets.flatMap((a) => {
    const r = s.stored?.[a];
    return r ? [[a, { from: r.from, truncated: r.truncated ?? false }] as const] : [];
  }));
  store.addWallets = async (_c, wallets) => { asked.added.push(...wallets); };
  store.saveMoney = async (_c, wallet, flows) => { asked.saved.push(wallet); db.set(wallet, [...flows]); };
  store.flowsOf = async (_c, wallets) => {
    const seen = new Set<Flow>();
    for (const a of wallets) for (const f of db.get(a) ?? []) seen.add(f);
    return [...seen];
  };

  const chain = new Chain(1, 'http://x');
  const all = Object.entries(s.history).flatMap(([c, ts]) => ts.map((t) => ({ ...t, collection: c })));
  chain.receipt = async () => (s.missing ? null : {
    blockNumber: BLOCK, reverted: s.reverted ?? false,
    logs: s.logs ?? all.filter((t) => t.txHash === TX).map((t) => nftLog(t)),
  });
  chain.finalized = async () => 1_000;
  chain.tokenTransfers = async (collection, tokenId) => {
    asked.histories.push(`${collection}:${tokenId}`);
    return (s.history[collection] ?? []).filter((t) => t.tokenId === tokenId).map((t) => ({ ...t }));
  };
  chain.receipts = async (txs) => new Map(txs.map((t) => [t, s.legs?.[t] ?? []]));

  let etherscan: Etherscan | null = null;
  if (s.etherscan !== false) {
    etherscan = new Etherscan('key');
    etherscan.flows = async (_c, wallet, _budget, from) => {
      asked.read.push([wallet, from]);
      const r = s.money?.[wallet];
      if (r instanceof Error) throw r;
      const flows = r?.flows ?? [];
      return { flows, truncated: r?.truncated ?? false, through: flows.length === 0 ? null : Math.max(...flows.map((f) => f.blockNumber)) };
    };
    etherscan.creation = async () => null;
  }
  return { check: new SpotCheck(store, chain, etherscan, 1), asked };
}

/** A token minted to S and sold to B in TX. */
const plainSale = () => ({ [COLL]: [transfer('1', ZERO, S, { blockNumber: 10 }), sold('1', S, B)] });

describe('receiptTrades', () => {
  it('keeps ERC-721 transfers, drops ERC-20 ones, and marks a marketplace sale', () => {
    const t = sold('1', S, B);
    const erc20 = { ...nftLog(t), topics: [TRANSFER, pad(S), pad(B)] } as unknown as Log;
    const seaport = { ...nftLog(t), address: SEAPORT, topics: [pad('99')], logIndex: 5 } as unknown as Log;
    const got = receiptTrades(TX, BLOCK, [nftLog(t), erc20, seaport]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ collection: COLL, tokenId: '1', from: S, to: B, txHash: TX, blockNumber: BLOCK, marketplace: 'seaport-1.6' });
  });
});

describe('middlesOf and counterparties', () => {
  it('finds wallets that moved money with both sides, never the pair, the zero address or a contract', () => {
    const flows = [flow(F, S), flow(B, F), flow(X, S), flow(SEAPORT, S), flow(B, SEAPORT), flow(ZERO, S), flow(ZERO, B), flow(S, B)];
    expect(middlesOf(flows, S, B, new Set([SEAPORT]))).toEqual([F]);
  });

  it('counts distinct wallets either way', () => {
    expect(counterparties([flow(F, S), flow(S, F), flow(F, B), flow(X, F)], F)).toBe(3);
  });
});

describe('SpotCheck.run', () => {
  it('fails a transaction that is not an ERC-721 trade', async () => {
    await expect(setup({ history: plainSale(), missing: true }).check.run(TX, null)).rejects.toThrow('No such transaction on chain 1.');
    await expect(setup({ history: plainSale(), reverted: true }).check.run(TX, null)).rejects.toThrow('This transaction reverted.');
    const single = { ...nftLog(sold('1', S, B)), topics: [toEventSelector('TransferSingle(address,address,address,uint256,uint256)'), pad(S), pad(S), pad(B)] } as unknown as Log;
    await expect(setup({ history: plainSale(), logs: [single] }).check.run(TX, null))
      .rejects.toThrow('This transaction moved only ERC-1155 tokens, which washtrace does not read.');
    await expect(setup({ history: plainSale(), logs: [] }).check.run(TX, null)).rejects.toThrow('This transaction moved no ERC-721 token.');
    const mint = { [COLL]: [transfer('1', ZERO, S, { txHash: TX, blockNumber: BLOCK })] };
    await expect(setup({ history: mint }).check.run(TX, null))
      .rejects.toThrow('This transaction holds no trade: a mint, a burn or a move into or out of custody.');
  });

  it('a token passed back and forth is a round trip', async () => {
    const history = { [COLL]: [
      transfer('1', ZERO, S, { blockNumber: 10 }), transfer('1', S, B, { blockNumber: 20 }), transfer('1', B, S, { blockNumber: 30 }),
      sold('1', S, B), transfer('1', B, S, { blockNumber: 600 }),
    ] };
    const r = await setup({ history, money: { [S]: { flows: [] }, [B]: { flows: [] } } }).check.run(TX, null);
    expect(r.methods).toContain('A');
    expect(r.washTrade).toBe(true);
    expect(r.transfers[0]!.flags.A).toMatchObject({ kind: 'scc' });
    expect(r.source).toBe('spot');
    expect(r.finalized).toBe(true);
  });

  it('a shared funder links the pair, and the funder is read but not saved', async () => {
    const r1 = flow(F, S), r2 = flow(F, B);
    const { check, asked } = setup({ history: plainSale(), money: { [S]: { flows: [r1] }, [B]: { flows: [r2] }, [F]: { flows: [r1, r2, flow(F, X)] } } });
    const r = await check.run(TX, null);
    expect(r.methods).toEqual(['AC']);
    expect(r.transfers.find((t) => t.from === S)!.flags.AC).toMatchObject({ kind: 'pair', middle: F });
    expect(r.washTrade).toBe(true);
    expect(asked.read.map(([a]) => a)).toContain(F);
    expect(asked.saved.sort()).toEqual([B, S].sort());
    expect(asked.added.sort()).toEqual([B, S].sort());
  });

  it('a marketplace or WETH contract is never a middle', async () => {
    const { check, asked } = setup({ history: plainSale(), money: {
      [S]: { flows: [flow(SEAPORT, S), flow(S, WETH)] }, [B]: { flows: [flow(B, SEAPORT), flow(WETH, B)] },
    } });
    const r = await check.run(TX, null);
    expect(asked.read.map(([a]) => a).sort()).toEqual([B, S].sort());
    expect(r.methods).toEqual([]);
    expect(r.washTrade).toBe(false);
  });

  it('a link only through a busy middle is at least, not clean', async () => {
    const r1 = flow(F, S), r2 = flow(F, B);
    const crowd = Array.from({ length: 21 }, (_, i) => flow(F, w(`c${i + 100}`)));
    const r = await setup({ history: plainSale(), money: { [S]: { flows: [r1] }, [B]: { flows: [r2] }, [F]: { flows: [r1, r2, ...crowd] } } }).check.run(TX, null);
    expect(r.methods).toEqual([]);
    expect(r.atLeast).toBe(true);
    expect(r.washTrade).toBeNull();
  });

  it('a truncated middle is a hub, and the answer is clean', async () => {
    const r1 = flow(F, S), r2 = flow(F, B);
    const r = await setup({ history: plainSale(), money: { [S]: { flows: [r1] }, [B]: { flows: [r2] }, [F]: { flows: [r1, r2], truncated: true } } }).check.run(TX, null);
    expect(r.methods).toEqual([]);
    expect(r.atLeast).toBe(false);
    expect(r.washTrade).toBe(false);
  });

  it('a payment in another sale of the collection is not a link', async () => {
    const leg = flow(B, S, { txHash: pad('1e9') });
    const other = transfer('9', S, B, { txHash: leg.txHash, blockNumber: 300 });
    const r = await setup({
      history: plainSale(), money: { [S]: { flows: [leg] }, [B]: { flows: [leg] } }, legs: { [leg.txHash]: [nftLog(other)] },
    }).check.run(TX, null);
    expect(r.methods).toEqual([]);
    expect(r.washTrade).toBe(false);
  });

  it('two collections in one transaction are judged apart', async () => {
    const history = {
      [COLL]: [transfer('7', ZERO, S, { blockNumber: 1 }), transfer('7', S, B, { blockNumber: 2 }), sold('7', B, S, { logIndex: 0 })],
      [OTHER]: [transfer('7', ZERO, S, { blockNumber: 1 }), sold('7', S, B, { logIndex: 1 })],
    };
    const r = await setup({ history, etherscan: false }).check.run(TX, null);
    // Merged, token 7 would be S→B twice and B→S once: two cycles, a round trip. Apart, neither is.
    expect(r.methods).not.toContain('A');
    expect(r.transfers.map((t) => t.collection).sort()).toEqual([COLL, OTHER].sort());
  });

  it('a stored read that covers the trade is reused; an older one reads on from where it stopped', async () => {
    const { check, asked } = setup({
      history: plainSale(),
      stored: { [S]: { from: null, flows: [] }, [B]: { from: 300, flows: [] } },
      money: { [B]: { flows: [] } },
    });
    await check.run(TX, null);
    expect(asked.read).toEqual([[B, 300]]);
  });

  it('a wallet whose read fails is not added, and Linked wallets is then not run', async () => {
    const { check, asked } = setup({ history: plainSale(), money: { [S]: { flows: [flow(F, S)] }, [B]: new Error('timed out') } });
    const r = await check.run(TX, null);
    expect(asked.added).toEqual([S]);
    expect(asked.saved).toEqual([S]);
    expect(r.notRun).toContain('AC');
    expect(r.washTrade).toBeNull();
  });

  it('without Etherscan, Linked wallets is not run', async () => {
    const r = await setup({ history: plainSale(), etherscan: false }).check.run(TX, null);
    expect(r.notRun).toEqual(['AU', 'AC']);
    expect(r.washTrade).toBeNull();
  });

  it('past SPOT_TRADES_MAX tokens the rest are not judged and the answer is at least', async () => {
    const ids = Array.from({ length: SPOT_TRADES_MAX + 1 }, (_, i) => String(i + 1));
    const history = { [COLL]: ids.flatMap((id, i) => [transfer(id, ZERO, S, { blockNumber: 10 }), sold(id, S, B, { logIndex: i })]) };
    const { check, asked } = setup({ history, money: { [S]: { flows: [] }, [B]: { flows: [] } } });
    const r = await check.run(TX, null);
    expect(asked.histories).toHaveLength(SPOT_TRADES_MAX);
    expect(r.atLeast).toBe(true);
    expect(r.washTrade).toBeNull();
  });

  it('a saved lens runs on the transaction\'s trades only', async () => {
    const back = flow(B, S, { blockNumber: 510, blockTime: 2_000, valueWei: '1000000000000000000' });
    const history = { [COLL]: [transfer('1', ZERO, S, { blockNumber: 10 }), sold('1', S, B, { blockTime: 1_000 }), transfer('2', ZERO, X, { blockNumber: 10 }), transfer('2', X, B, { blockNumber: 400 })] };
    const r = await setup({ history, money: { [S]: { flows: [back] }, [B]: { flows: [back] } } }).check.run(TX, { key: 'L7', rule: COPIES.AC.rule });
    expect(r.methods).toEqual(['L7']);
    expect(r.notRun).toEqual([]);
    expect(r.atLeast).toBe(false);
    expect(r.washTrade).toBe(true);
    expect(r.transfers.map((t) => t.tokenId)).toEqual(['1']);
    expect(r.transfers[0]!.flags.L7).toMatchObject({ wallets: expect.arrayContaining([S, B]) });
  });

  it('a lens needing money further out is at least, and only the pair is read', async () => {
    const far: LensRule = { ...COPIES.AC.rule, hops: { min: 0, max: 3 } };
    const { check, asked } = setup({ history: plainSale(), money: { [S]: { flows: [] }, [B]: { flows: [] } } });
    const r = await check.run(TX, { key: 'L8', rule: far });
    expect(r.atLeast).toBe(true);
    expect(r.washTrade).toBeNull();
    expect(asked.read.map(([a]) => a).sort()).toEqual([B, S].sort());
  });
});

describe('lensRefusal', () => {
  it('names Other tokens and other tokens in the collection, and passes the rest', () => {
    const on = { use: true, direction: 'along', max: null, minWei: null, repeats: 'each' } as const;
    expect(lensRefusal({ ...DEFAULT_RULE, edges: { ...DEFAULT_RULE.edges, 'other-tokens': on } })).toBe('This lens uses Other tokens, which a spot check does not read.');
    expect(lensRefusal({ ...DEFAULT_RULE, edges: { ...DEFAULT_RULE.edges, 'nft-collection': on } })).toBe('This lens follows other tokens in the collection, which a spot check does not read.');
    expect(lensRefusal(COPIES.AC.rule)).toBeNull();
  });
});
