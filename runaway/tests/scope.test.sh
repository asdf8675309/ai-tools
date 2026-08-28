#!/usr/bin/env bash
#
# rg_select — who is in scope, and who may be signalled.
#
# This is the half of the tool that decides whether your build server gets
# killed or your agent's leaked worker does. Every case below is a way to get
# that wrong.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=harness.sh
. "$HERE/harness.sh"
# shellcheck source=../lib/policy.sh
. "$HERE/../lib/policy.sh"

NEVER='^-?(sh|bash|zsh|fish|dash|ksh)$|^(launchd|login|tmux|screen|ssh|sshd|sudo|su|runaway)$'

# pid ppid rss_kb command...
#
# 500 is the agent. 610 is the runaway worker under it. 800 is a browser the
# guard must never touch even though it is the second-largest thing running.
TABLE='    1     0   9000 /sbin/launchd
  400     1  20000 /bin/zsh -l
  410   400  30000 -zsh
  500   400 180000 /opt/homebrew/bin/claude
  600   500 900000 /opt/homebrew/bin/node /w/server.js
  610   600 12000000 /opt/homebrew/bin/node /w/leak.js
  700   500  40000 /bin/sh -c bun test
  800     1 4000000 /Applications/Firefox.app/Contents/MacOS/firefox
  900   999  50000 /usr/bin/orphaned-thing'

sel() { printf '%s\n' "$TABLE" | rg_select "$@"; }

out=$(sel 4096 '^claude$' 'claude-code/cli\.js' "$NEVER" 1 0 '' 0)

contains 'the runaway grandchild of the agent is over the cap' \
  'over 610 12000000' "$out"
lacks 'a browser you own but did not launch from the agent is never a target' \
  '800' "$out"
lacks 'a process under the cap is not a target' \
  'over 600' "$out"
eq 'the largest signallable process is the runaway, not the browser' \
  'largest 610 12000000 /opt/homebrew/bin/node /w/leak.js' \
  "$(printf '%s\n' "$out" | grep '^largest ')"
eq 'top reports the biggest process you own regardless of scope' \
  'top 610 12000000 /opt/homebrew/bin/node /w/leak.js' \
  "$(printf '%s\n' "$out" | grep '^top ')"
eq 'scope is the agent plus its descendants, and nothing else' \
  'scoped 4 13120000' "$(printf '%s\n' "$out" | grep '^scoped ')"

# ── the agent itself ─────────────────────────────────────────────────────────
# Killing the root is killing the session. Default is to leave it alone; the
# option to include it exists and has to be asked for.
big_root='  500   400 99000000 /opt/homebrew/bin/claude'
out=$(printf '%s\n' "$big_root" | rg_select 4096 '^claude$' '' "$NEVER" 1 0 '' 0)
lacks 'protect_roots=1 spares the agent process itself' 'over 500' "$out"
out=$(printf '%s\n' "$big_root" | rg_select 4096 '^claude$' '' "$NEVER" 0 0 '' 0)
contains 'protect_roots=0 makes the agent a target like anything else' 'over 500' "$out"

# ── the never list ───────────────────────────────────────────────────────────
shell='  500   400 180000 /opt/homebrew/bin/claude
  700   500 9000000 -zsh'
out=$(printf '%s\n' "$shell" | rg_select 4096 '^claude$' '' "$NEVER" 1 0 '' 0)
lacks 'a login shell under the agent is never signalled' 'over 700' "$out"
lacks 'and it is not offered as the pressure-relief target either' 'largest 700' "$out"

# ── the guard itself ─────────────────────────────────────────────────────────
# An agent that started the watchdog would otherwise put the watchdog inside the
# scope it is policing, and the first swap spike would have it kill itself.
selftree='  500   400 180000 /opt/homebrew/bin/claude
  550   500  10000 /bin/bash runaway.sh watch
  560   550 9000000 /usr/bin/some-child-of-the-guard'
out=$(printf '%s\n' "$selftree" | rg_select 4096 '^claude$' '' '' 1 550 '' 0)
lacks 'the guard never targets itself'            'over 550' "$out"
lacks 'nor anything it spawned, even under a root' 'over 560' "$out"
eq 'so a tree that is only the guard has nothing in scope' \
  'scoped 1 180000' "$(printf '%s\n' "$out" | grep '^scoped ')"

# ── explicit roots from `runaway run` ────────────────────────────────────────
wrapped='  300     1  10000 /bin/bash -c npm run build
  310   300 9000000 /usr/bin/node /w/build.js'
out=$(printf '%s\n' "$wrapped" | rg_select 4096 '^claude$' '' "$NEVER" 1 0 '' 0)
lacks 'without a registration, an unwrapped build is out of scope' 'over 310' "$out"
out=$(printf '%s\n' "$wrapped" | rg_select 4096 '^claude$' '' "$NEVER" 1 0 '300' 0)
contains 'a pid registered by `runaway run` brings its children into scope' 'over 310' "$out"
out=$(printf '%s\n' "$wrapped" | rg_select 4096 '^claude$' '' "$NEVER" 1 0 'not-a-pid,300' 0)
contains 'a junk entry in the registry is dropped, not fatal' 'over 310' "$out"

# ── regexes must survive the trip into awk ───────────────────────────────────
# awk expands backslash escapes in a `-v` assignment, so `cli\.js` would arrive
# as `cli.js` and match a command it was never meant to. Patterns go through the
# environment instead. This asserts the escape is still an escape.
escaped='  500   400 180000 /usr/bin/node /w/claude-code/cliXjs
  510   500 9000000 /usr/bin/node /w/worker.js'
out=$(printf '%s\n' "$escaped" | rg_select 4096 '^never-matches$' 'claude-code/cli\.js' '' 1 0 '' 0)
eq 'a dot escaped in a config regex does not match an arbitrary character' \
  'scoped 0 0' "$(printf '%s\n' "$out" | grep '^scoped ')"

# ── malformed and hostile input ──────────────────────────────────────────────
# ps writing a warning to stdout, a parent that has already exited, a cycle.
messy='ps: some warning
    1     0   1000 /sbin/launchd
  500   400 180000 /opt/homebrew/bin/claude
  610   500 9000000 /usr/bin/node /w/leak.js
  700   701  10000 /usr/bin/a
  701   700  10000 /usr/bin/b'
# The ancestry walk is depth-bounded, which is what stops the cycle below from
# spinning; if that bound is ever removed this assertion hangs rather than fails.
out=$(printf '%s\n' "$messy" | rg_select 4096 '^claude$' '' "$NEVER" 1 0 '' 0)
rc=$?
eq 'a non-process line on stdin is skipped rather than parsed as a pid' 0 "$rc"
contains 'and the real runaway is still found' 'over 610' "$out"
lacks 'a parent cycle terminates instead of hanging, and is not in scope' 'over 700' "$out"

# ── pid 1 ────────────────────────────────────────────────────────────────────
out=$(printf '%s\n' '    1     0 99000000 /sbin/launchd' | rg_select 4096 '.' '' '' 0 0 '' 0)
lacks 'pid 1 is never a target, whatever the patterns say' 'over 1' "$out"

# ── the cap boundary ─────────────────────────────────────────────────────────
# 4096 MB is 4194304 KB. Strictly greater, so a process sitting exactly at the
# cap is not killed for it.
boundary='  500   400 100 /opt/homebrew/bin/claude
  600   500 4194304 /usr/bin/node /w/at-the-cap.js
  601   500 4194305 /usr/bin/node /w/one-kb-over.js'
out=$(printf '%s\n' "$boundary" | rg_select 4096 '^claude$' '' '' 1 0 '' 0)
lacks 'a process exactly at the cap is left alone' 'over 600' "$out"
contains 'a process one KB over the cap is not' 'over 601' "$out"

out=$(printf '%s\n' "$boundary" | rg_select 0 '^claude$' '' '' 1 0 '' 0)
lacks 'max_rss_mb = 0 disables the per-process rule' 'over ' "$out"

summary scope
