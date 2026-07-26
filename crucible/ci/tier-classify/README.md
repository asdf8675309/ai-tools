# Risk Tier Classifier

Classifies every PR as **Trivial / Lite / Full** from diff stats + sensitive-path globs. Downstream review workflows gate on the `tier:trivial` label to skip themselves on small low-risk PRs.

## How it works

```
PR opened / synchronized
        │
        ▼
tier-classify.yml fires (pull_request trigger)
        │
        ▼
git diff "$BASE_SHA...$HEAD_SHA"   (three-dot: vs the MERGE BASE)
        │
        ├─ insertions + deletions (LoC churn; Lite gates on insertions alone)
        ├─ workspace count (first segment under apps/ or packages/)
        ├─ sensitive-path matches (regex grep)
        └─ Trivial blockers (manifests, lockfiles, deploy configs, *.sql)
        │
        ▼
fail-safe cross-check: local file count vs GitHub changed_files
        │        (any mismatch, or a failed diff, ⇒ Full)
        ▼
tier rule decision
        │
        ▼
gh pr edit --add-label tier:{trivial,lite,full}
        │
        ▼
upsert sticky <!-- pr-tier --> comment with reasoning
        │
        ▼
review workflows check the label, skip on tier:trivial —
default-to-run on label absence
```

### Why three-dot, and why the cross-check

`BASE_SHA`/`HEAD_SHA` are the PR payload's `base.sha` and `head.sha`. The diff is **three-dot**, so it measures HEAD against the *merge base* — the same thing GitHub reports for the PR. A two-dot diff compares the two endpoints, which makes the tier a function of how far the branch has fallen behind the base rather than of PR content. The merge base is available because the checkout uses `fetch-depth: 0`.

> **Never add `--depth=1` to the base fetch.** A shallow fetch grafts a shallow boundary onto an already-complete repo, which hides the merge base and breaks the three-dot diff. This bug has been shipped twice in this pipeline's history: once here (three-dot alongside a `--depth=1` base fetch), then "fixed" by switching to two-dot — which introduced the staleness bug instead. The same shallow-graft mechanism separately broke the reviewer workflow, where the symptom was a crashing job rather than a wrong number.

The `DIFF_BROKEN` fail-safe then compares the local file count against the payload's `changed_files`. Under three-dot the two measure the same thing, so **any** mismatch — not just a zero local count — means the diff cannot be trusted and the PR is tiered Full. A failed `git diff`, or a non-numeric `changed_files`, fails closed the same way. All directions are conservative: the fail-safe can only over-tier, never under-tier.

Two path-shape hazards the classifier defends against, both of which could otherwise land a sensitive file in Trivial and skip every review surface:

- **Renames hide the source path.** With detection on, `--name-only` emits only the destination, so `git mv packages/auth/token.ts apps/x/token.ts` shows nothing sensitive — and a pure rename is 0 insertions / 0 deletions. `SENSITIVE_HITS` therefore reads a separate `--no-renames` list. `LOCAL_FILE_COUNT` deliberately does **not** — it needs detection on to match `changed_files`.
- **Awkward paths get C-quoted.** git renders `café.ts` as `"packages/auth/caf\303\251.ts"`, and does the same for any path holding a backslash, tab, double quote, or control character. The leading quote defeats every `^`-anchored regex — a `.sql` migration scored **0** sensitive hits that way. All path diffs use `git diff -z … | tr '\0' '\n'`, which emits raw NUL-separated paths. `core.quotePath=false` is *not* sufficient: it covers only the non-ASCII half. A path containing a literal newline splits into two lines under `-z`, which inflates the local file count, disagrees with `changed_files`, and fails closed to Full.

## Tests

```bash
bash tier-classify/tier-classify.test.sh
```

Extracts the real `run:` block from the workflow and executes it, so the tests bind to the shipped text rather than a copy that drifts. Exits non-zero on failure. Needs `bash`, `git`, and `python3` — no package install.

It finds the workflow at `$TIER_WORKFLOW` if set, else `<repo>/.github/workflows/tier-classify.yml`, else the sibling `../workflows/tier-classify.yml`. So it works both in this repo's layout and after you copy the directory into `.github/`.

Two harnesses, because neither covers everything:

- **Real git fixtures** — the only way to test the ref-spec. A stubbed `git` returns canned output regardless of arguments, so `BASE...HEAD` and `BASE HEAD` are indistinguishable to it.
- **A discriminating stub** — the practical way to drive `changed_files` mismatch cases. It holds the rename-blind list separately from the rename-detected one; a stub answering both `--name-only` calls identically cannot detect a rename regression.

Each test names the defect it guards, and four of them assert that a *mutant* is killed — the ref-spec reverted to two-dot, and each of the three classifiers pointed back at the rename-detected list. The two-dot mutant is exercised against a fixture where the base branch independently lands the same edit as the PR, so the file counts agree and the `changed_files` fail-safe is blind. That is the only arrangement where the three-dot ref-spec is uniquely load-bearing; an easier fixture would let the fail-safe take the credit and prove nothing about the ref-spec.

## Tier rules

| Tier | Rule |
|------|------|
| **Trivial** | ≤10 LoC churn — insertions **+** deletions — AND no sensitive paths AND no manifest / lockfile / deploy-config / `*.sql` change |
| **Lite** | ≤100 insertions AND ≤2 workspaces affected AND no sensitive paths |
| **Full** | Everything else (default) |

> **Label metadata is workflow-authoritative.** `gh label create --force` rewrites each tier label's colour and description on every PR event, so editing either in the GitHub UI is silently reverted on the next run — change them here instead. Scope is colour and description only: it cannot rename a label, and it does not touch the manual `gh pr edit --add-label` override documented below.

## Sensitive paths (always Full regardless of size)

Default pattern:

- `.github/` at **any depth** — including nested `apps/*/.github/`, which holds per-app reviewer prompts and deploy workflows. Matched wholesale, not as a subdirectory list. A subdirectory list omits whichever directory is added next; when that happened here, the omitted one was the reviewer's own prompt directory, so a one-line edit to the prompt classified Trivial and skipped the reviewer.
- `**/crypto/**`, `**/webhook/**`, `**/auth/**` — those directories at any depth.
- The same stems as **files**, with the stem anywhere in the basename provided it is separator-delimited — `auth.ts`, `service-auth.ts`, `stripe-webhooks.ts` match; `author.ts`, `authorize-page.tsx` and `oauthLib.ts` do not. Both halves matter: a directory-only form misses auth code that lives in files, and a form without the separator sweeps in every `author.ts`. The exact set is asserted in the test suite.
- `**/*.sql` — DB migrations.
- `**/secret*.ts` / `.js` — secret handling.

Override with the repository variable `TIER_SENSITIVE_REGEX` (an extended regex matched against one path per line). Add your own high-risk directories — the point of the list is that it names *your* dangerous code, not a generic one.

## Configuration

| Repository variable | Default | Meaning |
|---|---|---|
| `TIER_SENSITIVE_REGEX` | see above | Always-Full paths |
| `TIER_WORKSPACE_ROOTS` | `apps\|packages` | Alternation of monorepo roots whose first path segment names a workspace |
| `TIER_DEPLOY_CONFIG_REGEX` | wrangler / Dockerfile / compose / `*.tf` / serverless / fly | Deploy descriptors that block the Trivial tier |

**Non-monorepo repos need no configuration.** Nothing matches the default workspace roots, the workspace count stays 0, and both workspace gates are simply inert. Size, sensitive paths, and Trivial blockers still classify normally. That case is asserted in the test suite.

## Downstream gating

| Workflow | Behavior on `tier:trivial` |
|----------|----------------------------|
| `pre-pr-review.yml` | Skipped — a 5-reviewer pass adds noise on trivial diffs |
| `coordinator.yml` | No explicit skip needed — its ≥2-surfaces gate naturally absorbs the absence of upstream comments |
| your required CI | Always runs — tiering never gates correctness checks |

**Default-to-run when the label is absent.** A PR opened before the classifier exists, or in the race window before it completes, gets the full review surface. Worst-case cost: a few minutes of runner time on a trivial PR. The opposite default would silently skip review on a real PR.

## Manual overrides

```bash
# Force full review on a PR auto-tagged as trivial
gh pr edit <N> --add-label tier:full --remove-label tier:trivial

# Force skip on a PR the classifier picked as Full
gh pr edit <N> --add-label tier:trivial --remove-label tier:full
```

The classifier won't re-overwrite a manual label until the next push (which re-evaluates from the diff). For a permanent override, push a no-op commit after the manual label change.

## Concurrency

`cancel-in-progress: true` is correct for this workflow, unlike the comment-writing ones. Tier classification is idempotent — a later commit's run supersedes the prior one's with fresh inputs. Cancellation loses no data.

## Required secrets

None beyond `GITHUB_TOKEN` (provided automatically).

## Prior art

Implements the risk-tier and file-touched routing signals described in Cloudflare's 2026-05 [AI code review post](https://blog.cloudflare.com/ai-code-review/): trivial diffs get fewer agents, larger ones get more, and security-sensitive files always trigger the full review.
