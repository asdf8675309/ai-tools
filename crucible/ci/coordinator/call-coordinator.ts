#!/usr/bin/env bun
// Runs in place from the workflow's trusted default-branch checkout — never from
// the PR tree. Calls an OpenAI-compatible chat-completions endpoint with the
// coordinator prompt, parses the JSON response, and posts a sticky
// `<!-- coordinator-judge -->` comment on the PR.
//
// Unlike call-reviewer.ts this file DOES import siblings: the workflow runs it
// from the checkout rather than copying it to /tmp, precisely so the relative
// imports resolve. Copying only this file to /tmp broke them.
//
// Inputs:
//   /tmp/coordinator-prompt.md  — trusted prompt template
//   /tmp/comments.json          — fetch-surfaces.ts output
// Outputs:
//   /tmp/coordinator.json       — raw JSON the coordinator returned
//   /tmp/coordinator-meta.json  — telemetry (model, tokens, duration)
//   PR comment upsert via gh api

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseStateComment } from "./parse-state.ts";
import {
  computeDelta,
  detectForcePush,
  withCounters,
  type ComputeDeltaOptions,
  type ComputeDeltaResult,
  type SourceFinding,
} from "./compute-delta.ts";
import { parseDismissalCommands, type DismissalComment } from "./parse-dismissals.ts";
import type { CoordinatorState, FindingSeverity, StateFinding } from "./state-schema.ts";
import {
  chatCompletion,
  selectModel,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_TOKENS,
  type ChatCompletionResponse,
} from "../lib/model-client.ts";
// The scrubber and the verdict glyphs are shared with call-reviewer.ts, which
// used to hold its own byte-identical copy of each. Re-exported because the
// coordinator's tests reach for them through this module.
import { scrubSecrets } from "../lib/scrub.ts";
import { verdictEmoji } from "../lib/verdict.ts";
export { scrubSecrets };

const TOKEN = process.env.REVIEW_API_TOKEN;
const PR = Number(process.env.PR_NUMBER);
const REPO = process.env.GH_REPO;
const RUN_URL = process.env.RUN_URL ?? "";
const BASE_URL = (process.env.REVIEW_API_BASE_URL ?? "").replace(/\/+$/, "");
const MODEL = process.env.REVIEW_MODEL ?? "";
const MODEL_LARGE = process.env.REVIEW_MODEL_LARGE || MODEL;
const METADATA_HEADER = process.env.REVIEW_METADATA_HEADER ?? "";
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "main";

// `||` not `??`: Actions passes an unset repository variable as the EMPTY
// STRING, not as undefined, so `??` would happily adopt "" as the head SHA.
const CURRENT_HEAD_SHA =
  process.env.CURRENT_HEAD_SHA ||
  process.env.GITHUB_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const BASE_SHA =
  process.env.BASE_SHA ||
  (process.env.GITHUB_BASE_REF
    ? execFileSync("git", ["rev-parse", `origin/${process.env.GITHUB_BASE_REF}`], {
        encoding: "utf8",
      }).trim()
    : execFileSync("git", ["rev-parse", `origin/${DEFAULT_BRANCH}`], { encoding: "utf8" }).trim());

// HTML marker for the sticky upsert. Declared HERE (top of file) — not next to
// the comment-builders below — because top-level awaits later in this file
// invoke those builders before lexical execution reaches their block. A `const`
// is in the temporal dead zone until its declaration line runs; declaring this
// after those awaits produced "Cannot access 'MARKER' before initialization" at
// the exact moment the surface-count gate was first cleared and the verdict path
// actually executed end-to-end. Kept here to make the ordering visible.
const MARKER = "<!-- coordinator-judge -->";
const STATE_MARKER = "<!-- coordinator-state -->";
// Max state-comment body length before fitStateForComment trims old commits +
// closed findings to fit. GitHub's hard limit is 65536; 60K leaves headroom for
// the markdown chrome wrapping the state JSON.
export const MAX_COMMENT_BODY = 60_000;

// ONE pass, not chained replaceAll calls — same construct as call-reviewer.ts's
// buildPrompt, for the same two reasons: sequential passes rescan inserted
// content, and `replaceAll` with a string replacement expands `$` patterns from
// it (`$'` inserts everything after the match).
//
// The rescan half is latent here rather than live: the untrusted value is
// substituted last today, so nothing it inserts is rescanned. Single-pass keeps
// that true if a placeholder is ever added in front of it. The `$` half IS live
// — this is JSON.stringify'd review-comment prose, which quotes shell and regex
// routinely, and JSON.stringify does not escape `$`.
const PLACEHOLDERS = /\{(?:PR_NUMBER|INJECTED_COMMENTS_JSON)\}/g;

export function buildPrompt(template: string, pr: string, commentsJson: string): string {
  const map: Record<string, string> = {
    "{PR_NUMBER}": pr,
    "{INJECTED_COMMENTS_JSON}": commentsJson,
  };
  return template.replace(PLACEHOLDERS, (m) => map[m] ?? m);
}

// Incremental mode: track findings across commits in a state comment, and send
// the model only what is new or still open. Off by default — the seed path
// behaves exactly like a stateless coordinator.
const INCREMENTAL = process.env.INCREMENTAL_REVIEW_ENABLED === "true";

if (!TOKEN) {
  console.error("REVIEW_API_TOKEN required");
  process.exit(2);
}
if (!PR) {
  console.error("PR_NUMBER required");
  process.exit(2);
}

// Top-level imperative flow lives in main(). The state comment is written
// exactly once, in the `finally` below, on every exit path that occurs AFTER the
// delta is computed — so error paths no longer each have to remember their own
// state write. NOTE: use `return` (with process.exitCode for failures) inside
// the try, NEVER process.exit() — process.exit skips finally and would drop the
// state write.
export async function main(deps: { sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  if (!REPO) throw new Error("GH_REPO required (owner/repo)");
  if (!BASE_URL) throw new Error("REVIEW_API_BASE_URL required");
  if (!TOKEN) throw new Error("REVIEW_API_TOKEN required");
  if (!MODEL) throw new Error("REVIEW_MODEL required");

  const promptTemplate = readFileSync("/tmp/coordinator-prompt.md", "utf8");
  // Guarded /tmp/comments.json read+parse. SyntaxError / ENOENT here would
  // otherwise bypass the degraded path, leaving the workflow red with no PR
  // comment posted. This runs BEFORE any delta exists, so it exits directly —
  // there is no state to write yet.
  let surfaces: SurfacesInput;
  try {
    const surfacesJson = readFileSync("/tmp/comments.json", "utf8");
    surfaces = JSON.parse(surfacesJson) as SurfacesInput;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[coordinator] failed to read/parse /tmp/comments.json: ${msg}`);
    await safePostComment(buildDegradedComment(0, `Failed to read /tmp/comments.json: ${msg}`));
    process.exit(1);
  }
  const currentFindings = sourceFindingsFromSurfaces(surfaces);

  const runId = process.env.GITHUB_RUN_ID ?? "0";
  const currentTs = new Date().toISOString();
  const { priorState, opts } = loadPriorContext(currentTs, runId, INCREMENTAL);
  const delta = computeDelta(priorState, currentFindings, opts);

  try {
    const promptSurfaces = INCREMENTAL
      ? surfacesForDelta(surfaces, [...delta.newly_introduced, ...delta.carried_over], currentTs)
      : surfaces;
    const promptSurfacesJson = JSON.stringify(promptSurfaces, null, 2);

    if (INCREMENTAL && delta.newly_introduced.length + delta.carried_over.length === 0) {
      const emptyComment = buildIncrementalApproveComment(delta, {
        modelResolved: "not-called",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        surfaceCount: promptSurfaces.surface_count,
        surfacesPresent: promptSurfaces.surfaces_present,
        runUrl: RUN_URL,
      });
      await safePostComment(emptyComment);
      console.error("[coordinator] empty incremental input: posted APPROVE without calling the model");
      return;
    }

    const fullPrompt = buildPrompt(promptTemplate, String(PR), promptSurfacesJson);

    const totalChars = fullPrompt.length;
    const { sizeTag, model } = selectModel(totalChars, MODEL, MODEL_LARGE);

    // Token-budget guard: stop if input is over ~80K tokens (≈320K chars).
    if (totalChars > MAX_INPUT_CHARS) {
      await safePostComment(buildBudgetBlockedComment(totalChars));
      console.error(`[coordinator] input too large (${totalChars} chars) — posted TOO_LARGE comment`);
      return;
    }

    const metadata = {
      task: "coordinator",
      pr: String(PR),
      size: sizeTag,
      surface_count: String(promptSurfaces.surface_count),
      total_chars: String(totalChars),
    };

    console.error(
      `[coordinator] calling ${model}, size=${sizeTag}, ${totalChars} chars, ${promptSurfaces.surface_count} surfaces`,
    );

    // One model call through the shared client, which owns the retry envelope
    // (429 / 5xx / transport throw → bounded backoff, Retry-After honored and
    // clamped, all inside the job timeout). The coordinator previously did a
    // single un-retried fetch here, so a rate limit that the reviewer rode out
    // would fail this step; going through model-client.ts is what removed that
    // divergence.
    const t0 = Date.now();
    const { resp, networkErrorMsg } = await chatCompletion({
      baseUrl: BASE_URL,
      token: TOKEN,
      model,
      prompt: fullPrompt,
      maxTokens: MAX_OUTPUT_TOKENS,
      metadataHeader: METADATA_HEADER || undefined,
      metadata,
      sleep: deps.sleep,
      // Scrub before the retry envelope's messages reach the CI log — an
      // upstream error body can carry a token, and this now fires once per
      // retry. The old single-fetch path logged it unscrubbed; this is stricter.
      log: (m: string) => console.error(scrubSecrets(m.replace("[model-client]", "[coordinator]"))),
    });
    const durationMs = Date.now() - t0;

    if (!resp) {
      // Every attempt threw at the transport layer — no HTTP status to report.
      const msg = networkErrorMsg ?? "unknown network error";
      console.error(`[coordinator] fetch failed after retries: ${msg}`);
      await safePostComment(buildDegradedComment(0, scrubSecrets(`fetch failed: ${msg}`)));
      process.exitCode = 1;
      return;
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      // Scrub Bearer-token-shaped strings before any public-facing surface:
      // any token-shaped substring lands in a PUBLIC PR comment otherwise.
      const safeErr = scrubSecrets(errBody.slice(0, 300));
      console.error(`[coordinator] model error ${resp.status}: ${scrubSecrets(errBody.slice(0, 500))}`);
      await safePostComment(buildDegradedComment(resp.status, safeErr));
      process.exitCode = 1;
      return;
    }

    const data = (await resp.json()) as ChatCompletionResponse;

    // Always persist the full response BEFORE the empty-content check, so the
    // artifact upload preserves visibility regardless of outcome. Without this,
    // an empty-content path (HTTP 200, empty body) loses the data that would
    // explain WHY content was empty.
    writeFileSync(
      "/tmp/coordinator-raw.json",
      scrubSecrets(JSON.stringify(data, null, 2)),
    );

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      console.error("[coordinator] empty response");
      await safePostComment(buildDegradedComment(200, "Empty response from the model endpoint"));
      process.exitCode = 1;
      return;
    }

    writeFileSync("/tmp/coordinator.json", content);
    writeFileSync(
      "/tmp/coordinator-meta.json",
      JSON.stringify(
        {
          pr: PR,
          model_requested: model,
          model_resolved: data.model,
          input_tokens: data.usage?.prompt_tokens,
          output_tokens: data.usage?.completion_tokens,
          total_tokens: data.usage?.total_tokens,
          duration_ms: durationMs,
          size_tag: sizeTag,
          surface_count: promptSurfaces.surface_count,
        },
        null,
        2,
      ),
    );

    // Parse JSON — the coordinator should return strict JSON. Tolerate one
    // optional fence.
    let parsed: CoordinatorOutput;
    try {
      const cleaned = content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "");
      parsed = JSON.parse(cleaned) as CoordinatorOutput;
    } catch (e) {
      console.error(`[coordinator] failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`);
      writeFileSync("/tmp/coordinator-raw-error.txt", content);
      await safePostComment(buildParseErrorComment(scrubSecrets(content.slice(0, 500))));
      process.exitCode = 1;
      return;
    }

    const commentBody = buildVerdictComment(parsed, {
      modelResolved: data.model ?? model,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      durationMs,
      surfaceCount: promptSurfaces.surface_count,
      surfacesPresent: promptSurfaces.surfaces_present,
      runUrl: RUN_URL,
      delta,
    });

    await safePostComment(commentBody);

    console.error(
      `[coordinator] done: verdict=${parsed.verdict}, kept=${(parsed.findings_kept ?? []).length}, dropped=${(parsed.findings_dropped ?? []).length}, model=${data.model ?? model}, ${durationMs}ms`,
    );
  } finally {
    await safePostStateComment(buildStateComment(delta.state));
  }
}

// Only run when invoked as the entry script. Guarded so the module can be
// imported by the test harness without executing the model flow. Tests set
// REVIEW_API_TOKEN / PR_NUMBER / CURRENT_HEAD_SHA / BASE_SHA before importing so
// module-init has no side effects (no process.exit, no git shell-out).
if (import.meta.main) {
  await main();
}

// ────────────────────────────────────────────────────────────────────────────

interface CoordinatorOutput {
  verdict: "APPROVE" | "APPROVE_WITH_COMMENTS" | "BLOCK";
  summary_line: string;
  findings_kept: Array<{
    severity: "CRITICAL" | "WARNING" | "SUGGESTION";
    file: string;
    title: string;
    rationale: string;
    source_surface: string;
    original_severity?: string;
  }>;
  findings_dropped: Array<{
    title: string;
    source_surface: string;
    drop_reason: string;
  }>;
  verification_criteria: string[];
}

export interface SurfaceCommentFinding {
  surface: string;
  severity_hint?: string;
  file?: string;
  line?: number;
  body: string;
  author: string;
  posted_at: string;
  comment_url: string;
  source_surface?: string;
  title?: string;
}

export interface SurfacesInput {
  pr: number;
  surface_count: number;
  finding_count: number;
  surfaces_present: string[];
  findings: SurfaceCommentFinding[];
}

interface RenderMeta {
  modelResolved: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  surfaceCount: number;
  surfacesPresent: string[];
  runUrl: string;
  delta?: ComputeDeltaResult;
}

// Build the prior-state + delta options for the active mode. Seed mode
// (incremental disabled) supplies a null prior state, no force-push, and empty
// dismissals/renames. Incremental mode fetches the prior state comment,
// force-push status, rename map, and dismissal commands.
//
// `incremental` is a parameter rather than a direct read of the module-level
// INCREMENTAL const so both modes are reachable in one process; main() passes
// INCREMENTAL, so behavior in the workflow is unchanged.
export function loadPriorContext(
  ts: string,
  runIdValue: string,
  incremental: boolean,
): { priorState: CoordinatorState | null; opts: ComputeDeltaOptions } {
  const base = {
    currentHeadSha: CURRENT_HEAD_SHA,
    currentRunId: runIdValue,
    currentRunUrl: RUN_URL,
    currentTs: ts,
    baseSha: BASE_SHA,
  };

  if (!incremental) {
    return {
      priorState: null,
      opts: { ...base, forcePushed: false, dismissalRecords: [], renameMap: new Map() },
    };
  }

  // Everything the incremental path needs is fetched with `gh` or `git`, and any
  // of those can fail (rate limit, a shallow checkout with no PR objects, a
  // deleted branch). This runs BEFORE the try/finally in main(), so an
  // unguarded throw here kills the job with no comment posted — and a dead run
  // on a non-required check reads exactly like a clean one. Degrade to seed mode
  // instead, loudly.
  try {
    const stateComment = fetchExistingStateComment();
    const priorState = parseStateComment(stateComment?.body ?? null);
    const forcePushed = detectForcePush(priorState?.last_head_sha, CURRENT_HEAD_SHA, runGit);
    const renameMap = readRenameMap();
    const comments = fetchIssueCommentsForDismissal();
    const prAuthor = fetchPrAuthor();
    const dismissalRecords = parseDismissalCommands(comments, prAuthor);
    return {
      priorState,
      opts: { ...base, forcePushed, dismissalRecords, renameMap },
    };
  } catch (e) {
    console.error(
      `[coordinator-state] incremental context unavailable, falling back to seed mode: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {
      priorState: null,
      opts: { ...base, forcePushed: false, dismissalRecords: [], renameMap: new Map() },
    };
  }
}

export function sourceFindingsFromSurfaces(input: SurfacesInput): SourceFinding[] {
  return input.findings.map((finding) => ({
    source_surface: finding.surface,
    severity: severityFromSurfaceFinding(finding),
    file: finding.file?.trim() || "PR comment",
    line: typeof finding.line === "number" && Number.isFinite(finding.line) ? finding.line : 1,
    title: titleFromSurfaceFinding(finding),
  }));
}

function severityFromSurfaceFinding(finding: SurfaceCommentFinding): FindingSeverity {
  const text = `${finding.severity_hint ?? ""}\n${finding.body}`;
  if (/\b(CRITICAL|ERROR|HIGH|BLOCK)\b/i.test(text)) return "CRITICAL";
  if (/\b(WARNING|WARN|MEDIUM|APPROVE_WITH_COMMENTS)\b/i.test(text)) return "WARNING";
  return "SUGGESTION";
}

function titleFromSurfaceFinding(finding: SurfaceCommentFinding): string {
  if (finding.title?.trim()) return finding.title.trim();
  const line = finding.body
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0 && !candidate.startsWith("<!--"));
  if (!line) return `${finding.surface} finding`;
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/[*_`]/g, "")
    .slice(0, 180)
    .trim();
}

export function surfacesForDelta(
  input: SurfacesInput,
  findings: StateFinding[],
  ts: string,
): SurfacesInput {
  const promptFindings: SurfaceCommentFinding[] = findings.map((finding) => ({
    surface: finding.source_surface,
    source_surface: finding.source_surface,
    severity_hint: finding.severity,
    file: finding.file,
    line: finding.line_at_last_seen,
    title: finding.title_original,
    body: `[${finding.id}] ${finding.title_original}`,
    author: "coordinator-state",
    posted_at: ts,
    comment_url: RUN_URL,
  }));
  const surfacesPresent = [...new Set(promptFindings.map((finding) => finding.surface))];
  return {
    ...input,
    surface_count: surfacesPresent.length,
    finding_count: promptFindings.length,
    surfaces_present: surfacesPresent,
    findings: promptFindings,
  };
}

// Bot login that authors all Actions-driven comments. Used as a positive
// allowlist when locating sticky coordinator comments: an attacker can otherwise
// pre-post a comment carrying our marker plus forged-but-schema-valid state JSON
// before our bot ever runs, and subsequent runs would read attacker payload as
// priorState. We ONLY trust the bot's own previous comments.
const BOT_LOGIN = "github-actions[bot]";

// Locate the bot-authored sticky comment carrying `marker`. The author allowlist
// is load-bearing — see BOT_LOGIN above. Shared by fetchExistingStateComment and
// postSticky so both sides agree on which comment is ours.
function findStickyByMarker(marker: string): { id: number; body: string } | null {
  const raw = execFileSync(
    "gh",
    [
      "api",
      `repos/${REPO}/issues/${PR}/comments`,
      "--paginate",
      "--jq",
      `[.[] | select(.body | contains("${marker}")) | select(.user.login == "${BOT_LOGIN}")] | .[0] // empty`,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ).trim();
  return parseStickyComment(raw);
}

// Parse the `gh api --jq` sticky-lookup output. Tolerates malformed JSON
// (partial flush, network blip, mixed stderr) by returning null — i.e. "no
// existing sticky", which makes postSticky POST a fresh comment and the state
// reader fall back to seed mode, rather than throwing on the hot post path and
// crashing the workflow with no degraded comment.
export function parseStickyComment(raw: string): { id: number; body: string } | null {
  if (!raw) return null;
  let parsed: { id?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(raw) as { id?: unknown; body?: unknown };
  } catch (e) {
    console.error(
      `[coordinator] parseStickyComment: malformed gh output, treating as no existing comment: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
  if (typeof parsed.id !== "number" || typeof parsed.body !== "string") return null;
  return { id: parsed.id, body: parsed.body };
}

export function fetchExistingStateComment(): { id: number; body: string } | null {
  // Parallel call: log non-bot authored comments carrying the marker as a
  // security event (a pre-poisoning attempt).
  try {
    const impostors = execFileSync(
      "gh",
      [
        "api",
        `repos/${REPO}/issues/${PR}/comments`,
        "--paginate",
        "--jq",
        `[.[] | select(.body | contains("${STATE_MARKER}")) | select(.user.login != "${BOT_LOGIN}") | {id, user: .user.login}]`,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ).trim();
    if (impostors && impostors !== "[]") {
      console.error(
        `[coordinator-security] non-bot comment(s) carrying STATE_MARKER detected (possible pre-poisoning): ${impostors}`,
      );
    }
  } catch (e) {
    console.error(`[coordinator-security] impostor scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return findStickyByMarker(STATE_MARKER);
}

export function fetchIssueCommentsForDismissal(): DismissalComment[] {
  // NDJSON pagination: `--paginate --jq '.[]'` emits one comment per line,
  // parsed independently — robust to pagination shape, and streamed rather than
  // buffering a whole-response array. Mirrors the fetch-surfaces.ts gh() pattern.
  const raw = execFileSync(
    "gh",
    ["api", `repos/${REPO}/issues/${PR}/comments?per_page=100`, "--paginate", "--jq", ".[]"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return parseDismissalNdjson(raw);
}

// Parse the NDJSON issue-comments stream into DismissalComment records.
// Malformed lines (partial flush, mixed stderr) are skipped rather than thrown —
// this runs BEFORE the model call on the incremental path, so an uncaught parse
// error would bypass the degraded-comment path and leave the workflow red with
// no PR comment.
export function parseDismissalNdjson(raw: string): DismissalComment[] {
  const comments: DismissalComment[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (e) {
      console.error(
        `[coordinator-dismissals] skipping malformed NDJSON line: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const comment = parsed as Record<string, unknown>;
    comments.push({
      body: stringField(comment, "body"),
      user: { login: userLogin(comment) },
      author_association: stringField(comment, "author_association"),
      created_at: stringField(comment, "created_at"),
    });
  }
  return comments;
}

function fetchPrAuthor(): string {
  return execFileSync("gh", ["api", `repos/${REPO}/pulls/${PR}`, "--jq", ".user.login"], {
    encoding: "utf8",
  }).trim();
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : "";
}

function userLogin(record: Record<string, unknown>): string {
  const user = record.user;
  if (typeof user !== "object" || user === null || Array.isArray(user)) return "";
  const login = (user as Record<string, unknown>).login;
  return typeof login === "string" ? login : "";
}

export function readRenameMap(): Map<string, string> {
  const renames = new Map<string, string>();
  // --end-of-options (git ≥2.24) before the revision range so a hypothetical
  // `-`-prefixed BASE_SHA can never be parsed as a flag. A bare `--` only
  // separates pathspecs, not revisions.
  const out = execFileSync(
    "git",
    ["diff", "--find-renames=80%", "--name-status", "--end-of-options", `${BASE_SHA}...HEAD`],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  for (const line of out.split("\n")) {
    const match = /^R\d+\t([^\t]+)\t(.+)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) renames.set(match[1], match[2]);
  }
  return renames;
}

export function runGit(args: string[]): { ok: boolean } {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function buildVerdictComment(out: CoordinatorOutput, meta: RenderMeta): string {
  // `?? []` for the reason call-reviewer.ts states above countAll(): a model may
  // legitimately return only `{verdict, summary_line}` — a clean APPROVE has
  // nothing to keep or drop, which makes the omission the LIKELIEST case, not an
  // edge one. Without these, valid JSON with a missing key threw a TypeError out
  // of main() and the run ended with no PR comment at all — failing harder than
  // malformed JSON, which has a graceful buildParseErrorComment path.
  const kept = out.findings_kept ?? [];
  const dropped = out.findings_dropped ?? [];
  const totalIn = kept.length + dropped.length;

  const keptTable =
    kept.length === 0
      ? "_No findings kept._"
      : [
          "| Severity | File | Finding | Source |",
          "|----------|------|---------|--------|",
          ...kept.map(
            (f) =>
              `| ${f.severity} | \`${f.file}\` | ${f.title} | ${f.source_surface} |`,
          ),
        ].join("\n");

  const droppedDetails =
    dropped.length === 0
      ? ""
      : `\n### Dropped findings (filtered)\n\n<details>\n<summary>Click to see the ${dropped.length} dropped findings</summary>\n\n${dropped.map((d) => `- \`[${d.drop_reason}]\` ${d.title} (from \`${d.source_surface}\`)`).join("\n")}\n\n</details>\n`;

  const criteriaList = out.verification_criteria ?? [];
  const criteria =
    criteriaList.length === 0
      ? ""
      : `\n### Verification criteria for the PR description\n\n\`\`\`markdown\n${criteriaList.map((c) => `- [ ] ${c}`).join("\n")}\n\`\`\`\n`;

  const runLink = meta.runUrl ? `[Run log](${meta.runUrl})` : "Run log unavailable";
  // The delta is always supplied; renderDeltaSection itself returns "" unless
  // incremental mode is on, so the stateless verdict body stays byte-identical.
  // Guard on the rendered string (not on delta presence) so the surrounding
  // blank lines are only added when there is a section to show.
  const renderedDelta = meta.delta ? renderDeltaSection(meta.delta, INCREMENTAL) : "";
  const deltaSection = renderedDelta ? `\n\n${renderedDelta}` : "";

  return `${MARKER}

## ${verdictEmoji(out.verdict)} Coordinator Judge — verdict: **${out.verdict}**

${out.summary_line}${deltaSection}

Reviewed **${totalIn}** findings across **${meta.surfaceCount}** surface(s) (${meta.surfacesPresent.join(", ")}) — **kept ${kept.length}, dropped ${dropped.length}**.

### Kept findings

${keptTable}
${droppedDetails}${criteria}
---

_Coordinator: \`${meta.modelResolved}\`. Tokens: ${meta.inputTokens} in / ${meta.outputTokens} out. Duration: ${(meta.durationMs / 1000).toFixed(1)}s. ${runLink}._
`;
}

export function buildIncrementalApproveComment(
  deltaResult: ComputeDeltaResult,
  meta: RenderMeta,
): string {
  const runLink = meta.runUrl ? `[Run log](${meta.runUrl})` : "Run log unavailable";
  return `${MARKER}

## ✅ Coordinator Judge — verdict: **APPROVE**

No newly introduced or carried-over open findings were present in the incremental input.

${renderDeltaSection(deltaResult, INCREMENTAL)}

Reviewed **0** findings across **${meta.surfaceCount}** surface(s) (${meta.surfacesPresent.join(", ")}) — **kept 0, dropped 0**.

---

_Coordinator: \`${meta.modelResolved}\`. Tokens: ${meta.inputTokens} in / ${meta.outputTokens} out. Duration: ${(meta.durationMs / 1000).toFixed(1)}s. ${runLink}._
`;
}

export function renderDeltaSection(deltaResult: ComputeDeltaResult, incremental: boolean): string {
  // Gate the whole delta surface on incremental mode. In seed mode the delta has
  // a populated newly_introduced bucket, so unconditional rendering would add a
  // "New findings" table to the stateless verdict comment. Both callers pass the
  // module-level INCREMENTAL; taking it as a parameter keeps this pure and lets
  // one test process exercise both modes.
  if (!incremental) return "";
  const rows: Array<[string, number, string]> = [
    ["Newly introduced", deltaResult.newly_introduced.length, "Listed in New findings below"],
    ["Carried over", deltaResult.carried_over.length, "Still open from a prior run"],
    ["Resolved", deltaResult.resolved.length, "Not re-listed; see prior verdict for context"],
    ["Dismissed", deltaResult.dismissed.length, "Not sent to the coordinator model"],
    ["Re-emerged", deltaResult.reemerged.length, "Previously dismissed and emitted again"],
  ];
  const table = [
    "State delta:",
    "",
    "| | Count | Notes |",
    "|---|---:|---|",
    ...rows.map(([label, count, notes]) => `| ${label} | ${count} | ${notes} |`),
  ].join("\n");

  const sections = [
    table,
    renderFindingTable("### New findings (this commit)", deltaResult.newly_introduced, false),
    renderFindingTable("### Carried over (still open)", deltaResult.carried_over, true),
    renderFindingDetails("resolved", deltaResult.resolved),
    renderFindingDetails("dismissed", deltaResult.dismissed),
    renderFindingDetails("re-emerged", deltaResult.reemerged),
  ].filter((section) => section.length > 0);

  return sections.join("\n\n");
}

function renderFindingTable(title: string, findings: StateFinding[], includeFirstSeen: boolean): string {
  if (findings.length === 0) return "";
  const header = includeFirstSeen
    ? "| ID | Severity | File | Finding | First seen |\n|---|---|---|---|---|"
    : "| ID | Severity | File | Finding |\n|---|---|---|---|";
  const rows = findings.map((finding) => {
    const file = `${finding.file}:${finding.line_at_last_seen}`;
    if (!includeFirstSeen) {
      return `| ${finding.id} | ${finding.severity} | \`${file}\` | ${finding.title_original} |`;
    }
    return `| ${finding.id} | ${finding.severity} | \`${file}\` | ${finding.title_original} | ${finding.first_seen_commit.slice(0, 7)} |`;
  });
  return [title, "", header, ...rows].join("\n");
}

function renderFindingDetails(label: string, findings: StateFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((finding) => {
    const reason = finding.dismissed_reason
      ? `: "${escapeForMarkdownVerdict(finding.dismissed_reason)}"`
      : "";
    const by = finding.dismissed_by ? ` by @${finding.dismissed_by}` : "";
    return `- \`${finding.id}\` ${finding.severity}: ${finding.title_original} in \`${finding.file}:${finding.line_at_last_seen}\`${by}${reason}`;
  });
  return `<details>\n<summary>${findings.length} ${label} finding(s)</summary>\n\n${lines.join("\n")}\n\n</details>`;
}

// Defense-in-depth render-time escape for dismissed_reason. Parse-time
// scrubbing already strips markers + fences, but the rendered markdown lives
// inside a <details> block — a stray </details> would break out visually, and
// any backtick that survived parse-time would corrupt the inline `code` runs.
// Caps length so a long reason doesn't dominate the verdict.
export function escapeForMarkdownVerdict(s: string): string {
  const truncated = s.length > 200 ? `${s.slice(0, 200)}…` : s;
  return truncated
    .replace(/```+/g, "'''")
    .replace(/<\/details>/gi, "\\</details\\>");
}

function buildDegradedComment(status: number, errExcerpt: string): string {
  return `${MARKER}

## ❌ Coordinator Judge — DEGRADED

The coordinator model call failed (HTTP ${status}).

Individual source-surface comments above remain authoritative. Manual review required.

\`\`\`
${errExcerpt}
\`\`\`
`;
}

function buildParseErrorComment(rawExcerpt: string): string {
  return `${MARKER}

## ❌ Coordinator Judge — PARSE_ERROR

The model returned a response that could not be parsed as JSON. Raw output (first 500 chars):

\`\`\`
${rawExcerpt}
\`\`\`

Individual source-surface comments above remain authoritative.
`;
}

function buildBudgetBlockedComment(chars: number): string {
  return `${MARKER}

## 🛑 Coordinator Judge — TOO_LARGE

Combined comment input was ${chars.toLocaleString()} chars (~${Math.round(chars / 4).toLocaleString()} tokens) — over the coordinator's 80K-token budget. This PR is too large for a single coordination pass.

Individual source-surface comments above remain authoritative.
`;
}

export function buildStateComment(state: CoordinatorState): string {
  return renderStateComment(fitStateForComment(state));
}

function renderStateComment(state: CoordinatorState): string {
  // DO NOT apply scrubSecrets() to the structured state JSON.
  // An earlier, broader token-shape heuristic matched 40-char hex commit SHAs
  // (last_head_sha, first_seen_commit, commits_reviewed[].sha, …). After a
  // round-trip, detectForcePush would run
  // `git merge-base --is-ancestor [REDACTED-TOKEN-SHAPE] <head>`, which always
  // fails — a blanket state reset on every run.
  // The state JSON is produced by THIS script; every field is one we wrote. The
  // single field with attacker-controlled content is `dismissed_reason`, which
  // is scrubbed at INSERTION time in parse-dismissals.ts. Future reviewer: do
  // NOT re-wrap this with scrubSecrets.
  const stateJson = JSON.stringify(state, null, 2);
  const runLink = state.last_run_url
    ? `[run ${state.last_run_id}](${state.last_run_url})`
    : `run ${state.last_run_id}`;
  return `${STATE_MARKER}

## 🧠 Coordinator State

Machine-readable state used by the next coordinator run to compute the delta. Do not hand-edit — \`/dismiss <id> <reason>\` instead.

- **Commits reviewed:** ${state.commits_reviewed.length}
- **Total findings ever seen:** ${state.counters.total_ever_seen} (${state.counters.open} open · ${state.counters.resolved} resolved · ${state.counters.dismissed} dismissed · ${state.counters.reemerged} re-emerged)
- **Last run:** ${runLink}
- **Last head SHA:** \`${state.last_head_sha.slice(0, 12)}\`

<details>
<summary>State JSON</summary>

\`\`\`json
${stateJson}
\`\`\`

</details>

---

_State written by ${runLink}. Schema v${state.schema_version}._
`;
}

function fitStateForComment(state: CoordinatorState): CoordinatorState {
  let working = cloneState(state);
  let body = renderStateComment(working);
  let droppedCommits = 0;
  let droppedFindings = 0;

  while (body.length > MAX_COMMENT_BODY && working.commits_reviewed.length > 1) {
    working = { ...working, commits_reviewed: working.commits_reviewed.slice(1) };
    droppedCommits += 1;
    body = renderStateComment(working);
  }

  // Drop closed (resolved/dismissed/permanently_dismissed) findings in batches,
  // re-rendering once per batch rather than once per drop — that avoids the
  // O((N+M)²) re-render of the whole JSON on each single removal.
  const CLOSED_STATUSES = ["resolved", "dismissed", "permanently_dismissed"];
  const DROP_BATCH = 8;
  while (body.length > MAX_COMMENT_BODY) {
    const dropSet = new Set<number>();
    for (let i = 0; i < working.findings.length && dropSet.size < DROP_BATCH; i += 1) {
      const finding = working.findings[i];
      if (finding && CLOSED_STATUSES.includes(finding.status)) dropSet.add(i);
    }
    if (dropSet.size === 0) break;
    working = withCounters({
      ...working,
      findings: working.findings.filter((_, i) => !dropSet.has(i)),
    });
    droppedFindings += dropSet.size;
    body = renderStateComment(working);
  }

  if (droppedCommits > 0 || droppedFindings > 0) {
    console.error(
      `[coordinator-state] truncated state comment: dropped_commits=${droppedCommits} dropped_findings=${droppedFindings}`,
    );
  }

  return working;
}

function cloneState(state: CoordinatorState): CoordinatorState {
  return {
    ...state,
    commits_reviewed: state.commits_reviewed.map((commit) => ({ ...commit })),
    findings: state.findings.map((finding) => ({ ...finding })),
    counters: { ...state.counters },
  };
}

// Wrap postComment in try/catch so failures during error-reporting paths don't
// mask the original failure in the run log.
async function safePostComment(body: string): Promise<void> {
  try {
    await postComment(body);
  } catch (e) {
    console.error(`[coordinator] postComment failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function safePostStateComment(body: string): Promise<void> {
  try {
    await postStateComment(body);
  } catch (e) {
    console.error(`[coordinator] postStateComment failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function postComment(body: string): Promise<void> {
  await postSticky(MARKER, body, "comment", "/tmp/coordinator-comment-body.md");
}

async function postStateComment(body: string): Promise<void> {
  await postSticky(STATE_MARKER, body, "state comment", "/tmp/coordinator-state-comment-body.md");
}

// Single sticky-upsert path for both the verdict and state comments. Locates the
// existing bot-authored comment via findStickyByMarker (the author allowlist is
// load-bearing) and PATCHes it, or POSTs a new one. Collapsing the two
// byte-identical posters removes a "fixed one, forgot the other" bug class.
export async function postSticky(
  marker: string,
  body: string,
  label: string,
  tmpPath: string,
): Promise<void> {
  const existing = findStickyByMarker(marker);
  writeFileSync(tmpPath, body);

  if (existing) {
    execFileSync(
      "gh",
      [
        "api",
        "-X",
        "PATCH",
        `repos/${REPO}/issues/comments/${existing.id}`,
        "-F",
        `body=@${tmpPath}`,
      ],
      { stdio: "inherit" },
    );
    console.error(`[coordinator] updated existing ${label} ${existing.id}`);
  } else {
    execFileSync(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `repos/${REPO}/issues/${PR}/comments`,
        "-F",
        `body=@${tmpPath}`,
      ],
      { stdio: "inherit" },
    );
    console.error(`[coordinator] posted new ${label} on PR #${PR}`);
  }
}
