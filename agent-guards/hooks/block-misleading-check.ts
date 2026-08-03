#!/usr/bin/env bun
/**
 * block-misleading-check.ts — PreToolUse hook on Bash
 *
 * One family, three checks: block a verification command that would LIE TO YOU
 * — one that exits 0 while testing something other than what you think it
 * tested. A failing check is cheap; a check that passes without checking is
 * what actually ships bugs, because it ends the investigation.
 *
 * WHAT IT BLOCKS
 *   1. bare-tsc     `tsc --noEmit` with no -p/--project/-b/--build flag.
 *   2. cross-tree   a test/build/deploy about to run in a DIFFERENT working
 *                   tree of the same repo than the session is editing in.
 *   3. piped-check  a verification command piped into a pager/filter without
 *                   `set -o pipefail`.
 *
 * WHAT IT ALLOWS
 *   Everything else, untouched — including `npm run typecheck`, `tsc -b`,
 *   `tsc --noEmit -p tsconfig.json`, any command in the session's own tree,
 *   and any pipeline that is not a verification command or that sets pipefail.
 *   Non-Bash tools are never even parsed.
 *
 * THE FAILURES THAT MOTIVATED IT
 *   1. Bare `tsc --noEmit` resolves whatever tsconfig it finds by walking up
 *      from the cwd and IGNORES project references. In a repo whose CI runs
 *      `tsc -b` over a project graph, the bare form compiles a different set
 *      of files against a different lib/target — green locally, red in CI. It
 *      shipped a broken PR that "typechecked".
 *
 *      The audit that produced this guard is why it inspects the COMMAND and
 *      not the config. A package's tsconfig does not tell you what gets
 *      checked; the script that runs tsc does. Sweeping configs got it wrong in
 *      BOTH directions at once: packages flagged as unchecked were fully
 *      covered, because their script chained a second config the root one never
 *      mentioned — while one package had a perfectly correct second config that
 *      NOTHING INVOKED, so tens of thousands of lines went unchecked for months and every
 *      config-level review of it came back clean. The defect was one missing
 *      line in a script. Configuration describes intent; the invocation is what
 *      actually happens, so the invocation is what this guard reads.
 *   2. A verify command run in a sibling worktree tests UNCHANGED code, so the
 *      edits you just made are not what passed. The deploy version of this is
 *      worse: it ships the stale tree to production.
 *   3. `npm test | tail -5` reports TAIL's exit status, not the test runner's.
 *      A failing suite prints its failures and the shell says 0. This one has
 *      been caught twice in the wild, both times reading as a clean pass.
 *
 * FAIL-OPEN ON OUR OWN BUGS, FAIL-CLOSED ON THE QUESTION ASKED
 *   The bottom try/catch exits 0 on any internal error — a crash in here must
 *   never wedge your shell. But once a check has positively identified its
 *   pattern, it blocks; it does not shrug. Where a check genuinely cannot
 *   determine the answer (check 2 needs git, and a non-repo has no worktrees to
 *   confuse) the condition is absent rather than uncertain, so allowing is the
 *   correct reading, not a soft failure. See README.
 *
 * BYPASS (each announced on stderr, never silent)
 *   per check : AGENT_GUARDS_BARE_TSC=0 | AGENT_GUARDS_CROSS_TREE=0 |
 *               AGENT_GUARDS_PIPED_CHECK=0
 *   inline    : [skip-bare-tsc] | [skip-cross-tree] | [skip-piped-check]
 *   whole hook: AGENT_GUARDS_MISLEADING_CHECK=0   all guards: AGENT_GUARDS_OFF=1
 */

import { execFileSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import {
  announceBypass,
  bashCall,
  block,
  bypassReason,
  runHook,
  shellSegments,
  stripQuoted,
} from './lib/shared.ts';

const PARENT = 'misleading-check';

/** Bypass for a sub-check, falling back to the whole-hook switch. Exported so
 *  tests can verify the child-slug-first, parent-fallback precedence directly
 *  without risking a call into block()'s process.exit. */
export function standDown(slug: string, cmd: string): string | null {
  return bypassReason(slug, cmd) ?? bypassReason(PARENT, cmd);
}

// ── Check 1: bare `tsc --noEmit` ──────────────────────────────────────────

const BARE_TSC_RE =
  /(?:^|[\s;&|])(?:npx\s+|bunx\s+|pnpm\s+(?:exec\s+|dlx\s+)?|yarn\s+|\.?\/?node_modules\/\.bin\/)?tsc(?:\s+[^;&|]*?)?\s--noEmit\b/;
// Any of these means a project was chosen deliberately — that is the whole ask.
const PROJECT_FLAG_RE = /(?:^|\s)(?:-b\b|--build\b|-p\s+\S|--project[\s=]\S)/;

/**
 * Pure: the offending segment, or null. No bypass check, no exit — just the
 * judgement, so it is safe to call directly from a test.
 */
export function findBareTscSegment(command: string): string | null {
  if (!command.includes('tsc') || !command.includes('--noEmit')) return null;

  // Quoted text is data, not a command — `echo "run tsc --noEmit"` is a
  // sentence about a command. See stripQuoted for what that costs.
  for (const seg of shellSegments(stripQuoted(command))) {
    if (!BARE_TSC_RE.test(seg)) continue;
    if (PROJECT_FLAG_RE.test(seg)) continue;
    return seg;
  }
  return null;
}

function checkBareTsc(command: string): void {
  const seg = findBareTscSegment(command);
  if (seg !== null) {
    const why = standDown('bare-tsc', command);
    if (why) return announceBypass('bare-tsc', why, seg);

    block('bare-tsc', [
      `segment: ${seg}`,
      '',
      'Bare `tsc --noEmit` walks up for an ambient tsconfig and ignores project',
      'references, so it can compile a different file set against a different',
      'lib/target than your CI does. It passes while checking the wrong thing.',
      '',
      'Use one of:',
      '  npm run typecheck                    # whatever CI runs — the canonical answer',
      '  tsc -b                               # explicit build graph',
      '  tsc --noEmit -p tsconfig.json        # explicit project file',
      '',
      'Bypass: AGENT_GUARDS_BARE_TSC=0, or put [skip-bare-tsc] in the command.',
    ]);
  }
}

// ── Check 2: verify/deploy in the wrong working tree ──────────────────────

const VERIFY_RE =
  /\b((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|build|lint|deploy)\b|vitest\b|jest\b|tsc\b|pytest\b|go\s+test\b|cargo\s+test\b|wrangler\s+deploy\b|playwright\s+test\b)/;

export interface RepoCtx {
  topLevel: string;
  commonDir: string;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function repoCtx(dir: string): RepoCtx | null {
  try {
    return {
      topLevel: git(dir, 'rev-parse', '--show-toplevel'),
      // The COMMON dir is shared by every worktree of one repo — that is what
      // makes "same repo, different tree" detectable at all.
      commonDir: git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    };
  } catch {
    return null;
  }
}

/** Where the command will actually run, honouring a leading `cd`. Pure string
 *  work — exported so tests can probe the `cd`-resolution rules directly. */
export function effectiveRunDir(command: string, sessionCwd: string): string {
  const matches = [...command.matchAll(/\bcd\s+(?:-[^\s]+\s+)?(?:"([^"]+)"|'([^']+)'|([^\s&;|]+))/g)];
  const last = matches[matches.length - 1];
  if (!last) return sessionCwd;
  const path = last[1] ?? last[2] ?? last[3] ?? '';
  // An unexpanded variable is a path we cannot resolve — do not guess at one.
  if (!path || path.includes('$')) return sessionCwd;
  const expanded = path.startsWith('~') ? path.replace(/^~/, process.env.HOME ?? '') : path;
  return isAbsolute(expanded) ? expanded : resolve(sessionCwd, expanded);
}

export type WrongTreeVerdict =
  | { blocked: false }
  | { blocked: true; sessionTop: string; runTop: string };

/**
 * Pure: given the two already-resolved repo contexts, is this a cross-tree
 * verify? No git call, no bypass check, no exit — exported so the decision
 * (as opposed to the git plumbing that feeds it) can be unit-tested with
 * synthetic contexts. Null in either slot means "not detectable as a second
 * worktree", which this hook treats as allow, not as uncertain — see the
 * FAIL-OPEN header comment.
 */
export function evaluateWrongTree(session: RepoCtx | null, run: RepoCtx | null): WrongTreeVerdict {
  if (!session || !run) return { blocked: false };
  if (session.commonDir !== run.commonDir) return { blocked: false }; // different repo entirely — your call
  if (session.topLevel === run.topLevel) return { blocked: false }; // same tree — fine
  return { blocked: true, sessionTop: session.topLevel, runTop: run.topLevel };
}

function checkWrongTree(command: string, sessionCwd: string): void {
  if (!VERIFY_RE.test(command)) return;

  const session = repoCtx(sessionCwd);
  const run = repoCtx(effectiveRunDir(command, sessionCwd));
  const verdict = evaluateWrongTree(session, run);
  if (!verdict.blocked) return;

  const why = standDown('cross-tree', command);
  if (why) return announceBypass('cross-tree', why, `verify in ${verdict.runTop}`);

  block('cross-tree', [
    'A test/build/deploy is about to run in a DIFFERENT working tree of this repo',
    'than the session is editing. It would run against UNCHANGED code — and a',
    'wrong-tree deploy ships the stale tree to production.',
    '',
    `  session edits in : ${verdict.sessionTop}`,
    `  command runs in  : ${verdict.runTop}`,
    '',
    'Run it in the tree you are editing (drop the cross-tree `cd`).',
    'Bypass: AGENT_GUARDS_CROSS_TREE=0, or put [skip-cross-tree] in the command.',
  ]);
}

// ── Check 3: verification piped into a filter without pipefail ────────────

const PAGER_RE = /^\s*(tail|head|less|more|grep|rg|awk|sed|cut|sort|uniq|wc|jq)\b/;

export interface PipedCheckSegments {
  left: string;
  right: string;
}

/**
 * Pure: the first verify-command-piped-into-a-filter pair, or null. No
 * bypass check, no exit — just the judgement, so it is safe to call directly
 * from a test.
 */
export function findPipedCheckSegments(command: string): PipedCheckSegments | null {
  if (/set\s+-[a-zA-Z]*o\s+pipefail|set\s+-o\s+pipefail/.test(command)) return null;
  if (!command.includes('|')) return null;

  // Only real pipes. `||` is not a pipe, and a `|` inside quotes is data.
  const parts = stripQuoted(command).split(/(?<!\|)\|(?!\|)/);
  if (parts.length < 2) return null;

  for (let i = 0; i < parts.length - 1; i++) {
    const left = parts[i] ?? '';
    const right = parts[i + 1] ?? '';
    if (!VERIFY_RE.test(left)) continue;
    if (!PAGER_RE.test(right)) continue;
    return { left, right };
  }
  return null;
}

function checkPipedCheck(command: string): void {
  const found = findPipedCheckSegments(command);
  if (found !== null) {
    const { left, right } = found;
    const why = standDown('piped-check', command);
    if (why) return announceBypass('piped-check', why, `${left.trim()} | ${right.trim()}`);

    block('piped-check', [
      `pipeline: ${left.trim()} |${right}`,
      '',
      'A pipeline exits with the status of the LAST command, so this reports the',
      "filter's exit code, not the check's. A failing suite prints its failures",
      'and the shell still says 0 — the definitive false green.',
      '',
      'Use one of:',
      '  set -o pipefail; <cmd> | tail -40    # propagate the real status',
      '  <cmd> > /tmp/out.log 2>&1; echo "EXIT=$?"; tail -40 /tmp/out.log',
      '',
      'Bypass: AGENT_GUARDS_PIPED_CHECK=0, or put [skip-piped-check] in the command.',
    ]);
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────

/** `raw`, when passed, is forwarded to readStdinJson instead of real stdin —
 *  the same test-only seam readStdinJson itself exposes. Every production
 *  call site (below) omits it. */
export function main(raw?: string): void {
  const call = bashCall(raw);
  if (!call) return;
  const { input, cmd } = call;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();

  checkBareTsc(cmd);
  checkWrongTree(cmd, cwd);
  checkPipedCheck(cmd);
}

// Fail-open on our OWN bugs. A deliberate block() exits before reaching here.
if (import.meta.main) runHook(PARENT, main);
