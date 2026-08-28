#!/usr/bin/env bash
#
# runaway — a memory watchdog for the processes your coding agent spawns.
#
#   runaway.sh status              what it sees right now, and what it would do
#   runaway.sh watch               the daemon loop (this is what launchd runs)
#   runaway.sh watch --once        one tick, then exit — for cron, or for trying it
#   runaway.sh watch --dry-run     decide and log, signal nothing
#   runaway.sh run -- <cmd...>     run a command inside the guard's scope
#   runaway.sh config              the effective configuration and where it came from
#   runaway.sh --help
#
# Named `.sh` so the repo's shell lint picks it up from `git ls-files '*.sh'`.
# install.sh drops a `runaway` symlink on your PATH; the extension is for CI.

set -uo pipefail

RUNAWAY_VERSION=1.0.0

# Resolved through symlinks, because install.sh puts one on your PATH and the
# library is found relative to the real file. macOS ships bash 3.2 and a readlink
# with no -f, so this is the hand-rolled loop rather than one command. Bounded,
# so a symlink cycle ends in a clear error instead of a hang.
RG_SELF="${BASH_SOURCE[0]}"
RG_HOPS=0
while [ -L "$RG_SELF" ] && [ "$RG_HOPS" -lt 32 ]; do
  RG_TARGET="$(readlink "$RG_SELF")"
  case "$RG_TARGET" in
    /*) RG_SELF="$RG_TARGET" ;;
    *) RG_SELF="$(dirname "$RG_SELF")/$RG_TARGET" ;;
  esac
  RG_HOPS=$((RG_HOPS + 1))
done
RG_HOME="$(cd "$(dirname "$RG_SELF")/.." && pwd)"
RG_LIB="${RUNAWAY_LIB:-$RG_HOME/lib/policy.sh}"

if [ ! -r "$RG_LIB" ]; then
  printf 'runaway: cannot read %s (set RUNAWAY_LIB to override)\n' "$RG_LIB" >&2
  exit 1
fi
# shellcheck source=../lib/policy.sh
. "$RG_LIB"

RG_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/runaway"
RG_CONFIG="${RUNAWAY_CONFIG:-$RG_CONFIG_DIR/runaway.conf}"
RG_STATE_DIR="${RUNAWAY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/runaway}"
RG_ROOTS_DIR="$RG_STATE_DIR/roots"

# ── defaults ─────────────────────────────────────────────────────────────────
#
# Chosen to fire early. A watchdog whose thresholds are set at the point where
# the machine is already thrashing is a watchdog that cannot get scheduled when
# it matters — that is the whole trap. 8 GB is a number a compiler, a test run,
# or a language server will never reach by accident on a 16 GB+ Mac, and a
# runaway crosses it long before the compressor starts working.

max_rss_mb=8192
max_swap_mb=4096
min_disk_free_mb=10240
interval_seconds=5
grace_seconds=10
node_max_old_space_mb=4096
protect_roots=1
dry_run=0
notify=1
root_pattern='^claude$'
root_cmdline_pattern='claude-code/cli\.js'
never_pattern='^-?(sh|bash|zsh|fish|dash|ksh)$|^(launchd|login|tmux|screen|ssh|sshd|sudo|su|runaway)$'
vm_volume='/System/Volumes/VM'

RG_CONFIG_SOURCE='built-in defaults'
RG_CONFIG_ERRORS=0

rg_load_config() {
  [ -r "$RG_CONFIG" ] || return 0
  local parsed rc=0 key val
  parsed=$(rg_parse_conf <"$RG_CONFIG") || rc=1
  [ "$rc" -eq 0 ] || RG_CONFIG_ERRORS=1
  RG_CONFIG_SOURCE="$RG_CONFIG"
  # Applied by an explicit case, never by eval. The parser has already decided
  # each key is one of these and each value is the right shape; this is the
  # second half of never letting a config file name a variable.
  while IFS='=' read -r key val; do
    [ -n "$key" ] || continue
    case "$key" in
      max_rss_mb) max_rss_mb=$val ;;
      max_swap_mb) max_swap_mb=$val ;;
      min_disk_free_mb) min_disk_free_mb=$val ;;
      interval_seconds) interval_seconds=$val ;;
      grace_seconds) grace_seconds=$val ;;
      node_max_old_space_mb) node_max_old_space_mb=$val ;;
      protect_roots) protect_roots=$val ;;
      dry_run) dry_run=$val ;;
      notify) notify=$val ;;
      root_pattern) root_pattern=$val ;;
      root_cmdline_pattern) root_cmdline_pattern=$val ;;
      never_pattern) never_pattern=$val ;;
      vm_volume) vm_volume=$val ;;
    esac
  done <<EOF
$parsed
EOF
  [ "${interval_seconds:-0}" -ge 1 ] || interval_seconds=1
}

# ── logging ──────────────────────────────────────────────────────────────────
#
# stderr only. launchd points StandardErrorPath at the log file, so there is
# exactly one writer and no log-file handling in here. Note that launchd does
# not rotate it; see the README.

rg_log() {
  printf '%s runaway[%s] %s: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$$" "$1" "$2" >&2
}

rg_notify() {
  [ "$notify" = "1" ] || return 0
  command -v osascript >/dev/null 2>&1 || return 0
  # Passed as an argv item, not interpolated into the script text — a process
  # can be named anything, including something with a quote in it.
  osascript - "$1" >/dev/null 2>&1 <<'OSA' &
on run argv
  display notification (item 1 of argv) with title "runaway"
end run
OSA
  return 0
}

# ── platform probes ──────────────────────────────────────────────────────────

rg_is_darwin() { [ "$(uname -s 2>/dev/null)" = "Darwin" ]; }

RG_USER="$(id -un)"

rg_ps_table() {
  # -ww so a long command line is not truncated to the terminal width, which
  # would hide the very argv the cmdline root pattern matches on.
  # -U restricts this to processes running as you. Combined with the ancestry
  # walk it is the tool's outermost safety property: nothing it cannot signal
  # anyway ever enters the table, so it can never plan against another user's
  # process or a system daemon.
  ps -ww -U "$RG_USER" -o pid=,ppid=,rss=,command= 2>/dev/null
}

rg_probe_swap_mb() {
  rg_is_darwin || { printf '%s' -1; return 0; }
  sysctl -n vm.swapusage 2>/dev/null | rg_swap_used_mb
}

rg_probe_disk_mb() {
  local path=$vm_volume
  [ -d "$path" ] || path=/
  df -Pm "$path" 2>/dev/null | rg_df_free_mb
}

rg_roots_csv() {
  local f pid out=''
  [ -d "$RG_ROOTS_DIR" ] || return 0
  for f in "$RG_ROOTS_DIR"/*; do
    [ -e "$f" ] || continue
    pid=${f##*/}
    if ! rg_is_uint "$pid"; then rm -f "$f"; continue; fi
    # Reaped on sight. A registration outlives the process that made it because
    # `runaway.sh run` execs and so cannot clean up after itself.
    if kill -0 "$pid" 2>/dev/null; then
      out="${out:+$out,}$pid"
    else
      rm -f "$f"
    fi
  done
  printf '%s' "$out"
}

rg_mb() {
  if rg_is_uint "${1-}"; then printf '%d' "$(( $1 / 1024 ))"; else printf '?'; fi
}

# ── acting ───────────────────────────────────────────────────────────────────

rg_signal() {
  local pid=$1 sig=$2 waited=0
  if [ "$sig" = "KILL" ]; then
    kill -KILL "$pid" 2>/dev/null
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || return 0
  while [ "$waited" -lt "$grace_seconds" ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    rg_log warn "pid $pid ignored SIGTERM for ${grace_seconds}s, sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null
  fi
}

rg_execute_plan() {
  local kind pid rss sig why cmd mb
  while read -r kind pid rss sig why cmd; do
    case "$kind" in
      plan)
        mb=$(rg_mb "$rss")
        if [ "$dry_run" = "1" ]; then
          rg_log dry-run "would send SIG$sig to pid $pid ($why, ${mb} MB): $cmd"
          continue
        fi
        rg_log act "SIG$sig to pid $pid ($why, ${mb} MB): $cmd"
        rg_notify "Killed pid $pid — $why, ${mb} MB: $cmd"
        rg_signal "$pid" "$sig"
        ;;
      note)
        rg_log warn "$why tripped but nothing in scope to signal; largest process you own is pid $pid ($(rg_mb "$rss") MB): $cmd"
        ;;
    esac
  done
}

# ── tick ─────────────────────────────────────────────────────────────────────

rg_tick() {
  local table decisions swap disk roots
  table=$(rg_ps_table)
  if [ -z "$table" ]; then
    rg_log error "ps produced no output; cannot evaluate this tick"
    return 1
  fi
  roots=$(rg_roots_csv)
  swap=$(rg_probe_swap_mb)
  disk=$(rg_probe_disk_mb)
  decisions=$(printf '%s\n' "$table" | rg_select \
    "$max_rss_mb" "$root_pattern" "$root_cmdline_pattern" "$never_pattern" \
    "$protect_roots" "$$" "$roots" 0)
  printf '%s\n' "$decisions" | rg_plan "$swap" "$max_swap_mb" "$disk" "$min_disk_free_mb" | rg_execute_plan
}

# ── subcommands ──────────────────────────────────────────────────────────────

rg_cmd_watch() {
  local once=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --once) once=1 ;;
      --dry-run) dry_run=1 ;;
      --interval)
        shift
        rg_is_uint "${1-}" || { printf 'runaway: --interval needs a whole number of seconds\n' >&2; exit 2; }
        interval_seconds=$1
        ;;
      *) printf 'runaway: unknown option for watch: %s\n' "$1" >&2; exit 2 ;;
    esac
    shift
  done

  if ! rg_is_darwin; then rg_log warn "not macOS: swap and notification probes are unavailable, only the per-process cap and the disk floor apply"; fi
  if [ "$RG_CONFIG_ERRORS" -ne 0 ]; then rg_log warn "config had errors (above); the rejected keys are running on defaults"; fi

  rg_log start "v$RUNAWAY_VERSION config=$RG_CONFIG_SOURCE rss_cap=${max_rss_mb}MB swap_cap=${max_swap_mb}MB disk_floor=${min_disk_free_mb}MB interval=${interval_seconds}s grace=${grace_seconds}s dry_run=$dry_run roots=/$root_pattern/"

  trap 'rg_log stop "signalled, exiting"; exit 0' INT TERM

  if [ "$once" -eq 1 ]; then
    rg_tick
    return 0
  fi
  while :; do
    rg_tick
    sleep "$interval_seconds"
  done
}

rg_cmd_status() {
  local table swap disk roots decisions
  table=$(rg_ps_table)
  if [ -z "$table" ]; then
    printf 'runaway: ps produced no output for user %s\n' "$RG_USER" >&2
    return 1
  fi
  roots=$(rg_roots_csv)
  swap=$(rg_probe_swap_mb)
  disk=$(rg_probe_disk_mb)
  decisions=$(printf '%s\n' "$table" | rg_select \
    "$max_rss_mb" "$root_pattern" "$root_cmdline_pattern" "$never_pattern" \
    "$protect_roots" "$$" "$roots" 1)

  printf 'runaway %s   config: %s\n\n' "$RUNAWAY_VERSION" "$RG_CONFIG_SOURCE"

  local mark
  if [ "$swap" -lt 0 ]; then
    printf '  swap used      unavailable (rule disabled)\n'
  else
    mark=''
    if [ "$max_swap_mb" -gt 0 ] && [ "$swap" -gt "$max_swap_mb" ]; then mark='   OVER'; fi
    printf '  swap used      %s MB   / cap %s MB%s\n' "$swap" "$max_swap_mb" "$mark"
  fi
  if [ "$disk" -lt 0 ]; then
    printf '  disk free      unavailable (rule disabled)\n'
  else
    mark=''
    if [ "$min_disk_free_mb" -gt 0 ] && [ "$disk" -lt "$min_disk_free_mb" ]; then mark='   UNDER'; fi
    printf '  disk free      %s MB   / floor %s MB%s\n' "$disk" "$min_disk_free_mb" "$mark"
  fi
  printf '  per-process    cap %s MB\n' "$max_rss_mb"
  if [ -n "$roots" ]; then printf '  wrapped roots  %s\n' "$roots"; fi
  printf '\n'

  printf 'In scope (descended from /%s/ or a `runaway run` wrapper):\n' "$root_pattern"
  local n=0 kind pid rss flags cmd
  while read -r kind pid rss flags cmd; do
    [ "$kind" = "proc" ] || continue
    n=$((n + 1))
    printf '  %7s  %8s MB  %-16s %s\n' "$pid" "$(rg_mb "$rss")" "$flags" "$cmd"
  done <<EOF
$decisions
EOF
  if [ "$n" -eq 0 ]; then
    printf '  (nothing — no agent running, or root_pattern does not match it)\n'
  fi
  printf '\n'

  printf 'Would act on:\n'
  local plan
  plan=$(printf '%s\n' "$decisions" | rg_plan "$swap" "$max_swap_mb" "$disk" "$min_disk_free_mb")
  if [ -z "$plan" ]; then
    printf '  nothing\n'
  else
    printf '%s\n' "$plan" | while read -r kind pid rss sig why cmd; do
      case "$kind" in
        plan) printf '  SIG%-5s pid %-7s %8s MB  %-28s %s\n' "$sig" "$pid" "$(rg_mb "$rss")" "$why" "$cmd" ;;
        note) printf '  %s tripped, but nothing in scope to signal (largest process you own: pid %s, %s MB, %s)\n' "$why" "$pid" "$(rg_mb "$rss")" "$cmd" ;;
      esac
    done
  fi
}

rg_cmd_config() {
  local suffix=''
  if [ ! -r "$RG_CONFIG" ]; then suffix='   (absent — using defaults)'; fi
  printf 'config file:  %s%s\n' "$RG_CONFIG" "$suffix"
  printf 'state dir:    %s\n\n' "$RG_STATE_DIR"
  local k
  for k in max_rss_mb max_swap_mb min_disk_free_mb interval_seconds grace_seconds \
    node_max_old_space_mb protect_roots dry_run notify vm_volume \
    root_pattern root_cmdline_pattern never_pattern; do
    printf '%-24s %s\n' "$k" "${!k}"
  done
}

rg_cmd_run() {
  if [ "${1-}" = "--" ]; then shift; fi
  [ $# -gt 0 ] || { printf 'runaway: run needs a command\n' >&2; exit 2; }

  mkdir -p "$RG_ROOTS_DIR" || exit 1
  # This shell's pid becomes a scope root, and exec keeps it, so the command and
  # everything it spawns is in scope from the moment it starts. Removed by the
  # daemon once the pid is gone — exec means there is no trap left to do it here.
  : >"$RG_ROOTS_DIR/$$" || exit 1

  # The cheapest guard of the three, and the only one that is a real limit
  # rather than a reaction: V8 refuses the allocation and the process dies with
  # a heap OOM naming your code, instead of growing until something else does.
  # Not set if you already set one — yours wins.
  if [ "$node_max_old_space_mb" -gt 0 ]; then
    case "${NODE_OPTIONS-}" in
      *max-old-space-size*) ;;
      *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$node_max_old_space_mb" ;;
    esac
  fi

  exec "$@"
}

# The header block above IS the help text. Bounded by "stops at the first line
# that is not a comment" rather than by line numbers, so editing the header
# cannot silently start printing shell code at anyone.
rg_usage() {
  awk 'NR > 2 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$RG_SELF"
}

rg_main() {
  local cmd=${1-}
  if [ $# -gt 0 ]; then shift; fi
  case "$cmd" in
    watch) rg_load_config; rg_cmd_watch "$@" ;;
    status) rg_load_config; rg_cmd_status "$@" ;;
    config) rg_load_config; rg_cmd_config "$@" ;;
    run) rg_load_config; rg_cmd_run "$@" ;;
    version | --version) printf 'runaway %s\n' "$RUNAWAY_VERSION" ;;
    help | --help | -h | '') rg_usage ;;
    *) printf 'runaway: unknown command: %s\n\n' "$cmd" >&2; rg_usage >&2; exit 2 ;;
  esac
}

# The tests source this file to exercise the pieces that are not in policy.sh.
[ -n "${RUNAWAY_NO_MAIN-}" ] || rg_main "$@"
