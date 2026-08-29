#!/usr/bin/env bash
#
# A throwaway Postgres to cut stored data from, for `npm run publish:hub`.
# Publishing reads a restored copy of a pull's backup, never a live store.
#
#   scripts/publish-prep.sh [dump] [--schema-only]   # start, restore, migrate; print --store '<url>'
#   scripts/publish-prep.sh down                     # remove the container
#
# dump           A pg_dump custom-format file. Default: the newest
#                ~/washtrace-data/pull/backups/*.dump.
# --schema-only  Restore only the schema (pg_restore --schema-only): proves
#                an old dump migrates, without the disk a full restore takes.
#                Rows can then be added with psql in the container.
#
# Always a fresh container: if washtrace-publish-db exists, it refuses and
# says to run `down` first, so a restore never lands on top of an earlier
# one. The restore is one transaction that stops at the first error, so a
# bad dump leaves nothing half-restored. The password is random per
# container and appears only in the --store line on stdout; everything else
# goes to stderr.
set -euo pipefail

NAME="washtrace-publish-db"
IMAGE="${WASHTRACE_PUBLISH_IMAGE:-postgres:17-alpine}"
PORT="${WASHTRACE_PUBLISH_PORT:-55441}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 1; }

DUMP=""
SCHEMA_ONLY=""
for arg in "$@"; do
  case "$arg" in
    down)
      docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed ${NAME}" >&2 || echo "${NAME} not present" >&2
      exit 0 ;;
    --schema-only) SCHEMA_ONLY="--schema-only" ;;
    -*) echo "usage: $0 [dump] [--schema-only] | down" >&2; exit 2 ;;
    *) DUMP="$arg" ;;
  esac
done

if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t "$HOME"/washtrace-data/pull/backups/*.dump 2>/dev/null | head -1 || true)"
  [ -n "$DUMP" ] || { echo "no dump given and none in ~/washtrace-data/pull/backups" >&2; exit 1; }
fi
[ -f "$DUMP" ] || { echo "${DUMP} is not a file" >&2; exit 1; }

if [ -n "$(docker ps -aq -f "name=^${NAME}$")" ]; then
  echo "${NAME} already exists: run scripts/publish-prep.sh down first" >&2
  exit 1
fi

# Built first, so the migrate below is the current code.
npm run --prefix "$ROOT" --workspace @washtrace/worker build >&2

PASSWORD="$(openssl rand -hex 16)"
docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=washtrace -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
printf "waiting for readiness" >&2
READY=""
for _ in $(seq 1 60); do
  # Over TCP: the image's first-start server listens on the socket only, and is restarted before it serves the port.
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d washtrace >/dev/null 2>&1; then READY=1; break; fi
  printf "." >&2; sleep 1
done
echo >&2
[ -n "$READY" ] || { echo "${NAME} was not ready after 60 seconds" >&2; exit 1; }
URL="postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/washtrace"

echo "restoring $(basename "$DUMP") ${SCHEMA_ONLY}" >&2
docker exec -i "$NAME" pg_restore -U postgres -d washtrace --no-owner --no-privileges --single-transaction --exit-on-error $SCHEMA_ONLY < "$DUMP" >&2

node "$ROOT/apps/worker/dist/migrate.js" "$URL" >&2

echo "--store '${URL}'"
