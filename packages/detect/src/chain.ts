import {
  AbiDecodingDataSizeTooSmallError, AbiDecodingZeroDataError, BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, SliceOffsetOutOfBoundsError,
  createPublicClient, http, toEventSelector, parseAbi, parseAbiItem, type Log, type PublicClient,
} from 'viem';
import { ZERO } from './graph.js';
import { tagSales } from './marketplaces.js';
import type { Transfer } from './types.js';

/** ERC-721 and ERC-20 share this selector; ERC-721 indexes the token id, so its log has four topics. */
export const TRANSFER = toEventSelector(parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'));

const METADATA = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)']);
/** The contract's own answer that it has no such string: a revert, no return data, or data that is not a string. */
const NO_ANSWER = [ContractFunctionRevertedError, ContractFunctionZeroDataError, AbiDecodingDataSizeTooSmallError, AbiDecodingZeroDataError, SliceOffsetOutOfBoundsError];

/**
 * The block span a log query starts at. Providers cap a query by blocks or by
 * results (Alchemy: 10,000 logs), and the cap is not advertised, so the span
 * halves on any refusal and grows back on success.
 */
export const START_SPAN = 2_000;
const MAX_SPAN = 50_000;

/**
 * Terraforms, the collection a Test reads logs of. Its filter keeps a
 * 50,000-block query small on Ethereum, and on a chain where it was never
 * deployed the query answers empty, which still tests the range limit.
 */
export const TERRAFORMS = '0x4e1f41613c9084fdb9e34e11fae9412427480e56';
/** How far back a Test reads a balance: far enough that only an archive node still holds the state. */
const ARCHIVE_DEPTH = 1_000_000;
/**
 * How long a Test waits for each read, tried once. The finalized read and
 * then the other two at once make about 12 seconds at worst, inside the
 * 20 seconds the console polls for.
 */
export const CHECK_TIMEOUT_MS = 6_000;
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
  /**
   * The client a Test reads through: one try, a short timeout, and no
   * batching, so a slow log query cannot hold the archive read in the same
   * HTTP request and fail it.
   */
  private readonly checkClient: PublicClient;
  private span = START_SPAN;

  constructor(readonly chainId: number, url: string) {
    this.client = createPublicClient({ transport: http(url, { batch: { batchSize: RECEIPT_WIDTH }, retryCount: 3, timeout: 30_000 }) });
    this.checkClient = createPublicClient({ transport: http(url, { batch: false, retryCount: 0, timeout: CHECK_TIMEOUT_MS }) });
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

  /**
   * The three things ingest needs, for the console's Test: the finalized
   * block, an archive read (a balance a million blocks back, as finding a
   * deployment block needs) and one log query as wide as ingest's widest
   * span. A part that fails is false; only an unreadable finalized block
   * throws, since without it nothing else can be asked. Each read is tried
   * once within CHECK_TIMEOUT_MS: a Test must answer while the page polls.
   */
  async check(): Promise<{ finalized: number; archive: boolean; logs: boolean }> {
    const finalized = Number((await this.checkClient.getBlock({ blockTag: 'finalized' })).number);
    const yes = () => true;
    const no = () => false;
    const [archive, logs] = await Promise.all([
      this.checkClient.getBalance({ address: ZERO, blockNumber: BigInt(Math.max(0, finalized - ARCHIVE_DEPTH)) }).then(yes, no),
      this.checkClient.request({
        method: 'eth_getLogs',
        params: [{ address: TERRAFORMS, topics: [TRANSFER], fromBlock: hex(Math.max(0, finalized - MAX_SPAN + 1)), toBlock: hex(finalized) }],
      }).then(yes, no),
    ]);
    return { finalized, archive, logs };
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
   * The contract's own name() and symbol(). Either is null where the contract
   * answers that it has none, both being optional in ERC-721: it reverts,
   * returns nothing, or returns something other than a string. Anything else,
   * such as a node that cannot be reached, throws, so it is retried and not
   * kept as an answer.
   */
  async describe(address: `0x${string}`): Promise<{ name: string | null; symbol: string | null }> {
    const read = (functionName: 'name' | 'symbol') => this.client.readContract({ address, abi: METADATA, functionName }).then(
      (v) => (v.trim() === '' ? null : v.trim().slice(0, 120)),
      (err: unknown) => {
        if (err instanceof BaseError && err.walk((e) => NO_ANSWER.some((E) => e instanceof E))) return null;
        throw err;
      },
    );
    const [name, symbol] = await Promise.all([read('name'), read('symbol')]);
    return { name, symbol };
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
