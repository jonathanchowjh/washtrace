import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters, type Log } from 'viem';
import { ORDER_FULFILLED, seaportPrice, tagSales } from '../src/marketplaces.js';
import { transfer, w } from './fixtures.js';

const SEAPORT_16 = '0x0000000000000068f116a894984e2db1123eb395';
const BLUR_V2 = '0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const collection = w('c011');
const seller = w('5e11'), buyer = w('b');

type Spent = { itemType: number; token: `0x${string}`; identifier: bigint; amount: bigint };
type Received = Spent & { recipient: `0x${string}` };

function fill(offer: Spent[], consideration: Received[], address = SEAPORT_16): Log {
  const data = encodeAbiParameters(
    parseAbiParameters('bytes32, address, (uint8, address, uint256, uint256)[], (uint8, address, uint256, uint256, address)[]'),
    [
      `0x${'11'.repeat(32)}`, buyer as `0x${string}`,
      offer.map((i) => [i.itemType, i.token, i.identifier, i.amount] as const),
      consideration.map((i) => [i.itemType, i.token, i.identifier, i.amount, i.recipient] as const),
    ],
  );
  const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}` as `0x${string}`;
  return { address, data, topics: [ORDER_FULFILLED, pad(seller), pad(w('0'))] } as unknown as Log;
}

const nft = (id: bigint): Spent => ({ itemType: 2, token: collection as `0x${string}`, identifier: id, amount: 1n });
const eth = (amount: bigint, to = seller): Received => ({ itemType: 0, token: w('0') as `0x${string}`, identifier: 0n, amount, recipient: to as `0x${string}` });
const weth = (amount: bigint): Spent => ({ itemType: 1, token: WETH as `0x${string}`, identifier: 0n, amount });

describe('seaportPrice', () => {
  it('prices a listing from its consideration, fees included', () => {
    const log = fill([nft(7n)], [eth(975n), eth(25n, w('fee'))]);
    expect(seaportPrice(log, collection, 7n)).toEqual({ priceWei: '1000', currency: '' });
  });

  it('prices a bid from its offer', () => {
    const log = fill([weth(500n)], [{ ...nft(7n), recipient: buyer as `0x${string}` }]);
    expect(seaportPrice(log, collection, 7n)).toEqual({ priceWei: '500', currency: WETH });
  });

  it('splits a bundle evenly across its tokens', () => {
    expect(seaportPrice(fill([nft(1n), nft(2n)], [eth(1000n)]), collection, 2n)?.priceWei).toBe('500');
  });

  it('does not price a fill that is not of this token', () => {
    expect(seaportPrice(fill([nft(1n)], [eth(1000n)]), collection, 9n)).toBeNull();
  });
});

describe('tagSales', () => {
  it('marks a Blur sale as a sale and leaves it unpriced', () => {
    const t = transfer('7', seller, buyer);
    tagSales([t], new Map([[t.txHash, [{ address: BLUR_V2, topics: ['0x01'], data: '0x' } as unknown as Log]]]), collection);
    expect(t).toMatchObject({ marketplace: 'blur-v2', priceWei: null });
  });

  it('marks and prices a Seaport sale', () => {
    const t = transfer('7', seller, buyer);
    tagSales([t], new Map([[t.txHash, [fill([nft(7n)], [eth(1000n)])]]]), collection);
    expect(t).toMatchObject({ marketplace: 'seaport-1.6', priceWei: '1000', currency: '' });
  });

  it('leaves a plain transfer alone', () => {
    const t = transfer('7', seller, buyer);
    tagSales([t], new Map(), collection);
    expect(t.marketplace).toBeNull();
  });
});
