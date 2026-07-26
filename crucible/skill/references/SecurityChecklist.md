# Security Reviewer — Vulnerability Checklist

> Loaded by the Crucible **Security reviewer** — Pass 1 reviewer #2 in `FullReview`,
> and the sole reviewer in `SecurityOnly`. Absorbed from a retired repo-local
> GitHub Actions security-review workflow so Crucible's security review is
> **self-contained** — it no longer depends on a per-repo
> `.github/agents/security-reviewer.md` file and works on any repo.
>
> Use alongside `TrustBoundary.md` (diff-as-untrusted-input) and
> `PositivePrecedents.md` (assume-safe list). Frame every finding as a deviation
> from the codebase's own patterns (the Phase 1 patterns block) — not against
> this checklist in the abstract.

## OWASP Top 10 — review questions

1. **Injection** — queries parameterized? user input sanitized? ORM used safely?
2. **Broken auth** — passwords hashed (bcrypt/argon2)? JWT validated (signature + `exp` + `aud` + `iss`)? sessions secure?
3. **Sensitive data** — HTTPS enforced? secrets in env / Secrets Store? PII encrypted? logs sanitized (no raw email/token)?
4. **XXE** — XML parsers configured securely, external entities disabled?
5. **Broken access control** — auth checked on every state-changing route? CORS / `frame-ancestors` / `postMessage` origins allowlisted? IDOR (object IDs scoped to the caller)?
6. **Misconfiguration** — default creds changed? debug off in prod? security headers (CSP, HSTS) set?
7. **XSS** — output escaped? CSP set? framework auto-escaping not bypassed (`innerHTML`, `dangerouslySetInnerHTML`)?
8. **Insecure deserialization** — user input deserialized safely?
9. **Known-vulnerable dependencies** — `npm audit` clean? new deps vetted?
10. **Logging** — security events logged — and conversely, secrets / tokens / raw PII NOT logged?

## Code patterns — flag on sight

| Pattern | Severity | Fix |
|---------|----------|-----|
| Hardcoded secret / API key / token | CRITICAL | env var / Secrets Store |
| Shell command built with user input | CRITICAL | safe API / `execFile` with an arg array |
| String-concatenated SQL | CRITICAL | parameterized query / prepared statement |
| Plaintext password / token comparison | CRITICAL | constant-time compare (`bcrypt.compare`, `crypto.timingSafeEqual`) |
| No auth check on a state-changing route | CRITICAL | auth middleware on the route |
| Balance / quota check without a lock | CRITICAL | `FOR UPDATE` / transactional guard |
| `innerHTML = userInput` | HIGH | `textContent` / sanitizer |
| `fetch(userProvidedUrl)` (SSRF) | HIGH | allowlist target hosts |
| No rate limit on an unauthenticated endpoint | HIGH | rate-limit binding / middleware |
| Logging passwords / tokens / raw PII | MEDIUM | redact at the log call site |

## Known false positives — do NOT flag

- Env vars in `.env.example` — placeholders, not real secrets.
- Test credentials in test files, clearly marked, using reserved domains (`example.com`).
- Public / publishable keys genuinely meant to be public.
- SHA-256 / MD5 used for checksums or cache keys — not password hashing.

Always verify context before flagging — cross-check `PositivePrecedents.md`.

## Principles

Defense in depth · least privilege · fail securely (errors don't leak data) · don't trust input · keep dependencies current.
