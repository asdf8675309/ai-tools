// scrub.ts — the one scrubber every CI script sends text through before that
// text reaches a public surface (a PR comment) or a run log.
//
// It used to be copied byte-for-byte into call-reviewer.ts and
// call-coordinator.ts, with a comment claiming the duplication was forced by
// deployment: the reviewer is copied to /tmp while the coordinator runs in
// place, and a shared module would 404 in the copied case. That stopped being
// true when the reviewer's staging step started copying `lib/` alongside the
// script (it already imports ../lib/model-client.ts) — so the scrubber, the
// highest-stakes function in either file, no longer has to exist twice.
//
// A workflow that stages these scripts MUST copy this file too. See
// workflows/pre-pr-review.yml, "Stage trusted scripts at /tmp".

// Scrub Bearer-token-shaped strings + known-prefix API keys + a tightened
// long-alnum token-shape heuristic from any text destined for a public surface.
// Catches the defense-in-depth case where an upstream provider error echoes the
// Authorization header back in its response body.
//
// An earlier heuristic `\b[A-Za-z0-9_-]{40,}\b` was too broad — it redacted
// SHA-256 hashes (64 hex), git commit SHAs (40 hex), npm sha512 lockfile hashes,
// and base64 chunks, stripping useful diagnostic info from DEGRADED /
// PARSE_ERROR excerpts. Tightened:
//   - explicit Bearer / known-prefix anchors run first (always redact)
//   - generic fallback requires length ≥ 48 AND mixed case AND ≥ 1 digit
// Plain hex (commit SHAs, sha256/sha512) is single-case + digits but not mixed
// case, so it passes through — which is also why the coordinator's state-comment
// guard is defense-in-depth rather than load-bearing today. Base64 chunks of
// arbitrary content still match (mixed case + digits) — accepted trade-off,
// since base64 is a common API-key encoding and the alternative is leaving real
// secrets in public output.
export function scrubSecrets(s: string): string {
  return s
    // RFC 6750 §2.1 b64token charset (ALPHA / DIGIT / "-" / "." / "_" / "~" /
    // "+" / "/", optionally "="-padded) — the prior [A-Za-z0-9._-]+ stopped at
    // the first "+", "/", or "=", leaving the rest of a base64-shaped bearer
    // token exposed in public output.
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
    // Known secret prefixes — redact regardless of shape characteristics.
    .replace(/\b(ghp_|gho_|ghu_|ghs_|ghr_|sk-ant-|sk-|sk_|cf_|xoxb-|xoxp-)[A-Za-z0-9_-]+/g, "[REDACTED-PREFIXED-TOKEN]")
    // Tightened generic heuristic: ≥48 chars, mixed case, at least one digit.
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, (match) => {
      const hasUpper = /[A-Z]/.test(match);
      const hasLower = /[a-z]/.test(match);
      const hasDigit = /[0-9]/.test(match);
      return hasUpper && hasLower && hasDigit ? "[REDACTED-TOKEN-SHAPE]" : match;
    });
}
