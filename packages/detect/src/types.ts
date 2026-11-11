/**
 * The paper's "Transaction Details" interface, split in two. In 2023 one
 * shape was backfilled with dummy fields so trades, transfers and ETH
 * transfers could share it. Here each source gets the shape it can fill,
 * and a field nobody could read is `null`, never a placeholder.
 *
 * Addresses are lowercase hex everywhere. Amounts are decimal strings of wei:
 * they exceed 2^53, and are summed as bigint only where they are summed.
 */

/** One ERC-721 Transfer log of a watched collection: an edge of the asset transfer graph. */
export interface Transfer {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Seconds. Null when the RPC did not return `blockTimestamp` on the log. */
  blockTime: number | null;
  /** uint256 as a decimal string. */
  tokenId: string;
  from: string;
  to: string;
  /** The marketplace whose fill event is in the same transaction. Null: not a sale. */
  marketplace: string | null;
  /** What the buyer paid for this token, in wei of `currency`. Null when unpriced or not a sale. */
  priceWei: string | null;
  /** '' for the chain's native token, else the ERC-20 address. Null when unpriced. */
  currency: string | null;
}

/** How money moved in a flow. Each is a separate Etherscan action. */
export type FlowKind = 'native' | 'internal' | 'token';

/** One movement of money between two wallets: an edge of the user transaction graph. */
export interface Flow {
  txHash: string;
  kind: FlowKind;
  from: string;
  to: string;
  valueWei: string;
  /** '' for native and internal; the ERC-20 address for token flows. */
  token: string;
  blockNumber: number;
  blockTime: number;
}

/** One transfer of a listed token (TOKENS) between two wallets. Kept apart from Flow: it is never ETH-denominated money. */
export interface TokenFlow {
  txHash: string;
  from: string;
  to: string;
  /** The ERC-20 address, lowercase; always one of TOKENS for the chain. */
  token: string;
  /** Raw units, as Etherscan gives them: decimals come from TOKENS. */
  valueRaw: string;
  blockNumber: number;
  blockTime: number;
}

/**
 * The three detection methods from the paper, by its own acronyms.
 *
 * - `A`  SCC detection on the asset transfer graph.
 * - `AU` SCC detection on the asset transfer graph joined to the directed
 *        user transaction graph.
 * - `AC` SCC detection on the asset transfer graph, unioned with depth-2
 *        cycles through the undirected user transaction graph.
 *
 * The console calls a method a lens: `A` is Round trips, `AU` Money loops
 * back and `AC` Linked wallets.
 */
export type Method = 'A' | 'AU' | 'AC';
export const METHODS: readonly Method[] = ['A', 'AU', 'AC'];
/**
 * The lenses a trade is counted flagged by, Round trips to Linked wallets; the
 * console's headline range reads the same. Here so a wallet's "flagged only"
 * in SQL and the console's verdict read one list.
 */
export const HEADLINE: readonly Method[] = ['A', 'AC'];

/**
 * Which way the money went between a linked pair's seller and buyer. Through
 * a middle: `funder` it paid both, `payee` both paid it, `back` the buyer paid
 * it and it paid the seller, `forward` the seller paid it and it paid the
 * buyer. Direct: `direct-back` the buyer paid the seller, `direct-forward` the
 * seller paid the buyer, `both` each paid the other. Of several that hold
 * through a middle, the first of back, forward, funder, payee; one always
 * does, since the middle paid or was paid by each.
 */
export type PairShape = 'funder' | 'payee' | 'back' | 'forward' | 'direct-back' | 'direct-forward' | 'both';
export const PAIR_SHAPES: readonly PairShape[] = ['funder', 'payee', 'back', 'forward', 'direct-back', 'direct-forward', 'both'];

/**
 * A chain of payments from one wallet to another, possibly out of block
 * order: each wallet on it, both ends included, and `txs[i]` the payment from
 * `wallets[i]` to `wallets[i + 1]` (of several, the smallest hash).
 */
export type MoneyPath = { wallets: string[]; txs: string[] };

/**
 * Why one transfer was flagged by one method: enough to draw it. A pair's
 * `shape` is absent on one an analysis stored before shapes were recorded.
 * A loop's `paths`, at most 4, are for its first `via` edges: each matches
 * its edge by its ends, not by index. They are absent on one stored before
 * paths were recorded.
 */
export type Witness =
  | { kind: 'scc'; wallets: string[]; cycles: number }
  | { kind: 'scc+flow'; wallets: string[]; cycles: number; via: [string, string][]; paths?: MoneyPath[] }
  | { kind: 'pair'; pair: [string, string]; middle: string | null; flowTx: string; shape?: PairShape };

/**
 * How a lens used one payment (payments.ts useOf): Linked wallets, with
 * `named` when it is the payment the witness names; or Money loops back, on
 * the money back from `back[0]` to `back[1]`. Not a time order of anything.
 */
export type PaymentUse = { method: 'AC'; named: boolean } | { method: 'AU'; back: [string, string] };

export interface Flag {
  txHash: string;
  logIndex: number;
  method: Method;
  witness: Witness;
}

/** One method's totals for a collection. Paper Table 3's "Wash Trade Share" is `flagged / transfers`. */
export interface MethodTotals {
  /** Ownership-change hops counted: mints, burns, custody round trips and inferred bridges excluded. Stored and sent as `transfers`. */
  transfers: number;
  flagged: number;
  sales: number;
  flaggedSales: number;
  /** Priced sales only, in wei of the native token and its wrappers. */
  volumeWei: string;
  flaggedVolumeWei: string;
  /** Wallets this method flagged (unlike `Analysis.wallets`, all the collection's). Stored and sent as `wallets`. */
  wallets: number;
  tokens: number;
  /** False when the method needs funding data and no funding source is configured. */
  available: boolean;
}

export interface Analysis {
  totals: Record<Method, MethodTotals>;
  flags: Flag[];
  /** Every input transfer no hop stands for (mints, burns, custody moves), so a list can say "not counted" for them. */
  uncounted: { txHash: string; logIndex: number }[];
  /** Share of ownership changes whose sender was not the previous receiver: the paper's missing-data measure. */
  missingData: number;
  /** Wallets in the collection whose funding has been read, over all of them. */
  fundedWallets: number;
  wallets: number;
  /** Reach searches that stopped at the visit cap rather than at depth 30. */
  truncatedSearches: number;
}
