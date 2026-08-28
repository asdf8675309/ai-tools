#!/usr/bin/env bash
#
# runaway installer.
#
# Stages the tool, a config file, and a LaunchAgent plist. It does not load the
# LaunchAgent — it prints the one command that does, for you to run. A watchdog
# that installs itself into your login session without you typing anything is a
# watchdog you will find running months later and not remember agreeing to.
#
#   ./install.sh                 stage everything, then print the launchctl command
#   ./install.sh --dry-run       show every path it would touch, change nothing
#   ./install.sh --yes           skip the confirmation prompt
#   ./install.sh --uninstall     remove what this script installed
#   ./install.sh --help
#
# Nothing here needs sudo, and nothing runs as root. runaway is a LaunchAgent:
# it runs as you and can only signal your own processes.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LABEL="local.runaway"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/runaway"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/runaway"
CONFIG_FILE="$CONFIG_DIR/runaway.conf"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/runaway"
LOG_FILE="$STATE_DIR/runaway.log"
BIN_DIR="$HOME/.local/bin"
BIN_LINK="$BIN_DIR/runaway"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"

DRY_RUN=0
ASSUME_YES=0
UNINSTALL=0

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
err() { printf '\033[31m%s\033[0m\n' "$1" >&2; }
run() { if [ "$DRY_RUN" -eq 1 ]; then printf '  would: %s\n' "$*"; else "$@"; fi; }

usage() {
  awk 'NR > 2 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit 0
}

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$DRY_RUN" -eq 1 ] && return 1
  printf '%s [y/N] ' "$1"
  read -r reply </dev/tty || return 1
  case "$reply" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --help | -h) usage ;;
    *) err "unknown option: $1"; exit 2 ;;
  esac
  shift
done

if [ "$UNINSTALL" -eq 1 ]; then
  bold "Uninstalling runaway"
  printf '\n'
  if [ -e "$PLIST" ]; then
    warn "Unload the LaunchAgent first, if you loaded it:"
    printf '\n    launchctl bootout gui/%s/%s\n\n' "$(id -u)" "$LABEL"
  fi
  run rm -f "$PLIST"
  run rm -f "$BIN_LINK"
  run rm -rf "$DATA_DIR"
  printf '\n'
  # Neither is removed: the config is yours, and the log is the record of what
  # this thing did to your processes. Deleting either on the way out is how you
  # lose the answer to "what killed my build last Tuesday".
  printf 'Left in place, delete them yourself if you want them gone:\n'
  printf '  %s\n  %s\n' "$CONFIG_FILE" "$LOG_FILE"
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
  err "runaway is macOS-only: it reads swap through sysctl vm.swapusage and installs a LaunchAgent."
  err "The decision logic is portable and its tests run anywhere, but this installer is not."
  exit 1
fi

for tool in ps awk sysctl df launchctl; do
  command -v "$tool" >/dev/null 2>&1 || { err "missing required tool: $tool"; exit 1; }
done

bold "runaway — what this will do"
printf '\n'
printf '  stage      %s/bin, %s/lib\n' "$DATA_DIR" "$DATA_DIR"
printf '  symlink    %s -> %s/bin/runaway.sh\n' "$BIN_LINK" "$DATA_DIR"
if [ -e "$CONFIG_FILE" ]; then
  printf '  config     %s   (exists, left untouched)\n' "$CONFIG_FILE"
else
  printf '  config     %s   (from runaway.conf.example)\n' "$CONFIG_FILE"
fi
printf '  state      %s\n' "$STATE_DIR"
printf '  log        %s\n' "$LOG_FILE"
printf '  plist      %s   (staged, NOT loaded)\n' "$PLIST"
printf '\n'

if [ "$DRY_RUN" -eq 0 ] && ! confirm "Proceed?"; then
  printf 'Nothing changed.\n'
  exit 0
fi

run mkdir -p "$DATA_DIR/bin" "$DATA_DIR/lib" "$CONFIG_DIR" "$STATE_DIR" "$BIN_DIR" "$AGENT_DIR"
run cp "$SOURCE_DIR/bin/runaway.sh" "$DATA_DIR/bin/runaway.sh"
run cp "$SOURCE_DIR/lib/policy.sh" "$DATA_DIR/lib/policy.sh"
run chmod +x "$DATA_DIR/bin/runaway.sh"
run ln -sf "$DATA_DIR/bin/runaway.sh" "$BIN_LINK"

if [ -e "$CONFIG_FILE" ]; then
  printf '  keeping your existing %s\n' "$CONFIG_FILE"
else
  run cp "$SOURCE_DIR/runaway.conf.example" "$CONFIG_FILE"
fi

# sed rather than a heredoc so the template in the repo stays a real, readable
# plist instead of a string with holes in it.
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  would: write %s from launchd/runaway.plist.template\n' "$PLIST"
else
  sed \
    -e "s|__LABEL__|$LABEL|g" \
    -e "s|__PROGRAM__|$DATA_DIR/bin/runaway.sh|g" \
    -e "s|__CONFIG__|$CONFIG_FILE|g" \
    -e "s|__STATE_DIR__|$STATE_DIR|g" \
    -e "s|__LOG__|$LOG_FILE|g" \
    "$SOURCE_DIR/launchd/runaway.plist.template" >"$PLIST"
fi

printf '\n'
[ "$DRY_RUN" -eq 1 ] && { bold "Dry run — nothing was changed."; exit 0; }

bold "Staged."
printf '\n'
printf 'Look before you load it. Neither of these changes anything.\n\n'
printf 'First — which probes this machine actually lets a non-root user read. A probe\n'
printf 'that reads "unavailable" is a rule that will not fire:\n\n'
printf '    %s probes\n\n' "$BIN_LINK"
printf 'Then what it can see and what it would do right now:\n\n'
printf '    %s status\n\n' "$BIN_LINK"
printf 'Then, when the thresholds look right for your machine:\n\n'
printf '    launchctl bootstrap gui/%s %s\n\n' "$(id -u)" "$PLIST"
printf 'To stop it:\n\n'
printf '    launchctl bootout gui/%s/%s\n\n' "$(id -u)" "$LABEL"
printf 'Log:  %s\n' "$LOG_FILE"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add it, or call $DATA_DIR/bin/runaway.sh directly." ;;
esac
