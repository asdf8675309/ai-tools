# Coordinator Judge

One comment per PR that **deduplicates, re-categorizes, and decides** across every review surface already posting on the PR, using a single model call.

Reviewer fan-out is what most CI pipelines already have. The coordinator is the layer on top: without it, five surfaces mean five inboxes and the same finding restated four ways.

## How it works

```
a comment-posting workflow finishes / a review is submitted
                    │
                    ▼
        workflow_run / pull_request_review event
                    │
                    ▼  (skip checks, then a 15s debounce)
        coordinator.yml
                    │
                    ▼
        fetch-surfaces.ts ── gh api → all PR comments → filter by markers → JSON
                    │
                    ▼ (gate: ≥2 distinct surfaces)
        call-coordinator.ts ── POST {REVIEW_API_BASE_URL}/chat/completions
                    │
                    ▼
        sticky <!-- coordinator-judge --> comment: verdict + kept/dropped findings
```

## Files

- **`coordinator-prompt.md`** — the prompt template, loaded from the default branch at runtime, never from the PR branch. Has one adopter-editable section: the *surface trust calibration* table.
- **`fetch-surfaces.ts`** — fetches issue comments, review comments, and reviews; classifies each by marker or header; emits JSON. **Edit `SURFACE_MARKERS` / `SURFACE_HEADERS` to match the tools you actually run.**
- **`call-coordinator.ts`** — builds the prompt, calls the model, renders the verdict, upserts the sticky comment.
- **`compute-delta.ts`, `parse-state.ts`, `parse-dismissals.ts`, `state-schema.ts`** — the incremental-mode machinery (below). Inert unless incremental mode is on.
- **`*.test.ts`** — unit tests. `bun test` from this directory.

Unlike `pre-pr-review/call-reviewer.ts`, these scripts run **in place** from the trusted checkout rather than being copied to `/tmp`. That is deliberate: copying only the entry file to `/tmp` breaks the relative sibling imports, which is exactly how that failed the first time.

## Skipping the coordinator

| Method | How |
|---|---|
| Per-PR opt-out | Add label `no-coordinator` |
| Per-PR opt-out via body | Put `<!-- skip-coordinator -->` in the PR description |
| Draft / closed / merged PRs | Skipped automatically |
| PRs after a red CI run | Skipped automatically — don't coordinate against red CI |
| Single-surface PRs | Skipped automatically — nothing to deduplicate |

## Incremental mode (optional, off by default)

Set the repository variable `INCREMENTAL_REVIEW_ENABLED=true` to turn on cross-commit state:

- A second sticky comment (`<!-- coordinator-state -->`) carries machine-readable state: every finding ever seen, its status, and the commits reviewed.
- Each run computes a delta — newly introduced / carried over / resolved / dismissed / re-emerged — and sends the model only what is new or still open.
- Humans can `/dismiss <finding-id> <reason>` in a PR comment. Authorization is checked against `author_association`: write-access associations always, plus the PR author when they are `CONTRIBUTOR` or above. A fork author with `NONE` or `FIRST_TIME_CONTRIBUTOR` cannot dismiss — otherwise the three-strikes `permanently_dismissed` rule lets an outsider bury any finding in three force-pushes.
- A finding dismissed and then re-emitted three times becomes `permanently_dismissed` and stops being surfaced at all (it is still logged to stderr for audit).

Two things to know before enabling it:

1. **State is read back from a public comment.** It is validated as untrusted input on the way in (`state-schema.ts` is a total validator), and only comments authored by `github-actions[bot]` are trusted — otherwise anyone could pre-post a comment carrying the marker and a forged state blob, and the next run would adopt it.
2. **The job does not check out the PR head.** The rename map (`git diff --find-renames`) and the force-push probe therefore have less to work with than they would in a PR-head checkout. Any failure in that path degrades to seed mode with a loud log rather than killing the run — but if you rely on rename tracking, add a PR-head checkout to the workflow.

## Manual dispatch

```bash
gh workflow run coordinator.yml -f pr_number=<PR#>
```

## Required configuration

Same as the reviewer: secret `REVIEW_API_TOKEN`, variables `REVIEW_API_BASE_URL` and `REVIEW_MODEL` (optionally `REVIEW_MODEL_LARGE`, `REVIEW_METADATA_HEADER`). Plus the automatic `GITHUB_TOKEN`.

## Loop safety

- The workflow does not subscribe to `issue_comment`, so its own comment cannot retrigger it.
- `fetch-surfaces.ts` additionally self-skips both coordinator markers. Belt and braces on purpose: a comment loop here costs a model call per iteration.
- Sticky upsert by marker prevents duplicate comments on rapid re-runs.
- `cancel-in-progress: false` — cancelling mid-upsert drops a verdict.

## Prior art

Implements the **coordinator-judge pass** described in Cloudflare's 2026-05 [AI code review post](https://blog.cloudflare.com/ai-code-review/): deduplicate findings, re-categorize issues, filter false positives, make the final call.
