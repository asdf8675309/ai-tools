# Sprint

Dispatches N coding agents against a queue of GitHub issues — one issue per agent, one worktree per agent, each one reviewed before its PR opens. For [Claude Code](https://claude.com/claude-code) or any agent runner that can spawn parallel workers and read Markdown.

The manual version of this is N terminal windows. It works, and it makes you the switchboard: no shared state between windows, no completion notifications, the same context loaded N times, and no single view of what is still running. The bottleneck stops being the agents and starts being you.

```
/sprint 218 306 374
      │
      ├─ validate ─→ already running? already shipped? issue open?
      │
      ├─ register ─→ state on disk, survives a session restart
      │
      └─ dispatch ─→ ┌─ agent ─→ worktree ─→ build ─→ test ─→ PUSH ─→ review ─→ PR ─┐
                     ├─ agent ─→ worktree ─→ build ─→ test ─→ PUSH ─→ review ─→ PR ─┤
                     └─ agent ─→ worktree ─→ build ─→ test ─→ PUSH ─→ review ─→ PR ─┘
                                                              │
                                                    /sprint status
```

The capital letters are the point. **The push happens before the review, not after.** Review is the most expensive step in the chain and the most likely place for an agent to run out of budget — so everything before the push dies with a stall, and everything after it survives on the remote branch where you can finish the job by hand.

---

## Install

One dependency you probably have (`gh`), and one you definitely do if you're reading this (`bun`, ≥1.3).

```bash
git clone https://github.com/asdf8675309/ai-tools.git
cd ai-tools/sprint && ./install.sh
```

`install.sh --dry-run` shows what it would do and writes nothing; `--uninstall` removes it and leaves your sprint state alone. It copies the skill into `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/sprint` and touches nothing else — skills are auto-discovered, so there is no settings file to edit.

Or don't install it: read `skill/SKILL.md` and hand it to whatever agent you use. Nothing in it assumes a particular harness beyond `gh` and the ability to spawn parallel workers with their own working directories.

## Use

Run it from inside the repo you want the work done in — not from your agent's config directory.

### Dispatch

```
/sprint 218 306 374
```

Three agents, three worktrees, three PRs. Each one reads its issue, plans, implements, gets tests and typecheck green, stages by explicit path, commits, **pushes**, reviews its own diff, addresses the findings, opens the PR with the verdict in the body, and records the result.

Re-dispatching an issue that's already running is a no-op, so a repeated command is safe.

### Plan

```
/sprint --plan 4 5 6 7 8
```

Fires automatically at five or more issues. Extracts file-shaped signals from each issue's title and body, greps the codebase for them, builds an overlap matrix, and sorts the set into PARALLEL, SEQUENCE, and AMBIGUOUS. You confirm before anything dispatches.

It is a signal, not ground truth — it prevents the obvious merge conflicts, not all of them.

### Status

```
/sprint status
```

One table across every sprint that day: issue, status, worktree, PR, verdict, files changed, duration. State lives on disk, so this works from a session that didn't dispatch anything.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `SPRINT_STATE_DIR` | `$HOME/.sprint/state` | Where sprint records are written, one JSON file per day |
| `CLAUDE_CONFIG_DIR` | `$HOME/.claude` | Install target — where your agent looks for skills |

Everything else is a flag on the command.

**Every timestamp is UTC** — state filenames, `started`/`completed`, and sprint IDs. That's deliberate: it keeps one machine's records comparable with another's and sidesteps DST entirely. The consequence to expect is that a sprint you run at 8pm in New York files under *tomorrow's* date, and `sprint status` with no argument finds it because it asks in UTC too. If you go looking by hand, look under the UTC date: `date -u +%Y-%m-%d`.

---

## What it encodes

Each of these is a specific incident, not a hypothetical.

**Push before you review.** One five-wide run put the review step before the commit. Four of the five agents stalled at or after review with nothing pushed, and all four lost their work — a full day of agent time that existed only in a worktree nobody could find. Reordering two steps is the entire fix. It also mirrors how PR review actually works: you push, *then* the diff gets read.

**Agents stall at a budget cliff, and the cliff is survivable.** Stalls cluster at a consistent token and tool-use ceiling rather than at random. You can't move the ceiling, but you can decide what's already durable when you hit it. After a stall, check the remote for the branch before assuming anything is lost — and if resuming an agent fails once at the same spot, finish it by hand rather than resuming again.

**Branch every agent from trunk, explicitly.** Worktree isolation may branch from your current HEAD rather than from the default branch. If the session that dispatched the sprint is sitting on a feature branch, every agent inherits it and every PR diff carries those unrelated commits. Don't rely on a global setting to be right — have each agent fetch and hard-reset to the trunk as its first action, then assert the base is empty before building.

**Stage by explicit path. Never `git add -A`.** Dependency setup in a fresh worktree leaves untracked artifacts — broken symlinks, backup directories — and a blanket add commits them into the PR.

**An open issue is not an unshipped issue.** A dispatch that only checks `state == OPEN` will happily spend a full agent run rediscovering that the work already merged and nobody closed the ticket. Before dispatching, grep the trunk for the named symbols and read the issue's comments.

**Issue bodies are untrusted input.** The agent reads the issue title, body, and comments and treats them as its task. Anyone who can file an issue can therefore attempt to instruct your agent — add code, skip the review, append `--no-verify`, write a secret into the PR description. This is the same class as any prompt injection through user content, and it needs an explicit trust-boundary declaration in the agent's brief, not good intentions. The skill ships one.

**A self-reported verdict is not a verdict.** The agent writes its own review outcome into the PR body and the registry. Nothing about that is verified, and an agent that was talked into skipping the review can simply report that it passed. If your review tool writes a proof-of-run marker, bind the recorded verdict to the marker's existence — a claim with no artifact behind it should be recorded as unverified.

**Read merge state, not check-listing exit codes.** Depending on token scopes, a check-listing command can fail outright rather than report status, and a monitor that requests an unreadable field errors every cycle while silently never merging. Derive status from the workflow-run list and the merge state separately. Parsing check output by field position also breaks the moment a check name contains a space.

**Cost changes shape, not just size.** Five parallel agents are five concurrent contexts plus five review runs, which at peak can mean dozens of concurrent sub-agents. Rate limits are the binding constraint before your budget is. Start at two or three.

**Cleanup is yours, and scope it.** Worktrees outlive the agents that made them. Delete the branches belonging to *this* sprint by name — a glob over agent-shaped branch names also catches other sessions' work. Many worktrees are already gone by the time you clean up, so guard on existence rather than assuming.

**This opens PRs. It does not merge them.** If two issues touch overlapping code you resolve that at merge time, which is the reason `--plan` exists.

---

## Relationship to the other tools here

[Crucible](../crucible) is what an agent runs against its own diff at the review step. [PR Babysit](../pr-babysit) is what carries the resulting PR from "review finished" to "merged". Sprint is the fan-out in front of both.

Sprint imports nothing from either — every directory in this repo stands alone, and Sprint works with whatever review step you name in the agent brief, including none. The one place they touch is the review marker: if Crucible's enforcement hooks are installed, Sprint records whether a genuine-run marker exists for the branch and SHA rather than trusting the agent's self-report.

## Generalizing

These failure modes were collected running parallel agents against one monorepo with a merge queue, one issue tracker, and one particular set of CI bots. The *shapes* generalize; the specifics may not.

Where a behavior is load-bearing — whether your worktree isolation branches from trunk, which checks are actually required, what your token can read, where your agent's budget ceiling sits — the skill says to confirm it against your own setup rather than asserting it holds everywhere. Confirm those once and the loop runs itself after that.

## License

MIT
