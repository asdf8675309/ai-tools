#!/usr/bin/env bash
#
# sprint installer.
#
# Copies the skill into your Claude Code skills directory. Skills are
# auto-discovered, so there is nothing to wire up afterwards and this script
# never touches settings.json.
#
#   ./install.sh                  install the skill
#   ./install.sh --dry-run        show what would happen, change nothing
#   ./install.sh --uninstall      remove what this script installed
#   ./install.sh --yes            skip confirmation prompts
#   ./install.sh --help
#
# An existing installation is moved aside to a timestamped backup rather than
# overwritten — if you edited the skill in place, that edit survives.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SKILL_TARGET="$CONFIG_DIR/skills/sprint"

DRY_RUN=0
UNINSTALL=0
ASSUME_YES=0

usage() {
  /usr/bin/sed -n '3,17p' "${BASH_SOURCE[0]}" | /usr/bin/sed 's/^# \{0,1\}//'
  exit 0
}

warn() { printf '%s\n' "$*" >&2; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  would run: %s\n' "$*"
  else
    "$@"
  fi
}

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf '%s [y/N] ' "$1"
  read -r reply
  case "$reply" in [yY] | [yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --help | -h) usage ;;
    *)
      warn "unknown option: $1"
      exit 2
      ;;
  esac
  shift
done

if [ "$UNINSTALL" -eq 1 ]; then
  if [ ! -e "$SKILL_TARGET" ]; then
    echo "  Nothing installed at $SKILL_TARGET — nothing to do."
    exit 0
  fi
  confirm "  Remove $SKILL_TARGET?" || { echo "  Cancelled."; exit 0; }
  run rm -rf "$SKILL_TARGET"
  echo "  Removed. Sprint state under \${SPRINT_STATE_DIR:-\$HOME/.sprint} was left alone."
  exit 0
fi

if [ ! -d "$CONFIG_DIR" ]; then
  warn "  $CONFIG_DIR does not exist."
  warn "  cancel and re-run with CLAUDE_CONFIG_DIR=/your/path ./install.sh"
  confirm "  Create $CONFIG_DIR and continue?" || { echo "  Cancelled."; exit 0; }
fi

echo "  target: $SKILL_TARGET"

if [ -e "$SKILL_TARGET" ]; then
  warn "  Something is already installed at:"
  warn "  $SKILL_TARGET"
  confirm "  Move it aside to a timestamped backup and continue?" || { echo "  Cancelled."; exit 0; }
  backup="$SKILL_TARGET.backup.$(date -u +%Y%m%d%H%M%S)"
  run mv "$SKILL_TARGET" "$backup"
  echo "  previous install saved at $backup"
fi

run mkdir -p "$(dirname "$SKILL_TARGET")"
run cp -R "$SOURCE_DIR/skill" "$SKILL_TARGET"
run rm -rf "$SKILL_TARGET/node_modules"

echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "  Dry run — nothing was written. Re-run without --dry-run to install."
  exit 0
fi
echo "  Installed. Invoke it from inside a git repo with a GitHub remote:"
echo
echo "    /sprint 218 306 374      dispatch three engineers"
echo "    /sprint --plan 4 5 6 7 8 triage dependencies first"
echo "    /sprint status           what is running"
echo
echo "  State is written under \${SPRINT_STATE_DIR:-\$HOME/.sprint/state}."
