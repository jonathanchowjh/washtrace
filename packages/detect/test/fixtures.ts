import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { CollectionRow } from '../src/store.js';
import type { StoredEntry } from '../src/stored.js';
import { StoredSync } from '../src/stored-sync.js';
import type { Worker } from '../src/worker.js';
import type { Analysis, Flag, Flow, Method, MethodTotals, Transfer, Witness } from '../src/types.js';
import { ZERO } from '../src/graph.js';
import type { Input } from '../src/methods.js';
import { Payments } from '../src/payments.js';

/** Readable stand-ins for addresses: `w('a')` is a wallet named a. */
export function w(name: string): string {
  return `0x${name.padStart(40, '0')}`;
}

let seq = 0;

/** A transfer of `tokenId` from `from` to `to`, each in its own block unless one is given. */
export function transfer(tokenId: string, from: string, to: string, more: Partial<Transfer> = {}): Transfer {
  seq += 1;
  return {
    txHash: `0xtx${seq}`, logIndex: 0, blockNumber: seq, blockTime: null, tokenId, from, to,
    marketplace: null, priceWei: null, currency: null, ...more,
  };
}

/** A token's life as a chain of holders: mint to the first, then each to the next. */
export function chain(tokenId: string, ...holders: string[]): Transfer[] {
  const out = [transfer(tokenId, ZERO, holders[0]!)];
  for (let i = 1; i < holders.length; i++) out.push(transfer(tokenId, holders[i - 1]!, holders[i]!));
  return out;
}

export function flow(from: string, to: string, more: Partial<Flow> = {}): Flow {
  seq += 1;
  return { txHash: `0xflow${seq}`, kind: 'native', from, to, valueWei: '1000', token: '', blockNumber: seq, blockTime: seq, ...more };
}

export function input(transfers: Transfer[], flows: Flow[] = [], more: Partial<Input> = {}): Input {
  const wallets = new Set(transfers.flatMap((t) => [t.from, t.to]));
  return {
    transfers, payments: Payments.from(flows, transfers), fundingAvailable: true, funded: wallets, truncated: new Set(),
    custodians: new Set(), contracts: new Set(), money: new Set(['']), ...more,
  };
}

// ---- the lab fixtures ------------------------------------------------------

const DAY = 86_400;
const ETH = 10n ** 18n;
/** Midday UTC of day `d` since 2023-01-01. */
export const at = (d: number): number => Date.UTC(2023, 0, 1) / 1000 + d * DAY + DAY / 2;
export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
/** What counts as money on the lab chain: the native token and its wrapper. */
export const MONEY: ReadonlySet<string> = new Set(['', WETH]);

/** A fact as the table holds it, with the bigints as numbers. */
export interface Fact { counted: boolean; heldS: number | null; buyerAgeS: number | null; floorRatio: number | null }

type Sale = [marketplace: string, priceWei: bigint | null, currency: string | null];

/** One lab transfer, its tx hash made of its key so a read-back table can be keyed by it. */
function lab(key: string, token: string, from: string, to: string, block: number, day: number, sale?: Sale): Transfer {
  return {
    txHash: `0xlab_${key.toLowerCase()}`, logIndex: 0, blockNumber: block, blockTime: at(day), tokenId: token, from, to,
    marketplace: sale?.[0] ?? null, priceWei: sale?.[1]?.toString() ?? null, currency: sale?.[2] ?? null,
  };
}

function totals(
  counted: number, sales: number, volume: bigint, flagged: number, flaggedSales: number, flaggedVolume: bigint,
  wallets: number, tokens: number, available: boolean,
): MethodTotals {
  return {
    transfers: counted, flagged, sales, flaggedSales, volumeWei: volume.toString(), flaggedVolumeWei: flaggedVolume.toString(),
    wallets, tokens, available,
  };
}

function flagsOf(txs: readonly Transfer[], methods: readonly Method[], witness: Witness): Flag[] {
  return methods.flatMap((method) => txs.map((t) => ({ txHash: t.txHash, logIndex: t.logIndex, method, witness })));
}

const [W1, W2, W3, W4, W5, W6, W7, W8] = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'].map(w) as
  [string, string, string, string, string, string, string, string];
const blur = (price: bigint | null, currency: string | null = ''): Sale => ['blur', price, currency];
const labTransfers = {
  M1: lab('M1', '1', ZERO, W1, 100, 0),
  S1: lab('S1', '1', W1, W2, 200, 10, blur(ETH)),
  S5: lab('S5', '2', W5, W6, 250, 11, blur(2n * ETH)),
  S2: lab('S2', '1', W2, W3, 300, 12, ['seaport-1.6', 3n * ETH, '']),
  U1: lab('U1', '2', W6, W7, 350, 13, blur(100_000_000n, USDC)),
  P1: lab('P1', '2', W7, W8, 360, 14, blur(null, null)),
  S3: lab('S3', '1', W3, W1, 400, 50, blur(2n * ETH)),
  S4: lab('S4', '1', W1, W2, 500, 51, blur(ETH)),
};
const labWash = [labTransfers.S1, labTransfers.S2, labTransfers.S3, labTransfers.S4];
const labScc: Witness = { kind: 'scc', wallets: [W1, W2, W3], cycles: 2 };
const days = (n: number) => n * DAY;

/**
 * One collection with a mint, a ring traded round twice, an USDC sale and an
 * unpriced one; its analysis (saved with `cursor_block` 600, no funding) and
 * the facts it should give. LATE is past the cursor: ingested, never judged.
 */
export const LAB = {
  cursor: 600,
  transfers: Object.values(labTransfers),
  late: lab('LATE', '1', W2, W4, 900, 60, blur(ETH)),
  /** A transfer's fixture key, from its tx hash. */
  keyOf: (txHash: string): string => txHash.replace('0xlab_', '').toUpperCase(),
  analysis: {
    totals: {
      A: totals(7, 7, 9n * ETH, 4, 4, 7n * ETH, 3, 1, true),
      AU: totals(7, 7, 9n * ETH, 0, 0, 0n, 0, 0, false),
      AC: totals(7, 7, 9n * ETH, 0, 0, 0n, 0, 0, false),
    },
    flags: flagsOf(labWash, ['A', 'AU', 'AC'], labScc),
    uncounted: [{ txHash: labTransfers.M1.txHash, logIndex: 0 }],
    missingData: 0, fundedWallets: 0, wallets: 8, truncatedSearches: 0,
  } satisfies Analysis,
  facts: {
    M1: { counted: false, heldS: null, buyerAgeS: 0, floorRatio: null },
    S1: { counted: true, heldS: days(10), buyerAgeS: 0, floorRatio: null },
    S5: { counted: true, heldS: null, buyerAgeS: 0, floorRatio: 2 },
    S2: { counted: true, heldS: days(2), buyerAgeS: 0, floorRatio: 2 },
    U1: { counted: true, heldS: days(2), buyerAgeS: 0, floorRatio: null },
    P1: { counted: true, heldS: days(1), buyerAgeS: 0, floorRatio: null },
    S3: { counted: true, heldS: days(38), buyerAgeS: days(50), floorRatio: null },
    S4: { counted: true, heldS: days(1), buyerAgeS: days(41), floorRatio: 0.5 },
  } as Record<string, Fact>,
};

const [W10, W11, W12, W13] = ['w10', 'w11', 'w12', 'w13'].map(w) as [string, string, string, string];
const mixed = {
  Q1: lab('Q1', '3', W10, W11, 10, 1, blur(ETH)),
  Q2: lab('Q2', '3', W11, W10, 20, 2, blur(ETH)),
  Q3: lab('Q3', '3', W10, W11, 30, 3, blur(ETH)),
  Q4: lab('Q4', '3', W11, W12, 40, 4, blur(ETH)),
};

/** A second collection, funded so all three lenses ran: a pair wash caught by A, AU and AC, and Q4 by AC alone. */
export const LAB_MIXED = {
  cursor: 50,
  transfers: Object.values(mixed),
  keyOf: LAB.keyOf,
  analysis: {
    totals: {
      A: totals(4, 4, 4n * ETH, 3, 3, 3n * ETH, 2, 1, true),
      AU: totals(4, 4, 4n * ETH, 3, 3, 3n * ETH, 2, 1, true),
      AC: totals(4, 4, 4n * ETH, 4, 4, 4n * ETH, 3, 1, true),
    },
    flags: [
      ...flagsOf([mixed.Q1, mixed.Q2, mixed.Q3], ['A', 'AU', 'AC'], { kind: 'scc', wallets: [W10, W11], cycles: 2 }),
      ...flagsOf([mixed.Q4], ['AC'], { kind: 'pair', pair: [W11, W12], middle: W13, flowTx: '0xlab_x1' }),
    ],
    uncounted: [],
    missingData: 0, fundedWallets: 4, wallets: 4, truncatedSearches: 0,
  } satisfies Analysis,
};

// ---- the worker fixtures ---------------------------------------------------

/** No test reaches the Hub: one that forgets to say what the Hub answers finds it unreachable, and downloads nothing. */
export function refuseHub(): void {
  vi.spyOn(StoredSync.prototype, 'fetchHubManifest').mockRejectedValue(new Error('tests never reach the Hub'));
  vi.spyOn(StoredSync.prototype, 'downloadFile').mockRejectedValue(new Error('tests never reach the Hub'));
}

/** The Hub was asked a moment ago, so a pass reads the manifest on disk (`manifest`, as the test overrides it) and asks nothing. */
export function askedHub(w: Worker): Worker {
  (w.sync as any).hubAskedAt = Date.now();
  return w;
}

/**
 * The connection a lock is held on, as Store.locked hands it over and as
 * pg's: it emits 'error' when lost, and answers a query while `alive`.
 */
export function lockClient() {
  const client = Object.assign(new EventEmitter(), { alive: true, query: async () => { if (!client.alive) throw new Error('Connection terminated unexpectedly'); return { rows: [] }; } });
  return client;
}

/** A store whose `locked` runs the pass at once on a live lock connection; `over` is the rest of what the test needs. */
export const stubStore = (over: Record<string, unknown>) => ({
  locked: async (_key: number, _wait: boolean, fn: (c: unknown) => Promise<void>) => { await fn(lockClient()); return 'ran'; }, ...over,
});

/**
 * An analyze pass's analysis, without the lock or the pick: the collection
 * dueAnalysis gives, analysed, or 'nothing due' when none is. It rejects as
 * the analysis does, where a pass would only record the failure.
 */
export async function analyzeDue(w: Worker): Promise<string> {
  const c = await w.dueAnalysis(Date.now());
  return c === null ? 'nothing due' : (w as any).analyzeOne(c);
}

export function row(more: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1, chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, cursorBlock: 995, headBlock: 1_000,
    addedAt: 0, ingestedAt: 0, error: null, errorAt: null, transfers: 10, wallets: 4, fundedWallets: 4,
    stale: false, latest: null, servedAt: null, readRate: null, priority: false, pausedAt: null, rules: {}, contract: null,
    restoreProgress: null, restoreNote: null, restoreNoteKey: null, restoreRetryAt: null, analysisError: null, analysisRetryAt: null, storedThroughTime: null, storedThroughBlock: null, trailImportedSha: null, trailNote: null, trailProgress: null,
    downloadFile: null, downloadProgress: null, downloadNote: null, downloadRetryAt: null, downloadMismatch: null, readTokens: false, ...more,
  };
}

export const ENTRY: StoredEntry = {
  chainId: 1, address: '0xbc4c', name: 'BAYC', startBlock: 100, throughBlock: 900, throughTime: 1_700_000_000_000,
  transfers: { file: '1-0xbc4c.transfers.csv.zst', rows: 3, bytes: 10, sha256: 'abc' }, trail: null,
};
