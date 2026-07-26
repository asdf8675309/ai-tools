# AI review pipeline for GitHub Actions

Four workflows that review pull requests with an LLM, scale the review depth to the risk of the diff, deduplicate findings across every review surface you run, and keep the lower-severity ones from evaporating at merge.

This is a port of a pipeline that ran on real PRs for months and was debugged repeatedly. **The bug fixes are the valuable part.** A clean reimplementation would look almost identical and be worth less. The [Gotchas](#gotchas) section at the bottom is the distilled version of what went wrong; read it before you change anything.

Provider-agnostic: any OpenAI-compatible chat-completions endpoint, supplied by repository secrets and variables.

---

## The pipeline

```
 PR opened / pushed
        │
        ▼
 tier-classify.yml ───► label tier:trivial | tier:lite | tier:full
        │                       │
        │                       └── tier:trivial makes the reviewer skip itself
        ▼
 your CI ──(green)──► pre-pr-review.yml ───► sticky "## Pre-PR Review:" comment
                              │                       │
                              │                       ├──► noted-items-issue.yml
                              │                       │      files ONE issue for
                              │                       │      SUGGESTION findings
                              ▼                       │
                      coordinator.yml ◄───────────────┘
                      reads every review surface's comment,
                      dedupes + re-classifies + decides,
                      posts ONE verdict comment
```

| Workflow | What it does | Needs a model? |
|---|---|---|
| `tier-classify.yml` | Sizes and risk-scores the diff; labels `tier:trivial\|lite\|full` | No |
| `tier-classify-test.yml` | Regression tests for the classifier, run in CI | No |
| `pre-pr-review.yml` | One 5-pass LLM review; posts a sticky comment | Yes |
| `coordinator.yml` | Dedupes across all review surfaces into one verdict | Yes |
| `noted-items-issue.yml` | Files a tracking issue for SUGGESTION-severity findings | No |
| `review-pipeline-test.yml` | Unit tests for the pipeline's own scripts | No |

You can adopt any subset. The classifier is useful on its own. The reviewer works without the coordinator. The coordinator only earns its keep once you have two or more review surfaces posting comments.

Per-component detail: [`pre-pr-review/README.md`](pre-pr-review/README.md), [`tier-classify/README.md`](tier-classify/README.md), [`coordinator/README.md`](coordinator/README.md).

---

## Install

```bash
# from the root of your repo
cp -r path/to/ci/workflows/*        .github/workflows/
cp -r path/to/ci/lib                .github/   # shared model client — both reviewers import it
cp -r path/to/ci/pre-pr-review      .github/
cp -r path/to/ci/tier-classify      .github/
cp -r path/to/ci/coordinator        .github/
cp -r path/to/ci/noted-items        .github/
```

Then, in order:

1. **Point the triggers at your workflows.** `pre-pr-review.yml` fires on `workflow_run` of a workflow literally named `CI`; `coordinator.yml` and `noted-items-issue.yml` name `CI` and `Pre-PR Review`. If your required check is called something else, edit the `workflows:` lists.

   Two things that bite here, both silent:
   - **A `workflow_run` trigger naming a workflow that does not exist on your default branch is dormant, not broken.** No error, no warning, no run. One such trigger sat dormant for months in the repo this came from, waiting on a workflow that had not been written yet.
   - **The workflow will not fire on the PR that installs it.** `workflow_run` resolves the workflow file from the *default branch*, so on the installing PR the default branch's copy has no such trigger and the PR's copy is never consulted. Expect one quiet PR; it activates on merge. Say so in the PR body or a reviewer will think it is broken.
2. **Set the secret and variables** (below).
3. **Edit two lists to match your repo:** the *Repo conventions* section of `pre-pr-review/reviewer-prompt.md`, and `SURFACE_MARKERS` in `coordinator/fetch-surfaces.ts`.
4. **Make `review-pipeline-test.yml` and `tier-classify-test.yml` required checks.** The reviewer and coordinator are deliberately *not* required — a model outage should not block merges — which means these two suites are the only thing that fails loudly when the pipeline's own logic breaks.
5. Open a throwaway PR and watch it. The first run tells you more than any amount of reading.

### Secrets and variables

| Name | Kind | Required | Used by | Meaning |
|---|---|---|---|---|
| `REVIEW_API_TOKEN` | secret | yes | reviewer, coordinator | Bearer token for the model endpoint |
| `REVIEW_API_BASE_URL` | variable | yes | reviewer, coordinator | Base URL; `/chat/completions` is appended |
| `REVIEW_MODEL` | variable | yes | reviewer, coordinator | Model name for standard-size inputs |
| `REVIEW_MODEL_LARGE` | variable | no | reviewer, coordinator | Model for inputs over 30K chars. Defaults to `REVIEW_MODEL` |
| `REVIEW_METADATA_HEADER` | variable | no | reviewer, coordinator | Header name for per-call attribution JSON. Unset = no header |
| `INCREMENTAL_REVIEW_ENABLED` | variable | no | coordinator | `true` turns on cross-commit state + `/dismiss` |
| `TIER_SENSITIVE_REGEX` | variable | no | classifier | Always-Full paths |
| `TIER_WORKSPACE_ROOTS` | variable | no | classifier | Monorepo roots, default `apps\|packages` |
| `TIER_DEPLOY_CONFIG_REGEX` | variable | no | classifier | Deploy descriptors that block the Trivial tier |

`GITHUB_TOKEN` is provided automatically. **No per-vendor model key ever needs to live in repo secrets beyond `REVIEW_API_TOKEN`** — if you front the model with a gateway that holds provider keys, this pipeline never sees them.

Minimum viable configuration is three values: `REVIEW_API_TOKEN`, `REVIEW_API_BASE_URL`, `REVIEW_MODEL`.

Sending cheap PRs to a cheap model and expensive ones to a strong one is covered in [`GATEWAY-ROUTING.md`](GATEWAY-ROUTING.md). The two-model split above needs no extra infrastructure; a routing gateway is the optional step beyond it.

### Required checks: one aggregate gate, not a list

If your CI fans out over a matrix, **make one job that `needs:` every matrix entry and require only that job.** Two reasons, and the first is a hard blocker:

- Matrix job names are generated at runtime. Branch protection needs names you can type in advance, so dynamically-named entries cannot be listed at all.
- Even with static names, a per-entry list rots. Every app or package added later needs a branch-protection edit that nobody remembers to make, and the new one is unguarded until someone notices.

Require the aggregate, plus `review-pipeline-test.yml` and `tier-classify-test.yml`. Do **not** require `pre-pr-review.yml` or `coordinator.yml` — a model outage would block every merge.

One rule that follows from this, and it is worth stating plainly: **nothing except the real CI run may ever emit a status check bearing the required check's name.** See gotcha 2.

### Not a monorepo?

Nothing to do. The classifier's workspace signals key off a first path segment under `apps/` or `packages/`; in a single-package repo nothing matches, the workspace count stays 0, and the two workspace gates are inert. Size, sensitive paths, and Trivial blockers still classify normally. That case is asserted in the test suite (`config: non-monorepo layout still classifies`).

If you have a monorepo with different roots, set `TIER_WORKSPACE_ROOTS` (e.g. `services|libs`).

---

## Tests

```bash
bun test pre-pr-review coordinator noted-items   # unit tests
bash tier-classify/tier-classify.test.sh         # classifier regression suite
```

Both run standalone — **no `bun install`, no `npm ci`, no network.** The TypeScript tests import only `bun:test` and node builtins; the classifier suite needs `bash`, `git`, and `python3`, all present on a stock GitHub runner. `bun install` is needed only if you want to run `bun run typecheck`.

The classifier suite **extracts the real `run:` block from the workflow YAML and executes it**, so it binds to the shipped text rather than a copy that drifts.

### Why the tests are shaped the way they are

One principle drove every one of them, and it is the same principle this pipeline exists to enforce:

> **When you add a check to something that is already failing, "it went red" is not evidence your check works. Only detection of a specific known-bad input is.**

That came from an audit of typecheck coverage. Sweeping config files to answer "which code is actually checked?" gave false positives in *both* directions — some packages chained a second config the first never mentioned, so their code was covered despite the config looking wrong; another had a perfectly good config that no script ever invoked, so a large body of code went unchecked. The config does not tell you what gets checked. The run script does. And because that package already carried a backlog of diagnostics, its check exited non-zero before and after any change — the exit code proved nothing. What proved it was injecting one known-bad line and watching the count rise by exactly one, naming the injected file.

Applied here, that means the suite does not just assert "the classifier returns Full for a sensitive path". It:

- **builds four mutants** — the ref-spec reverted to two-dot, and each of three classifiers pointed back at the rename-blind list — and asserts each one is *killed*;
- **guards the mutants themselves**, failing loudly if a `sed` produces a file byte-identical to the original, because a mutant whose anchor stopped matching "passes" every assertion while testing nothing;
- **checks the extracted block is real**, greping for four markers and running `bash -n`, so a broken extractor cannot silently yield an empty script that every test then passes against;
- **picks fixtures where the fail-safe is blind.** The two-dot mutant is exercised against a branch whose base independently landed the same edit, so the file counts agree and the `changed_files` cross-check cannot save it. An easier fixture would let the fail-safe take the credit and prove nothing about the ref-spec. Same for the `pipefail` test: with a mismatched file count both variants reach Full anyway, so the fixture is built at the one count where only `pipefail` stands between a failed diff and Trivial.

If you extend this pipeline, extend the tests this way. A green suite that would stay green with the fix removed is the failure mode, not the goal.

---

## Adopting into a repo that isn't green

The first real run of a review pipeline on a codebase that has never had one surfaces every problem at once. None of it was caused by your install PR; it was already there, silently.

The playbook that works:

1. **Do not fix pre-existing failures in the install PR.** Keep the install diff reviewable and revertible. If the pipeline design changes, the fixes get dragged along with it.
2. **Open a parallel fix PR from the default branch**, not stacked on the install. Independent merge path, independent revert.
3. **Put a triage table in the fix PR body** — one row per error: file, line, cause, fix. Reviewers need to see you are not papering over something real.
4. **Expect cascades.** Fixing the first error reveals the second one hiding behind it, especially with `&&`-chained scripts where later steps never ran.
5. **Verify with the exact command chain CI runs**, not a simplified version of it. A multi-config typecheck can pass its first invocation and fail its third.
6. **Track what you consciously chose not to fix** as its own issue. Not as bullets in a PR body that nobody reads again.

Two anti-patterns, both of which turn the pipeline into decoration:

- **`continue-on-error: true` to get past a failing step.** It hides the error *and* lets a later `if: success()` gate fire under false pretenses. In this pipeline that would mean the "add `pre-pr-review-done` label" step marking a PR reviewed when no review happened. That label step is guarded with `success()` for exactly this reason.
- **Disabling workflows wholesale** until "later". A review of five disabled workflows in another repo found every one of them gated on a threshold the repo did not currently meet — coverage floors, bundle budgets, a clean audit — so all five were switched off together and stayed off. If you gate on thresholds, stage them: observe first, enforce once you actually pass.

This is also why the pipeline's own test workflows are the ones to make required, rather than any quality threshold. They pass on day one in any repo.

## Gotchas

Every item here is a bug that shipped, in this pipeline or in the CI around it. Roughly ordered by how much time each one cost.

### 1. The reviewer runs the default branch's copy of itself, never the PR's

Both the prompt and the scripts are read from a separate checkout of the default branch. A PR cannot rewrite the instructions that judge it — that is the whole point.

**GitHub enforces the same rule one level up, whether you want it or not.** Which version of a workflow *file* runs depends on the event:

| Event | Workflow file read from |
|---|---|
| `push` | the pushed ref |
| `pull_request` | the PR's **head branch** |
| `pull_request_target` | the **base branch** |
| `workflow_run` | the **default branch**, always |
| `workflow_dispatch` / `schedule` | the **default branch** |

Every model-calling workflow here is `workflow_run`-triggered, so both the workflow and the scripts come from the default branch.

Three consequences:

- **A PR that fixes the reviewer cannot be reviewed by its own fix.** The run on that PR exercises the *old* code. The first real validation of any reviewer change is the *next* PR after it merges. A green run on the fixing PR is evidence the previous version still runs, nothing more.
- **Changing a trigger creates a one-PR dead zone.** The old trigger no longer matches the PR's copy; the new trigger is not yet on the default branch. Neither fires. If you need it live on the introducing PR, ship the new trigger *alongside* the old one first and remove the old one in a second PR.
- **A `workflow_run` naming a workflow that does not exist on the default branch never fires and never complains.**

### 2. A green required check that verified nothing

The worst failure in this whole class shipped as a *feature*. A bot workflow appended a generated changelog entry to every PR, committed it with `[skip ci]` so it would not re-trigger CI, and — because that commit had no CI run of its own and would otherwise sit unmergeable forever — emitted a **synthetic status check using the required check's name** on its own commit.

Branch protection evaluates required checks against the **latest** commit SHA. The bot's commit was always latest. So the required gate resolved green against a check that had verified a markdown file, on a SHA whose actual code was never checked. A PR merged before its real CI finished; the broken state landed on the default branch and failed only afterwards.

Every piece of that was individually reasonable. The rule that falls out of it is not subtle:

**Nothing may emit a status check bearing a required check's name except the run that actually performs the check.** If a bot's commit would be unmergeable without a synthetic green, the bot should not be committing to the PR at all — do the work locally before the PR exists, so the author's own commit is HEAD and real CI runs against it.

Generalized: a check that can pass without exercising the thing it names is worse than no check, because it also removes the pressure to add a real one.

### 3. Merge-base handling — two opposite bugs, one root cause

A three-dot diff (`base...HEAD`) measures HEAD against the **merge base**, which is what GitHub reports for a PR. A two-dot diff (`base HEAD`) compares the two endpoints, which folds in everything the base branch gained since the branch diverged.

Both mistakes have shipped here, in opposite directions:

- **The reviewer** used three-dot with a `--depth=1` base fetch. A shallow fetch never brings the merge base, so the diff died with "no merge base" and the job **crashed instead of reviewing**.
- **The classifier** was "fixed" by dropping `--depth=1` *and* switching to two-dot. That made the tier a function of branch staleness: a small PR on a behind branch measured as everything on the base branch since it diverged, and was tiered Full with someone else's line count.

Current state: both use three-dot, both fetch without `--depth=1`, and the classifier cross-checks its local file count against the API's `changed_files` and fails closed to Full on any disagreement. Never add `--depth=1` to a fetch that feeds a three-dot diff. The reviewer prompt lists that change as a CRITICAL workflow-integrity finding for exactly this reason.

### 4. A non-required check that crashes reads as a passing check

The reviewer and coordinator are not required checks, which is correct — a model outage should not block merges. It also means **a dead job and a clean review are indistinguishable on the PR**: no red X, no comment, nothing to notice.

Three defenses, all necessary:

- The reviewer step runs on `!cancelled()`, so a failure in an earlier step still reaches the script, which posts a DEGRADED comment. (Not `always()` — a cancelled run should post nothing.)
- `main()` has a `.catch()` backstop that posts a DEGRADED comment for anything unhandled before exiting non-zero.
- The pipeline's *own* tests are required checks. Something has to assert the reviewer actually runs, and it cannot be the reviewer.

### 5. A guard placed after an unguarded read of the same resource never runs

The `!cancelled()` condition above was **inert on arrival**. The script read one of its two `/tmp` inputs unguarded, ahead of the guarded read, so it threw before reaching the degraded path. The workflow-side fix and the script-side guard are one fix in two files; either alone does nothing.

Related, same file: the guard's catch block used `(e as Error).message`. For a string throw that yields `undefined`; for a `throw null` **the cast itself throws — from inside the catch that exists to prevent that**. Narrow instead: `e instanceof Error ? e.message : String(e)`. Both cases are in `call-reviewer.test.ts`, including a test that asserts a null throw does not escape the guard.

### 6. Prompt substitution: `$` patterns and chained passes

Building the prompt with chained `.replaceAll("{TOKEN}", value)` has two independent defects:

- **`$` expansion.** With a *string* replacement, `$&`, `` $` ``, `$'` and `$$` are special. A diff containing `$'` splices the entire remainder of the template into the prompt; `$$` silently shrinks to `$`. Real diffs contain these constantly — shell quoting, regexes, `PID=$$`.
- **Rescanning.** Each pass scans what earlier passes inserted. A diff containing the literal text `{INJECTED_FILES}` gets the whole file block spliced into it, once per occurrence — no `$` involved. Measured on the PR that fixed this: 3 occurrences turned 91,306 chars into 343,002, over the reviewer's own size guard. Note *which* PRs contain those tokens: the ones that edit this pipeline.

The fix is a single regex pass with a **callback** replacer, which is never subject to `$` substitution and never rescans:

```ts
const PLACEHOLDERS = /\{(?:PR_NUMBER|INJECTED_DIFF|INJECTED_FILES)\}/g;
template.replace(PLACEHOLDERS, (m) => map[m] ?? m);
```

`$1` is inert under both forms and does **not** discriminate between them; the test suite keeps it as a labelled control, because an earlier version of that suite asserted `$1` as though it proved something.

### 7. Treat the diff as attacker-influenceable input, all the way through

It reaches an LLM *and* a CI runner. Layered defenses, in order:

- Untrusted content is wrapped in `<UNTRUSTED_DIFF>` / `<UNTRUSTED_FILES>` tags, and any literal occurrence of those tags is **stripped from the payload before substitution** so a diff cannot forge a closing tag and break out into instruction context. A module-init self-test asserts the strip pattern still matches all six tag forms.
- Oversize files become diff-only stubs; per-file 50 KB and total 300 KB budgets; a hard TOO_LARGE stop at ~80K tokens.
- Nothing from the diff is ever shell-interpolated. Comment bodies are passed to scripts through files and env, never spliced into a command.
- Everything bound for a public comment goes through `scrubSecrets` first — an upstream error can echo your `Authorization` header back in its body.
- In the coordinator's incremental mode, finding titles are scrubbed **at storage time**, because state persists across runs and is re-injected into the prompt later.

### 8. `scrubSecrets` that is too aggressive breaks the thing it protects

An earlier heuristic redacted any `[A-Za-z0-9_-]{40,}` run. That eats 40-char git SHAs and sha256/sha512 hashes, which (a) strips the useful diagnostics out of DEGRADED excerpts and (b) in the coordinator, redacted the commit SHAs *inside its own state JSON* — so the next run's force-push probe ran `git merge-base --is-ancestor [REDACTED-TOKEN-SHAPE] <head>`, always failed, and reset the entire state every run.

Current heuristic: explicit `Bearer` and known key prefixes always redact; the generic fallback needs length ≥ 48 **and** mixed case **and** a digit. Plain hex passes through. There is a test asserting a 40-hex SHA survives — it looks trivial and is load-bearing.

### 9. Trusted-source loading has a shape constraint

The reviewer copies **one file** to `/tmp` and runs it, so every helper must live in that file; a sibling import would 404 at runtime. The coordinator runs **in place** from the trusted checkout, so it may use relative imports — copying only its entry file to `/tmp` broke them. Both choices are deliberate, and mixing them up produces a runtime failure that no test catches, because both look fine locally.

### 10. Path shapes defeat naive classifiers

Three ways a sensitive file slips into the Trivial tier and skips every review surface:

- **Renames hide the source path.** With detection on, `--name-only` shows only the destination, and a pure rename is 0 insertions / 0 deletions. The sensitive-path check therefore reads a separate `--no-renames` list. The file *count* deliberately does not — it must match the API's `changed_files`, which counts a rename as one file.
- **git C-quotes awkward paths.** `café.ts` renders as `"packages/auth/caf\303\251.ts"` — and the leading quote defeats every `^`-anchored regex. A `.sql` migration scored zero sensitive hits that way. Fix: `git diff -z … | tr '\0' '\n'`. `core.quotePath=false` covers only the non-ASCII half.
- **Subdirectory lists rot.** The `.github/` sensitive rule was once a list of specific subdirectories. It omitted the one holding the reviewer's own prompt, so editing the prompt classified Trivial and skipped the reviewer. Match `.github/` wholesale, at any depth.

### 11. Piped commands hide their own failure

`git diff … | tr '\0' '\n'` reports `tr`'s exit status. Without `set -o pipefail`, a failed diff sails past `|| DIFF_OK=0` and the classifier reads an empty diff as a tiny PR — a silent fail-**open**. `pipefail` is load-bearing in the classifier's compute step and there is a test that binds it, deliberately constructed for the one input shape where the `changed_files` cross-check is blind (otherwise the fail-safe takes the credit and the test proves nothing).

The same class applies to your own verification: `cmd | tail` reports the pipe's status, not the command's. Redirect to a file and check `$?`.

### 12. Never write a bare closing keyword near `#N` in generated text

GitHub acts on `closes #123` / `fixes #123` anywhere in an issue or PR body, and it matches the **token**, not the sentence — negation and future tense are invisible to it. A model-authored finding title reading "closes #400 without checking" will close issue 400 when the noted-items workflow files it. `sanitizeForIssueBody` breaks the `#`-to-digits token with an empty HTML comment (renders identically, parses as nothing) and defangs `@mentions` the same way. Tested.

### 13. Resolve a PR from the event payload, not by head SHA

`workflow_run`-triggered jobs that look the PR up with `gh pr list --jq '.headRefOid == $HEAD_SHA'` break the moment anything pushes to the PR branch — a changelog bot, a formatter, a rebase. The lookup returns empty, the job skips, and nothing reports that it skipped. The `workflow_run` payload carries a `pull_requests` array that was bound at trigger time; use that.

### 14. A secret in the wrong store resolves to an empty string, silently

GitHub has several separate secret stores and they do not cross-read. The one that bites: a secret saved under **Settings → Environments → *name* → Environment secrets** is visible only to a job that declares `environment: <name>`. Referenced from a job that does not, `${{ secrets.X }}` returns **the empty string** — no error, no warning, no annotation.

The downstream tool then reports its own authentication failure, which sends you looking at the token instead of at the scope. That misdiagnosis cost weeks in the repo this came from.

The diagnostic is in the runner log's `env:` echo:

```
env:
  GOOD_TOKEN: ***      ← resolved (masked)
  BAD_TOKEN:           ← EMPTY: not missing, literally empty
```

A real secret always prints as `***`, and GitHub does not accept an empty value on save — so a bare `NAME:` is a scope miss, every time.

Put `REVIEW_API_TOKEN` in **repository** Actions secrets and this never arises. If you must use an environment secret, add `environment: <name>` to the job. The scripts exit 2 on a missing token rather than calling the endpoint with an empty bearer, which turns a confusing 401 into an obvious failure.

### 15. Small things that cost real time

- **`cancel-in-progress` is not a style choice.** `true` on the idempotent classifier (a later run supersedes). `false` on every workflow whose comment is a source of truth — cancelling mid-upsert drops a verdict.
- **`gh label create` without `--force` is write-once.** The create fails, `|| true` swallows it, and an edited description never reaches GitHub. The label text then drifts from the rule it documents.
- **An unset repository variable is the empty string, not undefined.** `process.env.X ?? fallback` happily adopts `""`. Use `||` where empty is meaningless.
- **Retry-After needs a ceiling and a trim.** `Number(" ")` is `0`, not `NaN`, so an untrimmed whitespace header becomes an immediate retry; an unbounded server value can sleep past the job timeout and get the run killed before it posts the degraded comment the retries existed to reach.
- **A read-only reviewer instruction is void if the task requires a write.** If you ask a review agent to "run the old tests against the new code", it will swap files in your working tree to do it.

---

## Layout

```
ci/
├── workflows/                  → copy into .github/workflows/
│   ├── pre-pr-review.yml
│   ├── tier-classify.yml
│   ├── tier-classify-test.yml
│   ├── coordinator.yml
│   ├── noted-items-issue.yml
│   └── review-pipeline-test.yml
├── pre-pr-review/              → copy into .github/
│   ├── reviewer-prompt.md      (edit: repo conventions)
│   ├── collect-diff.ts
│   ├── call-reviewer.ts
│   └── call-reviewer.test.ts
├── tier-classify/
│   ├── README.md
│   └── tier-classify.test.sh
├── coordinator/
│   ├── coordinator-prompt.md   (edit: surface trust table)
│   ├── fetch-surfaces.ts       (edit: SURFACE_MARKERS)
│   ├── call-coordinator.ts
│   ├── compute-delta.ts
│   ├── parse-state.ts
│   ├── parse-dismissals.ts
│   ├── state-schema.ts
│   └── *.test.ts
├── noted-items/
│   ├── parse-noted-items.ts
│   └── parse-noted-items.test.ts
├── GATEWAY-ROUTING.md          (optional: routing review calls by complexity)
├── package.json
└── tsconfig.json
```

Nothing here imports anything from outside this directory.

## Prior art

The tiering and coordinator-judge architecture follow Cloudflare's 2026-05 [AI code review post](https://blog.cloudflare.com/ai-code-review/). The implementation, and every gotcha above, is ours.
