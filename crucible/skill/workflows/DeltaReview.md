# DeltaReview Workflow

Re-review only the changes since a specific commit, AND verify whether previously-noted issues from a prior Crucible run have been resolved.

**Use case:** A PR went through Crucible once. CRITICAL/HIGH issues were fixed; MEDIUM/LOW were filed as a tracking issue (`#XX`). The author has since pushed more commits — possibly addressing the noted items, possibly introducing new issues. DeltaReview answers two questions in one pass:

1. **What's NEW since the last review?** (regression scan on the delta)
2. **Of the previously-noted items in `#XX`, which are now resolved?** (regression check on prior findings)

All tool paths below are relative to this skill's own directory — `tools/`, `agents/`, `references/`.

---

## Required inputs

- `--since <commit-or-ref>` — the base for the delta scan (e.g., the SHA of the last reviewed commit, or `HEAD~5`)
- `--tracked-issue <#NNN>` — the GitHub issue number where prior MEDIUM/LOW items were filed (optional but recommended)
- `--pr <#NNN>` — the PR number being reviewed (optional)

If `--since` is not provided, ask the user. The cleanest source is the most recent commit on the PR that has a `Crucible Review` line in its body or follow-up comment.

---

## Phase 0: Eligibility

Same as `FullReview.md`. Plus: confirm the `--since` commit is reachable (`git cat-file -e <sha>`). If not, ask the user.

```bash
git cat-file -e <since> 2>/dev/null || echo "Unreachable commit"
git log --oneline <since>..HEAD | head -20
```

If the delta is empty (no commits since), stop and report: "No new commits since `<since>` — nothing to delta-review."

## Phase 1: Codebase Pattern Survey

Same as `FullReview.md`. Pass 1 reviewers need the patterns block to frame findings.

## Phase 2: Verification Gate

Same as `FullReview.md` — build, typecheck, tests on current HEAD.

## Phase 3: Pass 1 — Delta-Scoped Reviewers

Spawn the same **10 reviewers** as `FullReview.md` (see `FullReview.md` § "The 10 reviewers" — Code Quality, Security, Simplify, TypeScript, Platform Best Practices, Test Runner, Clone Detector, CI Tamper, History Analyzer, PR-Continuity), resolved and dispatched exactly as described there (see "Per-reviewer enumeration model resolution"), BUT scope the diff to `<since>..HEAD` only:

```bash
git diff --name-only <since>..HEAD
git diff <since>..HEAD
```

Each reviewer:

- Reads ONLY the files changed since `<since>`
- Has access to the FULL diff against `origin/main` for context, but enumerates candidates ONLY in the delta
- Returns candidates in the same JSON/YAML contract as `FullReview.md`
- Dispatches with the same `Crucible-Reviewer: <lens-key>` tag requirement

## Phase 4: Pass 2 — Disprove

Same collapsed per-reviewer disprove design as `FullReview.md` Phase 4 — one disprove agent per reviewer that returned candidates, with an optional cross-vendor second opinion on CRITICAL/HIGH when `integrations.gateway.enabled` and `models.disprove_cross_vendor` is set.

## Phase 5: Filter Survivors

Same three filters as `FullReview.md` Phase 5.

## Phase 6: Tracked-Issue Regression Check (distinct from FullReview's Phase 6)

If `--tracked-issue <#NNN>` was provided:

```bash
gh issue view <NNN> --json body,comments
```

Parse the issue body for the `## Noted Items` checklist. For EACH unchecked item:

```
For each previously-noted item:
  1. Read the file:line mentioned in the item
  2. Determine if the issue described still exists at that location
  3. Mark RESOLVED / STILL OPEN / UNRESOLVED-BUT-MOVED (file was renamed/restructured)
```

Spawn one lightweight verifier sub-agent per noted item — parallel batch. A small model is sufficient for this narrow check:

```
Agent({
  subagent_type: "general-purpose",
  model: "haiku",
  prompt: `Verify whether this previously-noted issue is still present:

NOTED ITEM (from GitHub issue #NNN):
- Title: <item title>
- Location: <file:line from item>
- Description: <description from item>

CURRENT CODE AT THAT LOCATION:
<git show HEAD:<file> | sed -n '<line-5>,<line+5>p'>

Return JSON: {
  "item": "<title>",
  "status": "RESOLVED" | "STILL_OPEN" | "MOVED_TO_<new-file:line>",
  "evidence": "<one sentence>"
}`
})
```

Update the GitHub issue: check off RESOLVED items, leave STILL_OPEN unchecked, edit MOVED items to point at new location.

## Phase 7: Final Report — Two-Part

```markdown
## Crucible Delta Review

**Branch:** `feature/...`
**Delta range:** `<since>..HEAD` (N commits, M files)
**Tracked issue:** #NNN

### Part 1 — New findings in delta

| # | Severity | Finding | File:Line | Status |
|---|---|---|---|---|
| 1 | HIGH | New SQL injection in <new file> | path:NN | Fixed |
| 2 | MEDIUM | Missing test for new branch | path:NN | Noted → #NNN |

### Part 2 — Previously-noted items (from #NNN)

| Item | Prior status | Current status | Action |
|---|---|---|---|
| Missing zod validation on /foo | OPEN | RESOLVED | Checked off in #NNN |
| Duplicate helper in apps/X and apps/Y | OPEN | STILL OPEN | Re-noted in #NNN |
| Console.log in production handler | OPEN | MOVED → apps/foo/src/v2.ts:18 | Updated in #NNN |

### Summary

- **New findings introduced:** 2 (1 HIGH fixed, 1 MEDIUM noted)
- **Previously-noted items resolved:** 1 of 3 (33%)
- **Previously-noted items still open:** 2

### Verdict

**APPROVE** — No new CRITICAL/HIGH; previously-noted items either resolved or still tracked.
**WARNING** — New HIGH introduced that could not be auto-fixed.
**BLOCK** — New CRITICAL introduced.
```
