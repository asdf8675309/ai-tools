#!/usr/bin/env bash
#
# Config parsing and the probe parsers.
#
# The config file is the one input a person edits by hand, so it is the one that
# will be wrong. Every rejection here is a threshold that would otherwise have
# been silently ignored, leaving a guard that looks installed and enforces the
# default.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=harness.sh
. "$HERE/harness.sh"
# shellcheck source=../lib/policy.sh
. "$HERE/../lib/policy.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

conf() { printf '%s\n' "$1" | rg_parse_conf 2>"$WORK/err"; }
errs() { cat "$WORK/err"; }

eq 'a plain assignment is passed through' \
  'max_rss_mb=6000' "$(conf 'max_rss_mb = 6000')"
eq 'whitespace around the key and value is not part of either' \
  'max_rss_mb=6000' "$(conf '   max_rss_mb   =   6000   ')"
eq 'comments and blank lines are skipped' \
  'max_rss_mb=6000' "$(conf '# a comment

max_rss_mb = 6000')"
eq 'a quoted regex loses exactly one layer of quotes' \
  'root_pattern=^claude$' "$(conf 'root_pattern = "^claude$"')"
eq 'a value containing = keeps everything after the first one' \
  'never_pattern=a=b' "$(conf 'never_pattern = a=b')"

# ── rejections ───────────────────────────────────────────────────────────────
# Each of these leaves the built-in default in force, which is the safe outcome
# — but only because the parser says so on stderr and the daemon logs it at
# startup. A silently ignored key is the failure mode that matters.
eq 'a misspelled key is rejected, not silently ignored' '' "$(conf 'max_rss = 6000')"
contains 'and the rejection names the key' 'unknown key: max_rss' "$(errs)"

eq 'a threshold that is not a number is rejected' '' "$(conf 'max_rss_mb = lots')"
contains 'and says what it wanted' 'must be a whole number' "$(errs)"

eq 'a negative threshold is rejected — there is no such size' '' "$(conf 'max_rss_mb = -1')"
eq 'a fractional threshold is rejected rather than truncated' '' "$(conf 'max_swap_mb = 4.5')"
eq 'a flag that is not 0 or 1 is rejected' '' "$(conf 'dry_run = yes')"
contains 'and says so' 'must be 0 or 1' "$(errs)"

eq 'a line with no separator is rejected' '' "$(conf 'max_rss_mb 6000')"
contains 'and says what a line should look like' 'not a key = value line' "$(errs)"

# An unbalanced group is the shape a hand-written regex actually breaks in, and
# awk would otherwise fail on every tick — which looks exactly like a running
# guard that never finds anything.
eq 'an invalid regex is rejected at parse time, not on every tick' \
  '' "$(conf 'never_pattern = ^(unclosed')"
contains 'and says which key' 'never_pattern is not a valid regex' "$(errs)"

eq 'one bad line does not discard the good ones around it' \
  'max_rss_mb=6000
max_swap_mb=2048' "$(conf 'max_rss_mb = 6000
nonsense = 1
max_swap_mb = 2048')"

rc=0
conf 'nonsense = 1' >/dev/null || rc=$?
eq 'and the parser still exits non-zero so the daemon can warn about it' 1 "$rc"

# ── the config file is data ──────────────────────────────────────────────────
# It is parsed, never sourced, and values are applied by an explicit case in
# bin/runaway.sh rather than by eval. A config file that can run code turns
# "edit a threshold" into a way to execute something as you — and this file is
# read by a process whose whole job is sending signals.
canary="$WORK/canary"
conf "never_pattern = \$(touch $canary)" >/dev/null
eq 'a command substitution in a value never runs' 0 "$([ -e "$canary" ] && echo 1 || echo 0)"
conf "vm_volume = \`touch $canary\`" >/dev/null
eq 'nor does a backquoted one' 0 "$([ -e "$canary" ] && echo 1 || echo 0)"
eq 'a semicolon in a value is a character, not a statement separator' \
  'vm_volume=/tmp; rm -rf /' "$(conf 'vm_volume = /tmp; rm -rf /')"

# ── probe parsers ────────────────────────────────────────────────────────────
# `sysctl -n vm.swapusage` on macOS.
eq 'megabytes of swap in use are read out of the sysctl line' \
  1024 "$(printf 'total = 3072.00M  used = 1024.50M  free = 2047.50M  (encrypted)\n' | rg_swap_used_mb)"
eq 'a gigabyte suffix is converted, not taken at face value' \
  2560 "$(printf 'total = 4.00G  used = 2.50G  free = 1.50G\n' | rg_swap_used_mb)"
eq 'the sysctl-name prefix form parses too' \
  384 "$(printf 'vm.swapusage: total = 2048.00M  used = 384.75M  free = 1663.25M\n' | rg_swap_used_mb)"
eq 'an unrecognisable line reads as unavailable, never as zero swap in use' \
  -1 "$(printf 'sysctl: unknown oid\n' | rg_swap_used_mb)"
eq 'and so does no output at all' -1 "$(printf '' | rg_swap_used_mb)"

# `df -Pm <path>` — -P guarantees one data line, so field 4 is available MB.
eq 'available megabytes come from the single -P data line' \
  170000 "$(printf 'Filesystem 1048576-blocks Used Available Capacity Mounted on\n/dev/disk3s5 476802 300000 170000 64%% /\n' | rg_df_free_mb)"
eq 'a df that printed only a header reads as unavailable' \
  -1 "$(printf 'Filesystem 1048576-blocks Used Available Capacity Mounted on\n' | rg_df_free_mb)"
eq 'a df that failed entirely reads as unavailable' -1 "$(printf '' | rg_df_free_mb)"

summary config
