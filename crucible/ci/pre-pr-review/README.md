# Pre-PR Review

One LLM call per PR. Produces a single sticky `<!-- pre-pr-review -->` comment carrying a 5-section reviewer verdict (Code Quality / Security / Simplify / TypeScript / Platform Best Practices).

## How it works

```
CI completes (green) on a PR
                    │
                    ▼
        workflow_run event
                    │
                    ▼  (skip gates: tier:trivial / pre-pr-review-done label /
                       skip marker in PR body / docs-only diff)
        pre-pr-review.yml
                    │
                    ▼
        checkout PR head SHA, checkout default branch separately for scripts
                    │
                    ▼
        collect-diff.ts ── git diff + file context → /tmp/pr-diff.txt + /tmp/pr-files.json
                    │
                    ▼
        call-reviewer.ts ── POST {REVIEW_API_BASE_URL}/chat/completions
                    │
                    ▼
        sticky <!-- pre-pr-review --> comment beginning with `## Pre-PR Review:`
```

## Files

- **`reviewer-prompt.md`** — the prompt template. Loaded at runtime from a checkout of the **default branch**, never from the PR branch (prompt-injection defense). Has one adopter-editable section: *Repo conventions to respect*.
- **`collect-diff.ts`** — runs `git diff <base>...HEAD`, reads each changed file (or marks it oversize/deleted), writes `/tmp/pr-diff.txt` + `/tmp/pr-files.json`. Bounded per-file (50 KB) and total (300 KB) so a hostile mega-file can't blow the context budget.
- **`call-reviewer.ts`** — builds the prompt, calls the model, parses the JSON response, upserts the sticky comment via `gh api`. All helpers live in this one file on purpose: the workflow copies **only this file** to `/tmp`, so a sibling import would 404 at runtime.
- **`call-reviewer.test.ts`** — unit tests for every pure helper. `bun test` from this directory.

## Model configuration

Provider-agnostic: anything that speaks the OpenAI chat-completions shape.

| Variable | Kind | Required | Meaning |
|---|---|---|---|
| `REVIEW_API_TOKEN` | secret | yes | Bearer token for the endpoint |
| `REVIEW_API_BASE_URL` | variable | yes | Prefix that `/chat/completions` is appended to |
| `REVIEW_MODEL` | variable | yes | Model name for standard-size PRs |
| `REVIEW_MODEL_LARGE` | variable | no | Model used when the assembled prompt exceeds 30K chars. Defaults to `REVIEW_MODEL` |
| `REVIEW_METADATA_HEADER` | variable | no | Header name to carry per-call attribution JSON (`{task, pr, size, file_count, total_chars}`). Unset = no header sent |

The metadata is **never** put in the request body — some OpenAI-compatible servers reject unknown body fields. It is always written to `/tmp/pre-pr-review-meta.json` and uploaded as a run artifact, whether or not the header is configured.

If you front the model with a gateway that does its own routing (model fallback chains, budget caps), point `REVIEW_API_BASE_URL` at the gateway and set `REVIEW_MODEL` to whatever route name it expects. The two-model `REVIEW_MODEL` / `REVIEW_MODEL_LARGE` split exists so size-based routing works without a gateway at all.

## Skip signals

| Method | How |
|---|---|
| Per-PR opt-out via label | Add label `pre-pr-review-done` (the workflow also adds this itself after a successful run) |
| Per-PR opt-out via risk tier | Add label `tier:trivial` (the tier classifier sets this on ≤10 LoC PRs) |
| Per-PR opt-out via body | Put `<!-- skip-pre-pr-review -->` in the PR description |
| Docs-only diff | Skipped automatically |
| Draft / closed / merged PRs | Skipped automatically |

The skip-marker regex is deliberately narrow. An earlier version matched the marker token *anywhere* in the body, so a PR whose description quoted or explained the marker opted itself out. The HTML-comment form is the primary marker because it does not occur in natural prose; the bare `[skip-pre-pr-review]` legacy form is honored only when it is the entire line.

## Manual dispatch

```bash
gh workflow run pre-pr-review.yml -f pr_number=<PR#>
```

## Coordinator contract

The coordinator workflow detects this surface by regex-matching comment bodies against `/^## Pre-PR Review:/m`. The HTML marker `<!-- pre-pr-review -->` is the upsert anchor; the `## Pre-PR Review:` header is the coordinator's detector.

**Do NOT rename or drop the `## Pre-PR Review:` header without updating `coordinator/fetch-surfaces.ts` in the same PR** — the coordinator's surface accounting would silently lose this surface and fall below its ≥2-surface gate on most PRs. `call-reviewer.test.ts` asserts the header is present so the rename cannot pass silently.

## Required permissions

`contents: read`, `pull-requests: write`, `issues: write` (PR comments go through the issues API).
