/**
 * Shared helpers + constants for the Crucible review-gate hook pair —
 * mark-review.ts (writer) and gate-pr.ts (gate). Kept together so the two
 * can't drift out of sync on what counts as "enough review" (they must
 * agree on MIN_ROSTER and WRITTEN_BY, or the gate will reject markers the
 * writer considers valid, or vice versa).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimum distinct `Crucible-Reviewer: <name>` tags required for a marker
 *  to count as a real review. Default of 6 assumes the Crucible skill's
 *  FullReview workflow (10 reviewer lenses) as the thing being certified —
 *  override with CRUCIBLE_MIN_ROSTER, or edit the default, to match a
 *  different workflow or a review process of your own. */
export const MIN_ROSTER = Number(process.env.CRUCIBLE_MIN_ROSTER ?? 6);

/** Minimum tool_use blocks a subagent transcript must show before its prose is
 *  accepted as review evidence. Text alone is something a model can author;
 *  tool calls are work it actually did. Not forgery-proof — see
 *  hooks/README.md § Limits — but it removes the free path. */
export const MIN_SUBAGENT_TOOL_CALLS = Number(process.env.CRUCIBLE_MIN_SUBAGENT_TOOL_CALLS ?? 5);

/** Drop this file at a repo's root to opt that repo out of the gate entirely. */
export const SENTINEL_FILE = '.no-crucible-review';

/** Inline bypass: include this literal token anywhere in the `gh pr create` command. */
export const BYPASS_TOKEN = '[skip-crucible-review]';

/** Env-var bypass, checked first — see gate-pr.ts. */
export const BYPASS_ENV_VAR = 'CRUCIBLE_REVIEW_BYPASS';

/** Marker files older than this are treated as stale — re-run the review. */
export const MARKER_TTL_MS = 30 * 60 * 1000;

/** Written into every marker's `written_by` field; the gate checks for this
 *  exact value so a hand-crafted JSON file can never pass as a real marker. */
export const WRITTEN_BY = 'crucible-mark-review';

/** Tag a sub-agent review dispatch's prompt/description with this so the
 *  writer can find it — see the README for the full convention. */
export const TAG_RE = /Crucible-Reviewer:\s*([a-zA-Z0-9_-]+)/gi;

const DEFAULT_BRANCHES = new Set(['main', 'master']);

export interface RepoContext {
  toplevel: string;
  originUrl: string;
  branch: string;
  sha: string;
  /** Where marker state for this repo lives — inside its shared .git dir,
   *  so worktrees of the same repo see the same markers. */
  stateDir: string;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Resolve repo identity for `cwd`. Returns null when it isn't inside a git
 * repo with a GitHub `origin` remote — both hooks treat that as "nothing to
 * gate" and no-op.
 */
export function getRepoContext(cwd: string): RepoContext | null {
  let toplevel: string;
  let commonDir: string;
  let originUrl: string;
  let branch: string;
  let sha: string;
  try {
    toplevel = git(cwd, 'rev-parse', '--show-toplevel');
    commonDir = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    originUrl = git(cwd, 'remote', 'get-url', 'origin');
    if (!originUrl.includes('github.com')) return null;
    branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
    sha = git(cwd, 'rev-parse', 'HEAD').slice(0, 7);
  } catch {
    return null;
  }
  const stateDir = join(commonDir, 'crucible', 'pre-pr-review');
  return { toplevel, originUrl, branch, sha, stateDir };
}

export function isDefaultBranch(branch: string): boolean {
  return DEFAULT_BRANCHES.has(branch);
}

export function headCommitTime(cwd: string): number | null {
  try {
    const iso = git(cwd, 'log', '-1', '--format=%cI', 'HEAD');
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function markerPath(stateDir: string, branch: string, sha: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(stateDir, `${safe}-${sha}.json`);
}

/** Strip userinfo (user:token@) from a remote URL before it hits stderr/logs. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//');
}

/** Read + JSON.parse this process's stdin. Never throws — returns {} on any
 *  failure, so callers can't be crashed by a hook harness sending odd input. */
export function readStdinJson<T>(): T {
  try {
    const raw = readFileSync('/dev/stdin', 'utf8');
    if (!raw.trim()) return {} as T;
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}
