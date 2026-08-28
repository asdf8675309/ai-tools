#!/usr/bin/env bash
#
# The parts of bin/runaway.sh that are not pure: applying a config, registering
# a scope root, and actually sending the signal.
#
# Sourced with RUNAWAY_NO_MAIN set so the script defines its functions without
# dispatching a subcommand.
#
# The thresholds and flags asserted below (max_rss_mb, dry_run, notify, ...) are
# defined by that script. CI runs shellcheck without -x, so it cannot follow the
# source and reports every one of them as unassigned or unused.
# shellcheck disable=SC2154,SC2034

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=harness.sh
. "$HERE/harness.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Cleared so the suite exercises the SHIPPED DEFAULTS. A developer with either
# of these exported would otherwise be testing their own environment and
# reporting green.
unset NODE_OPTIONS RUNAWAY_LIB

BIN="$HERE/../bin/runaway.sh"
export RUNAWAY_STATE_DIR="$WORK/state"
export RUNAWAY_CONFIG="$WORK/runaway.conf"
export RUNAWAY_NO_MAIN=1
# shellcheck source=../bin/runaway.sh
. "$BIN"

# ── config actually reaches the thresholds ───────────────────────────────────
# A config file that parses but is never applied is the worst outcome available:
# `runaway config` would print your numbers while the daemon enforced the
# defaults.
eq 'the built-in per-process cap before any config' 8192 "$max_rss_mb"
cat >"$RUNAWAY_CONFIG" <<'EOF'
max_rss_mb = 3000
grace_seconds = 2
notify = 0
root_pattern = ^my-agent$
EOF
rg_load_config
eq 'a configured threshold replaces the default'   3000 "$max_rss_mb"
eq 'so does a configured grace period'             2 "$grace_seconds"
eq 'and a configured pattern'                      '^my-agent$' "$root_pattern"
eq 'a key the file does not mention keeps its default' 4096 "$max_swap_mb"
eq 'and the source is reported as the file, not as defaults' "$RUNAWAY_CONFIG" "$RG_CONFIG_SOURCE"

printf 'interval_seconds = 0\n' >"$RUNAWAY_CONFIG"
rg_load_config
eq 'a zero interval is floored to one second rather than spinning the CPU' 1 "$interval_seconds"

printf 'bogus_key = 1\n' >"$RUNAWAY_CONFIG"
rg_load_config 2>/dev/null
eq 'a config with a rejected line is flagged so the daemon can warn at startup' 1 "$RG_CONFIG_ERRORS"

# ── the scope registry ───────────────────────────────────────────────────────
mkdir -p "$RG_ROOTS_DIR"
: >"$RG_ROOTS_DIR/$$"
: >"$RG_ROOTS_DIR/4194303"
: >"$RG_ROOTS_DIR/not-a-pid"
csv="$(rg_roots_csv)"
contains 'a live registration is offered to the scope walk' "$$" "$csv"
lacks 'a registration whose process has exited is not' '4194303' "$csv"
eq 'and the dead entry is reaped from disk, since `run` execs and cannot clean up' \
  0 "$([ -e "$RG_ROOTS_DIR/4194303" ] && echo 1 || echo 0)"
eq 'a junk filename is reaped too' \
  0 "$([ -e "$RG_ROOTS_DIR/not-a-pid" ] && echo 1 || echo 0)"
rm -f "$RG_ROOTS_DIR/$$"

# ── signalling ───────────────────────────────────────────────────────────────
notify=0
grace_seconds=2

# Dry run has to be airtight: it is what the README tells people to spend a week
# in before they trust this with SIGKILL.
sleep 30 &
victim=$!
dry_run=1
log="$(printf 'plan %d 9999999 KILL rss-cap /bin/sleep\n' "$victim" | rg_execute_plan 2>&1)"
contains 'a dry run says what it would have done' 'would send SIGKILL' "$log"
eq 'and the process it named is still running' \
  0 "$(kill -0 "$victim" 2>/dev/null && echo 0 || echo 1)"

dry_run=0
log="$(printf 'plan %d 9999999 KILL rss-cap /bin/sleep\n' "$victim" | rg_execute_plan 2>&1)"
contains 'a real run logs the signal it sent' 'SIGKILL to pid' "$log"
wait "$victim" 2>/dev/null
eq 'and the process is gone' \
  1 "$(kill -0 "$victim" 2>/dev/null && echo 0 || echo 1)"

# SIGTERM first, SIGKILL only after the grace period, and only if it is still
# there. A process that handles SIGTERM gets to exit on its own terms.
sleep 30 &
victim=$!
start=$SECONDS
log="$(printf 'plan %d 9999999 TERM swap-pressure /bin/sleep\n' "$victim" | rg_execute_plan 2>&1)"
elapsed=$((SECONDS - start))
contains 'a TERM plan sends SIGTERM' 'SIGTERM to pid' "$log"
eq 'a process that dies on SIGTERM is never escalated to SIGKILL' \
  '' "$(printf '%s' "$log" | grep -o 'SIGKILL' || true)"
eq 'and the guard does not sit out the whole grace period waiting for a corpse' \
  1 "$([ "$elapsed" -lt "$grace_seconds" ] && echo 1 || echo 0)"
wait "$victim" 2>/dev/null

# ── a note is reported, never acted on ───────────────────────────────────────
log="$(printf 'note 4194303 4000000 NONE swap-pressure /some/process\n' | rg_execute_plan 2>&1)"
contains 'a tier that tripped with nothing in scope names what it saw' \
  'swap-pressure tripped but nothing in scope' "$log"
contains 'and reports it in megabytes' '3906 MB' "$log"
lacks 'and sends no signal' 'act:' "$log"

# ── the run wrapper ──────────────────────────────────────────────────────────
# `env -u RUNAWAY_NO_MAIN` because this suite exported it to source the script;
# these cases need the real dispatcher. The config file the earlier cases wrote
# goes too — the wrapper's behaviour under defaults is what is being asserted.
rm -f "$RUNAWAY_CONFIG"
runaway() { env -u RUNAWAY_NO_MAIN bash "$BIN" "$@"; }

out="$(runaway run -- sh -c 'printf "%s" "${NODE_OPTIONS-}"')"
eq 'the wrapper caps the V8 heap of anything it launches' \
  '--max-old-space-size=4096' "$out"

out="$(NODE_OPTIONS='--max-old-space-size=256' runaway run -- sh -c 'printf "%s" "$NODE_OPTIONS"')"
eq 'a cap you set yourself is left alone' '--max-old-space-size=256' "$out"

out="$(NODE_OPTIONS='--enable-source-maps' runaway run -- sh -c 'printf "%s" "$NODE_OPTIONS"')"
eq 'and unrelated NODE_OPTIONS are preserved, not replaced' \
  '--enable-source-maps --max-old-space-size=4096' "$out"

out="$(runaway run -- sh -c 'if [ -e "$RUNAWAY_STATE_DIR/roots/$$" ]; then echo registered; fi')"
eq 'the wrapped command is in scope from its first instruction, under its own pid' \
  'registered' "$out"

# install.sh puts a `runaway` symlink on your PATH pointing at the staged
# script; the library is found relative to the real file, not the link. Without
# resolution the installed CLI cannot start at all.
ln -s "$BIN" "$WORK/runaway-link"
out="$(env -u RUNAWAY_NO_MAIN bash "$WORK/runaway-link" run sh -c 'printf ok')"
eq 'invoked through a symlink, the CLI still finds its own library' 'ok' "$out"

out="$(runaway run sh -c 'printf ok')"
eq 'the -- separator is optional' 'ok' "$out"

runaway run -- sh -c 'exit 42' >/dev/null 2>&1
eq 'the wrapper execs, so the exit status is the commands own' 42 "$?"

summary cli
