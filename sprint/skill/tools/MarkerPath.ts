/**
 * Review-marker path derivation.
 *
 * Deliberately duplicated from crucible/hooks/lib/shared.ts rather than
 * imported: every tool directory in this repo stands alone. MarkerPath.test.ts
 * asserts the two stay byte-identical, so drift fails a test instead of
 * silently returning false forever.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function markerPath(stateDir: string, branch: string, sha: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(stateDir, `${safe}-${sha}.json`);
}

export interface MarkerContext {
  branch: string;
  sha: string;
  stateDir: string;
}

/** Null when cwd isn't a git repo with a GitHub origin — nothing to verify. */
export function getMarkerContext(cwd: string): MarkerContext | null {
  try {
    const commonDir = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const originUrl = git(cwd, "remote", "get-url", "origin");
    if (!originUrl.includes("github.com")) return null;
    const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
    const sha = git(cwd, "rev-parse", "HEAD").slice(0, 7);
    return { branch, sha, stateDir: join(commonDir, "crucible", "pre-pr-review") };
  } catch {
    return null;
  }
}
