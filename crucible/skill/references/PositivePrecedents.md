# Positive Precedents — Assume Safe Unless Proven Otherwise

These items pre-resolve common false-positive debates BEFORE the disprove sub-agent runs. They are NOT a deny-list — they are a list of patterns that are correct-by-construction and do not need flagging unless evidence proves otherwise.

**Load these into every Pass 1 reviewer** so candidates that touch these patterns are not enumerated in the first place. The disprove sub-agent (Pass 2) ALSO loads them as a tie-breaker when the trust-source check is ambiguous.

## 10 Positive Precedents

| # | Pattern | Assumption | Counter-evidence needed to flag |
|---|---|---|---|
| 1 | **UUIDs (v4) in URLs / identifiers** | Unguessable. Not a "predictable identifier" issue | UUID is sequential, predictable, or derived from low-entropy input (e.g., timestamp + counter) |
| 2 | **Env vars (`process.env`, `c.env`)** | Trusted. Not user-controlled | Diff shows env var being populated from a user-controlled source at runtime |
| 3 | **React/JSX text rendering** | Auto-escapes. `{userInput}` is safe | `dangerouslySetInnerHTML` is involved, OR raw HTML strings are concatenated outside JSX |
| 4 | **Zod-validated payloads** | Once a payload passes `schema.parse()`, downstream code can trust the shape | Schema is too permissive (e.g., `z.any()`, `passthrough()` on critical fields) |
| 5 | **Cloudflare Workers sandboxed isolate** | File-system, `child_process`, and most native-attack vectors don't apply | Code uses wasm with external buffer access, or escapes the isolate via known CVE |
| 6 | **D1 prepared statements** | `db.prepare("... ?").bind(value)` parametrizes. Not SQL-injectable | String concatenation BEFORE `prepare()`, or `db.exec(string)` with interpolated values |
| 7 | **JWT signature verification** | If `verifyJWT()` returns success, the claims are trusted (signature implies integrity) | Verifier accepts `alg: none`, or the secret is weak/leaked |
| 8 | **Client-side auth checks** | Don't count for/against. Server-side enforcement is what matters | The finding is "missing server-side auth check" — that's the real issue, flag it directly |
| 9 | **Same-tenant internal RPC payloads** | Service-to-service calls within the same trust boundary do not need input re-validation | RPC crosses tenancy boundary, or peer service has been compromised |
| 10 | **Constant-time comparison** | Only needed for **secret** comparison (passwords, tokens, HMAC outputs). Public IDs / config values do not need it | Comparison target is a secret value (API key, session token, password hash) |
| 11 | **Fail-on-revert test present (R7)** | When a functional change in the diff is paired with a test that fails when the change is reverted — by symbol-reference scan OR explicit revert-run — the change has structural evidence of correctness. Assume the change is verified | Test references symbol but evidence shows the test still passes after revert (asserts only that the symbol is callable, not that it produces the new behavior) |

## How Pass 2 uses these

The disprove sub-agent prompt (`tools/DisproveSubagentPrompt.md`) embeds this file. When evaluating Check #1 (trust source), the sub-agent matches the candidate against each precedent:

```
For candidate C:
  If the input is a UUID (precedent #1):
    Set disproven=true unless caller has evidence the UUID is predictable.
  If the input is process.env / c.env (precedent #2):
    Set disproven=true unless caller has evidence of runtime-user-populated env.
  ...etc
```

Precedents are matched on the candidate's `evidence` field plus a quick re-read of the surrounding code. A clean match flips `disproven=true` with high confidence.

## Why this works

Anthropic's published [claude-code-security-review](https://github.com/anthropics/claude-code-security-review) prompt uses precedents like these as the highest-leverage technique for cutting noise. They convert ambiguous reviewer findings into deterministic skip decisions, dropping the false-positive rate without touching the true-positive rate. Cross-validated by Molinet's "AI Security Scanning Checklist" Prompt #3 (False Positive Verification), which uses the same identify-then-filter architecture against the same FP-class.

## Adding new precedents

Three rules:

1. **The pattern must be correct-by-construction in the language/framework, not just usually-OK.** Precedent #6 (D1 prepared statements) qualifies because parametrization is enforced by the API. "Usually we validate input" does not qualify.
2. **The counter-evidence must be specific and observable in code.** Not "could be unsafe if misused" — name the specific anti-pattern.
3. **It must address a real FP class.** If reviewers don't actually flag this pattern, adding it just bloats the precedent set.
