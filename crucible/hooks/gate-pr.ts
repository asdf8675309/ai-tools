#!/usr/bin/env bun
/**
 * gate-pr.ts — PreToolUse hook on Bash (pairs with mark-review.ts)
 *
 * Blocks `gh pr create` (and `gh pr merge --auto`) for any GitHub-hosted
 * git repo when the current branch+commit has no matching review marker.
 * mark-review.ts (a Stop hook) writes that marker automatically once it
 * sees a genuine review in this session's own transcript — there is no way
 * to hand-author one.
 *
 * A provably inert diff (docs-only files, under a small line-count
 * ceiling) skips the gate entirely via LIGHT_PATH below, since there's
 * nothing risky to review.
 *
 * FAIL-CLOSED ON THE REVIEW QUESTION, FAIL-OPEN ON OUR OWN BUGS: if this
 * hook cannot positively confirm a review happened — no marker, a stale
 * marker, a corrupt/malformed marker — it blocks. That's the whole point of
 * a gate: "I don't know" has to mean "no." But a crash inside this script's
 * OWN logic, unreadable stdin, or a filesystem race must never permanently
 * wedge someone's ability to open a PR — every unexpected-error path below
 * falls through to allow, never to block. See the try/catch around
 * hookMain() at the bottom.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BYPASS_ENV_VAR,
  BYPASS_TOKEN,
  MARKER_TTL_MS,
  MIN_ROSTER,
  SENTINEL_FILE,
  WRITTEN_BY,
  getRepoContext,
  markerPath,
  readStdinJson,
  redactUrl,
  type RepoContext,
} from './lib/shared.ts';

const PR_TRIGGER_RE = /\bgh\s+pr\s+(create|merge\s+--auto\b)/;

// ── Light path: a diff this inert doesn't need a marker at all ──────────
// Deliberately narrow and hardcoded (not read from any config file an
// agent could edit) — this is the one place a false "light" verdict would
// let real code skip review, so it stays conservative on purpose.
const LIGHT_PATH_EXTENSIONS = new Set(['.md', '.txt', '.rst']);
const LIGHT_PATH_MAX_LOC = 1000;
// Docs that steer agent behavior aren't "inert" even though they're
// Markdown — CLAUDE.md/AGENTS.md/SKILL.md, anything under .claude/ or
// .github/, custom commands/agents. Changing these changes what an agent
// (including a reviewer) does, so they always force the full gate.
const BEHAVIOR_DOC_RE =
  /(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|(^|\/)SKILL\.md$|(^|\/)copilot-instructions\.md$|(^|\/)\.cursorrules$|(^|\/)\.claude\/|(^|\/)\.github\/|(^|\/)commands\/|(^|\/)agents\//i;

interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string };
  cwd?: string;
}

try {
  hookMain();
} catch (e) {
  // Fail-open on our OWN bugs — never let an internal crash in this hook
  // block a PR. A deliberate block always goes through block() below,
  // which exits directly and can't reach this catch.
  //
  // Announced, though: an allow that came from a crash is not an allow that
  // came from a marker, and a gate crashing on every invocation looks exactly
  // like a gate that keeps finding a valid review.
  console.error(
    `[crucible gate] internal error — allowing this PR ungated: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(0);
}

function hookMain(): void {
  if (process.env[BYPASS_ENV_VAR] === '1') {
    console.error(`[crucible gate] bypassed via ${BYPASS_ENV_VAR}=1`);
    process.exit(0);
  }

  const input = readStdinJson<HookInput>();
  if (input.tool_name !== 'Bash') process.exit(0);

  const cmd = (input.tool_input?.command ?? '').trim();
  if (!cmd || !PR_TRIGGER_RE.test(cmd)) process.exit(0);

  if (cmd.includes(BYPASS_TOKEN)) {
    console.error(`[crucible gate] bypassed via ${BYPASS_TOKEN} in the command`);
    process.exit(0);
  }

  const sessionCwd = input.cwd?.trim() || process.cwd();
  // `gh pr create` is often prefixed with an inline `cd` (e.g. a worktree
  // pattern: `cd /path/to/worktree && gh pr create ...`). input.cwd is the
  // SESSION cwd, not the post-cd directory — resolve the governing `cd` so
  // the gate inspects the branch+commit actually being PR'd.
  const cwd = resolveCommandCwd(cmd, sessionCwd);

  const ctx = getRepoContext(cwd);
  if (!ctx) process.exit(0); // not a git repo, or no GitHub origin — nothing to gate
  if (existsSync(`${ctx.toplevel}/${SENTINEL_FILE}`)) process.exit(0);

  // Light-path exit: a provably inert diff skips the marker check.
  try {
    const base = lightPathBase(cmd);
    if (base && cwdUnambiguous(cmd)) {
      execFileSync('git', ['fetch', 'origin', base, '--quiet'], {
        cwd,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const { files, addedLoc } = getDiffStat(cwd, 'FETCH_HEAD');
      if (isLightDiff(files, addedLoc)) {
        console.error(`[crucible gate] docs-only diff (${files.length} file(s), ${addedLoc} added LOC) — skipping the review gate`);
        process.exit(0);
      }
    }
  } catch (e) {
    // Any failure here (no network, unparseable base, ...) just falls
    // through to the marker check below — a diff we couldn't classify is
    // never treated as light. Named, so a docs-only PR that unexpectedly
    // hits the gate says why rather than reading as a broken light path.
    console.error(
      `[crucible gate] could not classify the diff — falling through to the marker check: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const path = markerPath(ctx.stateDir, ctx.branch, ctx.sha);
  if (!existsSync(path)) {
    block(ctx, 'no review marker for this branch+commit');
  }

  const ageMs = Date.now() - statSync(path).mtimeMs;
  if (ageMs > MARKER_TTL_MS) {
    block(ctx, `marker is ${Math.floor(ageMs / 60000)}m old (>${MARKER_TTL_MS / 60000}m TTL) — re-run the review`);
  }

  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as { written_by?: string; roster_count?: number };
    const valid = m.written_by === WRITTEN_BY && typeof m.roster_count === 'number' && m.roster_count >= MIN_ROSTER;
    if (!valid) block(ctx, 'marker is malformed or under-roster — re-run the review');
  } catch {
    block(ctx, 'marker file is unreadable/corrupt — re-run the review');
  }

  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────

function resolveCommandCwd(cmd: string, sessionCwd: string): string {
  const triggerIdx = cmd.search(PR_TRIGGER_RE);
  const head = triggerIdx >= 0 ? cmd.slice(0, triggerIdx) : cmd;
  const cdRe = /(?:^|&&|;|\|)\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  let target: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = cdRe.exec(head)) !== null) {
    target = m[1] ?? m[2] ?? m[3] ?? target;
  }
  if (!target) return sessionCwd;
  return isAbsolute(target) ? target : resolve(sessionCwd, target);
}

/** The base branch to classify against, or null when the light path must
 *  NOT apply. Only `gh pr create` is eligible — never `gh pr merge --auto`
 *  on an already-open PR. `--base`/`-B` present but unparseable → null
 *  (fail toward the marker gate) so a non-main target is never silently
 *  diffed against main. */
function lightPathBase(cmd: string): string | null {
  if (!/\bgh\s+pr\s+create\b/.test(cmd)) return null;
  const m = cmd.match(/(?:--base[=\s]+|(?:^|\s)-B\s+)("[^"]+"|'[^']+'|[^\s;&|]+)/);
  const captured = m?.[1];
  if (captured) return captured.replace(/^["']|["']$/g, '');
  if (/--base\b|(?:^|\s)-B\b/.test(cmd)) return null;
  return 'main';
}

/** True only when the governing cwd is unambiguous — no `;` sequencing, no
 *  `&` backgrounding, at most one `cd` before the trigger. Anything trickier
 *  could desync the classified repo from the one `gh` actually runs in, so
 *  we skip the light path (fall through to the marker gate) rather than
 *  risk classifying the wrong diff. */
function cwdUnambiguous(cmd: string): boolean {
  const idx = cmd.search(/\bgh\s+pr\s+create\b/);
  const head = idx >= 0 ? cmd.slice(0, idx) : cmd;
  if (/;/.test(head)) return false;
  if (/&(?!&)/.test(head)) return false;
  if ((head.match(/(?:^|&&|\s)cd\s/g) ?? []).length > 1) return false;
  return true;
}

interface DiffStat {
  files: string[];
  addedLoc: number;
}

function getDiffStat(cwd: string, base: string): DiffStat {
  const out = execFileSync('git', ['diff', '--numstat', '--no-renames', `${base}...HEAD`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const files: string[] = [];
  let addedLoc = 0;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [added, , ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    if (!path) continue;
    files.push(path);
    const n = Number.parseInt(added ?? '', 10);
    if (Number.isFinite(n)) addedLoc += n; // binary "-" → NaN → skipped (0)
  }
  return { files, addedLoc };
}

/** Deny-by-default: the diff is light only if EVERY file is an allow-listed
 *  extension (and not a behavior-steering doc) and total added LOC is under
 *  the ceiling. An empty diff is not "light" — there's nothing to bypass. */
function isLightDiff(files: string[], addedLoc: number): boolean {
  if (files.length === 0) return false;
  for (const f of files) {
    if (BEHAVIOR_DOC_RE.test(f)) return false;
    const ext = extname(f).toLowerCase();
    if (!ext || !LIGHT_PATH_EXTENSIONS.has(ext)) return false;
  }
  return addedLoc <= LIGHT_PATH_MAX_LOC;
}

function block(ctx: RepoContext, reason: string): never {
  const lines = [
    '',
    '════ CRUCIBLE REVIEW GATE — BLOCKED ════',
    `repo:   ${redactUrl(ctx.originUrl)}`,
    `branch: ${ctx.branch} @ ${ctx.sha}`,
    `reason: ${reason}`,
    '',
    "Run your review workflow for this branch+commit. The marker is written",
    'automatically by mark-review.ts once this session shows a genuine',
    'review (enough tagged reviewer dispatches) for this exact commit — you',
    'cannot hand-author it.',
    '',
    'Bypass options (in priority order):',
    `  1. env ${BYPASS_ENV_VAR}=1`,
    `  2. include ${BYPASS_TOKEN} in the gh command`,
    `  3. add a ${SENTINEL_FILE} sentinel file at the repo root (per-repo opt-out)`,
    '═════════════════════════════════════════',
    '',
  ];
  console.error(lines.join('\n'));
  process.exit(2);
}
