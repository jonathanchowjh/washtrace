#!/usr/bin/env bash
#
# A throwaway Postgres for development. Not for production.
#
#   ./scripts/dev-db.sh up      # start (idempotent) and print the store URL
#   ./scripts/dev-db.sh down    # stop and remove
#   ./scripts/dev-db.sh psql    # open psql inside the container
#
# A port of its own, so it runs beside pg-ops' dev database on 55432.
set -euo pipefail

NAME="washtrace-dev"
IMAGE="${WASHTRACE_DEV_IMAGE:-postgres:17-alpine}"
PORT="${WASHTRACE_DEV_PORT:-55433}"
URL="postgres://postgres:secret@localhost:${PORT}/washtrace"

command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 1; }

case "${1:-up}" in
  up)
    if [ -z "$(docker ps -q -f "name=^${NAME}$")" ]; then
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker run -d --name "$NAME" -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=washtrace -p "${PORT}:5432" "$IMAGE" >/dev/null
      printf "waiting for readiness"
      for _ in $(seq 1 30); do
        docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break
        printf "."; sleep 1
      done
      echo
    fi
    echo "export WASHTRACE_STORE_URL='${URL}'"
    ;;
  down) docker rm -f "$NAME" >/dev/null 2>&1 && echo "removed ${NAME}" || echo "${NAME} not present" ;;
  psql) docker exec -it "$NAME" psql -U postgres -d washtrace ;;
  *) echo "usage: $0 {up|down|psql}" >&2; exit 1 ;;
esac
