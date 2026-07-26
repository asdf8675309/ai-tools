# Crucible enforcement hooks

Two [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks) that make code review non-skippable. This is software that tells you "no" — read this whole file before installing it.

**Honest statement up front: this hook can block a command you expected to succeed.** If you run `gh pr create` and this is installed, it may refuse. That's the entire point of it, but it will surprise you at least once if you skip this file.

Installing these is **opt-in and never automatic** — nothing in this repo edits your `settings.json` for you, including `install.sh` (it stages the files and prints the block below, then stops).

## What it does

| File | Hook type | Job |
|---|---|---|
| `mark-review.ts` | `Stop` | After each turn, checks this session's own transcript for a real review. If it finds one, writes a marker for the current branch+commit. |
| `gate-pr.ts` | `PreToolUse` on `Bash` | Intercepts `gh pr create` and `gh pr merge --auto`. Blocks unless a matching marker exists. |

**Exactly which command is intercepted, and when it blocks:** `gate-pr.ts` only looks at `Bash` tool calls whose command matches `gh pr create` or `gh pr merge --auto`. Everything else — every other Bash command, every other tool — passes through untouched; the hook doesn't even parse it. For a matching command, it blocks (exit code 2, PR not created) unless one of these is true:

- a marker file exists for the exact repo + branch + commit SHA you're on, is less than 30 minutes old, and was written by `mark-review.ts` with enough distinct reviewer tags in it, **or**
- the diff is provably inert (see "Docs-only diffs" below), **or**
- you used one of the bypasses (see "Bypass" below).

"Enough distinct reviewer tags" means: `mark-review.ts` scans your session transcript for sub-agent dispatches whose prompt contains a literal `Crucible-Reviewer: <name>` tag, timestamped at or after your current commit. It counts *distinct* tag values, not dispatch count — five dispatches all tagged `security` count as one. It needs `CRUCIBLE_MIN_ROSTER` distinct tags (default **6**) before it writes a marker. If you're using this alongside the Crucible skill in this same repo, its reviewer prompts already emit this tag (see `skill/SKILL.md` and `skill/workflows/FullReview.md`) — you don't have to do anything extra. If you're using your own review process, tag each reviewer dispatch's prompt with `Crucible-Reviewer: whatever-name-you-want` and the count still works; the names aren't a fixed vocabulary.

There is no command, no flag, and no file format that lets an agent hand-author a passing marker. The *only* code path that writes one is `mark-review.ts`, reading transcript files Claude Code itself produced for this session.

### Limits — read this before relying on it

The gate raises the cost of skipping review. It does not make skipping impossible, and there are two evidence paths with different strengths.

**The structural path is strong.** Tags found in the main transcript come from `tool_use` blocks — the recorded arguments of dispatches that actually happened. An agent cannot add one without dispatching.

**The sub-agent fallback is weaker, by necessity.** A review that fans out *inside* one sub-agent leaves no per-lens dispatches in the main transcript, so `mark-review.ts` also reads `subagents/*.jsonl` and scans the assistant-authored **text** for tags. Text is something a model writes, which means that path is prose making a claim about itself — precisely the shape a gate should distrust.

Two things narrow it: the transcript must name the reviewed commit's SHA, and it must contain at least `CRUCIBLE_MIN_SUBAGENT_TOOL_CALLS` (default **5**) `tool_use` blocks. A transcript that names the lenses but never called a tool did not review anything; it wrote about reviewing, and is rejected.

**What that still leaves.** An agent that reads a handful of files and *then* writes the tag lines clears both bars without doing a real review. Closing that would mean rejecting the inline-fan-out shape entirely, which is a legitimate way to run a review. If you want the stronger property, set `CRUCIBLE_MIN_ROSTER` high enough that only genuine per-lens dispatches can reach it, and run your reviewers as top-level dispatches.

Treat this as a gate against forgetting and against casual skipping — which is what actually happens — not as a defense against an adversary who wants to bypass it.

## The branch+SHA keying consequence

**A marker is only valid for the exact commit it was written against.** Push one more commit — even a one-line typo fix after review — and the marker no longer matches; `gate-pr.ts` will block until you review again.

This is intentional, not a bug: a new commit is, by definition, unreviewed code. But it means "review, then make one more small fix, then open the PR" requires a second review pass. If that's surprising the first time it happens, this paragraph is why.

## Where state is written

Markers live inside your repo's own `.git` directory: `<git-common-dir>/crucible/pre-pr-review/<branch>-<sha>.json`. `git rev-parse --git-common-dir` resolves to the *shared* `.git` for a repo, so every worktree of the same repo sees the same markers.

This is never committed (it's inside `.git/`, not your working tree) and is trivial to wipe:

```bash
rm -rf "$(git rev-parse --git-common-dir)/crucible"
```

Nothing is written outside your repo's own `.git` directory — no global state, no home-directory cache.

One network call: `gate-pr.ts` runs `git fetch origin <base> --quiet` when classifying a docs-only diff, so the comparison is against the real fetched tip rather than a possibly-stale local ref (see below). It contacts your own git remote and nothing else. If the fetch fails, the diff is not treated as inert and the normal marker check applies.

## Docs-only diffs skip the gate entirely

If every changed file is `.md`, `.txt`, or `.rst`, and the diff adds 1000 lines or fewer, `gate-pr.ts` allows `gh pr create` without requiring a marker at all — there's nothing executable to review. This is deliberately narrow and hardcoded in `gate-pr.ts` (not read from any config file), because a false "this is safe" verdict here is the one mistake that would let real code through unreviewed:

- Files that steer agent behavior — `CLAUDE.md`, `AGENTS.md`, `SKILL.md`, anything under `.claude/` or `.github/`, custom `commands/`/`agents/` directories — are **never** treated as inert, even though some of those are `.md` files. Changing what an agent does is not a docs change.
- Any file with a non-doc extension anywhere in the diff forces the full gate.
- The check runs `git fetch origin <base branch> --quiet` and diffs the real fetched tip (`FETCH_HEAD`), not a possibly-stale local ref, so a diff can't hide code behind a ref that hasn't been updated.
- If anything about this check fails or can't be determined — no network, an unparseable `--base`, an ambiguous shell command with `cd`/`;`/`&` before the `gh` call — it falls through to the normal marker check. A diff it can't classify is never treated as light.

## Install

Add this to your `settings.json` (project-level `.claude/settings.json`, or your global Claude Code settings — your choice):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/crucible/mark-review.ts" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/crucible/gate-pr.ts" }
        ]
      }
    ]
  }
}
```

Adjust the path if you didn't use `install.sh` (which stages this directory at `$CLAUDE_CONFIG_DIR/hooks/crucible`, `$HOME/.claude/hooks/crucible` by default) or copied these files somewhere else. Both files are self-contained — `mark-review.ts`, `gate-pr.ts`, and `lib/shared.ts` are the whole thing, no other install step, no dependency install. They run under [Bun](https://bun.sh) (`#!/usr/bin/env bun` shebang, executable bit set) — if you'd rather not rely on the shebang, use `"command": "bun $HOME/.claude/hooks/crucible/mark-review.ts"` instead.

If your `settings.json` already has `Stop` or `PreToolUse` entries, merge the arrays rather than replacing them — most Claude Code setups have other hooks registered there already.

## Bypass

In priority order, checked before anything else:

1. **Env var:** run with `CRUCIBLE_REVIEW_BYPASS=1` set. Allows the command immediately, before any check.
2. **Inline token:** include the literal text `[skip-crucible-review]` anywhere in the `gh` command.
3. **Sentinel file:** commit a `.no-crucible-review` file at the repo root. Opts that whole repo out permanently, until the file is removed.

Every bypass **prints to stderr when used** — never silent. If you see `[crucible gate] bypassed via ...` in the transcript, that's this hook telling you it let something through without confirming a review.

Use the bypass for real exceptions: a hotfix where the review already happened outside this session, a repo where you've decided this workflow doesn't apply, a one-off you've consciously decided to skip. Reaching for it every time defeats the purpose of installing this at all — at that point, remove it instead (see below).

## Uninstall

This never touched your `settings.json` — you added those entries by hand, so remove them by hand:

1. Delete (or comment out) the two hook entries you added under `Stop` and `PreToolUse` in `settings.json`.
2. Delete the hook files: `rm -rf $HOME/.claude/hooks/crucible` (or wherever you put them) — or run `./install.sh --uninstall` from the cloned repo, which does the same thing after confirming.
3. Optional cleanup: delete any leftover marker state per-repo with `rm -rf "$(git rev-parse --git-common-dir)/crucible"` in each repo you used this in. Harmless to leave — it's inert once the hooks are gone.

That's it. Nothing else was modified.

## Configuration

Everything is a constant in `lib/shared.ts` or an environment variable — there's no config file for the hooks themselves (the Crucible *skill* has its own `config.yaml`; these hooks don't read it, by design — see "Self-contained" below).

| Setting | Default | Override |
|---|---|---|
| Minimum distinct reviewer tags for a marker | 6 | `CRUCIBLE_MIN_ROSTER=<n>` env var, or edit `MIN_ROSTER` in `lib/shared.ts` |
| Marker time-to-live | 30 minutes | edit `MARKER_TTL_MS` in `lib/shared.ts` |
| Sentinel opt-out filename | `.no-crucible-review` | edit `SENTINEL_FILE` in `lib/shared.ts` |
| Inline bypass token | `[skip-crucible-review]` | edit `BYPASS_TOKEN` in `lib/shared.ts` |
| Sub-agent dispatch tool name(s) scanned | `Task`, `Agent` | edit `DISPATCH_TOOL_NAMES` in `mark-review.ts` |

`mark-review.ts` and `gate-pr.ts` share `MIN_ROSTER`, the sentinel filename, and the bypass token from `lib/shared.ts` on purpose — if you edit one, edit the shared constant, not a copy in each file, or the writer and the gate will disagree about what counts as a real review.

## Fail-open vs. fail-closed — and why they're different

These hooks fail in two different directions on purpose, and the distinction matters:

- **Fail-closed on the review question.** No marker, a stale marker, a marker that doesn't parse, a marker with too few tags — every one of these means "I cannot confirm a review happened," and the gate blocks. That's the actual job of a gate: uncertainty about whether review happened has to mean no.
- **Fail-open on this script's own bugs.** Unreadable stdin, a filesystem race, an unexpected exception in the hook's own code — none of these are allowed to permanently block your ability to open a PR. `gate-pr.ts` wraps its own logic in a top-level `try`/`catch` that exits 0 (allow) on anything unexpected; only a deliberate `block()` call — which is the reviewed, intentional code path — can produce the blocking exit code. `mark-review.ts` is fail-open by the same logic in the other direction: any internal error means *no marker gets written*, which is always the safe failure for a writer (it can never cause a false "review happened").

If this hook ever wedges you in a way that isn't one of the documented block reasons above, that's a bug in this script, not a security feature — use the bypass, then please file an issue.

## Self-contained, deliberately

Nothing in `crucible/hooks/` imports from outside this directory. The docs-only light-path check above is a small, hardcoded, standalone classifier — it does **not** read the Crucible skill's `config.yaml` or any `.crucible.yaml` overlay, even if you have the full skill installed. Two reasons: these hooks need to work if you've installed only the enforcement layer (no skill, no config file to read), and a gate that could be widened by editing a working-tree YAML file is a weaker gate than one that can't be.

## What this doesn't do

This proves *dispatches happened* — it counts tagged sub-agent calls in your own transcript, timestamped after your current commit. It does not read what those reviewers concluded, and it can't verify their output was substantive rather than perfunctory. An agent that dispatches six real-looking-but-empty review calls, each correctly tagged, would satisfy this gate. That's a deliberate scope limit, not an oversight: this is a "did a review actually run" gate, not a "was the review any good" gate. Pair it with a review process you trust — this only makes that process mandatory, it doesn't grade it.
