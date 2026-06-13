import { decodeEventLog, parseAbi, toEventSelector, type Log } from 'viem';
import { ZERO } from './graph.js';
import type { Transfer } from './types.js';

/**
 * The venues a transfer can be a sale on, by the contract that emits the fill.
 * Seaport is deployed at the same address on every EVM chain.
 *
 * In 2023 the paper read Seaport 1.4 and 1.5 through Moralis. Since then
 * OpenSea moved to Seaport 1.6, and Blur took most of Ethereum's NFT volume,
 * much of it wash trading for points: CryptoSlam counted at least
 * $577M of Blur-linked wash sales.
 */
export const MARKETPLACES: Readonly<Record<string, string>> = {
  '0x00000000006c3852cbef3e08e8df289169ede581': 'seaport-1.1',
  '0x00000000000001ad428e4906ae43d8f9852d0dd6': 'seaport-1.4',
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc': 'seaport-1.5',
  '0x0000000000000068f116a894984e2db1123eb395': 'seaport-1.6',
  '0x000000000000ad05ccc4f10045630fb830b95127': 'blur',
  '0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5': 'blur-v2',
  '0x0000000000e655fae4d56241588680f86e3b2377': 'looksrare-v2',
  '0x74312363e45dcaba76c59ec49a7aa8a65a67eed3': 'x2y2',
  // 2022, the paper's year. LooksRare paid its token for volume, which is
  // most of the wash trading the paper measured; OpenSea ran on Wyvern until
  // Seaport replaced it in June.
  '0x59728544b08ab483533076417fbbb2fd0b17ce3a': 'looksrare',
  '0x7be8076f4ea4a4ad08075c2508e481d6c946d12b': 'wyvern-1',
  '0x7f268357a8c2552623316e2562d90e642bb538e5': 'wyvern-2',
};

/** Escrows that hold a token without owning it. See tokenGraph. */
export const CUSTODIANS: readonly string[] = [
  // Blur Blend: NFT-backed loans. The token sits here for the loan's life.
  '0x29469395eaf6f95920e59f858042f0e28d98a20b',
];

/** Wrapped native tokens per chain id. Their transfers are money, and their amounts are volume. */
export const WRAPPED: Readonly<Record<number, readonly string[]>> = {
  1: [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0x0000000000a39bb272e79075ade125fd351887ac', // Blur Pool: Blur's bidding balance
  ],
  8453: ['0x4200000000000000000000000000000000000006'], // WETH on Base
};

/** Contracts never treated as the middle of a money path, beyond the marketplaces themselves. */
export const INFRASTRUCTURE: readonly string[] = [
  '0x1e0049783f008a0085193e00003d00cd54003c71', // OpenSea conduit
  '0x0000a26b00c1f0df003000390027140000faa719', // OpenSea fee recipient
];

export function contractsFor(chainId: number): Set<string> {
  return new Set([...Object.keys(MARKETPLACES), ...CUSTODIANS, ...INFRASTRUCTURE, ...(WRAPPED[chainId] ?? [])]);
}

export function moneyFor(chainId: number): Set<string> {
  return new Set(['', ...(WRAPPED[chainId] ?? [])]);
}

/**
 * The wallets some transfers queue for a funding check: every sender and
 * receiver, once per transfer, but the zero address and the chain's
 * contracts, which are not traders. Reading the chain and loading stored
 * data queue the same.
 */
export function traders(chainId: number, transfers: readonly Pick<Transfer, 'from' | 'to'>[]): string[] {
  const contracts = contractsFor(chainId);
  return transfers.flatMap((t) => [t.from, t.to]).filter((a) => a !== ZERO && !contracts.has(a));
}

const SEAPORT = parseAbi([
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
]);
export const ORDER_FULFILLED = toEventSelector(SEAPORT[0]);

const LOOKSRARE = parseAbi([
  'event TakerAsk(bytes32 orderHash, uint256 orderNonce, address indexed taker, address indexed maker, address indexed strategy, address currency, address collection, uint256 tokenId, uint256 amount, uint256 price)',
  'event TakerBid(bytes32 orderHash, uint256 orderNonce, address indexed taker, address indexed maker, address indexed strategy, address currency, address collection, uint256 tokenId, uint256 amount, uint256 price)',
]);
const TAKER = new Set(LOOKSRARE.map((e) => toEventSelector(e)));

const WYVERN = parseAbi(['event OrdersMatched(bytes32 buyHash, bytes32 sellHash, address indexed maker, address indexed taker, uint256 price, bytes32 indexed metadata)']);
const ORDERS_MATCHED = toEventSelector(WYVERN[0]);
/** ERC-20 and ERC-721 Transfer share it; ERC-721 indexes the token id, so its log has four topics. */
const TRANSFER = toEventSelector('event Transfer(address indexed from, address indexed to, uint256 value)');

// Seaport's ItemType enum.
const NATIVE = 0;
const ERC20 = 1;
const ERC721 = 2;
const ERC721_WITH_CRITERIA = 4;

interface Item { itemType: number; token: string; identifier: bigint; amount: bigint }

/**
 * Mark which transfers are sales, and price what can be priced, from the
 * logs of the transactions they were in.
 *
 * A transfer is a sale when a known marketplace emitted any log in its
 * transaction. Seaport fills are priced from OrderFulfilled, LooksRare v1
 * from TakerAsk and TakerBid, and Wyvern from OrdersMatched. Other venues'
 * sales are marked and left unpriced: Blur v2 packs price into bit fields of
 * its own events, not decoded here yet, and a guessed price would be summed
 * into volume as though it were read.
 */
export function tagSales(transfers: Transfer[], logsByTx: ReadonlyMap<string, readonly Log[]>, collection: string): void {
  for (const t of transfers) {
    const logs = logsByTx.get(t.txHash);
    if (!logs) continue;
    for (const log of logs) {
      const venue = MARKETPLACES[log.address.toLowerCase()];
      if (venue === undefined) continue;
      t.marketplace ??= venue;
      const topic = log.topics[0];
      const priced = venue.startsWith('seaport') && topic === ORDER_FULFILLED ? seaportPrice(log, collection, BigInt(t.tokenId))
        : venue === 'looksrare' && topic !== undefined && TAKER.has(topic) ? looksRarePrice(log, collection, BigInt(t.tokenId))
        : venue.startsWith('wyvern') && topic === ORDERS_MATCHED ? wyvernPrice(logs, log, t.logIndex)
        : null;
      if (priced) {
        t.marketplace = venue;
        t.priceWei = priced.priceWei;
        t.currency = priced.currency;
        break;
      }
    }
  }
}

/**
 * What one Seaport fill paid for one token. The currency is on whichever side
 * the token is not: a listing offers the token for currency in its
 * consideration, a bid offers currency for the token. A fill of several
 * tokens is split evenly across them, which is what the order states.
 * Mixed currencies are unpriced rather than added together.
 */
export function seaportPrice(log: Log, collection: string, tokenId: bigint): { priceWei: string; currency: string } | null {
  let args: { offer: readonly Item[]; consideration: readonly Item[] };
  try {
    ({ args } = decodeEventLog({ abi: SEAPORT, data: log.data, topics: log.topics as [`0x${string}`] }) as unknown as { args: typeof args });
  } catch {
    return null;
  }
  const isToken = (i: Item) =>
    (i.itemType === ERC721 || i.itemType === ERC721_WITH_CRITERIA) && i.token.toLowerCase() === collection;
  const isMoney = (i: Item) => i.itemType === NATIVE || i.itemType === ERC20;
  const offered = args.offer.some((i) => isToken(i) && i.identifier === tokenId);
  const asked = args.consideration.some((i) => isToken(i) && i.identifier === tokenId);
  if (!offered && !asked) return null;
  const tokenSide = offered ? args.offer : args.consideration;
  const moneySide = offered ? args.consideration : args.offer;
  const paid = moneySide.filter(isMoney);
  if (paid.length === 0) return null;
  const currency = paid[0]!.itemType === NATIVE ? '' : paid[0]!.token.toLowerCase();
  if (paid.some((i) => (i.itemType === NATIVE ? '' : i.token.toLowerCase()) !== currency)) return null;
  const count = BigInt(tokenSide.filter(isToken).length);
  const total = paid.reduce((s, i) => s + i.amount, 0n);
  return { priceWei: (total / count).toString(), currency };
}

/** What one LooksRare v1 fill paid. The event names the collection, the token and the currency, so nothing is inferred. */
export function looksRarePrice(log: Log, collection: string, tokenId: bigint): { priceWei: string; currency: string } | null {
  let args: { currency: string; collection: string; tokenId: bigint; amount: bigint; price: bigint };
  try {
    ({ args } = decodeEventLog({ abi: LOOKSRARE, data: log.data, topics: log.topics as [`0x${string}`] }) as unknown as { args: typeof args });
  } catch {
    return null;
  }
  if (args.collection.toLowerCase() !== collection || args.tokenId !== tokenId || args.amount === 0n) return null;
  return { priceWei: (args.price / args.amount).toString(), currency: args.currency.toLowerCase() };
}

/**
 * What one Wyvern match paid for the token transferred at `logIndex`. The
 * event has the price and nothing else: the tokens it sold are the ERC-721
 * transfers logged since the previous match in the transaction, and it was
 * paid in whatever ERC-20 moved in that stretch, or in ETH where none did.
 * A bundle is split evenly; mixed currencies are unpriced.
 */
export function wyvernPrice(logs: readonly Log[], match: Log, logIndex: number): { priceWei: string; currency: string } | null {
  const end = match.logIndex ?? -1;
  const start = Math.max(-1, ...logs.filter((l) => l.topics[0] === ORDERS_MATCHED && (l.logIndex ?? -1) < end).map((l) => l.logIndex ?? -1));
  if (logIndex <= start || logIndex >= end) return null;
  const stretch = logs.filter((l) => (l.logIndex ?? -1) > start && (l.logIndex ?? -1) < end && l.topics[0] === TRANSFER);
  const tokens = stretch.filter((l) => l.topics.length === 4).length;
  const paidIn = new Set(stretch.filter((l) => l.topics.length === 3).map((l) => l.address.toLowerCase()));
  if (tokens === 0 || paidIn.size > 1) return null;
  let price: bigint;
  try {
    price = (decodeEventLog({ abi: WYVERN, data: match.data, topics: match.topics as [`0x${string}`] }).args as { price: bigint }).price;
  } catch {
    return null;
  }
  return { priceWei: (price / BigInt(tokens)).toString(), currency: [...paidIn][0] ?? '' };
}
