# Operating washtrace

For whoever runs washtrace on a real chain for days at a time. It covers every setting, the deploy, what the
worker does and how fast, reading traders again, and the limits an operator meets. What each migration does at
boot is in [upgrading.md](upgrading.md).

## Settings

Both services read the same variables; in Compose they share one `.env`, and
[.env.example](../.env.example) is the same list as a template. A setting saved in the console wins over `.env`
and applies from the worker's next pass.

| Variable | Console setting | Purpose |
|---|---|---|
| `WASHTRACE_STORE_URL` | | Postgres for the `washtrace` schema. Required; `DATABASE_URL` is read if unset. |
| `WASHTRACE_RPC_<chainId>` | `rpc.1` (Ethereum only) | JSON-RPC URL per chain, such as `WASHTRACE_RPC_8453`. Finding a deployment block needs archive state; otherwise pass `fromBlock`. |
| `WASHTRACE_ETHERSCAN_KEY` | `etherscan.key` | Etherscan API V2 key, one for every chain. Without it, Money loops back and Linked wallets use only a stored money trail. |
| `WASHTRACE_ETHERSCAN_RPS` | `etherscan.rps` | Calls per second. Default 4; the free plan allows 5. |
| `WASHTRACE_ETHERSCAN_URL` | `etherscan.url` | Any API that answers Etherscan's account actions, such as Blockscout. Defaults to Etherscan V2. A console URL never receives a `.env` key ([why](#etherscan-and-other-explorers)). |
| `WASHTRACE_FOLLOW_HOPS` | `follow.hops` | Hops of money followed out of a trader. Default 3, at most 10; 0 reads traders only, as the paper did. |
| `WASHTRACE_FOLLOW_REREAD` | `follow.reread` | "Read traders again (days)", 0 to 365. Default 0, off. Read a trader's money and other tokens again when it trades, at most once every this many days ([how](#reading-traders-again)). |
| `WASHTRACE_TOKENS_PAYEES` | `tokens.payees` | "Read tokens of wallets paid in tokens". `on` also reads the tokens of wallets traders paid in them, up to 25 more reads per trader. Anything but `on` is off. |
| `WASHTRACE_STORED_REPO` | `stored.repo` | Hugging Face dataset to download stored data from, `owner/name`. Default `jonathanmiro97/washtrace-data`. |
| `WASHTRACE_STORED_DIR` | | Where stored data is kept. Defaults to `data/stored`; `/app/data/stored` in the images. |
| `WASHTRACE_USERNAME`, `WASHTRACE_PASSWORD` | | Basic auth on every route but `/api/health`. Set both or neither; one alone gives 503. |
| `WASHTRACE_PORT` | | Port Compose publishes the console and API on. Default 8080. |
| `PORT` | | The api's listen port. 8080 in the image. |
| `WASHTRACE_WORKER_PORT` | | The worker's health check port. Default 8081. |

## Deploying

The [Dockerfile](../Dockerfile) builds two images (`--target worker` and `--target api`), and
[docker-compose.yml](../docker-compose.yml) runs them over Postgres 17.

- **Schema.** Both services migrate the `washtrace` schema on boot, so there is no separate migration step.
- **Health.** `GET :8081/health` on the worker, `GET /api/health` on the api.
- **Auth.** On a public host, set `WASHTRACE_USERNAME` and `WASHTRACE_PASSWORD`. Without them the console is
  open to read, and every write is accepted only from the machine itself. Compose publishes the port to
  127.0.0.1 only; publish it wider once basic auth is on.
- **Project name.** Compose names its volumes after the folder, so renaming the folder starts an empty project.
  Set `COMPOSE_PROJECT_NAME` to the old name, or pass `-p`.
- **Stored data.** Give the worker a writable volume at `WASHTRACE_STORED_DIR` and mount it read only into the
  api.
- **Shutdown.** On `SIGTERM` the worker gives passes in flight 8 seconds, then exits. Postgres rolls back an
  unfinished pass.
- **Scaling.** `docker compose up --scale api=3 --scale worker=2`. Each worker pass takes its job's advisory
  lock without waiting, so a second worker gives failover, not double reads.

## The worker's jobs

The worker runs four jobs on timers. A pass that is due while the last one is still running is skipped, not
queued.

| Job | Every | Does |
|---|---|---|
| **ingest** | 60 s | Loads stored data, then reads transfers forward to the finalized head. |
| **fund** | 5 s | Reads who paid whom for traders, then follows their money out. |
| **analyze** | 60 s | Runs the three methods on a collection whose data changed. |
| **lens** | with analyze | Runs your lenses and previews. A preview goes first; a lens run gives way to a due analysis for up to 10 minutes. |

**Funding is slow on purpose.** Each wallet costs about four Etherscan calls, at four calls a second
(`etherscan.rps`), so 30,000 wallets take about eight hours. Traders are read before followed wallets, busiest
first, so a collection's own funding is never delayed by following.

**Pause** keeps a collection's data, stops its stored-data download and import, and stops the worker serving
its wallets. A wallet's Etherscan read already in flight can't be cancelled; one that ends after the pause does
not queue the collection for analysis.

## Reading traders again

By default a wallet's money and Other tokens are read once, and a later payment is not seen. Set
`follow.reread` ("Read traders again (days)", `WASHTRACE_FOLLOW_REREAD`) to a number of days, from 1 to 365, to
change that:

- When a trader trades again more than that many days after its last read, ingest marks it to be read again.
- The re-read starts 7,200 blocks (about a day on Ethereum) before the block its last read reached, so rows the
  last read missed are read too. Only what is new is stored, and a re-read that adds nothing changes no
  collection.
- A wallet last read before migration #34 has no block recorded, so its first re-read reads it in full.
- A re-read costs about 4 Etherscan calls, plus about 1 more for the token read.
- Turning it off (0) stops new re-reads. Any already due are read once.

**What is never read again:**

- A wallet loaded from a stored money trail has no read time, and ingest skips it.
- A wallet whose read hit Etherscan's page limit (10,000 rows) is truncated. It stops being followed, and a
  re-read that hits the limit stops it too.

## Etherscan and other explorers

`etherscan.url` (`WASHTRACE_ETHERSCAN_URL`) points the worker at any API that answers Etherscan's account
actions, such as Blockscout. One rule protects the key: while the key comes from `.env` and none is saved in
the console, a URL saved in the console is ignored, so a console edit can't send the `.env` key elsewhere.

## Limits

| Limit | Value | When it is hit |
|---|---|---|
| A trade's money search | 5,000 edges (`SEARCH_CAP`) | The trade is never called clean for it, and the share reads "at least". |
| A lens run's money edges | 40 million (`MONEY_EDGE_CEILING`) | The run fails, saying so. Terraforms' 37 million fit. |
| Wallets between seller and buyer in a lens | 6 (`MAX_HOPS`) | The rule is refused. |
| `follow.hops` | 10 (`MAX_FOLLOW_HOPS`) | A larger value in `.env` reads as the default, 3. |
| Wallets a followed wallet may have paid | 25 (`FOLLOW_FANOUT`) | Its money is not followed further. |
| CSV downloads at once | 3 (`MAX_STREAMS`) | A fourth gets 429. A download ends after 65 seconds unread, or 15 minutes open. |
| An analysis, lens run or preview in its thread | 1 hour (`ANALYZE_TIMEOUT_MS`, `LENS_TIMEOUT_MS`) | The thread is stopped, and the run fails, saying it took too long. |
