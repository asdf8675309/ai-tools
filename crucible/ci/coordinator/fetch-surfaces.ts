#!/usr/bin/env bun
// Runs in place from the workflow's trusted default-branch checkout — never
// from the PR tree. Fetches all comments on a PR and normalizes them into the
// SurfaceFinding shape the coordinator prompt expects. Emits JSON to stdout,
// log to stderr.
//
// SECURITY: comment bodies are treated as untrusted input. We do not eval, do
// not shell-interpolate, and do not parse any structure beyond known markers.

import { execFileSync } from "node:child_process";

// ADOPTERS: add a row per review surface you run. The key is a literal string
// searched for in the comment body — an HTML marker comment is the sturdiest
// choice because it survives markdown rendering and never occurs in prose. Order
// matters only in that the first match wins.
const SURFACE_MARKERS: ReadonlyArray<readonly [marker: string, surface: string]> = [
  ["<!-- semgrep-sast-comment -->", "semgrep"],
  ["<!-- dependency-audit-comment -->", "dependency-audit"],
  ["<!-- crucible -->", "crucible"],
];

// Surfaces detected by a header regex rather than a marker, for tools whose
// output shape you do not control.
const SURFACE_HEADERS: ReadonlyArray<readonly [pattern: RegExp, surface: string]> = [
  [/^## Crucible Review/m, "crucible"],
  // The pre-pr-review workflow's own detector. Renaming this header there
  // without changing it here silently drops the surface — its own test suite
  // asserts the header exists for that reason.
  [/^## Pre-PR Review:/m, "pre-pr-review"],
];

interface SurfaceFinding {
  surface: string;
  severity_hint?: string;
  file?: string;
  line?: number;
  body: string;
  author: string;
  posted_at: string;
  comment_url: string;
}

const PR = Number(process.env.PR_NUMBER);
const REPO = process.env.GH_REPO;
if (!PR) {
  console.error("PR_NUMBER required");
  process.exit(2);
}
if (!REPO) {
  console.error("GH_REPO required (owner/repo)");
  process.exit(2);
}

// SURFACE_INPUT delimiter tokens — must be stripped from any field that lands in
// the LLM prompt as `body`. The coordinator prompt wraps comment data in these
// tags as structural boundaries; an attacker who controls a PR comment could
// otherwise forge the closing tag and break out of the data envelope.
const DELIMITERS = ["<!-- SURFACE_INPUT -->", "<!-- /SURFACE_INPUT -->"];

function scrubDelimiters(s: string): string {
  let out = s;
  for (const d of DELIMITERS) out = out.split(d).join("[redacted-delimiter]");
  return out;
}

function gh<T>(path: string): T[] {
  // `gh api --paginate` concatenates per-page outputs and is NOT guaranteed to
  // produce a single valid JSON array for all endpoints. Use `--jq '.[]'` to
  // emit one record per line (NDJSON) and parse each line independently —
  // robust to any pagination shape.
  const out = execFileSync(
    "gh",
    ["api", `repos/${REPO}/${path}`, "--paginate", "--jq", ".[]"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function detect(body: string, author: string): string {
  // Self-skip: the coordinator's own markers — never treat our own output as a
  // finding, or every run compounds the last one's verdict.
  if (body.includes("<!-- coordinator-judge -->")) return "unknown";
  if (body.includes("<!-- coordinator-state -->")) return "unknown";

  for (const [marker, surface] of SURFACE_MARKERS) {
    if (body.includes(marker)) return surface;
  }
  for (const [pattern, surface] of SURFACE_HEADERS) {
    if (pattern.test(body)) return surface;
  }

  // GitHub's built-in review bot — author check, because its login varies.
  if (author === "Copilot" || author.startsWith("copilot-pull-request-reviewer")) {
    return "copilot-builtin";
  }

  return "unknown";
}

interface RawComment {
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
  path?: string;
  line?: number | null;
}

interface RawReview {
  body: string | null;
  user: { login: string };
  state: string;
  submitted_at: string;
  html_url: string;
}

const issueComments = gh<RawComment>(`issues/${PR}/comments?per_page=100`);
const reviewComments = gh<RawComment>(`pulls/${PR}/comments?per_page=100`);
const reviews = gh<RawReview>(`pulls/${PR}/reviews?per_page=100`);

const findings: SurfaceFinding[] = [];

for (const c of issueComments) {
  const surface = detect(c.body, c.user.login);
  if (surface === "unknown") continue;
  findings.push({
    surface,
    body: scrubDelimiters(c.body),
    author: c.user.login,
    posted_at: c.created_at,
    comment_url: c.html_url,
  });
}

for (const c of reviewComments) {
  const surface = detect(c.body, c.user.login);
  if (surface === "unknown") continue;
  findings.push({
    surface,
    body: scrubDelimiters(c.body),
    author: c.user.login,
    file: c.path,
    line: c.line ?? undefined,
    posted_at: c.created_at,
    comment_url: c.html_url,
  });
}

for (const r of reviews) {
  if (!r.body) continue;
  const surface = detect(r.body, r.user.login);
  if (surface === "unknown") continue;
  findings.push({
    surface,
    body: scrubDelimiters(r.body),
    author: r.user.login,
    severity_hint: r.state,
    posted_at: r.submitted_at,
    comment_url: r.html_url,
  });
}

const surfacesPresent = new Set(findings.map((f) => f.surface));

console.error(
  `[fetch-surfaces] PR #${PR}: ${findings.length} comments across ${surfacesPresent.size} surfaces: ${[...surfacesPresent].join(", ")}`,
);

process.stdout.write(
  JSON.stringify(
    {
      pr: PR,
      surfaces_present: [...surfacesPresent],
      surface_count: surfacesPresent.size,
      finding_count: findings.length,
      findings,
    },
    null,
    2,
  ),
);
