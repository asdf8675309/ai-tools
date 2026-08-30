#!/usr/bin/env bash
#
# runaway — keeps a Mac out of the "your system has run out of application
# memory" panel by acting on the processes that get it there.
#
#   runaway.sh status              what it sees right now, and what it would do
#   runaway.sh probes              every probe, its raw reading, and whether it parsed
#   runaway.sh watch               the daemon loop (this is what launchd runs)
#   runaway.sh watch --once        one tick, then exit
#   runaway.sh watch --dry-run     decide and log, signal nothing
#   runaway.sh ps                  processes runaway has paused, and for how long
#   runaway.sh resume <pid|all>    un-pause them
#   runaway.sh run -- <cmd...>     run a command inside the guard's scope
#   runaway.sh config              the effective configuration and where it came from
#   runaway.sh --help
#
# Named `.sh` so the repo's shell lint picks it up from `git ls-files '*.sh'`.
# install.sh drops a `runaway` symlink on your PATH; the extension is for CI.

set -uo pipefail

RUNAWAY_VERSION=2.0.0

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
RG_STOPPED_DIR="$RG_STATE_DIR/stopped"

# ── defaults ─────────────────────────────────────────────────────────────────

# The per-process cap. Deliberately low: a number nothing you run legitimately
# reaches, crossed by a leak long before the machine is in trouble.
max_rss_mb=8192

# The system-pressure rule — three independent inputs, any one of which trips
# it. See runaway.conf.example for why there are three.
max_pressure_level=2
max_compressed_pct=60
max_swapout_mb_per_sec=0
pressure_sustain_seconds=10
pressure_escalate_seconds=90
pressure_action=stop
resume_on_recovery=1

# No target smaller than this. Once the real offenders are protected or already
# paused, "the largest process I may act on" is whatever tiny thing is left, and
# pausing that relieves nothing.
target_min_mb=512

# Absolute backstops, for the shapes the pressure rule can miss.
max_swap_mb=8192
min_disk_free_mb=10240
vm_volume='/System/Volumes/VM'

# Scope. `agents` is descendants of a root; `user` is every process you own.
#
# The two differ because the two kinds of action differ. The destructive rules
# stay narrow. The pressure rule's default action is SIGSTOP — reversible, no
# work lost — so it is allowed to look at everything you own, because the thing
# filling your swap is very often not something your agent started.
scope=agents
pressure_scope=user

protect_roots=1
root_pattern='^(claude|codex|aider|goose|opencode|cursor-agent)$'
root_cmdline_pattern='claude-code/cli\.js'

# Never signalled, in any scope, at any pressure. Two groups: things whose death
# breaks the session or the desktop, and things holding work you have not saved.
never_pattern='^-?(sh|bash|zsh|fish|dash|ksh)$|^(launchd|login|tmux|screen|ssh|sshd|sudo|su|runaway)$|^(Finder|Dock|SystemUIServer|WindowServer|loginwindow|ControlCenter|NotificationCenter|Spotlight|coreaudiod|bluetoothd|cfprefsd|distnoted|UserEventAgent|securityd|opendirectoryd)$|^(mds|mds_stores|mdworker.*|mdwrite.*)$|^(Terminal|iTerm2|Xcode|Code|Code Helper.*|Electron|nvim|vim|emacs|git)$'

interval_seconds=5
grace_seconds=10
dry_run=0
notify=1
node_max_old_space_mb=4096

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
      max_pressure_level) max_pressure_level=$val ;;
      max_compressed_pct) max_compressed_pct=$val ;;
      max_swapout_mb_per_sec) max_swapout_mb_per_sec=$val ;;
      pressure_sustain_seconds) pressure_sustain_seconds=$val ;;
      pressure_escalate_seconds) pressure_escalate_seconds=$val ;;
      pressure_action) pressure_action=$val ;;
      target_min_mb) target_min_mb=$val ;;
      resume_on_recovery) resume_on_recovery=$val ;;
      scope) scope=$val ;;
      pressure_scope) pressure_scope=$val ;;
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
# exactly one writer and no log-file handling in here. launchd does not rotate
# it; see the README.

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
  # -U restricts this to processes running as you. That is the tool's outermost
  # safety property: nothing it could not signal anyway ever enters the table,
  # so even the widest scope cannot reach another user's process or a system
  # daemon.
  ps -ww -U "$RG_USER" -o pid=,ppid=,rss=,command= 2>/dev/null
}

rg_probe_swap_mb() { sysctl -n vm.swapusage 2>/dev/null | rg_swap_used_mb; }
rg_probe_pressure_level() { sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null | rg_sysctl_int; }
# hw.memsize_usable is physical RAM minus the firmware carveouts, which is the
# denominator that makes "% of RAM" mean what a person reading it thinks. It is
# the newer of the two keys, so hw.memsize is the fallback.
rg_probe_memsize_bytes() {
  local v
  v=$(sysctl -n hw.memsize_usable 2>/dev/null | rg_sysctl_int)
  if [ "$v" -le 0 ]; then v=$(sysctl -n hw.memsize 2>/dev/null | rg_sysctl_int); fi
  printf '%s' "$v"
}
rg_probe_vm_stat() { vm_stat 2>/dev/null | rg_vm_stat; }

rg_probe_disk_mb() {
  local path=$vm_volume
  [ -d "$path" ] || path=/
  df -Pm "$path" 2>/dev/null | rg_df_free_mb
}

# Pull one key out of a `k=v k=v` facts string.
rg_fact() {
  local f
  for f in $1; do
    case "$f" in
      "$2="*)
        printf '%s' "${f#*=}"
        return 0
        ;;
    esac
  done
  printf '%s' "${3--1}"
}

# ── registries ───────────────────────────────────────────────────────────────
#
# Two directories of pid-named files: processes registered as scope roots by
# `runaway run`, and processes runaway has paused. Both are reaped on sight,
# because neither the wrapped command (which execs) nor a paused process can
# clean up after itself.

rg_prune_dir() {
  local dir=$1 f pid out=''
  [ -d "$dir" ] || return 0
  for f in "$dir"/*; do
    [ -e "$f" ] || continue
    pid=${f##*/}
    if ! rg_is_uint "$pid"; then
      rm -f "$f"
      continue
    fi
    if kill -0 "$pid" 2>/dev/null; then
      out="${out:+$out,}$pid"
    else
      rm -f "$f"
    fi
  done
  printf '%s' "$out"
}

rg_roots_csv() { rg_prune_dir "$RG_ROOTS_DIR"; }
rg_stopped_csv() { rg_prune_dir "$RG_STOPPED_DIR"; }

# Paused pids whose timer has run out. Only consulted while pressure is still
# tripped: a process paused during a spike that passed is resumed, not killed.
rg_escalate_csv() {
  local now=$1 f pid at out=''
  [ -d "$RG_STOPPED_DIR" ] || return 0
  [ "${pressure_escalate_seconds:-0}" -gt 0 ] || return 0
  for f in "$RG_STOPPED_DIR"/*; do
    [ -e "$f" ] || continue
    pid=${f##*/}
    rg_is_uint "$pid" || continue
    at=$(cat "$f" 2>/dev/null)
    rg_is_uint "$at" || continue
    if [ $((now - at)) -ge "$pressure_escalate_seconds" ]; then
      out="${out:+$out,}$pid"
    fi
  done
  printf '%s' "$out"
}

# Command lines run to hundreds of characters — a java classpath, an agent's
# own argv. One of those per log line makes the log unreadable at exactly the
# moment you are reading it to find out what happened.
rg_short() {
  local s=${1-}
  if [ "${#s}" -gt 140 ]; then printf '%s...' "${s:0:137}"; else printf '%s' "$s"; fi
}

rg_mb() {
  if rg_is_uint "${1-}"; then printf '%d' "$(($1 / 1024))"; else printf '?'; fi
}

# ── acting ───────────────────────────────────────────────────────────────────

rg_signal() {
  local pid=$1 sig=$2 waited=0
  case "$sig" in
    STOP)
      kill -STOP "$pid" 2>/dev/null || return 0
      mkdir -p "$RG_STOPPED_DIR" 2>/dev/null
      date '+%s' >"$RG_STOPPED_DIR/$pid" 2>/dev/null
      return 0
      ;;
    CONT)
      kill -CONT "$pid" 2>/dev/null
      rm -f "$RG_STOPPED_DIR/$pid"
      return 0
      ;;
  esac

  # A stopped process cannot act on SIGTERM — it is not running, so it never
  # reaches its handler, and the grace period would expire against a process
  # that was never given the chance. Wake it first.
  if [ -e "$RG_STOPPED_DIR/$pid" ]; then
    kill -CONT "$pid" 2>/dev/null
    rm -f "$RG_STOPPED_DIR/$pid"
  fi

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
          rg_log dry-run "would send SIG$sig to pid $pid ($why, ${mb} MB): $(rg_short "$cmd")"
          continue
        fi
        rg_log act "SIG$sig to pid $pid ($why, ${mb} MB): $(rg_short "$cmd")"
        case "$sig" in
          STOP) rg_notify "Paused pid $pid, ${mb} MB — $why. Undo: runaway resume $pid" ;;
          CONT) rg_notify "Resumed pid $pid — $why" ;;
          *) rg_notify "Killed pid $pid, ${mb} MB — $why" ;;
        esac
        rg_signal "$pid" "$sig"
        ;;
      note)
        rg_log warn "$why tripped, but nothing it may act on is over ${target_min_mb} MB; largest process you own is pid $pid ($(rg_mb "$rss") MB): $(rg_short "$cmd")"
        ;;
    esac
  done
}

# ── tick ─────────────────────────────────────────────────────────────────────
#
# State carried between ticks. The swapout counter is cumulative since boot, so
# a rate needs the previous reading; the sustain counters are what stop a
# one-tick spike from pausing anything.

RG_PREV_SWAPOUTS=-1
RG_PREV_EPOCH=-1
RG_TRIP_TICKS=0
RG_CLEAR_TICKS=0

# Exported for status to reuse. Set by rg_gather.
RG_SWAP_MB=-1
RG_DISK_MB=-1
RG_LEVEL=-1
RG_COMP_PCT=-1
RG_SWAPOUT_RATE=-1
RG_MEM_MB=-1

rg_gather() {
  local vm now pagesize comp swapouts memsize comp_bytes rate_pages
  RG_SWAP_MB=$(rg_probe_swap_mb)
  RG_DISK_MB=$(rg_probe_disk_mb)
  RG_LEVEL=$(rg_probe_pressure_level)
  memsize=$(rg_probe_memsize_bytes)
  vm=$(rg_probe_vm_stat)
  now=$(date '+%s')

  pagesize=$(rg_fact "$vm" pagesize)
  comp=$(rg_fact "$vm" compressor)
  swapouts=$(rg_fact "$vm" swapouts)

  RG_MEM_MB=-1
  RG_COMP_PCT=-1
  if [ "$memsize" -gt 0 ]; then
    RG_MEM_MB=$((memsize / 1048576))
    if [ "$comp" -ge 0 ] && [ "$pagesize" -gt 0 ]; then
      comp_bytes=$((comp * pagesize))
      RG_COMP_PCT=$(rg_pct "$comp_bytes" "$memsize")
    fi
  fi

  RG_SWAPOUT_RATE=-1
  if [ "$swapouts" -ge 0 ] && [ "$pagesize" -gt 0 ] && [ "$RG_PREV_EPOCH" -ge 0 ]; then
    rate_pages=$(rg_rate "$RG_PREV_SWAPOUTS" "$swapouts" "$((now - RG_PREV_EPOCH))")
    if [ "$rate_pages" -ge 0 ]; then
      RG_SWAPOUT_RATE=$((rate_pages * pagesize / 1048576))
    fi
  fi
  RG_PREV_SWAPOUTS=$swapouts
  RG_PREV_EPOCH=$now
}

rg_pressure_facts() {
  printf 'level=%s max_level=%s comp_pct=%s max_comp_pct=%s swapout=%s max_swapout=%s' \
    "$RG_LEVEL" "$max_pressure_level" "$RG_COMP_PCT" "$max_compressed_pct" \
    "$RG_SWAPOUT_RATE" "$max_swapout_mb_per_sec"
}

rg_select_facts() {
  printf 'cap_mb=%s target_min_mb=%s protect_roots=%s self_pid=%s extra_roots=%s stopped=%s scope=%s pressure_scope=%s list_all=%s' \
    "$max_rss_mb" "$target_min_mb" "$protect_roots" "$$" "${1-}" "${2-}" "$scope" "$pressure_scope" "${3:-0}"
}

rg_tick() {
  local table decisions roots stopped now tripped why sustained clear_sustained resume escalate

  table=$(rg_ps_table)
  if [ -z "$table" ]; then
    rg_log error "ps produced no output; cannot evaluate this tick"
    return 1
  fi
  roots=$(rg_roots_csv)
  stopped=$(rg_stopped_csv)
  rg_gather
  now=$(date '+%s')

  read -r tripped why <<EOF
$(rg_pressure "$(rg_pressure_facts)")
EOF

  if [ "$tripped" = "1" ]; then
    RG_TRIP_TICKS=$((RG_TRIP_TICKS + 1))
    RG_CLEAR_TICKS=0
  else
    RG_CLEAR_TICKS=$((RG_CLEAR_TICKS + 1))
    RG_TRIP_TICKS=0
  fi
  sustained=0
  clear_sustained=0
  [ $((RG_TRIP_TICKS * interval_seconds)) -ge "$pressure_sustain_seconds" ] && sustained=1
  [ $((RG_CLEAR_TICKS * interval_seconds)) -ge "$pressure_sustain_seconds" ] && clear_sustained=1

  escalate=''
  resume=0
  if [ "$tripped" = "1" ]; then
    escalate=$(rg_escalate_csv "$now")
  elif [ "$resume_on_recovery" = "1" ] && [ "$clear_sustained" -eq 1 ]; then
    resume=1
  fi

  decisions=$(printf '%s\n' "$table" | RG_ROOT_RE="$root_pattern" RG_ROOT_CMD_RE="$root_cmdline_pattern" \
    RG_NEVER_RE="$never_pattern" rg_select "$(rg_select_facts "$roots" "$stopped" 0)")

  printf '%s\n' "$decisions" | rg_plan "$(printf 'swap=%s max_swap=%s disk=%s min_disk=%s pressure=%s pressure_why=%s sustained=%s action=%s escalate=%s resume=%s' \
    "$RG_SWAP_MB" "$max_swap_mb" "$RG_DISK_MB" "$min_disk_free_mb" \
    "$tripped" "$why" "$sustained" "$pressure_action" "$escalate" "$resume")" | rg_execute_plan
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

  if ! rg_is_darwin; then rg_log warn "not macOS: the pressure and swap probes are unavailable, so only the per-process cap and the disk floor apply"; fi
  if [ "$RG_CONFIG_ERRORS" -ne 0 ]; then rg_log warn "config had errors (above); the rejected keys are running on defaults"; fi

  rg_log start "v$RUNAWAY_VERSION config=$RG_CONFIG_SOURCE rss_cap=${max_rss_mb}MB pressure=level>=${max_pressure_level},comp>${max_compressed_pct}%,swapout>${max_swapout_mb_per_sec}MB/s action=$pressure_action scope=$scope pressure_scope=$pressure_scope interval=${interval_seconds}s dry_run=$dry_run"

  trap 'rg_log stop "signalled, exiting"; exit 0' INT TERM

  if [ "$once" -eq 1 ]; then
    # One tick can never compute a swapout rate — that needs two readings — so
    # --once silently has one fewer pressure input than the daemon does.
    rg_tick
    return 0
  fi
  while :; do
    rg_tick
    sleep "$interval_seconds"
  done
}

rg_probe_row() {
  local name=$1 value=$2 unit=$3 rule=$4
  if [ "$value" = "-1" ]; then
    printf '  %-34s %-22s %s\n' "$name" "unavailable" "$rule"
  else
    printf '  %-34s %-22s %s\n' "$name" "$value$unit" "$rule"
  fi
}

rg_cmd_probes() {
  rg_gather
  printf 'runaway %s   probes on this machine\n\n' "$RUNAWAY_VERSION"
  printf 'Anything reading "unavailable" is a rule that will not fire. These come\n'
  printf 'from sysctl and vm_stat, and what they return has changed across macOS\n'
  printf 'releases, so this is the only honest answer for your machine.\n\n'
  printf 'The pressure level is queried by name on purpose: it is readable without\n'
  printf 'root, but flagged hidden, so it does not appear in `sysctl -a` at all.\n\n'
  rg_probe_row 'kern.memorystatus_vm_pressure_level' "$RG_LEVEL" '' "trips at >= $max_pressure_level (1 normal, 2 warn, 4 critical)"
  rg_probe_row 'compressor share of RAM' "$RG_COMP_PCT" '%' "trips above ${max_compressed_pct}%"
  rg_probe_row 'swapout rate' "$RG_SWAPOUT_RATE" ' MB/s' "$([ "$max_swapout_mb_per_sec" -gt 0 ] && printf 'trips above %s MB/s' "$max_swapout_mb_per_sec" || printf 'rule off (see the README on calibrating it)')"
  rg_probe_row 'vm.swapusage used' "$RG_SWAP_MB" ' MB' "trips above $max_swap_mb MB"
  rg_probe_row 'free space on the swap volume' "$RG_DISK_MB" ' MB' "trips below $min_disk_free_mb MB"
  rg_probe_row 'hw.memsize' "$RG_MEM_MB" ' MB' 'used to turn compressor pages into a share'
  printf '\n'
  printf 'The swapout rate needs two readings and so is always unavailable here and\n'
  printf 'under `watch --once`; the daemon has it from its second tick onward.\n'
}

rg_cmd_status() {
  local table roots stopped decisions tripped why plan n kind pid rss flags cmd
  table=$(rg_ps_table)
  if [ -z "$table" ]; then
    printf 'runaway: ps produced no output for user %s\n' "$RG_USER" >&2
    return 1
  fi
  roots=$(rg_roots_csv)
  stopped=$(rg_stopped_csv)
  rg_gather

  read -r tripped why <<EOF
$(rg_pressure "$(rg_pressure_facts)")
EOF

  printf 'runaway %s   config: %s\n\n' "$RUNAWAY_VERSION" "$RG_CONFIG_SOURCE"
  rg_probe_row 'memory pressure (kernel)' "$RG_LEVEL" '' "trips at >= $max_pressure_level"
  rg_probe_row 'compressor share of RAM' "$RG_COMP_PCT" '%' "trips above ${max_compressed_pct}%"
  rg_probe_row 'swapout rate' "$RG_SWAPOUT_RATE" ' MB/s' 'needs two ticks; see `runaway probes`'
  rg_probe_row 'swap used' "$RG_SWAP_MB" ' MB' "trips above $max_swap_mb MB"
  rg_probe_row 'free disk on swap volume' "$RG_DISK_MB" ' MB' "trips below $min_disk_free_mb MB"
  printf '\n'
  if [ "$tripped" = "1" ]; then
    printf '  SYSTEM PRESSURE TRIPPED: %s\n' "$why"
    printf '  (the daemon would wait %ss of this before acting)\n\n' "$pressure_sustain_seconds"
  else
    printf '  system pressure: clear\n\n'
  fi
  [ -n "$roots" ] && printf '  wrapped roots  %s\n' "$roots"
  [ -n "$stopped" ] && printf '  paused by runaway  %s   (runaway ps)\n' "$stopped"

  decisions=$(printf '%s\n' "$table" | RG_ROOT_RE="$root_pattern" RG_ROOT_CMD_RE="$root_cmdline_pattern" \
    RG_NEVER_RE="$never_pattern" rg_select "$(rg_select_facts "$roots" "$stopped" 1)")

  printf 'In scope — everything under /%s/, plus anything over 500 MB that the\n' "$root_pattern"
  printf 'pressure rule may pause (marked `wide`):\n'
  n=0
  while read -r kind pid rss flags cmd; do
    [ "$kind" = "proc" ] || continue
    n=$((n + 1))
    printf '  %7s  %8s MB  %-24s %s\n' "$pid" "$(rg_mb "$rss")" "$flags" "$cmd"
  done <<EOF
$decisions
EOF
  if [ "$n" -eq 0 ]; then
    printf '  (nothing — no agent running, or root_pattern does not match it)\n'
  fi
  printf '\n'

  printf 'Would act on, right now:\n'
  plan=$(printf '%s\n' "$decisions" | rg_plan "$(printf 'swap=%s max_swap=%s disk=%s min_disk=%s pressure=%s pressure_why=%s sustained=%s action=%s' \
    "$RG_SWAP_MB" "$max_swap_mb" "$RG_DISK_MB" "$min_disk_free_mb" "$tripped" "$why" "$tripped" "$pressure_action")")
  if [ -z "$plan" ]; then
    printf '  nothing\n'
  else
    printf '%s\n' "$plan" | while read -r kind pid rss flags why cmd; do
      case "$kind" in
        plan) printf '  SIG%-5s pid %-7s %8s MB  %-30s %s\n' "$flags" "$pid" "$(rg_mb "$rss")" "$why" "$cmd" ;;
        note) printf '  %s tripped, but nothing it may act on (largest process you own: pid %s, %s MB, %s)\n' "$why" "$pid" "$(rg_mb "$rss")" "$cmd" ;;
      esac
    done
  fi
}

rg_cmd_ps() {
  local f pid at now age cmd found=0
  now=$(date '+%s')
  rg_stopped_csv >/dev/null
  if [ ! -d "$RG_STOPPED_DIR" ]; then
    printf 'Nothing paused.\n'
    return 0
  fi
  for f in "$RG_STOPPED_DIR"/*; do
    [ -e "$f" ] || continue
    pid=${f##*/}
    rg_is_uint "$pid" || continue
    at=$(cat "$f" 2>/dev/null)
    rg_is_uint "$at" || at=$now
    age=$((now - at))
    cmd=$(ps -ww -o command= -p "$pid" 2>/dev/null)
    [ -n "$cmd" ] || cmd='(gone)'
    [ "$found" -eq 0 ] && printf '%-8s %-10s %s\n' PID PAUSED COMMAND
    found=1
    printf '%-8s %-10s %s\n' "$pid" "${age}s" "$cmd"
  done
  if [ "$found" -eq 0 ]; then
    printf 'Nothing paused.\n'
  else
    printf '\nResume with: runaway resume <pid>   or   runaway resume all\n'
  fi
}

rg_cmd_resume() {
  local target=${1-} f pid n=0
  if [ -z "$target" ]; then
    printf 'runaway: resume needs a pid, or "all"\n' >&2
    exit 2
  fi
  if [ "$target" = "all" ]; then
    [ -d "$RG_STOPPED_DIR" ] || { printf 'Nothing paused.\n'; return 0; }
    for f in "$RG_STOPPED_DIR"/*; do
      [ -e "$f" ] || continue
      pid=${f##*/}
      rg_is_uint "$pid" || { rm -f "$f"; continue; }
      kill -CONT "$pid" 2>/dev/null
      rm -f "$f"
      printf 'resumed %s\n' "$pid"
      n=$((n + 1))
    done
    [ "$n" -eq 0 ] && printf 'Nothing paused.\n'
    return 0
  fi
  rg_is_uint "$target" || { printf 'runaway: not a pid: %s\n' "$target" >&2; exit 2; }
  # Deliberately not restricted to pids in the registry: if the daemon was
  # killed between the SIGSTOP and the write, the registry is the thing that is
  # wrong, and refusing to resume would leave you with a stopped process and no
  # way to say so.
  kill -CONT "$target" 2>/dev/null || { printf 'runaway: no such process: %s\n' "$target" >&2; exit 1; }
  rm -f "$RG_STOPPED_DIR/$target"
  printf 'resumed %s\n' "$target"
}

rg_cmd_config() {
  local suffix='' k
  if [ ! -r "$RG_CONFIG" ]; then suffix='   (absent — using defaults)'; fi
  printf 'config file:  %s%s\n' "$RG_CONFIG" "$suffix"
  printf 'state dir:    %s\n\n' "$RG_STATE_DIR"
  for k in max_rss_mb target_min_mb max_pressure_level max_compressed_pct max_swapout_mb_per_sec \
    pressure_sustain_seconds pressure_escalate_seconds pressure_action resume_on_recovery \
    max_swap_mb min_disk_free_mb vm_volume scope pressure_scope protect_roots \
    interval_seconds grace_seconds dry_run notify node_max_old_space_mb \
    root_pattern root_cmdline_pattern never_pattern; do
    printf '%-28s %s\n' "$k" "${!k}"
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

  # The cheapest guard here, and the only real limit rather than a reaction: V8
  # refuses the allocation and the process dies with a heap OOM naming your code,
  # instead of growing until something else has to decide. Not set if you already
  # set one — yours wins.
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
    probes) rg_load_config; rg_cmd_probes "$@" ;;
    ps) rg_load_config; rg_cmd_ps "$@" ;;
    resume) rg_load_config; rg_cmd_resume "$@" ;;
    config) rg_load_config; rg_cmd_config "$@" ;;
    run) rg_load_config; rg_cmd_run "$@" ;;
    version | --version) printf 'runaway %s\n' "$RUNAWAY_VERSION" ;;
    help | --help | -h | '') rg_usage ;;
    *) printf 'runaway: unknown command: %s\n\n' "$cmd" >&2; rg_usage >&2; exit 2 ;;
  esac
}

# The tests source this file to exercise the pieces that are not in policy.sh.
[ -n "${RUNAWAY_NO_MAIN-}" ] || rg_main "$@"
