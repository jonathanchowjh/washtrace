# API reference

The console's HTTP API, for clients that read verdicts or manage what is watched. It is served by the
`api` service (apps/web) under `/api`, plus one redirect route, `/go`. There are 28 route files under
`apps/web/app/api` with 34 method handlers, and `/go`.

Paths below use `{chain}` for a chain id (digits, such as `1`), `{address}` for a 0x address (any case; stored
lowercase), and `{tx}` for a 0x transaction hash (64 hex digits).

## Rules every route shares

**Bodies.** JSON in and out. Every JSON response carries `cache-control: no-store`. An error is
`{"error": "<sentence>"}` with the status below.

**Auth.** Set `WASHTRACE_USERNAME` and `WASHTRACE_PASSWORD` and every page and route but `/api/health`
needs HTTP basic auth.

| Status | When | Body |
|---|---|---|
| 401 | Basic auth is on and the credentials are missing or wrong. Carries `WWW-Authenticate: Basic realm="washtrace", charset="UTF-8"`. | Plain text, `Authentication required.` |
| 503 | Only one of the two variables is set, so every request is refused. | Plain text, naming the missing variable. |

**Writes.** A route that changes state (every `POST`, `PATCH` and `DELETE`, even those with no body worth
sending) applies these checks, in this order:

| Status | When |
|---|---|
| 403 | Basic auth is off and the request is not from the machine itself (`Host` is `localhost`, `127.0.0.1` or `[::1]`, with no `Forwarded` or `X-Real-IP` header). |
| 415 | `Content-Type` is not `application/json`. |
| 400 | The body is not valid JSON, or is not a JSON object. |

`GET /api/settings/check/{id}` is not a write but is refused with the same 403, because a Test's detail
describes the owner's sources.

**Other errors.** 503 when the server is missing a setting it needs (a ConfigError, such as no
`WASHTRACE_STORE_URL`), with a sentence saying what to set. 500 with the error's message for anything
else. A path that is not a chain id and a collection address is 404, as is a collection that is not
watched.

**Lens keys.** `?method=` on the collection route takes `A`, `AU` or `AC` (default `AC`) or the key of one of
your lenses, `L<id>` such as `L7`. Anything else reads as `AC`.

## Routes

### Collections

| Route | Body or query | Status | Top-level keys |
|---|---|---|---|
| `GET /api/collections` | | 200 | `collections`: every watched collection, with its ingest cursor, funding coverage, latest analysis, `priority`, `pausedAt`, and the stored-data fields below. |
| `POST /api/collections` | `{chainId, address, name?, fromBlock?}`. `name` is cut to 120 characters. Without `fromBlock` the worker finds the deployment block. | 201 new, 200 already watched, 400 | `id`, `chainId`, `address`, `created`, `warning` (set when the chain has no RPC, else absent) |
| `GET /api/collections/{chain}/{address}` | `?method=` | 200, 404 | `collection`, `method`, `history`, `tokens`, `wallets`, `lenses` |
| `DELETE /api/collections/{chain}/{address}` | | 200, 404, 409 when not paused first | `removed` |
| `POST /api/collections/{chain}/{address}/pause` | | 200, 404 | `paused` (true) |
| `POST /api/collections/{chain}/{address}/resume` | | 200, 404 | `paused` (false) |
| `GET /api/collections/{chain}/{address}/config` | | 200, 404 | `chainId`, `address`, `name`, `overrides`, `rules`, `priority` |
| `POST /api/collections/{chain}/{address}/config` | `{name?, rules?, priority?}`; any other key is 400. `rules` holds `minCycles`, `reachDepth`, `hubDegree`, `visitCap`, each a positive whole number or `null` for the default. A key left out is left alone. | 200, 400, 404 | as `GET .../config` |
| `POST /api/collections/{chain}/{address}/follow` | `{hops}`: a whole number from 1 to 10, above the global `follow.hops`. | 202 set, 200 already set (`set: false`), 400, 404 | `set` |
| `POST /api/collections/{chain}/{address}/tokens` | `{}` | 202 started, 200 already started (`started: false`), 404 | `started` |
| `GET /api/collections/{chain}/{address}/tokens/{tokenId}` | | 200, 404 (no such path, not watched, or no transfer of the token) | `collection`, `tokenId`, `transfers`, `middles`, `flows`, and the verdict keys |
| `GET /api/collections/{chain}/{address}/rings` | `page` | 200, 404 | `rings`, `total`, `page`, `pages` |
| `GET /api/collections/{chain}/{address}/rings/{anchor}` | | 200, 404 (not watched, or no ring has that anchor) | `line`, `wallets`, `walletsCut`, `tokens` |
| `GET /api/collections/{chain}/{address}/card` | exactly one of `wallet`, `token`, `ring` | 200, 400, 404 | `kind`, `judged`, and for a wallet `trades`, `flagged`, `rings`, `ring`; for a token `transfers`, `flagged`; for a ring `ring` |
| `GET /api/collections/{chain}/{address}/counts` | `method` (a lens key, Linked wallets when left out or unknown) | 200, 404 | `trades`, and that lens's `tokens` and `wallets`: each `null` when the lens has not run |

Notes:

- Pause and resume are idempotent. Delete is refused with 409 until the collection is paused; the delete drops
  its transfers and analyses, and keeps the funding read for its wallets, which is per chain.
- A changed rule queues the collection for a new analysis. `priority: true` checks its wallets' funding first.
- `GET /api/collections/{chain}/{address}` lists the 50 tokens and 50 wallets with the most trades caught
  under `method`, each `{rows, total}`. A lens that did not run lists none. `lenses` holds each lens of yours
  with its `run` on this collection (`run` is null when it has none).
- Rings ([methods.md](methods.md#rings)) are 20 a page, the most ETH first. Each is `{anchor, rank, wallets,
  sample, sales, floorSales, tokens, volumeWei, firstAt, lastAt}`: `anchor` is its smallest wallet and its name in
  the path, `sample` its first three wallets by address, `sales` its counted flagged sales and `floorSales` those
  Round trips flags. A ring's `wallets` are `{address, traded}`, `traded` false for one in between (joined by money only),
  at most 500 (`walletsCut` true past them); its `tokens` are `{tokenId, sales, volumeWei}`, the most ETH first.
- `.../card` is the console's hover card: a few counts, never a verdict. A wallet's `trades` and `flagged` are in
  this collection, and `ring` is the first of its `rings`; a token's `flagged` counts its transfers Round trips or
  Linked wallets flags. `judged` is false before the first analysis.
- Stored-data fields on a collection in `GET /api/collections`: `restoreNote` and `analysisError` say why its
  stored data did not load or its latest analysis failed, with when each is tried again (`restoreRetryAt`,
  `analysisRetryAt`); null when nothing failed. `downloadFile` (`transfers` or `trail`) and `downloadProgress`
  (0 to 1, null while the collection waits its turn) say what is downloading; `downloadNote` and
  `downloadRetryAt` say why a download failed and when it is tried again; `downloadMismatch` is the URL of the
  last download whose bytes did not match the manifest. `trailProgress` (0 to 1) says how far a downloaded
  money trail has loaded into the database; null when none is loading.

### Trades

`GET /api/collections/{chain}/{address}/trades` answers 200 or 404.

The query is the Trades page's address bar. The filters are `caught`, `not`, `market`, `pmin`, `pmax`,
`heldover`, `heldunder`, `ageover`, `ageunder`, `fmin`, `fmax`, `from`, `to`, `wallet`, `token`, `ring`, `group`,
`q`, `sort`, `dir` and `all`, and `page` for JSON. A filter on a lens that did not run holds no trades. `ring` is a
ring's anchor: the trades Round trips or Linked wallets flags through one of its witnesses.

| `format` | Response |
|---|---|
| none | One page of 20: `total`, `unjudged` (trades newer than the latest analysis), `page`, `pages`, `ran` (the lenses that ran), `through` (for each lens of yours in `ran`, the block its run read), `rows`. Rows carry lens codes. |
| `csv` | Every trade the filters hold, streamed as `text/csv` and named `<address>-trades.csv`. Read one row at a time, so a cancelled download closes its cursor. |

Limits on the CSV download:

| Limit | Value | What happens |
|---|---|---|
| Open downloads (`MAX_STREAMS`) | 3 | A fourth gets 429, `Too many downloads at once; try again in a minute.` |
| Reader stops pulling (`DOWNLOAD_STALL_MS`) | 65 seconds | The download is closed and its body errors. |
| Open too long (`STREAM_MAX_MS`) | 15 minutes | The body ends with the error `The download ran too long and was stopped.` (`DOWNLOAD_TOO_LONG`). |

A body that errors after its headers were sent reaches the client as a cut-off stream, not a status code: a
client that needs the whole file checks that the transfer ended cleanly. The columns are `date`, `token`,
`seller`, `buyer`, `price`, `currency`, `marketplace`, `held_seconds`, `buyer_age_seconds`, `price_vs_floor`, one
column per lens (the three built-ins, then yours), and `tx`. A field a spreadsheet would read as a formula gets a
leading `'`.

### Wallets, transactions and search

| Route | Query | Status | Top-level keys |
|---|---|---|---|
| `GET /api/wallets/{chain}/{address}` | `trades`, `partners`, `flows` (page numbers); `collection` (a collection address); `flagged=1`; `q`; `psort` (`flows`, `sent`, `received` or `watched`); `with` (another wallet) and `dir` (`sent` or `received`, both when left out) | 200, 404 | `chainId`, `address`, `funding`, `collections`, `counterparties`, `transfers`, `counts`, `pages`, `cut`, `between`, and the verdict keys |
| `GET /api/transfers/{chain}/{tx}` | | 200, 404 | `chainId`, `tx`, `transfers`, and the verdict keys |
| `GET /api/search` | `q`; `kind` (`collections`, `tokens`, `wallets` or `trades`) with `page`; `scope` (`<chain>:<address>`) | 200 | `collections`, `tokens`, `wallets`, `trades`, `more`, and with a scope `connected` |

- `scope` narrows a search to one watched collection: its tokens, and the wallets that traded in it. A full
  address, a transaction hash and collection names are searched everywhere still; a scope that names no watched
  collection narrows nothing. In a scoped search each wallet hit carries `here`, whether it traded in that
  collection: false only for one found by its full address.
- Each collection hit carries `totals`, its latest analysis's totals per lens (as in `GET /api/collections`), or
  `null` before the first analysis. The search page draws the range of washed sales from them.
- The start of a hex string (4 characters or more after `0x`) finds wallets and also trades whose transaction hash
  starts that way, in every collection: a trade's link needs every transfer of its transaction, so a scope never
  narrows trades. Each token hit carries `flagged`, true when Round trips or Linked wallets flagged one of its
  counted trades in the latest analysis; false says only that none is, not that it was judged clean.
- `connected` comes with a scoped search of every kind (no `kind`) whose best match, the first hit of the kind
  listed first, is a wallet on the scope's chain: `{wallet, rings, tokens}`, its first 3 rings there by rank
  (`{anchor, rank}`) and the 3 tokens it traded there most. The search box lists them under that wallet.

- A wallet page holds 20 money partners and 20 trades, newest first. `pages` gives each list's
  `{page, pages, total}` (a page past the last reads as the last); `counts` every trade it has and those counted
  flagged; `cut` which list has more than one page. With `with`, `between` holds the trades between the two
  (`trades`, the latest 20, of `tradesTotal`) and a page of 20 payments in `dir` (`flows` of `flowsTotal`);
  otherwise `between` is null. A wallet with no trades answers `washTrade: null, judged: false`.
- A transaction washtrace has not read is 404, never `washTrade: false`.
- Search `q` is a collection name, a token number (`#1234`), a wallet address or its start (`0x` and at least 4
  hex digits), or a transaction hash. Each kind answers at most 20 rows and `more` says which had another. Text
  that is not understood finds nothing; it is not an error.

**The verdict keys** are `washTrade`, `judged`, `methods`, `apartOnly` and `notRun`.

| Key | Meaning |
|---|---|
| `washTrade` | `true` when Round trips (`A`) or Linked wallets (`AC`) flags it. `null` with `judged: false` is read but not yet covered by an analysis, which is not the same as clean. |
| `judged` | An analysis covers it. |
| `methods` | Every lens that ran and flagged it. Money loops back (`AU`) is listed here but not counted in `washTrade`. |
| `apartOnly` | Only Money loops back flags it: shown, not counted. |
| `notRun` | The lenses that did not run in some transfer's analysis. A lens that did not run is never in `methods`. |

### Settings

The keys are `rpc.1`, `etherscan.key`, `etherscan.rps`, `etherscan.url`, `follow.hops`, `tokens.payees`,
`follow.reread` and `stored.repo`.

| Route | Body | Status | Top-level keys |
|---|---|---|---|
| `GET /api/settings` | | 200 | `writable`, `open` (saving needs no login), `fields`, `trailFunded` |
| `POST /api/settings` | `{key, value}`; `value: null` clears the key, so `.env` applies, else the default. `value` is otherwise a string. | 200, 400 (unknown key, bad value), 409 | `key`, `set` |
| `POST /api/settings/check` | `{kind: "rpc", chainId}` or `{kind: "etherscan"}` | 201, 400 | `id` |
| `GET /api/settings/check/{id}` | | 200, 403, 404 | `finished`, `ok`, `detail` |

- `fields` ends with a read-only `rpc.<chainId>` entry for each other chain the worker reports an RPC for: only
  `.env` sets those, and the API saves no RPC but Ethereum's (`rpc.1`). `POST /api/settings/check` tests the RPC of
  any chain the console knows; the worker tests the URL it reads, and says so when it has none.
- Each entry of `fields` has `key`, `label`, `secret`, `set`, `shown`, `source`, `env` (what `.env` holds,
  masked the same way), `locked`, `pinned` and `invalid`. A secret answers as `••••` and at most its last 4
  characters (an RPC URL also keeps its scheme and host); a client can replace or clear a secret and never read
  it.
- `follow.reread` is a whole number of days from 0 to 365 (label `Read traders again (days)`); 0, the default,
  is off.
- `POST /api/settings` answers 409 for a non-null `etherscan.url` while the Etherscan key comes from `.env`.
  Clearing a key is always allowed. A saved value beats the environment's.
- A Test is run by the worker, not the API. `chainId` must be one with an RPC setting. Poll
  `GET /api/settings/check/{id}` until `finished`.

### Lenses

Lenses are the rules you write yourself. `rule` is the lens rule the editor builds; a rule that fails its
check is 400 with the reason.

| Route | Body | Status | Top-level keys |
|---|---|---|---|
| `POST /api/lenses` | `{name, rule, chainId, address}`, or `collections: [{chainId, address}]` (1 to 100) in place of `chainId` and `address` to queue a run on each | 201, 400, 404 (collection not watched), 409 (name taken) | `lens` |
| `PATCH /api/lenses/{id}` | `{name, rule, chainId?, address?}` or `collections`; each collection named gets a run queued | 200, 400, 404, 409 | `lens` |
| `DELETE /api/lenses/{id}` | | 200, 404 | `deleted` |
| `POST /api/lenses/{id}/runs` | `{chainId, address}` | 202, 404 | `queued` |
| `POST /api/lenses/previews` | `{chainId, address, rule}` | 202, 400, 404, 409 (no sales to sample, or not analyzed yet) | `id` |
| `GET /api/lenses/previews/{id}` | | 200, 404 | the preview: `id`, `collectionId`, `rule`, `status`, `progress`, `result`, `error`, `requestedAt`, `finishedAt` |

- `{id}` is the lens's number (digits). The key `L<id>` and the built-in keys are not ids.
- A lens name must be new, a built-in's name included.
- Editing a lens moves its version and queues its runs again. Creating one queues its run on the collection.
- A preview is a sample run of an unsaved rule. Poll it until it finishes. It is 404 once it is swept (an hour
  after it was asked for) or its collection is removed.

### Spot checks

One transaction judged without watching its collection: the worker reads its receipt, each of its tokens'
histories, and the money of its sellers, buyers and the wallets that could join them, at the start of a fund pass
and between wallets in one. The console's Check this transaction button uses these two routes.

| Route | Body or query | Status | Top-level keys |
|---|---|---|---|
| `POST /api/spots` | `{chainId, tx, lens?}`. `chainId` a number, `tx` a 0x hash, `lens` a key of yours such as `L7`. | 200, 202, 400, 404 | 200: `status: 'done'`, `result`. 202: `id`, `status`, `reused`. |
| `GET /api/spots/{id}` | | 200, 404 | `id`, `chainId`, `tx`, `lens`, `status` (`queued`, `running`, `done`, `failed`), `result`, `error`, `requestedAt`, `finishedAt` |

- **200 at once.** With no `lens`, a transaction every transfer of which a watched collection's latest analysis
  judged is answered from the store, `result.source: 'watched'`. That answer holds only the transfers of
  collections you watch: a token of another collection in the same transaction is not in it. With a lens it is
  always queued: stored verdicts hold only the built-ins.
- **Reuse.** A check of the same transaction, with the same lens at the same version, that is queued or running is
  shared (`reused: true`), so two requests at once make one check. A done one is answered again for an hour when
  its block was final. A failed one is asked again.
- **400** for a bad `chainId`, `tx` or `lens`, and for a lens a spot check cannot run, with the sentence: `This lens
  uses Other tokens, which a spot check does not read.` or `This lens follows other tokens in the collection, which
  a spot check does not read.` **404** `No such lens.` and `No such spot check.` (swept a day after it was asked).
- **A failed check's `error`** says why: `No such transaction on chain N.`, `This transaction reverted.`, `This
  transaction moved only ERC-1155 tokens, which washtrace does not read.`, `This transaction moved no ERC-721
  token.`, `This transaction holds no trade: a mint, a burn or a move into or out of custody.`, `No RPC is configured
  for chain N. Set WASHTRACE_RPC_N.`, `Reading the history of token N took longer than a spot check allows: this RPC
  answers only narrow log queries.`, `That lens was removed.`, `That lens was edited; ask again.`

**The result** has the verdict keys' meaning, in one shape for both sources:

| Key | Meaning |
|---|---|
| `washTrade` | `true` when a counted method flags a trade (Round trips or Linked wallets; with a lens, that lens). `false` only when each of them ran on every trade, nothing is `atLeast`, and none flagged. Otherwise `null`. |
| `methods` | The counted methods, or the lens, that flagged. |
| `notRun` | What could not run: `AU` always on a spot check; `AC` (or the lens) without an Etherscan key or when a seller's or buyer's money could not be read. |
| `atLeast` | Some of it could not be judged: more than 10 tokens moved, a possible middle wallet moved money with more than 20 wallets or could not be read, more than 200 other transactions joined the wallets (a payment whose receipt is not read is left out, since it may be another sale's price), a lens needs money further out than the sellers and buyers, or a lens skipped a trade (one no marketplace filled, when it judges sales; an untimed one, under a window or loop order) or its search hit its cap. |
| `finalized` | The transaction's block was final when read. A check of one that was not is never reused. |
| `source` | `spot` or `watched`. |
| `transfers` | The transaction's transfers, each with its `collection` and `flags`: a built-in's witness as in the verdict keys, or a lens's `{path, wallets}`. |

### Status

| Route | Status | Top-level keys |
|---|---|---|
| `GET /api/status` | 200 | `jobs`, `collections`, `funding`, `config`, `notices` |
| `GET /api/worker` | 200 | `every`, `rpcChains`, `funding`, `followHops`, `trailFunded`, `passes`, `jobs`, `notices`, `backlog`, `collections` |
| `GET /api/health` | 200, 503 | `ok` |

- `/api/status` gives each job's `state` (`never`, `running`, `ok`, `failed` or `stalled`) and last `outcome`,
  each collection's `turn` and lag, the funding backlog, and `notices`.
- `/api/worker` adds each job's last pass, the funding backlog per chain, and which sources are configured
  (never their values). `funding` is null while there is no Etherscan key. Its `perSecond` and `followHops` are
  null while the worker runs on its defaults. Each collection also carries `stages`: its six stages, each with a
  `state` and a `share`.
- `/api/health` is `{ok: true}` when the store answers and `{ok: false}` with 503 when it does not. It needs no
  login, for the container's health check.

**Notices.** A notice is `{severity, text}`, its severity `needs-you`, `working` or `info`. A `needs-you` one
also says what to do (`doThis`, maybe with an `href`); the others may carry `action: {label, href}`. Working
and info notices are there while all is well, so a monitor alerts on
`notices.some(n => n.severity === 'needs-you')`. An empty `needs-you` list does not mean the worker is
reading: a missing RPC or Etherscan key is an `info` notice, a limit to lift and not a failure, so a monitor
that wants to know reading is moving looks at the other notices and at `stages` too.

**Funding backlog**, one entry per chain in `/api/worker`:

| Key | Meaning |
|---|---|
| `pending`, `failed` | Wallets the worker will check, and those whose check failed and will be retried. |
| `stale` | Wallets already read that are marked to be read again (`follow.reread`). Marked only while `follow.reread` is above 0. |
| `stranded` | Wallets held back while their collections are paused or removed, or followed further out than the follow limit. |
| `done`, `doneLastHour` | Wallets checked, and those checked in the last hour. |
| `truncated`, `followed` | Wallets whose history passed Etherscan's cap, and wallets followed past the traders. |
| `etaMs` | How long the pending ones take at the last hour's rate; null until known. |

### Redirect

`GET /go?q=<text>&chain=<id>` is the sidebar's search. It answers 303 to a console page and never a JSON body:
a transaction hash goes to `/tx/{chain}/{hash}`, a watched collection's address to `/c/{chain}/{address}`, any
other address to `/w/{chain}/{address}`, and text to the one thing it finds, or to `/search?q=` when it finds
none or several. With no `chain`, a hash or address is searched for as text is and goes to the chain that holds
it; an address nothing holds opens its wallet page on chain 1.
