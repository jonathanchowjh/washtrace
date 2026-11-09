# Stored data

For people who use the dataset and for the maintainer who publishes it. A big collection takes days to read
from the chain, so its chain data is cut once and published to a Hugging Face dataset, by default
[`jonathanmiro97/washtrace-data`](https://huggingface.co/datasets/jonathanmiro97/washtrace-data)
(`STORED_REPO` in hub.ts). The files are zstd-compressed CSV, so the data reads without washtrace too.

## Files

A collection has up to three files, named `<chainId>-<address>.<part>.csv.zst` with the address lowercased. A
file starts with its header row. Null is an empty field. No value holds a comma or a line break.

| Part | Holds | Columns |
|---|---|---|
| `transfers` | The collection's transfers. | `tx_hash`, `log_index`, `block_number`, `block_time`, `token_id`, `from_address`, `to_address`, `marketplace`, `price_wei`, `currency` |
| `wallets` | The wallets whose payments were read to the end of their history when checked. A collection's money trail is this file and the next. | `address` |
| `flows` | The payments those wallets made or received. | `tx_hash`, `kind`, `from_address`, `to_address`, `value_wei`, `token`, `block_number`, `block_time` |

The columns are the tables' own, in the order of [migrations.ts](../packages/detect/src/migrations.ts), without
the store's keys (`collection_id`, `chain_id`): the manifest says which collection and chain a file is. Read the
files with `dtype=str` (pandas) or the equivalent, so that `price_wei`, `value_wei` and `token_id` keep their
full precision.

Only chain data is published: transfers, the money trail's flows, the checked wallets' addresses, and each
collection's address, chain and contract name. Never a wallet's status or errors, a label you gave a collection,
or any setting or key.

## The manifest

`manifest.json` lists every collection with stored data. A worker reads only **version 3**; a version 1 or 2
manifest is refused as unreadable, and the chain is read instead until the dataset is published again.

| Field | Meaning |
|---|---|
| `version` | `3`. |
| `revision` | The Hub commit (40 hex digits) the manifest was fetched at, so the files fetched next are from the same publish. Absent in a manifest cut locally. |
| `collections[]` | One entry per collection, sorted by chain id, then address. |

Each entry:

| Field | Meaning |
|---|---|
| `chainId`, `address` | The collection. The address is lowercase hex. |
| `name` | The contract's own `name()`, else its address. Never the label you gave it in the console. |
| `startBlock` | The collection's start block. |
| `throughBlock`, `throughTime` | The collection's cursor when it was cut, and the time of the latest transfer at or below it, in milliseconds. The file holds every transfer up to that block. |
| `transfers` | `{file, rows, bytes, sha256}` of the transfers file. |
| `trail` | `null`, or `{rows, wallets, checked, of, bytes, sha256, files}`. `rows` counts flows, `wallets` the checked list's length, and `checked` of `of` is how many of the collection's traders are on that list. `bytes` is the two files' sizes added. `files` is `{wallets: {bytes, sha256}, flows: {bytes, sha256}}`. |

**The trail sha.** A trail's `sha256` is the sha256 of its two files' sha256s joined by a colon:
`sha256("<wallets sha256>:<flows sha256>")` (`trailSha` in stored.ts). A worker records it in
`collections.trail_imported_sha` when it has loaded the trail, so a trail loads once and a trail that is cut again
loads again. The manifest is refused if a trail's `bytes` or `sha256` is not what its two files add up to.

## The dataset card

The publish writes the dataset's `README.md` from the manifest (`datasetCard` in stored.ts), so it cannot list a
collection the manifest does not, nor columns other than the ones written. It holds:

- front matter (`license: cc-by-4.0`) declaring three tables, one `configs` entry each: `transfers`, `wallets`
  and `flows`, with one split per collection. The Hub's viewer opens them as such. A split is the collection's name
  lowercased, runs of other characters made one underscore; a name that leaves nothing, or that another
  collection's leaves too, falls back to `c<chainId>_<address>`;
- a table of the collections: name, address, chain id, through block, last transfer date, checked wallets, and
  the sizes of the transfers file and the trail;
- each file's columns, and how to read them with pandas (`pip install pandas zstandard`) and with the `datasets`
  library (`load_dataset(repo, table, split=...)`).

## How a collection gets its stored data

The worker does these in the background. The console shows each step.

1. **Ask the Hub.** The worker fetches the dataset's manifest about hourly, and at once when a collection is
   newly watched. It keeps the last one, so an unreachable Hub only means the chain is read instead. The
   dataset is `WASHTRACE_STORED_REPO`, or the console's `stored.repo` setting, which wins over the environment.
2. **Download.** If the manifest holds the collection, the worker downloads its files into `WASHTRACE_STORED_DIR`
   (default `data/stored`): the transfers first, then the trail's two files. Every download is pinned to the
   manifest's `revision`, checked against its sha256, and written to a `.part` file, so a restart resumes it
   from the bytes it has. Files download one at a time across every replica.
3. **Load the transfers.** The worker loads the transfers into the database, then reads on from the chain where
   they stop (`throughBlock`).
4. **Import the trail.** The money trail's flows go in first, batch by batch, then the checked wallets. A big
   trail takes over an hour for the biggest collections. Progress is kept (`trail_resume`, `trail_progress`), so
   a restart goes on from the last batch it wrote. When it is in, the analysis runs again. A trail gives
   Money loops back and Linked wallets their money without an Etherscan key.

The wallets a trail import adds are marked checked (`status = 'done'`) with no read time (`fetched_at` null). A
wallet with no read time is never marked to be read again by `follow.reread`.

When the worker stops, a download picks up from the bytes it has, and half-downloaded files the manifest no
longer names are deleted, as are the old single trail files of a version 2 dataset.

| Case | What happens |
|---|---|
| A file does not match its checksum | Its `.part` is deleted and the collection's note says the Hub does not match its manifest. The URL is remembered (`download_mismatch`), and that file is not downloaded again, by any worker or after a restart, before the dataset is published again. The chain is read meanwhile. A download that had resumed from kept bytes is the exception: it is downloaded again from its start, as the bytes kept may be what broke. |
| A download fails | The collection's note says so and it is tried again later: five minutes, doubling with each failure in a row, up to an hour. |
| The disk is full | The note says so; it is tried again later. |
| A download makes no progress for 2 minutes | It is given up and fails. |
| A trail import writes nothing for 15 minutes | It is given up and fails. |
| The trail on disk does not match the manifest, or cannot be read | It is not loaded, and not tried again until the file changes. |
| The Hub has no public dataset | The cached manifest is replaced by an empty one, and the chain is read. |

## Cleaning up

Delete `data/stored/`. Under Compose the folder is the named volume `stored`, written by the worker and mounted
read only into the api: stop the services and run `docker volume rm <project>_stored`. Under Compose,
`WASHTRACE_STORED_DIR` must match the volume's mount (`/app/data/stored`), or the worker and the api look in
different places.

## Publishing (maintainers)

Publishing cuts a restored copy of a pull's backup, never a live store. It needs a Hugging Face token that can
write to the dataset, `HF_TOKEN`, from `.env` or the environment; the token is never printed.

| Command | What it does |
|---|---|
| `scripts/publish-prep.sh [dump] [--schema-only]` | Starts a throwaway Postgres container (`washtrace-publish-db`, port 55441 by default), restores a `pg_dump` custom-format file into it (default: the newest `~/washtrace-data/pull/backups/*.dump`), migrates it with the current worker build, and prints `--store '<url>'`. It refuses if the container exists. `--schema-only` restores only the schema. |
| `scripts/publish-prep.sh down` | Removes the container. |
| `npm run stored -- <chainId>/<address> [--trail]` | Cuts one collection from the store the worker reads into `data/stored/` (`WASHTRACE_STORED_DIR`): its transfers file and, with `--trail`, the two trail files, and writes the manifest entry. Without `--trail` an existing trail entry is kept. It only reads the store. The worker's hourly fetch replaces that manifest, so a local cut is for publishing, not for serving. |
| `npm run publish:hub -- --store <url> [--dry-run] [<chainId>/<address> ...]` | Cuts the named collections (or every collection that is not paused) with their trails from the prep store, and commits them with the merged manifest and the regenerated card in one commit. It refuses a store whose schema is not current, and never migrates. The commit also deletes every `.csv.zst` at the repo root that the merged manifest does not name. `--dry-run` writes the files to `./publish-dry` and only reads the Hub. |
| `npm run publish:hub -- --from <dir> [--check \| --replace]` | Uploads a folder a dry run wrote, after reading every row of it against its manifest. `--check` only verifies and needs no token. `--replace` publishes over a Hub manifest that cannot be read (a version 2 one): the folder's manifest replaces it and the files of collections not in the folder are deleted. |

- `WASHTRACE_STORED_REPO` sets the target dataset. The token must belong to the dataset's owner.
- A publish of named collections merges into the Hub's manifest; it does not drop the others. Over a Hub manifest
  that is not version 3, naming collections is refused: publish every collection, or use `--from <dir> --replace`.
- Publishing with `--from` is refused if the Hub has a newer cut (higher `throughBlock`) of a collection in the
  folder.
- `--from` takes no `--store`, `--dry-run` or names.
