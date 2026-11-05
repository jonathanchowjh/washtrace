# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb>=1.1", "huggingface_hub>=0.25"]
# ///
# Downloads the first N Parquet shards of NFT-70M (MLNTeam-Unical/NFT-70M_transactions,
# CC BY-NC 4.0) and reduces them to one sorted, gzipped CSV of Ethereum ERC-721
# sales: $NFT70M_DIR/sales.csv.gz (default ~/washtrace-data/nft70m), with the
# header contract,token,ts,seller,buyer,price,currency.
# Run: uv run scripts/nft70m/extract.py --shards 1
#
# Whole files are downloaded and queried locally: DuckDB's range requests on
# hf:// paths hit the Hub's rate limit within one query.
import argparse
import os
from pathlib import Path

import duckdb
from huggingface_hub import list_repo_files, snapshot_download

REPO = "MLNTeam-Unical/NFT-70M_transactions"
DIR = Path(os.environ.get("NFT70M_DIR", "~/washtrace-data/nft70m")).expanduser()

parser = argparse.ArgumentParser()
parser.add_argument("--shards", type=int, default=10, help="first N shards by file name")
args = parser.parse_args()
if args.shards < 1:
    raise SystemExit("--shards must be at least 1")

names = sorted(f for f in list_repo_files(REPO, repo_type="dataset") if f.startswith("data/") and f.endswith(".parquet"))
names = names[: args.shards]
if not names:
    raise SystemExit(f"no data/*.parquet shards found in {REPO}")
(DIR / "tmp").mkdir(parents=True, exist_ok=True)
snapshot_download(repo_id=REPO, repo_type="dataset", local_dir=f"{DIR}/raw", allow_patterns=names)

paths = ", ".join(f"'{DIR}/raw/{n}'" for n in names)
out = f"{DIR}/sales.csv.gz"
db = duckdb.connect()
db.execute(f"SET temp_directory = '{DIR}/tmp'")
# floor says what is meant: whole seconds. The dataset has no block number or
# log index, so chainOrder in rows.mjs alone decides the order of sales within
# a second. The seller and buyer in the ORDER BY make the file the same on every
# run, and so make chainOrder's file-order fallbacks (rule 1's last tie-break
# and rule 3) the same on every run.
# The dataset repeats sales: rows identical in contract, token, ts, seller,
# buyer, price and currency cannot both be real unless the token went b->a and
# back within that second, which the data cannot tell apart, so such a pair is
# kept once (a repeated a->b reads as a round trip through the engine's gap
# bridge, last buyer to next seller). Same-second repeats that differ only in
# price survive DISTINCT and are bridged like any gap; that is accepted as rare.
scope = "chain = 'ethereum' AND token_type = 'ERC721' AND asset_type = 'simple'"
db.execute(f"""
COPY (
  SELECT DISTINCT contract_address AS contract, token_id AS token,
         floor(epoch(CAST(tx_timestamp AS TIMESTAMP)))::BIGINT AS ts,
         seller_account AS seller, winner_account AS buyer, price, token AS currency
  FROM read_parquet([{paths}])
  WHERE {scope}
  ORDER BY contract, token, ts, seller, buyer
) TO '{out}' (HEADER, COMPRESSION gzip)
""")
in_scope = db.execute(f"SELECT count(*) FROM read_parquet([{paths}]) WHERE {scope}").fetchone()[0]
written = db.execute(f"SELECT count(*) FROM read_csv('{out}')").fetchone()[0]
print("rows written:", written, "| repeated rows removed:", in_scope - written)
print("ethereum rows left out, by token_type and asset_type:")
print(db.execute(f"""
  SELECT token_type, asset_type, count(*) AS n FROM read_parquet([{paths}])
  WHERE chain = 'ethereum' AND NOT (token_type = 'ERC721' AND asset_type = 'simple')
  GROUP BY ALL ORDER BY n DESC
""").fetchall())
