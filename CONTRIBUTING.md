# Contributing to washtrace

This is the guide for changing the code. To *run* washtrace, read the
[README](README.md) and [doc/operating.md](doc/operating.md). What each method
flags, on the demo's tokens, is in [doc/methods.md](doc/methods.md). The routes
are in [doc/api.md](doc/api.md), the tables and files a dataset user sees in
[doc/stored-data.md](doc/stored-data.md), and upgrading in
[doc/upgrading.md](doc/upgrading.md). Every environment variable
and console setting is in [doc/operating.md](doc/operating.md#settings);
[.env.example](.env.example) is the same list as a template.

## Setup

You need **Node 22.15 or newer**, **npm** and **Docker**. Docker runs the dev
Postgres and the integration tests. Unit and component tests run without it.

```sh
npm install
git config core.hooksPath .githooks          # one-time: the pre-commit hook below
npm run db:up                                # Postgres 17 on localhost:55433
export WASHTRACE_STORE_URL='postgres://postgres:secret@localhost:55433/washtrace'
export WASHTRACE_RPC_1='https://…'           # optional: any Ethereum JSON-RPC
export WASHTRACE_ETHERSCAN_KEY='…'           # optional: turns SCC AU and AC on
npm run dev                                  # the api and console: http://localhost:3000
npm run worker                               # the worker, in a second terminal
```

`npm run db:up` prints the store URL it started. `npm run db:down` removes the
container and `npm run db:psql` opens psql in it.

For a chain with a scripted market and no keys, run the Docker demo (see the
README). Its seeder, `scripts/demo/seed.mjs`, works against any anvil, so
`RPC=… API=http://localhost:3000 node scripts/demo/seed.mjs` seeds a dev
server too.

## Commands

Run from the repo root. `npm test` and the other test commands are the root
`package.json`'s; the rest of the table is each package's own script.

| Command | What it does | Needs Docker |
|---|---|---|
| `npm test` | The `unit` Vitest project: `packages/*/test/**/*.test.ts` (not `*.int.test.ts`), `apps/worker/test/**/*.test.ts` and `scripts/**/*.test.mjs`. It reads detect's source, so it needs no build. | No |
| `npm run test:int` | The `integration` project: `packages/**/test/**/*.int.test.ts`, the store against a real Postgres, one container per file. | Yes |
| `npm run test:web` | Builds `packages/detect`, then runs the `web` project (`apps/web/test`, jsdom). | No |
| `npm run test:watch` | Vitest in watch mode over every project. | Only for `*.int.test.ts` |
| `npm run typecheck:test` | `tsc -p tsconfig.test.json --noEmit`: `packages/*/src` and `test`, `apps/worker/src` and `test`, and `vitest.config.ts`. | No |
| `npm run --workspace @washtrace/detect typecheck` | The package's own `tsconfig.json`, no emit. | No |
| `npm run --workspace @washtrace/web typecheck` | The console, `tsc -p tsconfig.json --noEmit`. | No |
| `npm run --workspace @washtrace/worker typecheck` | The worker app, no emit. | No |
| `npm run --workspace @washtrace/detect build` | Compiles `packages/detect` to `dist/`. The web app and the scripts read that build, not the source. | No |
| `npm run --workspace @washtrace/web build` | Builds detect, then `next build`. | No |
| `npm run dev` | Builds detect, then `next dev` for the console and API. | Needs a store |
| `npm run worker` | Builds detect and the worker, then runs `apps/worker/dist/main.js`. | Needs a store |
| `npm run db:up`, `db:down`, `db:psql` | `scripts/dev-db.sh`: a throwaway Postgres 17 on port 55433. | Yes |
| `npm run migrate -- <store url>` | Builds the worker and migrates the store at that URL, and only that one. | Needs a store |
| `npm run stored -- <chainId>/<address> [--trail]` | Cuts a collection's stored data from a local store into `data/stored`. | Needs a store |
| `npm run publish:hub -- --store <url> [...]` | Publishes stored data to the Hub dataset. Reads `HF_TOKEN`, and a throwaway store from `scripts/publish-prep.sh`, never the live one. | Yes, for the prep script |

`apps/worker` also has `build`, `start` and `dev`, and `apps/web` has `start`;
the images run `node` directly (see the Dockerfile), so these are for local use.

### The pre-commit hook

[.githooks/pre-commit](.githooks/pre-commit) runs, in this order, stopping at
the first failure:

1. `npm run typecheck:test`
2. `npm run --workspace @washtrace/detect typecheck`
3. `npm test`
4. `npm run test:web`
5. `npm run --workspace @washtrace/web typecheck`
6. `npm run --workspace @washtrace/worker typecheck`

It does not run `npm run test:int` (Docker) or any build, so run `test:int`
by hand after a change to the store, and `npm run --workspace @washtrace/web
build` after a change to the console. `git commit --no-verify` skips the hook
for a checkpoint that does not typecheck yet.

### Dev-only environment variables

These are read by scripts, not by the product, and are not in the settings table
or `.env.example`.

| Variable | Read by | Meaning |
|---|---|---|
| `WASHTRACE_DEV_IMAGE`, `WASHTRACE_DEV_PORT` | `scripts/dev-db.sh` | The dev Postgres's image (default `postgres:17-alpine`) and host port (default 55433). |
| `WASHTRACE_PUBLISH_IMAGE`, `WASHTRACE_PUBLISH_PORT` | `scripts/publish-prep.sh` | The same for the publish throwaway (default `postgres:17-alpine`, port 55441). |
| `NFT70M_DIR` | `scripts/nft70m/extract.py`, `survey.mjs` | Where the NFT-70M data is kept. Default `~/washtrace-data/nft70m`. |
| `HF_HUB_DISABLE_XET` | the Hugging Face client under `extract.py` | Set to `1` if the download stalls at 0 bytes. |

The profiling scripts (`scripts/profile-analysis.mjs`, `profile-lens.mjs`,
`profile-preview.mjs`) take `WASHTRACE_STORE_URL` and a collection id; each
file's header says what it times and what it writes (`profile-lens` and
`profile-preview` are read-only; `profile-analysis` saves its analysis). They
read `packages/detect/dist`, so build detect first.

### NFT-70M survey

```bash
uv run scripts/nft70m/extract.py
npm run --workspace @washtrace/detect build && node scripts/nft70m/survey.mjs
```

The extract's default `--shards 10` downloads all 6.6 GB. If the download stalls at 0 bytes, `HF_HUB_DISABLE_XET=1` works around it.

It runs Round trips (SCC A) over the public NFT-70M dataset's Ethereum ERC-721 sales on OpenSea (identical repeated sales are kept once, since the dataset records some twice and a repeat reads as a round trip) and gives a share of sales flagged for every collection (anonymised IDs, so none can be named), plus how long `analyze()` takes on real collection sizes. Each share is an OpenSea-only figure: it is a share of OpenSea's sales, not of all sales. Sales on Blur, LooksRare and X2Y2 are missing, and the engine bridges each gap from the last buyer to the next seller, so a missing sale can hide a round trip or make one: a share can be off in either direction. Volume counts ETH and WETH sales only; a sale in another currency counts in sales but not in volume. With no money flows in the data, Money loops back and Linked wallets cannot run.
The dataset is CC BY-NC 4.0 (credit `MLNTeam-Unical/NFT-70M_transactions`): keep it and every output in `$NFT70M_DIR` (default `~/washtrace-data/nft70m`), never in the repo. Never match its rows to real transactions or collections; it was anonymised on purpose.

## The shape of the repo

```
packages/detect/          Everything that knows chains, money and graphs. No React, no HTTP.
  src/                    31 files, by concern:
    Types and the pure engine
      types.ts            Transfer, Flow, Method, Witness, Analysis
      graph.ts            The asset transfer graph of one token (AddressGraph); Tarjan; cycle counting
      methods.ts          SCC A, AU and AC over a collection: analyze() and its RULES
      marketplaces.ts     Venue addresses, custodians, wrapped native tokens; Seaport pricing
      wallets.ts          Wallets: addresses by number, held as bytes
      payments.ts         Payments: the money graph's payments as typed arrays
      moves.ts            Moves: the money edges between numbered wallets, in blocks
    Lenses
      lens-rule.ts        A lens's rule and its checks. Client-safe
      lens-reads.ts       What a collection has read for a rule. Client-safe
      lens.ts             runLens: the rule's search over a run's input
      trades.ts           Trade bands and the Trades list's words. Client-safe
      bytes.ts            A file's size as the Hub shows it. Client-safe, no imports
    Reading the world
      chain.ts            Chain: finalized head, transfer logs, receipts, deployment block
      etherscan.ts        Etherscan: who paid whom, per wallet, paced per key; token flows
      hub.ts              The Hugging Face manifest and file downloads
      stored.ts           Stored data: cutting, reading and checking the files
    The store
      store.ts            Store: every read and write of the washtrace schema
      store-rows.ts       Row mappers and the bulk writes ingest, funding and stored loads share
      reach.ts            Following money out of a wallet (the walk) and the SQL that serves wallets by it
      facts.ts            A collection's trade facts, written in SQL for an analysis's save
      trade-sql.ts        The SQL behind the Trades list and a trade's detail
      migrations.ts       The only DDL in the product
    The worker's parts
      worker.ts           Worker: the ingest, fund and analyze passes, and pickWork
      stored-sync.ts      StoredSync: the Hub's manifest, loads, trail imports, downloads
      locked-run.ts       LockedRun: watches the connection holding a lock while a run goes on
      checks.ts           Checks: the console's Test requests
      analysis-thread.ts  analyze() in a worker thread
      lens-thread.ts      A lens run or a preview in a worker thread
      spot.ts             SpotCheck: one transaction judged without watching its collection
    Shared
      env.ts              Every environment variable, read the same way by both services
      index.ts            The package entry
  test/                   *.test.ts is pure; *.int.test.ts starts Postgres; fixtures.ts is shared

apps/worker/              The worker service: a plain Node process, no Next.
  src/main.ts             Migrates, starts Worker's timers, serves /health, drains on SIGTERM
  src/migrating.ts        Migrating: the start-up migration, retried, and what /health says meanwhile
  src/migrate.ts          `npm run migrate`
  src/stored.ts           `npm run stored`: cut a collection's stored data
  src/publish.ts          Publisher: uploads stored data to the Hub
  src/publish-main.ts     `npm run publish:hub`
  test/                   Unit tests (the root `unit` project)

apps/web/                 The api service: the JSON API and the console, over the store.
  instrumentation.ts      Migrates the schema on boot; never reads a chain
  proxy.ts                Basic auth over every route but /api/health
  app/api/                The API: collections, lenses, search, settings, status, transfers, wallets, worker, health
  app/                    One folder per page: c (collection), tx, w (wallet), search, settings, worker; go is a redirect route
  components/             The console's React components
  lib/                    What pages and routes share: views.ts (reads a page and its route both serve), settings.ts, layout.ts (the token graph's layout), and so on
  test/                   Vitest with jsdom (the root `web` project)

scripts/
  demo/                   The local market: contracts, seeder, Etherscan stand-in
  nft70m/                 The NFT-70M survey: extract.py, survey.mjs, rows.mjs and its test
  profile-*.mjs           Time one analysis, lens run or preview on a real store
  dev-db.sh               `npm run db:*`
  publish-prep.sh         The throwaway store `npm run publish:hub` cuts from

doc/                      Reference pages: methods.md, console.md, operating.md, api.md, upgrading.md, stored-data.md
paper/                    The paper and its slides (PDF)
LICENSE, CITATION.cff     MIT for the code; how to cite the paper
.githooks/pre-commit      See the hook above
```

`packages/detect` depends on `pg` and `viem` and nothing else. The console
never builds a pool or writes SQL; it calls `Store` and renders what comes
back. `lens-rule.ts`, `lens-reads.ts`, `trades.ts` and `bytes.ts` are imported
by client components, so they and what they import stay free of `pg`, `viem`
and `node:*`.

## How a transfer becomes a verdict

Two processes share one Postgres. The worker's `Worker` runs three timers
(`EVERY` in `worker.ts`): ingest and analyze every minute, fund every 5
seconds. Each pass takes its job's advisory lock without waiting, so replicas
share the work, and a pass that is due while the last is still running is
skipped.

1. **Stored data** (`StoredSync`, driven first by `Worker.ingest`). Before any
   chain is read, ingest asks the Hub for its manifest (`askHub`), loads a
   collection's stored transfers (`restore`), imports a money trail (`trails`)
   and starts background downloads of files not yet on disk (`downloads`). A
   collection whose load or download is still to come is not read from the
   chain meanwhile. `Store.restore` and a trail import never mark a wallet to be
   read again.
2. **Ingest** (`Worker.ingest`). For each collection on a chain with an RPC,
   `readSpans` reads the ERC-721 `Transfer` logs from the cursor to the
   finalized head (`Chain.transfers`, spans that halve on a provider's refusal
   and grow back), and each span goes to `Store.ingest` in one transaction:
   the transfers (`insertTransfers`), the cursor, and the traders queued as
   wallets (`queueWallets`, in address order). The worker passes
   `followReread` as `Store.ingest`'s `rereadDays`. When it is above 0, the
   same transaction sets `stale_at` on the traders in the span whose money (or
   other-token) read is `done`, not `truncated`, has a `fetched_at` (or
   `read_at`) older than that many days, and is not already marked, in
   address order. At 0 nothing is marked.
3. **Fund** (`Worker.fund`). Per chain, in this order: `seedReach` walks a
   collection's reach one step at a time (`reach.ts`, within `SEED_MS`),
   queueing the wallets its traders' money went to, out to the collection's hop
   limit; the token pass
   (`readTokens`, below) for collections that pressed Start reading; then the
   money pass. The money pass asks `Store.moneyLanes` for up to 20 wallets per
   collection (plus a lane of followed wallets), and `interleave` checks them
   in turn. Within a lane the order is: pending, then wallets marked to be read
   again once `stale_at` has passed, then failed ones an hour after they failed;
   within each group, shallowest depth first, then the busiest. For
   each wallet `Store.rereadFrom` gives a start block when the wallet is
   marked (`read_block + 1 - REREAD_OVERLAP_BLOCKS`, floored at 0, so a day of
   blocks the last read may have missed is read again; 0 if it never had rows),
   and null for a full read;
   `Etherscan.flows` pages from there and returns `through`, the highest block
   it paged; `Store.saveMoney` writes the flows, clears `stale_at`, keeps the
   wallet `done`, queues the wallets it paid one hop further out (not past
   `FOLLOW_FANOUT`, judged on every flow stored for a re-read), and bumps the
   version of every collection the wallet or a counterparty traded in. A re-read
   that stores no new flow bumps no version. One that stores a new flow, and
   reads any flow out of the wallet, also clears `stepped` on the wallet's reach
   rows so the walk steps from it again. A read that fails calls
   `Store.moneyFailed`: a first read becomes `failed` and waits an hour; a
   marked wallet keeps its status, `fetched_at` and `read_block`, and is served
   again an hour later. An Etherscan key or quota refusal ends the pass.
   `readTokens` does the same for other tokens with `Store.tokenLanes` (never
   read first, then marked, then failed an hour on), `Etherscan.tokenFlows`,
   `Store.saveTokens` and `Store.tokensFailed`, and writes no collection's
   version. After every chain's money pass, `Store.countNext` and
   `Store.countTokens` count how far reading has got, for the console.
4. **Analyze** (`Worker.turn`, one job per pass under the analysis lock).
   `turn` finds out what is waiting (a preview from `Store.nextPreview`, a lens
   run from `Store.nextLensRun`, a collection due an analysis from
   `dueAnalysis`) and the pure function `pickWork` returns `'preview'`,
   `'analysis'`, `'run'` or `'nothing'`: a preview goes first, but not twice in
   a row while an analysis is due; a lens run gives way to a due analysis until
   it has waited `LENS_WAIT_MS` (10 minutes); then an analysis; then any run.
   Each runs in a worker thread so the main thread keeps ingesting and
   answering `/health`:
   - **Analysis** (`analyzeOne`): `analyzeInThread` starts
     `analysis-thread.ts`, which opens its own connection, reads the input
     (`Store.analysisInput`) and runs `analyze()`. The result is saved with
     `Store.saveAnalysis` against the collection `version` read before it ran,
     so a write that lands mid-analysis leaves the collection due again.
   - **Lens run or preview** (`lensRun`, `preview`): `runLensInThread` or
     `runPreviewInThread` start `lens-thread.ts`, which reads its own input
     (`Store.lensInput`) and runs `runLens`; a preview judges a sample of
     `PREVIEW_SAMPLE` (2,000) sales.
   Both thread starters take the pass's `AbortSignal`. If the worker loses the
   connection holding its lock, the thread is ended and the run is queued
   again, not counted as a failure. A thread running past an hour
   (`ANALYZE_TIMEOUT_MS`, `LENS_TIMEOUT_MS`) is ended too.
5. **Spot checks** (`Worker.spots`, in the fund pass: first, then between wallets). `POST /api/spots` queues a
   row (`Store.requestSpot`, shared while one is in flight by a unique index); `nextSpot` takes it, and
   `SpotCheck.run` reads the receipt (`Chain.receipt`), each token's history (`Chain.tokenTransfers`, its own span),
   the sellers' and buyers' money (`Store.moneyCovering` says which stored reads reach the block; the rest are read
   and saved), and the possible middles' money in memory only. It then runs `analyze()` per collection, or
   `runLens` on the transaction's trades, and `saveSpot` stores the `SpotResult`.
6. **The console and the API** read the store. Neither calls a chain.

## Design record

### The paper's methods, as code

- **The asset transfer graph** (paper §4.3) is `tokenGraph`. It sorts a token's
  transfers, connects sender to receiver, and bridges from the last receiver
  when the next sender differs. A bridge is never flagged and never counted,
  and the number of bridges over all ownership changes is the paper's
  missing-data share.
- **Cycle counting.** The paper counted back-edges against low-link values.
  washtrace uses the cyclomatic number E − V + 1 of each strongly connected
  component, which gives the same count, stays exact under parallel edges and
  self-loops, and leaves Tarjan unmodified. Tarjan is iterative, because a
  token traded ten thousand times is a ten-thousand-deep search.
- **SCC AU's depth-30 cut** is a breadth-first reach over the money graph,
  memoised per wallet and folded into each token's graph as one edge per
  reachable holder. The result is the same as running Tarjan over the combined
  graph, at a fraction of the cost.
- **SCC AC** follows the paper's Figure 8: any undirected money path of length
  one or two between a transfer's two wallets.

### The thresholds are data

`RULES` in `methods.ts` holds `minCycles`, `reachDepth`, `hubDegree` and
`visitCap`, and each one carries the sentence that justifies its number. A
collection can override any of them through its config route, and the
override is stored as only the keys it sets.

### `null` means "we could not look"

A method that needs funding and has none reports `available: false`, never 0%.
A price that cannot be read is `null`, never 0. A transaction washtrace has not
read is 404 from the API, never `washTrade: false`. One that is read but that no
analysis has covered yet (`judged: false`) answers `washTrade: null`. `washTrade`
counts Round trips and Linked wallets only; `methods` lists every lens that ran
and flagged it, Money loops back included.

### Two services, one store

The worker is its own process ([apps/worker](apps/worker)), and the api never
calls a chain. They share nothing but Postgres, so a slow backfill cannot slow
a page, and either can be restarted, scaled or redeployed alone. Each pass
takes its job's advisory lock without waiting, so N workers do one worker's
work. A pass that is due while the last one is still running is skipped, not
queued.

### Following money

`Store.saveMoney` queues the wallets a trader sent money to, one hop further
out, up to `WASHTRACE_FOLLOW_HOPS`. It never follows a wallet that paid more than
`FOLLOW_FANOUT` (25) others, nor a known contract. Traders are read before
followed wallets, so following never delays a collection's own funding.

## Conventions

- **Light OOP.** A class exists where several functions share the same state,
  and holds that state; everything else is a function. A test that needs a
  seam overrides a method on the instance, as `Worker.analyzeOff`,
  `lensOff`, `previewOff` and `etherscanClient` are overridden in
  `worker.test.ts`. No interfaces as design, no abstract classes, no
  dependency injection, no factories. One class per file.
- **Comments say why**: the constraint the code answers to, not what it does.
- **Addresses are lowercase; amounts are wei strings**, summed as bigint only
  where they are summed.
- **Relative imports end in `.js` in `packages/detect` and `apps/worker`** and
  have no extension in `apps/web`, as each toolchain requires.
- **One claim, one test.** A README sentence that states a property has a test
  that holds it.
- **Commit messages** follow `type(scope): summary`, such as
  `feat(detect): …` or `fix(web): …`.

### The classes

Every class in the product code, by file. The state it holds is what its
methods share.

| File | Class | Holds |
|---|---|---|
| `packages/detect/src/chain.ts` | `Chain` | Its viem clients and its adaptive span |
| `packages/detect/src/etherscan.ts` | `Etherscan` | A key, a URL and its pacing |
| `packages/detect/src/store.ts` | `Store` | The pool, its open-download count and test-tunable limits |
| `packages/detect/src/worker.ts` | `Worker` | The store, the config, the chain clients, the timers |
| `packages/detect/src/stored-sync.ts` | `StoredSync` | The Hub's manifest, file hashes, and the back-offs of loads, imports and downloads |
| `packages/detect/src/checks.ts` | `Checks` | The Test listener and the check run in flight |
| `packages/detect/src/locked-run.ts` | `LockedRun` | The client holding a lock, its abort and its progress |
| `packages/detect/src/wallets.ts` | `Wallets` | Addresses as bytes, with their numbers |
| `packages/detect/src/payments.ts` | `Payments` | The money graph's payments as typed arrays |
| `packages/detect/src/moves.ts` | `Moves` | The numbered wallets and their money edges |
| `packages/detect/src/graph.ts` | `AddressGraph` | One token's graph |
| `packages/detect/src/methods.ts` | `MoneyGraph` (not exported) | The sorted arrays built from `Payments` |
| `packages/detect/src/lens.ts` | `LensSearch` (not exported) | One lens run's indexes and the path being grown |
| `packages/detect/src/spot.ts` | `SpotCheck` | The store, the chain, Etherscan and one check's deadline |
| `apps/worker/src/migrating.ts` | `Migrating` | Whether the last migration attempt failed, and why |
| `apps/worker/src/publish.ts` | `Publisher` | The store, the token, the repo and the folder it commits from |
| `packages/detect/src/env.ts` | `ConfigError` | A setting is missing or malformed |
| `packages/detect/src/stored.ts` | `StoredDataError` | Stored data is bad |
| `packages/detect/src/store.ts` | `TooManyStreams` | A download was refused: `MAX_STREAMS` others are open |

That is 19 classes. The last three `extends Error` and carry no state of their
own: they exist so a caller can tell the failure by `instanceof`. They are the
one exception to "never inheritance"; add no other subclass.
