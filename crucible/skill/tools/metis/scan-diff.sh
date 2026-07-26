#!/usr/bin/env bash
# Review a diff with Metis. This is the entry point Crucible's Metis phase uses.
#
#   scan-diff.sh <repo-dir> <diff-file> [--schema NAME] [--output FILE]
#
# ALWAYS exits 0. Metis is a second opinion; a missing second opinion must never
# stop a review that would otherwise complete. When the scan cannot run it says
# why on stderr, optionally files a tracking issue, and returns nothing on stdout.
# On success stdout is Metis's JSON findings.
set -uo pipefail

# shellcheck source=./lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ISSUE_TITLE="Metis security scan skipped — scanner unavailable"

TARGET_ARG="${1:-$PWD}"
DIFF_ARG="${2:-}"
[ $# -gt 0 ] && shift
[ $# -gt 0 ] && shift
PASSTHROUGH=("$@")

if [ -z "$DIFF_ARG" ]; then
  metis_say "✗ metis/scan-diff: usage: scan-diff.sh <repo-dir> <diff-file> [--schema NAME] [--output FILE]"
  exit 0
fi

REPO_ROOT="$(metis_repo_root "$TARGET_ARG")"
metis_load_config "$REPO_ROOT"

issue_body() {
  cat <<'BODY'
Filed automatically by Crucible's optional Metis phase.

A Crucible review completed, but the Metis security second opinion was
**skipped** because the scanner was unavailable. Reviews are still running —
they are running without this extra pass.

To restore it:

- [ ] Start Docker
- [ ] Confirm the Metis Postgres container is up (`docker ps`)
- [ ] Re-run the review

This issue closes automatically on the next run once Metis is reachable again.
BODY
}

# Best effort in every direction: issue bookkeeping must never be able to fail
# the gate. `repo` is always explicit — never inferred from the git remote.
report_unavailable() {
  [ "${CRUCIBLE_METIS_ISSUE_ENABLED:-false}" = "true" ] || return 0
  command -v gh >/dev/null 2>&1 || return 0

  local existing
  existing="$(gh issue list -R "$CRUCIBLE_METIS_ISSUE_REPO" --state open \
    --search "${ISSUE_TITLE} in:title" --json number -q '.[0].number' 2>/dev/null)"
  if [ -n "$existing" ]; then
    metis_say "↳ metis/scan-diff: tracking issue already open (#${existing})"
    return 0
  fi

  # Only labels that already exist are applied; inventing labels is not this
  # tool's business, and an unknown label fails the whole create call.
  local label_flags=() i label known var
  known="$(gh label list -R "$CRUCIBLE_METIS_ISSUE_REPO" --limit 200 --json name -q '.[].name' 2>/dev/null)"
  i=0
  while [ "$i" -lt "${CRUCIBLE_METIS_ISSUE_LABEL_COUNT:-0}" ]; do
    var="CRUCIBLE_METIS_ISSUE_LABEL_${i}"
    label="${!var:-}"
    if [ -n "$label" ] && printf '%s\n' "$known" | grep -Fxq -- "$label"; then
      label_flags+=(--label "$label")
    fi
    i=$((i + 1))
  done

  if gh issue create -R "$CRUCIBLE_METIS_ISSUE_REPO" --title "$ISSUE_TITLE" \
       ${label_flags[@]+"${label_flags[@]}"} --body "$(issue_body)" >/dev/null 2>&1; then
    metis_say "↳ metis/scan-diff: opened a tracking issue in ${CRUCIBLE_METIS_ISSUE_REPO}"
  fi
  return 0
}

resolve_unavailable_issue() {
  [ "${CRUCIBLE_METIS_ISSUE_ENABLED:-false}" = "true" ] || return 0
  command -v gh >/dev/null 2>&1 || return 0
  local n
  for n in $(gh issue list -R "$CRUCIBLE_METIS_ISSUE_REPO" --state open \
               --search "${ISSUE_TITLE} in:title" --json number -q '.[].number' 2>/dev/null); do
    gh issue close "$n" -R "$CRUCIBLE_METIS_ISSUE_REPO" \
      --comment "Metis is reachable again and the scan ran. Closing automatically." >/dev/null 2>&1
  done
  return 0
}

# Scanner-unavailable: worth a tracking issue, because the review silently lost
# a security pass.
skip_unavailable() {
  metis_say "⚠ Metis scan skipped — $1"
  report_unavailable
  exit 0
}

# Caller error or config state: nothing to file, nothing was silently lost.
skip_quiet() {
  metis_say "⚠ Metis scan skipped — $1"
  exit 0
}

[ -n "${CRUCIBLE_METIS_ISSUE_WARNING:-}" ] && metis_say "⚠ metis/scan-diff: ${CRUCIBLE_METIS_ISSUE_WARNING}"

if [ "$CRUCIBLE_METIS_AVAILABLE" != "true" ]; then
  # A disabled integration is the default state, not an incident: say so and go,
  # without filing anything.
  if [ "${CRUCIBLE_METIS_ENABLED:-false}" != "true" ]; then
    metis_say "→ Metis phase off (${CRUCIBLE_METIS_REASON})"
    exit 0
  fi
  skip_unavailable "$CRUCIBLE_METIS_REASON"
fi

[ -f "$DIFF_ARG" ] || skip_quiet "diff file not found: ${DIFF_ARG}"
command -v docker >/dev/null 2>&1 || skip_unavailable "docker is not on PATH"

# Invoked through `bash` rather than directly: an installer that copies this
# tree may not carry the executable bit across.
if ! bash "${CRUCIBLE_METIS_DIR}/ensure-up.sh" "$REPO_ROOT"; then
  skip_unavailable "could not bring up ${CRUCIBLE_METIS_POSTGRES_CONTAINER}"
fi

resolve_unavailable_issue

bash "${CRUCIBLE_METIS_DIR}/run.sh" "$REPO_ROOT" \
  --diff "$DIFF_ARG" \
  --command "review_patch /diff/patch.diff" \
  ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  metis_say "⚠ Metis scan did not complete (exit ${STATUS}) — continuing the review without it"
fi
exit 0
