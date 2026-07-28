#!/usr/bin/env bash
#
# Fresh-install smoke test.
#
# Runs a full dispatch -> update -> list cycle against a throwaway HOME with no
# agent config directory in it, then asserts two things the unit tests can't:
# that state lands on the documented default path when SPRINT_STATE_DIR is
# unset, and that nothing was written into an agent config directory at all.
#
# The unit tests always set SPRINT_STATE_DIR, so they prove the override works
# and say nothing about the default. This is the other half.
#
#   ./smoke.sh          run it
#   ./smoke.sh --keep   leave the sandbox behind for inspection

set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

SANDBOX="$(mktemp -d)"
cleanup() { [ "$KEEP" -eq 1 ] || rm -rf "$SANDBOX"; }
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok   %s\n' "$*"; }

# A HOME with nothing in it. SPRINT_STATE_DIR deliberately unset so the default
# path is what gets exercised.
export HOME="$SANDBOX/home"
unset SPRINT_STATE_DIR
mkdir -p "$HOME"

REGISTRY="$TOOLS_DIR/Registry.ts"
# -u because Registry names state files from toISOString(), which is UTC. Local
# time drifts a day ahead of it every evening west of Greenwich, and this check
# then looks for a file that was correctly written under tomorrow's name.
TODAY="$(date -u +%Y-%m-%d)"

bun "$REGISTRY" dispatch \
  --sprint-id smoke --repo octocat/example --issues 1,2 \
  > "$SANDBOX/dispatch.json" || fail "dispatch exited non-zero"
grep -q '"status": "ok"' "$SANDBOX/dispatch.json" || fail "dispatch did not report ok"
ok "dispatch"

bun "$REGISTRY" get-running --issue 1 | grep -q '"status":"running"' \
  || fail "a dispatched issue did not read as running"
ok "get-running"

bun "$REGISTRY" update --sprint-id smoke --issue 1 \
  --pr-url "https://example.invalid/pull/1" --verdict APPROVE --status pr-opened \
  > /dev/null || fail "update exited non-zero"
ok "update"

bun "$REGISTRY" list | grep -q "APPROVE (unverified)" \
  || fail "list did not mark an unbacked verdict as unverified"
ok "list"

# ISC-11 — the documented default, with no env override in play.
STATE="$HOME/.sprint/state/$TODAY.json"
[ -f "$STATE" ] || fail "state not written to the default path ($STATE)"
ok "state at the documented default"

# ISC-16 — nothing anywhere near an agent config directory.
[ -e "$HOME/.claude" ] && fail "wrote into an agent config directory"
ok "no agent config directory created"

# Nothing outside the two paths this tool documents.
UNEXPECTED="$(find "$HOME" -mindepth 1 -maxdepth 1 -not -name '.sprint' | head -5)"
[ -n "$UNEXPECTED" ] && fail "unexpected paths in HOME: $UNEXPECTED"
ok "no writes outside \$HOME/.sprint"

printf '\nAll smoke checks passed.\n'
