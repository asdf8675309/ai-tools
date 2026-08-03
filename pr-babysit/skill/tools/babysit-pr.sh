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

# stderr is kept — a failed call has to say WHY — but it goes to a FILE, never
# into the variable holding the answer. `cmd 2>&1` folds the two together, and
# gh is not obliged to keep stderr empty on success: an upgrade notice or a
# deprecation warning appended to a captured value silently corrupts it. For
# REPO and BRANCH that value is used verbatim in every later `--repo`/`--branch`
# flag; for the JSON captures it reaches jq as trailing garbage. Both failures
# look exactly like the API being down, which is the confusion this whole file
# exists to remove.
GH_ERR=$(mktemp) || { echo "ERROR: cannot create a temp file for gh diagnostics." >&2; exit 1; }
# Cleanup hangs off EXIT alone. Trapping INT/TERM with a handler that only
# cleans up and RETURNS makes bash resume the loop — an unkillable poller that
# ignores Ctrl-C. These two re-exit so the EXIT trap still fires.
trap 'rm -f "$GH_ERR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# First line of the last gh call's stderr — enough to tell "not authenticated"
# from "rate limited" from "no such PR" without pasting a stack into the log.
gh_err() { head -n 1 "$GH_ERR" 2>/dev/null; }

# Resolve the repo from the working directory when not given. No hardcoded
# fallback: guessing which repository to poll is exactly the wrong thing to
# guess, and a wrong guess reports another repo's state as though it were yours.
if [ -z "$REPO" ]; then
  # "not a repo", "gh not authenticated" and "API unreachable" all produce an
  # empty answer here and have three different fixes; the message is the only
  # thing that distinguishes them.
  if ! REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>"$GH_ERR"); then
    echo "ERROR: could not resolve the repo from this directory: $(gh_err)" >&2
    echo "       Pass one explicitly: babysit-pr.sh $PR owner/name" >&2
    exit 1
  fi
fi
if [ -z "$REPO" ]; then
  echo "ERROR: no repo given and this directory is not a GitHub repo." >&2
  echo "       Pass one explicitly: babysit-pr.sh $PR owner/name" >&2
  exit 1
fi

# Derive the head branch once. The CI query below goes through `gh run list`
# rather than statusCheckRollup because a fine-grained PAT cannot read the
# rollup — it returns empty rather than erroring, which would read as "no CI".
if ! BRANCH=$(gh pr view "$PR" --repo "$REPO" --json headRefName --jq .headRefName 2>"$GH_ERR"); then
  echo "ERROR: cannot resolve PR #$PR on $REPO: $(gh_err)" >&2
  exit 1
fi
if [ -z "$BRANCH" ]; then echo "ERROR: cannot resolve PR #$PR on $REPO" >&2; exit 1; fi
echo "STATUS: babysitting $REPO#$PR (branch $BRANCH), poll ${POLL}s."

prev_merge=""; prev_ci=""; prev_reviews=""
while true; do
  # Same rule the CI query below spells out, applied to the PR itself: a call
  # that FAILED is not a state. Collapsing it into UNKNOWN would re-emit READY
  # on the next CLEAN reading (UNKNOWN is a transition away from CLEAN and back),
  # so an expired token turns into a merge prompt for a PR nobody looked at.
  # Nothing is compared on a failed poll — warn once, keep the last known state,
  # and wait for the next round.
  if ! view=$(gh pr view "$PR" --repo "$REPO" --json state,mergeStateStatus,reviewDecision 2>"$GH_ERR"); then
    echo "WARN: cannot read $REPO#$PR — $(gh_err)" >&2
    sleep "$POLL"
    continue
  fi
  # And a payload that did not PARSE is not a state either — same rule, one
  # layer down. jq failing here yields an empty string, and an empty `merge`
  # resets prev_merge, so the next CLEAN reading re-announces READY: exactly
  # the spurious transition the failed-call branch above exists to prevent.
  if ! state=$(printf '%s' "$view" | jq -r '.state // "UNKNOWN"' 2>"$GH_ERR") \
     || ! merge=$(printf '%s' "$view" | jq -r '.mergeStateStatus // "UNKNOWN"' 2>"$GH_ERR"); then
    echo "WARN: unparseable response for $REPO#$PR — $(gh_err)" >&2
    sleep "$POLL"
    continue
  fi

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
  if ! runs=$(gh run list --repo "$REPO" --branch "$BRANCH" --limit 12 --json conclusion,status 2>"$GH_ERR"); then
    ci="UNKNOWN"
    [ "$prev_ci" != "UNKNOWN" ] && echo "WARN: cannot read CI for $REPO#$PR — $(gh_err)" >&2
  elif ! ci=$(printf '%s' "$runs" \
        | jq -r '[.[] | select(.status=="completed") | .conclusion] | (if any(.=="failure") then "FAILURE" elif any(.=="cancelled") then "CANCELLED" elif length>0 and all(.=="success" or .=="skipped" or .=="neutral") then "SUCCESS" else "PENDING" end)' 2>"$GH_ERR"); then
    # A jq failure is "I cannot see the checks", not "checks haven't started".
    # Defaulting it to PENDING is the same collapse the comment above rejects.
    ci="UNKNOWN"
    [ "$prev_ci" != "UNKNOWN" ] && echo "WARN: cannot parse CI for $REPO#$PR — $(gh_err)" >&2
  else
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
  #
  # And a failed query is not a count of zero. Zeroing it here makes the NEXT
  # successful poll read as "N new reviews landed" for reviews that arrived long
  # ago, and — worse in the other direction — resets the baseline a real arrival
  # is measured against. A failure keeps the previous count and says so.
  if ! reviews_raw=$(gh pr view "$PR" --repo "$REPO" --json reviews 2>"$GH_ERR"); then
    reviews="${prev_reviews:-0}"
    echo "WARN: cannot read reviews for $REPO#$PR — $(gh_err)" >&2
  elif ! reviews=$(printf '%s' "$reviews_raw" \
        | jq -r --arg p "$REVIEWER_PATTERN" '[.reviews[]? | select(.author.login|test($p;"i"))] | length' 2>"$GH_ERR"); then
    # An invalid REVIEWER_PATTERN reaches jq as a bad regex and fails HERE, not
    # at startup. Reported rather than counted as zero, which is the same typo
    # the --arg note above is about, one layer down.
    echo "WARN: cannot count reviews for $REPO#$PR — $(gh_err) (REVIEWER_PATTERN=$REVIEWER_PATTERN)" >&2
    reviews="${prev_reviews:-0}"
  else
    reviews=${reviews:-0}
  fi

  [ "$ci" = "FAILURE" ]   && [ "$ci" != "$prev_ci" ]       && echo "CI FAILURE on $REPO#$PR — investigate failing checks."
  [ "$ci" = "CANCELLED" ] && [ "$ci" != "$prev_ci" ]       && echo "CI CANCELLED on $REPO#$PR."
  { [ "${reviews:-0}" -gt "${prev_reviews:-0}" ] 2>/dev/null; } && echo "REVIEW: a new review landed on $REPO#$PR ($reviews total) — address threads before merge."
  [ "$merge" = "CLEAN" ]    && [ "$merge" != "$prev_merge" ] && echo "READY: $REPO#$PR mergeStateStatus=CLEAN — safe to enqueue (gh pr merge $PR --repo $REPO, no flags)."
  [ "$merge" = "DIRTY" ]    && [ "$merge" != "$prev_merge" ] && echo "CONFLICT: $REPO#$PR mergeStateStatus=DIRTY — needs rebase/conflict resolution."
  [ "$merge" = "UNSTABLE" ] && [ "$prev_merge" = "" ]        && echo "STATUS: $REPO#$PR checks running (UNSTABLE)."

  prev_merge="$merge"; prev_ci="$ci"; prev_reviews="$reviews"
  sleep "$POLL"
done
