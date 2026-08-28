#!/usr/bin/env bash
#
# runaway — decision logic.
#
# Everything in this file is pure: it reads text on stdin and arguments, and
# writes text on stdout. Nothing here probes the machine, sends a signal, or
# touches a file. The platform probes and the killing live in bin/runaway.sh.
#
# That split is deliberate and it is the whole reason this tool has a test
# suite. The interesting failures of a memory watchdog are all decisions —
# "which process is in scope", "is that over the cap", "what does swap at 6 GB
# mean" — and none of them need a Mac under load to exercise. The tests pipe a
# fixture process table through the same functions the daemon calls, on Linux
# CI, and assert the plan.
#
# Sourced, not executed. Every function is prefixed `rg_`.

# ── small helpers ────────────────────────────────────────────────────────────

rg_is_uint() {
  case "${1-}" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Strip leading/trailing spaces and tabs, then one layer of matching quotes.
# Values in the config file are regexes as often as they are numbers, and a
# regex is a thing people reflexively quote.
rg_trim() {
  local s=${1-} tab
  tab=$(printf '\t')
  while :; do
    case "$s" in
      ' '* | "$tab"*) s=${s#?} ;;
      *) break ;;
    esac
  done
  while :; do
    case "$s" in
      *' ' | *"$tab") s=${s%?} ;;
      *) break ;;
    esac
  done
  case "$s" in
    \"*\") s=${s#\"}; s=${s%\"} ;;
    \'*\') s=${s#\'}; s=${s%\'} ;;
  esac
  printf '%s' "$s"
}

# A malformed regex in the config would otherwise make awk exit non-zero on
# every tick, which reads exactly like "the guard is running and finding
# nothing". Checked once at startup instead.
rg_valid_regex() {
  [ -n "${1-}" ] || return 0
  RG_PROBE_RE="$1" awk 'BEGIN { if ("runaway-probe-string" ~ ENVIRON["RG_PROBE_RE"]) x = 1; exit 0 }' >/dev/null 2>&1
}

# ── config ───────────────────────────────────────────────────────────────────
#
# Reads a config file on stdin, writes validated `key=value` lines on stdout,
# and complains on stderr about anything it rejected. The caller applies the
# output with an explicit case statement — this never evals, and the config
# file is never sourced. A config file that can run code is a config file that
# turns "edit a threshold" into a way to execute something as you.

RG_CONF_UINT_KEYS='max_rss_mb max_swap_mb min_disk_free_mb interval_seconds grace_seconds node_max_old_space_mb'
RG_CONF_BOOL_KEYS='protect_roots dry_run notify'
RG_CONF_RE_KEYS='root_pattern root_cmdline_pattern never_pattern'
RG_CONF_STR_KEYS='vm_volume'

rg_conf_key_kind() {
  local k=$1 known
  for known in $RG_CONF_UINT_KEYS; do [ "$k" = "$known" ] && { printf 'uint'; return 0; }; done
  for known in $RG_CONF_BOOL_KEYS; do [ "$k" = "$known" ] && { printf 'bool'; return 0; }; done
  for known in $RG_CONF_RE_KEYS; do [ "$k" = "$known" ] && { printf 'regex'; return 0; }; done
  for known in $RG_CONF_STR_KEYS; do [ "$k" = "$known" ] && { printf 'str'; return 0; }; done
  return 1
}

rg_parse_conf() {
  local line key val kind rc=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '' | '#'*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *)
        printf 'runaway: config: not a key = value line: %s\n' "$line" >&2
        rc=1
        continue
        ;;
    esac
    key=$(rg_trim "${line%%=*}")
    val=$(rg_trim "${line#*=}")

    if ! kind=$(rg_conf_key_kind "$key"); then
      printf 'runaway: config: unknown key: %s\n' "$key" >&2
      rc=1
      continue
    fi

    case "$kind" in
      uint)
        if ! rg_is_uint "$val"; then
          printf 'runaway: config: %s must be a whole number, got: %s\n' "$key" "$val" >&2
          rc=1
          continue
        fi
        ;;
      bool)
        case "$val" in
          0 | 1) ;;
          *)
            printf 'runaway: config: %s must be 0 or 1, got: %s\n' "$key" "$val" >&2
            rc=1
            continue
            ;;
        esac
        ;;
      regex)
        if ! rg_valid_regex "$val"; then
          printf 'runaway: config: %s is not a valid regex: %s\n' "$key" "$val" >&2
          rc=1
          continue
        fi
        ;;
    esac
    printf '%s=%s\n' "$key" "$val"
  done
  return "$rc"
}

# ── probes, parsing half only ────────────────────────────────────────────────

# `sysctl -n vm.swapusage` prints:
#   total = 3072.00M  used = 1024.50M  free = 2047.50M  (encrypted)
# Returns whole megabytes used, or -1 if the line is not in that shape — which
# is what happens on a non-Darwin machine, and is why the swap rule can be
# skipped rather than silently reading as "0 MB, all clear".
rg_swap_used_mb() {
  awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "used" && $(i + 1) == "=") { v = $(i + 2); break }
        if (substr($i, 1, 5) == "used=") { v = substr($i, 6); break }
      }
    }
    END {
      if (v == "") { print -1; exit }
      u = substr(v, length(v), 1)
      n = v + 0
      if (u == "G") n *= 1024
      else if (u == "K") n /= 1024
      else if (u == "T") n *= 1048576
      printf "%d\n", int(n)
    }
  '
}

# `df -Pm <path>` prints a header and exactly one data line thanks to -P.
# Field 4 is available megabytes. -1 when the output is not that shape.
rg_df_free_mb() {
  awk 'NR == 2 { print ($4 ~ /^[0-9]+$/) ? $4 : -1; found = 1 } END { if (!found) print -1 }'
}

# ── scope and per-process selection ──────────────────────────────────────────
#
# stdin:  one process per line, `PID PPID RSS_KB COMMAND...`, as produced by
#         `ps -ww -U <you> -o pid=,ppid=,rss=,command=`.
# args:   1 max_rss_mb  2 root_regex  3 root_cmdline_regex  4 never_regex
#         5 protect_roots(0|1)  6 self_pid  7 extra_root_pids(csv)  8 list_all(0|1)
# stdout: some of
#         top     <pid> <rss_kb> <cmd>   largest process you own, in scope or not
#         largest <pid> <rss_kb> <cmd>   largest process this guard may signal
#         over    <pid> <rss_kb> <cmd>   each signallable process above the cap
#         proc    <pid> <rss_kb> <flags> <cmd>   only when list_all=1
#         scoped  <count> <total_rss_kb>
#
# Regexes go through the environment, not `-v`. awk processes backslash escapes
# in a -v value, so a perfectly good pattern like `cli\.js` arrives at the
# program as `cli.js` — a silently wider match than the one you wrote.
rg_select() {
  RG_ROOT_RE="${2-}" RG_ROOT_CMD_RE="${3-}" RG_NEVER_RE="${4-}" \
    awk \
    -v max_rss_mb="${1:-0}" \
    -v protect_roots="${5:-1}" \
    -v self_pid="${6:-0}" \
    -v extra_roots="${7-}" \
    -v list_all="${8:-0}" '
    function base(s,   n, a) { n = split(s, a, "/"); return a[n] }

    # In scope = descended from a root, or a root itself. Walks up the parent
    # chain, bounded, so a chain that loops or points at a pid that has already
    # exited terminates instead of spinning.
    #
    # self_pid short-circuits to "not in scope" BEFORE the root test, so the
    # guard can never plan against itself or anything it spawned — including in
    # the case where the guard was started by the very agent it is watching.
    function inscope(p,   q, d) {
      q = p; d = 0
      while (d < 64 && (q in seen)) {
        if (q == self_pid) return 0
        if (q in root) return 1
        q = ppid[q]; d++
      }
      return 0
    }

    BEGIN {
      root_re     = ENVIRON["RG_ROOT_RE"]
      root_cmd_re = ENVIRON["RG_ROOT_CMD_RE"]
      never_re    = ENVIRON["RG_NEVER_RE"]
      if (extra_roots != "") {
        n = split(extra_roots, xs, ",")
        for (i = 1; i <= n; i++) if (xs[i] ~ /^[0-9]+$/) xroot[xs[i] + 0] = 1
      }
    }

    # A line whose first three fields are not all numeric is not a process row.
    # Skipping it rather than guessing keeps a stray warning on ps stderr from
    # being read as a process with a garbage pid.
    $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {
      p = $1 + 0
      c = ""
      for (i = 4; i <= NF; i++) c = c (i > 4 ? " " : "") $i
      seen[p]  = 1
      ppid[p]  = $2 + 0
      rss[p]   = $3 + 0
      cmd[p]   = c
      argv0[p] = $4
      order[++nord] = p
      if (root_re != "" && base($4) ~ root_re) root[p] = 1
      else if (root_cmd_re != "" && c ~ root_cmd_re) root[p] = 1
      if (p in xroot) root[p] = 1
    }

    # Iterated in input order, not `for (p in seen)`, because awk gives no
    # ordering guarantee for the latter and a watchdog that picks a different
    # victim run to run on the same input is untestable.
    END {
      cap_kb = (max_rss_mb + 0) * 1024
      top_pid = 0; top_rss = -1
      big_pid = 0; big_rss = -1

      for (i = 1; i <= nord; i++) {
        p = order[i]
        if (rss[p] > top_rss) { top_rss = rss[p]; top_pid = p }
        if (!inscope(p)) continue

        nscope++
        tscope += rss[p]

        prot = 0
        if (p == 1) prot = 1
        if (protect_roots + 0 == 1 && (p in root)) prot = 1
        if (never_re != "" && base(argv0[p]) ~ never_re) prot = 1

        if (list_all + 0 == 1) {
          flags = (p in root) ? "root" : "-"
          if (prot) flags = flags ",protected"
          printf "proc %d %d %s %s\n", p, rss[p], flags, cmd[p]
        }

        if (prot) continue
        if (rss[p] > big_rss) { big_rss = rss[p]; big_pid = p }
        if (cap_kb > 0 && rss[p] > cap_kb) printf "over %d %d %s\n", p, rss[p], cmd[p]
      }

      if (top_pid) printf "top %d %d %s\n", top_pid, rss[top_pid], cmd[top_pid]
      if (big_pid) printf "largest %d %d %s\n", big_pid, rss[big_pid], cmd[big_pid]
      printf "scoped %d %d\n", nscope + 0, tscope + 0
    }
  '
}

# ── the plan ─────────────────────────────────────────────────────────────────
#
# stdin:  rg_select output
# args:   1 swap_used_mb  2 max_swap_mb  3 disk_free_mb  4 min_disk_free_mb
# stdout: some of
#         plan <pid> <rss_kb> <TERM|KILL> <reason> <cmd>
#         note <pid> <rss_kb> NONE <reason> <cmd>
#
# Both shapes are six fields in the same order, so one `read` in the caller
# handles either. A `note` is a tier that tripped with nothing in scope to act
# on; its pid/rss/cmd describe the largest process you own, as a lead, and the
# guard deliberately does nothing about it.
#
# A probe that returned -1 (unavailable) disables its rule. A threshold of 0
# disables its rule too, which is the documented way to turn one off.
#
# Disk plans KILL and skips the grace period on purpose. The other two tiers
# can afford to ask a process to leave; a boot volume with minutes of headroom
# cannot, because that is the failure that takes the machine with it.
rg_plan() {
  awk \
    -v swap_mb="${1:--1}" \
    -v max_swap_mb="${2:-0}" \
    -v disk_mb="${3:--1}" \
    -v min_disk_mb="${4:-0}" '
    function rest(   i, s) { s = ""; for (i = 4; i <= NF; i++) s = s (i > 4 ? " " : "") $i; return s }

    # Second and later reasons for the same pid merge into the existing plan.
    # KILL wins over TERM; one process is signalled once, with the most urgent
    # reason it earned.
    function add(p, r, sig, why, c) {
      if (!(p in planned)) {
        planned[p] = 1
        porder[++np] = p
        prss[p] = r; psig[p] = sig; pwhy[p] = why; pcmd[p] = c
        return
      }
      pwhy[p] = pwhy[p] "+" why
      if (sig == "KILL") psig[p] = "KILL"
    }

    function trip(why, sig) {
      if (lpid) add(lpid, lrss, sig, why, lcmd)
      else if (tpid) printf "note %d %d NONE %s %s\n", tpid, trss, why, tcmd
      else printf "note 0 0 NONE %s -\n", why
    }

    $1 == "over"    { add($2 + 0, $3 + 0, "TERM", "rss-cap", rest()) }
    $1 == "largest" { lpid = $2 + 0; lrss = $3 + 0; lcmd = rest() }
    $1 == "top"     { tpid = $2 + 0; trss = $3 + 0; tcmd = rest() }

    END {
      if (swap_mb + 0 >= 0 && max_swap_mb + 0 > 0 && swap_mb + 0 > max_swap_mb + 0)
        trip("swap-pressure", "TERM")
      if (disk_mb + 0 >= 0 && min_disk_mb + 0 > 0 && disk_mb + 0 < min_disk_mb + 0)
        trip("disk-pressure", "KILL")
      for (i = 1; i <= np; i++) {
        p = porder[i]
        printf "plan %d %d %s %s %s\n", p, prss[p], psig[p], pwhy[p], pcmd[p]
      }
    }
  '
}
