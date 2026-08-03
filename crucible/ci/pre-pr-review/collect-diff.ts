#!/usr/bin/env bun
// Collects the PR diff + full file context (within size budget) for the reviewer
// prompt. Copied to /tmp from a trusted checkout of the default branch and run
// against the PR-head worktree.
//
// Inputs:
//   env BASE_SHA — base ref to diff against (default: origin/main)
// Outputs:
//   /tmp/pr-diff.txt   — raw `git diff BASE_SHA...HEAD` output
//   /tmp/pr-files.json — { files: [{path, content, truncated}...], totalChars }
//
// SECURITY: file contents are treated as untrusted data. No eval, no shell
// interpolation, no execution. Oversize files become diff-only stubs so a
// hostile mega-file can't blow past the combined context budget.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";

const BASE_SHA = process.env.BASE_SHA ?? "origin/main";

// Per-file limit (full text included only if the file is under this size).
const FILE_BYTES_LIMIT = 50_000;     // ~12K tokens at 4 char/tok
// Combined context budget — stop accumulating files once we hit this.
const TOTAL_CONTEXT_LIMIT = 300_000; // ~75K tokens — headroom under a 200K ctx

// Three-dot: diff HEAD against the MERGE BASE, which is what GitHub shows for
// the PR. Two-dot would fold in everything the base branch gained since the
// branch diverged, so a behind branch would be reviewed as if it authored the
// base branch's commits. The workflow must therefore fetch the base branch
// WITHOUT --depth=1 — a shallow fetch never brings the merge base and this
// command dies with "no merge base".
// `--end-of-options` so a BASE_SHA that starts with a dash is a bad revision
// rather than a git option — `--output=<path>` there would write a file.
const diff = execFileSync("git", ["diff", "--end-of-options", `${BASE_SHA}...HEAD`], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const namesRaw = execFileSync(
  "git",
  ["diff", "--name-only", "--end-of-options", `${BASE_SHA}...HEAD`],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const names = namesRaw.split("\n").map((s) => s.trim()).filter(Boolean);

interface CollectedFile {
  path: string;
  content: string;
  truncated: boolean;
  truncatedReason?: string;
}

const files: CollectedFile[] = [];
let totalChars = diff.length;

// Alphabetical sort for a stable subset on truncation (deterministic, so the
// same PR produces the same prompt).
for (const name of [...names].sort()) {
  if (totalChars >= TOTAL_CONTEXT_LIMIT) break;
  let content = "";
  let truncated = false;
  let truncatedReason: string | undefined;
  try {
    const size = statSync(name).size;
    if (size > FILE_BYTES_LIMIT) {
      // Oversize file — diff already covers the change; skip full content.
      truncated = true;
      truncatedReason = `oversize: ${size} > ${FILE_BYTES_LIMIT} bytes`;
    } else {
      content = readFileSync(name, "utf8");
    }
  } catch (e) {
    // Narrow the catch rather than swallowing every error:
    //   - ENOENT  → deleted file, diff already covers it; skip silently.
    //   - Anything else (EISDIR submodule, EACCES, ELOOP, EBADF, …) →
    //     log to stderr and emit a truncated stub with a typed reason so the
    //     model knows context is missing rather than silently absent.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      continue;
    }
    console.error(
      `[collect-diff] non-deleted error reading ${name}: ${code ?? "UNKNOWN"} — ${e instanceof Error ? e.message : String(e)}`,
    );
    truncated = true;
    truncatedReason = `error: ${code ?? "UNKNOWN"}`;
  }
  totalChars += content.length;
  files.push({
    path: name,
    content,
    truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
  });
}

writeFileSync("/tmp/pr-diff.txt", diff);
writeFileSync(
  "/tmp/pr-files.json",
  JSON.stringify({ files, totalChars }, null, 2),
);

console.error(
  `[collect-diff] ${names.length} files, ${diff.length} char diff, ${totalChars} char total context`,
);
