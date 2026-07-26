#!/usr/bin/env bun
// Reads the sticky pre-PR-review comment and turns its SUGGESTION-severity rows
// into a tracking issue, so lower-severity findings survive the merge instead of
// scrolling off the PR.
//
// CRITICAL and WARNING findings are deliberately NOT collected: those are meant
// to be fixed in the PR, and filing them as follow-ups is how a blocking finding
// quietly becomes a backlog item.
//
// Inputs (when run as a script):
//   env COMMENT_BODY — the reviewer's sticky comment body
//   env PR_NUMBER    — PR the comment belongs to
// Output: GITHUB_OUTPUT keys `has_items`, `count`; issue body at /tmp/noted-items-body.md
//
// The pure functions are exported and unit-tested; only the bottom block, guarded
// by import.meta.main, touches the environment.

import { appendFileSync, writeFileSync } from "node:fs";

export interface NotedFinding {
  section: string;
  severity: string;
  file: string;
  text: string;
}

// Rows in the reviewer's comment look like:
//   | SUGGESTION | `path/to/file.ts:42` | Title — rationale |
const ROW = /^\|\s*(CRITICAL|WARNING|SUGGESTION)\s*\|\s*`?([^`|]*)`?\s*\|\s*(.*?)\s*\|\s*$/;
const SECTION = /^###\s+(.*?)\s*$/;

export function extractFindings(commentBody: string, severity = "SUGGESTION"): NotedFinding[] {
  const out: NotedFinding[] = [];
  let section = "";
  for (const line of commentBody.split("\n")) {
    const heading = SECTION.exec(line);
    if (heading?.[1] !== undefined) {
      section = heading[1];
      continue;
    }
    const row = ROW.exec(line);
    if (!row) continue;
    if (row[1] !== severity) continue;
    out.push({
      section,
      severity: row[1],
      file: (row[2] ?? "").trim(),
      text: (row[3] ?? "").trim(),
    });
  }
  return out;
}

// Everything in a finding is model-authored text derived from an
// attacker-influenceable diff, and it is about to be posted to a public issue.
// Two things have to be defanged, and neither is cosmetic:
//
//   1. `#123` — GitHub acts on `fixes #123` / `closes #123` ANYWHERE in an issue
//      or PR body, and it acts on the token, not the sentence. A finding whose
//      title happens to read "closes #400 without checking" would close issue
//      400. Breaking the `#`-to-digits token with an empty HTML comment defeats
//      the parser while still rendering as `#123` to a human.
//   2. `@name` — an unsanitized mention notifies a real person every time this
//      issue is edited.
//
// Control characters are stripped as well: they corrupt the markdown table and
// are the standard log/render-injection vector.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeForIssueBody(s: string): string {
  return s
    .replace(CONTROL_CHARS, "")
    .replace(/\|/g, "\\|")
    .replace(/#(\d)/g, "#<!-- -->$1")
    .replace(/@([A-Za-z0-9])/g, "@<!-- -->$1")
    .slice(0, 500);
}

export function issueTitle(pr: number, prefix = "review"): string {
  return `${prefix}: address noted items from pre-PR review (PR ${pr})`;
}

export function buildIssueBody(pr: number, findings: NotedFinding[], runUrl: string): string {
  const rows = findings
    .map(
      (f) =>
        `| ${sanitizeForIssueBody(f.section)} | ${sanitizeForIssueBody(f.file)} | ${sanitizeForIssueBody(f.text)} |`,
    )
    .join("\n");

  // Deliberately writes "PR <n>", never "#<n>": a bare `#<n>` here would be a
  // cross-link, and any closing keyword near it would act on it.
  return `## Context

- Source: PR ${pr}, pre-PR review
- Filed automatically because the review reported SUGGESTION-severity findings that were not blocking.

CRITICAL and WARNING findings are not listed here — those are expected to be resolved in the PR itself.

## Noted items

| Pass | File | Finding |
|------|------|---------|
${rows}

---

_Filed by the noted-items workflow. Run: ${runUrl || "unavailable"}_
`;
}

if (import.meta.main) {
  const body = process.env.COMMENT_BODY ?? "";
  const pr = Number(process.env.PR_NUMBER);
  const runUrl = process.env.RUN_URL ?? "";
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!pr) {
    console.error("PR_NUMBER required");
    process.exit(2);
  }

  const findings = extractFindings(body);
  const lines = [`has_items=${findings.length > 0}`, `count=${findings.length}`];
  if (outputPath) appendFileSync(outputPath, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));

  if (findings.length > 0) {
    writeFileSync("/tmp/noted-items-body.md", buildIssueBody(pr, findings, runUrl));
  }
  console.error(`[noted-items] ${findings.length} SUGGESTION finding(s) on PR ${pr}`);
}
