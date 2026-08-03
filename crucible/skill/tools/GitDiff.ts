/**
 * Crucible — shared git-diff plumbing for the skill's tools.
 *
 * Four tools each shelled out to `git diff` for the same three-dot range, and
 * the flags had already drifted between the copies — which matters, because
 * every flag here is load-bearing:
 *
 *   --end-of-options (git ≥2.24) so a `-`-prefixed ref can never be parsed as a
 *     flag. A bare `--` only separates pathspecs, not revisions: the array form
 *     stops a SHELL from seeing the ref, this stops GIT from doing so.
 *   --no-renames (opt-in) so a rename lands as delete(old)+add(new) on clean
 *     single-path lines. A classifier reading `code.ts => doc.md` would take the
 *     extension of the destination and call a code change a docs change. It is
 *     opt-in because the removal-ratio gate wants renames counted as renames.
 *   stdio stderr:"pipe" so git's own diagnostics do not land in a tool's stderr,
 *     which several callers treat as their machine-readable audit channel.
 *
 * Every function throws on git failure (missing base ref, not a repo). That is
 * deliberate: each caller's catch decides what failing closed means for it.
 */

import { execFileSync } from "child_process";

function gitDiff(cwd: string, args: string[], sinceRef: string): string {
  return execFileSync("git", ["diff", ...args, "--end-of-options", `${sinceRef}...HEAD`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The full unified diff for `<sinceRef>...HEAD`. */
export function unifiedDiff(cwd: string, sinceRef: string): string {
  return gitDiff(cwd, [], sinceRef);
}

/** The paths changed in `<sinceRef>...HEAD`, blank lines dropped. */
export function changedFiles(cwd: string, sinceRef: string, opts: { noRenames?: boolean } = {}): string[] {
  const out = gitDiff(cwd, opts.noRenames ? ["--name-only", "--no-renames"] : ["--name-only"], sinceRef);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface NumstatTotals {
  /** Changed paths, in diff order. Binary files are included. */
  files: string[];
  addedLoc: number;
  removedLoc: number;
}

/**
 * Per-file paths plus added/removed line totals from `git diff --numstat`.
 *
 * A binary file reports "-" instead of a count: it contributes 0 LOC but still
 * appears in `files`, so a classifier keying on extension still sees it.
 */
export function numstatTotals(cwd: string, sinceRef: string, opts: { noRenames?: boolean } = {}): NumstatTotals {
  const out = gitDiff(cwd, opts.noRenames ? ["--numstat", "--no-renames"] : ["--numstat"], sinceRef);
  const files: string[] = [];
  let addedLoc = 0;
  let removedLoc = 0;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    files.push(path);
    const a = Number.parseInt(added ?? "", 10);
    const r = Number.parseInt(removed ?? "", 10);
    if (Number.isFinite(a)) addedLoc += a; // binary "-" → NaN → skipped (0)
    if (Number.isFinite(r)) removedLoc += r;
  }
  return { files, addedLoc, removedLoc };
}
