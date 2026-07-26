#!/usr/bin/env bash
# Quit a Docker that this integration auto-started, once Metis has been idle
# long enough, reclaiming the VM's memory.
#
#   reap.sh [repo-dir]
#
# No-op unless the sentinel says WE started Docker — a Docker the user launched
# is never touched. Safe to run on a timer, and safe under parallel reviews: it
# refuses while any scan container or scan process is still alive.
set -uo pipefail

# shellcheck source=./lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

log() {
  mkdir -p "$CRUCIBLE_METIS_STATE_DIR" 2>/dev/null
  printf '{"ts":"%s","event":"%s","detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "${2:-}" >> "$CRUCIBLE_METIS_REAPER_LOG" 2>/dev/null
}

# 1. Only ever act on a Docker we started.
[ -f "$CRUCIBLE_METIS_SENTINEL" ] || exit 0

REPO_ROOT="$(metis_repo_root "${1:-$PWD}")"
metis_load_config "$REPO_ROOT"

IDLE_MINUTES="${CRUCIBLE_METIS_IDLE_REAP_MINUTES:-10}"
if [ "$IDLE_MINUTES" = "0" ]; then
  log disabled
  exit 0
fi

command -v docker >/dev/null 2>&1 || exit 0

# 2. Daemon already down — the work is done, clear the marker.
if ! metis_daemon_up; then
  rm -f "$CRUCIBLE_METIS_SENTINEL"
  log daemon-already-down
  exit 0
fi

# 3. Parallel safety. Touching the sentinel restarts the idle clock, so a live
#    scan keeps Docker warm instead of racing the reaper.
if metis_scan_container_running; then
  touch "$CRUCIBLE_METIS_SENTINEL"
  log active-scan-container
  exit 0
fi
if metis_scans_active; then
  touch "$CRUCIBLE_METIS_SENTINEL"
  log active-scan-process
  exit 0
fi

# 4. Idle gate — sentinel mtime is the last-activity clock.
if [ -z "$(find "$CRUCIBLE_METIS_SENTINEL" -mmin +"$IDLE_MINUTES" 2>/dev/null)" ]; then
  log still-warm
  exit 0
fi

log reaping "idle>${IDLE_MINUTES}m"
if [ -n "${CRUCIBLE_METIS_COMPOSE_DIR:-}" ] && [ -d "$CRUCIBLE_METIS_COMPOSE_DIR" ]; then
  (cd "$CRUCIBLE_METIS_COMPOSE_DIR" && docker compose stop) >/dev/null 2>&1
fi
if metis_is_macos; then
  osascript -e 'quit app "Docker Desktop"' >/dev/null 2>&1 \
    || osascript -e 'quit app "Docker"' >/dev/null 2>&1
fi
rm -f "$CRUCIBLE_METIS_SENTINEL"
log reaped
exit 0
