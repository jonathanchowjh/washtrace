# Contributing to washtrace

This is the guide for working on the code. To *run* washtrace, read the
[README](README.md).

## Setup

You need **Node 22.15 or newer**, **npm** and **Docker**. Docker runs the dev
Postgres and the integration tests. Unit and component tests run without it.

```sh
npm install
git config core.hooksPath .githooks          # one-time: the hooks below
npm run db:up                                # Postgres 17 on localhost:55433
export WASHTRACE_STORE_URL='postgres://postgres:secret@localhost:55433/washtrace'
export WASHTRACE_RPC_1='https://…'           # optional: any Ethereum JSON-RPC
export WASHTRACE_ETHERSCAN_KEY='…'           # optional: turns SCC AU and AC on
npm run dev                                  # the api: http://localhost:3000
npm run worker                               # the worker, in a second terminal
```

For a chain with a scripted market and no keys, run the Docker demo (see the
README). Its seeder, `scripts/demo/seed.mjs`, works against any anvil, so
`RPC=… API=http://localhost:3000 node scripts/demo/seed.mjs` seeds a dev
server too.

## Everyday commands

| Command | What it runs | Needs Docker |
|---|---|---|
| `npm test` | Unit tests in `packages/detect`: graph, methods, Seaport decoding, Etherscan paging | No |
| `npm run test:web` | The console's tests: layout, configuration, status | No |
| `npm run test:int` | The store against a real Postgres, one container per file | Yes |
| `npm run typecheck:test` | Types across the package and its tests | No |
| `npm run --workspace @washtrace/web typecheck` | The console | No |

[.githooks/pre-commit](.githooks/pre-commit) runs every command in this table
except the integration tests.

## The shape of the repo

```
packages/detect/          Everything that knows chains, money and graphs. No React, no HTTP.
  src/types.ts            Transfer, Flow, Method, Witness, Analysis
  src/graph.ts            The asset transfer graph of one token; Tarjan; cycle counting
  src/methods.ts          SCC A, AU and AC over a collection: analyze() and its RULES
  src/marketplaces.ts     Venue addresses, custodians, wrapped native tokens; Seaport pricing
  src/chain.ts            Chain: finalized head, transfer logs, receipts, deployment block
  src/etherscan.ts        Etherscan: who paid whom, per wallet, paced per key
  src/store.ts            Store: every read and write of the washtrace schema
  src/migrations.ts       The only DDL in the product
  src/worker.ts           Worker: the ingest, fund and analyze passes
  src/env.ts              Every environment variable, read the same way by both services
  test/                   *.test.ts is pure; *.int.test.ts starts Postgres

apps/worker/              The worker service: a plain Node process, no Next.
  src/main.ts             Migrates, starts Worker's timers, serves /health, drains on SIGTERM

apps/web/                 The api service: the JSON API and the console, over the store.
  instrumentation.ts      Migrates the schema on boot; never reads a chain
  proxy.ts                Basic auth over every route but /api/health
  app/api/                The API; see the README for the routes
  app/                    One folder per page
  lib/views.ts            Reads that a page and its API route share
  lib/layout.ts           The token graph's layout, as a pure function
  lib/config.ts           Re-exports packages/detect's env.ts

scripts/demo/             The local market: contracts, seeder, Etherscan stand-in
```

`packages/detect` depends on `pg` and `viem` and nothing else. The console
never builds a pool or writes SQL; it calls `Store` and renders what comes
back.

## How a transfer becomes a verdict

1. **Ingest** (`Worker.ingest`, every minute) asks the chain for its finalized
   head. It reads each collection's ERC-721 `Transfer` logs in spans that halve
   on a provider's refusal and grow back on success. It fetches the receipts of
   their transactions, so a transfer whose transaction has a marketplace's
   event is a sale, and a Seaport sale is priced from `OrderFulfilled`. The
   transfers and the new cursor are written in one transaction, and the
   wallets join the funding queue weighted by how often they traded.
2. **Fund** (`Worker.fund`, every 5 seconds) takes the nearest, busiest wallets
   not yet read and asks Etherscan for their native, internal and
   wrapped-native flows. Each wallet's flows are written, the wallets it paid
   are queued one hop further out, and every collection it or a counterparty
   traded is marked for analysis.
3. **Analyze** (`Worker.analyze`, every minute) reruns `analyze()` over each
   collection written to since its last analysis. It replaces the flags and
   records the totals. The collection's version is read before the analysis
   and recorded with it, so a write that lands mid-analysis is not lost.
4. **The console and the API** read the store. Neither calls a chain.

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
read is 404 from the API, never `washTrade: false`.

### Two services, one store

The worker is its own process ([apps/worker](apps/worker)), and the api never
calls a chain. They share nothing but Postgres, so a slow backfill cannot slow
a page, and either can be restarted, scaled or redeployed alone. Each pass
takes its job's advisory lock without waiting, so N workers do one worker's
work. A pass that is due while the last one is still running is skipped, not
queued.

### Following money

`Store.fund` queues the wallets a trader sent money to, one hop further out,
up to `WASHTRACE_FOLLOW_HOPS`. It never follows a wallet that paid more than
`FOLLOW_FANOUT` (25) others, nor a known contract. Traders are read before
followed wallets, so following never delays a collection's own funding.

## Conventions

- **Light OOP.** A class exists where several functions share the same state:
  `Chain` (a client and its adaptive span), `Etherscan` (a key and its pacing),
  `Store` (a pool), `Worker` (all of those and its timers), and `MoneyGraph`
  inside `methods.ts` (four indexes). Everything else is a function. Never
  inheritance or dependency injection. A test that needs a seam overrides a
  method on the instance, as `etherscan.test.ts` does with `fetch`.
- **Comments say why**: the constraint the code answers to, not what it does.
- **Addresses are lowercase; amounts are wei strings**, summed as bigint only
  where they are summed.
- **Relative imports end in `.js` in `packages/detect`** and have no extension
  in `apps/web`, as each toolchain requires.
- **One claim, one test.** A README sentence that states a property has a test
  that holds it.
- **Commit messages** follow `type(scope): summary`, such as
  `feat(detect): …` or `fix(web): …`.
