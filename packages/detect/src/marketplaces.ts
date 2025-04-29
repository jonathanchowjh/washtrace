import { decodeEventLog, parseAbi, toEventSelector, type Log } from 'viem';
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

const SEAPORT = parseAbi([
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
]);
export const ORDER_FULFILLED = toEventSelector(SEAPORT[0]);

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
 * transaction. Seaport fills are priced from OrderFulfilled. Other venues'
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
      if (!venue.startsWith('seaport') || log.topics[0] !== ORDER_FULFILLED) continue;
      const priced = seaportPrice(log, collection, BigInt(t.tokenId));
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
