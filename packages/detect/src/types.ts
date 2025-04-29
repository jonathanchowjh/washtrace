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

/**
 * The three detection methods from the paper, by its own acronyms.
 *
 * - `A`  SCC detection on the asset transfer graph.
 * - `AU` SCC detection on the asset transfer graph joined to the directed
 *        user transaction graph.
 * - `AC` SCC detection on the asset transfer graph, unioned with depth-2
 *        cycles through the undirected user transaction graph.
 */
export type Method = 'A' | 'AU' | 'AC';
export const METHODS: readonly Method[] = ['A', 'AU', 'AC'];

/** Why one transfer was flagged by one method: enough to draw it. */
export type Witness =
  | { kind: 'scc'; wallets: string[]; cycles: number }
  | { kind: 'scc+flow'; wallets: string[]; cycles: number; via: [string, string][] }
  | { kind: 'pair'; pair: [string, string]; middle: string | null; flowTx: string };

export interface Flag {
  txHash: string;
  logIndex: number;
  method: Method;
  witness: Witness;
}

/** One method's totals for a collection. Paper Table 3's "Wash Trade Share" is `flagged / transfers`. */
export interface MethodTotals {
  /** Ownership changes counted: mints, burns, custody round trips and inferred bridges excluded. */
  transfers: number;
  flagged: number;
  sales: number;
  flaggedSales: number;
  /** Priced sales only, in wei of the native token and its wrappers. */
  volumeWei: string;
  flaggedVolumeWei: string;
  wallets: number;
  tokens: number;
  /** False when the method needs funding data and no funding source is configured. */
  available: boolean;
}

export interface Analysis {
  totals: Record<Method, MethodTotals>;
  flags: Flag[];
  /** Share of ownership changes whose sender was not the previous receiver: the paper's missing-data measure. */
  missingData: number;
  /** Wallets in the collection whose funding has been read, over all of them. */
  fundedWallets: number;
  wallets: number;
  /** Reach searches that stopped at the visit cap rather than at depth 30. */
  truncatedSearches: number;
}
