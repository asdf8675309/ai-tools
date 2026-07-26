#!/usr/bin/env bun
// Calls an OpenAI-compatible chat-completions endpoint with the reviewer prompt,
// parses the JSON response, and posts a sticky `<!-- pre-pr-review -->` comment
// on the PR.
//
// The workflow copies THIS FILE ALONE to /tmp from a trusted checkout of the
// default branch and runs `bun /tmp/call-reviewer.ts`, so every helper stays
// in-file — a sibling import would 404 at runtime.
//
// The pipeline lives in `runReview(env, io)`, which takes every side effect it
// needs as an injected dependency and RETURNS an exit code instead of calling
// process.exit. Only the `import.meta.main` block at the bottom binds the real
// filesystem, fetch, clock, and `gh`, so importing this module for unit tests
// runs nothing — no shelling out, no fetching, no /tmp, no exiting.
//
// Inputs:
//   /tmp/reviewer-prompt.md — trusted prompt template
//   /tmp/pr-diff.txt        — collect-diff.ts output (raw diff)
//   /tmp/pr-files.json      — collect-diff.ts output (file context + total chars)
// Outputs:
//   /tmp/pre-pr-review-raw.json        — raw gateway response (secret-scrubbed)
//   /tmp/pre-pr-review-raw-error.txt   — raw content on parse failure
//   /tmp/pre-pr-review-comment-body.md — assembled comment body (also posted)
//   PR comment upsert via gh api

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TOKEN = process.env.REVIEW_API_TOKEN;
const PR = Number(process.env.PR_NUMBER);
const REPO = process.env.GH_REPO;
const RUN_URL = process.env.RUN_URL ?? "";

// Provider-agnostic model access: any OpenAI-compatible server works (a vendor
// API, a gateway, a self-hosted proxy). BASE_URL is the prefix this script
// appends `/chat/completions` to.
const BASE_URL = (process.env.REVIEW_API_BASE_URL ?? "").replace(/\/+$/, "");
const MODEL = process.env.REVIEW_MODEL ?? "";
// Optional: a stronger model for large diffs. Falls back to REVIEW_MODEL.
const MODEL_LARGE = process.env.REVIEW_MODEL_LARGE || MODEL;
// Optional: gateways that accept per-request attribution read it from a custom
// header. Unset means no extra header is sent — some strict OpenAI-compatible
// servers reject unknown request-body fields, so the metadata never goes in the
// body. It is always written to the telemetry artifact regardless.
const METADATA_HEADER = process.env.REVIEW_METADATA_HEADER ?? "";

// Env guards run at module init. Tests set REVIEW_API_TOKEN + PR_NUMBER before
// importing so these don't exit; the import.meta.main guard at the bottom keeps
// main() from running under `bun test`.
if (!TOKEN) {
  console.error("REVIEW_API_TOKEN required");
  process.exit(2);
}
if (!PR) {
  console.error("PR_NUMBER required");
  process.exit(2);
}

const MARKER = "<!-- pre-pr-review -->";

// Single-sourced so the workflow's artifact-upload list and the tests reference
// the same literals the code writes.
export const PROMPT_PATH = "/tmp/reviewer-prompt.md";
export const DIFF_PATH = "/tmp/pr-diff.txt";
export const FILES_PATH = "/tmp/pr-files.json";
export const RAW_RESPONSE_PATH = "/tmp/pre-pr-review-raw.json";
export const RAW_ERROR_PATH = "/tmp/pre-pr-review-raw-error.txt";
export const META_PATH = "/tmp/pre-pr-review-meta.json";
export const COMMENT_BODY_PATH = "/tmp/pre-pr-review-comment-body.md";

// Prompt-injection delimiter defense. reviewer-prompt.md wraps untrusted PR
// content in <UNTRUSTED_DIFF> and <UNTRUSTED_FILES> tags. Strip any literal
// occurrence of those tags from the injected content BEFORE substitution so a
// malicious diff cannot forge a closing tag and break out into instruction
// context.
const DELIMITER_PATTERN = /<\/?UNTRUSTED_(?:DIFF|FILES?|FILE)>/gi;
// invariant: DELIMITER_PATTERN must match both opening and closing forms of
// UNTRUSTED_DIFF, UNTRUSTED_FILES, UNTRUSTED_FILE (case-insensitive).
{
  const _probe = [
    "<UNTRUSTED_DIFF>",
    "</UNTRUSTED_DIFF>",
    "<UNTRUSTED_FILES>",
    "</UNTRUSTED_FILES>",
    "<UNTRUSTED_FILE>",
    "</UNTRUSTED_FILE>",
  ];
  for (const tag of _probe) {
    if (!DELIMITER_PATTERN.test(tag)) {
      throw new Error(`DELIMITER_PATTERN invariant broken: did not match ${tag}`);
    }
    DELIMITER_PATTERN.lastIndex = 0; // reset between test() calls (g flag)
  }
}

export function stripDelimiters(s: string): string {
  return s.replace(DELIMITER_PATTERN, "[stripped-delimiter-token]");
}

// ONE pass, not three chained replaceAll calls. Two independent traps:
//
//   1. Sequential passes rescan what earlier passes inserted, so a diff
//      containing the literal text {INJECTED_FILES} gets the whole file block
//      spliced into it, once per occurrence. No `$` involved. Measured on the
//      PR that fixed this: 3 occurrences turned 91,306 chars of real content
//      into 343,002 — over the reviewer's own size guard.
//   2. `replaceAll` with a STRING replacement expands `$` patterns inside the
//      replacement; `$'` inserts everything after the match, `$$` collapses to
//      a single `$`. The callback form below is what disables that.
//
// Params are named `clean*` because callers must pass blocks already through
// stripDelimiters — the inline call site used to enforce that by construction;
// this seam relies on the convention.
//
// A single pass with a callback closes both and removes the ordering-dependence
// entirely — inserted content is never rescanned, whatever the placeholders are.
const PLACEHOLDERS = /\{(?:PR_NUMBER|INJECTED_DIFF|INJECTED_FILES)\}/g;

export function buildPrompt(
  template: string,
  pr: string,
  cleanDiffBlock: string,
  cleanFilesBlock: string,
): string {
  const map: Record<string, string> = {
    "{PR_NUMBER}": pr,
    "{INJECTED_DIFF}": cleanDiffBlock,
    "{INJECTED_FILES}": cleanFilesBlock,
  };
  return template.replace(PLACEHOLDERS, (m) => map[m] ?? m);
}

// The model-call retry envelope lives in ../lib/model-client.ts — the ONE place
// a CI script talks to a model. Imported (for this file's own call site) and
// re-exported (so this file's tests keep resolving them). The implementation is
// shared with call-coordinator.ts, so the two cannot drift apart the way they
// once did — the coordinator had no retry at all while this file had a full one.
import {
  callModelWithRetry,
  fetchTimeoutMs,
  isTransientStatus,
  clampDelay,
  retryAfterMs,
  MAX_RETRY_DELAY_MS,
  type ModelCallResult,
} from "../lib/model-client.ts";
export {
  callModelWithRetry,
  fetchTimeoutMs,
  isTransientStatus,
  clampDelay,
  retryAfterMs,
  MAX_RETRY_DELAY_MS,
  type ModelCallResult,
};

// Over LARGE_INPUT_CHARS the call swaps in the stronger model; over
// MAX_INPUT_CHARS (~80K tokens at 4 chars/token) it refuses the PR entirely.
export const LARGE_INPUT_CHARS = 30_000;
export const MAX_INPUT_CHARS = 320_000;
export const MAX_OUTPUT_TOKENS = 8192;

// `modelLarge || model` is re-applied here, not just at module init: an empty
// REVIEW_MODEL_LARGE must never resolve to an empty model name on a large PR.
export function selectModel(
  totalChars: number,
  model: string,
  modelLarge: string,
): { sizeTag: "large" | "standard"; model: string } {
  const sizeTag: "large" | "standard" = totalChars > LARGE_INPUT_CHARS ? "large" : "standard";
  return { sizeTag, model: sizeTag === "large" ? modelLarge || model : model };
}

// A configured base URL with a trailing slash would otherwise produce a double
// slash, which some gateways route differently (or 404).
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export function buildMetadata(
  pr: number,
  sizeTag: string,
  fileCount: number,
  totalChars: number,
): Record<string, string> {
  return {
    task: "pre-pr-review",
    pr: String(pr),
    size: sizeTag,
    file_count: String(fileCount),
    total_chars: String(totalChars),
  };
}

// The attribution metadata rides in a custom HEADER, never the request body:
// strict OpenAI-compatible servers reject unknown body fields. An unset
// REVIEW_METADATA_HEADER means no extra header at all.
export function buildModelHeaders(
  token: string,
  metadataHeader: string,
  metadata: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (metadataHeader) headers[metadataHeader] = JSON.stringify(metadata);
  return headers;
}

export function buildModelBody(model: string, prompt: string): string {
  return JSON.stringify({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
}

// ────────────────────────────────────────────────────────────────────────────

export interface Finding {
  severity: "CRITICAL" | "WARNING" | "SUGGESTION";
  file: string;
  title: string;
  rationale: string;
}

export interface ReviewerOutput {
  verdict: "APPROVE" | "APPROVE_WITH_COMMENTS" | "BLOCK";
  summary_line: string;
  code_quality: Finding[];
  security: Finding[];
  simplify: Finding[];
  typescript: Finding[];
  platform: Finding[];
  verification_criteria: string[];
}

interface RenderMeta {
  modelResolved: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  runUrl: string;
}

export function verdictEmoji(v: string): string {
  if (v === "APPROVE") return "✅";
  if (v === "APPROVE_WITH_COMMENTS") return "⚠️";
  if (v === "BLOCK") return "🛑";
  return "❓";
}

// All section accessors below tolerate a model that omits a section (e.g.
// returns only `{verdict, summary_line}`). `?? []` turns a missing section into
// an empty Finding[] so `.length` and iteration never throw post-parse.

export function countAll(out: ReviewerOutput): number {
  const codeQuality = out.code_quality ?? [];
  const security = out.security ?? [];
  const simplify = out.simplify ?? [];
  const typescript = out.typescript ?? [];
  const platform = out.platform ?? [];
  return (
    codeQuality.length +
    security.length +
    simplify.length +
    typescript.length +
    platform.length
  );
}

export function countBySeverity(
  out: ReviewerOutput,
  sev: Finding["severity"],
): number {
  let n = 0;
  for (const list of [
    out.code_quality ?? [],
    out.security ?? [],
    out.simplify ?? [],
    out.typescript ?? [],
    out.platform ?? [],
  ]) {
    for (const f of list) if (f.severity === sev) n++;
  }
  return n;
}

// Robust JSON object extraction. Tolerates chatty preamble, single or multiple
// markdown fences, trailing prose, and BOM. Finds the first '{' and matches it
// to the last '}'. On no-match, returns the trimmed input so JSON.parse surfaces
// its original error message.
export function extractJsonObject(raw: string): string {
  const trimmed = raw.replace(/^﻿/, "").trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return trimmed;
  }
  return trimmed.slice(firstBrace, lastBrace + 1);
}

// Escape a value for one markdown table cell. Finding fields are model output
// derived from the untrusted diff and are posted verbatim in a PUBLIC PR
// comment — unescaped, a `|` forges a column (making a HIGH look like a
// SUGGESTION) and a newline ends the row early, corrupting the table below it.
// Collapse any newline run to a space; escape pipes and backslashes.
export function mdCell(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").replace(/([\\|])/g, "\\$1");
}

// A filename rendered inside an inline code span. A backtick would break out of
// the span, and backticks cannot be escaped *inside* a code span — so strip
// them (a real path never needs one), then apply cell escaping for the table.
export function mdCodeCell(s: string): string {
  return mdCell(s.replace(/`/g, ""));
}

export function renderSection(name: string, findings: Finding[]): string {
  if (findings.length === 0) {
    return `### ${name}\n\n_No findings._\n`;
  }
  const rows = findings
    .map(
      (f) =>
        `| ${mdCell(f.severity)} | \`${mdCodeCell(f.file)}\` | ${mdCell(f.title)} — ${mdCell(f.rationale)} |`,
    )
    .join("\n");
  return `### ${name}\n\n| Severity | File | Finding |\n|----------|------|---------|\n${rows}\n`;
}

export function buildReviewComment(out: ReviewerOutput, meta: RenderMeta): string {
  const codeQuality = out.code_quality ?? [];
  const security = out.security ?? [];
  const simplify = out.simplify ?? [];
  const typescript = out.typescript ?? [];
  const platform = out.platform ?? [];
  const verification = out.verification_criteria ?? [];

  const total = countAll(out);
  const nCritical = countBySeverity(out, "CRITICAL");
  const nWarning = countBySeverity(out, "WARNING");
  const nSuggestion = countBySeverity(out, "SUGGESTION");

  const sections = [
    renderSection("Code Quality", codeQuality),
    renderSection("Security", security),
    renderSection("Simplify", simplify),
    renderSection("TypeScript", typescript),
    renderSection("Platform Best Practices", platform),
  ].join("\n");

  const criteria =
    verification.length === 0
      ? ""
      : `\n### Verification criteria for the PR description\n\n\`\`\`markdown\n${verification.map((c) => `- [ ] ${c}`).join("\n")}\n\`\`\`\n`;

  const runLink = meta.runUrl ? `[Run log](${meta.runUrl})` : "Run log unavailable";

  return `${MARKER}

## Pre-PR Review: ${verdictEmoji(out.verdict)} ${out.verdict}

${out.summary_line}

Found **${total}** findings across 5 reviewer passes — **${nCritical} CRITICAL / ${nWarning} WARNING / ${nSuggestion} SUGGESTION**.

${sections}
${criteria}
---

_Pre-PR Review: \`${meta.modelResolved}\`. Tokens: ${meta.inputTokens} in / ${meta.outputTokens} out. Duration: ${(meta.durationMs / 1000).toFixed(1)}s. ${runLink}._
`;
}

export function buildDegradedComment(status: number, errExcerpt: string): string {
  return `${MARKER}

## Pre-PR Review: ❌ DEGRADED

The pre-PR-review model call failed (HTTP ${status}) and the retry budget was exhausted.

Other review comments on this PR remain authoritative. Manual review required.

\`\`\`
${errExcerpt}
\`\`\`
`;
}

export function buildParseErrorComment(rawExcerpt: string): string {
  return `${MARKER}

## Pre-PR Review: ❌ PARSE_ERROR

The model returned a response that could not be parsed as JSON. Raw output (first 500 chars, secret-scrubbed):

\`\`\`
${rawExcerpt}
\`\`\`

Other review comments on this PR remain authoritative.
`;
}

export interface ReviewFile {
  path: string;
  content: string;
  truncated: boolean;
  truncatedReason?: string;
}

// Renders the per-file context block. A truncated file must still be ANNOUNCED —
// dropping it silently would let the model reason about a file it never saw —
// and must carry a reason even when collect-diff supplied none.
export function buildFilesBlock(files: ReviewFile[]): string {
  return files
    .map((f) =>
      f.truncated
        ? `\n#### ${f.path}\n_(diff-only — ${f.truncatedReason ?? "file exceeds size budget"})_\n`
        : `\n#### ${f.path}\n\`\`\`\n${f.content}\n\`\`\`\n`,
    )
    .join("");
}

export function buildTooLargeComment(chars: number): string {
  return `${MARKER}

## Pre-PR Review: 🛑 TOO_LARGE

Combined diff + file context was ${chars.toLocaleString()} chars (~${Math.round(chars / 4).toLocaleString()} tokens) — over the reviewer's 80K-token budget. This PR is too large for a single review pass.

Other review comments on this PR remain authoritative. Consider splitting the PR.
`;
}

// Reads the two inputs main() needs before it can call the model. Returns a
// result rather than throwing so main() can post the degraded comment instead of
// dying silently: /tmp/pr-diff.txt is written by collect-diff.ts AFTER its git
// diff succeeds, so a collect-diff failure leaves it absent.
export function readReviewerInputs(
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): { ok: true; promptTemplate: string; diff: string } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      promptTemplate: read(PROMPT_PATH),
      diff: read(DIFF_PATH),
    };
  } catch (e) {
    // Narrow rather than cast: `(e as Error).message` yields undefined for a
    // string throw and itself THROWS on a null throw — from inside the catch
    // that exists to prevent exactly that.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

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
// case, so it passes through. Base64 chunks of arbitrary content still match
// (mixed case + digits) — accepted trade-off, since base64 is a common API-key
// encoding and the alternative is leaving real secrets in public output.
export function scrubSecrets(s: string): string {
  return s
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
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

// Wrap the post in try/catch so failures during error-reporting paths don't
// mask the original failure in the run log. Without this, a `gh` PATCH/POST
// failure would throw before the script's intended non-zero exit runs.
async function safePost(io: ReviewIo, body: string): Promise<void> {
  try {
    await io.postComment(body);
  } catch (e) {
    io.log(`[pre-pr-review] postComment failed: ${e instanceof Error ? e.message : String(e)}`);
    // Don't rethrow — the calling context is itself an error path; it must reach
    // its own non-zero exit rather than be hijacked by the inner throw.
  }
}

// The comment is STICKY: one `<!-- pre-pr-review -->` comment per PR, updated in
// place. The jq filter is what finds the prior one; if it stops matching, every
// run appends a new comment instead of updating.
export function findCommentArgs(repo: string, pr: number): string[] {
  return [
    "api",
    `repos/${repo}/issues/${pr}/comments`,
    "--paginate",
    "--jq",
    `[.[] | select(.body | contains("${MARKER}"))] | .[0].id // empty`,
  ];
}

// `-F body=@<path>` reads the body from a file rather than argv — a large
// markdown body would otherwise hit the OS argument-length limit.
export function upsertCommentArgs(
  repo: string,
  pr: number,
  existingId: string,
  bodyPath: string,
): string[] {
  return existingId
    ? ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${existingId}`, "-F", `body=@${bodyPath}`]
    : ["api", "-X", "POST", `repos/${repo}/issues/${pr}/comments`, "-F", `body=@${bodyPath}`];
}

async function postComment(body: string): Promise<void> {
  // Find existing comment via marker
  const existing = execFileSync("gh", findCommentArgs(REPO ?? "", PR), {
    encoding: "utf8",
  }).trim();

  writeFileSync(COMMENT_BODY_PATH, body);
  execFileSync("gh", upsertCommentArgs(REPO ?? "", PR, existing, COMMENT_BODY_PATH), {
    stdio: "inherit",
  });
  console.error(
    existing
      ? `[pre-pr-review] updated existing comment ${existing}`
      : `[pre-pr-review] posted new comment on PR #${PR}`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// The pipeline. Every side effect it performs — file reads and writes, the model
// call, the comment post, the clock — arrives through `ReviewIo`, so the
// decision logic (which comment on which failure, and with which exit code) is
// exercisable without a network, a /tmp, or a `gh` binary. `main()` below is the
// only place the real implementations are bound, and it is guarded by
// import.meta.main so importing this module for tests runs none of it.

export interface ReviewEnv {
  pr: number;
  repo: string;
  baseUrl: string;
  model: string;
  modelLarge: string;
  metadataHeader: string;
  token: string;
  runUrl: string;
}

export interface ReviewIo {
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  postComment: (body: string) => Promise<void>;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
}

/**
 * Runs one review end to end and returns the PROCESS EXIT CODE rather than
 * calling process.exit. 0 is success — which includes TOO_LARGE, a budget
 * signal rather than a workflow failure. 1 is every reported failure; each one
 * posts a comment first, because pre-pr-review is not a required check and a
 * silent death reads on the PR as a clean review.
 */
export async function runReview(env: ReviewEnv, io: ReviewIo): Promise<number> {
  if (!env.repo) throw new Error("GH_REPO required (owner/repo)");
  if (!env.baseUrl) throw new Error("REVIEW_API_BASE_URL required");
  if (!env.model) throw new Error("REVIEW_MODEL required");

  // Guarded like the pr-files.json read below. collect-diff.ts writes
  // pr-diff.txt only after its git diff succeeds, so a collect-diff failure
  // leaves it absent — and the workflow runs this step on !cancelled() precisely
  // so that case still posts a comment. An unguarded read here would throw
  // first and defeat that.
  const inputs = readReviewerInputs(io.readFile);
  if (!inputs.ok) {
    io.log(`[pre-pr-review] failed to read reviewer inputs: ${inputs.error}`);
    await safePost(
      io,
      buildDegradedComment(0, scrubSecrets(`Failed to read reviewer inputs: ${inputs.error}`)),
    );
    return 1;
  }
  const { promptTemplate, diff } = inputs;

  // Guarded read+parse. SyntaxError / ENOENT here would otherwise bypass the
  // degraded path, leaving the workflow red with no PR comment posted.
  let filesJson: { files: ReviewFile[]; totalChars: number };
  try {
    filesJson = JSON.parse(io.readFile(FILES_PATH)) as typeof filesJson;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    io.log(`[pre-pr-review] failed to read/parse ${FILES_PATH}: ${msg}`);
    await safePost(io, buildDegradedComment(0, `Failed to read ${FILES_PATH}: ${msg}`));
    return 1;
  }

  const filesBlock = buildFilesBlock(filesJson.files);

  const cleanDiff = stripDelimiters(diff);
  const cleanFilesBlock = stripDelimiters(filesBlock);

  const fullPrompt = buildPrompt(
    promptTemplate,
    String(env.pr),
    `\`\`\`diff\n${cleanDiff}\n\`\`\``,
    cleanFilesBlock,
  );

  const totalChars = fullPrompt.length;
  const { sizeTag, model } = selectModel(totalChars, env.model, env.modelLarge);
  const metadata = buildMetadata(env.pr, sizeTag, filesJson.files.length, totalChars);

  // Token-budget guard: stop if input is over ~80K tokens (≈320K chars at 4
  // chars/token). Posting TOO_LARGE is intentional success (exit 0) — too-large
  // is a budget signal, not a workflow failure.
  if (totalChars > MAX_INPUT_CHARS) {
    io.log(`[pre-pr-review] input too large (${totalChars} chars) — posting TOO_LARGE comment`);
    await safePost(io, buildTooLargeComment(totalChars));
    return 0;
  }

  io.log(
    `[pre-pr-review] calling ${model}, size=${sizeTag}, ${totalChars} chars, ${filesJson.files.length} files`,
  );

  const t0 = io.now();
  const { resp, networkErrorMsg } = await callModelWithRetry(
    (attempt) =>
      io.fetchImpl(chatCompletionsUrl(env.baseUrl), {
        method: "POST",
        headers: buildModelHeaders(env.token, env.metadataHeader, metadata),
        body: buildModelBody(model, fullPrompt),
        signal: AbortSignal.timeout(fetchTimeoutMs(attempt)),
      }),
    io.sleep,
  );

  const durationMs = io.now() - t0;

  if (!resp) {
    io.log(`[pre-pr-review] fetch failed: ${networkErrorMsg}`);
    await safePost(io, buildDegradedComment(0, scrubSecrets(`fetch failed: ${networkErrorMsg}`)));
    return 1;
  }

  if (!resp.ok) {
    const errBody = await resp.text();
    // Scrub Bearer-token-shaped strings before any public-facing surface. A
    // well-behaved server shouldn't echo Authorization headers in errors, but
    // defense in depth: any token-shaped substring lands in a PUBLIC PR comment
    // otherwise.
    const safeErr = scrubSecrets(errBody.slice(0, 300));
    io.log(`[pre-pr-review] model error ${resp.status}: ${scrubSecrets(errBody.slice(0, 500))}`);
    await safePost(io, buildDegradedComment(resp.status, safeErr));
    return 1;
  }

  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };

  // Always persist the full response BEFORE the empty-content check, so the
  // artifact upload preserves visibility regardless of outcome. Without this, an
  // empty-content path (HTTP 200, empty body) loses the data that would explain
  // WHY content was empty. The artifact is upload-only, never re-read
  // downstream, so scrubbing the whole response is safe.
  io.writeFile(RAW_RESPONSE_PATH, scrubSecrets(JSON.stringify(data, null, 2)));

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    io.log("[pre-pr-review] empty response");
    await safePost(io, buildDegradedComment(200, "Empty response from the model endpoint"));
    return 1;
  }

  // Parse JSON — the reviewer should return strict JSON. Tolerate chatty
  // preamble, single or multiple fences, trailing prose, and BOM.
  let parsed: ReviewerOutput;
  try {
    parsed = JSON.parse(extractJsonObject(content)) as ReviewerOutput;
  } catch (e) {
    io.log(`[pre-pr-review] failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`);
    io.writeFile(RAW_ERROR_PATH, scrubSecrets(content));
    await safePost(io, buildParseErrorComment(scrubSecrets(content.slice(0, 500))));
    return 1;
  }

  // Telemetry meta — structured fields so downstream aggregation (cost-per-PR,
  // p95 duration, model distribution) can read them instead of scraping the
  // rendered markdown comment.
  io.writeFile(
    META_PATH,
    JSON.stringify(
      {
        pr: env.pr,
        model_requested: model,
        model_resolved: data.model,
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens,
        total_tokens: data.usage?.total_tokens,
        duration_ms: durationMs,
        size_tag: sizeTag,
        file_count: filesJson.files.length,
        verdict: parsed.verdict,
        finding_count: countAll(parsed),
      },
      null,
      2,
    ),
  );

  const commentBody = buildReviewComment(parsed, {
    modelResolved: data.model ?? model,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    durationMs,
    runUrl: env.runUrl,
  });

  await safePost(io, commentBody);

  io.log(
    `[pre-pr-review] done: verdict=${parsed.verdict}, total=${countAll(parsed)}, model=${data.model ?? model}, ${durationMs}ms`,
  );
  return 0;
}

if (import.meta.main) {
  const env: ReviewEnv = {
    pr: PR,
    repo: REPO ?? "",
    baseUrl: BASE_URL,
    model: MODEL,
    modelLarge: MODEL_LARGE,
    metadataHeader: METADATA_HEADER,
    token: TOKEN ?? "",
    runUrl: RUN_URL,
  };
  const io: ReviewIo = {
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, contents) => writeFileSync(p, contents),
    postComment,
    fetchImpl: (url, init) => fetch(url, init),
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    log: (msg) => console.error(msg),
  };

  // Class-level backstop. The guarded reads above cover the known missing-input
  // path, but any other throw in runReview would otherwise kill the process with
  // no comment — and because pre-pr-review is not a required check, a silent
  // death leaves the PR green and reads as reviewed. Post, then exit non-zero.
  const code = await runReview(env, io).catch(async (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[pre-pr-review] unhandled failure: ${msg}`);
    await safePost(io, buildDegradedComment(0, scrubSecrets(`Reviewer crashed: ${msg}`)));
    return 1;
  });
  if (code !== 0) process.exit(code);
}
