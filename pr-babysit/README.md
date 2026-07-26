# PR Babysit

Carries a pull request from "review finished" to "merged" — as a state machine, for [Claude Code](https://claude.com/claude-code) or any agent that can read Markdown.

Opening the PR is the easy part. What actually costs time is the hour after: checks land in stages, two or three different bots post findings in three different places, one of them never re-reviews your fix, the merge state cycles through values that don't mean what they sound like, and at the end a merge queue lands the commit — possibly not the one you thought.

Most people run this loop from memory. It works until the day it doesn't, and then it fails in one of about a dozen specific ways. This is those dozen ways, written down as states and transitions.

```
OPEN ─→ SUBSCRIBE ─→ WAIT-CI ─┬─→ CI-RED ──→ (fix) ─┐
                              │                     │
                              ├─→ NO-CI ────────────┤
                              │                     │
                              ├─→ REVIEW ─→ FIX ────┤
                              │      │              │
                              │      ↓              └─→ back to WAIT-CI
                              └─→ READY ─→ ENQUEUED ─→ MERGED
```

The arrow that matters is the one that isn't there: **there is no path from WAIT-CI straight to ENQUEUED.** Every finding is read and addressed before the merge is requested, because a merge queue lands the PR the moment required checks go green — it does not know you are mid-edit.

---

## Install

No dependencies and no config. The skill is one Markdown file; the poller is one shell script.

```bash
git clone https://github.com/asdf8675309/ai-tools.git
cp -r ai-tools/pr-babysit/skill "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/pr-babysit"
```

`CLAUDE_CONFIG_DIR` is wherever your Claude Code configuration lives — the same directory your other skills are in. Or skip installing entirely: read `skill/SKILL.md` and hand it to whatever agent you use. There is nothing in it that assumes a particular harness beyond the `gh` CLI.

The `skill/` copy above includes `skill/tools/babysit-pr.sh`, so one copy installs both halves.

### The poller

`skill/tools/babysit-pr.sh` is the mechanical half — it watches a PR and prints one line per *actionable state change*, staying silent otherwise. That silence is the feature: it makes the script usable as a notification source rather than a log to scroll.

```bash
./skill/tools/babysit-pr.sh <PR#> [owner/name] [poll_seconds]
```

Repo defaults to the current directory's; the branch is derived from the PR. `REVIEWER_PATTERN` (default `copilot`) sets which review-author logins count as "a new review landed" — set it to whatever reviews your PRs. Needs `gh` and `jq`.

It exits 0 when the PR reaches MERGED or CLOSED, and it decides nothing: it reports transitions and names the next action. Reading the review channels and applying findings is the part that needs judgment, and the skill is what carries that part.

## Use

With a PR open, or about to be:

```
babysit this PR to merge
```

It will subscribe (or start a poll loop), wait out CI, read every review channel, apply or explicitly decline each finding, file the deferred ones as a tracked issue, enqueue, and confirm the merge actually happened.

It stops and asks — rather than proceeding — on a draft PR, a do-not-merge label, a check it can't confidently fix, a genuinely contested finding, or anything requiring a force-push.

---

## What it encodes

Each of these is a specific incident, not a hypothetical.

**Enqueue last, not first.** A PR was enqueued and then its review comments were read. The queue merged the pre-fix commit minutes later. Both fixes stayed on the branch and had to be re-shipped. Reading and addressing must *complete* before the merge is requested.

**`BLOCKED` is ambiguous, not a verdict.** It means "merge is not allowed right now," which is equally true while checks are pending and after they failed. Exiting a poll loop on the first `BLOCKED` throws away the whole CI run; camping on it as "still running" wastes cycles on a PR that went red ten minutes ago. Both happened. The fix is to read the run conclusion separately from the merge state — the skill carries the full exit-condition table.

**`UNSTABLE` is sometimes the terminal green state.** On a PR whose remaining jobs are all non-required or skipped, `CLEAN` never arrives, and a `CLEAN`-only wait hangs forever.

**Poll state, not exit codes.** A check-listing command returned success while CI was still running. Depending on token scopes it can also fail outright with a 403. And parsing its output by field position breaks the moment a check's name contains a space — `awk '{print $2}'` returns the second word of the name, and a green PR reads as not-green.

**An empty poll is not "CI hasn't started."** A poll that can't distinguish "no checks yet" from "I can't see checks" is broken, and there are four causes that all read as an empty list — including two silent ones. A skip-CI marker anywhere in a commit message body, even in prose *describing* the marker, suppresses every workflow with nothing in the API to explain it; the tell is that only platform-managed apps run. And a PR that changes a workflow's own trigger can fire neither the old nor the new one, because the two kinds are read from different branches.

**Some reviewers review once and never come back.** A built-in reviewer that runs on open may not re-review your fix commits and may not be requestable, so waiting for a second pass waits forever. The consequence: on a multi-commit PR, your own review of the final commit is load-bearing.

**Some reviewers post where you aren't looking.** A CI action's review summary can arrive as an *issue* comment, which the pull-request comment endpoints do not return. One setup had three channels; reading two of them merged a real defect.

**A stale summary looks exactly like a fresh one.** A bot that edits a single comment in place leaves an approving verdict from an earlier commit sitting there looking current. Gate on "this review ran against the current head", not "a comment exists".

**Outdated threads may not block, and still matter.** When a fix moves the lines a thread pointed at, the thread goes outdated-but-unresolved and merge state can still reach `CLEAN` — required checks are the gate, conversation resolution isn't. Don't wait on thread state; don't treat "it didn't block" as "it didn't matter". (And never auto-resolve a thread you didn't write.)

**Green CI is necessary and not sufficient.** Merge state reflects required checks. Advisory reviewers usually aren't required checks. Merging with an unread verdict on the PR is a process failure even when nothing bad ships.

**A review marker dies when HEAD moves.** Branch+SHA-keyed review gates invalidate on any new commit, including the one-line fix the review itself asked for. Batch fixes; review once at the end. And a marker written by a turn-end hook can never be satisfied mid-turn — review and PR-creation are necessarily separate turns, even though the review genuinely happened.

**A behind-branch can fail on a phantom package.** Monorepo tooling diffs against the stale merge base and flags a package renamed on the base since you forked — an error naming code you never touched. Update the branch; there is no defect to find.

**Auto-merge is not "merge when green."** Where a repository ruleset grants an actor bypass in always-mode, the rule doesn't apply to that actor — so auto-merge armed by them fires as soon as the PR is mergeable, with required checks not enforced at all. Two PRs merged 32 and 10 seconds after arming; one had the aggregate CI gate failing, the other had CI still running. Both landed the default branch red. The obvious diagnosis — "the failing check isn't in the required list" — is wrong and costs an hour: bypass overrides *any* required-check configuration, so check bypass actors and their mode first, and audit required checks only if no bypass applies. Prefer an explicit enqueue.

**A green required check can belong to a commit that isn't yours.** Required checks are judged on the PR's latest commit. A bot that pushes a commit onto your PR and emits a check under the required check's name makes the PR read green on a commit where the real CI never ran. One PR merged on that vacuous green and broke the base branch after the fact.

**Enqueued is not merged.** The merge command can print a fatal error *after* the server-side merge succeeded, because it then tried to fast-forward a diverged local branch. Query the state before retrying. And a PR can pass its own CI and still fail the queue — the queue re-runs against your PR rebased on the ones ahead of it, which is how it catches two PRs that only conflict with each other.

**One driver.** A background poll launched by a subagent does not survive the subagent returning — the agent reports "monitoring in the background", stops, and nothing is monitoring. Worse, two drivers race: one of them merged at the pre-fix SHA while the other was still applying findings.

**Don't write a closing keyword next to an issue you aren't closing.** GitHub acts on the literal token; negation and future tense are invisible to it. A PR body explaining why work was *not* finished closed its tracking issue one second after merge. The skill carries the grep for it.

---

## Relationship to `crucible`

[Crucible](../crucible) reviews the diff. This carries the PR home. They're sequential, and the seam between them is the review marker: Crucible's optional enforcement hooks write a branch+SHA-keyed record that `gh pr create` checks, which is why "batch every fix before the final review" appears in both.

Neither depends on the other. Use this with any review process, or none.

## Generalizing

The failure modes above were collected on one GitHub Enterprise setup with a merge queue and a particular set of bots. The *shapes* generalize; the specifics may not.

Where a behavior is load-bearing — a queue merging on green, a bot reviewing only once, which check is actually required, whether your reviewers re-review on push — the skill says so and tells you to confirm it against your own repo rather than asserting it holds everywhere. Verify those once, and the loop runs itself after that.

## License

MIT
