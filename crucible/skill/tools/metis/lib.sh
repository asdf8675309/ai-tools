# shellcheck shell=bash
# shellcheck disable=SC2034
# Two directives, both because this file is sourced rather than executed:
#   shell=bash  — it has no shebang by design, so shellcheck cannot infer a dialect.
#   SC2034      — every CRUCIBLE_METIS_* value below is read by the five scripts
#                 that source this one (ensure-up, reap, run, scan, scan-diff),
#                 which shellcheck cannot see from here. They are not unused.
#
# Shared helpers for the Metis integration scripts. Sourced, never executed.
#
# Every value these scripts hand to `docker` comes from config.yaml by way of
# `Config.ts metis-env`, so quoting is load-bearing throughout, not stylistic.

# `-e` is deliberately absent: these scripts probe for things that are expected
# to be missing (no Docker, no container, no index), and a probe returning
# non-zero is information, not a failure. Callers check explicitly.
set -uo pipefail

CRUCIBLE_METIS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CRUCIBLE_TOOLS_DIR="$(cd -- "${CRUCIBLE_METIS_DIR}/.." && pwd)"

# Docker ownership is a per-machine fact, not a per-repo one — a sentinel under
# one repo's .crucible/ would be invisible to a reaper run from another repo,
# leaving an auto-started Docker running forever.
CRUCIBLE_METIS_STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/crucible/metis"
CRUCIBLE_METIS_SENTINEL="${CRUCIBLE_METIS_STATE_DIR}/docker-autostart.sentinel"
CRUCIBLE_METIS_SCAN_DIR="${CRUCIBLE_METIS_STATE_DIR}/scans"
CRUCIBLE_METIS_REAPER_LOG="${CRUCIBLE_METIS_STATE_DIR}/reaper.jsonl"

metis_say() { printf '%s\n' "$*" >&2; }

metis_is_macos() { [ "$(uname -s 2>/dev/null)" = "Darwin" ]; }

# Returns non-zero when the state directory could not be created — callers that
# depend on it (metis_scan_begin) report rather than continuing blind.
metis_state_init() {
  mkdir -p "$CRUCIBLE_METIS_STATE_DIR" "$CRUCIBLE_METIS_SCAN_DIR" 2>/dev/null
}

# Repo root for a path, falling back to the path itself outside a work tree.
metis_repo_root() {
  local dir="${1:-$PWD}" root
  root="$(cd "$dir" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$root" ]; then printf '%s' "$root"; else (cd "$dir" 2>/dev/null && pwd); fi
}

# Load resolved Metis config into CRUCIBLE_METIS_* in the caller's shell.
# Always returns 0 — an unreadable config means "unavailable", never a crash.
metis_load_config() {
  local repo="${1:-$PWD}" raw filtered
  CRUCIBLE_METIS_AVAILABLE="false"
  CRUCIBLE_METIS_REASON="Crucible config not loaded"

  if ! command -v bun >/dev/null 2>&1; then
    CRUCIBLE_METIS_REASON="bun is not on PATH"
    return 0
  fi
  raw="$(cd "$repo" 2>/dev/null && bun "${CRUCIBLE_TOOLS_DIR}/Config.ts" metis-env "$repo" 2>/dev/null)"
  if [ -z "$raw" ]; then
    CRUCIBLE_METIS_REASON="could not read Crucible config"
    return 0
  fi
  # Defence in depth: only well-formed single assignments reach eval, whatever
  # the emitter printed. Config.ts guarantees one quoted assignment per line.
  filtered="$(printf '%s\n' "$raw" | grep -E "^CRUCIBLE_METIS_[A-Z0-9_]+='.*'$")"
  if [ -z "$filtered" ]; then
    CRUCIBLE_METIS_REASON="Crucible config produced no Metis settings"
    return 0
  fi
  eval "$filtered"
}

metis_daemon_up() { docker info >/dev/null 2>&1; }

metis_container_running() {
  local name="$1" running
  running="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -Fx -- "$name")"
  [ -n "$running" ]
}

# True while any container from the scan image is alive. Compared with `case`
# rather than a regex so an image name from config is never a pattern.
metis_scan_container_running() {
  local image scan="${CRUCIBLE_METIS_SCAN_IMAGE:-metis}"
  # Process substitution, not a pipe: a pipe would run the loop in a subshell
  # where `return 0` cannot report back.
  while IFS= read -r image; do
    case "$image" in
      "$scan" | "$scan":*) return 0 ;;
    esac
  done < <(docker ps --format '{{.Image}}' 2>/dev/null)
  return 1
}

# A scan registers its PID for the duration of the run. Checking live PIDs beats
# matching process names: the reaper stays correct however the caller is invoked.
metis_scan_begin() {
  # A PID file that did not get written makes this scan invisible to
  # metis_scans_active, which is what stops the reaper shutting Docker down
  # underneath a running scan. Still non-fatal — the scan works, it is just
  # unprotected — so it warns instead of exiting, and stops being silent.
  if ! metis_state_init || ! printf '%s\n' "$$" > "${CRUCIBLE_METIS_SCAN_DIR}/$$.pid" 2>/dev/null; then
    metis_say "→ metis: could not register this scan in ${CRUCIBLE_METIS_SCAN_DIR} — the reaper may stop Docker mid-scan"
  fi
}
metis_scan_end() { rm -f "${CRUCIBLE_METIS_SCAN_DIR}/$$.pid" 2>/dev/null; }

metis_scans_active() {
  local f pid
  [ -d "$CRUCIBLE_METIS_SCAN_DIR" ] || return 1
  for f in "$CRUCIBLE_METIS_SCAN_DIR"/*.pid; do
    [ -e "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 0; fi
    rm -f "$f" 2>/dev/null
  done
  return 1
}

# Escape a value for a double-quoted YAML scalar in the generated metis.yaml.
metis_yaml_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}
