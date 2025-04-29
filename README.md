# washtrace

A wash trading detector for NFT collections on any EVM chain. It reads every
transfer of the collections you watch and who paid whom among the wallets that
traded them. It flags wash trades by three graph methods and says why each one
was flagged. A polling worker and a JSON API run in one container, with a
console over both.

washtrace is the 2023 paper *Detecting and quantifying wash trading of
non-fungible tokens* (Chow, SMU CS470) rebuilt on the systems that exist in
2026. The three methods are the paper's. The data sources, the marketplaces and
three corrections are new: see [From the paper to now](#from-the-paper-to-now).

- **Status:** v0.1.0. Tested against Postgres 17 and anvil 1.5.1; verified on
  Ethereum mainnet against the paper's own example sale.

## Contents

- [Quick start](#quick-start)
- [The methods](#the-methods)
- [Configuration](#configuration)
- [API](#api)
- [Pages](#pages)
- [From the paper to now](#from-the-paper-to-now)
- [Known limits](#known-limits)

How it is built and why, and how to work on it, is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

Requires Docker.

**The demo needs no keys.** It runs a local chain with a scripted market, wash
trading of each kind hidden among honest trades, and an Etherscan-shaped API
over it:

```sh
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

Open http://localhost:8080. The worker reads the collection on its next ingest
pass and analyzes it on the pass after that, which takes about two minutes. The
seeder's log says which tokens should be flagged and by which method.

**Against a real chain**, give it an RPC endpoint and an Etherscan key:

```sh
cp .env.example .env    # set WASHTRACE_RPC_1 and WASHTRACE_ETHERSCAN_KEY
docker compose up --build
```

Then watch a collection from the console, or:

```sh
curl -X POST localhost:8080/api/collections -H 'content-type: application/json' \
  -d '{"chainId": 1, "address": "0x4e1f41613c9084fdb9e34e11fae9412427480e56", "name": "Terraforms"}'
```

The worker finds the contract's deployment block and reads forward to the
finalized head. Then it reads the funding of every wallet that traded the
collection, busiest wallets first.

## The methods

Each method flags transfers. A collection's **wash trade share** is the flagged
share of its changes of owner, as in the paper's Tables 3 and 4. It is also
stated for sales alone and for sale volume.

| Method | Flags a transfer when | Needs funding |
|---|---|---|
| **SCC A** | It lies in a strongly connected component of the token's own transfer graph with at least two cycles: wallets passing the token back and forth. | No |
| **SCC AU** | It lies in a component of the token's transfers joined with the directed graph of money between its holders, where the money can run up to 30 wallets deep. A component closed by money counts on one cycle. | Yes |
| **SCC AC** | SCC A flags it, or its two wallets are joined by money within two hops in either direction: one paid the other, or both share a funder, a sink or a middle. | Yes |

Every flag carries a witness: the wallets in the component and its cycle
count, or the pair and the wallet or transaction that joins them. The console
shows the witness as a sentence, and the API returns it as data.

A method that needs funding and has none reports itself **not run**, never
0%.

## Configuration

Read at request and pass time. The same image serves any chain.

| Variable | Purpose |
|---|---|
| `WASHTRACE_STORE_URL` | Postgres that washtrace creates its `washtrace` schema in. Required. `DATABASE_URL` is read if this is unset. |
| `WASHTRACE_RPC_<chainId>` | JSON-RPC URL per chain, such as `WASHTRACE_RPC_1` or `WASHTRACE_RPC_8453`. Any provider, or a node of your own. Finding a deployment block needs archive state; otherwise pass `fromBlock`. |
| `WASHTRACE_ETHERSCAN_KEY` | Etherscan API V2 key: one key for every chain. Without it, SCC AU and AC do not run. |
| `WASHTRACE_ETHERSCAN_RPS` | Calls per second. Default 4; the free plan allows 5. |
| `WASHTRACE_ETHERSCAN_URL` | Any API that answers Etherscan's account actions, such as a Blockscout instance. Defaults to Etherscan V2. |
| `WASHTRACE_USERNAME`, `WASHTRACE_PASSWORD` | HTTP basic auth over every route except `/api/health`. Set both or neither; setting only one returns 503 on every request. |
| `WASHTRACE_WORKER` | `off` serves the API without running worker passes in this process. |
| `PORT` | Listen port. `8080` in the image. |

**Scaling.** Every worker pass takes a Postgres advisory lock without waiting.
With N replicas of the image, each pass runs in exactly one of them. Use
`WASHTRACE_WORKER=off` only to keep chain traffic out of the replicas that
serve requests.

## API

JSON throughout. Every route except `/api/health` sits behind basic auth when
auth is configured. A write needs `Content-Type: application/json` and gets 415
without it, which closes the CSRF path basic auth would otherwise open.

| Method and route | Returns |
|---|---|
| `GET /api/collections` | Every watched collection: ingest cursor, finalized head, funding coverage, latest analysis. |
| `POST /api/collections` | Watches `{chainId, address, name?, fromBlock?}`. 201 when new, 200 when already watched. |
| `GET /api/collections/{chain}/{address}?method=AC` | The latest analysis, its history, and the most-flagged tokens and wallets under the chosen method. |
| `DELETE /api/collections/{chain}/{address}` | Stops watching and drops its transfers and analyses. |
| `GET`, `POST /api/collections/{chain}/{address}/config` | Per-collection overrides: `{name?, rules?: {minCycles?, reachDepth?, hubDegree?, visitCap?}}`. A rule set to `null` returns to the default, and a changed rule queues the collection for analysis again. |
| `GET /api/collections/{chain}/{address}/tokens/{tokenId}` | One token's transfers in chain order, each with its flags and witnesses, and the money among its wallets. |
| `GET /api/wallets/{chain}/{address}` | A wallet's funding state, its counterparties and its transfers in every watched collection. |
| `GET /api/transfers/{chain}/{txHash}` | "Is this sale a wash trade?" Answers `washTrade`, the `methods` that flag it, and the transfers. A transaction washtrace has not read is 404, never `false`. |
| `GET /api/worker` | Each job's last pass, the funding backlog per chain, and which sources are configured (never their values). |
| `GET /api/status` | Each job's state (`never`, `running`, `ok`, `failed`, `stalled`) and a `problems` list in plain sentences. |
| `GET /api/health` | `{ok}`: whether the store answers. Unauthenticated, for the container's health check. |

## Pages

| Route | Content | Refresh |
|---|---|---|
| `/` | One row per watched collection: how far ingest has read, funding coverage, each method's share, missing data and the time of the last analysis. A form to watch another. | 15 s |
| `/c/{chain}/{address}` | One collection: its four headline facts, each method's share of transfers, sales and volume, the share across analyses, and the most-flagged tokens and wallets under a chosen method. | 15 s |
| `/c/{chain}/{address}/t/{tokenId}` | One token as a graph, as in the paper's Figure 8: transfers drawn solid and coloured by verdict, money dashed. Below it, every transfer with its flags and the reason for each. | On open |
| `/w/{chain}/{address}` | One wallet: whether its money has been read, its transfers in every watched collection, and who it moved money with. | On open |
| `/tx/{chain}/{hash}` | One transaction's verdict: the console form of `/api/transfers`. | On open |
| `/worker` | The sources configured, each job's last pass, the funding queue and how far behind each collection is. | 5 s |

The sidebar search takes a wallet, a collection or a transaction hash. Times
are clock times in UTC, never "ago". Light or dark follows the operating
system.

## From the paper to now

| 2023 | Now | Why |
|---|---|---|
| Moralis and Footprint Analytics APIs | Any JSON-RPC endpoint for transfers and receipts; Etherscan API V2 for funding | The paper's conclusion was that a node of your own is the way forward. Reservoir's NFT API shut down in October 2025, and Etherscan V1 was switched off in August 2025. |
| Seaport 1.4 and 1.5 | Seaport 1.1 to 1.6, Blur v1 and v2, LooksRare v2, X2Y2 | OpenSea moved to Seaport 1.6. Blur took most of Ethereum's NFT volume, much of it wash trading for points. |
| ETH only, as the user transaction graph | Native ETH, internal transfers, WETH and Blur Pool | Bids are paid in WETH, and Blur bids are held in Blur Pool. A wash trader funding a second wallet in WETH was invisible in 2023. |
| Head of chain | Finalized blocks only | Since the Merge, a finalized block cannot be reorganized away, so a stored transfer is never retracted. |
| Ethereum | Any EVM chain, one RPC variable each | NFT trading spread to Base, ApeChain and others. Seaport has the same address on every chain. |
| One shape for every source, backfilled with dummy fields | Each source keeps its own shape, and an unread field is `null` | A placeholder cannot be told apart from a reading. |

Three corrections, each with a test:

- **The payment leg of a sale is not money closing a cycle.** In a WETH bid, the
  buyer's WETH goes directly to the seller in the sale's own transaction. Left
  in, it would close a cycle on every honest bid sale. Flows that share a
  transaction with a transfer are excluded.
- **Custody is not a change of owner.** A Blend loan moves a token
  A → Blend → A, which the 2023 method reads as a back-and-forth trade.
  Custody is collapsed, so A → escrow → B is one hop A → B and a round trip is
  no hop at all.
- **An exchange is not a common funder.** A wallet joined by money to more than
  20 of the collection's wallets cannot be the middle of an SCC AC path.
  Neither can a known contract or a wallet with more history than Etherscan
  pages through. Without this rule, every customer of one exchange would be
  joined to every other.

## Known limits

- **SCC AU's reach mostly stays inside the collection.** Like the paper's
  dataset 3, funding is read only for wallets that traded the collection. A
  payment routed back through two or more outside wallets is never read, so
  AU's 30 hops can travel only through other collection wallets. Demo token
  #113 is this case and goes unflagged. This also plausibly explains why the
  paper found AC catching more than AU.
- **Blur sales are marked as sales but not priced.** Blur v2 packs the price
  into bit fields of its own events, which washtrace does not decode yet. A
  guessed price would be counted in volume as though it had been read.
- **ERC-1155 is not read.** The method depends on non-fungibility: one token,
  one holder, one path. With 1155, a "cycle" can be different units of the
  same id.
- **Funding is slow on purpose.** It takes four Etherscan calls per wallet at
  four calls per second, so a collection with 30,000 wallets needs about eight
  hours. Until then the console states AU and AC as floors, along with the
  share of wallets read so far.
