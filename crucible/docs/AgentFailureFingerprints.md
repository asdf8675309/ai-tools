# Agent Failure Fingerprints — Per-Author Check Emphasis

Reference for the Crucible R4 per-agent-author profile loader. When `tools/PRAuthorClassifier.ts` detects that a PR was authored end-to-end by a specific coding agent, this table tells the Phase 1 Pattern Survey + Phase 3 reviewers which failure modes to emphasize.

Data anchored to Greptile's "Rise of the Overnight Agents" report (published May 2026, April 2026 data) (https://www.greptile.com/blog/rise-of-the-overnight-agents) — agent vs human failure rates per LOC, normalized so 1.00× = human baseline.

## The fingerprint table

Failure-rate multipliers vs human baseline (≥1.5× warrants emphasized check; ≥2.0× warrants HIGH-severity default):

| Failure pattern | Claude | Codex | Devin | Cursor BG |
|-----------------|--------|-------|-------|-----------|
| n+1 query | 1.27× | 0.64× | 0.45× | **3.45×** |
| Regression / breaks existing | 1.25× | 1.34× | 0.89× | **2.37×** |
| Missing test | 0.96× | 1.13× | 0.93× | **2.37×** |
| Off-by-one | 1.64× | 0.55× | 0.64× | **2.27×** |
| Timezone / date handling | 1.48× | 0.90× | 0.66× | 2.09× |
| SQL injection | 1.50× | 1.25× | 0.70× | 1.70× |
| XSS | 1.57× | 0.86× | 0.86× | 1.43× |
| Auth bypass | 1.50× | 1.00× | 0.50× | 1.67× |
| IDOR / tenant check | **1.75×** | 0.88× | 0.69× | 1.31× |
| Stale comment / wrong doc | 1.69× | 0.38× | 0.88× | 0.69× |
| Env var / config bug | 1.45× | **1.35×** | **1.35×** | 0.95× |
| Secret in logs | 1.34× | 1.34× | 0.94× | 1.65× |
| "Wrong task completed" (Devin only) | — | — | **HIGH** | — |

## Per-author check emphasis

When `PRAuthorClassifier.ts` returns `{ agent: "claude" | "codex" | "devin" | "cursor-bg" | "unknown" }`, the Phase 1 patterns block is annotated with the matching check-emphasis list below. Each reviewer's Pass 1 prompt receives this as context: "agent-author is X, weight these checks higher than usual."

### Claude — security + doc hygiene gaps

Highest-rate failure modes (≥1.5×):
- **IDOR / tenancy boundary checks (1.75×)** — every endpoint touching user-owned data must verify the requesting user owns the data. Security reviewer emphasizes per-tenant boundary checks.
- **Stale comments / wrong docs (1.69×)** — Code Quality reviewer checks whether comments in the diff match the new behavior; flags comment-code drift.
- **Off-by-one bugs (1.64×)** — Code Quality + Test Runner reviewers emphasize boundary tests (`>= 0`, `<= length-1`, pagination cutoffs).
- **XSS (1.57×)** — Security reviewer emphasizes output-encoding paths, esp. dangerouslySetInnerHTML and string-interpolated HTML.
- **SQL injection (1.50×)** + **Auth bypass (1.50×)** — Security reviewer's existing OWASP pass already covers these; just bump confidence floor on Claude PRs.
- **Timezone / date (1.48×)** — Code Quality emphasizes time-zone-aware date handling; flags naive `new Date()` arithmetic.
- **Env var / config (1.45×)** — Platform Best Practices reviewer emphasizes config-validation patterns.

### Codex — config + breakage cluster

Highest-rate failure modes (≥1.3×):
- **Regression / breaks existing (1.34×)** — Test Runner emphasizes regression test suite; CI Tamper checks for test removals.
- **Secret in logs (1.34×)** — Security reviewer scans `logger.*` and `console.*` calls for secret/token/email patterns.
- **Env var / config (1.35×)** — Platform Best Practices reviewer emphasizes env-var validation; verify all new env vars are documented in `.env.example`.
- **SQL injection (1.25×)** — Security reviewer's standard pass with bumped confidence.

### Devin — task-completion drift

Highest-rate failure modes (≥1.3×):
- **"Wrong task completed"** — Devin's distinct failure mode: completes A successfully but the PR's stated intent was B. Code Quality reviewer reads the PR title/body against the diff and flags any divergence (R12 removal-tracking gate catches one variant; Code Quality structural check catches the other).
- **Env var / config (1.35×)** — same as Codex; Platform Best Practices emphasizes config validation.
- Devin Revert Rate is high in the source data — this is operationalized as "extra weight on the PR title/body ↔ diff coherence check."

### Cursor BG — volume-heavy, hygiene-light

Highest-rate failure modes (≥2.0×):
- **n+1 query (3.45×)** — Code Quality + Platform reviewer emphasize loop-over-DB-call patterns. Flag any `for (... of items) { await db.query(...) }` shape.
- **Regression / breaks existing (2.37×)** — Test Runner emphasizes regression suite + CI Tamper checks for test removals.
- **Missing test (2.37×)** — R7 fail-on-revert gate becomes a HARD BLOCK (not just WARNING) on Cursor BG PRs.
- **Off-by-one (2.27×)** — same as Claude but bumped to HIGH-default severity.
- **Timezone / date (2.09×)** — same.

## Unknown / unclassified author

When `PRAuthorClassifier.ts` returns `{ agent: "unknown" }` (no `Co-Authored-By:` footer, no recognized branch prefix, no GitHub bot author, no heuristic match), no emphasis is applied — reviewers use their default check distribution. This is the correct behavior for human-authored PRs and for mixed-authorship PRs where attribution is genuinely ambiguous.

**Do NOT** assign emphasis based on file paths, code style, or other indirect signals — that's a false-positive multiplier on real human code. The Greptile data only applies when the agent attribution is direct (committed metadata).

## Caveats inherited from the Greptile source

The Greptile data has documented limitations:
- **Adverse selection** — humans may write riskier PRs; agent PRs may skew toward safer changes
- **Cross-agent contamination** — Codex PRs may have had Claude review; classifier picks one
- **Self-review** — Cursor BG and Codex now ship pre-PR review hooks; their PRs are pre-cleaned before Greptile sees them
- **"Human" baseline isn't really human** — anyone with an AI-assisted IDE running has AI in the loop

The fingerprints are directional, not absolute. Use them to tilt review attention, not to rubber-stamp findings.

## When to update this table

- Greptile (or another industry observer) publishes refreshed per-vendor data
- A new coding agent reaches non-trivial PR volume (currently tracking Claude / Codex / Devin / Cursor BG)
- A failure pattern's multiplier shifts materially (>0.5× delta from current table)
- An agent's fix profile is documented (e.g., Cursor BG ships an n+1-query analyzer in their PR pre-check)
