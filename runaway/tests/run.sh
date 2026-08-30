#!/usr/bin/env bash
# Runs every suite in this directory. `bun run test` calls this.
#
# Pure shell and awk on purpose: these suites exercise the decision logic, which
# is platform-independent, so they run on the Linux CI runner exactly as they run
# on the Mac the tool is for. Nothing here needs a process to actually die.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rc=0
for suite in "$HERE"/*.test.sh; do
  [ -e "$suite" ] || continue
  printf '\n== %s ==\n' "$(basename "$suite")"
  bash "$suite" || rc=1
done

if [ "$rc" -eq 0 ]; then printf '\nall suites passed\n'; else printf '\nSUITE FAILURES\n'; fi
exit "$rc"
