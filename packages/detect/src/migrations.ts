/**
 * Forward-only, numbered, idempotent. Index 0 is migration 001. A TypeScript
 * module rather than .sql files: the package builds with plain `tsc`, which
 * would not copy a .sql file into dist/. The only place in the product with DDL.
 */
export const MIGRATIONS: readonly string[] = [
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
];
