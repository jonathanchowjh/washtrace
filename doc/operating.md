# Operating washtrace

For whoever runs washtrace on a real chain for days at a time. It covers the deploy, what the worker does and
how fast, reading traders again, and the limits an operator meets. Settings are in the README's
[Configuration](../README.md#configuration) table, and what each migration does at boot is in
[upgrading.md](upgrading.md).

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
