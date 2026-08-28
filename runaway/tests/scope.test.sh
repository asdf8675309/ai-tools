#!/usr/bin/env bash
#
# rg_select — who is in scope, and who may be signalled.
#
# This is the half of the tool that decides whether your editor gets paused or
# the leaking worker does. Every case below is a way to get that wrong.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=harness.sh
. "$HERE/harness.sh"
# shellcheck source=../lib/policy.sh
. "$HERE/../lib/policy.sh"

NEVER='^-?(sh|bash|zsh|fish|dash|ksh)$|^(launchd|login|tmux|ssh|sudo|runaway)$|^(Finder|Dock|WindowServer)$|^(Terminal|Code|Code Helper.*)$'

# pid ppid rss_kb command...
#
# 500 is the agent, 610 the runaway worker under it. 700 is a browser and 800 is
# Finder — neither started by the agent, and the second must never be touched.
TABLE='    1     0   9000 /sbin/launchd
  400     1  20000 /bin/zsh -l
  500   400 180000 /opt/homebrew/bin/claude
  600   500 900000 /opt/homebrew/bin/node /w/server.js
  610   600 12000000 /opt/homebrew/bin/node /w/leak.js
  700     1 18000000 /Applications/Chrome.app/Contents/MacOS/Chrome
  800     1 3000000 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
  900   999  50000 /usr/bin/orphaned-thing'

# The two regexes and the never list travel in the environment; everything else
# is the facts string.
sel() {
  RG_ROOT_RE="${RE:-^claude$}" RG_ROOT_CMD_RE="${CMDRE:-}" RG_NEVER_RE="${NEV:-$NEVER}" \
    rg_select "$1"
}
line() { printf '%s\n' "$2" | grep "^$1 " || true; }

out=$(printf '%s\n' "$TABLE" | sel 'cap_mb=4096 target_min_mb=0 scope=agents pressure_scope=user')

contains 'the runaway grandchild of the agent is over the cap' 'over 610 12000000' "$out"
lacks    'a browser you own but did not launch from the agent is not over the cap' 'over 700' "$out"
eq 'the narrow target is the biggest thing under the agent' \
  'largest 610 12000000 /opt/homebrew/bin/node /w/leak.js' "$(line largest "$out")"
eq 'the wide target is the biggest thing you own that is not protected' \
  'pressure_target 700 18000000 /Applications/Chrome.app/Contents/MacOS/Chrome' "$(line pressure_target "$out")"
eq 'top reports the biggest process you own, filtered by nothing' \
  'top 700 18000000 /Applications/Chrome.app/Contents/MacOS/Chrome' "$(line top "$out")"
eq 'scope counts the agent and its descendants, and nothing else' \
  'scoped 3 13080000' "$(line scoped "$out")"

# ── the never list holds in BOTH scopes ──────────────────────────────────────
# This is the property that makes `pressure_scope = user` safe to ship on by
# default: widening the scope does not widen what may be signalled.
lacks 'Finder is never the wide target, even though it is the second largest' \
  'pressure_target 800' "$out"
out2=$(printf '%s\n' '  800     1 99000000 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder' \
  | sel 'cap_mb=1 target_min_mb=0 scope=user pressure_scope=user')
eq 'and it is not a target when it is the only process there is' '' "$(line pressure_target "$out2")"
eq 'nor is it over the cap, at any size, with scope = user' '' "$(line over "$out2")"

# ── scope = user ─────────────────────────────────────────────────────────────
out2=$(printf '%s\n' "$TABLE" | sel 'cap_mb=4096 target_min_mb=0 scope=user pressure_scope=user')
contains 'with scope = user the per-process cap reaches an unrelated browser' 'over 700' "$out2"
contains 'and still reaches the agent worker' 'over 610' "$out2"
eq 'and the narrow and wide targets converge' "$(line largest "$out2" | sed s/largest/X/)" \
  "$(line pressure_target "$out2" | sed s/pressure_target/X/)"

# ── the size floor ───────────────────────────────────────────────────────────
# Found by running the thing: with the real offender already paused, "the
# largest process I may act on" was a 1 MB `sleep`. Pausing that is not a
# smaller version of the right action, it is the wrong action.
SMALL='  500   400 180000 /opt/homebrew/bin/claude
  600   500  40000 /usr/bin/tiny-helper'
out2=$(printf '%s\n' "$SMALL" | sel 'cap_mb=0 target_min_mb=512 scope=agents pressure_scope=agents')
eq 'nothing under the floor is offered as a target at all' '' "$(line pressure_target "$out2")"
eq 'not even as the narrow one' '' "$(line largest "$out2")"
out2=$(printf '%s\n' "$SMALL" | sel 'cap_mb=0 target_min_mb=30 scope=agents pressure_scope=agents')
contains 'and it is offered once the floor is below it' 'pressure_target 600' "$out2"

# ── already paused ───────────────────────────────────────────────────────────
# Without this the guard re-stops the same process every tick and never reaches
# the next one.
out2=$(printf '%s\n' "$TABLE" | sel 'cap_mb=4096 target_min_mb=0 scope=agents pressure_scope=user stopped=700')
contains 'a paused process is reported so it can be resumed or escalated' \
  'stopped 700 18000000' "$out2"
eq 'but it is never chosen as a target again' \
  'pressure_target 610 12000000 /opt/homebrew/bin/node /w/leak.js' "$(line pressure_target "$out2")"
contains 'and it stays subject to the per-process cap, since it still holds the memory' \
  'over 610' "$out2"

# ── the agent itself ─────────────────────────────────────────────────────────
big_root='  500   400 99000000 /opt/homebrew/bin/claude'
out2=$(printf '%s\n' "$big_root" | sel 'cap_mb=4096 target_min_mb=0 scope=agents')
lacks 'protect_roots defaults on, sparing the agent process itself' 'over 500' "$out2"
out2=$(printf '%s\n' "$big_root" | sel 'cap_mb=4096 target_min_mb=0 protect_roots=0 scope=agents')
contains 'protect_roots=0 makes the agent a target like anything else' 'over 500' "$out2"

# ── the guard itself ─────────────────────────────────────────────────────────
selftree='  500   400 180000 /opt/homebrew/bin/claude
  550   500  10000 /bin/bash runaway.sh watch
  560   550 9000000 /usr/bin/some-child-of-the-guard'
out2=$(printf '%s\n' "$selftree" | sel 'cap_mb=4096 target_min_mb=0 self_pid=550 scope=user pressure_scope=user')
lacks 'the guard never targets itself, even with scope = user'  'over 550' "$out2"
lacks 'nor anything it spawned'                                  'over 560' "$out2"
eq 'and neither is offered as a pressure target' '' "$(line pressure_target "$out2")"

# ── explicit roots from `runaway run` ────────────────────────────────────────
wrapped='  300     1  10000 /bin/bash -c npm run build
  310   300 9000000 /usr/bin/node /w/build.js'
out2=$(printf '%s\n' "$wrapped" | sel 'cap_mb=4096 target_min_mb=0 scope=agents')
lacks 'without a registration, an unwrapped build is out of the narrow scope' 'over 310' "$out2"
out2=$(printf '%s\n' "$wrapped" | sel 'cap_mb=4096 target_min_mb=0 scope=agents extra_roots=300')
contains 'a pid registered by `runaway run` brings its children into scope' 'over 310' "$out2"
out2=$(printf '%s\n' "$wrapped" | sel 'cap_mb=4096 target_min_mb=0 scope=agents extra_roots=junk,300')
contains 'a junk entry in the registry is dropped, not fatal' 'over 310' "$out2"

# ── regexes must survive the trip into awk ───────────────────────────────────
# awk expands backslash escapes in a `-v` assignment, so `cli\.js` would arrive
# as `cli.js` and match a command it was never meant to. Patterns go through the
# environment instead. This asserts the escape is still an escape.
escaped='  500   400 180000 /usr/bin/node /w/claude-code/cliXjs
  510   500 9000000 /usr/bin/node /w/worker.js'
out2=$(RE='^never-matches$' CMDRE='claude-code/cli\.js' printf '%s\n' "$escaped" \
  | RE='^never-matches$' CMDRE='claude-code/cli\.js' sel 'cap_mb=4096 scope=agents')
eq 'a dot escaped in a config regex does not match an arbitrary character' \
  'scoped 0 0' "$(line scoped "$out2")"

# ── malformed and hostile input ──────────────────────────────────────────────
# The ancestry walk is depth-bounded, which is what stops the cycle below from
# spinning; if that bound is ever removed this assertion hangs rather than fails.
messy='ps: some warning
    1     0   1000 /sbin/launchd
  500   400 180000 /opt/homebrew/bin/claude
  610   500 9000000 /usr/bin/node /w/leak.js
  700   701  10000 /usr/bin/a
  701   700  10000 /usr/bin/b'
out2=$(printf '%s\n' "$messy" | sel 'cap_mb=4096 target_min_mb=0 scope=agents')
rc=$?
eq 'a non-process line on stdin is skipped rather than parsed as a pid' 0 "$rc"
contains 'and the real runaway is still found' 'over 610' "$out2"
lacks 'a parent cycle terminates instead of hanging, and is not in the narrow scope' 'over 700' "$out2"

out2=$(printf '%s\n' '    1     0 99000000 /sbin/launchd' | NEV='' sel 'cap_mb=4096 target_min_mb=0 scope=user')
lacks 'pid 1 is never a target, whatever the patterns say' 'over 1' "$out2"

# ── the cap boundary ─────────────────────────────────────────────────────────
# 4096 MB is 4194304 KB. Strictly greater, so a process sitting exactly at the
# cap is not killed for it.
boundary='  500   400 100 /opt/homebrew/bin/claude
  600   500 4194304 /usr/bin/node /w/at-the-cap.js
  601   500 4194305 /usr/bin/node /w/one-kb-over.js'
out2=$(printf '%s\n' "$boundary" | sel 'cap_mb=4096 target_min_mb=0 scope=agents')
lacks    'a process exactly at the cap is left alone' 'over 600' "$out2"
contains 'a process one KB over the cap is not'       'over 601' "$out2"
out2=$(printf '%s\n' "$boundary" | sel 'cap_mb=0 target_min_mb=0 scope=agents')
lacks 'max_rss_mb = 0 disables the per-process rule' 'over ' "$out2"

summary scope
