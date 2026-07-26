#!/bin/bash
# babysit-pr.sh — watch a GitHub PR and emit only actionable state changes.
#
# Usage: babysit-pr.sh <PR#> [repo] [poll_seconds]
#   repo defaults to the current directory's repo; pass owner/name to override
#   branch is derived from the PR (headRefName) — no need to pass it
#   poll_seconds defaults to 60
#
# Env:
#   REVIEWER_PATTERN  case-insensitive regex matched against review author
#                     logins to decide "a bot posted a new review" (default:
#                     copilot). Set it to whatever reviews your PRs.
#
# Emits one line per actionable transition; exits 0 when the PR is MERGED/CLOSED.
# Every line is a state CHANGE, so it stays quiet until something needs you —
# which is what makes it usable as a notification source rather than a log.
#
# This is the polling half of the state machine in skill/SKILL.md. It does not
# decide anything: it reports transitions and names the next action. Reading the
# review channels and applying findings is the part that needs judgment, and
# that part stays with you.
#
# Requires: gh (authenticated), jq.
set -uo pipefail

PR="${1:?usage: babysit-pr.sh <PR#> [repo] [poll_seconds]}"
REPO="${2:-}"
POLL="${3:-60}"
REVIEWER_PATTERN="${REVIEWER_PATTERN:-copilot}"

# Resolve the repo from the working directory when not given. No hardcoded
# fallback: guessing which repository to poll is exactly the wrong thing to
# guess, and a wrong guess reports another repo's state as though it were yours.
if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)
fi
if [ -z "$REPO" ]; then
  echo "ERROR: no repo given and this directory is not a GitHub repo." >&2
  echo "       Pass one explicitly: babysit-pr.sh $PR owner/name" >&2
  exit 1
fi

# Derive the head branch once. The CI query below goes through `gh run list`
# rather than statusCheckRollup because a fine-grained PAT cannot read the
# rollup — it returns empty rather than erroring, which would read as "no CI".
BRANCH=$(gh pr view "$PR" --repo "$REPO" --json headRefName --jq .headRefName 2>/dev/null)
if [ -z "$BRANCH" ]; then echo "ERROR: cannot resolve PR #$PR on $REPO" >&2; exit 1; fi
echo "STATUS: babysitting $REPO#$PR (branch $BRANCH), poll ${POLL}s."

prev_merge=""; prev_ci=""; prev_reviews=""
while true; do
  view=$(gh pr view "$PR" --repo "$REPO" --json state,mergeStateStatus,reviewDecision 2>/dev/null)
  state=$(echo "$view" | jq -r '.state // "UNKNOWN"')
  merge=$(echo "$view" | jq -r '.mergeStateStatus // "UNKNOWN"')

  # Bail clause. Without it a PR closed or merged out of band leaves the loop
  # spinning until something kills it.
  if [ "$state" = "MERGED" ]; then echo "MERGED: $REPO#$PR landed."; exit 0; fi
  if [ "$state" = "CLOSED" ]; then echo "CLOSED: $REPO#$PR closed without merge."; exit 0; fi

  # Collapse the run list to one conclusion. Any failure wins, then any
  # cancellation; SUCCESS requires at least one completed run and every completed
  # run to be success/skipped/neutral. An empty list stays PENDING rather than
  # reading as green — "no runs yet" and "all runs passed" must not collapse
  # into the same value.
  #
  # And the other half of that same rule: a gh call that FAILED must not collapse
  # into PENDING either. An expired token, a rate limit, or a fine-grained PAT
  # without the scope all return nothing, and silently calling that "checks
  # haven't started" is a poll loop that waits forever on a PR that went red an
  # hour ago. "I cannot see the checks" gets its own value, said out loud once.
  if ! runs=$(gh run list --repo "$REPO" --branch "$BRANCH" --limit 12 --json conclusion,status 2>&1); then
    ci="UNKNOWN"
    [ "$prev_ci" != "UNKNOWN" ] && echo "WARN: cannot read CI for $REPO#$PR — ${runs%%$'\n'*}" >&2
  else
    ci=$(printf '%s' "$runs" \
          | jq -r '[.[] | select(.status=="completed") | .conclusion] | (if any(.=="failure") then "FAILURE" elif any(.=="cancelled") then "CANCELLED" elif length>0 and all(.=="success" or .=="skipped" or .=="neutral") then "SUCCESS" else "PENDING" end)')
    ci=${ci:-PENDING}
  fi

  # Review count for the configured reviewer. Act when a NEW one appears — a bot
  # that edits one comment in place leaves a stale verdict looking current, so
  # count arrivals rather than trusting the latest body.
  #
  # The pattern goes in via --arg, not string-interpolated into the jq program.
  # Interpolated, a REVIEWER_PATTERN containing a quote or backslash makes the
  # program a syntax error, which yields an empty count, which reads as "no
  # reviews" — a config typo silently disabling the one check that stops you
  # merging over an unread verdict.
  reviews=$(gh pr view "$PR" --repo "$REPO" --json reviews 2>/dev/null \
        | jq -r --arg p "$REVIEWER_PATTERN" '[.reviews[]? | select(.author.login|test($p;"i"))] | length')
  reviews=${reviews:-0}

  [ "$ci" = "FAILURE" ]   && [ "$ci" != "$prev_ci" ]       && echo "CI FAILURE on $REPO#$PR — investigate failing checks."
  [ "$ci" = "CANCELLED" ] && [ "$ci" != "$prev_ci" ]       && echo "CI CANCELLED on $REPO#$PR."
  { [ "${reviews:-0}" -gt "${prev_reviews:-0}" ] 2>/dev/null; } && echo "REVIEW: a new review landed on $REPO#$PR ($reviews total) — address threads before merge."
  [ "$merge" = "CLEAN" ]    && [ "$merge" != "$prev_merge" ] && echo "READY: $REPO#$PR mergeStateStatus=CLEAN — safe to enqueue (gh pr merge $PR --repo $REPO, no flags)."
  [ "$merge" = "DIRTY" ]    && [ "$merge" != "$prev_merge" ] && echo "CONFLICT: $REPO#$PR mergeStateStatus=DIRTY — needs rebase/conflict resolution."
  [ "$merge" = "UNSTABLE" ] && [ "$prev_merge" = "" ]        && echo "STATUS: $REPO#$PR checks running (UNSTABLE)."

  prev_merge="$merge"; prev_ci="$ci"; prev_reviews="$reviews"
  sleep "$POLL"
done
