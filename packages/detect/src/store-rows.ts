// Row mappers, their SELECTs and the bulk writes ingest, funding and loads of stored data share: apart from
// store.ts because none of them needs the Store's connection.
import pg from 'pg';
import { checkRule } from './lens-rule.js';
import type { AnalysisRow, CollectionRow, Lens, LensRun, LoopEdge, OwnFlag } from './store.js';
import type { Flow, Transfer } from './types.js';

/** Postgres's code for a statement it ended to break a deadlock. */
const DEADLOCK_DETECTED = '40P01';
/** Wallets a load queues per statement, in address order. */
const QUEUE_BATCH = 10_000;
/** A batch of flags is cut at this many rows or this many characters of witness, whichever comes first. */
export const FLAG_BATCH_ROWS = 10_000;
export const FLAG_BATCH_CHARS = 16 * 2 ** 20;

// A path stored before LoopEdge had a token has none: it was never an other-token edge.
export const toOwnFlag = (r: any): OwnFlag => ({
  lensId: r.lens_id, collectionId: r.collection_id, txHash: r.tx_hash, logIndex: r.log_index,
  path: (r.path as LoopEdge[]).map((e) => ({ ...e, token: e.token ?? null })), wallets: r.wallets,
});

export const LENS_SELECT = `
SELECT l.id, l.name, l.rule, l.version, extract(epoch FROM l.created_at)::float8 AS created, extract(epoch FROM l.updated_at)::float8 AS updated
FROM washtrace.lenses l`;

/** A stored rule is checked on the way out: the routes check it on the way in, so one that fails is a corrupt row. */
export function toLens(r: any): Lens {
  const checked = checkRule(r.rule);
  if ('error' in checked) throw new Error(`The rule of lens ${r.id} is corrupt: ${checked.error}`);
  return { id: r.id, key: `L${r.id}`, name: r.name, rule: checked.rule, version: r.version, createdAt: r.created * 1000, updatedAt: r.updated * 1000 };
}

export function toLensRun(r: any): LensRun {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    lensId: r.run_lens, collectionId: r.collection_id, status: r.status, progress: r.progress, lensVersion: r.lens_version,
    analysisId: num(r.analysis_id), throughBlock: num(r.through_block), totals: r.totals, error: r.error,
    retryAt: r.retry === null ? null : r.retry * 1000, finishedAt: r.finished === null ? null : r.finished * 1000, tookMs: r.took_ms,
    tokensRead: r.tokens_read ?? null,
  };
}

export const COLLECTION_SELECT = `
SELECT c.*, extract(epoch FROM c.added_at)::float8 AS added, extract(epoch FROM c.ingested_at)::float8 AS ingested,
       extract(epoch FROM c.error_at)::float8 AS errored, extract(epoch FROM c.served_at)::float8 AS served, extract(epoch FROM c.paused_at)::float8 AS paused,
       extract(epoch FROM c.stored_through_time)::float8 AS stored_through, extract(epoch FROM c.restore_retry_at)::float8 AS restore_retry,
       extract(epoch FROM c.analysis_retry_at)::float8 AS analysis_retry, extract(epoch FROM c.download_retry_at)::float8 AS download_retry,
       (SELECT count(*)::int FROM washtrace.transfers t WHERE t.collection_id = c.id) AS transfer_count,
       a.id AS analysis_id, a.took_ms, a.through_block, a.totals, a.missing_data, a.funded_wallets, a.wallets, a.truncated_searches, a.loops, a.rings,
       extract(epoch FROM a.ran_at)::float8 AS ran
FROM washtrace.collections c
LEFT JOIN LATERAL (SELECT * FROM washtrace.analyses x WHERE x.collection_id = c.id ORDER BY x.ran_at DESC LIMIT 1) a ON true`;

export function toFlow(r: any): Flow {
  return {
    txHash: r.tx_hash, kind: r.kind, from: r.from_address, to: r.to_address, valueWei: String(r.value_wei),
    token: r.token, blockNumber: Number(r.block_number), blockTime: r.bt,
  };
}

/** `id` apart: a collection's row carries its own `id`, and its latest analysis's as `analysis_id`. */
export function toAnalysis(r: any, id: unknown): AnalysisRow {
  return {
    id: Number(id), ranAt: r.ran * 1000, tookMs: r.took_ms, throughBlock: r.through_block === null ? null : Number(r.through_block),
    totals: r.totals, missingData: r.missing_data, fundedWallets: r.funded_wallets, wallets: r.wallets, truncatedSearches: r.truncated_searches,
    loops: r.loops ?? null, rings: r.rings ?? null,
  };
}

export function toCollection(r: any): CollectionRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: r.id, chainId: r.chain_id, address: r.address, name: r.name,
    startBlock: num(r.start_block), cursorBlock: num(r.cursor_block), headBlock: num(r.head_block),
    addedAt: r.added * 1000, ingestedAt: r.ingested === null ? null : r.ingested * 1000,
    error: r.error, errorAt: r.errored === null ? null : r.errored * 1000,
    transfers: r.transfer_count,
    wallets: r.wallets ?? 0, fundedWallets: r.funded_wallets ?? 0,
    stale: Number(r.version) > Number(r.analyzed_version),
    latest: r.analysis_id === null ? null : toAnalysis(r, r.analysis_id),
    servedAt: r.served === null ? null : r.served * 1000, readRate: num(r.read_rate), priority: r.priority,
    pausedAt: r.paused === null ? null : r.paused * 1000,
    restoreProgress: num(r.restore_progress), restoreNote: r.restore_note, restoreNoteKey: r.restore_note_key,
    restoreRetryAt: r.restore_retry === null ? null : r.restore_retry * 1000,
    analysisError: r.analysis_error, analysisRetryAt: r.analysis_retry === null ? null : r.analysis_retry * 1000,
    storedThroughTime: r.stored_through === null ? null : r.stored_through * 1000,
    storedThroughBlock: r.stored_through_block === null ? null : Number(r.stored_through_block),
    trailImportedSha: r.trail_imported_sha, trailNote: r.trail_note, trailProgress: num(r.trail_progress),
    downloadFile: r.download_file, downloadProgress: num(r.download_progress), downloadNote: r.download_note,
    downloadRetryAt: r.download_retry === null ? null : r.download_retry * 1000, downloadMismatch: r.download_mismatch,
    readTokens: r.read_tokens_at !== null,
    rules: r.rules ?? {},
    contract: r.described_at === null ? null : { name: r.contract_name, symbol: r.symbol, creator: r.creator, creationTx: r.creation_tx },
  };
}

/**
 * Insert transfers, keeping any already stored, and return the senders and
 * receivers of the ones that were new. Ingest and a load of stored data
 * share it.
 */
export async function insertTransfers(c: pg.PoolClient, id: number, transfers: readonly Transfer[]): Promise<{ from: string; to: string }[]> {
  if (transfers.length === 0) return [];
  const { rows } = await c.query<{ from: string; to: string }>(
    `INSERT INTO washtrace.transfers
       (collection_id, tx_hash, log_index, block_number, block_time, token_id, from_address, to_address, marketplace, price_wei, currency)
     SELECT $1, tx, li, bn, to_timestamp(bt), tok, fr, too, mk, pr, cur
     FROM unnest($2::text[], $3::int[], $4::bigint[], $5::float8[], $6::numeric[], $7::text[], $8::text[], $9::text[], $10::numeric[], $11::text[])
       AS u(tx, li, bn, bt, tok, fr, too, mk, pr, cur)
     ON CONFLICT DO NOTHING
     RETURNING from_address AS "from", to_address AS "to"`,
    [
      id,
      transfers.map((t) => t.txHash), transfers.map((t) => t.logIndex), transfers.map((t) => t.blockNumber),
      transfers.map((t) => t.blockTime), transfers.map((t) => t.tokenId), transfers.map((t) => t.from),
      transfers.map((t) => t.to), transfers.map((t) => t.marketplace), transfers.map((t) => t.priceWei),
      transfers.map((t) => t.currency),
    ],
  );
  return rows;
}

/**
 * Insert flows, keeping any already stored: a flow between two checked
 * wallets is read from both sides, and is one edge. Funding and a loaded
 * money trail share it. Gives how many are new here, so a re-read knows
 * whether it found anything (Store.saveMoney); a count, not the rows, as a
 * trail loads millions of flows and needs neither.
 */
export async function insertFlows(c: pg.Pool | pg.PoolClient, chainId: number, flows: readonly Flow[]): Promise<number> {
  if (flows.length === 0) return 0;
  const { rowCount } = await c.query(
    `INSERT INTO washtrace.flows (chain_id, tx_hash, kind, from_address, to_address, value_wei, token, block_number, block_time)
     SELECT $1, tx, k, fr, too, v, tok, bn, to_timestamp(bt)
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::text[], $8::bigint[], $9::float8[])
       AS u(tx, k, fr, too, v, tok, bn, bt)
     ON CONFLICT DO NOTHING`,
    [
      chainId, flows.map((f) => f.txHash), flows.map((f) => f.kind), flows.map((f) => f.from), flows.map((f) => f.to),
      flows.map((f) => f.valueWei), flows.map((f) => f.token), flows.map((f) => f.blockNumber), flows.map((f) => f.blockTime),
    ],
  );
  return rowCount ?? 0;
}

/** The Postgres error code an error carries, or undefined for one that has none (or is no error object). */
export function pgCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** `statement`, run again in place up to three times when Postgres ends it to break a deadlock. Only for a statement that is safe to run twice. */
export async function deadlockRetried<T>(statement: () => Promise<T>): Promise<T> {
  for (let retries = 0; ; retries++) {
    try {
      return await statement();
    } catch (err) {
      if (retries >= 3 || pgCode(err) !== DEADLOCK_DETECTED) throw err;
    }
  }
}

/** How many times each address appears. */
export function tally(addresses: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of addresses) counts.set(a, (counts.get(a) ?? 0) + 1);
  return counts;
}

/**
 * Queue wallets for a funding check, weighted by how often they traded. A
 * wallet a collection traded is a trader, depth 0, even if it was first met
 * as a followed one. In address order, so two writers lock wallets in the
 * same order. Ingest and a load of stored data share it.
 */
export async function queueWallets(c: pg.PoolClient, chainId: number, counts: ReadonlyMap<string, number>): Promise<void> {
  const sorted = [...counts.keys()].sort();
  for (let at = 0; at < sorted.length; at += QUEUE_BATCH) {
    const addresses = sorted.slice(at, at + QUEUE_BATCH);
    await c.query(
      `INSERT INTO washtrace.wallets (chain_id, address, transfers)
       SELECT $1, a, n FROM unnest($2::text[], $3::int[]) AS u(a, n) ORDER BY a
       ON CONFLICT (chain_id, address) DO UPDATE SET transfers = washtrace.wallets.transfers + EXCLUDED.transfers, depth = 0`,
      [chainId, addresses, addresses.map((a) => counts.get(a)!)],
    );
  }
}
