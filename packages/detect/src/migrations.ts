/**
 * A migration the runner runs outside a transaction, one statement at a time,
 * then records: CREATE INDEX CONCURRENTLY runs no other way. Each statement
 * must be safe to run again, since a stop between them runs them all again.
 */
export interface Outside { outside: readonly string[] }

/**
 * Forward-only, numbered, idempotent. Index 0 is migration 001. A TypeScript
 * module rather than .sql files: the package builds with plain `tsc`, which
 * would not copy a .sql file into dist/. The only place in the product with
 * DDL. A string runs in one transaction with its version; an `Outside` does not.
 */
export const MIGRATIONS: readonly (string | Outside)[] = [
  `
CREATE SCHEMA IF NOT EXISTS washtrace;

CREATE TABLE IF NOT EXISTS washtrace.schema_version (
  version   int NOT NULL,
  singleton bool NOT NULL DEFAULT true UNIQUE CHECK (singleton)
);

CREATE TABLE IF NOT EXISTS washtrace.collections (
  id               serial PRIMARY KEY,
  chain_id         int NOT NULL,
  address          text NOT NULL,
  name             text,
  -- Null until the worker has found the deployment block.
  start_block      bigint,
  -- The last block fully ingested. Transfers and this move in one transaction.
  cursor_block     bigint,
  -- The finalized block when the worker last looked.
  head_block       bigint,
  added_at         timestamptz NOT NULL DEFAULT now(),
  ingested_at      timestamptz,
  error            text,
  error_at         timestamptz,
  -- Bumped by every write the analysis reads. The analysis records the
  -- version it read, so a write that lands mid-analysis is not lost.
  version          bigint NOT NULL DEFAULT 1,
  analyzed_version bigint NOT NULL DEFAULT 0,
  UNIQUE (chain_id, address)
);

CREATE TABLE IF NOT EXISTS washtrace.transfers (
  collection_id int NOT NULL REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  tx_hash       text NOT NULL,
  log_index     int NOT NULL,
  block_number  bigint NOT NULL,
  block_time    timestamptz,
  -- uint256: numeric so token ids sort as numbers.
  token_id      numeric(78, 0) NOT NULL,
  from_address  text NOT NULL,
  to_address    text NOT NULL,
  marketplace   text,
  price_wei     numeric(78, 0),
  currency      text,
  PRIMARY KEY (collection_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_token_idx ON washtrace.transfers (collection_id, token_id);
CREATE INDEX IF NOT EXISTS transfers_from_idx ON washtrace.transfers (from_address);
CREATE INDEX IF NOT EXISTS transfers_to_idx ON washtrace.transfers (to_address);
CREATE INDEX IF NOT EXISTS transfers_tx_idx ON washtrace.transfers (tx_hash);

-- A wallet is per chain, not per collection: its funding is read once.
CREATE TABLE IF NOT EXISTS washtrace.wallets (
  chain_id   int NOT NULL,
  address    text NOT NULL,
  -- Transfers it took part in. The funding queue reads busiest first.
  transfers  int NOT NULL DEFAULT 0,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  truncated  bool NOT NULL DEFAULT false,
  fetched_at timestamptz,
  error      text,
  PRIMARY KEY (chain_id, address)
);
CREATE INDEX IF NOT EXISTS wallets_queue_idx ON washtrace.wallets (chain_id, status, transfers DESC);

CREATE TABLE IF NOT EXISTS washtrace.flows (
  chain_id     int NOT NULL,
  tx_hash      text NOT NULL,
  kind         text NOT NULL,
  from_address text NOT NULL,
  to_address   text NOT NULL,
  value_wei    numeric(78, 0) NOT NULL,
  token        text NOT NULL,
  block_number bigint NOT NULL,
  block_time   timestamptz NOT NULL,
  -- A flow between two watched wallets is read from both sides; it is one edge.
  PRIMARY KEY (chain_id, kind, tx_hash, from_address, to_address, token, value_wei)
);
CREATE INDEX IF NOT EXISTS flows_from_idx ON washtrace.flows (chain_id, from_address);
CREATE INDEX IF NOT EXISTS flows_to_idx ON washtrace.flows (chain_id, to_address);

CREATE TABLE IF NOT EXISTS washtrace.analyses (
  id                 bigserial PRIMARY KEY,
  collection_id      int NOT NULL REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  ran_at             timestamptz NOT NULL DEFAULT now(),
  took_ms            int NOT NULL,
  through_block      bigint,
  totals             jsonb NOT NULL,
  missing_data       double precision NOT NULL,
  funded_wallets     int NOT NULL,
  wallets            int NOT NULL,
  truncated_searches int NOT NULL
);
CREATE INDEX IF NOT EXISTS analyses_collection_idx ON washtrace.analyses (collection_id, ran_at DESC);

-- The latest analysis's flags only; each analysis replaces them.
CREATE TABLE IF NOT EXISTS washtrace.flags (
  collection_id int NOT NULL REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  method        text NOT NULL CHECK (method IN ('A', 'AU', 'AC')),
  tx_hash       text NOT NULL,
  log_index     int NOT NULL,
  witness       jsonb NOT NULL,
  PRIMARY KEY (collection_id, method, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS flags_tx_idx ON washtrace.flags (tx_hash);

-- One row per worker job: what the worker page shows.
CREATE TABLE IF NOT EXISTS washtrace.passes (
  job         text PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  took_ms     int,
  outcome     text,
  detail      text
);
`,
  `
-- A collection's overrides of the methods' RULES. Only the keys set here;
-- the rest follow the defaults, so a changed default reaches every
-- collection that never chose otherwise.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS rules jsonb NOT NULL DEFAULT '{}';
`,
  `
-- How far a wallet is from the collections. 0: it traded a watched
-- collection. n: a wallet at n - 1 sent it money, and it is read so SCC AU
-- can follow a payment back through wallets that never traded. The queue
-- reads nearer wallets first, so following costs a collection nothing.
ALTER TABLE washtrace.wallets ADD COLUMN IF NOT EXISTS depth int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS wallets_depth_queue_idx ON washtrace.wallets (chain_id, status, depth, transfers DESC);
`,
  `
-- What the contract says of itself, read once by the worker: its own name
-- and symbol, and who deployed it (from Etherscan, when a key is set).
-- described_at is null until then.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS contract_name text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS symbol text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS creator text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS creation_tx text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS described_at timestamptz;
`,
  `
-- The worker takes turns across collections. served_at is when a collection
-- last had the worker's attention and read_rate how fast its chain was read
-- (blocks a second, smoothed), so the next turn goes to whoever waited
-- longest and a turn is sized to the time it should take. priority moves a
-- collection to the front. A pass says when it last proved it was alive,
-- what it is doing, and which collection that is.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS served_at timestamptz;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS read_rate double precision;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS priority boolean NOT NULL DEFAULT false;
ALTER TABLE washtrace.passes ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE washtrace.passes ADD COLUMN IF NOT EXISTS doing text;
ALTER TABLE washtrace.passes ADD COLUMN IF NOT EXISTS subject_id int;
`,  `
-- Funding lanes ask, for each unchecked wallet, whether a collection's
-- transfers name it. These make that two index probes, not a scan.
CREATE INDEX IF NOT EXISTS transfers_coll_from_idx ON washtrace.transfers (collection_id, from_address);
CREATE INDEX IF NOT EXISTS transfers_coll_to_idx ON washtrace.transfers (collection_id, to_address);
`,
  `
-- When a collection's rules last changed. Analyses are spaced out, but a
-- rule edited since the last one is analysed on the next pass: whoever
-- edited it is waiting to see the flags it gives.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS rules_at timestamptz;
`,
  `
-- A paused collection keeps its data and is left alone: the worker neither
-- reads it, analyses it nor checks its wallets until it is watched again.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS paused_at timestamptz;
`,
  `
-- Settings saved from the console. The worker reads them each pass; an
-- environment variable for the same key wins over them.
CREATE TABLE IF NOT EXISTS washtrace.settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Where each setting the worker uses came from, as the worker last said.
-- Only the worker knows its own environment, and the console locks a field
-- the environment sets. value is null for a secret: never kept here.
CREATE TABLE IF NOT EXISTS washtrace.setting_sources (
  key         text PRIMARY KEY,
  source      text NOT NULL CHECK (source IN ('env', 'console')),
  value       text,
  reported_at timestamptz NOT NULL
);

-- A Test pressed in the console. The API writes the request and notifies;
-- the worker, which alone calls chains, runs it and writes the result.
CREATE TABLE IF NOT EXISTS washtrace.checks (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('rpc', 'etherscan')),
  chain_id     int,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  ok           bool,
  detail       jsonb
);
`,
  `
-- Stored data (data/stored), loaded before the chain is read. While a load
-- runs, restore_progress says how far it has got (0 to 1), written outside
-- the load's transaction so the console sees it; null otherwise. A worker
-- that dies mid-load leaves it set, and the next worker to start clears it.
-- restore_note says why stored data could not be loaded: the worker reads
-- the chain instead, and does not try the stored data again. stored_through_time
-- is when the loaded data stops: how long a collection with no RPC is unsynced.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS restore_progress real;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS restore_note text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS stored_through_time timestamptz;
`,
  `
-- The block the loaded stored data stops at. Once the cursor is past it the
-- chain was read on from there, so with no RPC the collection stops at its
-- cursor, not at stored_through_time.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS stored_through_block bigint;
`,
  `
-- A money trail on disk loads by itself once its sha256 matches the manifest.
-- trail_imported_sha is the sha of the trail loaded for this collection, so a
-- file loads once, and a trail cut again loads again. trail_note says why a
-- trail on disk was not loaded; it is not tried again until the file changes.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS trail_imported_sha text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS trail_note text;
`,
  `
-- Errors written before the worker scrubbed them may hold an RPC URL with its
-- key, and the console shows them to every visitor; a paused collection's is
-- never overwritten. Any error with a URL in it goes: the next failure, if
-- any, says it again without one.
UPDATE washtrace.collections SET error = NULL WHERE error ~* '[a-z][a-z0-9+.-]*://';
UPDATE washtrace.wallets SET error = NULL WHERE error ~* '[a-z][a-z0-9+.-]*://';
`,
  `
-- A failed load of stored data is tried again once it can succeed, never
-- every pass. restore_note_key is what a load the data failed was about (the
-- manifest's sha256 and the file's stat, see storedKey): it is tried again
-- once that changes. A load the store failed (a full disk, a lost
-- connection) keeps no key and waits until restore_retry_at, five minutes
-- doubling with each of restore_failures in a row, up to an hour. Notes from
-- before lose "Reading from the chain instead": with no RPC nothing is, and
-- the console now says what follows.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS restore_note_key text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS restore_failures int NOT NULL DEFAULT 0;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS restore_retry_at timestamptz;
UPDATE washtrace.collections SET restore_note = replace(restore_note, ' Reading from the chain instead.', '') WHERE restore_note LIKE '% Reading from the chain instead.';
`,
  `
-- A failed analysis stays on its collection until one is saved, so the
-- console says so between passes and after a restart, not only while the
-- failed pass is the latest. analysis_error is why, scrubbed as every error
-- the console shows. The worker tries it again from analysis_retry_at: five
-- minutes, doubling with each of analysis_failures in a row, up to an hour.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS analysis_failures int NOT NULL DEFAULT 0;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS analysis_error text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS analysis_retry_at timestamptz;
`,
  `
-- The worker downloads a watched collection's stored data from Hugging Face
-- before it would load it, one file at a time across every replica. While one
-- runs, download_file says which ('transfers' or 'trail') and
-- download_progress how far, 0 to 1, so every replica and the console see it.
-- A failed download says why in download_note and waits until
-- download_retry_at, five minutes doubling with each of download_failures in a
-- row, up to an hour, as a failed load does; meanwhile its chain is read, if
-- it has an RPC.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS download_file text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS download_progress real;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS download_note text;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS download_failures int NOT NULL DEFAULT 0;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS download_retry_at timestamptz;
`,
  `
-- A money trail imports in the background, outside every pass: one of
-- millions of flows takes longer than an ingest pass may run. While one
-- imports, trail_progress says how far, 0 to 0.99, so every replica and the
-- console see it; the import's last statement sets it back to NULL.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS trail_progress real;
`,
  `
-- Until now .env beat a console value, so one could sit saved while .env
-- shadowed it. From here the console value wins. At this migration, before the
-- new worker's first report, the last report still says which console values
-- .env was shadowing; deleting them keeps behaviour unchanged across the upgrade.
DELETE FROM washtrace.settings s USING washtrace.setting_sources r WHERE r.key = s.key AND r.source = 'env';

-- The worker also reports what .env holds for each setting, as env_value, so
-- the console can offer it back. A secret is reported masked ('••••' plus its
-- last 4 characters), never itself: this replaces the earlier rule that value
-- is null for a secret. The store still drops a secret's value or env_value
-- that lacks '••••'.
ALTER TABLE washtrace.setting_sources ADD COLUMN IF NOT EXISTS env_value text;
`,
  `
-- How far a money trail import's flows got: the trail's sha and the count of
-- its flows committed, written with each batch of them. An import of the same
-- trail cut off (a restart, a stop) goes on from there instead of from the
-- first flow; the import's last statement deletes the row. A table of its own,
-- so writing it locks no collection row.
CREATE TABLE IF NOT EXISTS washtrace.trail_resume (
  collection_id int PRIMARY KEY REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  sha           text NOT NULL,
  flows         bigint NOT NULL
);
`,
  `
-- The URL of the last download whose bytes did not match the manifest's
-- sha256. A URL names one file at one publish: the same bytes would come
-- again, so no replica downloads it again, nor this one after a restart,
-- until the Hub publishes again and the URL changes. Never cleared: once the
-- URL changes it matches nothing.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS download_mismatch text;
`,
  `
-- The console's search finds wallets by the start of their address. The image's
-- collation is not C, so a prefix LIKE can only use an index built with
-- text_pattern_ops.
CREATE INDEX IF NOT EXISTS wallets_address_prefix_idx ON washtrace.wallets (chain_id, address text_pattern_ops);
`,
  `
-- What each transfer of the latest analysis was, for the console's Trades
-- table: whether the totals counted it, how long the token had sat since its
-- last move, how old the buyer was to the collection, and its price against
-- the week's floor. Written with the analysis, in its transaction, and only
-- for transfers up to its cursor: a transfer with no row here was not judged.
CREATE TABLE IF NOT EXISTS washtrace.trade_facts (
  collection_id int NOT NULL REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  tx_hash       text NOT NULL,
  log_index     int NOT NULL,
  counted       boolean NOT NULL,
  held_s        bigint,
  buyer_age_s   bigint,
  floor_ratio   double precision,
  PRIMARY KEY (collection_id, tx_hash, log_index)
);
`,
  `
-- Each loop once, with its wallets indexed: the console finds the loops a
-- wallet is in by containment, and a flag points at its loop by id. Written
-- with the analysis, in its transaction. \`loops\` on the analysis counts them
-- per lens; it is NULL on analyses saved before this.
CREATE TABLE IF NOT EXISTS washtrace.witnesses (
  collection_id int NOT NULL REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  id            int NOT NULL,
  kind          text NOT NULL,
  wallets       text[] NOT NULL,
  cycles        int,
  middle        text,
  PRIMARY KEY (collection_id, id)
);
CREATE INDEX IF NOT EXISTS witnesses_wallets_idx ON washtrace.witnesses USING gin (wallets);
ALTER TABLE washtrace.flags ADD COLUMN IF NOT EXISTS witness_id int;
CREATE INDEX IF NOT EXISTS flags_witness_idx ON washtrace.flags (collection_id, method, witness_id);
ALTER TABLE washtrace.analyses ADD COLUMN IF NOT EXISTS loops jsonb;
`,
  `
-- A Trades list's Find takes the start of a wallet address. The image's
-- collation is not C, so a prefix LIKE needs text_pattern_ops, and those
-- serve equality too: they replace the funding lanes' two indexes rather
-- than sit beside them, so the biggest table costs no more to write. Built
-- before the old ones go, so no moment is without one.
CREATE INDEX IF NOT EXISTS transfers_coll_from_prefix_idx ON washtrace.transfers (collection_id, from_address text_pattern_ops);
CREATE INDEX IF NOT EXISTS transfers_coll_to_prefix_idx ON washtrace.transfers (collection_id, to_address text_pattern_ops);
DROP INDEX IF EXISTS washtrace.transfers_coll_from_idx;
DROP INDEX IF EXISTS washtrace.transfers_coll_to_idx;
`,
  `
-- A Trades list is newest first with the untimed last, and block_time can be
-- null, so only an index in that order hands a page over without sorting the
-- collection. Date ranges and month groups read it as well as the old one,
-- which it replaces; built first, so no moment is without one.
CREATE INDEX IF NOT EXISTS transfers_coll_time_desc_idx ON washtrace.transfers (collection_id, block_time DESC NULLS LAST);
DROP INDEX IF EXISTS washtrace.transfers_coll_time_idx;
-- An analysis saved before loops were counted wrote no witness ids, and one
-- before that no trade facts: its trades all read "not judged yet" and its
-- groups find no loops. Such a collection is queued to be analysed again.
-- One with any analysis that counted loops is new enough.
UPDATE washtrace.collections c SET version = version + 1
WHERE c.analyzed_version > 0
  AND NOT EXISTS (SELECT 1 FROM washtrace.analyses a WHERE a.collection_id = c.id AND a.loops IS NOT NULL);
`,
  `
-- What the analysis's trade facts were worked out with: the facts' version,
-- the floor window and the money they price in. The next analysis adds only
-- the new facts when its own is the same, and writes them all again when not.
-- NULL on analyses saved before this, so their next one writes them all.
ALTER TABLE washtrace.analyses ADD COLUMN IF NOT EXISTS facts_key text;
`,
  `
-- Your own lenses. A lens is a rule the engine runs per
-- collection. Its version moves with each edit, so a run saved against an
-- older one is thrown away. A run keeps its last totals while it is queued
-- again, and its flags live apart from the built-ins' (flags.method stays as
-- it is). Everything of a lens goes with it, and with its collection.
CREATE TABLE IF NOT EXISTS washtrace.lenses (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  rule       jsonb NOT NULL,
  version    int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lenses_name_idx ON washtrace.lenses (lower(name));

CREATE TABLE IF NOT EXISTS washtrace.lens_runs (
  lens_id       int NOT NULL REFERENCES washtrace.lenses(id) ON DELETE CASCADE,
  collection_id int NOT NULL REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  progress      real,
  lens_version  int NOT NULL,
  analysis_id   bigint,
  through_block bigint,
  totals        jsonb,
  error         text,
  failures      int NOT NULL DEFAULT 0,
  retry_at      timestamptz,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  took_ms       int,
  PRIMARY KEY (lens_id, collection_id)
);
CREATE INDEX IF NOT EXISTS lens_runs_collection_idx ON washtrace.lens_runs (collection_id);

CREATE TABLE IF NOT EXISTS washtrace.lens_flags (
  collection_id int NOT NULL REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  lens_id       int NOT NULL REFERENCES washtrace.lenses(id) ON DELETE CASCADE,
  tx_hash       text NOT NULL,
  log_index     int NOT NULL,
  path          jsonb NOT NULL,
  wallets       text[] NOT NULL,
  PRIMARY KEY (collection_id, lens_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS lens_flags_wallets_idx ON washtrace.lens_flags USING gin (wallets);
CREATE INDEX IF NOT EXISTS lens_flags_lens_idx ON washtrace.lens_flags (lens_id);
`,
  {
    // A lens run reads back the hash and amount of each money edge it found by
    // the edge's ends and block (Store.moveTxs). By the sender alone, one busy
    // sender's whole history was read per edge. Built concurrently: on a live
    // install flows holds ~69M rows, ten minutes and more of building that
    // must not hold #27's lens tables back or stop writes to flows. A build
    // stopped part way leaves an INVALID index of this name, which IF NOT
    // EXISTS would take for done: it is dropped first and built again.
    // It leads with (chain_id, from_address), so it also serves every lookup
    // by the sender alone, which is why #30 drops flows_from_idx.
    outside: [
      `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'washtrace' AND c.relname = 'flows_moves_idx' AND NOT i.indisvalid) THEN
    DROP INDEX washtrace.flows_moves_idx;
  END IF;
END $$`,
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS flows_moves_idx ON washtrace.flows (chain_id, from_address, to_address, block_number)',
    ],
  },
  `
-- Preview: a lens tried on a sample before it is saved.
-- The editor queues a row and polls it; the worker's lens pass takes the
-- oldest queued one first. A row is kept an hour at most (the worker sweeps
-- it) and goes with its collection; a poll after either answers "gone".
CREATE TABLE IF NOT EXISTS washtrace.lens_previews (
  id            serial PRIMARY KEY,
  collection_id int NOT NULL REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  rule          jsonb NOT NULL,
  status        text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  progress      real,
  result        jsonb,
  error         text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS lens_previews_queued_idx ON washtrace.lens_previews (requested_at) WHERE status = 'queued';

-- The trade page reads your lenses' flags of one tx
-- (Store.lensFlagsOfTx). The key leads with collection and lens, so without
-- this every lens's entries on the chain were read to find it; the built-ins'
-- flags have flags_tx_idx for the same read.
CREATE INDEX IF NOT EXISTS lens_flags_tx_idx ON washtrace.lens_flags (tx_hash);
`,
  {
    // flows_from_idx (chain_id, from_address) is an exact prefix of
    // flows_moves_idx (#28), which serves any query it did, so on ~69M rows it
    // only cost writes and disk. Dropped concurrently, as #28 built the other:
    // no lock that stops writes to flows. IF EXISTS makes it a no-op on an
    // install that never had it; the runner records the version either way.
    outside: ['DROP INDEX CONCURRENTLY IF EXISTS washtrace.flows_from_idx'],
  },
  `
-- Data this lens needs: one collection follows its money further out
-- than follow.hops. follow_hops is its own hop limit, null for the global
-- one; the larger of the two wins, as a lower one would free nothing, the
-- wallets being the chain's. 10 is the most follow.hops itself may be.
-- Followed wallets belong to no collection, so reach lists the wallets a
-- collection's money has been walked to, each at its shallowest depth out
-- from that collection's own traders, which is not wallets.depth: that is
-- the shallowest from any collection's. The ones past the global limit are
-- what it follows further. It goes with its collection, and is read by
-- wallet too, when the wallet is checked. The walk goes over the flows
-- stored, a chunk a fund pass (Store.seedReach), and its rows are how far
-- it has got, so a pass goes on where the last stopped. stepped: what the
-- wallet sent is in the reach; a wallet still to check waits, unstepped,
-- in reach_unstepped_idx. reach_seeded_at: when the walk last found
-- nothing left to step, null until it has. follow_estimate is how
-- many wallets following one hop further would read, as the worker last
-- counted it (Store.countNext): a page only reads it, as counting is a walk.
-- count_tried_at: when a count was last tried, counted or not, so one that
-- runs out of time waits its turn behind the rest.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS follow_hops smallint CHECK (follow_hops BETWEEN 1 AND 10);
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS follow_estimate jsonb;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS reach_seeded_at timestamptz;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS count_tried_at timestamptz;
CREATE TABLE IF NOT EXISTS washtrace.reach (
  collection_id int NOT NULL REFERENCES washtrace.collections(id) ON DELETE CASCADE,
  chain_id      int NOT NULL,
  address       text NOT NULL,
  depth         smallint NOT NULL,
  stepped       bool NOT NULL DEFAULT false,
  PRIMARY KEY (collection_id, address)
);
CREATE INDEX IF NOT EXISTS reach_wallet_idx ON washtrace.reach (chain_id, address);
CREATE INDEX IF NOT EXISTS reach_unstepped_idx ON washtrace.reach (collection_id, depth) WHERE NOT stepped;
`,
  `
-- Other tokens: a short list of major tokens per chain
-- (TOKENS), read for one collection's wallets once it presses Start reading
-- (read_tokens_at). Their transfers have a table of their own, never flows,
-- so nothing that reads flows (the built-in lenses, the money follow, the
-- wallet pages, the published trail) changes. Every token edge is read by its
-- sender, so the key leads with it, then the ends and block a lens run reads
-- an edge back by; no index on recipients.
-- token_reads: each wallet's token read, chain-wide and apart from its money
-- check (wallets.status). fanout: how many wallets it sent listed tokens to,
-- capped at FOLLOW_FANOUT + 1, so a mass sender (an airdrop, a pool) is
-- known from its own read alone. token_payees: who a wallet read to the end,
-- with fanout within FOLLOW_FANOUT, paid in those tokens: kept whatever
-- tokens.payees says, which only chooses whether a trader's payees are read.
-- reach_hops: the limit a collection's walk was last walked to, so the walk
-- itself unmarks what it marked at a lower one (Store.seedReach); backfilled
-- for those that pressed Fetch them. reach_stepped_at: when the walk last
-- took a step for it, so collections take turns. traders_at: when a write
-- last added transfers, so a walk that read its traders before then is not
-- taken as seeded (Store.seedReach). token_counts: the token read's
-- progress, counted by the worker so a page only reads it.
-- lens_runs.tokens_read: the token reads a run took in, for 'behind'.
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS read_tokens_at timestamptz;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS reach_hops smallint;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS reach_stepped_at timestamptz;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS traders_at timestamptz;
ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS token_counts jsonb;
ALTER TABLE washtrace.lens_runs ADD COLUMN IF NOT EXISTS tokens_read int;
UPDATE washtrace.collections SET reach_hops = follow_hops WHERE reach_hops IS NULL AND follow_hops IS NOT NULL;
CREATE TABLE IF NOT EXISTS washtrace.token_flows (
  chain_id     int NOT NULL,
  tx_hash      text NOT NULL,
  from_address text NOT NULL,
  to_address   text NOT NULL,
  token        text NOT NULL,
  value_raw    numeric(78, 0) NOT NULL,
  block_number bigint NOT NULL,
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (chain_id, from_address, to_address, block_number, tx_hash, token, value_raw)
);
CREATE TABLE IF NOT EXISTS washtrace.token_reads (
  chain_id  int NOT NULL,
  address   text NOT NULL,
  status    text NOT NULL CHECK (status IN ('done', 'failed')),
  truncated bool NOT NULL DEFAULT false,
  fanout    smallint,
  error     text,
  read_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, address)
);
CREATE TABLE IF NOT EXISTS washtrace.token_payees (
  chain_id int NOT NULL,
  payer    text NOT NULL,
  payee    text NOT NULL,
  PRIMARY KEY (chain_id, payer, payee)
);
`,
  // When an analysis began and has not ended: a worker killed during one leaves it set, which the next worker counts as a failed try.
  `ALTER TABLE washtrace.collections ADD COLUMN IF NOT EXISTS analysis_started_at timestamptz;
`,
  `
-- Reading a trader again (follow.reread): its money (wallets) and its other
-- tokens (token_reads) keep status 'done' while due a read again, so every
-- reader of a done wallet (the analysis, the reach walk, the token set) still
-- counts it. read_block: the highest block its reads reached, so the next read
-- starts after it; null for a read with no rows, which starts again at 0.
-- stale_at: set when a trade comes in a while after its last read (Store.ingest),
-- the lanes serve it once it has passed, and a re-read that failed puts it an
-- hour on. Null for every wallet not due one, so the indexes stay small.
ALTER TABLE washtrace.wallets ADD COLUMN IF NOT EXISTS read_block bigint;
ALTER TABLE washtrace.wallets ADD COLUMN IF NOT EXISTS stale_at timestamptz;
ALTER TABLE washtrace.token_reads ADD COLUMN IF NOT EXISTS read_block bigint;
ALTER TABLE washtrace.token_reads ADD COLUMN IF NOT EXISTS stale_at timestamptz;
CREATE INDEX IF NOT EXISTS wallets_stale_idx ON washtrace.wallets (chain_id, stale_at) WHERE stale_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS token_reads_stale_idx ON washtrace.token_reads (chain_id, stale_at) WHERE stale_at IS NOT NULL;
`,
  `
-- A spot check: one transaction judged without watching its collection
-- (spot.ts). lens: null for the built-ins, else a key such as 'L7', at
-- lens_version, so an edited lens is asked again. result: the SpotResult.
CREATE TABLE IF NOT EXISTS washtrace.spot_checks (
  id           serial PRIMARY KEY,
  chain_id     int NOT NULL,
  tx_hash      text NOT NULL,
  lens         text,
  lens_version int,
  status       text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  result       jsonb,
  error        text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS spot_checks_queued_idx ON washtrace.spot_checks (requested_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS spot_checks_tx_idx ON washtrace.spot_checks (chain_id, tx_hash);
-- One check in flight per question, so two requests at once share it.
CREATE UNIQUE INDEX IF NOT EXISTS spot_checks_open_idx ON washtrace.spot_checks
  (chain_id, tx_hash, coalesce(lens, ''), coalesce(lens_version, 0)) WHERE status IN ('queued', 'running');
`,
  `
-- Rings (rings.ts): the wallets the counted evidence joins. Each witness a
-- counted lens points at gets its ring's anchor, the smallest wallet in it;
-- one only Money loops back points at gets none. analyses.rings counts them:
-- NULL on an analysis saved before this, which the worker fills from its
-- witnesses (Store.fillRings), so no collection is analysed again for it.
ALTER TABLE washtrace.witnesses ADD COLUMN IF NOT EXISTS ring text;
ALTER TABLE washtrace.analyses ADD COLUMN IF NOT EXISTS rings int;
CREATE INDEX IF NOT EXISTS witnesses_ring_idx ON washtrace.witnesses (collection_id, ring) WHERE ring IS NOT NULL;
`,
  {
    // A lens list counts each wallet's or token's counted trades by joining
    // its transfers to trade_facts on the key, AND counted (COUNTED_JOIN). At
    // a million transfers a page's 50 wallets made some 50,000 of those
    // lookups, each a heap fetch for one boolean. With only the counted rows'
    // keys in an index, the planner answers them from the index alone.
    // Built concurrently, as #28 built flows_moves_idx: writes to trade_facts
    // go on while it builds; an invalid one a stop left behind is dropped first.
    outside: [
      `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'washtrace' AND c.relname = 'trade_facts_counted_idx' AND NOT i.indisvalid) THEN
    DROP INDEX washtrace.trade_facts_counted_idx;
  END IF;
END $$`,
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS trade_facts_counted_idx ON washtrace.trade_facts (collection_id, tx_hash, log_index) WHERE counted',
    ],
  },
  `
-- A linked pair's shape (PairShape in types.ts): which way the money went
-- between its seller, its buyer and their middle. NULL on a witness saved
-- before this, and on every loop; a collection's next analysis writes it.
-- Nullable with no default, so adding it rewrites no row.
ALTER TABLE washtrace.witnesses ADD COLUMN IF NOT EXISTS shape text;
`,
  `
-- A ring's members that never traded are its pairs' middles: search finds them by the start of
-- their address. text_pattern_ops serves equality too. Partial: loops and direct pairs have none.
-- Not CONCURRENTLY: each analysis rewrites witnesses anyway, and the index is small.
CREATE INDEX IF NOT EXISTS witnesses_middle_idx ON washtrace.witnesses (middle text_pattern_ops) WHERE middle IS NOT NULL;
`,
];
