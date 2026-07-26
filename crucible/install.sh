#!/usr/bin/env bash
#
# Crucible installer.
#
# Copies the skill into your Claude Code skills directory. Does not install the
# enforcement hooks and does not modify settings.json unless you explicitly ask
# for it, and even then it prints the change and waits for you to apply it.
#
#   ./install.sh                 install the skill
#   ./install.sh --with-hooks    also stage the enforcement hooks
#   ./install.sh --dry-run       show what would happen, change nothing
#   ./install.sh --uninstall     remove what this script installed
#   ./install.sh --yes           skip confirmation prompts
#   ./install.sh --help

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SKILL_TARGET="$CONFIG_DIR/skills/crucible"
HOOKS_TARGET="$CONFIG_DIR/hooks/crucible"

WITH_HOOKS=0
DRY_RUN=0
UNINSTALL=0
ASSUME_YES=0

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
err()  { printf '\033[31m%s\033[0m\n' "$1" >&2; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then echo "  would: $*"; else "$@"; fi; }

usage() {
  sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$DRY_RUN" -eq 1 ] && return 1
  printf '%s [y/N] ' "$1"
  read -r reply </dev/tty || return 1
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --with-hooks) WITH_HOOKS=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    --uninstall)  UNINSTALL=1 ;;
    --yes|-y)     ASSUME_YES=1 ;;
    --help|-h)    usage ;;
    *) err "Unknown option: $1"; err "Try --help"; exit 2 ;;
  esac
  shift
done

# ── Uninstall ────────────────────────────────────────────────────────────────

if [ "$UNINSTALL" -eq 1 ]; then
  bold "Uninstall"
  found=0
  for dir in "$SKILL_TARGET" "$HOOKS_TARGET"; do
    if [ -e "$dir" ]; then found=1; echo "  found: $dir"; fi
  done
  if [ "$found" -eq 0 ]; then
    echo "  Nothing installed at $CONFIG_DIR — nothing to do."
    exit 0
  fi
  if confirm "Remove the directories listed above?"; then
    for dir in "$SKILL_TARGET" "$HOOKS_TARGET"; do
      [ -e "$dir" ] && run rm -rf "$dir"
    done
    echo
    warn "Removed. If you added Crucible hook entries to settings.json, remove them by hand —"
    warn "this script does not edit settings.json, so it will not edit it back."
  else
    echo "  Cancelled. Nothing removed."
  fi
  exit 0
fi

# ── Preflight ────────────────────────────────────────────────────────────────

bold "Crucible installer"
echo

if ! command -v bun >/dev/null 2>&1; then
  err "Bun is required (the deterministic tools are Bun scripts): https://bun.sh"
  exit 1
fi

bun_version="$(bun --version)"
bun_major="${bun_version%%.*}"
bun_rest="${bun_version#*.}"
bun_minor="${bun_rest%%.*}"
if [ "$bun_major" -lt 1 ] || { [ "$bun_major" -eq 1 ] && [ "$bun_minor" -lt 3 ]; }; then
  err "Bun >= 1.3.0 required (found $bun_version) — the skill uses Bun's built-in YAML parser."
  exit 1
fi
echo "  bun $bun_version"

if [ ! -d "$SOURCE_DIR/skill" ]; then
  err "Cannot find the skill directory next to this script. Run it from inside the cloned repo."
  exit 1
fi

if [ ! -d "$CONFIG_DIR" ]; then
  warn "  $CONFIG_DIR does not exist."
  warn "  That is where Claude Code keeps its configuration. If yours lives elsewhere,"
  warn "  cancel and re-run with CLAUDE_CONFIG_DIR=/your/path ./install.sh"
  confirm "  Create $CONFIG_DIR and continue?" || { echo "  Cancelled."; exit 0; }
fi

echo "  target: $SKILL_TARGET"
[ "$DRY_RUN" -eq 1 ] && warn "  DRY RUN — nothing will be written"
echo

# ── Skill ────────────────────────────────────────────────────────────────────

if [ -e "$SKILL_TARGET" ]; then
  warn "A crucible skill is already installed at:"
  warn "  $SKILL_TARGET"
  echo
  echo "  Reinstalling replaces it. Local edits you made there — including any"
  echo "  customised config.yaml — will be lost."
  echo
  if ! confirm "  Back it up and replace?"; then
    echo "  Cancelled. Nothing changed."
    exit 0
  fi
  backup="$SKILL_TARGET.backup.$(date +%Y%m%d%H%M%S)"
  echo "  backing up to $backup"
  run mv "$SKILL_TARGET" "$backup"
fi

run mkdir -p "$(dirname "$SKILL_TARGET")"
run cp -R "$SOURCE_DIR/skill" "$SKILL_TARGET"
run rm -rf "$SKILL_TARGET/node_modules"
echo "  installed skill"

# ── Hooks (opt-in) ───────────────────────────────────────────────────────────

if [ "$WITH_HOOKS" -eq 1 ]; then
  echo
  bold "Enforcement hooks"
  echo
  echo "  These make code review non-skippable. Before you agree, read what they do:"
  echo
  echo "    - A Stop hook records that a genuine review ran, keyed to your current"
  echo "      branch AND commit."
  echo "    - A PreToolUse hook BLOCKS 'gh pr create' unless that record exists."
  echo
  warn "  Consequence worth understanding: any new commit invalidates a prior review."
  warn "  Review, then commit one more fix, and you must review again before opening"
  warn "  the PR. That is intended — the new commit is genuinely unreviewed — but it"
  warn "  will surprise you at least once."
  echo
  echo "  This hook can block a command you expected to succeed. A documented bypass"
  echo "  exists and is described in hooks/README.md. Docs-only diffs pass without a"
  echo "  review record."
  echo
  if confirm "  Stage the hooks?"; then
    run mkdir -p "$(dirname "$HOOKS_TARGET")"
    [ -e "$HOOKS_TARGET" ] && run rm -rf "$HOOKS_TARGET"
    run cp -R "$SOURCE_DIR/hooks" "$HOOKS_TARGET"
    echo "  staged hooks at $HOOKS_TARGET"
    echo
    warn "  NOT YET ACTIVE. This script does not edit settings.json — that file is"
    warn "  yours, and a script that silently rewrites it is a script you should not"
    warn "  have run. Add the block printed in hooks/README.md to activate them."
  else
    echo "  Skipped. The skill works fine without them."
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo
if [ "$DRY_RUN" -eq 1 ]; then
  bold "Dry run complete — nothing was written."
else
  bold "Done."
fi
echo
echo "  Start a new Claude Code session in any git repo and say:"
echo
echo "      review my changes"
echo
echo "  Configuration:  $SKILL_TARGET/config.yaml"
echo "  Per-repo tuning: drop a .crucible.yaml at a repo root"
echo "  Uninstall:      ./install.sh --uninstall"
echo
