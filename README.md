# washtrace

A wash trading detector for NFT collections on any EVM chain. It reads every
transfer of the collections you watch and who paid whom among the wallets that
traded them. It flags wash trades by three graph methods and says why each one
was flagged. It runs as two services over one Postgres: a polling **worker**
and a JSON **API** with a console.

washtrace is the paper [*Detecting and quantifying wash trading of
non-fungible tokens*](paper/chow-2023-detecting-and-quantifying-nft-wash-trading.pdf)
(Chow, 2023) rebuilt on the systems that exist in 2026. The three methods are
the paper's. The data sources, the marketplaces and three corrections are new:
see [From the paper to now](#from-the-paper-to-now).

- **Status:** v0.1.0. Tested against Postgres 17 and anvil 1.5.1; verified on
  Ethereum mainnet against the paper's own example sale.
- **Paper:** [PDF](paper/chow-2023-detecting-and-quantifying-nft-wash-trading.pdf),
  7 pages, with its [slides](paper/chow-2023-detecting-and-quantifying-nft-wash-trading-slides.pdf).
- **Data:** [jonathanmiro97/washtrace-data](https://huggingface.co/datasets/jonathanmiro97/washtrace-data)
  on Hugging Face: six Ethereum collections read from the chain, CC-BY-4.0.
- **Sources:** the five works the paper builds on are in
  [What it builds on](#what-it-builds-on).

## Contents

- [The paper](#the-paper)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [The methods](#the-methods)
- [Configuration](#configuration)
- [Deploying](#deploying)
- [Stored data](#stored-data)
- [API](#api)
- [Pages](#pages)
- [From the paper to now](#from-the-paper-to-now)
- [Known limits](#known-limits)
- [Citing](#citing)

How it is built and why, and how to work on it, is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## The paper

[*Detecting and quantifying wash trading of non-fungible tokens*](paper/chow-2023-detecting-and-quantifying-nft-wash-trading.pdf)
(Chow, 2023) starts from an observation: the top NFT collections by market cap
show far less wash trading than the rest, which points to wash trades hidden
from the usual detector. That detector looks for strongly connected components
in a token's own transfers, and a wash trader beats it by paying through
wallets that never touch the token. The paper adds the graph of money between
wallets to the token's transfers, which gives the three methods washtrace runs.

### Resources

| Resource | What it is |
|---|---|
| [Paper](paper/chow-2023-detecting-and-quantifying-nft-wash-trading.pdf) (PDF, 7 pages) | The three methods, the 2023 data from the top 20 ERC-721 collections by trading volume, and the wash trade shares in its Tables 3 and 4. |
| [Slides](paper/chow-2023-detecting-and-quantifying-nft-wash-trading-slides.pdf) (PDF, 25 slides) | The paper as presented: the background on SCC detection, open source filters and DEX studies, then the approach, the evaluation and the conclusion. |
| [washtrace-data](https://huggingface.co/datasets/jonathanmiro97/washtrace-data) (Hugging Face) | Transfers and the money trail of six collections, read from the chain, so an install need not read them from their deploy blocks. See [Stored data](#stored-data). |
| [Demo](#quick-start) | A local chain with a scripted market that hides each kind of wash trade among honest trades, with no keys needed. |

### What it builds on

| Work | What washtrace takes from it |
|---|---|
| Jung (2022), [*Towards a Web Application to Detect and Analyze Wash Trading in NFT Collections on the Solana Blockchain*](https://wwwmatthes.in.tum.de/file/19apj4nvq7a8m/Sebis-Public-Website/Student-Theses-Guided-Research/Current-Theses-Guided-Researches/TUMKolleg-Sebastian-O.-Jung/Sebastian%20Jung%20Thesis.pdf), TUM | SCC detection on each token's transfer graph, flagging a component by its cycle count: the basis of SCC A. |
| Liu (2023), [*NFT Wash Trading Detection*](https://arxiv.org/abs/2305.01543), arXiv:2305.01543 | SCC detection over sales as well as transfers, so a sale fills an edge the transfers miss. |
| hildobby (2022), [*Ethereum NFTs Wash Trading*](https://dune.com/hildobby/nfts-wash-trading), Dune | Five filters, one of them buyer and seller first funded by the same wallet: the shared funder that SCC AC generalises. |
| Victor & Weintraud (2021), [*Detecting and Quantifying Wash Trading on Decentralized Cryptocurrency Exchanges*](https://arxiv.org/abs/2102.07001), arXiv:2102.07001 | SCC detection over the user transaction graph to find colluding traders, here applied to money between NFT traders. |
| Cao et al. (2016), [*Detecting Wash Trade in Financial Market Using Digraphs and Dynamic Programming*](https://ieeexplore.ieee.org/document/7298451), IEEE TNNLS 27(11) | Wash trades as cycles in a directed graph of trades. Its volume matching does not carry over: NFTs are not fungible. |

### Further reading

- [ERC-721](https://eips.ethereum.org/EIPS/eip-721), the token standard
  washtrace reads.
- [Seaport](https://github.com/ProjectOpenSea/seaport), the marketplace
  protocol whose sales washtrace prices.
- [Etherscan API V2](https://docs.etherscan.io/), the source of who paid whom.

## Architecture

```
            ┌──────────────────────────┐        ┌──────────────────────────┐
 JSON-RPC ─▶│  worker   (apps/worker)  │        │  api   (apps/web)        │◀─ HTTP :8080
Etherscan ─▶│  plain Node, no HTTP     │        │  JSON API + console      │   /api/…  and pages
            │  but /health on :8081    │        │  reads only; never calls │
            │                          │        │  a chain                 │
            │  ingest   every 60 s     │        │                          │
            │  fund     every 5 s      │        │                          │
            │  analyze  every 60 s     │        │                          │
            └────────────┬─────────────┘        └────────────┬─────────────┘
                         │  writes                     reads  │
                         ▼                                    ▼
                    ┌────────────────────────────────────────────┐
                    │  Postgres: schema washtrace                │
                    │  collections · transfers · wallets · flows │
                    │  analyses · flags · passes                 │
                    └────────────────────────────────────────────┘
```

- **worker** ([apps/worker/src/main.ts](apps/worker/src/main.ts)) runs the
  three jobs of [`Worker`](packages/detect/src/worker.ts) on timers. **ingest**
  reads finalized ERC-721 transfers and their receipts for every watched
  collection. **fund** reads who paid whom for each wallet that traded, then
  follows money out of them. **analyze** reruns the three methods over every
  collection that changed. A pass that comes due while the last one is still
  running is skipped, not queued.
- **api** ([apps/web](apps/web)) is Next.js: the JSON API under `/api` and the
  console pages, both reading the store. Adding a collection writes one row;
  the worker picks it up on its next ingest pass.
- **They share nothing but the store.** Each scales or restarts on its own.
  Each worker pass takes its job's advisory lock without waiting, so two
  worker replicas still do one worker's work, and one carries on when the
  other dies.

Both are built from one [Dockerfile](Dockerfile) as `--target worker` and
`--target api`. The domain code (chains, Etherscan, the graph methods, the
store) lives in [packages/detect](packages/detect), which both import.

## Quick start

Requires Docker.

**The demo needs no keys.** It runs a local chain with a scripted market, wash
trading of each kind hidden among honest trades, and an Etherscan-shaped API
over it:

```sh
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

`docker compose ps` shows the services: `worker`, `api`, `db`, and the demo's
`anvil`, `explorer` and `seed`. Open http://localhost:8080. The worker reads
the collection on its next ingest pass and analyzes it on the pass after that,
which takes about two minutes. `docker compose logs -f worker` shows the
passes as they run. The
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

Both services read the same variables. In Compose they share one `.env`.

| Variable | Purpose |
|---|---|
| `WASHTRACE_STORE_URL` | Postgres that washtrace creates its `washtrace` schema in. Required. `DATABASE_URL` is read if this is unset. |
| `WASHTRACE_RPC_<chainId>` | JSON-RPC URL per chain, such as `WASHTRACE_RPC_1` or `WASHTRACE_RPC_8453`. Any provider, or a node of your own. Finding a deployment block needs archive state; otherwise pass `fromBlock`. |
| `WASHTRACE_ETHERSCAN_KEY` | Etherscan API V2 key: one key for every chain. Without it, SCC AU and AC do not run. |
| `WASHTRACE_ETHERSCAN_RPS` | Calls per second. Default 4; the free plan allows 5. |
| `WASHTRACE_ETHERSCAN_URL` | Any API that answers Etherscan's account actions, such as a Blockscout instance. Defaults to Etherscan V2. While `WASHTRACE_ETHERSCAN_KEY` is set, only this variable sets the URL: a URL saved in the console is ignored, so it can't receive the key. |
| `WASHTRACE_USERNAME`, `WASHTRACE_PASSWORD` | HTTP basic auth over every route except `/api/health`. Set both or neither; setting only one returns 503 on every request. |
| `WASHTRACE_FOLLOW_HOPS` | Hops of money the worker follows out of a trader, so SCC AU sees a payment routed back through wallets that never traded. Default 3; 0 reads traders only, as the paper did. |
| `WASHTRACE_STORED_REPO` | The Hugging Face dataset the worker downloads stored data from, as `owner/name`. Defaults to `jonathanmiro97/washtrace-data`. Overrides the console's `stored.repo` setting. |
| `WASHTRACE_STORED_DIR` | Where stored data is kept. Defaults to `data/stored`; `/app/data/stored` in the images. |
| `PORT` | The api's listen port. `8080` in the image. |
| `WASHTRACE_WORKER_PORT` | The worker's health check port. `8081`. |

## Deploying

The [Dockerfile](Dockerfile) builds two images, and
[docker-compose.yml](docker-compose.yml) runs them over Postgres 17:

```sh
docker build --target worker -t washtrace-worker .
docker build --target api    -t washtrace-api .
```

- **Schema.** Both services migrate the `washtrace` schema on boot, so there
  is no separate migration step. Point `WASHTRACE_STORE_URL` at any Postgres
  you run. The Compose file's own database and password are for a single
  host, not for production.
- **Health.** The worker answers `GET :8081/health` and the api
  `GET /api/health`, and both images declare a `HEALTHCHECK`. Only the api
  needs a public port.
- **Auth.** On a public host, set `WASHTRACE_USERNAME` and
  `WASHTRACE_PASSWORD`. Without them the console is open to anyone, though
  its settings are read only.
- **Stored data.** Give the worker a writable volume at
  `WASHTRACE_STORED_DIR` and mount the same volume read only into the api.
- **Shutdown.** On `SIGTERM` the worker gives passes in flight 8 seconds to
  finish, then exits. Postgres rolls back a pass that did not finish and frees
  its lock, so `docker stop`'s 10-second grace is enough.
- **Scaling.** `docker compose up --scale api=3 --scale worker=2`. API replicas
  are stateless. Worker replicas share each job through an advisory lock, so a
  second worker gives failover, not double reads.

## Stored data

Reading a big collection from the chain takes days, so its chain data is cut
once and published to a Hugging Face dataset,
[`jonathanmiro97/washtrace-data`](https://huggingface.co/datasets/jonathanmiro97/washtrace-data)
by default. When you watch a collection that the dataset holds, the worker
downloads its files in the background and loads them, then reads on from the
chain where they stop. The console shows the download as it runs ("Downloading
stored data · 41%") and the Watch panel lists each collection's size before you
watch it, such as `stored data: 12.3 MB transfers + 3.4 GB money trail`. The
transfers come first; the money trail follows and feeds Money loops back and
Linked wallets without an Etherscan key. A large money trail loads into the
database in the background (over an hour for the biggest collections); the
console shows how far it has got ("Money trail loading from stored data · 41%"),
and the analysis runs again once it is in.

The default dataset holds six Ethereum collections, read through block
26288279 (October 2026):

| Collection | Address | Transfers | Money trail |
|---|---|---|---|
| Argonauts | [`0x387c…392c`](https://etherscan.io/address/0x387c41b0b2f1128de44db1bcf8baad085f26392c) | 1.3 MB | 321.4 MB |
| Terraforms | [`0x4e1f…0e56`](https://etherscan.io/address/0x4e1f41613c9084fdb9e34e11fae9412427480e56) | 2.9 MB | 621.8 MB |
| Meebits | [`0x7bd2…6bc7`](https://etherscan.io/address/0x7bd29408f11d2bfc23c34f18275bbf23bb716bc7) | 6.3 MB | 996.6 MB |
| Dreadfulz | [`0x81ae…5aa8`](https://etherscan.io/address/0x81ae0be3a8044772d04f32398bac1e1b4b215aa8) | 1.6 MB | 368.1 MB |
| BoredApeYachtClub | [`0xbc4c…f13d`](https://etherscan.io/address/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d) | 10.9 MB | 955.4 MB |
| dotdotdot | [`0xce25…92c3`](https://etherscan.io/address/0xce25e60a89f200b1fa40f6c313047ffe386992c3) | 1.0 MB | 414.7 MB |

Each file is zstd-compressed CSV, so the data reads without washtrace too. The
[dataset card](https://huggingface.co/datasets/jonathanmiro97/washtrace-data)
gives the columns and a pandas example.

- **Where it is kept.** `data/stored/` (`WASHTRACE_STORED_DIR`), never in the
  repo or the image. Under Compose it is the named volume `stored`, written by
  the worker and mounted read only into the api. Under Compose,
  `WASHTRACE_STORED_DIR` must match the volume's mount (`/app/data/stored`), or
  the worker and the api look in different places.
- **Which dataset.** `WASHTRACE_STORED_REPO` or the console's `stored.repo`
  setting (the environment wins). The worker fetches the dataset's manifest about
  hourly, and at once when a collection is newly watched, and keeps the last
  one, so an unreachable Hub only means the chain is read instead.
- **What is published.** Chain data only: transfers, the money trail's flows,
  the checked wallets' addresses, and each collection's address, chain and
  contract name. Never a wallet's status or errors, a label you gave a
  collection, or any setting or key.
- **Cleaning up.** Delete `data/stored/`, or under Compose
  `docker volume rm <project>_stored` with the services stopped.
- **Cutting your own.** `npm run stored` writes a local manifest and files into
  `data/stored/`. The worker's hourly fetch replaces that manifest, so a local
  cut is for publishing, not for serving.

## API

JSON throughout. Every route except `/api/health` sits behind basic auth when
auth is configured. A write needs `Content-Type: application/json` and gets 415
without it, which closes the CSRF path basic auth would otherwise open. The
settings writes and Tests answer 403 while basic auth is off.

| Method and route | Returns |
|---|---|
| `GET /api/collections` | Every watched collection: ingest cursor, finalized head, funding coverage, latest analysis, `priority` and `pausedAt`. `restoreNote` and `analysisError` say why its stored data did not load or its latest analysis failed, with when each is tried again (`restoreRetryAt`, `analysisRetryAt`); null when nothing failed. `downloadFile` (`transfers` or `trail`) and `downloadProgress` (0 to 1) say what is downloading from the Hub and how far, with a null progress for a collection waiting its turn; `downloadNote` says why a download failed and `downloadRetryAt` when it is tried again, both null when nothing failed. `trailProgress` (0 to 1) says how far that collection's downloaded money trail has loaded into the database; null when none is loading. |
| `POST /api/collections` | Watches `{chainId, address, name?, fromBlock?}`. 201 when new, 200 when already watched, with a `warning` when its chain has no RPC. |
| `GET /api/collections/{chain}/{address}?method=AC` | The latest analysis, its history, and the most-flagged tokens and wallets under the chosen method. |
| `POST /api/collections/{chain}/{address}/pause` | The worker stops serving it, its data kept. `{paused: true}`, and again if already paused. |
| `POST /api/collections/{chain}/{address}/resume` | The worker serves it again. `{paused: false}`, and again if not paused. |
| `DELETE /api/collections/{chain}/{address}` | Stops watching and drops its transfers and analyses: `{removed: true}`. 409 unless paused first. Funding read for its wallets is kept, as it is per chain. |
| `GET`, `POST /api/collections/{chain}/{address}/config` | Per-collection settings: `{name?, rules?: {minCycles?, reachDepth?, hubDegree?, visitCap?}, priority?}`. A rule set to `null` returns to the default, and a changed rule queues the collection for analysis again. `priority: true` checks its wallets' funding first, sharing those turns with any other prioritised collection. |
| `GET /api/collections/{chain}/{address}/tokens/{tokenId}` | One token's transfers in chain order, each with its flags and witnesses, and the money among its wallets. |
| `GET /api/wallets/{chain}/{address}` | A wallet's funding state, its counterparties and its transfers in every watched collection. |
| `GET /api/transfers/{chain}/{txHash}` | "Is this sale a wash trade?" Answers `washTrade`, the `methods` that flag it, and the transfers. A transaction washtrace has not read is 404, never `false`. |
| `GET /api/settings` | Each setting the console offers (`rpc.1`, `etherscan.key`, `etherscan.rps`, `etherscan.url`, `follow.hops`), where its value came from, and whether it can be changed here. A secret answers as `••••` and at most its last 4. |
| `POST /api/settings` | Saves `{key, value}`, or clears it with `value: null` so the default applies. 409 for a value the worker's environment pins, 400 for one the worker could not use. |
| `POST /api/settings/check` | Asks the worker to Test `{kind: 'rpc', chainId}` or `{kind: 'etherscan'}`. 201 `{id}`. |
| `GET /api/settings/check/{id}` | That Test: `{finished, ok, detail}`. Poll until `finished`. |
| `GET /api/worker` | Each job's last pass, the funding backlog per chain, which sources are configured (never their values), and `notices` as in `/api/status`. `funding` is null while there is no Etherscan key. Its `perSecond`, and `followHops`, are null while the worker runs on its defaults. |
| `GET /api/status` | Each job's state (`never`, `running`, `ok`, `failed`, `stalled`) and last `outcome`, each collection's `turn` and lag, the funding backlog, and `notices` in plain sentences. |
| `GET /api/health` | `{ok}`: whether the store answers. Unauthenticated, for the container's health check. |

A notice is `{severity, text}`, its severity `needs-you`, `working` or `info`.
A `needs-you` one also says what to do (`doThis`, maybe with an `href`); the
others may carry an `action: {label, href}`. Working and info notices are there
while all is well, so a monitor alerts on
`notices.some(n => n.severity === 'needs-you')`. In the funding backlog,
`pending` and `failed` count the wallets the worker will check, `etaMs` is how
long the pending ones take at the last hour's rate (null until known), and
`stranded` counts the ones held back while their collections are paused or
removed.

## Pages

| Route | Content | Refresh |
|---|---|---|
| `/` | One row per watched collection: the share of its sales and of its volume that looks washed, as a range from the strictest method to the widest, and how complete the reading under it is. A form to watch another. | 15 s |
| `/c/{chain}/{address}` | One collection, top down: how far it has been read, in one line; the answer as that range; the three methods as cards, each a tab over the ten tokens and wallets it flags most; each method's share of sales month by month (or week or day) across the collection's life, with history not yet read shaded; then the reading step by step, with how the answer settled at each analysis. | 15 s |
| `/c/{chain}/{address}/flagged` | Every token or wallet one method flags, most flagged first, 50 a page. `?method=AU&kind=wallets&page=2`. | On open |
| `/c/{chain}/{address}/t/{tokenId}` | One token: whether its trades look washed and by which methods, the reason for each pattern once with the transfers it covers, the graph as in the paper's Figure 8 (transfers solid and coloured by verdict, money dashed, a pair traded more than six times drawn as one counted arrow each way), and every transfer. | On open |
| `/w/{chain}/{address}` | One wallet: how many of its trades are flagged and whether its money has been read, its transfers in every watched collection, and who it moved money with. | On open |
| `/tx/{chain}/{hash}` | One transaction's verdict: the console form of `/api/transfers`. | On open |
| `/worker` | What needs a person, from the same reading as `/api/status`; the three jobs as the pipeline they form, each with what it feeds; the sources configured; how far behind each collection is. | 5 s |

The console names the methods by what they catch, with the paper's name
beside each: **Round trips** (SCC A), **Money loops back** (SCC AU) and
**Linked wallets** (SCC AC). The sidebar search takes a wallet, a collection or
a transaction hash. Times are clock times, never "ago", in the reader's time zone: detected in the
browser and changeable at the foot of the sidebar. The server buckets a
collection's history by that zone's calendar, so a month is the reader's month. Light or dark
follows the operating system.

## From the paper to now

| 2023 | Now | Why |
|---|---|---|
| Moralis and Footprint Analytics APIs | Any JSON-RPC endpoint for transfers and receipts; Etherscan API V2 for funding | The paper's conclusion was that a node of your own is the way forward. Reservoir's NFT API shut down in October 2025, and Etherscan V1 was switched off in August 2025. |
| Seaport 1.4 and 1.5 | Seaport 1.1 to 1.6, Blur v1 and v2, LooksRare v2, X2Y2 | OpenSea moved to Seaport 1.6. Blur took most of Ethereum's NFT volume, much of it wash trading for points. |
| ETH only, as the user transaction graph | Native ETH, internal transfers, WETH and Blur Pool | Bids are paid in WETH, and Blur bids are held in Blur Pool. A wash trader funding a second wallet in WETH was invisible in 2023. |
| Head of chain | Finalized blocks only | Since the Merge, a finalized block cannot be reorganized away, so a stored transfer is never retracted. |
| Funding read for traders only | Funding followed out of traders, through low fan-out wallets | So SCC AU's depth 30 reaches outside the collection, as the method intends. |
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

- **SCC AU sees as far as the worker follows money.** The paper read funding
  only for wallets that traded the collection (its dataset 3), so AU's 30 hops
  could only travel through other traders. That plausibly explains why the
  paper found AC catching more than AU. The worker now follows money out of
  each trader, `WASHTRACE_FOLLOW_HOPS` deep, but only through wallets that
  paid at most 25 others; an exchange or a busy trader is not followed. A
  path back through a busy wallet stays unseen. Demo token #113 is the case
  this exists for: AU flags it, AC cannot.
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

## Citing

washtrace implements the methods of (Chow, 2023):

```bibtex
@misc{chow2023washtrading,
  author = {Chow, Jonathan},
  title  = {Detecting and quantifying wash trading of non-fungible tokens},
  year   = {2023},
  url    = {https://github.com/jonathanchowjh/opensea-fraud-detector/blob/main/paper/chow-2023-detecting-and-quantifying-nft-wash-trading.pdf}
}
```

The data, if you use it:

```bibtex
@misc{washtracedata,
  author       = {Chow, Jonathan},
  title        = {washtrace data: NFT transfers and money trails},
  year         = {2026},
  howpublished = {Hugging Face},
  url          = {https://huggingface.co/datasets/jonathanmiro97/washtrace-data}
}
```
