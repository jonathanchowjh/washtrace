# washtrace

A wash trading detector for NFT collections on any EVM chain. It reads every
transfer of the collections you watch and who paid whom among the wallets that
traded them. It flags wash trades by three graph methods and says why each one
was flagged. It runs as two services over one Postgres: a polling **worker**
and a JSON **API** with a console.

It is the 2023 paper [*Detecting and quantifying wash trading of non-fungible
tokens*](paper/chow-2023-detecting-and-quantifying-nft-wash-trading.pdf) (Chow)
rebuilt on today's systems: the methods are the paper's, the data sources,
marketplaces and three corrections are new.

- **Status:** v0.1.0. Tested against Postgres 17 and anvil 1.5.1; verified on
  Ethereum mainnet against the paper's own example sale.
- **Try it:** the [demo](#quick-start) needs Docker and no keys.
- **Data:** [jonathanmiro97/washtrace-data](https://huggingface.co/datasets/jonathanmiro97/washtrace-data)
  on Hugging Face: six Ethereum collections read from the chain, CC-BY-4.0.
- **Docs:** [how the methods work](doc/methods.md), [operating it](doc/operating.md),
  the [API](doc/api.md), and [CONTRIBUTING.md](CONTRIBUTING.md) for working on the code.

## Quick start

Requires Docker with Compose 2.24 or later.

**The demo needs no keys.** It runs a local chain with a scripted market, wash
trading of each kind hidden among honest trades:

```sh
docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build
```

Open http://localhost:8080 and choose **Demo Apes**. The worker reads the
collection on its next ingest pass and analyzes it on the one after, about two
minutes. Each token below is one scenario, and [doc/methods.md](doc/methods.md)
walks through why each verdict is what it is.

| Token | What happens | Round trips (A) | Money loops back (AU) | Linked wallets (AC) |
|---|---|---|---|---|
| #101 | Sold back and forth between two wallets | flagged | flagged | flagged |
| #102 | Sold round a ring of three wallets, twice | flagged | flagged | flagged |
| #111 | The buyer pays the seller back | | flagged | flagged |
| #112 | The buyer pays the seller back through a third wallet | | flagged | flagged |
| #113 | The money comes back through three wallets that never traded | | flagged | |
| #114 | One wallet funded both the seller and the buyer | | | flagged |
| #116 | The seller and the buyer both paid the same wallet | | | flagged |
| #1–#40 | Honest sales, every buyer funded by one exchange | | | |
| #120 | Two loans through Blur Blend, then a sale | | | |
| #130 | Sold once and bought back once | | | |

**Against a real chain**, give it an RPC endpoint and an Etherscan key:

```sh
cp .env.example .env    # set WASHTRACE_RPC_1 and WASHTRACE_ETHERSCAN_KEY
docker compose up --build
```

Then watch a collection from the console, or `POST /api/collections`. The worker
reads it forward to the finalized head, then the funding of every wallet that
traded it, busiest first.

**With no keys**, skip the `cp` and watch one of the six collections in [the
dataset](#the-dataset). The worker downloads it and warns that no RPC is set, so
only stored data is read until one is set in Settings.

The console and API are on port 8080 of this machine only.

## The methods

Each method flags transfers. A collection's **wash trade share** is the flagged
share of its changes of owner, as in the paper's Tables 3 and 4; the collection
page leads with sales. The console names the methods Round trips (SCC A), Money
loops back (SCC AU) and Linked wallets (SCC AC).

| Method | Flags a transfer when | Needs funding |
|---|---|---|
| **SCC A** | It lies in a strongly connected component of the token's own transfer graph with at least two cycles: wallets passing the token back and forth. | No |
| **SCC AU** | It lies in a component of the token's transfers joined with the directed graph of money between its holders, where the money can run up to 30 wallets deep. A component closed by money counts on one cycle. | Yes |
| **SCC AC** | SCC A flags it, or its two wallets are joined by money within two hops in either direction: one paid the other, or both share a funder, a sink or a middle. | Yes |

Every flag carries a witness (the component and its cycle count, or the pair and
what joins them), shown as a sentence and returned as data. A method that needs
funding and has none reports itself **not run**, never 0%.

**The headline range is Round trips to Linked wallets.** Money loops back still
runs and keeps its card, but is not counted. In a placebo test on Terraforms and
dotdotdot, with buyers relabelled at random among wallets of similar activity,
it flagged as many sales as with the real buyers (Terraforms 71.7% against
74–75%, dotdotdot 59.5% against 58–59%), and its share follows `hubDegree` and
`visitCap` more than the data. Linked wallets clears the same test, though
between a third and a half of what it adds over Round trips is chance. The test,
its numbers and the thresholds are in [doc/methods.md](doc/methods.md).

## The paper

**[*Detecting and quantifying wash trading of non-fungible tokens*](paper/chow-2023-detecting-and-quantifying-nft-wash-trading.pdf)**
by Jonathan Chow, Singapore Management University, 2023
([slides](paper/chow-2023-detecting-and-quantifying-nft-wash-trading-slides.pdf), 25 slides).

The paper starts from an observation: the top NFT collections by market cap
show far less wash trading than the rest. That points to wash trades the usual
detector cannot see. The usual detector finds strongly connected components
(SCCs) in a token's own transfers, and a trader beats it by paying through
wallets that never touch the token. The paper adds the graph of money between
wallets to the token's transfers, and from the two builds the three methods
above.

### From the paper to now

Any JSON-RPC endpoint and Etherscan API V2 replace Moralis and Footprint
Analytics; Seaport 1.1 to 1.6, Blur, LooksRare v2 and X2Y2 replace Seaport 1.4 and
1.5; any EVM chain replaces Ethereum alone. ETH, internal transfers, WETH and
Blur Pool replace ETH alone, and funding is followed out of traders so SCC AU's
depth 30 reaches outside the collection. Only finalized blocks are read, so a
stored transfer is never retracted.

Three corrections, each with a test:

- **The payment leg of a sale is not money closing a cycle.** Flows sharing a
  transaction with a transfer are excluded.
- **Custody is not a change of owner.** A Blend loan A → Blend → A is not a round
  trip.
- **An exchange is not a common funder.** A wallet joined by money to more than
  20 of the collection's wallets (`hubDegree`), a known contract, or a wallet
  with more history than Etherscan pages through cannot be the middle of an SCC
  AC path.

### The work it builds on

- Jung (2022), [*Towards a Web Application to Detect and Analyze Wash Trading in NFT Collections on the Solana Blockchain*](https://wwwmatthes.in.tum.de/file/19apj4nvq7a8m/Sebis-Public-Website/Student-Theses-Guided-Research/Current-Theses-Guided-Researches/TUMKolleg-Sebastian-O.-Jung/Sebastian%20Jung%20Thesis.pdf), TUM: SCC detection on each token's transfer graph, flagged by cycle count: the basis of SCC A.
- Liu (2023), [*NFT Wash Trading Detection*](https://arxiv.org/abs/2305.01543): SCC detection over sales as well as transfers.
- hildobby (2022), [*Ethereum NFTs Wash Trading*](https://dune.com/hildobby/nfts-wash-trading), Dune: a buyer and seller first funded by the same wallet, which SCC AC generalises.
- Victor & Weintraud (2021), [*Detecting and Quantifying Wash Trading on Decentralized Cryptocurrency Exchanges*](https://arxiv.org/abs/2102.07001): SCC detection over the user transaction graph, here applied to money between NFT traders.
- Cao et al. (2016), [*Detecting Wash Trade in Financial Market Using Digraphs and Dynamic Programming*](https://ieeexplore.ieee.org/document/7298451): wash trades as cycles in a directed graph; its volume matching does not carry over, as NFTs are not fungible.

The standards and sources washtrace reads: [ERC-721](https://eips.ethereum.org/EIPS/eip-721),
[Seaport](https://github.com/ProjectOpenSea/seaport) (whose sales it prices) and
[Etherscan API V2](https://docs.etherscan.io/) (who paid whom).

## Concepts

The console's own words.

- **Lens.** One rule for what counts as a wash trade: the three methods, and
  [yours](#your-own-lenses).
- **Share.** The part of the trades a lens judged that it flags. The collection
  page leads with sales; the analysis also gives changes of owner and volume.
- **So far / at least.** "So far": reads still running can move the share. "At
  least": waiting will not close it (a search cap, a missing Etherscan key, a
  limit).
- **Judged.** Looked at by a lens. "Not judged yet" is a trade past the block the
  latest analysis or run read to, never shown as clean. Burns and moves into or
  out of custody are not trades and are never judged.
- **Money read.** How many traders are checked, and how many wallets out the
  worker follows.
- **Wallets out.** Hops of money followed out of a trader (`follow.hops`, "Follow
  money (wallets out)"), so a payment can return through wallets that never
  traded the collection.
- **Wallets between.** The wallets on a loop between seller and buyer.
- **Reach.** The wallets a collection's money has been walked to. The console
  says "Finding the wallets up to N wallets out".
- **Other tokens.** An edge type for payments in a fixed list of tokens (USDC,
  USDT, DAI and APE on Ethereum; USDC and DAI on Base; none elsewhere), with no
  smallest amount: washtrace has no prices.
- **Payees.** The wallets a trader paid in those tokens; reading their tokens too
  is off by default (`tokens.payees`).
- **Bridge.** The paper's fix for missing transfers: an unobserved edge from a
  token's last holder to the next sender. Never flagged or counted; the console
  does not name it.
- **Custody.** A contract holding a token without owning it, such as a Blur Blend
  loan. A → escrow → B is one hop A → B; A → escrow → A is none.
- **Read again.** Reading a trader's money and other tokens a second time after
  it trades again (`follow.reread`, off by default).

## Pages

| Route | Content | Refresh |
|---|---|---|
| `/` | Watched collections, each with the share of its sales and volume that looks washed (Round trips to Linked wallets) and how complete the reading is. A form to watch another. | 15 s |
| `/c/{chain}/{address}` | One collection: how far it has been read, the answer as that range, a tab per lens, each lens's share over time, and the six stages of the reading. | 15 s |
| `/c/{chain}/{address}/flagged` | Every token or wallet one lens flags, most flagged first. `?method=AU&kind=wallets&page=2`. | On open |
| `/c/{chain}/{address}/trades` | The collection's trades, filtered by lens, market, price, date, wallet and token, with a CSV download. | On open |
| `/c/{chain}/{address}/t/{tokenId}` | One token: its verdict, the graph as in the paper's Figure 8, and every transfer. | On open |
| `/w/{chain}/{address}` | One wallet: how many of its trades are flagged, whether its money has been read, and who it moved money with. | On open |
| `/tx/{chain}/{hash}` | One transaction's verdict. | On open |
| `/search?q=` | A collection name, token number (`#1234`), wallet address or transaction hash. The sidebar search goes to the one thing it finds (via `/go`), else here. | On open |
| `/settings` | The console settings in the [table below](#configuration), where each value came from, and a Test for the RPC and Etherscan. | On open |
| `/worker` | What needs a person, the four jobs, the sources, every collection's stages. | 5 s |

Times are clock times in the reader's time zone, changeable at the foot of the
sidebar.

## Your own lenses

A lens of yours sits beside the three methods on a collection's page; **Copy to
new lens** starts from one of them. The editor sets which edges may carry the way
back to the seller (NFT transfers, ETH, internal ETH, WETH including Blur Pool,
Other tokens), the wallets between seller and buyer, a time window, and which
trades it judges (sales, or every change of owner). **Advanced** shows the rest:
each edge's direction, limit, smallest payment and repeat rule, where the loop
closes, the order in time, how many loops a trade needs, and wallets a loop never
passes through.

**Data this lens needs** says which reads the rule is short of, money that many
wallets out or Other tokens; a button asks the worker for them, and the share
reads "so far" meanwhile. **Preview** tries the unsaved rule on a sample of 2,000
sales (`PREVIEW_SAMPLE`) and compares its catch with Round trips. **Save and
run** queues the lens's run. The lens routes are in [doc/api.md](doc/api.md).

## Configuration

Both services read the same variables; in Compose they share one `.env`. A
setting saved in the console wins over `.env` and applies from the worker's next
pass.

| Variable | Console setting | Purpose |
|---|---|---|
| `WASHTRACE_STORE_URL` | | Postgres for the `washtrace` schema. Required; `DATABASE_URL` is read if unset. |
| `WASHTRACE_RPC_<chainId>` | `rpc.1` (Ethereum only) | JSON-RPC URL per chain, such as `WASHTRACE_RPC_8453`. Finding a deployment block needs archive state; otherwise pass `fromBlock`. |
| `WASHTRACE_ETHERSCAN_KEY` | `etherscan.key` | Etherscan API V2 key, one for every chain. Without it, SCC AU and AC use only a stored money trail. |
| `WASHTRACE_ETHERSCAN_RPS` | `etherscan.rps` | Calls per second. Default 4; the free plan allows 5. |
| `WASHTRACE_ETHERSCAN_URL` | `etherscan.url` | Any API that answers Etherscan's account actions, such as Blockscout. Defaults to Etherscan V2. A console URL never receives a `.env` key ([why](doc/operating.md#etherscan-and-other-explorers)). |
| `WASHTRACE_FOLLOW_HOPS` | `follow.hops` | Hops of money followed out of a trader. Default 3, at most 10; 0 reads traders only, as the paper did. |
| `WASHTRACE_FOLLOW_REREAD` | `follow.reread` | "Read traders again (days)", 0 to 365. Default 0, off. Read a trader's money and other tokens again when it trades, at most once every this many days ([how](doc/operating.md#reading-traders-again)). |
| `WASHTRACE_TOKENS_PAYEES` | `tokens.payees` | "Read tokens of wallets paid in tokens". `on` also reads the tokens of wallets traders paid in them, up to 25 more reads per trader. Anything but `on` is off. |
| `WASHTRACE_STORED_REPO` | `stored.repo` | Hugging Face dataset to download stored data from, `owner/name`. Default `jonathanmiro97/washtrace-data`. |
| `WASHTRACE_STORED_DIR` | | Where stored data is kept. Defaults to `data/stored`; `/app/data/stored` in the images. |
| `WASHTRACE_USERNAME`, `WASHTRACE_PASSWORD` | | Basic auth on every route but `/api/health`. Set both or neither; one alone gives 503. |
| `WASHTRACE_PORT` | | Port Compose publishes the console and API on. Default 8080. |
| `PORT` | | The api's listen port. 8080 in the image. |
| `WASHTRACE_WORKER_PORT` | | The worker's health check port. Default 8081. |

## Deploying

The [Dockerfile](Dockerfile) builds two images (`--target worker` and
`--target api`), and [docker-compose.yml](docker-compose.yml) runs them over
Postgres 17. Both migrate the schema on boot. On a public host, set
`WASHTRACE_USERNAME` and `WASHTRACE_PASSWORD`: without them every write is
accepted only from the machine itself. Health checks, scaling, shutdown and the
worker's four jobs are in [doc/operating.md](doc/operating.md); what each
migration does at boot is in [doc/upgrading.md](doc/upgrading.md).

### The dataset

Reading a big collection from the chain takes days, so its data is cut once and
published to Hugging Face. When you watch a collection the dataset holds, the
worker downloads it, loads it, then reads on from the chain. The default dataset
holds six Ethereum collections, read through block 26299951 (October 2026):

| Collection | Address | Transfers | Money trail |
|---|---|---|---|
| Argonauts | [`0x387c…392c`](https://etherscan.io/address/0x387c41b0b2f1128de44db1bcf8baad085f26392c) | 1.3 MB | 321.0 MB |
| Terraforms | [`0x4e1f…0e56`](https://etherscan.io/address/0x4e1f41613c9084fdb9e34e11fae9412427480e56) | 2.9 MB | 621.8 MB |
| Meebits | [`0x7bd2…6bc7`](https://etherscan.io/address/0x7bd29408f11d2bfc23c34f18275bbf23bb716bc7) | 6.3 MB | 997.0 MB |
| Dreadfulz | [`0x81ae…5aa8`](https://etherscan.io/address/0x81ae0be3a8044772d04f32398bac1e1b4b215aa8) | 1.6 MB | 368.2 MB |
| BoredApeYachtClub | [`0xbc4c…f13d`](https://etherscan.io/address/0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d) | 10.9 MB | 955.8 MB |
| dotdotdot | [`0xce25…92c3`](https://etherscan.io/address/0xce25e60a89f200b1fa40f6c313047ffe386992c3) | 1.0 MB | 414.8 MB |

Each file is zstd-compressed CSV; a money trail is two files, and the table adds
their sizes. The [dataset card](https://huggingface.co/datasets/jonathanmiro97/washtrace-data)
gives the columns and a pandas example. How the worker loads it is in
[doc/stored-data.md](doc/stored-data.md).

## Known limits

- **Money is followed one way.** The worker follows money out of each trader,
  `follow.hops` deep, only through wallets that paid at most 25 others
  (`FOLLOW_FANOUT`). An exchange or a busy trader is not followed, so a path back
  through one stays unseen. Demo token #113 is the case this exists for: AU flags
  it, AC cannot.
- **Reads are a snapshot unless read again is on.** A wallet's money and Other
  tokens are read once, so a later payment is not seen. `follow.reread` reads a
  trader again when it trades again; wallets loaded from a stored money trail
  and wallets past Etherscan's 10,000-row page limit are never read again. See
  [doc/operating.md](doc/operating.md#reading-traders-again).
- **Other tokens are a fixed list** in the code, not the settings, and without
  `tokens.payees` a loop whose middle wallet was only paid in tokens can be
  missed.
- **Searches have caps.** A trade's money search stops at 5,000 edges and the
  share reads "at least"; a lens run holds at most 40 million money edges. All
  the caps are in [doc/operating.md](doc/operating.md#limits).
- **Funding is slow on purpose:** four Etherscan calls per wallet at four a
  second, so 30,000 wallets take about eight hours.
- **Sales on Blur, LooksRare v2 and X2Y2 are marked but not priced.** Blur v2
  packs the price into bit fields washtrace does not decode, and a guess would
  count as read volume. Their sales count; their volume does not.
- **ERC-1155 is not read.** The method depends on one token, one holder.

## Reference

- [The methods](doc/methods.md): each method on a demo token, what is never
  counted, the thresholds, and the placebo test.
- [Operating](doc/operating.md): deploying, the worker's jobs, reading traders
  again, and the limits.
- [API reference](doc/api.md): every route, its methods, status codes and keys.
- [Upgrading](doc/upgrading.md): what each migration does at boot.
- [Stored data](doc/stored-data.md): the files, the manifest, how a collection
  loads, and publishing.

## Citing

washtrace implements the methods of (Chow, 2023). GitHub's **Cite this
repository** reads [CITATION.cff](CITATION.cff).

```bibtex
@misc{chow2023washtrading,
  author = {Chow, Jonathan},
  title  = {Detecting and quantifying wash trading of non-fungible tokens},
  year   = {2023},
  url    = {https://github.com/jonathanchowjh/washtrace/blob/main/paper/chow-2023-detecting-and-quantifying-nft-wash-trading.pdf}
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

## License

The code is [MIT](LICENSE). The dataset is CC-BY-4.0. The paper and its slides
in [paper/](paper) are the author's, shared for reading and citing.
