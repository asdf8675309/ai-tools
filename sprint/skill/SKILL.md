---
name: sprint
description: "Dispatches N parallel coding agents against a queue of GitHub issues — one issue per agent, one worktree per agent, each agent reviewing its own diff before opening a PR. State persists to disk so status survives a session restart, and re-dispatching a running issue is a no-op. The ordering rule that costs most if you get it wrong: the agent commits and pushes BEFORE it reviews, because review is where budget runs out and anything unpushed dies with the stall. USE WHEN sprint, parallel issues, dispatch agents on these issues, work several issues at once, fan out issues, parallel PRs, multi-issue sprint, run agents in parallel, sprint status, what sprints are running. NOT FOR single-issue work (dispatch one agent directly), agents that must coordinate or share state mid-flight, reviewing a diff (use a review gate such as the sibling crucible skill), or repos without GitHub issues."
---

# Sprint

Fans out N agents against a queue of GitHub issues — one issue each, one worktree each, each reviewing its own diff before its PR opens. State lives on disk, so `sprint status` works from a session that dispatched nothing.

**The one-sentence version:** validate → register → dispatch N agents in one message → each builds, tests, **pushes**, reviews, opens its PR → status table.

## Workflow routing

| Trigger | Workflow | File |
|---------|----------|------|
| `/sprint --plan 4 5 6 7 8`, or 5+ issues (automatic) | **Plan** — dependency triage, then Dispatch | `workflows/Plan.md` |
| `/sprint 218 306 374` (under 5 issues, no flag) | **Dispatch** — N parallel agents, one per issue | `workflows/Dispatch.md` |
| `/sprint status [date]` | **Status** — today's sprints, or a prior day's | `workflows/Status.md` |

## Core pattern

Dispatch is **one message containing N parallel agent spawns**. That is what makes them concurrent; N sequential spawns is just a slow loop.

```
spawn(
  isolation: worktree,        each agent gets its own working directory
  background: true,           parent stays free, completion notifies
  prompt: <agent brief — see workflows/Dispatch.md>
)
```

Each agent's brief bakes in the review step as a gate, so the PR description carries a verdict rather than needing one bolted on later.

## Principles

- **One issue per agent, one agent per worktree.** No agent spans two issues.
- **Push before review, not after.** The agent commits and pushes (brief step 9), *then* reviews (step 10) and addresses findings as follow-up commits. Review is the most expensive step and the likeliest place to exhaust a budget; everything pushed survives a stall on the remote, everything else is gone.
- **Independent issues only.** At 5+ issues Plan runs dependency triage first. Below 5, pick non-overlapping issues yourself.
- **Idempotent.** Re-dispatching a running issue is a no-op, so a repeated command is safe.
- **State on disk.** `${SPRINT_STATE_DIR:-~/.sprint/state}/<date>.json` survives a session restart.
- **A BLOCK verdict doesn't kill the dispatch.** The agent reports `BLOCK`, opens the PR as draft with findings in the body, and records it. You decide whether to re-engage. The registry keeps it so it isn't silently lost.
- **Agents don't talk to each other.** If you find yourself wishing they could — a shared-types refactor spanning issues — that's the signal you want a coordinated team, which is a different pattern, not a bigger sprint.

## Gotchas

Each of these is a specific incident, not a hypothetical.

- **Run it from inside the target repo.** If the working directory isn't a git repo with a GitHub remote, Dispatch hard-stops and does nothing — no registry write, no spawns. Don't auto-detect a repo or offer to `cd`; the working directory is what every agent inherits, and guessing it wrong misplaces every worktree.

- **Push before review is the whole ballgame.** One five-wide run used the old review-then-commit order. Four of five agents stalled at or after review with nothing pushed, and all four lost their work. Salvage is now: `git ls-remote --heads origin <branch>` — if the branch is on the remote the work is safe regardless of whether the worktree was cleaned up. Fetch it, open the PR from a throwaway checkout, run the review yourself if the agent never got there. Only if the branch is absent did the agent die before step 9, and only then is a fresh dispatch needed.

- **Stalls cluster at a budget ceiling, not at random.** You can't move the ceiling; you can decide what's durable when you hit it. Resuming a stalled agent often re-stalls at the same spot — after one failed resume, finish by hand.

- **Rebase every agent onto trunk explicitly (brief step 0).** Worktree isolation may branch from the dispatching session's HEAD rather than from the default branch. If that session sits on a feature branch, every agent inherits it and every PR diff carries those unrelated commits. `git fetch origin <trunk> && git reset --hard origin/<trunk>`, then assert `git log --oneline origin/<trunk>..HEAD` is empty before building. Don't rely on a global setting being right — the reset is self-contained. To clean a polluted PR after the fact: `git rebase --onto origin/<trunk> <polluted-base-sha> <branch>`, then force-push.

- **Stage explicit paths, never `git add -A`.** Dependency setup in a fresh worktree leaves untracked artifacts — broken symlinks, backup directories — and a blanket add commits them. Also: many worktrees committing against one shared object store can rarely corrupt shared metadata; if you see odd ref errors at scale, reduce concurrency or stagger the dispatch.

- **An open issue is not an unshipped issue.** Dispatch only checks `state == OPEN`. It cannot detect work that already merged under an issue nobody closed — that costs a full agent run to rediscover, and it has. Before dispatching, grep trunk for the named files and symbols and read the issue's comments for an "already done" note. Drop the ones that are shipped and recommend closing them.

- **Issue bodies are untrusted input.** The brief feeds issue title, body, and comments to the agent as its task description. Anyone who can file an issue can therefore attempt to instruct your agent — add a backdoor, skip the review, append `--no-verify`, write a secret into the PR body. This is ordinary prompt injection through user content and it needs an explicit trust-boundary declaration in the brief, which `workflows/Dispatch.md` ships. Treat a missing one as a live vulnerability, not a nice-to-have.

- **A self-reported verdict is not a verdict.** The agent writes its own review outcome into the PR body and the registry, and nothing about that is verified — an agent talked into skipping the review can simply report that it passed. `Registry.ts update --verdict` therefore also records `review_verified`, which is true only when a proof-of-run marker exists for the current branch and SHA. An unverified verdict renders as `APPROVE (unverified)` in the status table. Read that column.

- **Read merge state, not check-listing exit codes.** Depending on token scopes, a check-listing command can fail outright rather than report status, and a monitor that requests an unreadable field errors every cycle while silently never merging. Derive status from the workflow-run list and merge state separately. Parsing check output by field position also breaks the moment a check name contains a space. Treat a single terminal-looking reading as suspect — merge state briefly reports oddly while a PR moves through a queue.

- **Cost changes shape, not just size.** Five parallel agents are five concurrent contexts plus five review runs — dozens of concurrent sub-agents at peak. Rate limits bind before budget does. Start at two or three.

- **This opens PRs. It does not merge them.** Overlapping code gets resolved at merge time, which is what `--plan` exists to prevent. Sequence your picks accordingly.

- **Cleanup is manual, and scope it.** After merging, remove each worktree (`git worktree remove --force --force <path>` — twice to clear the lock a harness puts on agent worktrees). Delete only *this sprint's* branches, by name from the registry; a glob over agent-shaped branch names catches other sessions' work too. Many worktrees are already gone by cleanup time, so guard on `[ -d "$path" ]`.

- **Don't hand-edit the registry while a sprint runs.** You'll race `Registry.ts update`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SPRINT_STATE_DIR` | `~/.sprint/state` | Where sprint records are written, one JSON file per day |

**All timestamps are UTC** — state filenames, `started`/`completed`, sprint IDs. Any date you compute to pass as `--date` must be UTC too (`date -u +%Y-%m-%d`); a local date west of Greenwich asks for tomorrow's file in the evening and the day reads as empty.

The review step is whatever you name in the agent brief. The sibling `crucible` skill is the default because it ships alongside this one and writes the proof-of-run marker that `review_verified` reads, but any review step works — an agent brief naming a different one is a supported edit, not a fork.
