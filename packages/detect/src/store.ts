import pg from 'pg';
import { ZERO } from './graph.js';
import { CUSTODIANS, contractsFor, moneyFor, traders } from './marketplaces.js';
import { MOVE_KIND, Moves } from './moves.js';
import { MIGRATIONS } from './migrations.js';
import { Payments } from './payments.js';
import { findOf, isOwnKey, NO_FILTER, type LensKey, type TradeContext, type TradeGroupBy, type TradeQuery } from './trades.js';
import { judgedColumn, lensesColumn, caughtColumns, caughtOf, COUNTED_JOIN, flagSource, judgedThrough, LIST_ORDER, PARTNERS_FROM, PARTNER_ORDER, SIDES, TRADES_FROM, SELECT_TRANSFER, FLAGS_AGG, TRANSFERS, betweenWhere, binder, groupKey, loopsOf, ownLoopsOf, toFlagged, toTrade, toTransfer, tradeSelect, tradeWhere, walletWhere, type FlaggedTransfer, type FlowDir, type ListOpts, type PartnerSort, type TokenLine, type TokenSort, type TradeGroup, type TradeRow, type WalletFilter, type WalletLine, type WalletSort } from './trade-sql.js';
import { checkRule, type EdgeKind, type FollowEstimate, type LensRule } from './lens-rule.js';
import type { Rules } from './methods.js';
import { StoredDataError, type StoredDataFault, type StoredEntry } from './stored.js';
import { type Analysis, type Flag, type Flow, type Method, type MethodTotals, type Transfer, type Witness } from './types.js';

export type { FlaggedTransfer, FlowDir, ListOpts, PartnerSort, TokenLine, TokenSort, TradeGroup, TradeRow, WalletFilter, WalletLine, WalletSort } from './trade-sql.js';

/** pg_advisory_lock's first key: this product's namespace. The second is the job. */
const LOCK_NS = 0x77617368; // "wash"
/** How often a caller that waits for a lock (the migrations) asks for it again. */
const LOCK_POLL_MS = 500;

/**
 * Every advisory-lock key `locked()` is given, in one table so a new one cannot
 * collide with another unseen. Only one replica holds a key at a time.
 */
export const LOCKS = {
  migrate: 0,
  /** The three polling jobs: only one replica runs each at a time. */
  ingest: 1,
  fund: 2,
  analyze: 3,
  /** Every replica hears a check's request, and one runs it. */
  checks: 4,
  /** One download at a time across every replica, so two never write the same part file. */
  download: 5,
  /** One trail import at a time across every replica, so two never load the same trail at once. */
  trail: 6,
} as const;

/**
 * When a failed stored-data load, download or analysis is tried again: five
 * minutes after the first failure, doubling with each one in a row, up to an
 * hour. The SQL for the column holding the failure count (the old count, so
 * the first failure waits five minutes; the power is capped so it never
 * overflows). `retryMs` below is its JS mirror; the two must agree.
 */
const backoffSql = (failures: string) => `now() + make_interval(secs => LEAST(3600, 300 * power(2, LEAST(${failures}, 4))))`;
/** The JS mirror of backoffSql, for the worker's own maps of failures: the wait after the `failures`th failure in a row. */
export function retryMs(failures: number): number {
  return Math.min(60 * 60_000, 5 * 60_000 * 2 ** (failures - 1));
}

/**
 * A lens run that failed this many times in a row is not tried again until
 * someone asks (Run here, or an edit): a run that ran the worker out of
 * memory would do it again on every try (Ruling DD).
 */
const LENS_TRIES = 3;
/** The SET of a failed lens run, its error `$3`: after LENS_TRIES no retry_at, so dueLensRun never picks it. */
const LENS_FAILED = `status = 'failed', error = $3, progress = NULL, failures = failures + 1,
  retry_at = CASE WHEN failures + 1 >= ${LENS_TRIES} THEN NULL ELSE ${backoffSql('failures')} END`;

/**
 * The most money edges a lens run holds. Task 11 measured Terraforms' 37M
 * money edges at 1,653 MB of the worker's 1.9 GB budget, inside the lens
 * thread; 40M is that with the margin it left. Past it the run fails, saying
 * so, before it can run the worker out of memory (Ruling DD). BAYC-sized
 * collections are not measured.
 */
export const MONEY_EDGE_CEILING = 40_000_000;

/**
 * A collection is not analysed again sooner than this after its last
 * analysis (see nextAnalysis), and a lens's done run is not run again for a
 * newer analysis sooner than this after it finished (see dueLensRun).
 */
export const ANALYZE_GAP_MS = 5 * 60_000;

/** Postgres's code for a row whose parent is gone. */
const FOREIGN_KEY_VIOLATION = '23503';
/** Postgres's code for a statement it ended to break a deadlock. */
const DEADLOCK_DETECTED = '40P01';
/** How long one of a trail import's statements waits for a lock before it fails: a stopped or stalled import is only seen between statements. */
const TRAIL_LOCK_TIMEOUT = '5min';
/** A batch of flags is cut at this many rows or this many characters of witness, whichever comes first. */
const FLAG_BATCH_ROWS = 10_000;
const FLAG_BATCH_CHARS = 16 * 2 ** 20;
const OWN_FLAG = 'SELECT f.lens_id, f.collection_id, f.tx_hash, f.log_index, f.path, f.wallets';
const toOwnFlag = (r: any): OwnFlag => ({ lensId: r.lens_id, collectionId: r.collection_id, txHash: r.tx_hash, logIndex: r.log_index, path: r.path, wallets: r.wallets });
/** Rows a cursor fetches at a time when stored data is cut. */
const CURSOR_PAGE = 10_000;
/** A load of stored data looks up from its work at most this often: Terraforms is a thousand batches. */
const RESTORE_CHECK_MS = 1_000;
/** Wallets a load queues per statement, in address order. */
const QUEUE_BATCH = 10_000;
/**
 * Why stored data could not be loaded, in the words the console shows. Only
 * why: what follows (the chain read instead, when the load is tried again)
 * depends on the chain's RPC, which the console knows. The full error goes to
 * the log.
 */
const RESTORE_NOTES: Readonly<Record<StoredDataFault | 'failed', string>> = {
  missing: 'Stored data could not be loaded: its file is missing.',
  mismatch: 'Stored data could not be loaded: its file does not match the manifest.',
  unreadable: 'Stored data could not be loaded: its file could not be read.',
  disk: 'Stored data could not be loaded: its file could not be read.',
  failed: 'Stored data could not be loaded.',
};
/** Thrown inside a load to stop it quietly: its collection was paused or deleted under it. */
const STOPPED = Symbol('restore stopped');

export interface CollectionRow {
  id: number;
  chainId: number;
  address: string;
  name: string | null;
  startBlock: number | null;
  cursorBlock: number | null;
  headBlock: number | null;
  addedAt: number;
  ingestedAt: number | null;
  error: string | null;
  errorAt: number | null;
  transfers: number;
  wallets: number;
  fundedWallets: number;
  /** True when something was written since the latest analysis. */
  stale: boolean;
  latest: AnalysisRow | null;
  /** When the worker last gave this collection a turn. Null until it has. */
  servedAt: number | null;
  /** Blocks a second the worker read here, smoothed. Null until it has read any. */
  readRate: number | null;
  /** Someone asked for this collection to be served first. */
  priority: boolean;
  /** When it was paused: the worker leaves it alone, its data kept. Null while it is watched. */
  pausedAt: number | null;
  /** How far a load of stored data has got, 0 to 1, while one runs. Null otherwise. */
  restoreProgress: number | null;
  /** Why stored data could not be loaded. Meanwhile the collection is read from the chain, if it has an RPC, and analysed on what it has. */
  restoreNote: string | null;
  /** What a load the data failed was about (storedKey). It is tried again once that changes. Null for any other failure. */
  restoreNoteKey: string | null;
  /** When a load the store failed is tried again, in ms. Null when none is waiting. */
  restoreRetryAt: number | null;
  /** Why its last analysis failed, kept until one is saved: meanwhile `latest` is the last that was. Null when none failed since. */
  analysisError: string | null;
  /** When an analysis that failed is tried again, in ms. Null when none failed. */
  analysisRetryAt: number | null;
  /** When the stored data it loaded stops, in ms. Null when none was loaded. */
  storedThroughTime: number | null;
  /** The block the stored data it loaded stops at. Null when none was loaded. */
  storedThroughBlock: number | null;
  /** The sha256 of the money trail loaded from stored data for it. Null when none was. */
  trailImportedSha: string | null;
  /** Why a money trail on disk was not loaded. It is not tried again until the file changes. */
  trailNote: string | null;
  /** How far an import of its money trail has got, 0 to 0.99, while one runs. Null otherwise. */
  trailProgress: number | null;
  /** Which of its stored files is downloading, while one is. Null otherwise. */
  downloadFile: 'transfers' | 'trail' | null;
  /** How far that download has got, 0 to 1. Null when none runs. */
  downloadProgress: number | null;
  /** Why its stored data could not be downloaded (DOWNLOAD_NOTES). Meanwhile its chain is read, if it has an RPC. */
  downloadNote: string | null;
  /** When a failed download is tried again, in ms. Null when none is waiting. */
  downloadRetryAt: number | null;
  /** The URL of the last download whose bytes did not match the manifest: not downloaded again while the Hub serves that URL. Null when none. */
  downloadMismatch: string | null;
  /** This collection's overrides of RULES. Keys absent here follow the defaults. */
  rules: Partial<Rules>;
  /** What the contract says of itself. Null until the worker has read it. */
  contract: { name: string | null; symbol: string | null; creator: string | null; creationTx: string | null } | null;
}

/** A collection as its transfers so far describe it: what exists, who holds it, and when and where it traded. */
export interface CollectionProfile {
  /** Tokens minted and not burned. */
  supply: number;
  /** Wallets holding at least one of them. */
  holders: number;
  firstMint: number | null;
  firstSale: number | null;
  lastSale: number | null;
  /** Sales per marketplace, busiest first. */
  marketplaces: { name: string; sales: number }[];
}

/** A change to a collection's settings. An absent key is left alone; a null rule goes back to its default. */
export interface Configure {
  name?: string | null;
  /** Serve this collection first. Changes no flag, so it queues no analysis. */
  priority?: boolean;
  rules?: { [K in keyof Rules]?: number | null };
}

/** Counts for each pair of lenses, row then column. */
export type CompareCounts = Partial<Record<LensKey, Partial<Record<LensKey, number>>>>;

export type Bucket = 'hour' | 'day' | 'week' | 'month';

/** One bucket of a collection's history. `at` is the bucket's start, in ms. */
export interface TimelinePoint {
  at: number;
  transfers: number;
  sales: number;
  /** Sales each method flags. A method that did not run flags none, so read it with the analysis's `available`. */
  flaggedSales: Record<Method, number> & Partial<Record<`L${number}`, number>>;
  /** Present only when lenses of yours were asked for: the sales each has judged here (its run read through their block), the denominator of its share. */
  judgedSales?: Partial<Record<`L${number}`, number>>;
}

export interface AnalysisRow {
  /** Which analysis: a lens run's `analysisId` names the one it read, so a run behind the latest can say so (Ruling FF). */
  id: number;
  ranAt: number;
  tookMs: number;
  throughBlock: number | null;
  totals: Record<Method, MethodTotals>;
  missingData: number;
  fundedWallets: number;
  wallets: number;
  truncatedSearches: number;
  /**
   * Distinct loops and pairs each lens found. Null for an analysis saved
   * before they were counted. A lens that did not run carries zero, as its
   * totals do, though its flags hold Round trips' copy. `pairs` counts pair
   * witnesses, one per hop, so two sales through the same middle count twice;
   * it is not a count of distinct wallet pairs.
   */
  loops: Record<Method, { loops: number; pairs: number }> | null;
}

/** The wallets one collection (or, with a null id, the followed wallets) wants checked, best first. */
export interface FundingLane {
  collectionId: number | null;
  wallets: string[];
}

/**
 * Following money out of a wallet, for SCC AU. Funding is otherwise read only
 * for wallets that traded a collection, as the paper's dataset 3 was, so a
 * payment routed back through two outside wallets was never seen.
 */
export interface Follow {
  /** How many hops out from a trader to read. */
  hops: number;
  /** A wallet that paid more than this many wallets is a business or a bot; it is not followed. */
  fanout: number;
  /** Contracts never followed into: marketplaces, wrapped native tokens, the zero address. */
  exclude: readonly string[];
}

/**
 * A wallet that sent money to more wallets than this is not followed. Mule
 * wallets in a wash ring pay a handful; a wallet paying dozens is a business,
 * a bot or a person with a life, and following it reads half the chain.
 */
export const FOLLOW_FANOUT = 25;

/**
 * How money is followed on `chainId`, `hops` out: what the fund job hands
 * `fund`, and what walkOut walks the stored flows by, so a collection's
 * count of wallets further out is of the ones `fund` would queue.
 */
export function followOf(chainId: number, hops: number): Follow {
  return { hops, fanout: FOLLOW_FANOUT, exclude: [...contractsFor(chainId), ZERO] };
}

/**
 * How far a collection's money is read (Data this lens needs). `traders`:
 * its traders checked (done, a truncated one too, as it is never read
 * again), of those queued. `limit` is the hops it is followed out to, the
 * larger of follow.hops and its own `ownLimit` (null: none of its own).
 *
 * `pendingByDepth`: its reach wallets past follow.hops not yet read, by their
 * depth out from its traders (nearer ones are the followed lane's).
 *
 * `estimate`: what reading one hop past `limit` would read, as last counted;
 * null until it is counted for that hop, so raising either limit makes it
 * null until the worker counts again.
 *
 * `seeding`: its own limit is past follow.hops, and the walk of its stored
 * money (seedReach) is not done: it has not once found nothing more to step
 * since that limit was set, or a reach wallet short of the limit is checked
 * and not yet stepped from. Then `pendingByDepth` does not hold every wallet
 * it is still to read: money is not read as far as its limit.
 */
export interface MoneyRead {
  traders: { checked: number; of: number };
  limit: number;
  ownLimit: number | null;
  pendingByDepth: Record<number, number>;
  estimate: FollowEstimate | null;
  seeding: boolean;
}

/**
 * The most wallets a count of the next hop (Store.countNext) walks out from,
 * in all. A walk costs about 45 µs a wallet warm, and a few random reads
 * each cold. Uncut, a synthetic one of 30k traders reaching some 300k
 * wallets over 9.3M flows took 15 s warm, and would take minutes cold:
 * too long for a fund pass of 45 s.
 */
export const WALK_CAP = 50_000;

/**
 * The longest a count of the next hop (Store.countNext) runs before it is
 * stopped. Capped, one over 30k traders and some 300k wallets reached took
 * 10 to 17 s cold and 2 s warm; it runs in the fund pass's last 15 s, and one
 * stopped cold leaves the pages it read warm for the next pass's.
 */
export const COUNT_TIMEOUT_MS = 15_000;

export interface PassRow {
  job: string;
  startedAt: number;
  finishedAt: number | null;
  tookMs: number | null;
  outcome: string | null;
  detail: string | null;
  /** When the pass last proved it was alive. Null until its first heartbeat. */
  heartbeatAt: number | null;
  /** What it is doing right now, in words. Null between turns. */
  doing: string | null;
  /** The collection it is on, or null. */
  subjectId: number | null;
}

/**
 * The settings that hold a secret: an RPC URL carries its provider's key.
 * Their values are kept in `settings`, which the worker needs, but only
 * masked in `setting_sources`, which the API reads, and in anything the API
 * returns.
 */
export const SECRET_KEYS = (key: string): boolean => key.startsWith('rpc.') || key === 'etherscan.key';

/**
 * Where the worker found one setting. `value` is the value used and `env` what
 * .env holds (null when it does not set it), each as the console may show it:
 * a secret masked, `etherscan.url` with its credentials masked, else raw.
 */
export interface SettingSource {
  source: 'env' | 'console';
  value: string | null;
  env: string | null;
}

/** A Test the console asked the worker to run. */
export type CheckKind = 'rpc' | 'etherscan';

/** The channel `requestCheck` notifies, so a listening worker runs the check at once rather than next pass. */
export const CHECKS_CHANNEL = 'washtrace_checks';

/** What was typed into a search, read: the console's `parseSearch` makes it, and `Store.search` answers it. */
export type Parsed =
  | { kind: 'tx'; tx: string }
  | { kind: 'address'; address: string }
  | { kind: 'prefix'; prefix: string }
  | { kind: 'token'; tokenId: string; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

export type SearchKind = 'collections' | 'tokens' | 'wallets' | 'trades';

export interface SearchHits {
  collections: { chainId: number; address: string; name: string | null; symbol: string | null }[];
  tokens: { chainId: number; address: string; name: string | null; tokenId: string; transfers: number }[];
  wallets: { chainId: number; address: string; transfers: number }[];
  trades: { chainId: number; txHash: string; address: string; name: string | null; tokenId: string }[];
  /** That kind had a row past `limit`: it is cut, and says so. */
  more: Record<SearchKind, boolean>;
}

/** A collection waiting for analysis, as `Store.stale` reads it. */
export type StaleRow = Awaited<ReturnType<Store['stale']>>[number];

/** The built-in lenses' names, which no lens of yours may take (the web's LENSES holds the same three for display). */
export const BUILT_IN_NAMES = ['Round trips', 'Money loops back', 'Linked wallets'];

export interface Lens { id: number; key: `L${number}`; name: string; rule: LensRule; version: number; createdAt: number; updatedAt: number }
export type LensRunStatus = 'queued' | 'running' | 'done' | 'failed';
export interface LensTotals extends MethodTotals { truncated: number; untimed: number }
export interface LensRun {
  lensId: number; collectionId: number; status: LensRunStatus; progress: number | null; lensVersion: number;
  analysisId: number | null; throughBlock: number | null; totals: LensTotals | null; error: string | null;
  retryAt: number | null; finishedAt: number | null; tookMs: number | null;
}
export interface LoopEdge { from: string; to: string; kind: EdgeKind | 'funds'; tx: string | null; time: number | null; amountWei: string | null; tokenId: string | null }
export interface LensFlag { txHash: string; logIndex: number; path: LoopEdge[]; wallets: string[] }
/** A stored flag of a lens of yours, with the lens and the collection it belongs to. */
export type OwnFlag = LensFlag & { lensId: number; collectionId: number };

/** The channel `requestPreview` notifies, so a listening worker starts the preview at once rather than next lens pass (P5). */
export const PREVIEWS_CHANNEL = 'washtrace_previews';
/** How many sales a preview judges (P4): the spec's "2,000 random sales". */
export const PREVIEW_SAMPLE = 2_000;
/** A preview is kept this long from when it was asked for, then swept: the editor that asked has long stopped polling. */
export const PREVIEW_KEEP_MS = 60 * 60_000;

/**
 * What a preview found. `sampled` is the drawn sample (all the sales when
 * the collection has `ofSales` under PREVIEW_SAMPLE); `judged` the part of
 * it the lens judged, and the lens caught `caught` of those. `hops` is the
 * sampled sales with a hop, which Round trips judges all of (it has no
 * window), so `roundTrips.caught` is of these; `roundTrips` is null when it
 * did not run on the latest analysis. `atLeast` when a search was cut short:
 * an untimed sale is out of `judged`, so it is no floor here, unlike a run's
 * share (`untimed` still counts them). `topMarket` is the VENUES name of the
 * market most of the caught were sold on, null with none caught.
 */
export interface PreviewResult {
  sampled: number; judged: number; hops: number; ofSales: number; caught: number; atLeast: boolean;
  roundTrips: { caught: number } | null;
  topMarket: { name: string; caught: number } | null;
  truncated: number; untimed: number; tookMs: number;
}
/** A preview as the editor polls it: `result` once done, `error` (scrubbed) once failed. */
export interface Preview {
  id: number; collectionId: number; rule: LensRule; status: LensRunStatus; progress: number | null;
  result: PreviewResult | null; error: string | null; requestedAt: number; finishedAt: number | null;
}

/** What a lens run reads: the transfers, and the money edges its rule may follow, held as numbers. */
export interface LensInput {
  transfers: Transfer[]; through: number | null; moves: Moves;
  contracts: ReadonlySet<string>; custodians: ReadonlySet<string>; money: ReadonlySet<string>;
  /** Wallets with more history than the funding source would page through, as analysisInput reads them: never a middle of a money lens. Empty with no money row. */
  truncated: ReadonlySet<string>;
  /** The collection's transfer transaction hashes, each once: the engine tells a hop's transaction by its index here. */
  tradeTxs: string[];
}

/**
 * Every read and write of the `washtrace` schema. A class because every one
 * of them needs the pool, and nothing else.
 */
export class Store {
  constructor(readonly pool: pg.Pool) {}

  /** How many payments `analysisInput` fetches at a time. A field so a test can make it small. */
  paymentBatch = 20_000;

  /**
   * How many money edges `moveTxs` asks about in one query. Each is one
   * index probe, so a query's time grows with it; at 1,000 a cold batch is a
   * few seconds of random reads at most, and the round trip is nothing
   * beside it. A field so a test can make it small.
   */
  moveTxBatch = 1_000;

  /** MONEY_EDGE_CEILING; a field so a test can make it small. */
  moneyEdgeCeiling = MONEY_EDGE_CEILING;

  /** WALK_CAP; a field so a test can make it small. */
  walkCap = WALK_CAP;

  /** COUNT_TIMEOUT_MS; a field so a test can make it small. */
  countTimeoutMs = COUNT_TIMEOUT_MS;

  static connect(url: string): Store {
    // Keep-alive probes find a connection that died without a word (a NAT's idle timeout, a host gone), so a
    // query on it errors instead of waiting forever. Probed after 30 seconds idle, not the OS's two hours.
    const pool = new pg.Pool({ connectionString: url, max: 10, application_name: 'washtrace', keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
    // An idle client's dropped connection is reported here; unheard, it ends the process.
    pool.on('error', (err) => console.error('[washtrace] store connection lost: %s', err.message));
    return new Store(pool);
  }

  /**
   * Applies every migration the store lacks, under a lock so replicas starting
   * together migrate once. A string migration commits with its version; an
   * `Outside` one runs statement by statement, then records its version.
   */
  async migrate(): Promise<number> {
    return this.locked(LOCKS.migrate, true, async (c) => {
      await c.query('CREATE SCHEMA IF NOT EXISTS washtrace');
      await c.query('CREATE TABLE IF NOT EXISTS washtrace.schema_version (version int NOT NULL, singleton bool NOT NULL DEFAULT true UNIQUE CHECK (singleton))');
      const { rows } = await c.query<{ version: number }>('SELECT version FROM washtrace.schema_version');
      const at = rows[0]?.version ?? 0;
      const record = (version: number) => c.query(
        'INSERT INTO washtrace.schema_version (version) VALUES ($1) ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version',
        [version],
      );
      for (let v = at; v < MIGRATIONS.length; v++) {
        const m = MIGRATIONS[v]!;
        if (typeof m !== 'string') {
          for (const statement of m.outside) await c.query(statement);
          await record(v + 1);
          continue;
        }
        await c.query('BEGIN');
        try {
          await c.query(m);
          await record(v + 1);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK');
          throw err;
        }
      }
      return MIGRATIONS.length;
    }) as Promise<number>;
  }

  /** The schema version the store is at (0 when it has none), without changing anything: for a caller that must refuse a store it did not migrate. */
  async schemaVersion(): Promise<number> {
    // Two queries: a SELECT naming a missing table fails to plan, even behind a CASE.
    const { rows: found } = await this.pool.query<{ there: boolean }>(`SELECT to_regclass('washtrace.schema_version') IS NOT NULL AS there`);
    if (!found[0]?.there) return 0;
    const { rows } = await this.pool.query<{ version: number }>('SELECT version FROM washtrace.schema_version');
    return rows[0]?.version ?? 0;
  }

  /**
   * Run `fn` holding job `job`'s advisory lock, or return `skipped` at once
   * when another replica holds it. This is what lets the same image run as
   * many API replicas while each worker pass runs in exactly one of them.
   * With `wait`, it is asked for again every LOCK_POLL_MS until it is got,
   * never waited on in one statement: a session blocked in pg_advisory_lock
   * holds a snapshot, and CREATE INDEX CONCURRENTLY (migration #28) waits for
   * every older snapshot to go, so the waiter and the build would deadlock.
   */
  async locked<T>(job: number, wait: boolean, fn: (c: pg.PoolClient) => Promise<T>): Promise<T | 'skipped'> {
    const c = await this.pool.connect();
    try {
      const got = async () => (await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_NS, job])).rows[0]!.ok;
      if (wait) {
        while (!(await got())) await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
      } else if (!(await got())) {
        return 'skipped';
      }
      try {
        return await fn(c);
      } finally {
        await c.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NS, job]).catch(() => {});
      }
    } finally {
      c.release();
    }
  }

  // ---- collections ---------------------------------------------------------

  async addCollection(chainId: number, address: string, name: string | null, startBlock: number | null): Promise<{ id: number; created: boolean }> {
    const { rows } = await this.pool.query<{ id: number; created: boolean }>(
      `INSERT INTO washtrace.collections (chain_id, address, name, start_block, cursor_block)
       VALUES ($1, $2, $3, $4::bigint, $4::bigint - 1)
       ON CONFLICT (chain_id, address) DO UPDATE SET name = COALESCE(EXCLUDED.name, washtrace.collections.name), paused_at = NULL
       RETURNING id, (xmax = 0) AS created`,
      [chainId, address, name, startBlock],
    );
    return rows[0]!;
  }

  /**
   * Delete a collection and, by cascade, its data, but only while it is paused:
   * the condition is in the SQL, so a resume racing the caller's own check can
   * never lead to a live collection being wiped. False when it is not there or
   * not paused; look it up to tell which.
   */
  async removeCollection(chainId: number, address: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM washtrace.collections WHERE chain_id = $1 AND address = $2 AND paused_at IS NOT NULL', [chainId, address]);
    return (rowCount ?? 0) > 0;
  }

  /** Stop the worker serving a collection, keeping its data. False when it is not there or already paused. */
  async pause(chainId: number, address: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE washtrace.collections SET paused_at = now() WHERE chain_id = $1 AND address = $2 AND paused_at IS NULL', [chainId, address]);
    return (rowCount ?? 0) > 0;
  }

  /** Let the worker serve a paused collection again. False when it is not there or not paused. */
  async resume(chainId: number, address: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE washtrace.collections SET paused_at = NULL WHERE chain_id = $1 AND address = $2 AND paused_at IS NOT NULL', [chainId, address]);
    return (rowCount ?? 0) > 0;
  }

  async collections(): Promise<CollectionRow[]> {
    const { rows } = await this.pool.query(`${COLLECTION_SELECT} ORDER BY c.added_at`);
    return rows.map(toCollection);
  }

  async collection(chainId: number, address: string): Promise<CollectionRow | null> {
    const { rows } = await this.pool.query(`${COLLECTION_SELECT} WHERE c.chain_id = $1 AND c.address = $2`, [chainId, address]);
    return rows[0] ? toCollection(rows[0]) : null;
  }

  /**
   * Apply `change` in one statement, so two edits at once both land. `||`
   * merges the rules and `jsonb_strip_nulls` drops the ones set to null. The
   * version moves only when the rules did: a rename or a priority changes no flag.
   * A rule change also ends the wait of an analysis that failed, which it may
   * fix: tried on the next pass, the failure still said until a run succeeds.
   */
  async configure(chainId: number, address: string, change: Configure): Promise<CollectionRow | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE washtrace.collections
       SET name = CASE WHEN $3 THEN $4 ELSE name END,
           priority = CASE WHEN $6::boolean IS NULL THEN priority ELSE $6 END,
           rules = jsonb_strip_nulls(rules || $5::jsonb),
           version = version + CASE WHEN jsonb_strip_nulls(rules || $5::jsonb) = rules THEN 0 ELSE 1 END,
           rules_at = CASE WHEN jsonb_strip_nulls(rules || $5::jsonb) = rules THEN rules_at ELSE now() END,
           analysis_retry_at = CASE WHEN jsonb_strip_nulls(rules || $5::jsonb) = rules THEN analysis_retry_at ELSE NULL END
       WHERE chain_id = $1 AND address = $2`,
      [chainId, address, change.name !== undefined, change.name ?? null, JSON.stringify(change.rules ?? {}), change.priority ?? null],
    );
    return rowCount === 0 ? null : this.collection(chainId, address);
  }

  /**
   * The worker gave this collection a turn that read `blocks` in `ms`. The
   * rate is smoothed (0.3 new, 0.7 old) so one slow turn does not resize the
   * next; the first reading stands alone. A turn with no usable duration or
   * a count of zero or less only marks the collection served.
   */
  async served(id: number, blocks: number, ms: number): Promise<void> {
    if (ms <= 0 || blocks <= 0) {
      await this.pool.query('UPDATE washtrace.collections SET served_at = now() WHERE id = $1', [id]);
      return;
    }
    const rate = blocks / (ms / 1000);
    await this.pool.query(
      'UPDATE washtrace.collections SET served_at = now(), read_rate = 0.3 * $2::float8 + 0.7 * coalesce(read_rate, $2::float8) WHERE id = $1',
      [id, rate],
    );
  }

  async setStart(id: number, block: number): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET start_block = $2::bigint, cursor_block = $2::bigint - 1 WHERE id = $1 AND start_block IS NULL', [id, block]);
  }

  /**
   * Keep what the contract says of itself. Read once: a contract's name,
   * symbol and deployer do not change. A collection watched without a name
   * takes the contract's; one given later replaces it.
   */
  async describe(id: number, facts: { name: string | null; symbol: string | null; creator: string | null; creationTx: string | null }): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.collections SET name = coalesce(name, $2), contract_name = $2, symbol = $3, creator = $4, creation_tx = $5, described_at = now()
       WHERE id = $1`,
      [id, facts.name, facts.symbol, facts.creator, facts.creationTx],
    );
  }

  /** The collection as its transfers so far describe it. A token's holder is the receiver of its latest transfer. */
  async profile(id: number): Promise<CollectionProfile> {
    const [{ rows: [r] }, { rows: markets }] = await Promise.all([
      this.pool.query(`
        WITH latest AS (
          SELECT DISTINCT ON (token_id) to_address FROM washtrace.transfers
          WHERE collection_id = $1 ORDER BY token_id, block_number DESC, log_index DESC
        )
        SELECT (SELECT count(*)::int FROM latest WHERE to_address <> $2) AS supply,
               (SELECT count(DISTINCT to_address)::int FROM latest WHERE to_address <> $2) AS holders,
               extract(epoch FROM min(block_time) FILTER (WHERE from_address = $2))::float8 AS first_mint,
               extract(epoch FROM min(block_time) FILTER (WHERE marketplace IS NOT NULL))::float8 AS first_sale,
               extract(epoch FROM max(block_time) FILTER (WHERE marketplace IS NOT NULL))::float8 AS last_sale
        FROM washtrace.transfers WHERE collection_id = $1`, [id, ZERO]),
      this.pool.query(`
        SELECT marketplace AS name, count(*)::int AS sales FROM washtrace.transfers
        WHERE collection_id = $1 AND marketplace IS NOT NULL GROUP BY marketplace ORDER BY sales DESC, marketplace`, [id]),
    ]);
    const ms = (v: number | null) => (v === null ? null : v * 1000);
    return { supply: r.supply, holders: r.holders, firstMint: ms(r.first_mint), firstSale: ms(r.first_sale), lastSale: ms(r.last_sale), marketplaces: markets };
  }

  async setHead(id: number, head: number): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET head_block = $2 WHERE id = $1', [id, head]);
  }

  async setError(id: number, message: string | null): Promise<void> {
    await this.pool.query(
      'UPDATE washtrace.collections SET error = $2, error_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1',
      [id, message],
    );
  }

  /**
   * Store one span's transfers and move the cursor past it, together: a crash
   * between the two would otherwise skip the span or read it twice. Wallets
   * enter the funding queue here, weighted by how often they traded.
   */
  async ingest(id: number, chainId: number, transfers: readonly Transfer[], through: number, queue: readonly string[]): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await insertTransfers(c, id, transfers);
      await queueWallets(c, chainId, tally(queue));
      await c.query(
        `UPDATE washtrace.collections SET cursor_block = $2, ingested_at = now(), error = NULL, error_at = NULL,
           version = version + CASE WHEN $3 THEN 1 ELSE 0 END WHERE id = $1`,
        [id, through, transfers.length > 0],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * Load a collection's stored data: every transfer in `batches`, then its
   * wallets queued and the cursor moved to where the data stops, all in one
   * transaction, so nothing (analysis included) ever sees half a load. A
   * transfer already read is kept, and only the ones new here count toward
   * their wallets, as ingest counts them. One batch is held at a time: a big
   * collection is millions of rows.
   *
   * Wallets are queued once, at the end, in address order: queued per batch,
   * their rows stayed locked for the whole load, and funding, which writes
   * them, waited minutes or deadlocked with it. Their counts are tallied
   * meanwhile: far fewer traders than transfers.
   *
   * About once a second, from a connection of its own (the transaction's
   * writes are invisible until it commits), the load writes its progress and
   * looks whether its collection was paused or deleted. Either stops it
   * quietly, as saveAnalysis drops an analysis whose collection went: so a
   * Delete, allowed only once paused, waits at most that second, not the
   * whole load. Neither look ever waits on a lock.
   *
   * On failure nothing is kept and the progress is cleared, and a note says
   * so. Bad stored data (a StoredDataError) is noted with `key`, what the
   * load was about (storedKey), and is not tried again until that changes.
   * Any other error (a full disk, a lost connection) waits as a failed
   * analysis does: five minutes, doubling with each failure in a row, up to
   * an hour. Either way it is thrown on. A load that goes through clears all
   * of it.
   */
  async restore(id: number, chainId: number, entry: StoredEntry, batches: AsyncIterable<Transfer[]>, key: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      // Shown at once: the whole file is checked against its sha256 before the first batch.
      await this.pool.query('UPDATE washtrace.collections SET restore_progress = 0 WHERE id = $1', [id]);
      let checked = Date.now();
      let loaded = 0;
      const counts = new Map<string, number>();
      await c.query('BEGIN');
      for await (const batch of batches) {
        if (Date.now() - checked >= RESTORE_CHECK_MS) {
          if (!(await this.restoreGoesOn(id, Math.min(1, loaded / Math.max(1, entry.transfers.rows))))) throw STOPPED;
          checked = Date.now();
        }
        const added = await insertTransfers(c, id, batch).catch((err) => { throw asDataFault(err); });
        for (const a of traders(chainId, added)) counts.set(a, (counts.get(a) ?? 0) + 1);
        loaded += batch.length;
      }
      // Once more before the wallets and the cursor are written: a pause in the last second still stops it.
      if (!(await this.restoreGoesOn(id, null))) throw STOPPED;
      await queueWallets(c, chainId, counts);
      // LEAST and GREATEST skip a null, so a collection with no start yet takes the stored one.
      await c.query(
        `UPDATE washtrace.collections SET start_block = LEAST(start_block, $2::bigint), cursor_block = GREATEST(cursor_block, $3::bigint),
           stored_through_time = to_timestamp($4::float8 / 1000), stored_through_block = $3::bigint, restore_progress = NULL,
           restore_note = NULL, restore_note_key = NULL, restore_failures = 0, restore_retry_at = NULL, version = version + 1
         WHERE id = $1`,
        [id, entry.startBlock, entry.throughBlock, entry.throughTime],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      // After the rollback, so a Delete waiting on the load has gone through and this finds nothing to wait on.
      // A load stopped by a pause or a Delete is no failure: only its progress goes.
      const stopped = err === STOPPED || (err as { code?: string }).code === FOREIGN_KEY_VIOLATION;
      const write = stopped
        ? this.pool.query('UPDATE washtrace.collections SET restore_progress = NULL WHERE id = $1', [id])
        : err instanceof StoredDataError
          ? this.pool.query(
            `UPDATE washtrace.collections SET restore_progress = NULL, restore_note = $2, restore_note_key = $3, restore_failures = 0, restore_retry_at = NULL
             WHERE id = $1`,
            [id, RESTORE_NOTES[err.kind], key],
          )
          // The old count on the right: the first failure waits five minutes.
          : this.pool.query(
            `UPDATE washtrace.collections SET restore_progress = NULL, restore_note = $2, restore_note_key = NULL, restore_failures = restore_failures + 1,
               restore_retry_at = ${backoffSql('restore_failures')}
             WHERE id = $1`,
            [id, RESTORE_NOTES.failed],
          );
      await write.catch(() => {});
      if (stopped) return;
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * Whether a load may go on: its collection is still there and not paused.
   * Writes `progress` too, unless null. A plain read never waits, and the
   * write skips a row it would have to wait for (a Delete queued on the
   * load), so the load is never stuck behind something waiting on it.
   */
  private async restoreGoesOn(id: number, progress: number | null): Promise<boolean> {
    const { rows } = await this.pool.query<{ paused: boolean }>('SELECT paused_at IS NOT NULL AS paused FROM washtrace.collections WHERE id = $1', [id]);
    if (rows.length === 0 || rows[0]!.paused) return false;
    if (progress !== null) {
      await this.pool.query(
        `UPDATE washtrace.collections SET restore_progress = $2
         WHERE id = (SELECT id FROM washtrace.collections WHERE id = $1 FOR NO KEY UPDATE SKIP LOCKED)`,
        [id, progress],
      );
    }
    return true;
  }

  /**
   * Forget why a collection's stored data was not loaded, and any wait: the
   * worker found the stored data no longer applies (gone from the manifest,
   * or read past), so nothing about it is true any more.
   */
  async clearRestoreNote(id: number): Promise<void> {
    await this.pool.query(
      'UPDATE washtrace.collections SET restore_note = NULL, restore_note_key = NULL, restore_failures = 0, restore_retry_at = NULL WHERE id = $1',
      [id],
    );
  }

  /**
   * Forget every load's progress. For a worker starting: a load that was
   * running when the last one died rolled back, but its progress, written
   * outside the load, would otherwise say "Loading stored data" for ever.
   */
  async clearRestoreProgress(): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET restore_progress = NULL WHERE restore_progress IS NOT NULL');
  }

  /**
   * Say which of a collection's stored files is downloading and how far, or
   * with null that none is. A file with no progress (null) is one waiting its
   * turn: held for a download that has not started. Returns whether the collection is still watched:
   * false when it was paused or deleted, and the download stops. Progress is
   * not written for a paused one; clearing always is.
   */
  async setDownload(id: number, file: 'transfers' | 'trail' | null, share: number | null): Promise<boolean> {
    const { rows } = await this.pool.query<{ live: boolean }>(
      `UPDATE washtrace.collections SET download_file = $2, download_progress = $3
       WHERE id = $1 AND ($2::text IS NULL OR paused_at IS NULL)
       RETURNING paused_at IS NULL AS live`,
      [id, file, share],
    );
    return rows[0]?.live ?? false;
  }

  /**
   * A download failed: say why, and wait as a failed load does (see
   * restore), five minutes doubling with each failure in a row, up to an
   * hour. Meanwhile its chain is read, if it has an RPC. `mismatch` is the
   * URL of one whose bytes did not match: kept, by every failure or download
   * after, until another such URL replaces it.
   */
  async downloadFailed(id: number, note: string, mismatch: string | null = null): Promise<void> {
    // The old count on the right: the first failure waits five minutes.
    await this.pool.query(
      `UPDATE washtrace.collections SET download_file = NULL, download_progress = NULL, download_note = $2, download_failures = download_failures + 1,
         download_retry_at = ${backoffSql('download_failures')},
         download_mismatch = COALESCE($3, download_mismatch)
       WHERE id = $1`,
      [id, note, mismatch],
    );
  }

  /**
   * Forget a download's failure note, which no longer says anything true: the
   * download was retried, or is no longer wanted. With `backoff` its failure
   * count and wait go too (it is not wanted, so nothing is waiting); without,
   * the next failure still waits as long as the one before it did.
   */
  async clearDownloadNote(id: number, backoff: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.collections SET download_note = NULL${backoff ? ', download_failures = 0, download_retry_at = NULL' : ''}
       WHERE id = $1 AND (download_note IS NOT NULL${backoff ? ' OR download_retry_at IS NOT NULL' : ''})`,
      [id],
    );
  }

  /** A download went through: nothing about downloading is true any more. */
  async downloadDone(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.collections SET download_file = NULL, download_progress = NULL, download_note = NULL, download_failures = 0, download_retry_at = NULL
       WHERE id = $1`,
      [id],
    );
  }

  /**
   * Forget every download's file and progress. For a worker starting: a
   * download running when the last one died says "Downloading" for ever
   * otherwise. Its note and back-off are kept: they are still true.
   */
  async clearDownloads(): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET download_file = NULL, download_progress = NULL WHERE download_file IS NOT NULL OR download_progress IS NOT NULL');
  }

  /**
   * Load a money trail another store cut (see trail): its flows, then its
   * checked wallets, then the mark that this collection has it. `open` reads
   * the trail from its start, checked addresses first, as readTrail does; it
   * is read twice.
   *
   * Every flow goes in before any wallet is marked done. A done wallet is
   * never read again, so one marked done before its flows were in, with the
   * load cut off between the two, would be a gap for good. Flows alone claim
   * nothing, so each batch commits on its own.
   *
   * Then the wallets, one short statement a batch, in address order as
   * queueWallets writes them: held for a whole load, their rows kept funding
   * waiting and deadlocked with it, as a load of stored data once did. The
   * trail says only that an address was checked to the end, so it comes in
   * done, not truncated, with no time it was read and no transfer counted
   * (this store counts its own as it reads them). Its depth is 0 if it
   * trades in this collection's transfers, else 1: a done wallet is only ever
   * read as depth 0 against depth above 0, so how far out a followed wallet
   * was needs no working out. A wallet this store already checked keeps its
   * own check; one still to check here takes the trail's. Either way it takes
   * the nearer of the two depths. Only the checked addresses come in: a wallet
   * that is merely an end of a flow does not, and is queued when something
   * follows it.
   *
   * Only then is the trail's sha recorded, its progress cleared and every
   * collection on the chain queued for analysis, in one statement. A load
   * cut off anywhere is safe to run again from the start, and ends as one
   * clean run does. It need not start there: each batch of flows commits with
   * the count of the trail's flows in so far (trail_resume), so a run of the
   * same trail skips those, still counting them for `onFlows`, and the last
   * statement deletes the count. Returns how many wallets and flows the trail held.
   *
   * It runs for an hour on a big trail, in the background (see
   * StoredSync.startTrailImport), so `onFlows` hears the running count of flows
   * as each batch commits, and `signal` stops it before the next batch of
   * either pass, throwing its reason. Every statement is idempotent, so one
   * Postgres ends to break a deadlock (funding writes the same wallets and
   * collections) is run again in place, not the whole import. One that waits
   * on a lock for longer than trailLockTimeout fails instead (55P03), and is
   * not run again: the import fails, and is tried again later.
   */
  async importTrail(
    id: number, chainId: number, sha256: string, open: () => AsyncIterable<{ checked: string[]; flows: Flow[] }>,
    opts: { onFlows?: (flows: number) => void; signal?: AbortSignal } = {},
  ): Promise<{ wallets: number; flows: number }> {
    // Flows an earlier import of this same trail committed: skipped, not written again.
    // On a connection of its own, as each of the import's statements is.
    const { rows: resumed } = await this.trailStatement((c) => c.query<{ flows: string }>('SELECT flows FROM washtrace.trail_resume WHERE collection_id = $1 AND sha = $2', [id, sha256]));
    const done = Number(resumed[0]?.flows ?? 0);
    let flows = 0;
    for await (const batch of open()) {
      opts.signal?.throwIfAborted();
      const fresh = batch.flows.slice(Math.max(0, done - flows));
      flows += batch.flows.length;
      // Still said, so the progress moves through what is skipped: those flows are in.
      if (flows <= done && done > 0) {
        opts.onFlows?.(flows);
        continue;
      }
      // The count goes in with the flows it counts, so it never says more than committed.
      await deadlockRetried(() => this.trailStatement(async (c) => {
        await insertFlows(c, chainId, fresh);
        await c.query(
          `INSERT INTO washtrace.trail_resume (collection_id, sha, flows) VALUES ($1, $2, $3)
           ON CONFLICT (collection_id) DO UPDATE SET sha = EXCLUDED.sha, flows = EXCLUDED.flows`,
          [id, sha256, flows],
        );
      })).catch((err) => { throw asDataFault(err); });
      opts.onFlows?.(flows);
    }
    let wallets = 0;
    for await (const batch of open()) {
      // The checked addresses come first; past them are only flows, all in already.
      if (batch.checked.length === 0) break;
      opts.signal?.throwIfAborted();
      const addresses = [...batch.checked].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      // Funding locks a wallet and then collections, so this can still deadlock with it, rarely: Postgres ends one, and it is retried.
      await deadlockRetried(() => this.trailStatement((c) => c.query(
        `INSERT INTO washtrace.wallets (chain_id, address, transfers, status, truncated, fetched_at, depth)
         SELECT $1, a, 0, 'done', false, NULL,
                CASE WHEN EXISTS (SELECT 1 FROM washtrace.transfers t WHERE t.collection_id = $3 AND (t.from_address = a OR t.to_address = a)) THEN 0 ELSE 1 END
         FROM unnest($2::text[]) AS u(a)
         ORDER BY a
         ON CONFLICT (chain_id, address) DO UPDATE SET
           status = CASE WHEN washtrace.wallets.status <> 'done' THEN 'done' ELSE washtrace.wallets.status END,
           truncated = CASE WHEN washtrace.wallets.status <> 'done' THEN false ELSE washtrace.wallets.truncated END,
           fetched_at = CASE WHEN washtrace.wallets.status <> 'done' THEN NULL ELSE washtrace.wallets.fetched_at END,
           error = CASE WHEN washtrace.wallets.status <> 'done' THEN NULL ELSE washtrace.wallets.error END,
           depth = LEAST(washtrace.wallets.depth, EXCLUDED.depth)`,
        [chainId, addresses, id],
      ))).catch((err) => { throw asDataFault(err); });
      wallets += addresses.length;
    }
    // Locked in id order, so two writers of the chain's collections never wait on each other in a circle.
    await deadlockRetried(() => this.trailStatement(async (c) => {
      await c.query(
        `UPDATE washtrace.collections SET version = version + 1,
           trail_imported_sha = CASE WHEN id = $2 THEN $3 ELSE trail_imported_sha END,
           trail_note = CASE WHEN id = $2 THEN NULL ELSE trail_note END,
           trail_progress = CASE WHEN id = $2 THEN NULL ELSE trail_progress END
         WHERE id IN (SELECT id FROM washtrace.collections WHERE chain_id = $1 ORDER BY id FOR NO KEY UPDATE)`,
        [chainId, id, sha256],
      );
      // Loaded whole: nothing to go on from.
      await c.query('DELETE FROM washtrace.trail_resume WHERE collection_id = $1', [id]);
    }));
    return { wallets, flows };
  }

  /**
   * One of importTrail's statements, in a transaction of its own that waits
   * at most trailLockTimeout for a lock. Only this transaction: everything
   * else in the store waits as it always has.
   */
  private async trailStatement<T>(statement: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('lock_timeout', $1, true)", [this.trailLockTimeout()]);
      const out = await statement(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** How long a trail import's statement waits for a lock (TRAIL_LOCK_TIMEOUT). Tests override it on the instance. */
  trailLockTimeout(): string {
    return TRAIL_LOCK_TIMEOUT;
  }

  /**
   * Say how far a collection's money trail import has got, or with null that
   * none runs. Returns whether the collection is still watched: false when it
   * was paused or deleted, and the import stops. Progress is not written for
   * a paused one; clearing always is.
   */
  async setTrailProgress(id: number, share: number | null): Promise<boolean> {
    const { rows } = await this.pool.query<{ live: boolean }>(
      `UPDATE washtrace.collections SET trail_progress = $2
       WHERE id = $1 AND ($2::real IS NULL OR paused_at IS NULL)
       RETURNING paused_at IS NULL AS live`,
      [id, share],
    );
    return rows[0]?.live ?? false;
  }

  /**
   * Forget every trail import's progress. For a worker starting, while no
   * replica imports (see StoredSync.clearStaleTrailProgress): an import running
   * when the last one died says "Importing" for ever otherwise.
   */
  async clearTrailProgress(): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET trail_progress = NULL WHERE trail_progress IS NOT NULL');
  }

  /** Say why a money trail on disk was not loaded, or with null that nothing is wrong. */
  async setTrailNote(id: number, note: string | null): Promise<void> {
    await this.pool.query('UPDATE washtrace.collections SET trail_note = $2 WHERE id = $1', [id, note]);
  }

  /**
   * Whether a collection's money lenses have funding to run on with no key:
   * it loaded a money trail of its own, and some wallet on its chain is
   * checked. Another collection's trail is not enough: its lenses would read
   * as floors over a check that, with no key, never moves.
   */
  async importedFunding(id: number): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM washtrace.wallets w WHERE w.chain_id = c.chain_id AND w.status = 'done') AS ok
       FROM washtrace.collections c WHERE c.id = $1 AND c.trail_imported_sha IS NOT NULL`,
      [id],
    );
    return rows[0]?.ok ?? false;
  }

  // ---- funding -------------------------------------------------------------

  /**
   * The wallets to read funding for next, in lanes so one big collection cannot
   * crowd out the rest: one lane per collection on the chain that is not paused (its traders),
   * and a last lane for followed wallets (depth > 0), which trade in no collection,
   * there only while some collection is in sync to read them for, and only
   * those within `hops`: ones queued while following went further out wait,
   * and 0 reads traders only.
   * A collection following its money past `hops` (follow_hops) has its
   * reach wallets past `hops` out from it (see seedReach) in its own lane,
   * after its traders and within the same perLane, so it takes one turn a
   * round as every collection does.
   * Each lane is at most `perLane` long: failed wallets last (they retry after
   * an hour), then the shallowest, then the busiest. A trader of two
   * collections is in both lanes, and a wallet two collections reach in
   * both, and in the followed lane too; `interleave` checks it once. Which wallets
   * a lane can hold is SERVED_*'s: fundingBacklog counts with them too.
   */
  async fundingLanes(chainId: number, perLane: number, hops: number): Promise<{ lanes: FundingLane[] }> {
    const unchecked = `w.chain_id = $1 AND (w.status = 'pending' OR (w.status = 'failed' AND w.fetched_at < now() - interval '1 hour'))`;
    const order = `ORDER BY w.status = 'failed', w.depth, w.transfers DESC`; // followed lane only
    // Start from the unchecked traders (few, and none in steady state), then probe
    // each collection's transfers by index for whether it names them. Followed
    // wallets (depth > 0) trade in no collection: their own lane, never a probe.
    const { rows } = await this.pool.query<{ id: number; address: string | null; follow_hops: number | null }>(
      `WITH todo AS MATERIALIZED (
         SELECT w.address, w.status, w.depth, w.transfers FROM washtrace.wallets w WHERE ${unchecked} AND w.depth = 0
       )
       SELECT c.id, l.address, c.follow_hops FROM washtrace.collections c
       LEFT JOIN LATERAL (
         SELECT address, rn FROM (
           SELECT w.address, row_number() OVER (ORDER BY w.status = 'failed', w.depth, w.transfers DESC) AS rn FROM todo w
           WHERE ${SERVED_NAMES}
         ) ranked WHERE rn <= $2
       ) l ON true
       WHERE c.chain_id = $1 AND ${SERVED_LIVE} ORDER BY c.id, l.rn`,
      [chainId, perLane],
    );
    const lanes: FundingLane[] = [];
    for (const r of rows) {
      let lane = lanes.at(-1);
      if (lane?.collectionId !== r.id) lanes.push((lane = { collectionId: r.id, wallets: [] }));
      if (r.address !== null) lane.wallets.push(r.address);
    }
    // Some collection on the chain is live: servedWallet's test for a followed wallet.
    if (lanes.length > 0 && hops > 0) {
      const followed = await this.pool.query<{ address: string }>(
        `SELECT w.address FROM washtrace.wallets w WHERE ${unchecked} AND w.depth > 0 AND w.depth <= $3 ${order} LIMIT $2`,
        [chainId, perLane, hops],
      );
      if (followed.rows.length > 0) lanes.push({ collectionId: null, wallets: followed.rows.map((r) => r.address) });
    }
    // Asked only when some collection follows further: otherwise the lanes are what they always were.
    const reaching = [...new Set(rows.filter((r) => (r.follow_hops ?? 0) > hops).map((r) => r.id))];
    if (reaching.length > 0) {
      // A wallet still to check is never stepped (seedReach), so reach_unstepped_idx holds every one.
      const reach = await this.pool.query<{ id: number; address: string }>(
        `SELECT id, address FROM (
           SELECT r.collection_id AS id, r.address,
                  row_number() OVER (PARTITION BY r.collection_id ORDER BY w.status = 'failed', r.depth, w.transfers DESC) AS rn
           FROM washtrace.reach r JOIN washtrace.wallets w ON w.chain_id = r.chain_id AND w.address = r.address
           WHERE r.collection_id = ANY($4::int[]) AND NOT r.stepped AND ${unchecked} AND ${SERVED_REACH('$3')}
         ) x WHERE rn <= $2 ORDER BY id, rn`,
        [chainId, perLane, hops, reaching],
      );
      // Every live collection has its lane by now: the traders' query gives each a row. Its reach fills what
      // its traders leave of perLane, so a lane stays at most perLane long.
      for (const r of reach.rows) {
        const lane = lanes.find((l) => l.collectionId === r.id)!;
        if (lane.wallets.length < perLane) lane.wallets.push(r.address);
      }
    }
    return { lanes };
  }

  /**
   * Store a wallet's flows and take it off the queue. With `follow`, queue
   * the wallets it sent money to, one hop further out: see Follow.
   */
  async fund(chainId: number, wallet: string, flows: readonly Flow[], truncated: boolean, follow?: Follow): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await insertFlows(c, chainId, flows);
      await c.query(
        `UPDATE washtrace.wallets SET status = 'done', truncated = $3, fetched_at = now(), error = NULL WHERE chain_id = $1 AND address = $2`,
        [chainId, wallet, truncated],
      );
      if (follow && !truncated) {
        const skip = new Set(follow.exclude);
        const sent = [...new Set(flows.filter((f) => f.from === wallet && f.to !== wallet && !skip.has(f.to)).map((f) => f.to))];
        if (sent.length > 0 && sent.length <= follow.fanout) {
          await c.query(
            `INSERT INTO washtrace.wallets (chain_id, address, depth)
             SELECT $1, a, w.depth + 1 FROM unnest($2::text[]) AS a, washtrace.wallets w
             WHERE w.chain_id = $1 AND w.address = $3 AND w.depth < $4
             ON CONFLICT (chain_id, address) DO NOTHING`,
            [chainId, sent, wallet, follow.hops],
          );
        }
      }
      // Every collection this wallet or any counterparty traded in reads it
      // again: a followed wallet's flows can close a path to a trader. So
      // does every collection holding it in its reach past the global limit
      // (Ruling S36): a wallet that far out seldom has a trader among its
      // counterparties, and without the bump no analysis, so no lens run,
      // would ever read what Fetch them fetched.
      const touched = [...new Set([wallet, ...flows.flatMap((f) => [f.from, f.to])])];
      // Locked in id order, as a loaded trail's bump locks them, so two writers never wait on each other in a circle.
      await c.query(
        `UPDATE washtrace.collections SET version = version + 1
         WHERE id IN (
           SELECT id FROM washtrace.collections
           WHERE (id IN (SELECT DISTINCT collection_id FROM washtrace.transfers WHERE from_address = ANY($2) OR to_address = ANY($2))
                  OR id IN (SELECT r.collection_id FROM washtrace.reach r WHERE r.chain_id = $1 AND r.address = $3 AND r.depth > $4))
             AND chain_id = $1
           ORDER BY id FOR NO KEY UPDATE)`,
        [chainId, touched, wallet, follow?.hops ?? 0],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async fundingFailed(chainId: number, wallet: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.wallets SET status = 'failed', fetched_at = now(), error = $3 WHERE chain_id = $1 AND address = $2`,
      [chainId, wallet, message],
    );
  }

  /**
   * Each chain's wallets by funding state. `pending` and `failed` are the
   * ones a lane will serve (servedWallet, from what fundingLanes builds on),
   * so the wait drains to nothing; `stranded` are the unchecked rest, held
   * back while every collection that names them is paused or removed, or
   * followed further out than `hops`, and no lane takes them. The status
   * route and the Worker page read this every few seconds, with the hops the
   * worker reported.
   */
  async fundingBacklog(hops: number): Promise<{ chainId: number; pending: number; done: number; failed: number; stranded: number; truncated: number; followed: number; doneLastHour: number }[]> {
    // Only the unchecked wallets are probed, each once (MATERIALIZED, so the
    // probe is not repeated in every count that reads it). Stranded ones
    // dominate the cost and are permanent: deleting a collection keeps its
    // wallets, and no lane ever checks them. The planner's estimate for the
    // probes is far above JIT's threshold, and compiling cost twice the query
    // itself (430 ms against 150 at 26k stranded wallets), so JIT is off.
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL jit = off');
      const { rows } = await c.query(
        `WITH waiting AS MATERIALIZED (
           SELECT w.chain_id, w.status, ${servedWallet('$1')} AS served FROM washtrace.wallets w WHERE w.status IN ('pending', 'failed')
         ), unchecked AS (
           SELECT chain_id, count(*) FILTER (WHERE status = 'pending' AND served)::int AS pending,
                  count(*) FILTER (WHERE status = 'failed' AND served)::int AS failed, count(*) FILTER (WHERE NOT served)::int AS stranded
           FROM waiting GROUP BY chain_id
         )
         SELECT w.chain_id, coalesce(u.pending, 0) AS pending, coalesce(u.failed, 0) AS failed, coalesce(u.stranded, 0) AS stranded,
                count(*) FILTER (WHERE w.status = 'done')::int AS done,
                count(*) FILTER (WHERE w.status = 'done' AND w.fetched_at > now() - interval '1 hour')::int AS done_last_hour,
                count(*) FILTER (WHERE w.truncated)::int AS truncated, count(*) FILTER (WHERE w.depth > 0)::int AS followed
         FROM washtrace.wallets w LEFT JOIN unchecked u ON u.chain_id = w.chain_id
         GROUP BY w.chain_id, u.pending, u.failed, u.stranded ORDER BY w.chain_id`,
        [hops],
      );
      await c.query('COMMIT');
      return rows.map((r) => ({
        chainId: r.chain_id, pending: r.pending, done: r.done, failed: r.failed, stranded: r.stranded, truncated: r.truncated, followed: r.followed, doneLastHour: r.done_last_hour,
      }));
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * Fetch them (Data this lens needs): follow this collection's money out to
   * `hops`, past follow.hops, from the next fund pass on. Only ever raised: a
   * second press, or one asking for less than is set, is 'already' and
   * changes nothing. 'gone' when the collection is. The collection's row is
   * locked first, then its reach, the order every write to what a collection
   * owns takes. Its reach is not seeded out to the new limit until a walk
   * finds nothing more to step (moneyRead's `seeding`), and the wallets read
   * at the old limit, marked stepped without being followed (stepReach), are
   * stepped from again.
   *
   * The row is taken FOR UPDATE (Ruling S29), the one lock mode that waits
   * for a seedReach chunk's FOR KEY SHARE. So a press waits for a chunk to
   * commit, and sees and unmarks what it marked at the old limit, which a
   * press reading the chunk's rows uncommitted would leave stepped; and a
   * chunk starting meanwhile waits, then reads the new limit. Nor can the
   * two lock the old limit's reach rows in opposite orders.
   *
   * It waits on more than a chunk: on every write that holds the row's KEY
   * SHARE for its foreign keys (an ingest span's transfers, saveAnalysis,
   * saveLensRun) and on the NO KEY UPDATE of a version bump (fund, ingest).
   * Each is short, a span or a save, so a press waits for it rather than
   * failing on a lock_timeout the reader would have to retry.
   */
  async followFurther(collectionId: number, hops: number): Promise<'set' | 'already' | 'gone'> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const own = (await c.query<{ follow_hops: number | null }>(
        'SELECT follow_hops FROM washtrace.collections WHERE id = $1 FOR UPDATE', [collectionId])).rows[0];
      if (own === undefined || (own.follow_hops ?? 0) >= hops) {
        await c.query('COMMIT');
        return own === undefined ? 'gone' : 'already';
      }
      await c.query('UPDATE washtrace.collections SET follow_hops = $2, reach_seeded_at = NULL WHERE id = $1', [collectionId, hops]);
      if (own.follow_hops !== null) {
        await c.query('UPDATE washtrace.reach SET stepped = false WHERE collection_id = $1 AND depth >= $2 AND stepped', [collectionId, own.follow_hops]);
      }
      await c.query('COMMIT');
      return 'set';
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * How far this collection's money is read, against `globalHops`, the
   * follow.hops the caller runs with: see MoneyRead. A reach wallet with no
   * wallet row is counted unread, so a share can never read complete on it.
   */
  async moneyRead(collectionId: number, globalHops: number): Promise<MoneyRead> {
    // A truncated trader counts as checked, as coverage counts it (Ruling S35): it is never read again, so
    // counting it unchecked would keep the traders' check "still running" for good on any collection with a busy trader.
    // Seeded, and no reach wallet left that is checked but not yet stepped from short of its limit: one is
    // walk work left, as what it paid is not in the reach yet, so moneyRead reads it as seeding (M3).
    const { rows } = await this.pool.query<{ follow_hops: number | null; follow_estimate: FollowEstimate | null; seeded: boolean; checked: number; of: number }>(
      `SELECT c.follow_hops, c.follow_estimate, t.checked, t.of,
              c.reach_seeded_at IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM washtrace.reach r JOIN washtrace.wallets w ON w.chain_id = r.chain_id AND w.address = r.address
                WHERE r.collection_id = c.id AND NOT r.stepped AND r.depth < c.follow_hops AND w.status = 'done' AND NOT w.truncated
              ) AS seeded
       FROM washtrace.collections c
       CROSS JOIN LATERAL (
         SELECT count(*) FILTER (WHERE w.status = 'done')::int AS checked, count(*)::int AS of
         FROM (SELECT x.from_address AS address FROM washtrace.transfers x WHERE x.collection_id = c.id
               UNION SELECT x.to_address FROM washtrace.transfers x WHERE x.collection_id = c.id) t
         JOIN washtrace.wallets w ON w.chain_id = c.chain_id AND w.address = t.address
       ) t
       WHERE c.id = $1`,
      [collectionId],
    );
    // A stepped wallet was done when stepped from, so only the unstepped are read (reach_unstepped_idx).
    // Within the global limit, reach rows are the walk's own, their wallets the followed lane's work (Ruling S23).
    const pending = await this.pool.query<{ depth: number; n: number }>(
      `SELECT r.depth, count(*)::int AS n FROM washtrace.reach r
       LEFT JOIN washtrace.wallets w ON w.chain_id = r.chain_id AND w.address = r.address
       WHERE r.collection_id = $1 AND NOT r.stepped AND r.depth > $2 AND w.status IS DISTINCT FROM 'done'
       GROUP BY r.depth`,
      [collectionId, globalHops],
    );
    const ownLimit = rows[0]?.follow_hops ?? null;
    const limit = Math.max(globalHops, ownLimit ?? 0);
    const estimate = rows[0]?.follow_estimate ?? null;
    return {
      traders: { checked: rows[0]?.checked ?? 0, of: rows[0]?.of ?? 0 },
      limit,
      ownLimit,
      pendingByDepth: Object.fromEntries(pending.rows.map((r) => [r.depth, r.n])),
      estimate: estimate?.depth === limit + 1 ? estimate : null,
      seeding: ownLimit !== null && ownLimit > globalHops && rows[0]?.seeded === false,
    };
  }

  /**
   * Count what following this collection's money one hop past its limit
   * would read, and store it as its follow_estimate (Ruling S21): the worker
   * counts, and a page only reads, since the count is a walk of seconds. The
   * walk steps as its reach is seeded (paidBy), at most `walkCap` wallets, and
   * a level it cut is scaled up (see walkOut). Counted are the wallets at
   * that hop not in its reach already nor checked on the chain, since only
   * those cost Etherscan calls. `growth` is the chain's own, from its
   * next-deepest depth to its deepest (wallets by depth), or on a chain that
   * follows nothing yet this walk's last step's.
   *
   * The walk reads in a snapshot of its own and holds no lock. The estimate
   * is written after it, in a statement of its own that takes the
   * collection's row and nothing else, as followFurther does: written inside
   * the snapshot, it would fail on any write to the row since (each funded
   * wallet bumps it). An estimate counted for a limit raised meanwhile reads
   * as nothing in moneyRead. 'gone' when the collection is.
   *
   * It stops by `timeoutMs` in all (COUNT_TIMEOUT_MS unless the pass has less
   * left), failing with nothing stored. Every attempt is noted in
   * count_tried_at first, so one that keeps running out of time waits its
   * turn behind the rest (nextCount) and never holds the count for itself.
   */
  async countNext(collectionId: number, globalHops: number, timeoutMs = this.countTimeoutMs): Promise<'counted' | 'gone'> {
    // Tried, whether or not it is counted (Ruling S26): nextCount gives the next pass's count to another.
    await this.pool.query('UPDATE washtrace.collections SET count_tried_at = now() WHERE id = $1', [collectionId]);
    const c = await this.pool.connect();
    let counted: Omit<FollowEstimate, 'at'>;
    try {
      // One snapshot for the walk's statements, so a level never sees flows the one before did not.
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const until = Date.now() + timeoutMs;
      await timeLeft(c, until);
      const own = (await c.query<{ chain_id: number; follow_hops: number | null }>(
        'SELECT chain_id, follow_hops FROM washtrace.collections WHERE id = $1', [collectionId],
      )).rows[0];
      if (own === undefined) {
        await c.query('COMMIT');
        return 'gone';
      }
      const limit = Math.max(globalHops, own.follow_hops ?? 0);
      const next = limit + 1;
      const walk = await walkOut(c, collectionId, own.chain_id, next, followOf(own.chain_id, next), this.walkCap, until);
      await timeLeft(c, until);
      const unread = (await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM walked k
         WHERE k.depth = $2
           AND NOT EXISTS (SELECT 1 FROM washtrace.reach r WHERE r.collection_id = $1 AND r.address = k.address)
           AND NOT EXISTS (SELECT 1 FROM washtrace.wallets w WHERE w.chain_id = $3 AND w.address = k.address AND w.status = 'done')`,
        [collectionId, next, own.chain_id],
      )).rows[0]!.n;
      await timeLeft(c, until);
      const byDepth = (await c.query<{ depth: number; n: number }>(
        'SELECT depth, count(*)::int AS n FROM washtrace.wallets WHERE chain_id = $1 GROUP BY depth ORDER BY depth', [own.chain_id],
      )).rows;
      await c.query('COMMIT');
      const deepest = byDepth.at(-1);
      const before = byDepth.find((r) => r.depth === (deepest?.depth ?? 0) - 1);
      const growth = deepest !== undefined && before !== undefined ? deepest.n / before.n
        : walk.counts[limit]! > 0 ? walk.counts[next]! / walk.counts[limit]! : null;
      counted = { depth: next, wallets: Math.round(unread * walk.scale), growth, cut: walk.cut };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
    const { rowCount } = await this.pool.query(
      // `at` in toISOString's form: jsonb's own rendering of now() has microseconds and +00:00, which a JS Date need not parse.
      `UPDATE washtrace.collections
       SET follow_estimate = $2::jsonb || jsonb_build_object('at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       WHERE id = $1`,
      [collectionId, JSON.stringify(counted)],
    );
    return (rowCount ?? 0) > 0 ? 'counted' : 'gone';
  }

  /**
   * The watched collection whose follow_estimate the fund pass counts next
   * (Ruling S21), or null when every one is fresh: not paused, and its
   * estimate missing, counted for a hop other than the one past its limit
   * now, or a day old. The one tried longest ago first (count_tried_at,
   * Ruling S26), one never tried before any, so one whose count runs out of
   * time waits its turn; then a missing estimate before any. One whose last
   * try failed (tried after its estimate was written, or with none) under an
   * hour ago waits out the hour: as the only one due, it would otherwise be
   * tried every pass, each costing the pass COUNT_MS of its checking.
   */
  async nextCount(globalHops: number): Promise<number | null> {
    // A count that succeeds writes its `at` after count_tried_at, truncated to the millisecond, hence the 1 ms.
    const { rows } = await this.pool.query<{ id: number }>(
      `SELECT id FROM washtrace.collections
       WHERE paused_at IS NULL AND (follow_estimate IS NULL
         OR (follow_estimate->>'depth')::int <> greatest($1, coalesce(follow_hops, 0)) + 1
         OR (follow_estimate->>'at')::timestamptz < now() - interval '24 hours')
         AND (count_tried_at IS NULL OR count_tried_at < now() - interval '1 hour'
              OR count_tried_at <= (follow_estimate->>'at')::timestamptz + interval '1 millisecond')
       ORDER BY count_tried_at NULLS FIRST, (follow_estimate->>'depth')::int = greatest($1, coalesce(follow_hops, 0)) + 1 NULLS FIRST,
                (follow_estimate->>'at')::timestamptz NULLS FIRST, id
       LIMIT 1`,
      [globalHops],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Walk the stored flows out from the traders of a collection following its
   * money past `globalHops` (N4), into its reach, stepping from at most
   * `limit` wallets a call (Ruling S28: wallets stepped from, not rows
   * written, which may be up to FOLLOW_FANOUT times as many): what a fund
   * pass can spend, as a walk of a big collection is minutes cold.
   *
   * Its rows are how far the walk has got, so the next call goes on from
   * them, and a wallet checked since, by any lane, is stepped from next: so
   * its reach grows past the global limit as reach wallets are checked, and
   * through the ones already checked on the chain, which no lane hands out
   * again. Shallowest first, each wallet at its shallowest depth: one found
   * nearer later is moved in and stepped from again. A step queues what a
   * wallet sent as `fund` does (paidBy), into wallets as well, at the chain
   * depth it has by this walk if `fund` gave none nearer, for a lane to
   * check: the followed lane within `globalHops`, its reach lane past it.
   * Out to follow_hops and no further.
   *
   * Its traders are added first, and once a day after, for those who
   * traded since; reach_seeded_at says when a call last found nothing more
   * to step or add, written only while follow_hops is still the limit the
   * call read, so a press meanwhile leaves it seeding. A paused collection
   * waits. Gives how many wallets it stepped from, or traders it added, 0
   * when no collection on the chain has any left.
   */
  async seedReach(chainId: number, globalHops: number, limit: number): Promise<number> {
    const { rows } = await this.pool.query<{ id: number; follow_hops: number; seeded: boolean }>(
      `SELECT id, follow_hops, coalesce(reach_seeded_at > now() - interval '24 hours', false) AS seeded FROM washtrace.collections
       WHERE chain_id = $1 AND paused_at IS NULL AND follow_hops > $2 ORDER BY id`,
      [chainId, globalHops],
    );
    for (const own of rows) {
      const step = await this.reachStatement(own.id, (c) => stepReach(c, own.id, chainId, limit, globalHops));
      if (step !== null && step.doneFar > 0) {
        // Ruling S39: its runs read every reach wallet past the global limit (followedFor), and one already
        // checked, for another collection or before a follow.hops was lowered, is never checked again, so no
        // fund call bumps the version for it. In its own statement after the chunk's commit, so the bump takes
        // the row alone, as fund's does, and the chunk's lock order is unchanged.
        await this.pool.query('UPDATE washtrace.collections SET version = version + 1 WHERE id = $1', [own.id]);
      }
      const stepped = step?.stepped ?? null;
      if (stepped !== null && stepped > 0) return stepped;
      if (stepped === null || own.seeded) continue;
      const added = await this.reachStatement(own.id, (c) => addTraders(c, own.id, chainId));
      if (added === null) continue;
      if (added > 0) return added;
      await this.pool.query('UPDATE washtrace.collections SET reach_seeded_at = now() WHERE id = $1 AND follow_hops = $2', [own.id, own.follow_hops]);
    }
    return 0;
  }

  /**
   * One of seedReach's writes, in a transaction of its own that takes the
   * collection's row first, FOR KEY SHARE as the reach rows' own key check
   * would, then wallets, then reach: the order every write to what a
   * collection owns takes, so a delete lands before or after, and a fund
   * bumping the row's version never waits on it. Null when the collection
   * is gone or paused since.
   */
  private async reachStatement<T>(id: number, write: (c: pg.PoolClient) => Promise<T>): Promise<T | null> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const live = await c.query('SELECT 1 FROM washtrace.collections WHERE id = $1 AND paused_at IS NULL FOR KEY SHARE', [id]);
      const n = live.rowCount === 0 ? null : await write(c);
      await c.query('COMMIT');
      return n;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  // ---- analysis ------------------------------------------------------------

  /**
   * Collections written to since their latest analysis, with the version each
   * analysis will record and the rules it runs under, read together: a rule
   * changed mid-analysis moves the version, so the collection runs again.
   * When the latest analysis ran and how long it took come along, so the
   * worker can space out the reruns of a collection that is always changing,
   * and when its rules last changed, so a rule edit is not made to wait.
   * `retryAt` is when one whose analysis failed may be tried again (see
   * analysisFailed): null when none failed.
   */
  async stale(): Promise<{
    id: number; chainId: number; version: number; rules: Partial<Rules>; name: string | null;
    ranAt: number | null; tookMs: number | null; rulesAt: number | null; retryAt: number | null;
  }[]> {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.chain_id, c.version, c.rules, c.name, a.took_ms, extract(epoch FROM a.ran_at)::float8 AS ran,
              extract(epoch FROM c.rules_at)::float8 AS rules_changed, extract(epoch FROM c.analysis_retry_at)::float8 AS retry
       FROM washtrace.collections c
       LEFT JOIN LATERAL (SELECT ran_at, took_ms FROM washtrace.analyses x WHERE x.collection_id = c.id ORDER BY x.ran_at DESC LIMIT 1) a ON true
       WHERE c.version > c.analyzed_version AND c.paused_at IS NULL ORDER BY c.id`,
    );
    return rows.map((r) => ({
      id: r.id, chainId: r.chain_id, version: Number(r.version), rules: r.rules, name: r.name,
      ranAt: r.ran === null ? null : r.ran * 1000, tookMs: r.took_ms, rulesAt: r.rules_changed === null ? null : r.rules_changed * 1000,
      retryAt: r.retry === null ? null : r.retry * 1000,
    }));
  }

  /**
   * What `analyze` reads for one collection: its transfers, the payments
   * among its wallets and the funding state of those wallets. The payments
   * stream through a cursor straight into a `Payments`, so no `Flow` is ever
   * built for them: Terraforms' millions were 1.2 GB of heap as objects.
   * `hops` is follow.hops, the global limit: see followedFor.
   */
  async analysisInput(id: number, chainId: number, hops: number): Promise<{
    transfers: Transfer[]; payments: Payments; funded: Set<string>; truncated: Set<string>; through: number | null;
  }> {
    // The cursor first, and the transfers no further than it. Ingest commits
    // its transfers and the cursor together, so a trade ingested while this
    // runs lies past `through` and is not judged; the next analysis takes it.
    const cursor = (await this.pool.query<{ cursor_block: string | null }>('SELECT cursor_block FROM washtrace.collections WHERE id = $1', [id])).rows[0]?.cursor_block;
    const through = cursor == null ? null : Number(cursor);
    const transfers = (await this.pool.query(
      `${SELECT_TRANSFER} ${TRANSFERS} WHERE t.collection_id = $1 AND ($2::bigint IS NULL OR t.block_number <= $2::bigint)`, [id, through],
    )).rows.map(toTransfer);
    // The collection's wallets go in as an array, not as a subquery. As an
    // IN subquery, thousands of them were too many to hash in work_mem, and
    // Postgres walked the whole list once per flow on the chain: 56 minutes
    // for Terraforms. An array it hashes, or probes the flows indexes with.
    const wallets = [...new Set(transfers.flatMap((t) => [t.from, t.to]))];
    const { near, far } = await this.followedFor(id, chainId, hops);
    const followed = [...near, ...far];
    // One payment per pair of wallets, the one with the smallest hash: the
    // money graph keeps no more than that, across both directions of a pair,
    // so the rest would be read only to be dropped, and the answer is the
    // same as reading them all. So are the flows it skips anyway: payments
    // inside the collection's own sales, zero values, a wallet paying itself,
    // and mints and burns. This WHERE is the whole filter, which is why
    // `Payments.add` checks nothing. A trader's history runs to thousands of
    // flows, and reading them all ran the worker out of memory at 6.7M flows
    // for 1.3M pairs; the cursor keeps even the pairs from landing at once.
    const payments = new Payments();
    const paid = this.stream(
      // Three columns and no more: millions of rows, and the graph reads nothing else of a payment.
      `SELECT DISTINCT ON (f.from_address, f.to_address) f.from_address, f.to_address, f.tx_hash FROM washtrace.flows f
       WHERE f.chain_id = $1 AND (f.from_address = ANY($2::text[]) OR f.to_address = ANY($2::text[])
         -- Followed wallets' payments onward: the middle of a path SCC AU follows back.
         OR f.from_address = ANY($3::text[]))
         AND f.value_wei > 0 AND f.from_address <> f.to_address AND f.from_address <> $4 AND f.to_address <> $4
         AND NOT EXISTS (SELECT 1 FROM washtrace.transfers s WHERE s.collection_id = $5 AND s.tx_hash = f.tx_hash)
       ORDER BY f.from_address, f.to_address, f.tx_hash`,
      [chainId, wallets, followed, ZERO, id], (r) => r, this.paymentBatch,
    );
    for await (const r of paid) payments.add(r.from_address, r.to_address, r.tx_hash);
    const state = (await this.pool.query<{ address: string; truncated: boolean }>(
      `SELECT address, truncated FROM washtrace.wallets WHERE chain_id = $1 AND status = 'done' AND (address = ANY($2::text[]) OR ${FOLLOWED_NEAR('$3')}${far.length > 0 ? ' OR address = ANY($4::text[])' : ''})`,
      far.length > 0 ? [chainId, wallets, hops, far] : [chainId, wallets, hops],
    )).rows;
    return {
      transfers,
      payments,
      funded: new Set(state.map((s) => s.address)),
      truncated: new Set(state.filter((s) => s.truncated).map((s) => s.address)),
      through,
    };
  }

  /**
   * The checked followed wallets a run of collection `id` reads onward from
   * (Ruling S38): `near`, those within `hops` (follow.hops) out on the chain,
   * and depth 1 at least (Ruling S40: see FOLLOWED_NEAR), and `far`, those of
   * its own reach past that. wallets.depth is the shallowest
   * depth from any collection's traders (Ruling S27), so a wallet deeper than
   * `hops` is in some collection's reach, and only that collection's runs
   * read it: one collection's Fetch them moves no other's numbers, nor its
   * memory. One left deeper by a follow.hops since lowered is read by none,
   * as the setting says. `far` is empty, and reach not asked at all, when the
   * collection follows no further than `hops`, so such a run reads as it did.
   */
  private async followedFor(id: number, chainId: number, hops: number): Promise<{ near: string[]; far: string[] }> {
    const near = (await this.pool.query<{ address: string }>(
      `SELECT address FROM washtrace.wallets WHERE chain_id = $1 AND ${FOLLOWED_NEAR('$2')} AND status = 'done'`,
      [chainId, hops],
    )).rows.map((r) => r.address);
    const own = (await this.pool.query<{ follow_hops: number | null }>('SELECT follow_hops FROM washtrace.collections WHERE id = $1', [id])).rows[0]?.follow_hops ?? 0;
    if (own <= hops) return { near, far: [] };
    const far = (await this.pool.query<{ address: string }>(
      `SELECT w.address FROM washtrace.reach r JOIN washtrace.wallets w ON w.chain_id = r.chain_id AND w.address = r.address
       WHERE r.collection_id = $1 AND w.status = 'done' AND w.depth > greatest($2, 1)`,
      [id, hops],
    )).rows.map((r) => r.address);
    return { near, far };
  }

  /**
   * What a lens run reads for one collection: its transfers up to `through`,
   * and the money edges its rule has switched on. The same wallets and reach
   * as `analysisInput`, but every edge is kept, with its kind, amount and
   * time, not one per pair: a lens judges those. So are payments inside the
   * collection's own sales, which the built-ins drop: the engine drops them
   * itself, from `Moves.sale`, as an NFT's price is neither a way back nor
   * funding. Each enabled kind is filtered by its minimum in SQL, so a
   * rule with a high floor never reads the dust, and one with no money row
   * reads no flows at all. Money past `moneyEdgeCeiling` edges throws, and the
   * run fails saying how many there are. `hops` is follow.hops, as there.
   */
  async lensInput(id: number, chainId: number, rule: LensRule, through: number | null, hops: number): Promise<LensInput> {
    const transfers = (await this.pool.query(
      `${SELECT_TRANSFER} ${TRANSFERS} WHERE t.collection_id = $1 AND ($2::bigint IS NULL OR t.block_number <= $2::bigint)`, [id, through],
    )).rows.map(toTransfer);
    const tradeTxs: string[] = [];
    const tradeAt = new Map<string, number>();
    for (const t of transfers) if (!tradeAt.has(t.txHash)) tradeAt.set(t.txHash, tradeTxs.push(t.txHash) - 1);
    const money = moneyFor(chainId);
    const moves = new Moves();
    let truncated = new Set<string>();
    const params: unknown[] = [chainId];
    const bind = binder(params);
    const kinds: string[] = [];
    const floor = (kind: 'eth' | 'internal' | 'weth') => `${bind(rule.edges[kind].minWei ?? '0')}::numeric`;
    if (rule.edges.eth.use) kinds.push(`(f.kind = 'native' AND f.value_wei >= ${floor('eth')})`);
    if (rule.edges.internal.use) kinds.push(`(f.kind = 'internal' AND f.value_wei >= ${floor('internal')})`);
    if (rule.edges.weth.use) kinds.push(`(f.kind = 'token' AND f.token = ANY(${bind([...money].filter((m) => m !== ''))}::text[]) AND f.value_wei >= ${floor('weth')})`);
    if (kinds.length > 0) {
      // Arrays, not subqueries, for the reason analysisInput gives.
      const wallets = [...new Set(transfers.flatMap((t) => [t.from, t.to]))];
      const { near, far } = await this.followedFor(id, chainId, hops);
      const w = bind(wallets), fw = bind([...near, ...far]), zero = bind(ZERO);
      const rows = this.stream(
        `SELECT f.from_address, f.to_address, f.tx_hash,
                CASE f.kind WHEN 'native' THEN ${MOVE_KIND.eth} WHEN 'internal' THEN ${MOVE_KIND.internal} ELSE ${MOVE_KIND.weth} END AS k,
                extract(epoch FROM f.block_time)::int AS t, f.block_number::int AS b, (f.value_wei / 1e18)::float8 AS eth
         FROM washtrace.flows f
         WHERE f.chain_id = $1 AND (f.from_address = ANY(${w}::text[]) OR f.to_address = ANY(${w}::text[])
           -- Followed wallets' payments onward, as analysisInput reads them.
           OR f.from_address = ANY(${fw}::text[]))
           AND f.value_wei > 0 AND f.from_address <> f.to_address AND f.from_address <> ${zero} AND f.to_address <> ${zero}
           AND (${kinds.join(' OR ')})
         -- By time, as Moves holds them, so it need not sort them (a sort of Terraforms' 37M edges
         -- held them all twice over); then the flows key, whole: Moves keeps equal-time edges in the
         -- order read, and a capped search meets them in that order, so the same data must be read
         -- the same way every run.
         ORDER BY t, f.kind, f.tx_hash, f.from_address, f.to_address, f.token, f.value_wei`,
        params, (r) => r, this.paymentBatch,
      );
      // The hash is looked up and dropped: no string per edge. Past the ceiling an edge is only counted, so the
      // run can say how big the money is without holding it.
      let n = 0;
      for await (const r of rows) {
        if (++n <= this.moneyEdgeCeiling) moves.add(r.from_address, r.to_address, r.k, r.t, r.b, r.eth, tradeAt.has(r.tx_hash));
      }
      if (n > this.moneyEdgeCeiling) throw new Error(`This collection's money is too big for a lens run yet (${n.toLocaleString('en-US')} money edges).`);
      // The same wallets analysisInput asks about: few, the busiest there are.
      truncated = new Set((await this.pool.query<{ address: string }>(
        `SELECT address FROM washtrace.wallets WHERE chain_id = $1 AND status = 'done' AND truncated
           AND (address = ANY($2::text[]) OR ${FOLLOWED_NEAR('$3')}${far.length > 0 ? ' OR address = ANY($4::text[])' : ''})`,
        far.length > 0 ? [chainId, wallets, hops, far] : [chainId, wallets, hops],
      )).rows.map((r) => r.address));
    }
    moves.seal();
    return { transfers, through, moves, contracts: contractsFor(chainId), custodians: new Set(CUSTODIANS), money, truncated, tradeTxs };
  }

  /**
   * The transaction hash and exact amount of each of a found loop's money
   * edges, in the order given, or null where none matches: the engine holds
   * no hash per edge and the amount only as a float, so only the few that
   * make a flag are looked up. An edge is found by its ends, kind and block,
   * among only the rows `lensInput` could have loaded for the run's rule
   * (Ruling LL): of some value, at least its kind's floor, and in no
   * transaction that moves one of the collection's tokens through the block
   * the run read. A flag's evidence is then a payment the lens admitted, not
   * dust or a sale's own leg that shares the pair and block. Of those, the
   * smallest hash answers when several match, with its own amount.
   *
   * Asked `moveTxBatch` edges at a time, each a probe of `flows_moves_idx`
   * that reads only its own few rows: joined on its sender alone, one busy
   * sender's whole history was read per edge, and 5,000 edges took 92 s.
   */
  async moveTxs(
    run: { chainId: number; collectionId: number; rule: LensRule; through: number | null },
    edges: { from: string; to: string; kind: EdgeKind; block: number }[],
  ): Promise<({ tx: string; amountWei: string } | null)[]> {
    const out: ({ tx: string; amountWei: string } | null)[] = edges.map(() => null);
    const asked = edges.map((e, i) => ({ e, i })).filter(({ e }) => e.kind === 'eth' || e.kind === 'internal' || e.kind === 'weth');
    const money = [...moneyFor(run.chainId)].filter((m) => m !== '');
    for (let at = 0; at < asked.length; at += this.moveTxBatch) {
      const batch = asked.slice(at, at + this.moveTxBatch);
      const { rows } = await this.pool.query<{ i: string; tx: string; wei: string }>(
        // Its ends are a Moves edge's, which are never the zero address or one wallet twice; said here too, as lensInput reads.
        `SELECT u.i, m.tx, m.wei
         FROM unnest($2::text[], $3::text[], $4::text[], $5::bigint[], $6::numeric[]) WITH ORDINALITY AS u(src, dst, k, b, floor, i)
         CROSS JOIN LATERAL (
           SELECT f.tx_hash AS tx, f.value_wei::text AS wei FROM washtrace.flows f
           WHERE f.chain_id = $1 AND f.from_address = u.src AND f.to_address = u.dst AND f.block_number = u.b AND f.kind = u.k
             AND (u.k <> 'token' OR f.token = ANY($7::text[]))
             AND f.value_wei > 0 AND f.value_wei >= u.floor
             AND f.from_address <> f.to_address AND f.from_address <> $8 AND f.to_address <> $8
             AND NOT EXISTS (SELECT 1 FROM washtrace.transfers t WHERE t.collection_id = $9 AND t.tx_hash = f.tx_hash
               AND ($10::bigint IS NULL OR t.block_number <= $10::bigint))
           ORDER BY f.tx_hash, f.value_wei LIMIT 1) m`,
        [
          run.chainId, batch.map(({ e }) => e.from), batch.map(({ e }) => e.to),
          batch.map(({ e }) => (e.kind === 'eth' ? 'native' : e.kind === 'internal' ? 'internal' : 'token')), batch.map(({ e }) => e.block),
          batch.map(({ e }) => run.rule.edges[e.kind].minWei ?? '0'),
          money, ZERO, run.collectionId, run.through,
        ],
      );
      for (const r of rows) out[batch[Number(r.i) - 1]!.i] = { tx: r.tx, amountWei: r.wei };
    }
    return out;
  }

  /**
   * Record an analysis and replace the collection's flags and trade facts with its own, and
   * forget any analysis that failed before it. A collection removed while
   * its analysis ran has nowhere to keep it, so the analysis is dropped
   * quietly: the removal was asked for, not a failure.
   */
  async saveAnalysis(id: number, version: number, analysis: Analysis, tookMs: number, through: number | null, money: ReadonlySet<string>): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const f: readonly Flag[] = analysis.flags;
      // Each witness gets an id in order of first appearance, and each lens
      // counts its own: from the map and the flags, with no pass in SQL. A
      // lens that did not run counts none, as its totals are zeroed, though
      // its flags carry Round trips' copy: the counts reach the API unfiltered.
      const ids = new Map<Witness, number>();
      const seen: Record<Method, Set<number>> = { A: new Set(), AU: new Set(), AC: new Set() };
      const loops: Record<Method, { loops: number; pairs: number }> = {
        A: { loops: 0, pairs: 0 }, AU: { loops: 0, pairs: 0 }, AC: { loops: 0, pairs: 0 },
      };
      for (const x of f) {
        let wid = ids.get(x.witness);
        if (wid === undefined) ids.set(x.witness, (wid = ids.size));
        if (!analysis.totals[x.method].available || seen[x.method].has(wid)) continue;
        seen[x.method].add(wid);
        loops[x.method][x.witness.kind === 'pair' ? 'pairs' : 'loops']++;
      }
      // How far the facts on disk reach, and what they were worked out with: the latest analysis's, read before this one's row is in.
      // Facts worked out otherwise, or by an analysis from before facts were keyed, are no base to add to.
      const key = factsKey(money);
      const last = (await c.query<{ through_block: string | null; facts_key: string | null }>(
        'SELECT through_block, facts_key FROM washtrace.analyses WHERE collection_id = $1 ORDER BY ran_at DESC LIMIT 1', [id],
      )).rows[0];
      const prev = last?.through_block != null && last.facts_key === key ? Number(last.through_block) : null;
      await c.query(
        `INSERT INTO washtrace.analyses (collection_id, took_ms, through_block, totals, missing_data, funded_wallets, wallets, truncated_searches, loops, facts_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, tookMs, through, JSON.stringify(analysis.totals), analysis.missingData, analysis.fundedWallets, analysis.wallets, analysis.truncatedSearches, JSON.stringify(loops), key],
      );
      await c.query('DELETE FROM washtrace.flags WHERE collection_id = $1', [id]);
      await c.query('DELETE FROM washtrace.witnesses WHERE collection_id = $1', [id]);
      // A component's flags share one witness, and the three methods share
      // an SCC's: each is written out once. The flags go in batches, so no
      // one parameter holds every witness: at two million flags that one
      // string was past what the heap would hold.
      const json = new Map<Witness, string>();
      const witness = (w: Witness) => {
        let s = json.get(w);
        if (s === undefined) json.set(w, (s = JSON.stringify(w)));
        return s;
      };
      let written = 0;
      for (let at = 0; at < f.length;) {
        const batch: Flag[] = [];
        const ws: string[] = [];
        const fresh: Witness[] = [];
        for (let size = 0; at < f.length && batch.length < FLAG_BATCH_ROWS && size < FLAG_BATCH_CHARS; at++) {
          const w = f[at]!.witness;
          batch.push(f[at]!);
          ws.push(witness(w));
          if (ids.get(w) === written + fresh.length) fresh.push(w);
          size += ws.at(-1)!.length;
        }
        if (fresh.length) {
          await c.query(
            `INSERT INTO washtrace.witnesses (collection_id, id, kind, wallets, cycles, middle)
             SELECT $1, i, k, ARRAY(SELECT jsonb_array_elements_text(w)), cy, mi FROM unnest($2::int[], $3::text[], $4::jsonb[], $5::int[], $6::text[]) AS u(i, k, w, cy, mi)`,
            [
              id, fresh.map((_, n) => written + n), fresh.map((w) => w.kind),
              // A jsonb array per row, since a text[] cannot nest in a text[]; the insert unpacks it.
              fresh.map((w) => JSON.stringify(w.kind === 'pair' ? (w.middle === null ? [...w.pair] : [...w.pair, w.middle]) : w.wallets)),
              fresh.map((w) => (w.kind === 'pair' ? null : w.cycles)), fresh.map((w) => (w.kind === 'pair' ? w.middle : null)),
            ],
          );
          written += fresh.length;
        }
        await c.query(
          `INSERT INTO washtrace.flags (collection_id, method, tx_hash, log_index, witness, witness_id)
           SELECT $1, m, tx, li, w, wi FROM unnest($2::text[], $3::text[], $4::int[], $5::jsonb[], $6::int[]) AS u(m, tx, li, w, wi)`,
          [id, batch.map((x) => x.method), batch.map((x) => x.txHash), batch.map((x) => x.logIndex), ws, batch.map((x) => ids.get(x.witness)!)],
        );
      }
      await writeFacts(c, id, analysis.uncounted, through, money, prev);
      await c.query(
        `UPDATE washtrace.collections SET analyzed_version = GREATEST(analyzed_version, $2), analysis_failures = 0, analysis_error = NULL, analysis_retry_at = NULL
         WHERE id = $1`,
        [id, version],
      );
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) return;
      throw err;
    } finally {
      c.release();
    }
  }

  /**
   * Note on a collection that its analysis failed, and why (`error`, already
   * scrubbed: it reaches the API), so the console says so until one is
   * saved, and set when it is tried again: five minutes, doubling with each
   * failure in a row, up to an hour. Meanwhile the others are analysed: a
   * failure writes nothing else, so without the wait the same collection
   * would stay first and be tried every pass. Here, not in the worker's
   * memory, so a restarted worker waits too.
   */
  async analysisFailed(id: number, error: string): Promise<void> {
    // The old count on the right: the first failure waits five minutes.
    await this.pool.query(
      `UPDATE washtrace.collections SET analysis_error = $2, analysis_failures = analysis_failures + 1,
         analysis_retry_at = ${backoffSql('analysis_failures')}
       WHERE id = $1`,
      [id, error],
    );
  }

  async history(id: number, limit = 100): Promise<AnalysisRow[]> {
    const { rows } = await this.pool.query(
      `SELECT *, extract(epoch FROM ran_at)::float8 AS ran FROM washtrace.analyses WHERE collection_id = $1 ORDER BY ran_at DESC LIMIT $2`,
      [id, limit],
    );
    return rows.map((r) => toAnalysis(r, r.id)).reverse();
  }

  // ---- stored data --------------------------------------------------------

  /**
   * What a stored-data cut of a collection starts from: where its data
   * begins and ends. The snapshot stops at the cursor, and its time is that
   * of the latest transfer at or below it. Null when it is not watched; the
   * blocks and time are null until it has read some. `name` is the console's
   * label; `contractName` is what the contract's own name() said, which is
   * what a published copy should carry, and is null until it is described.
   */
  async storedHeader(chainId: number, address: string): Promise<{
    id: number; name: string; contractName: string | null; startBlock: number | null; throughBlock: number | null; throughTime: number | null;
  } | null> {
    const { rows } = await this.pool.query(
      `SELECT c.id, COALESCE(c.name, c.contract_name, c.address) AS name, c.contract_name, c.start_block, c.cursor_block,
              (SELECT extract(epoch FROM max(t.block_time))::float8 FROM washtrace.transfers t
               WHERE t.collection_id = c.id AND t.block_number <= c.cursor_block) AS through
       FROM washtrace.collections c WHERE c.chain_id = $1 AND c.address = lower($2)`,
      [chainId, address],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, name: r.name, contractName: r.contract_name, startBlock: r.start_block === null ? null : Number(r.start_block),
      throughBlock: r.cursor_block === null ? null : Number(r.cursor_block), throughTime: r.through === null ? null : r.through * 1000,
    };
  }

  /** A collection's transfers up to block `through`, in chain order, streamed for writing to a file. */
  storedTransfers(id: number, through: number): AsyncGenerator<Transfer> {
    return this.stream(
      `${SELECT_TRANSFER} FROM washtrace.transfers t WHERE t.collection_id = $1 AND t.block_number <= $2 ORDER BY t.block_number, t.log_index`,
      [id, through], toTransfer,
    );
  }

  /**
   * A collection's money trail: the addresses checked to the end and the
   * flows they found. The same wallets and flows `analysisInput` reads, so a
   * store that imports the trail analyses the collection as this one does:
   * its traders, and every followed wallet on the chain. Only chain data goes
   * in: an address, never how or when it was read. `checked` of `of` is how
   * many of the collection's traders are on the list. The rows stream;
   * nothing is read until they are iterated, addresses before flows.
   *
   * An importing install never reads a done wallet again, so every address in
   * the file carries all of its flows, in and out. The followed wallets are
   * fixed when the trail is begun, and both streams use that list: one
   * checked later is left out, not written down without the flows nobody
   * looked for. Traders need no such care, since flows to or from them are
   * all read, and only grow between the two streams. A wallet that is
   * truncated (more history than Etherscan pages through) is left out: its
   * flows are not all there, so claiming it checked would be false. Nor are
   * the wallets still to check: the importing install queues what it needs.
   * Addresses are in address order, as importTrail writes them.
   */
  async trail(id: number, chainId: number): Promise<{ checked: number; of: number; addresses: AsyncGenerator<string>; flows: AsyncGenerator<Flow> }> {
    // Arrays, not subqueries, for the reason analysisInput gives.
    const traders = (await this.pool.query<{ address: string }>(
      `SELECT from_address AS address FROM washtrace.transfers WHERE collection_id = $1
       UNION SELECT to_address FROM washtrace.transfers WHERE collection_id = $1`,
      [id],
    )).rows.map((r) => r.address);
    const followed = (await this.pool.query<{ address: string }>(
      `SELECT address FROM washtrace.wallets WHERE chain_id = $1 AND depth > 0 AND status = 'done'`,
      [chainId],
    )).rows.map((r) => r.address);
    const { rows } = await this.pool.query<{ checked: number; of: number }>(
      `SELECT count(*) FILTER (WHERE status = 'done' AND NOT truncated)::int AS checked, count(*)::int AS of
       FROM washtrace.wallets WHERE chain_id = $1 AND address = ANY($2::text[])`,
      [chainId, traders],
    );
    return {
      checked: rows[0]!.checked,
      of: rows[0]!.of,
      addresses: this.stream(
        `SELECT address FROM washtrace.wallets
         WHERE chain_id = $1 AND status = 'done' AND NOT truncated AND (address = ANY($2::text[]) OR address = ANY($3::text[]))
         ORDER BY address`,
        [chainId, traders, followed],
        (r): string => r.address,
      ),
      flows: this.stream(
        `SELECT f.tx_hash, f.kind, f.from_address, f.to_address, f.value_wei, f.token, f.block_number,
                extract(epoch FROM f.block_time)::float8 AS bt FROM washtrace.flows f
         WHERE f.chain_id = $1 AND (f.from_address = ANY($2::text[]) OR f.to_address = ANY($2::text[])
           OR f.from_address = ANY($3::text[]) OR f.to_address = ANY($3::text[]))
         -- A total order: the same flows cut again give the same file, and the same sha256.
         ORDER BY f.block_number, f.tx_hash, f.kind, f.from_address, f.to_address, f.token, f.value_wei`,
        [chainId, traders, followed], toFlow,
      ),
    };
  }

  /**
   * The rows of `sql`, `page` at a time through a server-side cursor, so
   * millions of them stream rather than land in memory. One read-only
   * transaction, so the rows are one snapshot. Leaving the loop early (a
   * failed write) closes the cursor and gives the connection back.
   */
  private async *stream<T>(sql: string, params: unknown[], map: (r: any) => T, page = CURSOR_PAGE): AsyncGenerator<T> {
    const c = await this.pool.connect();
    let finished = false;
    try {
      await c.query('BEGIN READ ONLY');
      // A cursor is planned for its first tenth of rows. Every caller reads to
      // the end, so say so: Terraforms' payments planned an index walk at nearly
      // 7x the cost of a scan and sort.
      await c.query('SET LOCAL cursor_tuple_fraction = 1');
      await c.query(`DECLARE stored NO SCROLL CURSOR FOR ${sql}`, params);
      for (;;) {
        const { rows } = await c.query(`FETCH ${page} FROM stored`);
        for (const r of rows) yield map(r);
        if (rows.length < page) break;
      }
      await c.query('COMMIT');
      finished = true;
    } finally {
      if (!finished) await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  // ---- reads for the console and the API ----------------------------------

  /**
   * The tokens `method` caught trades of, a page at a time, each with what it
   * caught, of how many, and the loops behind it. Nothing for a lens that did
   * not run, whose flags are Round trips' copied. A Find takes a token number
   * and keeps the tokens whose number starts with it; anything else matches
   * no token.
   */
  async lensTokens(id: number, method: LensKey, o: ListOpts<TokenSort>, ctx: TradeContext): Promise<{ rows: TokenLine[]; total: number }> {
    if (!ctx.ran.includes(method)) return { rows: [], total: 0 };
    const params: unknown[] = [id];
    const src = caughtOf(method, params);
    params.push([...ctx.money]);
    let narrow = '';
    if (o.find !== null) {
      const f = findOf(o.find);
      if (f.kind !== 'token') return { rows: [], total: 0 };
      // Digits only, so the pattern holds no wildcard but its own.
      narrow = `AND t.token_id::text LIKE ${binder(params)(`${f.tokenId}%`)}`;
    }
    const caught = `SELECT t.token_id, ${caughtColumns(method)} ${src.from} WHERE ${src.where} ${narrow} GROUP BY t.token_id`;
    const caughtArgs = params.length;
    const judged = judgedOnly(method, ctx, params);
    const counts = (rows: string | null) => `SELECT t.token_id, count(*)::int AS trades, extract(epoch FROM max(t.block_time))::float8 * 1000 AS at
      FROM washtrace.transfers t ${COUNTED_JOIN}
      WHERE t.collection_id = $1 ${rows === null ? '' : `AND t.token_id IN (SELECT token_id FROM ${rows})`}${judged} GROUP BY t.token_id`;
    const order = `${LIST_ORDER[o.sort === 'newest' ? 'at' : o.sort]}, c.token_id`;
    const rows = await this.lensPage(params, caughtArgs, 'token_id', caught, counts, o.sort === 'share' || o.sort === 'newest', order, null, o, isOwnKey(method));
    return {
      rows: rows.rows.map((r) => ({
        tokenId: r.token_id, caught: r.caught, trades: r.trades, volumeWei: r.volume, lastAt: r.at,
        loops: r.loops, pairs: r.pairs, wallets: r.wallets, closedByMoney: r.closed, laps: r.laps, middles: r.middles,
      })),
      total: rows.total,
    };
  }

  /**
   * The wallets `method` caught trades of, as lensTokens reads tokens. A Find
   * takes a whole address or the start of one; anything else matches no wallet.
   */
  async lensWallets(id: number, method: LensKey, o: ListOpts<WalletSort>, ctx: TradeContext): Promise<{ rows: WalletLine[]; total: number }> {
    if (!ctx.ran.includes(method)) return { rows: [], total: 0 };
    const params: unknown[] = [id];
    const src = caughtOf(method, params);
    params.push([...ctx.money]);
    let narrow = '';
    if (o.find !== null) {
      const f = findOf(o.find);
      // Hex only, so the pattern holds no wildcard but its own.
      if (f.kind === 'address') narrow = `AND s.address = ${binder(params)(f.address)}`;
      else if (f.kind === 'prefix') narrow = `AND s.address LIKE ${binder(params)(`${f.prefix}%`)}`;
      else return { rows: [], total: 0 };
    }
    const caught = `SELECT s.address, ${caughtColumns(method)} ${src.from} ${SIDES} WHERE ${src.where} ${narrow} GROUP BY s.address`;
    const caughtArgs = params.length;
    const judged = judgedOnly(method, ctx, params);
    // A page's wallets each side by its own index; every wallet at once in one pass over the collection.
    const counts = (rows: string | null) => rows === null
      ? `SELECT s.address, count(*)::int AS trades, extract(epoch FROM min(t.block_time))::float8 * 1000 AS at
         FROM washtrace.transfers t ${COUNTED_JOIN} ${SIDES} WHERE t.collection_id = $1${judged} GROUP BY s.address`
      : `SELECT t.address, count(*)::int AS trades, extract(epoch FROM min(t.block_time))::float8 * 1000 AS at FROM (
           SELECT c.address, t.collection_id, t.tx_hash, t.log_index, t.block_time FROM ${rows} c
           JOIN washtrace.transfers t ON t.collection_id = $1 AND t.from_address = c.address${judged}
           UNION ALL
           SELECT c.address, t.collection_id, t.tx_hash, t.log_index, t.block_time FROM ${rows} c
           JOIN washtrace.transfers t ON t.collection_id = $1 AND t.to_address = c.address AND t.from_address <> c.address${judged}) t
         ${COUNTED_JOIN} GROUP BY t.address`;
    const order = `${LIST_ORDER[o.sort === 'first' ? 'at' : o.sort]}, c.address`;
    const rows = await this.lensPage(params, caughtArgs, 'address', caught, counts, o.sort === 'share' || o.sort === 'first', order, 'c.address', o, isOwnKey(method));
    return {
      rows: rows.rows.map((r) => ({
        address: r.address, caught: r.caught, trades: r.trades, volumeWei: r.volume, firstAt: r.at, loops: r.loops, pairs: r.pairs, partners: r.wallets,
      })),
      total: rows.total,
    };
  }

  /**
   * One page of a lens list, keyed by column `key`. `caught` ranks every row
   * from the lens's flags alone, with the loops its trades point at. `counts`
   * gives the counted trades, and when, of the rows in a table it is named, or
   * of every row given null. An order that needs them reads them all, in one
   * pass over the collection, before the page is cut; otherwise only the
   * page's rows are read, after. So ten rows of a collection do not read all
   * of its trades. The loops are always read after. `self` is left out of a
   * wallet's own partners. A page past the last still counts the list, and a
   * limit of 0 reads the count alone. A saved lens (`own`) has no witnesses:
   * its loops are counted from its stored paths (ownLoopsOf). `caught` binds the first
   * `caughtArgs` of `params`, and the count sends only those: Postgres refuses
   * a value its text never names, as a lens's block bound only for `counts`.
   */
  private async lensPage(
    params: unknown[], caughtArgs: number, key: string, caught: string, counts: (rows: string | null) => string, early: boolean, order: string, self: string | null, o: ListOpts<string>, own: boolean,
  ): Promise<{ rows: any[]; total: number }> {
    const count = async () => (await this.withoutJit(`WITH caught AS (${caught}) SELECT count(*)::int AS total FROM caught`, params.slice(0, caughtArgs)))[0].total as number;
    if (o.limit === 0) return { rows: [], total: await count() };
    const ranked = `ranked AS (SELECT c.*, count(*) OVER ()::int AS total
      FROM ${early ? `(SELECT c.*, n.trades, n.at FROM caught c JOIN counts n USING (${key}))` : 'caught'} c
      ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2})`;
    const ctes = early ? [`caught AS (${caught})`, `counts AS (${counts(null)})`, ranked] : [`caught AS (${caught})`, ranked, `counts AS (${counts('ranked')})`];
    const n = early ? 'c' : 'n';
    const rows = await this.withoutJit(
      `WITH ${ctes.join(', ')}
       SELECT c.${key}::text AS ${key}, c.caught, c.volume::text AS volume, c.total, ${n}.trades, ${n}.at, s.*
       FROM ranked c ${early ? '' : `JOIN counts n USING (${key})`} ${own ? ownLoopsOf(key, self) : loopsOf(self)} ORDER BY ${order}`,
      [...params, o.limit, o.offset],
    );
    if (rows.length > 0 || o.offset === 0) return { rows, total: rows[0]?.total ?? 0 };
    return { rows, total: await count() };
  }

  /**
   * One read with JIT off, in its own read-only transaction. A lens list's
   * plan costs enough to switch JIT on, and at a million transfers compiling
   * it took 40-600 ms of a query that runs in under a second.
   */
  private async withoutJit(sql: string, params: unknown[]): Promise<any[]> {
    const c = await this.pool.connect();
    let finished = false;
    try {
      await c.query('BEGIN READ ONLY');
      await c.query('SET LOCAL jit = off');
      const { rows } = await c.query(sql, params);
      await c.query('COMMIT');
      finished = true;
      return rows;
    } finally {
      if (!finished) await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }

  /**
   * The collection's own history: its sales bucketed by when they happened,
   * with how many each method flags. The bucket fits the span read so far,
   * so a young collection is drawn by the day and an old one by the month.
   * Buckets are calendar periods in `zone`, the reader's, whatever the
   * server's own TimeZone: a day is the reader's day, and a month the
   * reader's month. A sale here is any transfer
   * with a marketplace fill; the analysis also drops custody round trips,
   * so a period's share can sit a little under the headline's. A transfer
   * whose block time the RPC did not return is left out, and counted in
   * `untimed` so the gap is said rather than hidden. A lens of yours in `own`
   * is counted from its own flags, and a sale past its `through` block is not
   * counted: its run has not judged it (Ruling FF).
   */
  async timeline(id: number, zone = 'UTC', own: readonly { lensId: number; through: number | null }[] = []): Promise<{ bucket: Bucket; untimed: number; readThrough: number | null; points: TimelinePoint[] }> {
    const span = await this.pool.query(
      `SELECT extract(epoch FROM max(block_time) - min(block_time))::float8 AS seconds, extract(epoch FROM max(block_time))::float8 * 1000 AS last,
              count(*) FILTER (WHERE block_time IS NULL)::int AS untimed
       FROM washtrace.transfers WHERE collection_id = $1`,
      [id],
    );
    const seconds: number = span.rows[0]?.seconds ?? 0;
    const day = 86_400;
    const bucket: Bucket = seconds > 730 * day ? 'month' : seconds > 120 * day ? 'week' : seconds > 4 * day ? 'day' : 'hour';
    const params: unknown[] = [id, bucket, zone];
    const mine = own.map((l) => {
      params.push(l.lensId);
      const flagged = `EXISTS (SELECT 1 FROM washtrace.lens_flags lf WHERE lf.collection_id = $1 AND lf.lens_id = $${params.length} AND lf.tx_hash = t.tx_hash AND lf.log_index = t.log_index)`;
      let bound = '';
      if (l.through !== null) {
        params.push(l.through);
        bound = ` AND t.block_number <= $${params.length}::bigint`;
      }
      return `,
              count(*) FILTER (WHERE t.marketplace IS NOT NULL AND ${flagged}${bound})::int AS l${l.lensId},
              count(*) FILTER (WHERE t.marketplace IS NOT NULL${bound})::int AS j${l.lensId}`;
    }).join('');
    const { rows } = await this.pool.query(
      `WITH f AS (
         SELECT tx_hash, log_index, bool_or(method = 'A') AS a, bool_or(method = 'AU') AS au, bool_or(method = 'AC') AS ac
         FROM washtrace.flags WHERE collection_id = $1 GROUP BY tx_hash, log_index)
       SELECT extract(epoch FROM date_trunc($2, t.block_time, $3))::float8 * 1000 AS at, count(*)::int AS transfers,
              count(*) FILTER (WHERE t.marketplace IS NOT NULL)::int AS sales,
              count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.a)::int AS a,
              count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.au)::int AS au,
              count(*) FILTER (WHERE t.marketplace IS NOT NULL AND f.ac)::int AS ac${mine}
       FROM washtrace.transfers t LEFT JOIN f ON f.tx_hash = t.tx_hash AND f.log_index = t.log_index
       WHERE t.collection_id = $1 AND t.block_time IS NOT NULL
       GROUP BY 1 ORDER BY 1`,
      params,
    );
    return {
      bucket,
      untimed: span.rows[0]?.untimed ?? 0,
      // The newest trade read. Past it the chain may be unread or merely quiet; the caller knows which.
      readThrough: span.rows[0]?.last ?? null,
      points: rows.map((r) => ({
        at: r.at, transfers: r.transfers, sales: r.sales,
        flaggedSales: { A: r.a, AU: r.au, AC: r.ac, ...Object.fromEntries(own.map((l) => [`L${l.lensId}`, r[`l${l.lensId}`] as number])) },
        ...(own.length > 0 ? { judgedSales: Object.fromEntries(own.map((l) => [`L${l.lensId}`, r[`j${l.lensId}`] as number])) } : {}),
      })),
    };
  }

  /** One token's transfers in chain order, each with the methods that flagged it. */
  async token(id: number, tokenId: string): Promise<FlaggedTransfer[]> {
    const { rows } = await this.pool.query(
      `${SELECT_TRANSFER}, ${FLAGS_AGG} ${TRANSFERS} WHERE t.collection_id = $1 AND t.token_id = $2::numeric ORDER BY t.block_number, t.log_index`,
      [id, tokenId],
    );
    return rows.map(toFlagged);
  }

  /** Flows between any two of `wallets`, for drawing the money edges beside a token's graph. */
  async flowsAmong(chainId: number, wallets: readonly string[], limit = 500): Promise<Flow[]> {
    const { rows } = await this.pool.query(
      `SELECT f.*, extract(epoch FROM f.block_time)::float8 AS bt FROM washtrace.flows f
       WHERE f.chain_id = $1 AND f.from_address = ANY($2) AND f.to_address = ANY($2) AND f.from_address <> f.to_address
       ORDER BY f.block_number LIMIT $3`,
      [chainId, wallets, limit],
    );
    return rows.map(toFlow);
  }

  /** A page of a wallet's transfers across every watched collection on its chain, newest first, as `filter` narrows them. */
  async walletTransfers(chainId: number, address: string, limit: number, offset: number, filter: WalletFilter = {}): Promise<FlaggedTransfer[]> {
    const params: unknown[] = [];
    const where = walletWhere(chainId, address, filter, params);
    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `${SELECT_TRANSFER}, ${FLAGS_AGG}, c.chain_id, c.address AS collection_address, c.name AS collection_name ${TRANSFERS}
       WHERE ${where} ORDER BY t.block_number DESC, t.log_index DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows.map(toFlagged);
  }

  /** How many transfers `walletTransfers` holds under `filter`, every page of them. */
  async walletTradeCount(chainId: number, address: string, filter: WalletFilter = {}): Promise<number> {
    const params: unknown[] = [];
    const where = walletWhere(chainId, address, filter, params);
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n ${TRANSFERS} WHERE ${where}`, params);
    return rows[0].n;
  }

  /** The watched collections a wallet traded in, busiest first: what its trades can be narrowed to. */
  async walletCollections(chainId: number, address: string): Promise<{ address: string; name: string | null; trades: number }[]> {
    const params: unknown[] = [];
    const { rows } = await this.pool.query(
      `SELECT c.address, c.name, count(*)::int AS trades ${TRANSFERS}
       WHERE ${walletWhere(chainId, address, {}, params)} GROUP BY c.address, c.name ORDER BY trades DESC, c.address`,
      params,
    );
    return rows.map((r) => ({ address: r.address, name: r.name, trades: r.trades }));
  }

  /** A page of who a wallet moved money with, in `sort`'s order; ties by address, so the pages never overlap. */
  async counterparties(chainId: number, address: string, limit: number, offset: number, sort: PartnerSort): Promise<{ address: string; flows: number; sent: number; received: number; watched: boolean }[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM (SELECT other, count(*)::int AS flows, count(*) FILTER (WHERE dir = 'out')::int AS sent, count(*) FILTER (WHERE dir = 'in')::int AS received,
              EXISTS (SELECT 1 FROM washtrace.wallets w WHERE w.chain_id = $1 AND w.address = other) AS watched
       ${PARTNERS_FROM} GROUP BY other) p ORDER BY ${PARTNER_ORDER[sort]}, p.other LIMIT $3 OFFSET $4`,
      [chainId, address, limit, offset],
    );
    return rows.map((r) => ({ address: r.other, flows: r.flows, sent: r.sent, received: r.received, watched: r.watched }));
  }

  /** How many wallets `counterparties` pages through. */
  async counterpartyCount(chainId: number, address: string): Promise<number> {
    const { rows } = await this.pool.query(`SELECT count(DISTINCT other)::int AS n ${PARTNERS_FROM}`, [chainId, address]);
    return rows[0].n;
  }

  /** A page of the payments between wallets `a` and `b`, newest first: `sent` are a's to b, `received` b's to a. */
  async flowsBetween(chainId: number, a: string, b: string, dir: FlowDir, limit: number, offset: number): Promise<Flow[]> {
    const { rows } = await this.pool.query(
      `SELECT f.*, extract(epoch FROM f.block_time)::float8 AS bt FROM washtrace.flows f WHERE ${betweenWhere(dir)}
       ORDER BY f.block_number DESC, f.tx_hash, f.kind, f.from_address, f.token, f.value_wei LIMIT $4 OFFSET $5`,
      [chainId, a, b, limit, offset],
    );
    return rows.map(toFlow);
  }

  /** How many payments `flowsBetween` pages through. */
  async flowsBetweenCount(chainId: number, a: string, b: string, dir: FlowDir): Promise<number> {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM washtrace.flows f WHERE ${betweenWhere(dir)}`, [chainId, a, b]);
    return rows[0].n;
  }

  async wallet(chainId: number, address: string): Promise<{ status: string; truncated: boolean; fetchedAt: number | null; transfers: number; error: string | null } | null> {
    const { rows } = await this.pool.query(
      `SELECT status, truncated, extract(epoch FROM fetched_at)::float8 AS fetched, transfers, error FROM washtrace.wallets WHERE chain_id = $1 AND address = $2`,
      [chainId, address],
    );
    const r = rows[0];
    return r ? { status: r.status, truncated: r.truncated, fetchedAt: r.fetched === null ? null : r.fetched * 1000, transfers: r.transfers, error: r.error } : null;
  }

  /** Every watched transfer in one transaction, flagged or not: the API's "is this sale a wash trade?". */
  async transaction(chainId: number, txHash: string): Promise<FlaggedTransfer[]> {
    const { rows } = await this.pool.query(
      `${SELECT_TRANSFER}, ${FLAGS_AGG}, c.chain_id, c.address AS collection_address, c.name AS collection_name ${TRANSFERS}
       WHERE c.chain_id = $1 AND t.tx_hash = $2 ORDER BY t.log_index`,
      [chainId, txHash],
    );
    return rows.map(toFlagged);
  }

  /**
   * The stored paths of the lenses `lensIds` on a token, one per flagged
   * transfer, in chain order. The caller keeps the lenses that ran.
   */
  async lensFlagsOfToken(id: number, tokenId: string, lensIds: readonly number[]): Promise<OwnFlag[]> {
    if (lensIds.length === 0) return [];
    const { rows } = await this.pool.query(
      `${OWN_FLAG} FROM washtrace.lens_flags f
       JOIN washtrace.transfers t ON t.collection_id = f.collection_id AND t.tx_hash = f.tx_hash AND t.log_index = f.log_index
       WHERE f.collection_id = $1 AND t.token_id = $2::numeric AND f.lens_id = ANY($3::int[])
       ORDER BY t.block_number, t.log_index, f.lens_id`,
      [id, tokenId, [...lensIds]],
    );
    return rows.map(toOwnFlag);
  }

  /**
   * Every lens's stored paths for a transaction, on every watched collection
   * it moved tokens of. The caller keeps each collection's lenses that ran.
   */
  async lensFlagsOfTx(chainId: number, tx: string): Promise<OwnFlag[]> {
    const { rows } = await this.pool.query(
      `${OWN_FLAG} FROM washtrace.lens_flags f
       JOIN washtrace.collections c ON c.id = f.collection_id
       WHERE c.chain_id = $1 AND f.tx_hash = $2 ORDER BY f.collection_id, f.log_index, f.lens_id`,
      [chainId, tx],
    );
    return rows.map(toOwnFlag);
  }

  /** A page of a collection's trades, as `q` asks and in its order. */
  async trades(id: number, q: TradeQuery, ctx: TradeContext, limit: number, offset: number): Promise<TradeRow[]> {
    const params: unknown[] = [];
    const sql = tradeSelect(id, q, ctx, params);
    params.push(limit, offset);
    const { rows } = await this.pool.query(`${sql} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return rows.map(toTrade);
  }

  /** How many trades `q` holds, and how many of them no analysis has judged yet. */
  async tradeCount(id: number, q: TradeQuery, ctx: TradeContext): Promise<{ total: number; unjudged: number }> {
    const params: unknown[] = [];
    const where = tradeWhere(id, q, ctx, params);
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE x.tx_hash IS NULL)::int AS unjudged ${TRADES_FROM} WHERE ${where}`,
      params,
    );
    return { total: rows[0].total, unjudged: rows[0].unjudged };
  }

  /**
   * Compare's counts over the sales of `ctx.ran`'s lenses. `both[r][c]` is the
   * sales r and c both caught (the diagonal is r's total); `not[r][c]` is the
   * sales r caught that c judged and did not, which differs from `both[r][r] -
   * both[r][c]` when c's run is behind (Ruling FF). Built on `tradeWhere` and
   * the Trades list's `lenses` column, so each is exactly `tradeCount` of the
   * query its link opens.
   */
  async compare(id: number, ctx: TradeContext): Promise<{ both: CompareCounts; not: CompareCounts }> {
    const params: unknown[] = [];
    const lenses = lensesColumn(ctx, params);
    const judged = judgedColumn(ctx, params);
    const where = tradeWhere(id, NO_FILTER, ctx, params);
    const { rows } = await this.pool.query(
      `WITH s AS (SELECT ${lenses} AS lenses, ${judged} AS judged ${TRADES_FROM} WHERE ${where})
       SELECT 'both' AS kind, a, b, count(*)::int AS n FROM s, unnest(s.lenses) a, unnest(s.lenses) b GROUP BY a, b
       UNION ALL
       SELECT 'not', a, b, count(*)::int FROM s, unnest(s.lenses) a, unnest(s.judged) b WHERE NOT b = ANY(s.lenses) GROUP BY a, b`,
      params,
    );
    const grid = (): CompareCounts => Object.fromEntries(ctx.ran.map((r) => [r, Object.fromEntries(ctx.ran.map((c) => [c, 0]))]));
    const out = { both: grid(), not: grid() };
    for (const r of rows) out[r.kind as 'both' | 'not'][r.a as LensKey]![r.b as LensKey] = r.n;
    return out;
  }

  /**
   * The trades `q` holds, split by `by`, with what each lens that ran caught
   * in each. Bands and months in order, marketplaces busiest first, and
   * unknown ('-': no facts yet, or none to give) last.
   */
  async tradeGroups(id: number, q: TradeQuery, by: TradeGroupBy, ctx: TradeContext): Promise<TradeGroup[]> {
    const params: unknown[] = [];
    const where = tradeWhere(id, q, ctx, params);
    const key = groupKey(by, ctx, params);
    // Joined, not probed per row as a filter is: a month's groups count every trade in the collection.
    const joins = ctx.ran.map((m, i) => {
      const src = flagSource(m, params, `c${i}`);
      return `LEFT JOIN ${src.from} ON c${i}.collection_id = t.collection_id AND ${src.where} AND c${i}.tx_hash = t.tx_hash AND c${i}.log_index = t.log_index`;
    });
    const caught = ctx.ran.map((_, i) => `, count(c${i}.tx_hash)::int AS c${i}`).join('');
    // A lens of yours judged only through its run's block: its denominator leaves out the trades past it (Ruling FF).
    const own = ctx.ran.flatMap((m, i) => (!isOwnKey(m) ? [] : [{ m, i, bound: judgedThrough(m, ctx, params) }]));
    const judged = own.map((o) => (o.bound === null ? '' : `, count(*) FILTER (WHERE ${o.bound})::int AS j${o.i}`)).join('');
    const { rows } = await this.pool.query(
      `SELECT * FROM (SELECT ${key} AS key, count(*)::int AS trades${caught}${judged} ${TRADES_FROM} ${joins.join(' ')} WHERE ${where} GROUP BY 1) g
       ORDER BY g.key = '-', ${by === 'marketplace' ? 'g.trades DESC, ' : ''}g.key`,
      params,
    );
    return rows.map((r) => ({
      key: r.key, trades: r.trades, caught: Object.fromEntries(ctx.ran.map((m, i) => [m, r[`c${i}`]])),
      ...(own.length === 0 ? {} : { judged: Object.fromEntries(own.map(({ m, i }) => [m, r[`j${i}`] ?? r.trades])) }),
    }));
  }

  /** Every trade `q` holds, in its order, streamed: the same rows as every page of `trades` put together. */
  tradeStream(id: number, q: TradeQuery, ctx: TradeContext): AsyncGenerator<TradeRow> {
    const params: unknown[] = [];
    return this.stream(tradeSelect(id, q, ctx, params), params, toTrade);
  }

  /**
   * What a search finds, by what was typed: each kind fetches `limit + 1` so
   * `more` can say it was cut. `only` reads one kind, for its own paged view.
   */
  async search(p: Parsed, opts: { limit?: number; offset?: number; only?: SearchKind } = {}): Promise<SearchHits> {
    const limit = opts.limit ?? 20;
    const want = (k: SearchKind) => opts.only === undefined || opts.only === k;
    const more: SearchHits['more'] = { collections: false, tokens: false, wallets: false, trades: false };
    const hits: SearchHits = { collections: [], tokens: [], wallets: [], trades: [], more };
    const cut = <T>(rows: T[], k: SearchKind): T[] => { more[k] = rows.length > limit; return rows.slice(0, limit); };
    const page = [limit + 1, opts.offset ?? 0];
    const collections = async (where: string, arg: string) => cut((await this.pool.query(
      `SELECT c.chain_id, c.address, c.name, c.symbol FROM washtrace.collections c WHERE ${where} ORDER BY c.name, c.id LIMIT $2 OFFSET $3`,
      [arg, ...page],
    )).rows.map((r) => ({ chainId: r.chain_id, address: r.address, name: r.name, symbol: r.symbol })), 'collections');
    // The wallet index leads with chain_id, and only a chain with a watched collection can hold a wallet.
    const wallets = async (where: string, arg: string) => cut((await this.pool.query(
      `SELECT chain_id, address, transfers FROM washtrace.wallets
       WHERE chain_id IN (SELECT DISTINCT chain_id FROM washtrace.collections) AND ${where}
       ORDER BY transfers DESC, chain_id, address LIMIT $2 OFFSET $3`,
      [arg, ...page],
    )).rows.map((r) => ({ chainId: r.chain_id, address: r.address, transfers: r.transfers })), 'wallets');

    // The kinds' queries are independent, and the sidebar asks as a person types: they run at once, not one after another.
    const asks: Promise<void>[] = [];
    if ((p.kind === 'text' || p.kind === 'token') && want('collections')) {
      // `%`, `_` and `\` are only themselves in what a person typed.
      const like = `%${p.text.replace(/[\\%_]/g, '\\$&')}%`;
      asks.push(collections('(c.name ILIKE $1 OR c.contract_name ILIKE $1 OR c.symbol ILIKE $1)', like).then((h) => { hits.collections = h; }));
    }
    if (p.kind === 'token' && want('tokens')) {
      // One index probe per collection: Postgres 17 has no skip scan over transfers_token_idx.
      asks.push(this.pool.query(
        `SELECT c.chain_id, c.address, c.name, x.n FROM washtrace.collections c CROSS JOIN LATERAL (
           SELECT count(*)::int AS n FROM washtrace.transfers t WHERE t.collection_id = c.id AND t.token_id = $1::numeric) x
         WHERE x.n > 0 ORDER BY x.n DESC, c.id LIMIT $2 OFFSET $3`,
        [p.tokenId, ...page],
      ).then(({ rows }) => { hits.tokens = cut(rows.map((r) => ({ chainId: r.chain_id, address: r.address, name: r.name, tokenId: p.tokenId, transfers: r.n })), 'tokens'); }));
    }
    if (p.kind === 'address') {
      if (want('collections')) asks.push(collections('c.address = $1', p.address).then((h) => { hits.collections = h; }));
      if (want('wallets')) asks.push(wallets('address = $1', p.address).then((h) => { hits.wallets = h; }));
    }
    if (p.kind === 'prefix') {
      // Hex has no `%` or `_`, so the prefix needs no escaping.
      if (want('collections')) asks.push(collections(`c.address LIKE $1 || '%'`, p.prefix).then((h) => { hits.collections = h; }));
      if (want('wallets')) asks.push(wallets(`address LIKE $1 || '%'`, p.prefix).then((h) => { hits.wallets = h; }));
    }
    if (p.kind === 'tx' && want('trades')) {
      asks.push(this.pool.query(
        `SELECT c.chain_id, t.tx_hash, c.address, c.name, t.token_id::text AS token_id ${TRANSFERS}
         WHERE t.tx_hash = $1 ORDER BY c.id, t.log_index LIMIT $2 OFFSET $3`,
        [p.tx, ...page],
      ).then(({ rows }) => { hits.trades = cut(rows.map((r) => ({ chainId: r.chain_id, txHash: r.tx_hash, address: r.address, name: r.name, tokenId: r.token_id })), 'trades'); }));
    }
    await Promise.all(asks);
    return hits;
  }

  // ---- worker passes ------------------------------------------------------

  async passStarted(job: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO washtrace.passes (job, started_at, heartbeat_at) VALUES ($1, now(), now())
       ON CONFLICT (job) DO UPDATE SET started_at = now(), heartbeat_at = now(), doing = NULL, subject_id = NULL`,
      [job],
    );
  }

  async passFinished(job: string, tookMs: number, outcome: 'ok' | 'failed', detail: string): Promise<void> {
    await this.pool.query(
      'UPDATE washtrace.passes SET finished_at = now(), took_ms = $2, outcome = $3, detail = $4 WHERE job = $1',
      [job, tookMs, outcome, detail],
    );
  }

  /** A pass says it is alive, what it is doing, and which collection that is. */
  async heartbeat(job: string, doing: string | null, subjectId: number | null): Promise<void> {
    await this.pool.query('UPDATE washtrace.passes SET heartbeat_at = now(), doing = $2, subject_id = $3 WHERE job = $1', [job, doing, subjectId]);
  }

  async passes(): Promise<PassRow[]> {
    const { rows } = await this.pool.query(
      `SELECT job, extract(epoch FROM started_at)::float8 AS s, extract(epoch FROM finished_at)::float8 AS f, took_ms, outcome, detail,
              extract(epoch FROM heartbeat_at)::float8 AS h, doing, subject_id
       FROM washtrace.passes ORDER BY job`,
    );
    return rows.map((r) => ({ job: r.job, startedAt: r.s * 1000, finishedAt: r.f === null ? null : r.f * 1000, tookMs: r.took_ms, outcome: r.outcome, detail: r.detail, heartbeatAt: r.h === null ? null : r.h * 1000, doing: r.doing, subjectId: r.subject_id }));
  }

  // ---- settings and checks ------------------------------------------------

  /**
   * Every setting saved from the console, secrets included. The worker reads
   * it to run; the settings API reads it to show what is set and a secret's
   * last 4, and never returns a secret's value.
   */
  async settings(): Promise<Map<string, string>> {
    const { rows } = await this.pool.query<{ key: string; value: string }>('SELECT key, value FROM washtrace.settings ORDER BY key');
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  /** Save a setting, or with null delete it so the default applies again. `actor` is who saved it. */
  async setSetting(key: string, value: string | null, actor: string): Promise<void> {
    if (value === null) {
      await this.pool.query('DELETE FROM washtrace.settings WHERE key = $1', [key]);
      return;
    }
    await this.pool.query(
      `INSERT INTO washtrace.settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, value, actor],
    );
  }

  /**
   * The worker says where each setting it uses came from, replacing what it
   * said last: a setting it no longer uses is gone from the report. A secret's
   * value and env are kept only when masked (they contain '••••'), else
   * blanked, whatever the caller passed, so no unmasked secret reaches a table
   * the API reads. Reports are taken one at a time: the
   * worker's three jobs start together and each reports, and two
   * delete-then-insert transactions at once collide on the key. EXCLUSIVE
   * still lets the API read the table meanwhile.
   */
  async reportSources(s: Record<string, SettingSource>): Promise<void> {
    const keys = Object.keys(s);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE washtrace.setting_sources IN EXCLUSIVE MODE');
      await c.query('DELETE FROM washtrace.setting_sources');
      if (keys.length > 0) {
        await c.query(
          `INSERT INTO washtrace.setting_sources (key, source, value, env_value, reported_at)
           SELECT k, src, v, e, now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS u(k, src, v, e)`,
          [keys, keys.map((k) => s[k]!.source), keys.map((k) => safe(k, s[k]!.value)), keys.map((k) => safe(k, s[k]!.env))],
        );
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** Where the worker last said each setting came from, and what .env held. A secret only masked. */
  async sources(): Promise<Record<string, SettingSource & { reportedAt: number }>> {
    const { rows } = await this.pool.query(
      'SELECT key, source, value, env_value AS env, extract(epoch FROM reported_at)::float8 AS reported FROM washtrace.setting_sources ORDER BY key',
    );
    return Object.fromEntries(rows.map((r) => [r.key, { source: r.source, value: r.value, env: r.env, reportedAt: r.reported * 1000 }]));
  }

  /**
   * Ask the worker to run a Test, and tell it at once. The insert and the
   * notify are one statement, so the notify goes out when the row is
   * committed and a woken worker always finds it. Returns the check's id,
   * which the console polls.
   */
  async requestCheck(kind: CheckKind, chainId: number | null): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `WITH i AS (INSERT INTO washtrace.checks (kind, chain_id) VALUES ($1, $2) RETURNING id)
       SELECT id, pg_notify($3, id::text) FROM i`,
      [kind, chainId, CHECKS_CHANNEL],
    );
    return Number(rows[0]!.id);
  }

  /** Checks requested and not yet finished, oldest first, each with how long ago it was asked for by the store's clock. */
  async pendingChecks(): Promise<{ id: number; kind: CheckKind; chainId: number | null; ageMs: number }[]> {
    const { rows } = await this.pool.query(
      `SELECT id, kind, chain_id, extract(epoch FROM now() - requested_at)::float8 * 1000 AS age_ms
       FROM washtrace.checks WHERE finished_at IS NULL ORDER BY id`,
    );
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind, chainId: r.chain_id, ageMs: Number(r.age_ms) }));
  }

  /**
   * Finish, unrun, every check asked for more than `olderThanMs` ago, with
   * `{ error: 'expired' }`. Its page stopped polling long since, and a URL
   * tested now may not be the one it asked about. Aged by the store's clock,
   * not the worker's. Returns how many.
   */
  async expireChecks(olderThanMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE washtrace.checks SET finished_at = now(), ok = false, detail = '{"error":"expired"}'
       WHERE finished_at IS NULL AND requested_at < now() - make_interval(secs => $1::float8 / 1000)`,
      [olderThanMs],
    );
    return rowCount ?? 0;
  }

  /** Record a check's result. `detail` is shown in the console, so it must never hold a URL or a key. */
  async finishCheck(id: number, ok: boolean, detail: Record<string, unknown>): Promise<void> {
    await this.pool.query('UPDATE washtrace.checks SET finished_at = now(), ok = $2, detail = $3 WHERE id = $1', [id, ok, JSON.stringify(detail)]);
  }

  /** One check as the console polls it, or null when there is no such check. */
  async check(id: number): Promise<{ finished: boolean; ok: boolean | null; detail: Record<string, unknown> | null } | null> {
    const { rows } = await this.pool.query('SELECT finished_at IS NOT NULL AS finished, ok, detail FROM washtrace.checks WHERE id = $1', [id]);
    const r = rows[0];
    return r ? { finished: r.finished, ok: r.ok, detail: r.detail } : null;
  }

  // ---- your own lenses ----

  async lenses(): Promise<Lens[]> {
    const { rows } = await this.pool.query(`${LENS_SELECT} ORDER BY l.id`);
    return rows.filter(readable).map(toLens);
  }

  async lens(id: number): Promise<Lens | null> {
    const { rows } = await this.pool.query(`${LENS_SELECT} WHERE l.id = $1`, [id]);
    return rows[0] ? toLens(rows[0]) : null;
  }

  /**
   * Save a lens, and queue its first run on collection `runOn` when given, in
   * one statement: a failure leaves neither, so a retry never finds the name
   * taken by a lens nobody saw saved. The caller has checked the rule and the
   * name; a name taken after all (a race) throws the unique index's error, and
   * a collection removed meanwhile the foreign key's.
   */
  async createLens(name: string, rule: LensRule, runOn?: number): Promise<Lens> {
    const { rows } = await this.pool.query(
      `WITH l AS (
         INSERT INTO washtrace.lenses (name, rule) VALUES ($1, $2) RETURNING id, name, rule, version, created_at, updated_at
       ), r AS (
         INSERT INTO washtrace.lens_runs (lens_id, collection_id, status, lens_version) SELECT id, $3, 'queued', version FROM l WHERE $3::int IS NOT NULL
       )
       SELECT id, name, rule, version, extract(epoch FROM created_at)::float8 AS created, extract(epoch FROM updated_at)::float8 AS updated FROM l`,
      [name, JSON.stringify(rule), runOn ?? null],
    );
    return toLens(rows[0]);
  }

  /**
   * Edit a lens: its version moves, and every run of it is queued again in the
   * same statement. A run of the old version still in flight then finds its
   * version behind (saveLensRun), and the totals it had stay on show until the
   * new run saves; its `lens_version` stays the one they came from (Ruling FF),
   * so a reader can tell they are the old rule's. `runOn` is a collection the
   * lens has no run on yet, queued in the same statement (as createLens does),
   * so an edit made from that collection's page runs there too: the editor's
   * button says it will. A failure, such as no such collection (23503), leaves
   * the lens as it was. Null when there is no such lens.
   */
  async updateLens(id: number, name: string, rule: LensRule, runOn?: number): Promise<Lens | null> {
    const { rows } = await this.pool.query(
      `WITH l AS (
         UPDATE washtrace.lenses SET name = $2, rule = $3, version = version + 1, updated_at = now() WHERE id = $1
         RETURNING id, name, rule, version, created_at, updated_at
       ), r AS (
         UPDATE washtrace.lens_runs SET status = 'queued', progress = NULL, error = NULL, failures = 0, retry_at = NULL, requested_at = now()
         FROM l WHERE lens_id = l.id
       ), n AS (
         -- A run already here is queued by r; the NOT EXISTS reads the rows as they were before this statement, so the two never touch one row.
         INSERT INTO washtrace.lens_runs (lens_id, collection_id, status, lens_version)
         SELECT id, $4, 'queued', version FROM l
         WHERE $4::int IS NOT NULL AND NOT EXISTS (SELECT 1 FROM washtrace.lens_runs x WHERE x.lens_id = l.id AND x.collection_id = $4)
         ON CONFLICT (lens_id, collection_id) DO NOTHING
       )
       SELECT id, name, rule, version, extract(epoch FROM created_at)::float8 AS created, extract(epoch FROM updated_at)::float8 AS updated FROM l`,
      [id, name, JSON.stringify(rule), runOn ?? null],
    );
    return rows[0] ? toLens(rows[0]) : null;
  }

  /** Its runs and flags go with it (cascade). False when there was none. */
  async deleteLens(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM washtrace.lenses WHERE id = $1', [id]);
    return rowCount === 1;
  }

  /** Whether a lens of yours, or a built-in, already has this name (ignoring case); `exceptId` is the lens being edited. */
  async nameTaken(name: string, exceptId?: number): Promise<boolean> {
    if (BUILT_IN_NAMES.some((n) => n.toLowerCase() === name.toLowerCase())) return true;
    const { rows } = await this.pool.query('SELECT 1 FROM washtrace.lenses WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2', [name, exceptId ?? null]);
    return rows.length > 0;
  }

  /**
   * Queue a run of the lens here (or again), keeping the totals of its last one
   * until the new one saves, and the version they came from (Ruling FF: only
   * saveLensRun moves it; a new row takes the lens's own, with no totals yet).
   * A run already running is left alone: queueing it would start a second one
   * beside it, and an edit requeues through updateLens.
   */
  async requestLensRun(lensId: number, collectionId: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO washtrace.lens_runs (lens_id, collection_id, status, lens_version)
       SELECT id, $2, 'queued', version FROM washtrace.lenses WHERE id = $1
       ON CONFLICT (lens_id, collection_id) DO UPDATE SET
         status = 'queued', progress = NULL, error = NULL, failures = 0, retry_at = NULL, requested_at = now()
       WHERE washtrace.lens_runs.status <> 'running'`,
      [lensId, collectionId],
    );
  }

  /** Every lens, with its run on this collection, or null when it has none here. */
  async lensRuns(collectionId: number): Promise<{ lens: Lens; run: LensRun | null }[]> {
    const { rows } = await this.pool.query(
      `SELECT l.id, l.name, l.rule, l.version, extract(epoch FROM l.created_at)::float8 AS created, extract(epoch FROM l.updated_at)::float8 AS updated,
              r.lens_id AS run_lens, r.collection_id, r.status, r.progress, r.lens_version, r.analysis_id, r.through_block, r.totals, r.error,
              extract(epoch FROM r.retry_at)::float8 AS retry, extract(epoch FROM r.finished_at)::float8 AS finished, r.took_ms
       FROM washtrace.lenses l
       LEFT JOIN washtrace.lens_runs r ON r.lens_id = l.id AND r.collection_id = $1
       ORDER BY l.id`,
      [collectionId],
    );
    return rows.filter(readable).map((r) => ({ lens: toLens(r), run: r.run_lens === null ? null : toLensRun(r) }));
  }

  /**
   * The next run that is due, on a collection that has an analysis (its latest
   * is what the run reads) and is not paused: a queued one, a done one whose
   * lens has since moved on, a done one whose analysis has moved on once
   * ANALYZE_GAP_MS (or twice its length, if longer) has passed since it
   * finished, a failed one past its back-off, or one still `running`. The gap
   * is Ruling AA's: a busy collection is analysed every five minutes, and
   * re-running each of K lenses on every one would hold the analysis lock
   * most of the time. An edit, Run here or a first run queues the run, and a
   * queued one never waits: queued runs go first, then the retries and the
   * re-runs, each oldest-requested first (Ruling OO), so one asked for is not
   * behind every re-run a newer analysis made due. `dueAt` is when the run
   * became due, for the lens pass's wait (Ruling KK): when it was asked for,
   * its retry time, the edit, or the later of the newer analysis and the gap's
   * end. `name` is the collection's name, or its short address.
   *
   * Two due runs are marked failed (with the usual back-off) instead of
   * returned, and the next due run is taken in the same call, so neither
   * holds the queue: one whose lens's stored rule no longer checks, and one
   * still `running`. Its only caller, the worker's lens pass, holds the
   * analysis lock (R8), so nothing else is running one: a `running` row seen
   * here was left by a worker that stopped mid-run, and a run that ran the
   * worker out of memory would stop the next one too (Ruling DD). After
   * LENS_TRIES failures in a row a run waits to be asked again.
   */
  async nextLensRun(now: number): Promise<{ lens: Lens; collectionId: number; chainId: number; name: string; analysisId: number; through: number | null; dueAt: number } | null> {
    for (;;) {
      const next = await this.dueLensRun(now);
      if (next === null || 'lens' in next) return next;
      await this.pool.query(`UPDATE washtrace.lens_runs SET ${LENS_FAILED} WHERE lens_id = $1 AND collection_id = $2`, [next.lensId, next.collectionId, next.error]);
    }
  }

  /** The next due run, as nextLensRun orders them, or the ids of one to fail instead, and why. */
  private async dueLensRun(now: number): Promise<{ lens: Lens; collectionId: number; chainId: number; name: string; analysisId: number; through: number | null; dueAt: number } | { lensId: number; collectionId: number; error: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT l.id, l.name AS lens_name, l.rule, l.version, extract(epoch FROM l.created_at)::float8 AS created, extract(epoch FROM l.updated_at)::float8 AS updated,
              c.id AS collection_id, c.chain_id, coalesce(c.name, left(c.address, 6) || '…' || right(c.address, 4)) AS name,
              a.id AS analysis_id, a.through_block, r.status,
              extract(epoch FROM CASE
                WHEN r.status IN ('queued', 'running') THEN r.requested_at
                WHEN r.status = 'failed' THEN r.retry_at
                WHEN r.lens_version < l.version THEN l.updated_at
                ELSE greatest(a.ran_at, r.finished_at + make_interval(secs => greatest($2::float8, 2 * coalesce(r.took_ms, 0)) / 1000))
              END)::float8 * 1000 AS due_at
       FROM washtrace.lens_runs r
       JOIN washtrace.lenses l ON l.id = r.lens_id
       JOIN washtrace.collections c ON c.id = r.collection_id AND c.paused_at IS NULL
       JOIN LATERAL (SELECT id, through_block, ran_at FROM washtrace.analyses x WHERE x.collection_id = c.id ORDER BY x.ran_at DESC, x.id DESC LIMIT 1) a ON true
       WHERE r.status IN ('queued', 'running')
          OR (r.status = 'done' AND (r.lens_version < l.version
            OR (r.analysis_id IS DISTINCT FROM a.id
              AND r.finished_at <= to_timestamp($1::float8 / 1000) - make_interval(secs => greatest($2::float8, 2 * coalesce(r.took_ms, 0)) / 1000))))
          OR (r.status = 'failed' AND r.retry_at <= to_timestamp($1::float8 / 1000))
       -- A 'running' row goes with the queued: it is failed in this same call, never run, so it holds no one back.
       ORDER BY r.status IN ('queued', 'running') DESC, r.requested_at LIMIT 1`,
      [now, ANALYZE_GAP_MS],
    );
    const r = rows[0];
    if (!r) return null;
    if (r.status === 'running') return { lensId: r.id, collectionId: r.collection_id, error: 'The worker stopped during this run.' };
    const checked = checkRule(r.rule);
    if ('error' in checked) return { lensId: r.id, collectionId: r.collection_id, error: `This lens's rule can't be read: ${checked.error}` };
    return {
      lens: toLens({ ...r, name: r.lens_name }), collectionId: r.collection_id, chainId: r.chain_id, name: r.name,
      analysisId: Number(r.analysis_id), through: r.through_block === null ? null : Number(r.through_block), dueAt: r.due_at,
    };
  }

  async lensRunStarted(lensId: number, collectionId: number): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.lens_runs SET status = 'running', progress = 0, started_at = now() WHERE lens_id = $1 AND collection_id = $2`,
      [lensId, collectionId],
    );
  }

  /** Only while it runs: an edit that queued it again leaves nothing to report on. */
  async lensRunProgress(lensId: number, collectionId: number, share: number): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.lens_runs SET progress = $3 WHERE lens_id = $1 AND collection_id = $2 AND status = 'running'`,
      [lensId, collectionId, share],
    );
  }

  /**
   * Note a failed run and when it is tried again (backoffSql), or that it is not,
   * after LENS_TRIES in a row. Only while it runs, so an edit's fresh queueing is not undone.
   */
  async lensRunFailed(lensId: number, collectionId: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.lens_runs SET ${LENS_FAILED} WHERE lens_id = $1 AND collection_id = $2 AND status = 'running'`,
      [lensId, collectionId, error],
    );
  }

  /**
   * Save a finished run: its flags replace the lens's here, in batches, and the
   * run reads done. 'stale' when the lens was edited since the run began: the
   * result is thrown away, the run is queued again at the new version and its
   * old totals stay. 'gone' when the lens (or the collection) was removed.
   */
  async saveLensRun(
    lensId: number, collectionId: number, lensVersion: number, analysisId: number, through: number | null,
    totals: LensTotals, flags: readonly LensFlag[], tookMs: number,
  ): Promise<'saved' | 'stale' | 'gone'> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // The collection's row, then the lens's, then the run's: removeCollection locks the collection before its
      // cascade reaches the run and the flags, and deleteLens and updateLens lock the lens before its runs (M1). A
      // delete or an edit then lands before this reads or after the run is saved, never in a deadlock with the
      // flags' foreign-key checks on those two rows. KEY SHARE is what that check takes, so the worker's updates of
      // the collection never wait on it. An edit after it queues the run again.
      const collection = await c.query('SELECT 1 FROM washtrace.collections WHERE id = $1 FOR KEY SHARE', [collectionId]);
      if (collection.rowCount === 0) { await c.query('ROLLBACK'); return 'gone'; }
      const lens = await c.query<{ version: number }>('SELECT version FROM washtrace.lenses WHERE id = $1 FOR SHARE', [lensId]);
      if (lens.rowCount === 0) { await c.query('ROLLBACK'); return 'gone'; }
      const run = await c.query('SELECT 1 FROM washtrace.lens_runs WHERE lens_id = $1 AND collection_id = $2 FOR UPDATE', [lensId, collectionId]);
      if (run.rowCount === 0) { await c.query('ROLLBACK'); return 'gone'; }
      if (lens.rows[0]!.version !== lensVersion) {
        // Its lens_version stays the one its old totals came from (Ruling FF).
        await c.query(
          `UPDATE washtrace.lens_runs SET status = 'queued', progress = NULL, requested_at = now() WHERE lens_id = $1 AND collection_id = $2`,
          [lensId, collectionId],
        );
        await c.query('COMMIT');
        return 'stale';
      }
      await c.query('DELETE FROM washtrace.lens_flags WHERE lens_id = $1 AND collection_id = $2', [lensId, collectionId]);
      for (let at = 0; at < flags.length;) {
        const batch: LensFlag[] = [];
        const paths: string[] = [];
        for (let size = 0; at < flags.length && batch.length < FLAG_BATCH_ROWS && size < FLAG_BATCH_CHARS; at++) {
          batch.push(flags[at]!);
          paths.push(JSON.stringify(flags[at]!.path));
          size += paths.at(-1)!.length;
        }
        await c.query(
          // Wallets go as one comma-joined text each (a text[] cannot nest in a text[]); addresses hold no comma.
          `INSERT INTO washtrace.lens_flags (collection_id, lens_id, tx_hash, log_index, path, wallets)
           SELECT $1, $2, tx, li, p, string_to_array(ws, ',') FROM unnest($3::text[], $4::int[], $5::jsonb[], $6::text[]) AS u(tx, li, p, ws)`,
          [collectionId, lensId, batch.map((f) => f.txHash), batch.map((f) => f.logIndex), paths, batch.map((f) => f.wallets.join(','))],
        );
      }
      await c.query(
        `UPDATE washtrace.lens_runs SET status = 'done', progress = NULL, lens_version = $3, analysis_id = $4, through_block = $5, totals = $6,
           error = NULL, failures = 0, retry_at = NULL, finished_at = now(), took_ms = $7
         WHERE lens_id = $1 AND collection_id = $2`,
        [lensId, collectionId, lensVersion, analysisId, through, JSON.stringify(totals), tookMs],
      );
      await c.query('COMMIT');
      return 'saved';
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) return 'gone';
      throw err;
    } finally {
      c.release();
    }
  }

  // ---- previews (P2–P5) ----

  /**
   * Queue a preview of `rule` on the collection and tell the worker at once:
   * the insert and the notify are one statement, as requestCheck's are. A
   * preview reads through the latest analysis's block (P3), so a collection
   * never analysed has nothing to preview yet, and one with no sale up to
   * that block nothing to sample: neither is queued, and the editor says why.
   */
  async requestPreview(collectionId: number, rule: LensRule): Promise<{ id: number } | 'no-sales' | 'not-analysed'> {
    const { rows } = await this.pool.query<{ sales: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM washtrace.transfers t WHERE t.collection_id = $1 AND t.marketplace IS NOT NULL
                        AND (a.through_block IS NULL OR t.block_number <= a.through_block)) AS sales
       FROM (SELECT through_block FROM washtrace.analyses WHERE collection_id = $1 ORDER BY ran_at DESC, id DESC LIMIT 1) a`,
      [collectionId],
    );
    if (rows.length === 0) return 'not-analysed';
    if (!rows[0]!.sales) return 'no-sales';
    try {
      const { rows: made } = await this.pool.query<{ id: number }>(
        `WITH i AS (INSERT INTO washtrace.lens_previews (collection_id, rule, status) VALUES ($1, $2, 'queued') RETURNING id)
         SELECT id, pg_notify($3, id::text) FROM i`,
        [collectionId, JSON.stringify(rule), PREVIEWS_CHANNEL],
      );
      return { id: made[0]!.id };
    } catch (err) {
      // Removed since it was read: there is nothing to preview on.
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) return 'not-analysed';
      throw err;
    }
  }

  /** One preview as the editor polls it, or null once it is swept or its collection removed. */
  async preview(id: number): Promise<Preview | null> {
    const { rows } = await this.pool.query(
      `SELECT id, collection_id, rule, status, progress, result, error,
              extract(epoch FROM requested_at)::float8 AS requested, extract(epoch FROM finished_at)::float8 AS finished
       FROM washtrace.lens_previews WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, collectionId: r.collection_id, rule: r.rule, status: r.status, progress: r.progress, result: r.result, error: r.error,
      requestedAt: r.requested * 1000, finishedAt: r.finished === null ? null : r.finished * 1000,
    };
  }

  /**
   * Take the oldest queued preview and mark it running, with what its run
   * reads: the latest analysis's through block (P3). `name` is the
   * collection's name, or its short address. Its only caller, the lens pass,
   * holds the analysis lock (R8), so no other preview is running: one still
   * `running` was left by a worker that stopped, and is failed here rather
   * than tried again, since one that ran the worker out of memory would do it
   * again (as Ruling DD has it for a run). One whose stored rule no longer
   * checks is failed, and the next taken in the same call.
   */
  async nextPreview(): Promise<{ id: number; collectionId: number; chainId: number; name: string; rule: LensRule; through: number | null } | null> {
    await this.pool.query(
      `UPDATE washtrace.lens_previews SET status = 'failed', progress = NULL, error = 'The worker stopped during this preview.', finished_at = now()
       WHERE status = 'running'`,
    );
    for (;;) {
      const { rows } = await this.pool.query(
        `SELECT p.id, p.collection_id, p.rule, c.chain_id, coalesce(c.name, left(c.address, 6) || '…' || right(c.address, 4)) AS name, a.through_block
         FROM washtrace.lens_previews p
         JOIN washtrace.collections c ON c.id = p.collection_id
         LEFT JOIN LATERAL (SELECT through_block FROM washtrace.analyses x WHERE x.collection_id = c.id ORDER BY x.ran_at DESC, x.id DESC LIMIT 1) a ON true
         WHERE p.status = 'queued' ORDER BY p.requested_at, p.id LIMIT 1`,
      );
      const r = rows[0];
      if (!r) return null;
      const checked = checkRule(r.rule);
      if ('error' in checked) {
        await this.previewEnded(r.id, 'failed', null, `This rule can't be read: ${checked.error}`, 'queued');
        continue;
      }
      await this.pool.query(`UPDATE washtrace.lens_previews SET status = 'running', progress = 0 WHERE id = $1`, [r.id]);
      return {
        id: r.id, collectionId: r.collection_id, chainId: r.chain_id, name: r.name, rule: checked.rule,
        through: r.through_block === null ? null : Number(r.through_block),
      };
    }
  }

  /**
   * Preview's sample (P4): up to PREVIEW_SAMPLE of the collection's sales
   * through block `through`, as `${txHash}:${logIndex}` keys, ordered by an
   * md5 of the key and `seed` (the preview's id). Seeded, so a preview reads
   * the same sample every time it is asked, and Round trips' catch is counted
   * of exactly it; with fewer sales, all of them.
   */
  async previewSample(collectionId: number, seed: number, through: number | null): Promise<string[]> {
    const { rows } = await this.pool.query<{ key: string }>(
      `SELECT t.tx_hash || ':' || t.log_index AS key FROM washtrace.transfers t
       WHERE t.collection_id = $1 AND t.marketplace IS NOT NULL AND ($3::bigint IS NULL OR t.block_number <= $3::bigint)
       ORDER BY md5(t.tx_hash || ':' || t.log_index || ':' || $2::int), t.tx_hash, t.log_index
       LIMIT $4`,
      [collectionId, seed, through, PREVIEW_SAMPLE],
    );
    return rows.map((r) => r.key);
  }

  /**
   * How many of `keys` (a preview's sample) Round trips flagged, or null when
   * it did not run on the latest analysis. The flags are that analysis's; the
   * analysis lock the lens pass holds (R8) keeps them from being replaced
   * while a preview reads through its block.
   */
  async roundTripsCaught(collectionId: number, keys: readonly string[]): Promise<number | null> {
    const cut = keys.map((k) => k.lastIndexOf(':'));
    const { rows } = await this.pool.query<{ ran: boolean | null; caught: number }>(
      `SELECT (SELECT a.totals -> 'A' ->> 'available' = 'true' FROM washtrace.analyses a WHERE a.collection_id = $1 ORDER BY a.ran_at DESC, a.id DESC LIMIT 1) AS ran,
              (SELECT count(*)::int FROM washtrace.flags f JOIN unnest($2::text[], $3::int[]) AS k(tx, li) ON f.tx_hash = k.tx AND f.log_index = k.li
               WHERE f.collection_id = $1 AND f.method = 'A') AS caught`,
      [collectionId, keys.map((k, i) => k.slice(0, cut[i])), keys.map((k, i) => Number(k.slice(cut[i]! + 1)))],
    );
    return rows[0]!.ran ? rows[0]!.caught : null;
  }

  /** Only while it runs, as lensRunProgress: a swept preview has nothing to report on. */
  async previewProgress(id: number, share: number): Promise<void> {
    await this.pool.query(`UPDATE washtrace.lens_previews SET progress = $2 WHERE id = $1 AND status = 'running'`, [id, share]);
  }

  async savePreview(id: number, result: PreviewResult): Promise<void> {
    await this.previewEnded(id, 'done', result, null, 'running');
  }

  /** `error` is shown in the editor, so it comes already scrubbed. */
  async previewFailed(id: number, error: string): Promise<void> {
    await this.previewEnded(id, 'failed', null, error, 'running');
  }

  /** Finish a preview that is `from`, done or failed. One swept or removed meanwhile stays gone. */
  private async previewEnded(id: number, status: 'done' | 'failed', result: PreviewResult | null, error: string | null, from: 'queued' | 'running'): Promise<void> {
    await this.pool.query(
      `UPDATE washtrace.lens_previews SET status = $2, progress = NULL, result = $3, error = $4, finished_at = now() WHERE id = $1 AND status = $5`,
      [id, status, result === null ? null : JSON.stringify(result), error, from],
    );
  }

  /** Delete every preview asked for more than PREVIEW_KEEP_MS before `now`, whatever its state. Returns how many. */
  async sweepPreviews(now: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM washtrace.lens_previews WHERE requested_at < to_timestamp($1::float8 / 1000) - make_interval(secs => $2::float8 / 1000)`,
      [now, PREVIEW_KEEP_MS],
    );
    return rowCount ?? 0;
  }
}

/**
 * ` AND` the bound that keeps a lens list's counted trades to those `method`
 * judged, for its rows' denominators (Ruling FF), or '' when it judged them all.
 */
function judgedOnly(method: LensKey, ctx: TradeContext, params: unknown[]): string {
  const judged = judgedThrough(method, ctx, params);
  return judged === null ? '' : ` AND ${judged}`;
}

const LENS_SELECT = `
SELECT l.id, l.name, l.rule, l.version, extract(epoch FROM l.created_at)::float8 AS created, extract(epoch FROM l.updated_at)::float8 AS updated
FROM washtrace.lenses l`;
/** Whether a row's stored rule still checks; a list leaves out the rows that don't. */
const readable = (r: any): boolean => !('error' in checkRule(r.rule));

/** A stored rule is checked on the way out: the routes check it on the way in, so one that fails is a corrupt row. */
function toLens(r: any): Lens {
  const checked = checkRule(r.rule);
  if ('error' in checked) throw new Error(`The rule of lens ${r.id} is corrupt: ${checked.error}`);
  return { id: r.id, key: `L${r.id}`, name: r.name, rule: checked.rule, version: r.version, createdAt: r.created * 1000, updatedAt: r.updated * 1000 };
}

function toLensRun(r: any): LensRun {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    lensId: r.run_lens, collectionId: r.collection_id, status: r.status, progress: r.progress, lensVersion: r.lens_version,
    analysisId: num(r.analysis_id), throughBlock: num(r.through_block), totals: r.totals, error: r.error,
    retryAt: r.retry === null ? null : r.retry * 1000, finishedAt: r.finished === null ? null : r.finished * 1000, tookMs: r.took_ms,
  };
}

const COLLECTION_SELECT = `
SELECT c.*, extract(epoch FROM c.added_at)::float8 AS added, extract(epoch FROM c.ingested_at)::float8 AS ingested,
       extract(epoch FROM c.error_at)::float8 AS errored, extract(epoch FROM c.served_at)::float8 AS served, extract(epoch FROM c.paused_at)::float8 AS paused,
       extract(epoch FROM c.stored_through_time)::float8 AS stored_through, extract(epoch FROM c.restore_retry_at)::float8 AS restore_retry,
       extract(epoch FROM c.analysis_retry_at)::float8 AS analysis_retry, extract(epoch FROM c.download_retry_at)::float8 AS download_retry,
       (SELECT count(*)::int FROM washtrace.transfers t WHERE t.collection_id = c.id) AS transfer_count,
       a.id AS analysis_id, a.took_ms, a.through_block, a.totals, a.missing_data, a.funded_wallets, a.wallets, a.truncated_searches, a.loops,
       extract(epoch FROM a.ran_at)::float8 AS ran
FROM washtrace.collections c
LEFT JOIN LATERAL (SELECT * FROM washtrace.analyses x WHERE x.collection_id = c.id ORDER BY x.ran_at DESC LIMIT 1) a ON true`;

/**
 * A followed wallet everyone's runs read: within `hops` (a query parameter)
 * out on the chain (Store.followedFor). Depth 1 at least (Ruling S40): a
 * money trail's import writes its followed wallets at depth 1, and an install
 * running on one with follow.hops 0 read them before reach decided this.
 */
const FOLLOWED_NEAR = (hops: string) => `depth > 0 AND depth <= greatest(${hops}, 1)`;

/**
 * Which wallets funding serves, for fundingLanes and fundingBacklog alike, so
 * what is counted waiting is what gets checked. SERVED_LIVE: collection c is
 * not paused. SERVED_NAMES: c's transfers name wallet w, probed by index each
 * way, for a lane of one collection. servedWallet: the same question per
 * wallet, for the count: w is a trader some live collection on its chain
 * names, or a followed wallet (depth > 0) within `hops` (a query parameter)
 * on a chain where some collection is live, as fundingLanes gives followed
 * wallets a lane only then, or a wallet in the reach of a live collection
 * following past `hops` that those leave. SERVED_REACH: reach row r is
 * past `hops` out from its collection; at or within it, its wallet is the
 * followed lane's, so raising follow.hops hands it back, never checked
 * twice. That holds because stepReach lowers wallets.depth to what its walk
 * finds, so no wallet within `hops` of a collection sits deeper on the chain.
 */
const SERVED_LIVE = 'c.paused_at IS NULL';
const SERVED_REACH = (hops: string) => `r.depth > ${hops}`;
const SERVED_NAMES = `(EXISTS (SELECT 1 FROM washtrace.transfers x WHERE x.collection_id = c.id AND x.from_address = w.address)
  OR EXISTS (SELECT 1 FROM washtrace.transfers x WHERE x.collection_id = c.id AND x.to_address = w.address))`;
// By the wallet's own address, one probe each way, and only then whose
// transfers they are. Left to itself Postgres probes each live collection's
// index in turn, one probe per collection each way for a wallet none of them
// names: OFFSET 0 keeps it from folding the address lookup into that.
const namedLive = (side: 'from_address' | 'to_address') =>
  `EXISTS (SELECT 1 FROM (SELECT x.collection_id FROM washtrace.transfers x WHERE x.${side} = w.address OFFSET 0) x
     JOIN washtrace.collections c ON c.id = x.collection_id WHERE c.chain_id = w.chain_id AND ${SERVED_LIVE})`;
const servedWallet = (hops: string) =>
  `(CASE WHEN w.depth > 0 THEN w.depth <= ${hops} AND EXISTS (SELECT 1 FROM washtrace.collections c WHERE c.chain_id = w.chain_id AND ${SERVED_LIVE})
  ELSE ${namedLive('from_address')} OR ${namedLive('to_address')} END
  OR EXISTS (SELECT 1 FROM washtrace.reach r JOIN washtrace.collections c ON c.id = r.collection_id
             WHERE r.chain_id = w.chain_id AND r.address = w.address AND NOT r.stepped AND ${SERVED_LIVE} AND c.follow_hops > ${hops} AND ${SERVED_REACH(hops)}))`;

/**
 * The wallets `k.address` sent money to on chain `chain`, as `fund` queues
 * them: one row each, `p.address`, but itself and `exclude`, and none at all
 * when it paid more than `fanout`. Read by flows_moves_idx in payee order,
 * no further than one past the fanout, so a wallet paying thousands costs
 * what one paying 26 does. The one rule walkOut and seedReach step by.
 */
const paidBy = (chain: string, exclude: string, fanout: string) => `
  CROSS JOIN LATERAL (
    SELECT array_agg(s.to_address) AS paid FROM (
      SELECT DISTINCT f.to_address FROM washtrace.flows f
      WHERE f.chain_id = ${chain} AND f.from_address = k.address AND f.to_address <> k.address AND f.to_address <> ALL (${exclude}::text[])
      LIMIT ${fanout}::int + 1
    ) s
  ) s
  CROSS JOIN LATERAL unnest(CASE WHEN cardinality(s.paid) <= ${fanout} THEN s.paid END) AS p(address)`;

/**
 * Walk out from collection `id`'s traders over the stored flows, `depth`
 * sent-to steps, into the temporary table `walked` (address, depth): every
 * wallet reached, at its shallowest depth out from these traders. That is
 * this collection's depth, not wallets.depth, the chain's shallowest from
 * any collection's, so a wallet at chain depth 2 can be at 3 here. A step
 * takes a wallet's payees as `fund` would have queued them: only from one
 * checked to the end (done, not truncated), and only when it paid at least
 * one and at most `follow.fanout` wallets but itself and `follow.exclude`.
 * Depth 0 is the collection's transfer parties but `follow.exclude`, as
 * `traders` queues them. The walk a collection's next hop is counted by;
 * seedReach walks by the same step (paidBy), a chunk at a time, into reach.
 *
 * A level a statement, so no wallet comes to Node; each wallet's payees are
 * paidBy's. The cost is per wallet stepped from, so at most `cap` are, in
 * all: each level may take its share of what is left, split over the levels
 * still to walk, so a collection with more traders than the cap still walks
 * every level. A level with more wallets than that takes a sample of them,
 * and what it reaches is scaled up by its wallets over those it took
 * (`scale`, the product over every level cut; `cut` when any was). Infinity
 * walks them all.
 *
 * Runs in the caller's transaction, once: its end drops the table. It stops
 * by `until` (epoch ms; see timeLeft), failing the transaction. Gives
 * about how many wallets each depth holds, scaled as it was cut, depth 0 the
 * traders.
 */
async function walkOut(
  c: pg.PoolClient, id: number, chainId: number, depth: number, follow: Pick<Follow, 'fanout' | 'exclude'>, cap: number, until: number,
): Promise<{ counts: number[]; scale: number; cut: boolean }> {
  await c.query('CREATE TEMP TABLE walked (address text PRIMARY KEY, depth int NOT NULL) ON COMMIT DROP');
  await timeLeft(c, until);
  const traders = await c.query(
    `INSERT INTO walked (address, depth)
     SELECT a, 0 FROM (SELECT from_address AS a FROM washtrace.transfers WHERE collection_id = $1
                       UNION SELECT to_address FROM washtrace.transfers WHERE collection_id = $1) t
     WHERE a <> ALL ($2::text[])`,
    [id, follow.exclude],
  );
  const counts = [traders.rowCount ?? 0];
  // The wallets at depth $2 a step can follow out from.
  const steppable = `walked k JOIN washtrace.wallets w ON w.chain_id = $1 AND w.address = k.address AND w.status = 'done' AND NOT w.truncated
    WHERE k.depth = $2`;
  let scale = 1, cut = false, stepped = 0;
  for (let d = 0; d < depth; d++) {
    await timeLeft(c, until);
    const frontier = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${steppable}`, [chainId, d])).rows[0]!.n;
    const take = Math.min(frontier, Math.max(1, Math.floor((cap - stepped) / (depth - d))));
    const sampled = take < frontier;
    // A level not cut has no LIMIT (NULL): outside a snapshot a wallet checked
    // since the count would push one past it, dropped unsaid with nothing cut.
    // A cut one samples by md5, not address order: the lowest addresses are
    // vanity, bot and contract wallets, unlike the rest, and would skew the scale.
    // A payee already walked is nearer, or as near: ON CONFLICT keeps its depth.
    await timeLeft(c, until);
    const step = take === 0 ? null : await c.query(
      `INSERT INTO walked (address, depth)
       SELECT p.address, $2::int + 1 FROM (SELECT k.address FROM ${steppable} ${sampled ? 'ORDER BY md5(k.address)' : ''} LIMIT $5) k
       ${paidBy('$1', '$3', '$4')}
       ON CONFLICT (address) DO NOTHING`,
      [chainId, d, follow.exclude, follow.fanout, sampled ? take : null],
    );
    stepped += take;
    if (sampled) {
      scale *= frontier / take;
      cut = true;
    }
    counts.push((step?.rowCount ?? 0) * scale);
  }
  return { counts, scale, cut };
}

/**
 * Step from at most `limit` of collection `id`'s reach wallets checked since
 * they were added, shallowest first, out to its follow_hops (see
 * seedReach). One at the limit is marked stepped and not followed, so it
 * leaves reach_unstepped_idx; followFurther unmarks those when it raises
 * the limit, and a press while this step runs leaves them unmarked, as the
 * mark reads follow_hops afresh. Stepped is marked only where the depth is
 * still the one stepped from: one moved nearer in the same step is stepped
 * from again.
 *
 * A payee goes into wallets at the nearer of its sender's chain depth and
 * this walk's, plus one, and a wallet already there deeper is moved in to
 * it (Ruling S27): wallets.depth is the shallowest depth out from any
 * collection's traders, and a reach depth is one of those, so a wallet
 * within follow.hops for this collection is the followed lane's to check,
 * never left deeper where no lane serves it.
 *
 * Gives how many it stepped from, and `doneFar`: how many reach rows it
 * added, or moved nearer, past `globalHops` whose wallet is checked already,
 * for seedReach to bump the version by (Ruling S39).
 */
async function stepReach(c: pg.PoolClient, id: number, chainId: number, limit: number, globalHops: number): Promise<{ stepped: number; doneFar: number }> {
  const ownHops = (await c.query<{ follow_hops: number }>('SELECT follow_hops FROM washtrace.collections WHERE id = $1', [id])).rows[0]!.follow_hops;
  // To Node, at most `limit` rows: a call with nothing to step makes no temporary table.
  const { rows: k } = await c.query<{ address: string; depth: number; chain_depth: number; truncated: boolean }>(
    `SELECT r.address, r.depth, w.depth AS chain_depth, w.truncated FROM washtrace.reach r
     JOIN washtrace.wallets w ON w.chain_id = $2 AND w.address = r.address AND w.status = 'done'
     WHERE r.collection_id = $1 AND NOT r.stepped AND r.depth <= $3
     ORDER BY r.depth LIMIT $4`,
    [id, chainId, ownHops, limit],
  );
  if (k.length === 0) return { stepped: 0, doneFar: 0 };
  // A truncated wallet's money is not all read, so it is not followed (as `fund`), only marked.
  const from = k.filter((x) => !x.truncated && x.depth < ownHops);
  let doneFar = 0;
  if (from.length > 0) {
    const { exclude, fanout } = followOf(chainId, ownHops);
    await c.query(
      `CREATE TEMP TABLE paid ON COMMIT DROP AS
       SELECT p.address, min(k.depth) + 1 AS depth, min(least(k.chain_depth, k.depth)) + 1 AS chain_depth
       FROM unnest($4::text[], $5::int[], $6::int[]) AS k(address, depth, chain_depth) ${paidBy('$1', '$2', '$3')}
       GROUP BY p.address`,
      [chainId, exclude, fanout, from.map((x) => x.address), from.map((x) => x.depth), from.map((x) => x.chain_depth)],
    );
    // In address order, as every writer of wallets writes, so two never wait on each other in a circle. Only the
    // payees new to wallets or nearer than it says: DO UPDATE locks, and so dirties, every row it meets, its WHERE
    // false or not, and most are as near already. The WHERE still holds for one written since.
    await c.query(
      `INSERT INTO washtrace.wallets (chain_id, address, depth)
       SELECT $1, p.address, p.chain_depth FROM paid p
       WHERE NOT EXISTS (SELECT 1 FROM washtrace.wallets w WHERE w.chain_id = $1 AND w.address = p.address AND w.depth <= p.chain_depth)
       ORDER BY p.address
       ON CONFLICT (chain_id, address) DO UPDATE SET depth = EXCLUDED.depth WHERE washtrace.wallets.depth > EXCLUDED.depth`,
      [chainId],
    );
    // The rows it added or moved nearer past the global limit whose wallet is checked already (Ruling S39): the wallets
    // read by the statement before, as this one's snapshot is taken after it.
    doneFar = (await c.query<{ n: number }>(
      `WITH added AS (
         INSERT INTO washtrace.reach (collection_id, chain_id, address, depth) SELECT $1, $2, address, depth FROM paid ORDER BY address
         ON CONFLICT (collection_id, address) DO UPDATE SET depth = EXCLUDED.depth, stepped = false WHERE washtrace.reach.depth > EXCLUDED.depth
         RETURNING address, depth
       )
       SELECT count(*)::int AS n FROM added a JOIN washtrace.wallets w ON w.chain_id = $2 AND w.address = a.address
       WHERE a.depth > $3 AND w.status = 'done'`,
      [id, chainId, globalHops],
    )).rows[0]!.n;
  }
  await c.query(
    `UPDATE washtrace.reach r SET stepped = true FROM unnest($2::text[], $3::int[]) AS k(address, depth)
     WHERE r.collection_id = $1 AND r.address = k.address AND r.depth = k.depth
       AND (k.depth < $4 OR k.depth >= (SELECT follow_hops FROM washtrace.collections WHERE id = $1))`,
    [id, k.map((x) => x.address), k.map((x) => x.depth), ownHops],
  );
  return { stepped: k.length, doneFar };
}

/**
 * Add collection `id`'s traders not in its reach at depth 0 yet, or move one
 * found further out in to it: its transfer parties but the addresses never
 * followed, as walkOut starts. All in one statement, so the walk steps from
 * every trader's depth 0 before any depth 1, and steps from none twice; a
 * collection's traders are tens of thousands, a second or so. Only the
 * traders not at depth 0 already reach the insert, as in stepReach: DO
 * UPDATE locks, and so dirties, every row it meets, its WHERE false or not,
 * and once a day that would be every trader. The WHERE still holds for one
 * written since.
 */
async function addTraders(c: pg.PoolClient, id: number, chainId: number): Promise<number> {
  const { rowCount } = await c.query(
    `INSERT INTO washtrace.reach (collection_id, chain_id, address, depth)
     SELECT $1, $2, t.a, 0 FROM (SELECT from_address AS a FROM washtrace.transfers WHERE collection_id = $1
                                 UNION SELECT to_address FROM washtrace.transfers WHERE collection_id = $1) t
     WHERE t.a <> ALL ($3::text[])
       AND NOT EXISTS (SELECT 1 FROM washtrace.reach r WHERE r.collection_id = $1 AND r.address = t.a AND r.depth = 0)
     ORDER BY t.a
     ON CONFLICT (collection_id, address) DO UPDATE SET depth = 0, stepped = false WHERE washtrace.reach.depth > 0`,
    [id, chainId, followOf(chainId, 0).exclude],
  );
  return rowCount ?? 0;
}

/**
 * Give the transaction's next statement what is left until `until` (epoch
 * ms), so a run of statements stops by then in all: statement_timeout is
 * each statement's own. Past it, the next is given a millisecond, and fails.
 */
async function timeLeft(c: pg.PoolClient, until: number): Promise<void> {
  await c.query("SELECT set_config('statement_timeout', $1, true)", [`${Math.max(1, until - Date.now())}ms`]);
}

/** How many UTC days before a sale its floor looks back over. */
export const FLOOR_DAYS = 7;
/** Bump it whenever a fact's definition changes: an analysis then writes every trade fact again, not only the new ones. */
export const FACTS_VERSION = 1;

/** What a collection's trade facts are worked out with. Facts under another key can't be added to: each must be written again. */
function factsKey(money: ReadonlySet<string>): string {
  return `${FACTS_VERSION}/${FLOOR_DAYS}/${[...money].sort().join(',')}`;
}

/**
 * Replace a collection's trade facts: for every transfer up to `through`
 * (all of them when null), whether the analysis counted it, how long its
 * token had been still, how old its buyer was to the collection, and its
 * price over the median price of the seven UTC days before. All in SQL: a
 * collection is millions of rows, and none comes to Node. The uncounted keys
 * are the only thing sent in, in batches like the flags.
 *
 * Each ingest brings an analysis, so the facts are not all written each time.
 * When the ones on disk cover exactly the transfers through `prev`, the
 * previous analysis's cursor (null when its facts were worked out
 * otherwise), only the rows whose `counted` changed are written, and the
 * transfers past `prev` added. Otherwise they are all deleted and written
 * again.
 *
 * Change how `held_s`, `buyer_age_s` or `floor_ratio` is worked out here and
 * bump FACTS_VERSION (above factsKey), or old facts keep the old meaning.
 * `counted` needs no bump: it is re-checked every save.
 */
async function writeFacts(
  c: pg.PoolClient, id: number, uncounted: Analysis['uncounted'], through: number | null, money: ReadonlySet<string>, prev: number | null,
): Promise<void> {
  // Transfers are re-read here, not carried from analysisInput. A stored-data load adding rows below the cursor in between gets them counted = true, or no row at all if they land below `prev` after the count; the load bumps `version`, so the next analysis corrects it.
  // An older fact can stay: its token's last move, its buyer's first, and the week before its day are all older still, as ingest only appends past the cursor and block time rises with the block on every chain we read (Ethereum, Base). A row below `prev` that is new or gone since, as a load or restore leaves, breaks the equal count.
  const since = prev !== null && through !== null && through >= prev && (await c.query<{ covered: boolean }>(
    `SELECT (SELECT count(*) FROM washtrace.trade_facts WHERE collection_id = $1)
          = (SELECT count(*) FROM washtrace.transfers WHERE collection_id = $1 AND block_number <= $2::bigint) AS covered`,
    [id, prev],
  )).rows[0]!.covered ? prev : null;
  if (since === null) await c.query('DELETE FROM washtrace.trade_facts WHERE collection_id = $1', [id]);
  // Keyed, so the counted update probes it per fact when it is too big to hash, not scans it per fact.
  await c.query('CREATE TEMP TABLE uncounted (tx_hash text NOT NULL, log_index int NOT NULL, PRIMARY KEY (tx_hash, log_index)) ON COMMIT DROP');
  for (let at = 0; at < uncounted.length; at += FLAG_BATCH_ROWS) {
    const batch = uncounted.slice(at, at + FLAG_BATCH_ROWS);
    await c.query(
      'INSERT INTO uncounted SELECT * FROM unnest($1::text[], $2::int[])',
      [batch.map((u) => u.txHash), batch.map((u) => u.logIndex)],
    );
  }
  if (since !== null) {
    // A fact is wrong when it is counted and listed uncounted, or neither: only those are written.
    await c.query(
      `UPDATE washtrace.trade_facts x SET counted = NOT x.counted
       WHERE x.collection_id = $1
         AND x.counted = EXISTS (SELECT 1 FROM uncounted u WHERE u.tx_hash = x.tx_hash AND u.log_index = x.log_index)`,
      [id],
    );
  }
  // Every transfer through `through` is read either way: the new ones' last moves, first sightings and floors are in the old.
  // A change to how a fact below is worked out needs FACTS_VERSION bumped.
  await c.query(
    `WITH t AS (
       SELECT tx_hash, log_index, block_number, token_id, to_address, from_address, price_wei, currency, marketplace,
              extract(epoch FROM block_time)::float8 AS bt
       FROM washtrace.transfers WHERE collection_id = $1 AND ($2::bigint IS NULL OR block_number <= $2::bigint)
     ), seen AS (
       SELECT address, min(bt) AS bt FROM (SELECT from_address AS address, bt FROM t UNION ALL SELECT to_address, bt FROM t) x GROUP BY address
     ), sales AS (
       SELECT floor(bt / 86400)::int AS day, price_wei::float8 AS price FROM t
       WHERE marketplace IS NOT NULL AND price_wei IS NOT NULL AND currency = ANY($3::text[]) AND bt IS NOT NULL
     ), floors AS (
       -- A sale on day D sets the floor of days D+1..D+FLOOR_DAYS. Joined on the day, not on a range: a range is a nested loop.
       SELECT s.day + k AS day, percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price) AS floor
       FROM sales s CROSS JOIN generate_series(1, $4::int) k GROUP BY 1
     ), lagged AS (
       SELECT t.*, lag(bt) OVER (PARTITION BY token_id ORDER BY block_number, log_index) AS before FROM t
     )
     INSERT INTO washtrace.trade_facts (collection_id, tx_hash, log_index, counted, held_s, buyer_age_s, floor_ratio)
     SELECT $1, l.tx_hash, l.log_index, u.tx_hash IS NULL, round(l.bt - l.before)::bigint, round(l.bt - s.bt)::bigint,
            CASE WHEN l.price_wei IS NOT NULL AND l.currency = ANY($3::text[]) THEN l.price_wei::float8 / NULLIF(f.floor, 0) END
     FROM lagged l
     LEFT JOIN uncounted u ON u.tx_hash = l.tx_hash AND u.log_index = l.log_index
     LEFT JOIN seen s ON s.address = l.to_address
     LEFT JOIN floors f ON f.day = floor(l.bt / 86400)::int
     WHERE $5::bigint IS NULL OR l.block_number > $5::bigint`,
    [id, through, [...money], FLOOR_DAYS, since],
  );
}

// bigint and numeric columns arrive as strings; each is converted where it is read.
/** What a setting's report may keep: a secret only when it is masked, the store's own guard against its caller. */
function safe(key: string, shown: string | null): string | null {
  return SECRET_KEYS(key) && !shown?.includes('••••') ? null : shown;
}

function toFlow(r: any): Flow {
  return {
    txHash: r.tx_hash, kind: r.kind, from: r.from_address, to: r.to_address, valueWei: String(r.value_wei),
    token: r.token, blockNumber: Number(r.block_number), blockTime: r.bt,
  };
}

/** `id` apart: a collection's row carries its own `id`, and its latest analysis's as `analysis_id`. */
function toAnalysis(r: any, id: unknown): AnalysisRow {
  return {
    id: Number(id), ranAt: r.ran * 1000, tookMs: r.took_ms, throughBlock: r.through_block === null ? null : Number(r.through_block),
    totals: r.totals, missingData: r.missing_data, fundedWallets: r.funded_wallets, wallets: r.wallets, truncatedSearches: r.truncated_searches,
    loops: r.loops ?? null,
  };
}

function toCollection(r: any): CollectionRow {
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
    rules: r.rules ?? {},
    contract: r.described_at === null ? null : { name: r.contract_name, symbol: r.symbol, creator: r.creator, creationTx: r.creation_tx },
  };
}

/**
 * Insert transfers, keeping any already stored, and return the senders and
 * receivers of the ones that were new. Ingest and a load of stored data
 * share it.
 */
async function insertTransfers(c: pg.PoolClient, id: number, transfers: readonly Transfer[]): Promise<{ from: string; to: string }[]> {
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
 * money trail share it.
 */
async function insertFlows(c: pg.Pool | pg.PoolClient, chainId: number, flows: readonly Flow[]): Promise<void> {
  if (flows.length === 0) return;
  await c.query(
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
}

/** `statement`, run again in place up to three times when Postgres ends it to break a deadlock. Only for a statement that is safe to run twice. */
async function deadlockRetried<T>(statement: () => Promise<T>): Promise<T> {
  for (let retries = 0; ; retries++) {
    try {
      return await statement();
    } catch (err) {
      if (retries >= 3 || (err as { code?: unknown } | null)?.code !== DEADLOCK_DETECTED) throw err;
    }
  }
}

/**
 * A store error the data caused (class 22, a value it refuses; 23, a broken
 * constraint) as bad stored data, so a file whose sha256 matched but holds
 * such a value is noted once, not loaded and hashed again every pass. A row
 * whose collection went (a foreign key) is not the data's fault.
 */
function asDataFault(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || code === FOREIGN_KEY_VIOLATION || !(code.startsWith('22') || code.startsWith('23'))) return err;
  return new StoredDataError(`stored data holds a value the store refuses: ${(err as Error).message}`, 'unreadable');
}

/** How many times each address appears. */
function tally(addresses: readonly string[]): Map<string, number> {
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
async function queueWallets(c: pg.PoolClient, chainId: number, counts: ReadonlyMap<string, number>): Promise<void> {
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
