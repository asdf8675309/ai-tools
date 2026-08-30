#!/usr/bin/env bash
#
# runaway — decision logic.
#
# Everything in this file is pure: it reads text on stdin and arguments, and
# writes text on stdout. Nothing here probes the machine, sends a signal, or
# touches a file. The platform probes and the signalling live in bin/runaway.sh.
#
# That split is deliberate and it is the whole reason this tool has a test
# suite. The interesting failures of a memory watchdog are all decisions —
# "which process is in scope", "is that over the cap", "what does an unreadable
# probe mean" — and none of them need a Mac under load to exercise. The tests
# pipe a fixture process table through the same functions the daemon calls, on
# Linux CI, and assert the plan.
#
# Sourced, not executed. Every function is prefixed `rg_`.
#
# ── the -1 convention ────────────────────────────────────────────────────────
# Every probe returns -1 for "could not read this", never 0. A probe that failed
# and a probe that read zero must not be the same value: read as a number, -1 is
# below every floor and would have the guard killing something on every tick
# forever. A rule whose input is -1 is disabled for that tick.
#
# ── the facts string ─────────────────────────────────────────────────────────
# The two big functions take their numeric parameters as a single
# space-separated `key=value` string rather than a dozen positional arguments,
# so a call site says what it means and a test reads like the situation it
# describes. Regexes never travel this way — see rg_select.

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

# Integer percent of `total` that `part` represents. -1 if either is unusable,
# so a missing hw.memsize disables the compressor rule rather than reading as
# "0% compressed, all clear".
rg_pct() {
  awk -v part="${1:--1}" -v total="${2:--1}" 'BEGIN {
    if (part + 0 < 0 || total + 0 <= 0) { print -1; exit }
    printf "%d\n", int((part + 0) * 100 / (total + 0))
  }'
}

# Rate of change of a cumulative counter, per second, rounded down.
# A counter that went backwards means it was reset (or this is the first tick),
# which is not a rate — reporting one would be inventing a spike out of a
# restart. -1 for "no rate yet", which disables the rule that reads it.
rg_rate() {
  awk -v prev="${1:--1}" -v cur="${2:--1}" -v secs="${3:-0}" 'BEGIN {
    if (prev + 0 < 0 || cur + 0 < 0 || secs + 0 <= 0 || cur + 0 < prev + 0) { print -1; exit }
    printf "%d\n", int((cur - prev) / secs)
  }'
}

# ── config ───────────────────────────────────────────────────────────────────
#
# Reads a config file on stdin, writes validated `key=value` lines on stdout,
# and complains on stderr about anything it rejected. The caller applies the
# output with an explicit case statement — this never evals, and the config
# file is never sourced. A config file that can run code turns "edit a
# threshold" into a way to execute something as you, and this one is read by a
# process whose entire job is sending signals.

RG_CONF_UINT_KEYS='max_rss_mb target_min_mb max_swap_mb min_disk_free_mb max_pressure_level
max_compressed_pct max_swapout_mb_per_sec pressure_sustain_seconds
pressure_escalate_seconds interval_seconds grace_seconds node_max_old_space_mb'
RG_CONF_BOOL_KEYS='protect_roots dry_run notify resume_on_recovery'
RG_CONF_RE_KEYS='root_pattern root_cmdline_pattern never_pattern'
RG_CONF_STR_KEYS='vm_volume'
RG_CONF_ENUM_SCOPE_KEYS='scope pressure_scope'
RG_CONF_ENUM_ACTION_KEYS='pressure_action'

rg_conf_key_kind() {
  local k=$1 known
  for known in $RG_CONF_UINT_KEYS; do [ "$k" = "$known" ] && { printf 'uint'; return 0; }; done
  for known in $RG_CONF_BOOL_KEYS; do [ "$k" = "$known" ] && { printf 'bool'; return 0; }; done
  for known in $RG_CONF_RE_KEYS; do [ "$k" = "$known" ] && { printf 'regex'; return 0; }; done
  for known in $RG_CONF_STR_KEYS; do [ "$k" = "$known" ] && { printf 'str'; return 0; }; done
  for known in $RG_CONF_ENUM_SCOPE_KEYS; do [ "$k" = "$known" ] && { printf 'scope'; return 0; }; done
  for known in $RG_CONF_ENUM_ACTION_KEYS; do [ "$k" = "$known" ] && { printf 'action'; return 0; }; done
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
      scope)
        case "$val" in
          agents | user) ;;
          *)
            printf 'runaway: config: %s must be agents or user, got: %s\n' "$key" "$val" >&2
            rc=1
            continue
            ;;
        esac
        ;;
      action)
        case "$val" in
          stop | term | kill) ;;
          *)
            printf 'runaway: config: %s must be stop, term or kill, got: %s\n' "$key" "$val" >&2
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

# ── probe parsers ────────────────────────────────────────────────────────────
# The reading half of each probe, separated from the command that produces it so
# the parsing is testable without the platform.

# `sysctl -n vm.swapusage` prints:
#   total = 3072.00M  used = 1024.50M  free = 2047.50M  (encrypted)
# Whole megabytes in use, or -1 if the line is not in that shape.
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

# `vm_stat` output, into a facts string:
#   pagesize=<bytes> compressor=<pages> swapouts=<count> free=<pages>
# Each is -1 if its line was absent.
#
# Two details vm_stat's output has that its readers usually do not:
#
# - Every value carries a trailing period ("Swapouts:  99999."), so the digits
#   are extracted rather than read as a number.
# - There are TWO compressor lines. "Pages occupied by compressor" is the
#   physical pages the compressor consumes; "Pages stored in compressor" is the
#   larger, logical count of uncompressed pages it holds. The first is the one
#   that is a share of your RAM. Matching the wrong one overstates pressure by
#   whatever the compression ratio happens to be.
rg_vm_stat() {
  awk '
    function num(s,   t) { t = s; gsub(/[^0-9]/, "", t); return (t == "") ? -1 : t + 0 }
    /page size of/ {
      for (i = 1; i <= NF; i++) if ($i == "of") { pagesize = num($(i + 1)); break }
    }
    /^Pages free:/                     { free = num($NF) }
    /occupied by compressor/           { comp = num($NF) }
    /^Swapouts:/                       { swapouts = num($NF) }
    END {
      printf "pagesize=%d compressor=%d swapouts=%d free=%d\n",
        (pagesize == "" ? -1 : pagesize), (comp == "" ? -1 : comp),
        (swapouts == "" ? -1 : swapouts), (free == "" ? -1 : free)
    }
  '
}

# A sysctl that should print one non-negative integer and nothing else. Anything
# else — an error on stdout, an empty read, a permissions failure — is -1.
rg_sysctl_int() {
  awk 'NR == 1 { print ($0 ~ /^[0-9]+$/) ? $0 : -1; found = 1 } END { if (!found) print -1 }'
}

# ── scope and per-process selection ──────────────────────────────────────────
#
# stdin:  one process per line, `PID PPID RSS_KB COMMAND...`, as produced by
#         `ps -ww -U <you> -o pid=,ppid=,rss=,command=`.
# $1:     facts — cap_mb, target_min_mb, protect_roots, self_pid,
#         extra_roots (csv), stopped (csv), list_all, scope, pressure_scope
# env:    RG_ROOT_RE, RG_ROOT_CMD_RE, RG_NEVER_RE
# stdout: some of
#         top             <pid> <rss_kb> <cmd>   largest you own, filtered by nothing
#         largest         <pid> <rss_kb> <cmd>   largest actionable under `scope`
#         pressure_target <pid> <rss_kb> <cmd>   largest actionable under `pressure_scope`
#         over            <pid> <rss_kb> <cmd>   each in-scope process above the cap
#         stopped         <pid> <rss_kb> <cmd>   still present, and runaway stopped it
#         proc            <pid> <rss_kb> <flags> <cmd>   only when list_all=1
#         scoped          <count> <total_rss_kb>
#
# Regexes go through the environment, not the facts string and not `-v`. awk
# processes backslash escapes in a -v value, so a perfectly good pattern like
# `cli\.js` arrives at the program as `cli.js` — a silently wider match than the
# one you wrote.
rg_select() {
  RG_FACTS="${1-}" awk '
    function fact(k, d,   i, n, kv, parts) {
      if (!(k in F)) return d
      return F[k]
    }
    function base(s,   n, a) { n = split(s, a, "/"); return a[n] }

    # Descended from a root, or a root itself. Walks up the parent chain,
    # bounded, so a chain that loops or points at a pid that has already exited
    # terminates instead of spinning.
    #
    # self_pid short-circuits BEFORE the root test, so the guard can never plan
    # against itself or anything it spawned — including the case where the guard
    # was started by the very agent it is watching.
    function under_agent(p,   q, d) {
      q = p; d = 0
      while (d < 64 && (q in seen)) {
        if (q == self_pid) return 0
        if (q in root) return 1
        q = ppid[q]; d++
      }
      return 0
    }

    # Not under the guard itself, whatever the scope mode.
    function under_self(p,   q, d) {
      if (self_pid + 0 == 0) return 0
      q = p; d = 0
      while (d < 64 && (q in seen)) {
        if (q == self_pid) return 1
        q = ppid[q]; d++
      }
      return 0
    }

    function in_scope(p, mode) {
      if (mode == "user") return 1
      return under_agent(p)
    }

    # Everything that makes a process off limits regardless of which scope is
    # asking. Ordered cheapest first; each one is a line in the README.
    function protected(p) {
      if (p == 1) return 1
      if (under_self(p)) return 1
      if (protect_roots + 0 == 1 && (p in root)) return 1
      if (never_re != "" && base(argv0[p]) ~ never_re) return 1
      return 0
    }

    BEGIN {
      n = split(ENVIRON["RG_FACTS"], kvs, " ")
      for (i = 1; i <= n; i++) {
        eq = index(kvs[i], "=")
        if (eq > 1) F[substr(kvs[i], 1, eq - 1)] = substr(kvs[i], eq + 1)
      }
      cap_kb        = fact("cap_mb", 0) * 1024
      protect_roots = fact("protect_roots", 1)
      self_pid      = fact("self_pid", 0) + 0
      list_all      = fact("list_all", 0) + 0
      # Wide scope is every process you own, which is hundreds. The status
      # listing shows all of the narrow scope and only the wide-scope processes
      # big enough to ever be chosen.
      list_min_kb   = fact("list_min_mb", 500) * 1024
      # A target has to be big enough to be worth signalling. Without this the
      # guard picks the largest process it MAY act on, which — once the real
      # offenders are protected or already paused — is whatever tiny thing is
      # left. Pausing a 1 MB `sleep` to relieve memory pressure is not a smaller
      # version of the right action, it is the wrong action.
      target_min_kb = fact("target_min_mb", 512) * 1024
      scope         = fact("scope", "agents")
      pscope        = fact("pressure_scope", "user")

      root_re     = ENVIRON["RG_ROOT_RE"]
      root_cmd_re = ENVIRON["RG_ROOT_CMD_RE"]
      never_re    = ENVIRON["RG_NEVER_RE"]

      m = split(fact("extra_roots", ""), xs, ",")
      for (i = 1; i <= m; i++) if (xs[i] ~ /^[0-9]+$/) xroot[xs[i] + 0] = 1
      m = split(fact("stopped", ""), ss, ",")
      for (i = 1; i <= m; i++) if (ss[i] ~ /^[0-9]+$/) halted[ss[i] + 0] = 1
    }

    # A line whose first three fields are not all numeric is not a process row.
    # Skipping it rather than guessing keeps a stray warning on ps stdout from
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
      top_pid = 0; top_rss = -1
      big_pid = 0; big_rss = -1
      prs_pid = 0; prs_rss = -1

      for (i = 1; i <= nord; i++) {
        p = order[i]
        if (rss[p] > top_rss) { top_rss = rss[p]; top_pid = p }

        prot     = protected(p)
        agents   = in_scope(p, scope)
        pressure = in_scope(p, pscope)

        # A process runaway stopped is still holding its memory, so it stays
        # subject to the per-process cap — but it is never chosen again as a
        # target, or the guard would re-stop the same process forever and never
        # reach the second-largest one.
        if ((p in halted) && (p in seen)) printf "stopped %d %d %s\n", p, rss[p], cmd[p]

        if (agents) { nscope++; tscope += rss[p] }

        if (list_all == 1 && (agents || (pressure && rss[p] >= list_min_kb))) {
          flags = (p in root) ? "root" : "-"
          if (prot) flags = flags ",protected"
          if (p in halted) flags = flags ",stopped"
          if (!agents) flags = flags ",wide"
          printf "proc %d %d %s %s\n", p, rss[p], flags, cmd[p]
        }

        if (prot) continue
        if (agents && cap_kb > 0 && rss[p] > cap_kb) printf "over %d %d %s\n", p, rss[p], cmd[p]
        if (p in halted) continue
        if (rss[p] < target_min_kb) continue
        if (agents   && rss[p] > big_rss) { big_rss = rss[p]; big_pid = p }
        if (pressure && rss[p] > prs_rss) { prs_rss = rss[p]; prs_pid = p }
      }

      if (top_pid) printf "top %d %d %s\n", top_pid, rss[top_pid], cmd[top_pid]
      if (big_pid) printf "largest %d %d %s\n", big_pid, rss[big_pid], cmd[big_pid]
      if (prs_pid) printf "pressure_target %d %d %s\n", prs_pid, rss[prs_pid], cmd[prs_pid]
      printf "scoped %d %d\n", nscope + 0, tscope + 0
    }
  '
}

# ── is the machine in trouble ────────────────────────────────────────────────
#
# $1:     facts — level, max_level, comp_pct, max_comp_pct, swapout, max_swapout
# stdout: `<0|1> <reasons>` where reasons is a +-joined list, or `-`
#
# Three independent inputs, any one of which trips it, because they fail in
# different ways. The kernel's own pressure level needs no calibration but may
# not be readable; the compressor share is always computable from vm_stat but is
# a number someone has to pick; the swapout rate is the one that matches "the
# Mac is swapping heavily" directly but is the most machine-specific. Any input
# at -1 is unavailable, any threshold at 0 is off, and either way that input
# simply does not vote.
rg_pressure() {
  RG_FACTS="${1-}" awk '
    function fact(k, d) { return (k in F) ? F[k] : d }
    BEGIN {
      n = split(ENVIRON["RG_FACTS"], kvs, " ")
      for (i = 1; i <= n; i++) {
        eq = index(kvs[i], "=")
        if (eq > 1) F[substr(kvs[i], 1, eq - 1)] = substr(kvs[i], eq + 1)
      }
      why = ""
      if (fact("level", -1) + 0 >= 0 && fact("max_level", 0) + 0 > 0 &&
          fact("level", -1) + 0 >= fact("max_level", 0) + 0)
        why = why (why ? "+" : "") "kernel-pressure"
      if (fact("comp_pct", -1) + 0 >= 0 && fact("max_comp_pct", 0) + 0 > 0 &&
          fact("comp_pct", -1) + 0 > fact("max_comp_pct", 0) + 0)
        why = why (why ? "+" : "") "compressor"
      if (fact("swapout", -1) + 0 >= 0 && fact("max_swapout", 0) + 0 > 0 &&
          fact("swapout", -1) + 0 > fact("max_swapout", 0) + 0)
        why = why (why ? "+" : "") "swapout-rate"
      printf "%d %s\n", (why != "" ? 1 : 0), (why != "" ? why : "-")
    }
  '
}

# ── the plan ─────────────────────────────────────────────────────────────────
#
# stdin:  rg_select output
# $1:     facts — swap, max_swap, disk, min_disk, pressure (0|1),
#         pressure_why, sustained (0|1), action (stop|term|kill),
#         escalate (csv of stopped pids whose timer has run out), resume (0|1)
# stdout: some of
#         plan <pid> <rss_kb> <STOP|CONT|TERM|KILL> <reason> <cmd>
#         note <pid> <rss_kb> NONE <reason> <cmd>
#
# Both shapes are six fields in the same order, so one `read` in the caller
# handles either. A `note` is a rule that tripped with nothing it was allowed to
# act on; its pid/rss/cmd describe the largest process you own, as a lead, and
# the guard deliberately does nothing about it.
#
# Disk plans KILL and skips the grace period on purpose. The other rules can
# afford to ask a process to leave; a boot volume with minutes of headroom
# cannot, because that is the failure that takes the machine with it.
rg_plan() {
  RG_FACTS="${1-}" awk '
    function fact(k, d) { return (k in F) ? F[k] : d }
    function rest(   i, s) { s = ""; for (i = 4; i <= NF; i++) s = s (i > 4 ? " " : "") $i; return s }
    function rank(s) { return (s == "KILL") ? 4 : (s == "TERM") ? 3 : (s == "STOP") ? 2 : 1 }

    # Second and later reasons for the same pid merge into the existing plan.
    # The most urgent signal wins; one process is signalled once, with every
    # reason it earned.
    function add(p, r, sig, why, c) {
      if (!(p in planned)) {
        planned[p] = 1
        porder[++np] = p
        prss[p] = r; psig[p] = sig; pwhy[p] = why; pcmd[p] = c
        return
      }
      pwhy[p] = pwhy[p] "+" why
      if (rank(sig) > rank(psig[p])) psig[p] = sig
    }

    function trip(why, sig, pid, r, c) {
      if (pid) add(pid, r, sig, why, c)
      else if (tpid) printf "note %d %d NONE %s %s\n", tpid, trss, why, tcmd
      else printf "note 0 0 NONE %s -\n", why
    }

    BEGIN {
      n = split(ENVIRON["RG_FACTS"], kvs, " ")
      for (i = 1; i <= n; i++) {
        eq = index(kvs[i], "=")
        if (eq > 1) F[substr(kvs[i], 1, eq - 1)] = substr(kvs[i], eq + 1)
      }
      m = split(fact("escalate", ""), es, ",")
      for (i = 1; i <= m; i++) if (es[i] ~ /^[0-9]+$/) esc[es[i] + 0] = 1
    }

    $1 == "over"            { add($2 + 0, $3 + 0, "TERM", "rss-cap", rest()) }
    $1 == "largest"         { lpid = $2 + 0; lrss = $3 + 0; lcmd = rest() }
    $1 == "pressure_target" { gpid = $2 + 0; grss = $3 + 0; gcmd = rest() }
    $1 == "top"             { tpid = $2 + 0; trss = $3 + 0; tcmd = rest() }
    $1 == "stopped"         { nh++; hpid[nh] = $2 + 0; hrss[nh] = $3 + 0; hcmd[nh] = rest() }

    END {
      if (fact("swap", -1) + 0 >= 0 && fact("max_swap", 0) + 0 > 0 &&
          fact("swap", -1) + 0 > fact("max_swap", 0) + 0)
        trip("swap-ceiling", "TERM", lpid, lrss, lcmd)

      if (fact("disk", -1) + 0 >= 0 && fact("min_disk", 0) + 0 > 0 &&
          fact("disk", -1) + 0 < fact("min_disk", 0) + 0)
        trip("disk-floor", "KILL", lpid, lrss, lcmd)

      # The system-pressure rule. Gated on `sustained` so a one-tick spike from
      # a build starting up does not stop anything: the machine has to still be
      # in trouble the next time we look.
      if (fact("pressure", 0) + 0 == 1 && fact("sustained", 0) + 0 == 1) {
        act = fact("action", "stop")
        sig = (act == "kill") ? "KILL" : (act == "term") ? "TERM" : "STOP"
        trip("pressure:" fact("pressure_why", "-"), sig, gpid, grss, gcmd)
      }

      # A process that was stopped and whose timer has run out while pressure
      # never cleared. Stopping it did not free its memory, so it goes.
      for (i = 1; i <= nh; i++)
        if (hpid[i] in esc) add(hpid[i], hrss[i], "TERM", "pressure-escalate", hcmd[i])

      # Pressure is over and stayed over. Everything runaway stopped goes back.
      if (fact("resume", 0) + 0 == 1)
        for (i = 1; i <= nh; i++)
          if (!(hpid[i] in esc)) add(hpid[i], hrss[i], "CONT", "pressure-cleared", hcmd[i])

      for (i = 1; i <= np; i++) {
        p = porder[i]
        printf "plan %d %d %s %s %s\n", p, prss[p], psig[p], pwhy[p], pcmd[p]
      }
    }
  '
}
