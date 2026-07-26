#!/usr/bin/env bash
# Bring Docker and the Metis Postgres container up for a scan.
#
#   ensure-up.sh [repo-dir]
#
# Exit 0 once Postgres is confirmed accepting connections; non-zero if it could
# not be brought up, which the caller treats as "skip Metis", never as an error.
#
# When it starts Docker itself it records ownership in a sentinel, so reap.sh
# only ever quits a Docker this integration started.
set -uo pipefail

# shellcheck source=./lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

WAIT_DAEMON=60   # seconds to wait for the daemon after launching it
WAIT_PG=45       # seconds to wait for Postgres to accept connections

REPO_ROOT="$(metis_repo_root "${1:-$PWD}")"
metis_load_config "$REPO_ROOT"

if [ "$CRUCIBLE_METIS_AVAILABLE" != "true" ]; then
  metis_say "→ metis/ensure-up: not available — ${CRUCIBLE_METIS_REASON}"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  metis_say "→ metis/ensure-up: docker is not on PATH"
  exit 1
fi

metis_state_init

# 1. Daemon. The ownership sentinel is written BEFORE the launch, so a crash
#    mid-start still leaves a marker the reaper can act on.
if ! metis_daemon_up; then
  if [ "${CRUCIBLE_METIS_AUTOSTART_DOCKER}" != "true" ]; then
    metis_say "→ metis/ensure-up: Docker daemon is down and autostart_docker is off"
    exit 1
  fi
  if ! metis_is_macos; then
    metis_say "→ metis/ensure-up: Docker daemon is down — start it and re-run (autostart is macOS-only)"
    exit 1
  fi
  metis_say "→ metis/ensure-up: Docker daemon down — launching Docker Desktop…"
  printf 'autostarted %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CRUCIBLE_METIS_SENTINEL"
  open -a Docker
  i=0
  while [ "$i" -lt $((WAIT_DAEMON / 2)) ]; do
    metis_daemon_up && break
    sleep 2
    i=$((i + 1))
  done
  if ! metis_daemon_up; then
    metis_say "✗ metis/ensure-up: daemon did not come up within ${WAIT_DAEMON}s"
    exit 1
  fi
  metis_say "→ metis/ensure-up: daemon up"
fi

# 2. Postgres. A clean reap leaves the container stopped, so bring it up
#    explicitly rather than trusting a restart policy.
if ! metis_container_running "$CRUCIBLE_METIS_POSTGRES_CONTAINER"; then
  if [ ! -d "$CRUCIBLE_METIS_COMPOSE_DIR" ]; then
    metis_say "✗ metis/ensure-up: compose_dir does not exist: ${CRUCIBLE_METIS_COMPOSE_DIR}"
    exit 1
  fi
  metis_say "→ metis/ensure-up: starting ${CRUCIBLE_METIS_POSTGRES_CONTAINER}…"
  if ! (cd "$CRUCIBLE_METIS_COMPOSE_DIR" && docker compose up -d) >&2; then
    metis_say "✗ metis/ensure-up: docker compose up failed in ${CRUCIBLE_METIS_COMPOSE_DIR}"
    exit 1
  fi
fi

# 3. Wait for Postgres to actually accept connections — running is not ready.
i=0
while [ "$i" -lt $((WAIT_PG / 2)) ]; do
  docker exec "$CRUCIBLE_METIS_POSTGRES_CONTAINER" \
    pg_isready -U "$CRUCIBLE_METIS_DB_USER" -d "$CRUCIBLE_METIS_DB_NAME" >/dev/null 2>&1 && break
  sleep 2
  i=$((i + 1))
done
if ! docker exec "$CRUCIBLE_METIS_POSTGRES_CONTAINER" \
     pg_isready -U "$CRUCIBLE_METIS_DB_USER" -d "$CRUCIBLE_METIS_DB_NAME" >/dev/null 2>&1; then
  metis_say "✗ metis/ensure-up: ${CRUCIBLE_METIS_POSTGRES_CONTAINER} not ready within ${WAIT_PG}s"
  exit 1
fi

# 4. Refresh the idle clock ONLY if the sentinel exists. Its absence means the
#    daemon was already up — someone else's Docker, which must never be reaped.
[ -f "$CRUCIBLE_METIS_SENTINEL" ] && touch "$CRUCIBLE_METIS_SENTINEL"

metis_say "✓ metis/ensure-up: ${CRUCIBLE_METIS_POSTGRES_CONTAINER} ready"
exit 0
