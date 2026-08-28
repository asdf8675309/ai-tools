#!/usr/bin/env bash
#
# rg_plan — turning what the machine looks like into what gets signalled.
#
# The failures this guards are the quiet ones: a rule that never fires because
# its probe came back unavailable and was read as zero, a threshold that
# disables itself, a process signalled twice for two reasons.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=harness.sh
. "$HERE/harness.sh"
# shellcheck source=../lib/policy.sh
. "$HERE/../lib/policy.sh"

# The output of rg_select for an agent with two workers under it, neither over
# the per-process cap. Any plan here comes from a system-wide tier.
CALM='top 800 4000000 /Applications/Firefox.app/Contents/MacOS/firefox
largest 610 2000000 /usr/bin/node /w/worker.js
scoped 3 2500000'

# The same, with one worker over the per-process cap.
HOT='over 610 12000000 /usr/bin/node /w/leak.js
top 610 12000000 /usr/bin/node /w/leak.js
largest 610 12000000 /usr/bin/node /w/leak.js
scoped 3 12500000'

plan() { printf '%s\n' "$1" | rg_plan "$2" "$3" "$4" "$5"; }

# swap_used max_swap disk_free min_disk
eq 'a quiet machine produces no plan at all' \
  '' "$(plan "$CALM" 100 4096 50000 10240)"

eq 'a process over the per-process cap is asked to leave' \
  'plan 610 12000000 TERM rss-cap /usr/bin/node /w/leak.js' \
  "$(plan "$HOT" 100 4096 50000 10240)"

eq 'swap past its cap takes out the largest thing in scope' \
  'plan 610 2000000 TERM swap-pressure /usr/bin/node /w/worker.js' \
  "$(plan "$CALM" 6000 4096 50000 10240)"

# The disk tier skips the grace period. A boot volume with minutes of headroom
# is the failure that takes the machine down with it, and a process that ignores
# SIGTERM for ten seconds has spent those minutes.
eq 'a nearly-full boot volume kills immediately rather than asking' \
  'plan 610 2000000 KILL disk-pressure /usr/bin/node /w/worker.js' \
  "$(plan "$CALM" 100 4096 900 10240)"

eq 'one process earning several reasons is signalled once, at the highest urgency' \
  'plan 610 12000000 KILL rss-cap+swap-pressure+disk-pressure /usr/bin/node /w/leak.js' \
  "$(plan "$HOT" 6000 4096 900 10240)"

# ── probes that came back unavailable ────────────────────────────────────────
# -1 means "could not read this", which is what happens off Darwin. Read as a
# number it would be less than every floor, and the guard would kill something
# on every tick forever. This is the single most dangerous confusion in here.
eq 'an unreadable disk probe disables the disk rule instead of reading as empty' \
  '' "$(plan "$CALM" 100 4096 -1 10240)"
eq 'an unreadable swap probe disables the swap rule' \
  '' "$(plan "$CALM" -1 4096 50000 10240)"

# ── thresholds off ───────────────────────────────────────────────────────────
eq 'max_swap_mb = 0 turns the swap rule off' \
  '' "$(plan "$CALM" 999999 0 50000 10240)"
eq 'min_disk_free_mb = 0 turns the disk rule off' \
  '' "$(plan "$CALM" 100 4096 1 0)"

# ── boundaries ───────────────────────────────────────────────────────────────
eq 'swap exactly at the cap does not trip it' '' "$(plan "$CALM" 4096 4096 50000 10240)"
contains 'swap one MB over the cap does' 'swap-pressure' "$(plan "$CALM" 4097 4096 50000 10240)"
eq 'disk exactly at the floor does not trip it' '' "$(plan "$CALM" 100 4096 10240 10240)"
contains 'disk one MB under the floor does' 'disk-pressure' "$(plan "$CALM" 100 4096 10239 10240)"

# ── pressure with nothing in scope ───────────────────────────────────────────
# The machine is in trouble and the cause is something the guard is not allowed
# to touch. It says so and names the biggest process you own. It does not go
# looking for something else to kill — a watchdog that widens its own scope
# under pressure is one that eventually kills your editor.
NOSCOPE='top 800 4000000 /Applications/Firefox.app/Contents/MacOS/firefox
scoped 0 0'
eq 'pressure with no in-scope target reports, and signals nothing' \
  'note 800 4000000 NONE swap-pressure /Applications/Firefox.app/Contents/MacOS/firefox' \
  "$(plan "$NOSCOPE" 6000 4096 50000 10240)"
eq 'a note carries the same six fields as a plan, so one reader handles both' \
  6 "$(plan "$NOSCOPE" 6000 4096 50000 10240 | awk '{print NF}')"
eq 'and with no processes at all it still does not crash' \
  'note 0 0 NONE disk-pressure -' \
  "$(printf 'scoped 0 0\n' | rg_plan 100 4096 900 10240)"

summary plan
