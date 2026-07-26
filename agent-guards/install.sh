#!/usr/bin/env bash
#
# agent-guards installer.
#
# Stages the guards you pick into your Claude Code hooks directory and prints
# the settings.json block that activates them. It does not edit settings.json —
# that file is yours, and a script that rewrites it silently is a script you
# should not have run.
#
#   ./install.sh --list                    show every guard and what it does
#   ./install.sh --guards a,b,c            stage only those guards
#   ./install.sh --all                     stage all of them
#   ./install.sh --guards a --dry-run      show what would happen, change nothing
#   ./install.sh --uninstall               remove what this script installed
#   ./install.sh --yes                     skip confirmation prompts
#   ./install.sh --help
#
# Running it with no arguments prints the list and stops. Installing everything
# is a choice you make on purpose, not the path of least resistance.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
TARGET="$CONFIG_DIR/hooks/agent-guards"

DRY_RUN=0
UNINSTALL=0
ASSUME_YES=0
LIST_ONLY=0
SELECTED=""

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
err()  { printf '\033[31m%s\033[0m\n' "$1" >&2; }
run()  { if [ "$DRY_RUN" -eq 1 ]; then echo "  would: $*"; else "$@"; fi; }

usage() { sed -n '3,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$DRY_RUN" -eq 1 ] && return 1
  printf '%s [y/N] ' "$1"
  read -r reply </dev/tty || return 1
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# slug~file~event~matcher~blocks?~one-line description
# Delimiter is ~ and not | because matcher values contain | (a Claude Code
# matcher is an alternation), and a delimiter that appears inside a field is a
# parser that silently produces wrong fields rather than an error.
GUARDS='
misleading-check~block-misleading-check.ts~PreToolUse~Bash~BLOCKS~bare tsc --noEmit, a verify command in the wrong worktree, a check piped into tail
public-repo~block-public-repo.ts~PreToolUse~Bash~BLOCKS~any command that would make a repository public
egress~block-egress.ts~PreToolUse~Bash~BLOCKS~a credential in an outbound command, and curl piped to a shell
leaks~block-leaks.ts~PreToolUse~Write|Edit|MultiEdit|NotebookEdit~BLOCKS~writes carrying strings you declared private (needs a .agent-guards-forbidden file)
unverified-claim~block-unverified-claim.ts~Stop~~BLOCKS~ending a turn that claims success the transcript does not support
task-flood~block-task-flood.ts~TaskCreated~~BLOCKS~runaway subagent spawning (needs a harness that emits TaskCreated)
loops~warn-loops.ts~PostToolUse~~warns~repeated, oscillating, or hammering tool calls
repeat~warn-repeat.ts~UserPromptSubmit~~warns~the user restating a request, which means intent was missed
injection~warn-injection.ts~PostToolUse~WebFetch|WebSearch~warns~prompt-injection patterns in fetched external content
'

guard_line() { printf '%s\n' "$GUARDS" | grep "^$1~" || true; }
all_slugs() { printf '%s\n' "$GUARDS" | grep -v '^$' | cut -d'~' -f1; }

guard_field() {
  local line="$1" n="$2"
  case "$n" in
    file)    printf '%s\n' "$line" | cut -d'~' -f2 ;;
    event)   printf '%s\n' "$line" | cut -d'~' -f3 ;;
    matcher) printf '%s\n' "$line" | cut -d'~' -f4 ;;
    blocks)  printf '%s\n' "$line" | cut -d'~' -f5 ;;
    desc)    printf '%s\n' "$line" | cut -d'~' -f6- ;;
  esac
}

print_list() {
  bold "Available guards"
  echo
  printf '  %-18s %-8s %s\n' "GUARD" "ACTION" "WHAT IT CATCHES"
  while IFS= read -r slug; do
    [ -z "$slug" ] && continue
    line="$(guard_line "$slug")"
    printf '  %-18s %-8s %s\n' "$slug" "$(guard_field "$line" blocks)" "$(guard_field "$line" desc)"
  done <<EOF
$(all_slugs)
EOF
  echo
  echo "  Read README.md before installing anything marked BLOCKS — each one can"
  echo "  refuse a command you expected to succeed, and each one has an escape hatch."
  echo
  echo "  Then:  ./install.sh --guards misleading-check,public-repo"
  echo "     or: ./install.sh --all"
  echo
}

while [ $# -gt 0 ]; do
  case "$1" in
    --list)      LIST_ONLY=1 ;;
    --all)       SELECTED="$(all_slugs | tr '\n' ',')" ;;
    --guards)    shift; SELECTED="${1:-}" ;;
    --guards=*)  SELECTED="${1#--guards=}" ;;
    --dry-run)   DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --yes|-y)    ASSUME_YES=1 ;;
    --help|-h)   usage ;;
    *) err "Unknown option: $1"; err "Try --help"; exit 2 ;;
  esac
  shift
done

# ── Uninstall ────────────────────────────────────────────────────────────────

if [ "$UNINSTALL" -eq 1 ]; then
  bold "Uninstall"
  if [ ! -e "$TARGET" ]; then
    echo "  Nothing installed at $TARGET — nothing to do."
    exit 0
  fi
  echo "  found: $TARGET"
  if confirm "Remove it?"; then
    run rm -rf "$TARGET"
    echo
    warn "  Removed. Your settings.json still references these hooks — remove those"
    warn "  entries by hand. This script never edited that file, so it will not"
    warn "  edit it back. Until you do, Claude Code will log a missing-hook error."
    echo
    echo "  Leftover scratch state (harmless, ephemeral):"
    echo "    rm -rf \"\${TMPDIR:-/tmp}/agent-guards\""
  else
    echo "  Cancelled. Nothing removed."
  fi
  exit 0
fi

if [ "$LIST_ONLY" -eq 1 ] || [ -z "$SELECTED" ]; then
  print_list
  exit 0
fi

# ── Preflight ────────────────────────────────────────────────────────────────

bold "agent-guards installer"
echo

if ! command -v bun >/dev/null 2>&1; then
  err "Bun is required (the guards are Bun scripts): https://bun.sh"
  exit 1
fi
echo "  bun $(bun --version)"

if [ ! -d "$SOURCE_DIR/hooks" ]; then
  err "Cannot find the hooks directory next to this script. Run it from inside the cloned repo."
  exit 1
fi

# Validate every requested slug BEFORE touching anything, so a typo cannot
# produce a half-installed set.
CHOSEN=""
IFS=','
for slug in $SELECTED; do
  slug="$(printf '%s' "$slug" | tr -d '[:space:]')"
  [ -z "$slug" ] && continue
  if [ -z "$(guard_line "$slug")" ]; then
    unset IFS
    err "Unknown guard: $slug"
    err "Run ./install.sh --list to see the available guards."
    exit 2
  fi
  CHOSEN="$CHOSEN$slug "
done
unset IFS

if [ -z "$CHOSEN" ]; then
  err "No guards selected."
  exit 2
fi

echo "  target: $TARGET"
[ "$DRY_RUN" -eq 1 ] && warn "  DRY RUN — nothing will be written"
echo
bold "Selected"
for slug in $CHOSEN; do
  line="$(guard_line "$slug")"
  printf '  %-8s %-18s %s\n' "$(guard_field "$line" blocks)" "$slug" "$(guard_field "$line" desc)"
done
echo

if printf '%s' "$CHOSEN" | grep -q .; then
  for slug in $CHOSEN; do
    if [ "$(guard_field "$(guard_line "$slug")" blocks)" = "BLOCKS" ]; then
      warn "  Some of these BLOCK commands. A blocked command exits 2 and does not run."
      warn "  Every one has a documented bypass, and every bypass prints to stderr when"
      warn "  used — see README.md. If you have not read it, cancel and read it."
      echo
      break
    fi
  done
fi

if [ ! -d "$CONFIG_DIR" ]; then
  warn "  $CONFIG_DIR does not exist."
  warn "  That is where Claude Code keeps its configuration. If yours lives elsewhere,"
  warn "  cancel and re-run with CLAUDE_CONFIG_DIR=/your/path ./install.sh"
  confirm "  Create $CONFIG_DIR and continue?" || { echo "  Cancelled."; exit 0; }
fi

if [ -e "$TARGET" ]; then
  warn "  agent-guards is already installed at $TARGET"
  echo "  Reinstalling replaces the staged files. Any local edits there will be lost."
  echo "  Your settings.json is not touched either way."
  echo
  confirm "  Replace the staged files?" || { echo "  Cancelled. Nothing changed."; exit 0; }
fi

# ── Stage ────────────────────────────────────────────────────────────────────
# Idempotent: the destination is rebuilt from scratch each run, so installing
# the same set twice leaves exactly the same tree.

run mkdir -p "$TARGET/lib"
run cp "$SOURCE_DIR/hooks/lib/shared.ts" "$TARGET/lib/shared.ts"

needs_transcript_lib=0
for slug in $CHOSEN; do
  file="$(guard_field "$(guard_line "$slug")" file)"
  run cp "$SOURCE_DIR/hooks/$file" "$TARGET/$file"
  run chmod +x "$TARGET/$file"
  [ "$slug" = "unverified-claim" ] && needs_transcript_lib=1
done
if [ "$needs_transcript_lib" -eq 1 ]; then
  run cp "$SOURCE_DIR/hooks/lib/transcript-evidence.ts" "$TARGET/lib/transcript-evidence.ts"
fi

echo "  staged $(printf '%s' "$CHOSEN" | wc -w | tr -d ' ') guard(s)"
echo

# ── settings.json block ──────────────────────────────────────────────────────

emit_entry() {
  printf '            { "type": "command", "command": "%s/%s" }' "$TARGET" "$1"
}

bold "NOT YET ACTIVE — add this to your settings.json"
echo
echo '  Merge it into the arrays you already have; do not replace them.'
echo
echo '{'
echo '  "hooks": {'

events="$(for slug in $CHOSEN; do guard_field "$(guard_line "$slug")" event; done | sort -u)"
event_count="$(printf '%s\n' "$events" | grep -c . || true)"
event_i=0

for event in $events; do
  event_i=$((event_i + 1))
  printf '    "%s": [\n' "$event"

  matchers="$(for slug in $CHOSEN; do
    line="$(guard_line "$slug")"
    [ "$(guard_field "$line" event)" = "$event" ] || continue
    guard_field "$line" matcher
  done | sort -u)"

  # A guard with no matcher applies to the whole event; keep it in its own group.
  matcher_count="$(printf '%s\n' "$matchers" | grep -c '' || true)"
  matcher_i=0

  printf '%s\n' "$matchers" | while IFS= read -r matcher; do
    matcher_i=$((matcher_i + 1))
    printf '      {\n'
    [ -n "$matcher" ] && printf '        "matcher": "%s",\n' "$matcher"
    printf '        "hooks": [\n'
    first=1
    for slug in $CHOSEN; do
      line="$(guard_line "$slug")"
      [ "$(guard_field "$line" event)" = "$event" ] || continue
      [ "$(guard_field "$line" matcher)" = "$matcher" ] || continue
      [ "$first" -eq 0 ] && printf ',\n'
      emit_entry "$(guard_field "$line" file)"
      first=0
    done
    printf '\n        ]\n'
    if [ "$matcher_i" -lt "$matcher_count" ]; then printf '      },\n'; else printf '      }\n'; fi
  done

  if [ "$event_i" -lt "$event_count" ]; then printf '    ],\n'; else printf '    ]\n'; fi
done

echo '  }'
echo '}'
echo

if [ "$DRY_RUN" -eq 1 ]; then
  bold "Dry run complete — nothing was written."
else
  bold "Staged."
fi
echo
warn "  These hooks do nothing until you add the block above to settings.json."
warn "  That step is yours on purpose."
echo
echo "  Read first:  README.md  (what each guard blocks, and how to bypass it)"
echo "  Verify:      bun test"
echo "  Uninstall:   ./install.sh --uninstall"
echo
