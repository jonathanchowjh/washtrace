# Upgrading

For operators. The schema is defined in one file, [migrations.ts](../packages/detect/src/migrations.ts):
36 migrations, forward-only, numbered from 1, each safe to run again.

## How a migration runs

- **Both services migrate at start.** The api (`apps/web/instrumentation.ts`) and the worker call
  `Store.migrate()`, under one advisory lock, so replicas starting together migrate once. The others wait for the
  lock, and each tries again if the store is not up yet. `npm run migrate` runs the same code by hand.
- **Most migrations are one transaction** that also records the version, so a failed one leaves nothing behind.
- **Two run outside a transaction**, #28 and #30. They use `CREATE INDEX CONCURRENTLY` and
  `DROP INDEX CONCURRENTLY`, which Postgres refuses inside one. The runner sends their statements one at a
  time, then records the version.
- **A plain `CREATE INDEX` holds a SHARE lock on its table** until it is done. Reads go on, but anything that
  writes the table waits: ingest, a load of stored data, deleting a collection. The migrations that build one on a
  table that already holds rows are marked in the table below. Reads wait too when the same migration first adds
  a column to that table: `ADD COLUMN` takes an ACCESS EXCLUSIVE lock, held until the migration commits, so it is
  held through the build. #3 does this on `wallets`, #23 on `flags`, and #34 on `wallets` and `token_reads`.
- **The worker does nothing until its migrate returns.** No pass starts before then. At tens of millions of
  transfers the indexes take minutes to build. The api serves while the migrations run.

## What each migration does

"Index at boot" names the indexes a migration builds and the table that holds them. `plain` is a
`CREATE INDEX`, which locks writes to a table with rows. `CONCURRENTLY` does not. An index on a table the same
migration creates is built empty, so it costs nothing and is not listed as a wait.

| # | What it does | Index at boot |
|---|---|---|
| 1 | Creates the schema and the first tables: `schema_version`, `collections`, `transfers`, `wallets`, `flows`, `analyses`, `flags`, `passes`. | On the new tables only: `transfers_token_idx`, `transfers_from_idx`, `transfers_to_idx`, `transfers_tx_idx`, `wallets_queue_idx`, `flows_from_idx`, `flows_to_idx`, `analyses_collection_idx`, `flags_tx_idx`. |
| 2 | `collections.rules`: a collection's overrides of the methods' rules. | |
| 3 | `wallets.depth`: how far a wallet is from the collections, so money can be followed through wallets that never traded. | `wallets_depth_queue_idx` on `wallets`, plain. |
| 4 | `collections.contract_name`, `symbol`, `creator`, `creation_tx`, `described_at`: what the contract says of itself. | |
| 5 | `collections.served_at`, `read_rate`, `priority`; `passes.heartbeat_at`, `doing`, `subject_id`: the worker takes turns across collections. | |
| 6 | Indexes for the funding lanes' "does a collection's transfers name this wallet" probe. | `transfers_coll_from_idx`, `transfers_coll_to_idx` on `transfers`, plain. Replaced by #24. |
| 7 | `collections.rules_at`: when a collection's rules last changed. | |
| 8 | `collections.paused_at`: a paused collection keeps its data and is left alone. | |
| 9 | Creates `settings`, `setting_sources` and `checks`: settings saved from the console, where the worker last said each came from, and Tests. | |
| 10 | `collections.restore_progress`, `restore_note`, `stored_through_time`: loading stored data. | |
| 11 | `collections.stored_through_block`. | |
| 12 | `collections.trail_imported_sha`, `trail_note`: a money trail loads once per sha256. | |
| 13 | Clears any stored `error` on `collections` and `wallets` that contains a URL, as it may hold an RPC key. | |
| 14 | `collections.restore_note_key`, `restore_failures`, `restore_retry_at`: a failed load is tried again once it can succeed. Trims an old suffix from existing notes. | |
| 15 | `collections.analysis_failures`, `analysis_error`, `analysis_retry_at`: a failed analysis stays on its collection until one is saved. | |
| 16 | `collections.download_file`, `download_progress`, `download_note`, `download_failures`, `download_retry_at`: downloading stored data from Hugging Face. | |
| 17 | `collections.trail_progress`: how far a money trail import has got. | |
| 18 | Deletes console settings that `.env` was shadowing (from here the console value wins), and adds `setting_sources.env_value`. | |
| 19 | Creates `trail_resume`: how many flows of a trail import are committed, so an interrupted import goes on from there. | |
| 20 | `collections.download_mismatch`: the URL of the last download whose bytes did not match the manifest. | |
| 21 | Prefix search over wallet addresses. | `wallets_address_prefix_idx` on `wallets`, plain. |
| 22 | Creates `trade_facts`: what each transfer of the latest analysis was, for the Trades table. | |
| 23 | Creates `witnesses`, adds `flags.witness_id` and `analyses.loops`. | `witnesses_wallets_idx` on the new `witnesses`; `flags_witness_idx` on `flags`, plain. |
| 24 | Prefix search over transfers' addresses within a collection. | `transfers_coll_from_prefix_idx`, `transfers_coll_to_prefix_idx` on `transfers`, plain, built before it drops #6's two. |
| 25 | Newest-first Trades pages without a sort. Queues every analyzed collection, none of whose analyses counted loops, for a new analysis. | `transfers_coll_time_desc_idx` on `transfers`, plain; then drops `transfers_coll_time_idx` if present. |
| 26 | `analyses.facts_key`: what the trade facts were worked out with, so only new facts are added when it is unchanged. | |
| 27 | Creates `lenses`, `lens_runs` and `lens_flags`: your own lenses. | On the new tables only: `lenses_name_idx`, `lens_runs_collection_idx`, `lens_flags_wallets_idx`, `lens_flags_lens_idx`. |
| 28 | A lens run reads a money edge back by its ends and block. | `flows_moves_idx` on `flows`, **CONCURRENTLY**. An invalid index of this name, left by a build that stopped, is dropped first. |
| 29 | Creates `lens_previews`. | `lens_previews_queued_idx` on the new table; `lens_flags_tx_idx` on `lens_flags`, plain. |
| 30 | Drops `flows_from_idx`: it is a prefix of #28's index, so it only cost writes. | `DROP INDEX CONCURRENTLY IF EXISTS`, no build. |
| 31 | `collections.follow_hops`, `follow_estimate`, `reach_seeded_at`, `count_tried_at`; creates `reach`: the wallets a collection's money has been walked to. | On the new `reach` table: `reach_wallet_idx`, `reach_unstepped_idx`. |
| 32 | Other tokens: creates `token_flows`, `token_reads`, `token_payees`; adds `collections.read_tokens_at`, `reach_hops`, `reach_stepped_at`, `traders_at`, `token_counts` and `lens_runs.tokens_read`; copies `follow_hops` into `reach_hops`. | |
| 33 | `collections.analysis_started_at`. | |
| 34 | Reading a trader again (`follow.reread`): adds `read_block bigint` and `stale_at timestamptz` to `wallets` and to `token_reads`. | `wallets_stale_idx` on `wallets` and `token_reads_stale_idx` on `token_reads`, both plain and partial (`WHERE stale_at IS NOT NULL`), so they hold no rows on upgrade. Each still scans its table, and the `ADD COLUMN`s before it hold an ACCESS EXCLUSIVE lock until commit, so reads of `wallets` and `token_reads` wait for the scans. |
| 35 | Spot checks: creates `spot_checks`, one row per transaction judged without watching its collection. | On the new table: `spot_checks_queued_idx`, `spot_checks_tx_idx` and the unique `spot_checks_open_idx`, built empty. |
| 36 | Rings: adds `witnesses.ring` and `analyses.rings`. Analyses saved before it have `rings` NULL; the worker works their rings out from the stored witnesses, one collection a turn, and analyses nothing again. | `witnesses_ring_idx` on `witnesses`, plain and partial (`WHERE ring IS NOT NULL`), so it holds no rows on upgrade, though it still scans the table. |

A wallet due a read again keeps `status = 'done'` and gets `stale_at` set, so every reader of a done wallet still
counts it. With `follow.reread` at 0, the default, nothing is marked and #34 changes no behaviour.

## What an upgrade changes for readers

- **The console's collection pages error until `analyses.loops` exists.** #23 adds the column and the pages read
  it, so a page opened between the api starting and #23 finishing fails.
- **Every analyzed collection is analyzed once more** when an upgrade passes #25. An analysis saved before loops
  were counted wrote no trade facts and no loops, so its trades read "not judged yet" until the worker has
  analyzed the collection again. A collection with any analysis that counted loops is left alone.
- **Errors stored with a URL are cleared** by #13, and console settings that `.env` shadowed are deleted by #18.

## Before a big upgrade

To skip the wait, build the indexes beforehand, with the services running. Postgres builds an index
`CONCURRENTLY` while writes carry on, though not inside a transaction, so run each statement on its own in
`psql`. These are the ones #21, #24 and #25 build:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS wallets_address_prefix_idx ON washtrace.wallets (chain_id, address text_pattern_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS transfers_coll_from_prefix_idx ON washtrace.transfers (collection_id, from_address text_pattern_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS transfers_coll_to_prefix_idx ON washtrace.transfers (collection_id, to_address text_pattern_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS transfers_coll_time_desc_idx ON washtrace.transfers (collection_id, block_time DESC NULLS LAST);
```

The names and definitions are the ones in migrations.ts, so the migrations find them there and skip them
(`IF NOT EXISTS`).

- **Some indexes cannot be built first.** `flags_witness_idx` (#23) and the two stale indexes (#34) need a column
  the migration adds, so they are built during the upgrade. #34's are partial and empty on upgrade, but they
  still scan their table once.
- **#28 and #30 are already `CONCURRENTLY`.** Writes to `flows` carry on while `flows_moves_idx` builds, but the
  migration lock is held for the build: at about 69 million rows in `flows`, migrations.ts puts it at ten
  minutes and more, and a service that starts meanwhile waits for it.
- **A failed `CONCURRENTLY` build leaves an invalid index** behind under its name, which `IF NOT EXISTS` would
  take for done. Drop it and run the statement again. #28 does this itself for `flows_moves_idx`.
