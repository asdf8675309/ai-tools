# Do Not Report — Hard Exclusions Deny-List

> **Origin.** The idea of a hard deny-list applied *after* filtering — categories dropped regardless of reviewer confidence — comes from Anthropic's published security-review prompt and its `HARD EXCLUSIONS` section (<https://github.com/anthropics/claude-code-security-review>, MIT, © 2025 Anthropic). **The entries below are Crucible's own**, written for a different stack; they overlap Anthropic's only where any two people solving this problem land in the same place. If you want their list, use theirs — it is MIT and it is good.

These categories are intentionally excluded from Crucible review output. Flagging them produces noise, false positives, or duplicates work owned by other tooling. The deny-list is applied at **Phase 5 (Filter Survivors)** — reviewers in Pass 1 may still enumerate them; the filter trims deterministically.

**This list is reference data, not orchestration logic.** Reviewers read it for context. The Phase 5 filter applies it programmatically.

## 19 Hard Exclusions

| # | Category | Reason for exclusion | When to override |
|---|---|---|---|
| 1 | **DOS or rate-limiting concerns on internal-only endpoints** | Internal services behind a WAF or edge rate-limit do not need app-level rate limiting flagged | Public-facing route with no edge protection |
| 2 | **Cloudflare-edge-protected rate limiting** | CF rate limits sit upstream of the Worker. "Missing rate limit" inside a Worker is FP unless the public route lacks CF protection | Worker is reachable directly (no CF route in front) |
| 3 | **Log spoofing via newlines / control chars** | Only matters when logs feed a downstream parser confused by them. Structured loggers (`logger.info`) are immune | Logs flow into a CSV/TSV parser, syslog forwarder, or known-vulnerable downstream system |
| 4 | **Regex injection** | Limited real-world impact unless user-supplied regex compiled into a server-side pattern that affects other users | User can submit raw regex via API, server compiles and applies to others' data |
| 5 | **Prototype pollution from trusted sources** | Env vars, build-time constants, internal RPC payloads from same-tenant services do not pollute | Object merge taking attacker-controlled JSON from user input |
| 6 | **Tabnabbing (`target="_blank"` w/o `rel="noopener"`)** | LOW severity at most; not CRITICAL | Phishing-prone surface (login page, account settings) |
| 7 | **Dependency CVEs** | Dependabot owns this. Do not duplicate | A CVE bypasses Dependabot's scope (e.g., transitive dep with no patch path) |
| 8 | **Audit-log completeness** | Out of scope unless the change directly touches audit-logging code path | Diff modifies an audit-log emitter and weakens its guarantees |
| 9 | **Doc-only / comment-only / README changes** | No security or correctness review needed for prose changes | README contains code snippets that downstream tools execute |
| 10 | **Test file security with clearly-marked fakes** | `test-secret`, `fake-api-key`, `sk-test-...` in test fixtures are intentional. Do not flag | Test fixture contains a real production-shaped key (no `test-` prefix) |
| 11 | **Public values mistaken for secrets** | Cloudflare account IDs, AI Gateway slugs, Stripe `pk_live_*` publishable keys, public model URLs, OpenAI org IDs — all designed to be public | Value matches a real server-side secret pattern (`sk_live_`, `ghp_`, server-side keys, OAuth client secrets) |
| 12 | **CSRF on read-only GET endpoints** | CSRF requires a state-changing action. Read endpoints are immune by definition | Endpoint is documented GET but actually performs state changes (anti-pattern itself) |
| 13 | **Missing security headers when set at the CF/WAF edge** | CF can set CSP/HSTS/X-Frame-Options. Confirm via `curl -I` before flagging the Worker | `curl -I` shows the header is NOT being set at any layer |
| 14 | **eslint-plugin-security known false-positive patterns** | The plugin has well-known FPs around `child_process.execFile` with hardcoded commands. Do not echo plugin output verbatim | Plugin output identifies a genuine attacker-controlled input |
| 15 | **Memory safety concerns in TypeScript/JavaScript** | Managed runtime. JS engine handles bounds | Wasm boundary / buffer-handling code |
| 16 | **"Could be exploited in theory" without concrete attack path** | Finding MUST specify input source, sink, and attacker capability. Theoretical findings are not actionable | Finding includes attacker model, input vector, and reproducible attack chain |
| 17 | **Formatting / imports / quote-style / semicolons** | Prettier and ESLint own this. Do not surface in Crucible output even if a reviewer noticed | Formatting reflects a real security issue (e.g., hidden whitespace in env-var key) |
| 18 | **Findings on lines the diff did NOT modify** | Pre-existing issues in unchanged code are out of scope for a diff review — flagging them punishes the author for code they didn't touch | The diff's change directly activates or worsens the pre-existing issue (e.g., a new caller reaches a latent bug) |
| 19 | **Issues a linter / typechecker / compiler would catch** | Missing/incorrect imports, type errors, broken tests, and pure style are caught by `typecheck` / `lint` / the test suite, which CI runs separately. Do not duplicate CI's job | The typecheck/lint gate is disabled, skipped, or the file is excluded from CI (then it's a CI Tamper finding, not a code finding) |

## How the filter applies

Phase 5 implementation (in `workflows/FullReview.md`):

```
for finding in survivors_from_pass_2:
    if matches_any_exclusion(finding, DO_NOT_REPORT):
        drop(finding, reason=matched_exclusion)
    else:
        keep(finding)
```

The match logic is keyword + category + file-path heuristic. When in doubt, **keep** — the >80% confidence floor and 5-finding cap already trim aggressively.

## Adding new exclusions

Before adding to this list, check three things:

1. **Have you observed it as a real false positive at least 3 times?** One-off FPs are not worth a permanent exclusion.
2. **Is there a positive-precedent equivalent?** Some FPs are better addressed by adding to `PositivePrecedents.md` ("X is trusted") than by adding a deny entry.
3. **Does it overlap with an existing exclusion?** Extend the existing one rather than fragmenting.

When adding, follow the table shape: number, category, reason, override-condition.
