#!/usr/bin/env bash
#
# rg_plan — turning what the machine looks like into what gets signalled.
#
# The failures this guards are the quiet ones: a rule that never fires because
# its probe came back unavailable and was read as zero, a threshold that
# disables itself, a process signalled twice for two reasons, a paused process
# escalated when the pressure that paused it had already passed.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=harness.sh
. "$HERE/harness.sh"
# shellcheck source=../lib/policy.sh
. "$HERE/../lib/policy.sh"

# rg_select output for an agent with two workers under it and a browser you own,
# none over the per-process cap. Any plan here comes from a system-wide rule.
CALM='top 700 18000000 /Applications/Chrome
largest 610 2000000 /usr/bin/node /w/worker.js
pressure_target 700 18000000 /Applications/Chrome
scoped 3 2500000'

# The same, with one worker over the per-process cap.
HOT='over 610 12000000 /usr/bin/node /w/leak.js
top 610 12000000 /usr/bin/node /w/leak.js
largest 610 12000000 /usr/bin/node /w/leak.js
pressure_target 610 12000000 /usr/bin/node /w/leak.js
scoped 3 12500000'

plan() { printf '%s\n' "$1" | rg_plan "$2"; }

OK='swap=100 max_swap=8192 disk=50000 min_disk=10240'

eq 'a quiet machine produces no plan at all' '' "$(plan "$CALM" "$OK")"

eq 'a process over the per-process cap is asked to leave' \
  'plan 610 12000000 TERM rss-cap /usr/bin/node /w/leak.js' "$(plan "$HOT" "$OK")"

eq 'swap past its ceiling takes the largest thing in the NARROW scope' \
  'plan 610 2000000 TERM swap-ceiling /usr/bin/node /w/worker.js' \
  "$(plan "$CALM" 'swap=9000 max_swap=8192 disk=50000 min_disk=10240')"

# The disk rule skips the grace period. A boot volume with minutes of headroom
# is the failure that takes the machine down with it, and a process that ignores
# SIGTERM for ten seconds has spent those minutes.
eq 'a nearly-full boot volume kills immediately rather than asking' \
  'plan 610 2000000 KILL disk-floor /usr/bin/node /w/worker.js' \
  "$(plan "$CALM" 'swap=100 max_swap=8192 disk=900 min_disk=10240')"

# ── the system-pressure rule ─────────────────────────────────────────────────
# This is the one that keeps the machine out of the out-of-memory panel, and the
# only one allowed to reach outside the agent — which is why its default action
# is a reversible pause rather than a kill.
eq 'sustained pressure pauses the largest thing you own, agent or not' \
  'plan 700 18000000 STOP pressure:kernel-pressure /Applications/Chrome' \
  "$(plan "$CALM" "$OK pressure=1 pressure_why=kernel-pressure sustained=1 action=stop")"

eq 'pressure that has not lasted yet does nothing — a spike is not a leak' \
  '' "$(plan "$CALM" "$OK pressure=1 pressure_why=kernel-pressure sustained=0 action=stop")"

eq 'sustained is not enough on its own either' \
  '' "$(plan "$CALM" "$OK pressure=0 sustained=1 action=stop")"

eq 'the reason travels into the log line, so you can see which probe fired' \
  'plan 700 18000000 STOP pressure:compressor+swapout-rate /Applications/Chrome' \
  "$(plan "$CALM" "$OK pressure=1 pressure_why=compressor+swapout-rate sustained=1 action=stop")"

eq 'pressure_action = term skips the pause and asks it to leave' \
  'plan 700 18000000 TERM pressure:compressor /Applications/Chrome' \
  "$(plan "$CALM" "$OK pressure=1 pressure_why=compressor sustained=1 action=term")"
eq 'pressure_action = kill does not ask' \
  'plan 700 18000000 KILL pressure:compressor /Applications/Chrome' \
  "$(plan "$CALM" "$OK pressure=1 pressure_why=compressor sustained=1 action=kill")"

# ── pause, then escalate or resume ───────────────────────────────────────────
PAUSED='stopped 700 18000000 /Applications/Chrome
top 700 18000000 /Applications/Chrome
scoped 0 0'

eq 'a paused process whose timer ran out while pressure held is killed' \
  'plan 700 18000000 TERM pressure-escalate /Applications/Chrome' \
  "$(plan "$PAUSED" "$OK pressure=1 pressure_why=compressor sustained=1 escalate=700" | grep escalate)"

eq 'a paused process is left alone while its timer is still running' \
  '' "$(plan "$PAUSED" "$OK pressure=1 pressure_why=compressor sustained=1" | grep -c 'plan 700' | sed 's/^0$//')"

# Stopping a process does not free its memory, so pressure usually does NOT
# clear and the escalation is what actually resolves it. When pressure DOES
# clear, the pause cost nothing and is undone.
eq 'pressure clearing resumes what was paused' \
  'plan 700 18000000 CONT pressure-cleared /Applications/Chrome' \
  "$(plan "$PAUSED" "$OK resume=1")"

eq 'a process being escalated is not also resumed in the same breath' \
  'plan 700 18000000 TERM pressure-escalate /Applications/Chrome' \
  "$(plan "$PAUSED" "$OK escalate=700 resume=1")"

eq 'one process earning several reasons is signalled once, at the highest urgency' \
  'plan 610 12000000 KILL rss-cap+swap-ceiling+disk-floor /usr/bin/node /w/leak.js' \
  "$(plan "$HOT" 'swap=9000 max_swap=8192 disk=900 min_disk=10240')"
eq 'and a pause never downgrades a kill that was already planned' \
  'plan 610 12000000 TERM rss-cap+pressure:compressor /usr/bin/node /w/leak.js' \
  "$(plan "$HOT" "$OK pressure=1 pressure_why=compressor sustained=1 action=stop")"

# ── probes that came back unavailable ────────────────────────────────────────
# -1 means "could not read this". Read as a number it is below every floor, and
# the guard would kill something on every tick forever. This is the single most
# dangerous confusion in here.
eq 'an unreadable disk probe disables the disk rule instead of reading as empty' \
  '' "$(plan "$CALM" 'swap=100 max_swap=8192 disk=-1 min_disk=10240')"
eq 'an unreadable swap probe disables the swap rule' \
  '' "$(plan "$CALM" 'swap=-1 max_swap=8192 disk=50000 min_disk=10240')"

# ── thresholds off ───────────────────────────────────────────────────────────
eq 'max_swap_mb = 0 turns the swap rule off' \
  '' "$(plan "$CALM" 'swap=999999 max_swap=0 disk=50000 min_disk=10240')"
eq 'min_disk_free_mb = 0 turns the disk rule off' \
  '' "$(plan "$CALM" 'swap=100 max_swap=8192 disk=1 min_disk=0')"

# ── boundaries ───────────────────────────────────────────────────────────────
eq 'swap exactly at the ceiling does not trip it' \
  '' "$(plan "$CALM" 'swap=8192 max_swap=8192 disk=50000 min_disk=10240')"
contains 'swap one MB over does' 'swap-ceiling' "$(plan "$CALM" 'swap=8193 max_swap=8192 disk=50000 min_disk=10240')"
eq 'disk exactly at the floor does not trip it' \
  '' "$(plan "$CALM" 'swap=100 max_swap=8192 disk=10240 min_disk=10240')"
contains 'disk one MB under does' 'disk-floor' "$(plan "$CALM" 'swap=100 max_swap=8192 disk=10239 min_disk=10240')"

# ── nothing it may act on ────────────────────────────────────────────────────
# The machine is in trouble and the cause is something the guard is not allowed
# to touch, or is too small to be worth touching. It says so and names the
# biggest process you own. It does not go looking for something else.
NOTHING='top 800 3000000 /System/.../Finder
scoped 0 0'
eq 'pressure with no permitted target reports, and signals nothing' \
  'note 800 3000000 NONE pressure:kernel-pressure /System/.../Finder' \
  "$(plan "$NOTHING" "$OK pressure=1 pressure_why=kernel-pressure sustained=1 action=stop")"
eq 'a note carries the same six fields as a plan, so one reader handles both' \
  6 "$(plan "$NOTHING" "$OK pressure=1 pressure_why=kernel-pressure sustained=1" | awk '{print NF}')"
eq 'and with no processes at all it still does not crash' \
  'note 0 0 NONE disk-floor -' "$(printf 'scoped 0 0\n' | rg_plan 'swap=100 max_swap=8192 disk=900 min_disk=10240')"

summary plan
