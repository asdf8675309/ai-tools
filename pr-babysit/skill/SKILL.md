---
name: pr-babysit
description: "Carries a pull request from 'review finished' to 'merged' as an explicit state machine — poll merge state, read every review channel to completion, address each finding, and only then enqueue. Encodes the failure modes that break this loop, starting with the one that costs most: a merge queue lands the PR as soon as checks are green, so enqueueing while still reading review comments merges the pre-fix commit. USE WHEN babysit a PR, carry this PR to merge, watch the PR, monitor CI on my PR, wait for checks then merge, address the review comments and merge, enqueue the PR, why is my PR BLOCKED, the PR merged before my fixes landed, should I turn on auto-merge, why did my PR merge before CI finished, is this PR ready to merge. NOT FOR reviewing the diff itself (use a code review gate such as the sibling crucible skill), authoring the change, or force-merging past a red required check."
---

# PR Babysit

Carries one pull request from *review finished* to *merged*. It is a state machine, not a checklist — the order is the substance, and every rule below is here because something went wrong once.

**The one-sentence version:** CI green → read every review channel to completion → apply or explicitly decline every finding → re-verify on the new HEAD → *then* enqueue → confirm `MERGED`.

**What this does not do:** review the diff. That happens before the PR opens — see the sibling `crucible` skill. This skill starts where review ends and stops when the merge commit exists.

## The states

| State | What is true | What to poll | Leaves when |
|---|---|---|---|
| **OPEN** | Change is reviewed and pushed; no PR yet | — | PR created → SUBSCRIBE. Gate refuses → **GATE-BLOCKED** |
| **GATE-BLOCKED** | A pre-PR review gate refused `gh pr create` | — | Marker earned on the current SHA, or a deliberate visible bypass → OPEN |
| **SUBSCRIBE** | PR exists | — | Subscribed to PR activity (or a poll loop started) → WAIT-CI |
| **WAIT-CI** | Checks in flight against the current HEAD | merge state + run conclusions | All runs completed → REVIEW, CI-RED, or READY. **Nothing ever appears → NO-CI** |
| **CI-RED** | A required check concluded failure/cancelled/timed-out | the failing job's log | Fix pushed → WAIT-CI. Infra flake re-run → WAIT-CI. Not yours to fix → HALT |
| **NO-CI** | The poll keeps reading empty — no runs, no checks | — | Cause identified from the triage list → WAIT-CI (usually after a push), or HALT |
| **REVIEW** | Required checks green; channels not yet fully read | each review channel, filtered to the current HEAD | Every finding applied or declined-with-a-tracked-issue → READY. Any code change → FIX |
| **FIX** | Applying findings | — | Committed and pushed → WAIT-CI (HEAD moved: checks re-run, prior review markers are void, and channels must be re-checked) |
| **READY** | Required checks green **on the current HEAD** and every channel addressed | merge state, one last time | Merge requested → ENQUEUED |
| **ENQUEUED** | Merge requested; queue owns it now | PR `state` | `MERGED` → DONE. Dequeued → WAIT-CI or CI-RED |
| **DONE** | Merge commit exists | — | Merge confirmed by query, follow-up issues filed and linked, outcome reported |
| **HALT** | Needs a human | — | Only a human decision moves this |

**HALT triggers** — stop and ask, do not proceed:

- PR is in **draft** state, or carries a do-not-merge label. Keep watching; say when it is green; do not merge.
- A required check is red for a reason you cannot confidently fix, or the same check goes red twice on different fixes.
- A finding is genuinely contested — an architectural change beyond a surgical fix, or one that crosses a constraint stated elsewhere.
- Merging would require a force-push, a base-branch rewrite, or any other destructive operation.

Ordinary nits, style adjustments, and test-add requests are **not** HALT triggers. Handle them.

## Before the PR opens: is this work already merged?

Two checks, both cheap, both preventing a PR that wastes a full review cycle on content that already landed.

**Is the branch spent?** A squash-merged branch that was never deleted can be re-opened as a brand-new PR re-proposing merged work — the squash commit's SHA never lands on the branch, so the branch looks unmerged. Auto-delete-on-merge does not save you: it fires on *merge*, not on *close*, so a closed PR's branch lingers indefinitely. Test it directly, and delete the branch by hand after closing any PR:

```bash
git merge-base --is-ancestor <recent-merge-sha> origin/<branch>   # exit 1 = branch predates that merge
```

**Did someone else land the same thing?** A long-open PR can be overtaken. The signal is unmistakable: `add/add` conflicts across whole new directories when you update the branch. Check `git log origin/<base> -- <conflict-dir>` to find the PR that got there first, then resolve per-file on merit — take the base's version where it is more developed, keep yours where it carries review fixes the other PR lacks. Afterwards the diff should show only your unique contribution; if it doesn't, the resolution kept something redundant.

**Two-dot and three-dot answer different questions.** Advice on which to use conflicts, and the conflict dissolves once you notice each is answering a different one. `git diff <base>...HEAD` (three-dot, from the merge base) is what the PR *proposes* and what the platform displays; on a stale branch it is the honest measure, since two-dot renders the base's newer commits as deletions. But `git diff <base> HEAD` (two-dot) is what answers *"is any of this still missing from the base branch?"* — and on a squash-merge repo that is the only one that can, because squashing leaves the merge base stale and three-dot re-renders already-merged content as pending. Use three-dot to review scope, two-dot to check whether the PR still has anything left to contribute. Always `git fetch` first; an un-fetched base will invent stranded commits that do not exist.

And when you have new work in hand on a branch that already merged, **start a fresh branch.** Merged branches stay frozen at their merge commit.

## The ordering rule, and why it is the whole skill

A merge queue merges a PR as soon as its required checks are green. It does not know you are mid-edit.

Enqueue first and read review comments in parallel, and the queue can land the **pre-fix** commit while you are still typing. The fixes stay on the branch, unmerged, and have to be re-shipped later. This has happened: enqueued, started applying two inline nits, queue merged the pre-fix head minutes later, both fixes orphaned.

So: **reading and addressing must complete before the enqueue, not alongside it.** If an automated reviewer has not posted yet, wait for it. Every state between WAIT-CI and ENQUEUED exists to enforce that one sequence.

Stated negatively: **green CI is necessary and not sufficient.** Merge state reflects *required checks*, and advisory reviewers are usually not required checks. A PR can read `CLEAN` with an unread reviewer verdict sitting on it that names a real defect. Merging there is a process failure even when nothing bad ships.

## Polling: state, never exit codes

Poll the PR's **merge state**, not a check-listing command.

```bash
gh pr view <N> --repo <owner>/<repo> --json state,mergeStateStatus,headRefOid,mergedAt
gh run list --repo <owner>/<repo> --branch <branch> --limit 20 \
  --json workflowName,status,conclusion,headSha
```

Three separate reasons the check-listing path fails, all observed:

- **Its exit code lies.** A watch-mode check command returned success while CI was still in progress.
- **It may be inaccessible at all.** Depending on token type and scopes, the status-rollup API can return `403 Resource not accessible`, and the command exits 1 immediately instead of watching anything.
- **Position-parsing its output breaks on names with spaces.** Pulling "the status column" with `awk '{print $2}'` returns the *second word of the check's name* when the name is two words, and the comparison silently fails a green PR. Key by name in JSON instead:

```bash
gh pr view <N> --json statusCheckRollup \
  -q '.statusCheckRollup[] | select((.name//.context)=="<required check name>") | (.conclusion//.state)'
```

Those last two points are in tension, deliberately: the name-keyed rollup query is the right way to read a specific check's status *when your token can read the rollup at all*. If it 403s, drop back to `gh run list` filtered by workflow name — same question, different endpoint. Establish once which one your token can do, then stop re-testing it.

Also worth knowing: filtering runs by `--commit <sha>` has returned `[]` for freshly-pushed commits while runs were genuinely firing; `--branch <branch>` plus a client-side filter on `headSha` was reliable. Verify which holds in your setup.

If your harness delivers PR webhook events into the session, **subscribe instead of sleep-polling** — it is strictly more responsive, and some harnesses forbid long sleeps outright.

### `tools/babysit-pr.sh` — the loop above, packaged

This section's polling logic ships as a script so you do not re-derive it each time:

```bash
tools/babysit-pr.sh <PR#> [owner/name] [poll_seconds]
```

It emits **one line per actionable state change** and stays silent otherwise, which is what makes it usable as a notification source rather than a log — if your harness turns process output into notifications, point it at this. Repo defaults to the working directory's; the branch is derived from the PR. `REVIEWER_PATTERN` (default `copilot`) selects which review-author logins count as a new review. Needs `gh` and `jq`. It exits 0 at MERGED or CLOSED — that is the bail clause, and without one a PR closed out of band leaves the loop spinning.

It uses `gh run list` rather than the status rollup for exactly the 403 reason above, and it never collapses "no runs yet" into "all runs passed" — an empty list stays `PENDING`.

**The script decides nothing.** It reports transitions and names the next action; it never enqueues, never merges, never resolves a thread. Everything that needs judgment — reading every review channel, deciding whether a finding is real, choosing to defer one — stays in the states below. Running the script is not babysitting the PR; it is the part of babysitting that can be automated without reading anything.

## Exit conditions for the poll loop

Reproduce this table exactly. Getting it wrong is the single most expensive mistake in the loop.

| Observation | Action |
|---|---|
| `state` is `MERGED` or `CLOSED` | Exit — done (or investigate, if you did not close it) |
| Latest run conclusion is `failure`, `cancelled`, or `timed_out` | Exit loop → CI-RED. Read the job log |
| `mergeStateStatus` is `CLEAN` **and** latest conclusion is `success` | Exit loop → REVIEW / READY |
| New review comments have posted | Exit loop → REVIEW, address them |
| Anything else — `BLOCKED`, `UNSTABLE`, `BEHIND`, checks pending | **Keep polling** |

### `BLOCKED` is ambiguous, not terminal

`BLOCKED` means "merge is not allowed right now." That is equally true when checks have not started, when checks are running, when a check failed, and when a required review is missing. A freshly-pushed PR is always `BLOCKED` at first.

Two opposite mistakes, both real:

- **Exiting on the first `BLOCKED`** throws away the entire CI run and reports a failure that never happened.
- **Camping on `BLOCKED` as "still running"** wastes cycles on a PR that went red minutes ago. One session scheduled three polls on a PR whose lint job had already failed.

Neither. On every `BLOCKED` tick, read the *run conclusion* separately from the merge state. `null`/`in_progress` → keep waiting. `failure` → CI-RED, pull the log. `success` → the block is some other gate; find out which one.

### An empty poll is not "CI hasn't started"

**A poll that cannot tell "no checks yet" from "I can't see checks" is broken.** Both read as an empty list. Before waiting a third cycle on an empty result, work the triage list — four causes, all observed, in rough order of likelihood:

1. **Genuinely not registered yet.** There is a real window where a workflow has been triggered but no run object exists to query. Normal, brief.
2. **Your token cannot see them.** The status-rollup path can be inaccessible to the token you are using, and some run-list filters return `[]` rather than an error. Confirm you can see checks on *any* PR before concluding this one has none.
3. **A skip-CI marker in the commit message.** See the prose-parsing section below — this is silent and there is nothing in the API that explains it.
4. **A trigger-change transition gap.** If the PR edits a workflow's own triggers, it may fire neither the old nor the new one. Triggers evaluated from the *head* ref (`push`, `pull_request`) read your branch's version; triggers evaluated from the *default* branch (`workflow_run`, `schedule`, `workflow_dispatch`) read the base's. Move a workflow from the first kind to the second and there is a one-PR gap where it fires neither way — it only activates after merge. Ship the new trigger alongside the old one first if you need it to run on its own PR, and say so in the PR body so a reviewer doesn't read it as broken.

Only after ruling these out is "this repo has no CI for these paths" a conclusion.

### `UNSTABLE` may be the terminal green state

`UNSTABLE` normally means required checks pass while a non-required check failed or is pending, and it usually resolves to `CLEAN`. But on a PR where the remaining jobs are all non-required or skipped — a workflow-config-only change, for instance — it **never reaches `CLEAN`**, and a `CLEAN`-only wait hangs forever.

Before enqueueing on `UNSTABLE`, confirm the required aggregate check itself is `SUCCESS` (by name, per the query above) and that nothing is still in a non-completed state. Then enqueue.

### `BEHIND` is not automatically a problem

With a merge queue active, a behind-but-non-conflicting PR reaches `CLEAN` on its own — the queue enforces up-to-date-ness against its own synthetic merge commit at queue time, not against your branch head. Reflexively updating the branch there just burns a second CI cycle for a check the queue is about to run anyway.

Update the branch when there is a *reason*: a genuine conflict, a dependency that just merged and you need CI to re-run with it, or the phantom-workspace failure below. Not merely because the PR is behind. Whether your repo behaves this way depends on the queue being configured — verify once and remember.

Without a queue, a "require branches to be up to date" setting means every open PR must update and re-run CI after *any* sibling merges. That is the churn a queue exists to remove, and it is also why a dependency bot's PRs seem to rebase endlessly on a busy repo. If you are drowning in re-runs, that setting plus no queue is the reason — not anything about your PR.

### A green required check can belong to a commit that isn't yours

Required checks are evaluated against the PR's **latest** commit. So a bot that pushes a commit onto your PR — a generated changelog entry, a formatting pass, anything carrying a skip-CI marker — makes *its* commit the one being judged. If that bot also emits a status check using the required check's name, the PR reads green on a commit where the real CI never ran against your code.

This is not hypothetical: a PR merged on that vacuous green before its real CI finished, and an end-to-end workflow then failed *after* merge, on the base branch.

Cheap check: confirm the green belongs to a real workflow run whose head SHA equals the PR's `headRefOid` — and that `headRefOid` is your commit, not a bot's.

```bash
gh pr view <N> --json headRefOid,commits -q '.headRefOid, (.commits[-1].authors[].login)'
```

If a bot is pushing commits onto your PRs at all, that is a repo-level defect to fix rather than route around: generate the artifact locally *before* opening the PR, so the head SHA is always a real authored commit and no synthetic check is needed.

**And a `success` conclusion can mean every step was skipped.** A workflow chained off another one typically resolves "which PR am I for?" from the upstream event, then guards every real step on having found one. When the lookup comes up empty — a non-PR commit, a closed PR's head, or a fork PR, which carries no PR linkage at all — the guarded steps all skip and the run still concludes `success`. A reviewer workflow that never reviewed anything is indistinguishable, from the conclusion alone, from one that approved.

Read the step list, not the conclusion, when a workflow's *output* is what you care about:

```bash
gh run view <id> --json jobs -q '.jobs[].steps[] | "\(.conclusion)\t\(.name)"'
```

A run three steps long is a run that did nothing. This is the same failure as the two above, at a third layer: **green means "nothing objected," not "the thing ran."**

## The phantom-workspace failure

A behind-base branch can fail a required check for something that is not in your diff. Monorepo tooling computes the changed set against the stale merge base, and flags a package that was **renamed on the base branch** since you forked — producing an error naming a package you never touched.

Updating the branch resets the diff base and the check goes green. Do not go hunting for the defect in your diff; there isn't one.

Related, same family: when a required check fails on **pre-existing breakage in an unrelated part of the repo** (workspace-wide checks see everything), fix it in a separate small PR branched off the base, land that, then update your branch. Never bundle the side fix into the feature PR — different review concerns, and a later revert of the feature would re-break the base.

And: local editor diagnostics from a stale worktree ("cannot find module", implicit-any on files you didn't touch) are **not** CI truth. The CI job is authoritative. Do not act on them.

## Review channels

There is rarely one channel. Enumerate what your repo actually has, once, and then read all of them every time. In one setup there were **three**, and reading two of them shipped a real defect:

| Channel | Where it lives | How it is missed |
|---|---|---|
| Inline review comments | `gh api repos/<owner>/<repo>/pulls/<N>/comments` | — |
| Review-level summaries | `gh api repos/<owner>/<repo>/pulls/<N>/reviews` | — |
| A CI action's review summary | posted as an **issue** comment: `gh api repos/<owner>/<repo>/issues/<N>/comments` | Both `pulls/...` endpoints return nothing for it. Easy to never see |
| Scanner annotations | check-run output | Not a comment at all |
| Humans | any of the above | — |

**Merge state does not include advisory channels.** If a reviewer is not a required check, `CLEAN` says nothing about whether it approved, or even ran.

### Freshness: gate on "reviewed the current HEAD", not "a comment exists"

Two distinct traps:

1. **Upserted summaries go stale invisibly.** A CI reviewer that edits one comment in place leaves a passing verdict from an *earlier commit* sitting there looking current. Capture the head SHA and confirm the review ran against it — via the review's `commit_id`, or by matching the workflow run's `headSha`.

2. **A reviewer that runs once on open never comes back.** A built-in reviewer (GitHub's Copilot code review, for example) auto-reviews on open, does **not** re-review your fix commits, and may not appear in the requestable-reviewers list — so there is no way to ask for another pass. Waiting for one in a poll loop waits forever.

The consequence of (2) is important: on a multi-commit PR, **your own local review of the final SHA is load-bearing, not redundant.** When no CI reviewer re-ran, the merge basis is: required checks green on the final SHA + a local review of that SHA. Verify how your reviewers behave — some re-review on push, some don't.

### Outdated threads, and threads you did not create

When your fix moves the lines a thread pointed at, the thread becomes **outdated but still unresolved** — and merge state can still reach `CLEAN` with it sitting there, because required checks are the gate, not conversation resolution.

Two things follow, and they pull in opposite directions, so hold both:

- **Do not block the loop waiting for thread state to change.** It won't. Fix → push → wait for checks on the new HEAD → enqueue.
- **Do not treat "it didn't block" as "it didn't matter."** The finding was real when it was written. Address it or decline it explicitly; the mechanism not enforcing it is exactly why the discipline has to.

**Never auto-resolve a thread you did not create.** Resolving someone else's review thread is their call, not yours — and some harnesses block the write outright. If your repo genuinely requires resolved threads to merge, surface that and let a human do it.

There is a real contradiction here between written policy and observed mechanism: a repo doc may say "merge only when no unresolved threads remain" while the gate demonstrably merges with unresolved-outdated threads present. Trust the mechanism to describe what *will* happen and the policy to describe what *should* — satisfy both by addressing every finding, not by watching thread state.

## Responding to findings

Every finding gets one of three dispositions, and all three end with something written down:

1. **Fix inline** — surgical, in scope. Fix, re-run the affected verification, commit, push, reply on the thread naming the fix commit.
2. **Decline with a reason** — a false positive, or already handled upstream. Reply on the thread saying so and why. Silence is not a disposition.
3. **Defer to a tracked issue** — real but out of this PR's scope, or larger than a surgical fix. **File the issue in the same turn**, then reply on the thread linking it.

On (3): *named work without a number is lost work.* Writing "worth a follow-up" in a PR comment and moving on loses it the moment the conversation ends — closed PRs and merged threads do not surface in backlog sweeps. File it, cross-link both directions (parent references the child, child body says where it came from), and make it legible standalone so nobody has to click through to understand it.

Batch the lower-severity findings into one tracked issue per PR rather than filing five — same rule, less noise.

When a PR spawns a genuinely large wave of follow-ups (ten or more), put the sequencing, dependencies, and an index table in **one parent issue** and give each child a one-line pointer back to it. Duplicating the cross-cutting notes into every child guarantees drift. Which issue serves as parent is a judgement call with consequences — ask rather than picking one silently.

## When the platform reads your prose as a command

Two traps, same mechanism: the platform scans your natural-language text for literal tokens and acts on them. Neither has an "I was only describing it" escape.

### A skip-CI marker anywhere in a commit message suppresses every run

The skip-CI family of tokens is matched **anywhere in the commit message, not just the subject line** — including inside a bullet list in the body that is *describing* the marker. Every workflow is then suppressed, silently. The PR opens, no runs fire, and nothing in the API says why: there are no held or `action_required` runs to find.

The recognizable symptom is the NO-CI state with a twist — **only platform-managed apps run.** A built-in code reviewer and a dependency bot fire; your own CI, scanners, and review workflows do not.

Fix by amending the message to describe the marker in prose ("the workflow-skip marker") rather than quoting it; escaping does not help, because the parser does not honor escapes. Force-push and the runs fire immediately. The same parser reads PR titles — never put the literal token in one.

### A closing keyword next to an issue number closes that issue

GitHub acts on the literal token in a PR title, body, or commit message. `closes #N`, `fixes #N`, `resolves #N` (and past-tense forms, `owner/repo#N`, and full issue URLs) all close the issue on merge — **negation and future tense are invisible to the parser.**

The trap fires precisely when you are being careful. A PR body explaining *"the gate is deliberately not flipped; that closes #N and needs both counts at zero"* closed a tracking issue for a pile of outstanding work one second after merge, marking it COMPLETED and invisible.

Before submitting any PR body or commit message that names an issue you do not intend to close:

```bash
grep -icE '(clos(e|es|ed)|fix(es|ed)?|resolv(e|es|ed)) #[0-9]+' <pr-body-file>
```

Safe rewrites: "that flip is what #N tracks", "#N's exit condition", "tracked in #N". If it happens anyway: reopen immediately and comment that it was a keyword accident, stating the true state.

## Enqueue and confirm

**Call the merge with no extra flags when a queue is active.** A merge queue picks its own configured strategy and handles branch deletion; passing `--squash` gets overridden and `--delete-branch` is rejected outright at CLI parse time. With no queue, pass your repo's merge method explicitly.

```bash
gh pr merge <N> --repo <owner>/<repo>          # queue active: no flags
gh pr view  <N> --repo <owner>/<repo> --json state,mergedAt,mergeCommit
```

### Prefer an explicit enqueue over an auto-merge flag

**Never treat "auto-merge enabled" as "will merge only when green."** Where a repository ruleset grants an actor bypass with mode *always*, the rule **does not apply to that actor at all** — so auto-merge armed by them fires as soon as basic mergeability holds, and required status checks are never enforced. Not delayed, not partially checked: not enforced.

Observed twice on the same repo: 32 seconds from arming to merged, with the aggregate CI gate *failing*; and 10 seconds, with CI still in progress. The default branch landed red both times. A babysit loop is pointless if the merge can outrun it.

**The obvious diagnosis is the wrong one.** The natural first guess is "the failing check isn't in the required list." That guess sends you off auditing required-check configuration, and it is wrong — the aggregate gate was already required. Bypass overrides *any* required-check configuration, so for that user the required list is irrelevant. Diagnostic order:

1. Read the ruleset's `bypass_actors` and each entry's `bypass_mode`. If any mode is `always` and covers the merging actor, **that is the cause.** Stop.
2. Only if no bypass applies, audit the required-check list and per-PR check timing.

**Check both protection systems, not one.** GitHub has two — classic branch protection and rulesets — on different endpoints with non-overlapping visibility. On a ruleset-protected repo the classic endpoint returns `404 Branch not protected`, which reads exactly like "this branch is unprotected" and is wrong.

```bash
gh api repos/<owner>/<repo>/branches/<base>/protection   # classic; 404 here proves nothing
gh api repos/<owner>/<repo>/rulesets                     # rulesets; bypass actors live here
```

**The fix is a mode change, not a removal.** Moving those entries from `always` to per-pull-request keeps break-glass available but makes each use an explicit, auditable action instead of a silent default. Removing the actor entirely also works and leaves no escape hatch for a genuinely stuck PR.

**A merge queue does not deprecate this rule.** Bypass overrides the queue gate exactly as it overrode required checks before the queue existed. Verify the ruleset once, per repo; until you have, use an explicit enqueue and confirm `MERGED` yourself.

### Enqueued is not merged

- Empty output from the merge call is success. Re-running says "already queued" — that is also success, not an error.
- The command's *exit code can lie in the other direction too*: the CLI may print a `fatal:` after the server-side merge already succeeded, because it then tried to fast-forward a diverged local branch as a convenience. **Query `state` before retrying.** `MERGED` means done; retrying a completed merge is how you make a mess.
- Verify the PR is actually *in* the queue rather than sitting in an auto-merge-only state. A no-flags merge has stalled that way before.
- If the queue's own checks fail, the PR is dequeued and lands back in your lap — poll until `MERGED`, do not assume.

**Your PR can pass its own CI and still fail the queue.** The queue builds a synthetic branch with your PR rebased on the ones ahead of it and runs the gating workflows against *that* — "what the base branch will actually look like." Catching semantic conflicts between concurrently-merging PRs (one renames a symbol, another still calls it) is the whole point. A dequeue here is a real signal, not a flake.

Two consequences worth knowing before you go debugging one:

- **Not every check runs on the queue snapshot.** Workflows that compute a diff against the pull-request base have no such payload on a queue event, and are often left PR-only. Their concern areas therefore land on the base branch without re-validation. If your change is squarely in one of those areas, verify it by hand before enqueueing.
- **Never cancel a queue run.** A cancelled run reads as "failed the queue check" and dequeues the PR. Ordinary cancel-in-flight-on-new-push concurrency rules must exclude queue events — if you see PRs mysteriously dequeuing, check that first.

**A token missing one scope can block the merge but not the enqueue.** A PR touching CI workflow files needs elevated scope on the path that *creates* an auto-merge request — but the plain enqueue path, taken when the branch is already up to date, does not. So a merge that fails with a scope complaint on a workflow PR is usually fixable without touching the token: bring the branch current with local git (which authenticates differently from the API token), wait for checks to re-run, then enqueue with no flags. Granting the scope is the one-time real fix.

**A flaky infra failure is not a code failure.** A scanner or comment bot that fails on a parse error with zero findings, then passes on re-run, is infrastructure noise: re-run the failed jobs, do not go looking for a defect and do not record it as one.

## One driver, in a session that stays alive

If you delegate the build to a subagent, **the babysit stays with the caller.** Two things go wrong otherwise, both observed across a six-PR run:

- A background poll launched by a subagent **does not survive the subagent returning.** The agent reports "monitoring in the background," the agent stops, nothing is monitoring, PRs sit unmerged.
- **Two drivers race.** When both the subagent and the caller watch the same PR, one of them merges — and it merged at the pre-fix SHA while the other was still applying review findings.

Pick one driver. The delegate's job ends at "PR open, review read, fixes pushed."

## The review-marker interaction

If a pre-PR review gate is installed (the sibling `crucible` skill ships one), two of its properties shape this loop:

**A marker is keyed to branch + commit.** Any commit after the review — including a one-line fix from the review itself — invalidates it. So: **make every fix first, then review, then open the PR.** Batch the fixes; do not commit them one at a time, each invalidating the last review. Renaming the branch orphans a perfectly valid marker for the same bytes, for the same reason.

**A turn-end hook cannot be satisfied mid-turn.** If the marker is written by a `Stop` hook, then a genuine review plus `gh pr create` *in the same turn* always finds no marker and blocks — the review really happened, the marker just does not exist yet. Review and PR-creation are necessarily separate turns. If your gate also has a TTL, a long gap between them expires an otherwise valid marker.

**Working from a worktree makes both worse.** A gate resolves branch and SHA from the *current* directory, so a marker earned for the feature branch does not satisfy a check running from a different worktree — same repo, same commit, wrong branch name. And an index or tool that points at the main checkout will hand you absolute paths into the wrong working tree, where edits land on whatever branch is checked out there rather than yours. Confirm the path you are editing sits inside the tree holding the branch you intend to commit to, and run the gate-relevant commands from that same directory.

When you do bypass — a review that genuinely happened outside the session, a stale TTL on an unchanged SHA — **say so out loud in the transcript.** Prefer a bypass form that does not persist in the permanent public record: an environment variable leaves no trace in PR history, while an inline token in the PR title does. Which forms your gate honors varies; the sibling hooks accept an env var, an inline token, and a committed sentinel file, checked in that order. Verify yours and use the least-persistent one that works.

## Gotchas

- **Do not merge someone else's PR, or a dependency bot's, without cause.** This loop covers PRs you authored.
- **A dependency bot may refuse to rebase a PR that a human edited**; the "recreate" path rebuilds it fresh against the base and **discards those manual edits**. Fine for a plain version bump, destructive otherwise.
- **Lockfile PRs serialize.** When several dependency PRs edit the same lockfile region, merging one makes the rest conflict. Drain them one at a time, recreate the conflicted set as a batch, and leave the widest-touching one for last.
- **Check what is actually required.** A repo with an aggregate "CI passed" check has *one* required check; everything else is advisory no matter how alarming it looks red. Conversely, standing-red non-required checks on every PR mean the aggregate state is permanently `UNSTABLE` and is not your gate.
- **Subscribe once, not repeatedly.** Subscription is usually idempotent, but re-subscribing per tick is noise.
- **The CI wait is usable time.** A few minutes of passive waiting is exactly the size of a second, orthogonal change — implement that one in the foreground while this PR's checks run, then carry each home in turn. Cheaper than a worktree or a delegated hand-off when the two touch no common files. If they *do* overlap, isolate instead; two branches editing one file will collide the moment the first merges.
- **Report the merge from a query, not from the absence of an error.** "It should be merged by now" is not a state.
