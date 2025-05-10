import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters, type Log } from 'viem';
import { ORDER_FULFILLED, seaportPrice, tagSales } from '../src/marketplaces.js';
import { transfer, w } from './fixtures.js';

const SEAPORT_16 = '0x0000000000000068f116a894984e2db1123eb395';
const BLUR_V2 = '0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const LOOKSRARE = '0x59728544b08ab483533076417fbbb2fd0b17ce3a';
const WYVERN_2 = '0x7f268357a8c2552623316e2562d90e642bb538e5';
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

const EVENTS = parseAbi([
  'event TakerBid(bytes32 orderHash, uint256 orderNonce, address indexed taker, address indexed maker, address indexed strategy, address currency, address collection, uint256 tokenId, uint256 amount, uint256 price)',
  'event OrdersMatched(bytes32 buyHash, bytes32 sellHash, address indexed maker, address indexed taker, uint256 price, bytes32 indexed metadata)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);
const H = `0x${'11'.repeat(32)}` as const;
const at = (log: object, logIndex: number) => ({ ...log, logIndex }) as unknown as Log;

/** A LooksRare v1 TakerBid, as its exchange logs it: currency, collection, token and price in the data. */
function takerBid(tokenId: bigint, price: bigint, currency = WETH, of = collection): object {
  return {
    address: LOOKSRARE,
    topics: encodeEventTopics({ abi: EVENTS, eventName: 'TakerBid', args: { taker: buyer as `0x${string}`, maker: seller as `0x${string}`, strategy: w('57') as `0x${string}` } }),
    data: encodeAbiParameters(parseAbiParameters('bytes32, uint256, address, address, uint256, uint256, uint256'), [H, 1n, currency as `0x${string}`, of as `0x${string}`, tokenId, 1n, price]),
  };
}

/** A Wyvern OrdersMatched: the price alone, with neither the token nor the currency. */
function matched(price: bigint): object {
  return {
    address: WYVERN_2,
    topics: encodeEventTopics({ abi: EVENTS, eventName: 'OrdersMatched', args: { maker: seller as `0x${string}`, taker: buyer as `0x${string}`, metadata: H } }),
    data: encodeAbiParameters(parseAbiParameters('bytes32, bytes32, uint256'), [H, H, price]),
  };
}

function nftLog(tokenId: bigint, of = collection): object {
  const [t0] = encodeEventTopics({ abi: [EVENTS[3]], eventName: 'Transfer' });
  const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}` as `0x${string}`;
  return { address: of, topics: [t0, pad(seller), pad(buyer), `0x${tokenId.toString(16).padStart(64, '0')}`], data: '0x' };
}

function wethLog(amount: bigint): object {
  const [t0] = encodeEventTopics({ abi: [EVENTS[2]], eventName: 'Transfer' });
  const pad = (a: string) => `0x${a.slice(2).padStart(64, '0')}` as `0x${string}`;
  return { address: WETH, topics: [t0, pad(buyer), pad(seller)], data: encodeAbiParameters(parseAbiParameters('uint256'), [amount]) };
}

describe('tagSales on the 2022 exchanges', () => {
  it('prices a LooksRare v1 sale from its TakerBid, in the currency it names', () => {
    const t = transfer('7', seller, buyer, { logIndex: 2 });
    tagSales([t], new Map([[t.txHash, [at(wethLog(900n), 0), at(nftLog(7n), 2), at(takerBid(7n, 1000n), 3)]]]), collection);
    expect(t).toMatchObject({ marketplace: 'looksrare', priceWei: '1000', currency: WETH });
  });

  it('does not price a LooksRare fill of another token', () => {
    const t = transfer('7', seller, buyer, { logIndex: 0 });
    tagSales([t], new Map([[t.txHash, [at(nftLog(7n), 0), at(takerBid(8n, 1000n), 1)]]]), collection);
    expect(t).toMatchObject({ marketplace: 'looksrare', priceWei: null });
  });

  it('prices a Wyvern sale in ETH when no token moved as payment', () => {
    const t = transfer('7', seller, buyer, { logIndex: 1 });
    tagSales([t], new Map([[t.txHash, [at(nftLog(7n), 1), at(matched(500n), 2)]]]), collection);
    expect(t).toMatchObject({ marketplace: 'wyvern-2', priceWei: '500', currency: '' });
  });

  it('prices a Wyvern sale in WETH when WETH moved before it', () => {
    const t = transfer('7', seller, buyer, { logIndex: 2 });
    tagSales([t], new Map([[t.txHash, [at(wethLog(450n), 0), at(wethLog(50n), 1), at(nftLog(7n), 2), at(matched(500n), 3)]]]), collection);
    expect(t).toMatchObject({ priceWei: '500', currency: WETH });
  });

  it('gives each Wyvern sale in one transaction its own price, and splits a bundle', () => {
    const one = transfer('1', seller, buyer, { logIndex: 0 });
    const two = transfer('2', seller, buyer, { txHash: one.txHash, logIndex: 2 });
    const three = transfer('3', seller, buyer, { txHash: one.txHash, logIndex: 3 });
    const logs = [at(nftLog(1n), 0), at(matched(100n), 1), at(nftLog(2n), 2), at(nftLog(3n), 3), at(matched(600n), 4)];
    tagSales([one, two, three], new Map([[one.txHash, logs]]), collection);
    expect([one.priceWei, two.priceWei, three.priceWei]).toEqual(['100', '300', '300']);
  });
});
