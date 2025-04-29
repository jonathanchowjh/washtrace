import { createPublicClient, http, toEventSelector, parseAbiItem, type Log, type PublicClient } from 'viem';
import { tagSales } from './marketplaces.js';
import type { Transfer } from './types.js';

/** ERC-721 and ERC-20 share this selector; ERC-721 indexes the token id, so its log has four topics. */
export const TRANSFER = toEventSelector(parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'));

/**
 * The block span a log query starts at. Providers cap a query by blocks or by
 * results (Alchemy: 10,000 logs), and the cap is not advertised, so the span
 * halves on any refusal and grows back on success.
 */
export const START_SPAN = 2_000;
const MAX_SPAN = 50_000;
/** Receipts requested at once. The transport batches them into one HTTP request. */
const RECEIPT_WIDTH = 50;

/**
 * One EVM chain, read over plain JSON-RPC. Any provider or a node of your
 * own; the paper ended on "creating my own Ethereum node for data scraping
 * would certainly be the way forward", and nothing here needs more than the
 * standard methods. An archive node is needed only to find a collection's
 * deployment block.
 */
export class Chain {
  readonly client: PublicClient;
  private span = START_SPAN;

  constructor(readonly chainId: number, url: string) {
    this.client = createPublicClient({ transport: http(url, { batch: { batchSize: RECEIPT_WIDTH }, retryCount: 3, timeout: 30_000 }) });
  }

  /**
   * The newest finalized block. Ingest never reads past it: a reorg cannot
   * unwind a finalized block, so a stored transfer is never retracted. Since
   * the Merge this trails the head by about 13 minutes on Ethereum.
   */
  async finalized(): Promise<number> {
    const block = await this.client.getBlock({ blockTag: 'finalized' });
    return Number(block.number);
  }

  /** The first block with code at `address`, by binary search. Needs archive state. */
  async deployBlock(address: `0x${string}`, head: number): Promise<number> {
    let lo = 0;
    let hi = head;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const code = await this.client.getCode({ address, blockNumber: BigInt(mid) });
      if (code && code !== '0x') hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /**
   * The collection's transfers from `from` up to at most `to`, as sales where
   * a marketplace filled them. Returns what it read and the last block it
   * covered, which may be short of `to`: one call reads one span.
   */
  async transfers(collection: string, from: number, to: number): Promise<{ transfers: Transfer[]; through: number }> {
    for (;;) {
      const through = Math.min(to, from + this.span - 1);
      let logs: RawLog[];
      try {
        logs = await this.client.request({
          method: 'eth_getLogs',
          params: [{ address: collection as `0x${string}`, topics: [TRANSFER], fromBlock: hex(from), toBlock: hex(through) }],
        }) as unknown as RawLog[];
      } catch (err) {
        if (this.span === 1) throw err;
        this.span = Math.max(1, Math.floor(this.span / 2));
        continue;
      }
      if (this.span < MAX_SPAN && logs.length < 1_000) this.span = Math.min(MAX_SPAN, this.span * 2);
      const transfers = logs.filter((l) => l.topics.length === 4 && !l.removed).map(toTransfer);
      await this.tag(transfers, collection);
      return { transfers, through };
    }
  }

  private async tag(transfers: Transfer[], collection: string): Promise<void> {
    const hashes = [...new Set(transfers.map((t) => t.txHash))];
    const logsByTx = new Map<string, readonly Log[]>();
    for (let i = 0; i < hashes.length; i += RECEIPT_WIDTH) {
      const receipts = await Promise.all(hashes.slice(i, i + RECEIPT_WIDTH).map((hash) =>
        this.client.getTransactionReceipt({ hash: hash as `0x${string}` })));
      for (const r of receipts) logsByTx.set(r.transactionHash.toLowerCase(), r.logs);
    }
    tagSales(transfers, logsByTx, collection);
  }
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
  /** Returned by Geth, Reth and most providers since 2025; absent on older nodes. */
  blockTimestamp?: string;
}

function toTransfer(l: RawLog): Transfer {
  return {
    txHash: l.transactionHash.toLowerCase(),
    logIndex: Number(l.logIndex),
    blockNumber: Number(l.blockNumber),
    blockTime: l.blockTimestamp === undefined ? null : Number(l.blockTimestamp),
    tokenId: BigInt(l.topics[3]!).toString(),
    from: topicAddress(l.topics[1]!),
    to: topicAddress(l.topics[2]!),
    marketplace: null,
    priceWei: null,
    currency: null,
  };
}

/** An indexed address is the low 20 bytes of a 32-byte topic. */
export function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function hex(n: number): `0x${string}` {
  return `0x${n.toString(16)}`;
}
