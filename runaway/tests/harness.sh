#!/usr/bin/env bash
# Shared assertions for the runaway test suites. Sourced, never run.

PASS=0
FAIL=0

ok() { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }

bad() {
  printf '  FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3"
  FAIL=$((FAIL + 1))
}

# Every assertion names the defect it guards, not the mechanism it exercises.
eq() {
  local what=$1 want=$2 got=$3
  if [ "$want" = "$got" ]; then ok "$what"; else bad "$what" "$want" "$got"; fi
}

contains() {
  local what=$1 needle=$2 hay=$3
  case "$hay" in
    *"$needle"*) ok "$what" ;;
    *) bad "$what" "output containing: $needle" "$hay" ;;
  esac
}

lacks() {
  local what=$1 needle=$2 hay=$3
  case "$hay" in
    *"$needle"*) bad "$what" "output WITHOUT: $needle" "$hay" ;;
    *) ok "$what" ;;
  esac
}

summary() {
  printf '\n%s: %d passed, %d failed\n' "$1" "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ]
}
