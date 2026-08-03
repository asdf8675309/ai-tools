#!/usr/bin/env bun
/**
 * block-public-repo.ts — PreToolUse hook on Bash
 *
 * WHAT IT BLOCKS
 *   Any command that would create a repository as public, or flip an existing
 *   one from private to public, through the GitHub CLI or the GitHub API:
 *     gh repo create … --public   |   --visibility public
 *     gh repo edit   … --public   |   --visibility=public
 *     gh api  …/repos…            visibility=public | private=false
 *     curl/wget … api.github.com  "visibility":"public" | "private":false
 *
 * WHAT IT ALLOWS
 *   Everything else. `--private` never matches. `gh repo view`, `gh repo
 *   clone`, `gh pr …`, and every unrelated command pass untouched, because
 *   every pattern below requires an explicit public / visibility-public /
 *   private-false flip. Reading a repo's visibility is not changing it.
 *
 * THE FAILURE THAT MOTIVATED IT
 *   Publishing is the one action in this whole surface with no undo. A repo
 *   that is public for ten seconds has been cloned, cached, and indexed; making
 *   it private again does not retract any of that. So this is not "an agent
 *   might do something surprising" — it is a one-way door, and one-way doors
 *   belong to the human, in the web UI, deliberately.
 *
 * WHY THIS IS TYPESCRIPT AND NOT THE THREE-LINE SHELL VERSION
 *   The original was a bash script that pulled the command out of the payload
 *   with `jq -r … 2>/dev/null`. On a machine without jq that produces an empty
 *   command, no match, and exit 0 — a guard silently doing nothing, with no
 *   way to notice. Reading the payload in the same runtime everything else here
 *   uses removes the one dependency whose absence disabled the guard.
 *
 * FAIL-OPEN ON OUR OWN BUGS, FAIL-CLOSED ON THE QUESTION ASKED
 *   An internal crash exits 0. But a command matching any pattern below blocks;
 *   there is no "probably fine" path.
 *
 * BYPASS (announced on stderr, never silent)
 *   AGENT_GUARDS_PUBLIC_REPO=0, or the inline token [skip-public-repo].
 *   Consider doing it in the GitHub UI instead — that is the point of the guard.
 */

import { announceBypass, announceFailOpen, block, bypassReason, commandOf, readStdinJson } from './lib/shared.ts';

const SLUG = 'public-repo';

export interface Rule {
  what: string;
  test: (cmd: string) => boolean;
}

const GH_REPO_WRITE = /gh\s+repo\s+(create|edit)\b/i;
const PUBLIC_FLAG = /--public\b|--visibility[\s=]+public\b/i;
const API_PUBLIC = /visibility["'\s=]+public|private["'\s=]+false/i;
const JSON_PUBLIC = /"visibility"\s*:\s*"public"|"private"\s*:\s*false|visibility=public|private=false/i;

const RULES: Rule[] = [
  {
    what: 'gh repo create/edit with a public visibility flag',
    test: (c) => GH_REPO_WRITE.test(c) && PUBLIC_FLAG.test(c),
  },
  {
    what: 'gh api call setting visibility=public or private=false',
    test: (c) => /gh\s+api\b/i.test(c) && API_PUBLIC.test(c),
  },
  {
    what: 'HTTP call to api.github.com setting visibility public / private false',
    test: (c) => /api\.github\.com/i.test(c) && JSON_PUBLIC.test(c),
  },
];

export type PublicRepoVerdict = { action: 'allow' } | { action: 'block'; rule: Rule };

/** Pure: which rule (if any) matches, first match wins — same order as RULES. */
export function evaluatePublicRepo(cmd: string): PublicRepoVerdict {
  for (const rule of RULES) {
    if (rule.test(cmd)) return { action: 'block', rule };
  }
  return { action: 'allow' };
}

/** `raw`, when passed, is forwarded to readStdinJson instead of real stdin —
 *  the same test-only seam readStdinJson itself exposes. Every production
 *  call site (below) omits it. */
export function main(raw?: string): void {
  const input = readStdinJson(raw);
  if (!input || input.tool_name !== 'Bash') return;
  const cmd = commandOf(input);
  if (!cmd) return;

  const verdict = evaluatePublicRepo(cmd);
  if (verdict.action === 'allow') return;

  const why = bypassReason(SLUG, cmd);
  if (why) return announceBypass(SLUG, why, verdict.rule.what);

  block(SLUG, [
    `matched: ${verdict.rule.what}`,
    '',
    'Making a repository public is a one-way door — once it is public it has',
    'been cloned, cached and indexed, and reverting does not take any of that',
    'back. Do it by hand in the GitHub UI, deliberately, or not at all.',
    '',
    'Create repositories with --private.',
    '',
    'Bypass: AGENT_GUARDS_PUBLIC_REPO=0, or put [skip-public-repo] in the command.',
  ]);
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    // Fail-open on our OWN bugs; block() exits before reaching here. Said out
    // loud, because a guard that has been crashing silently is not a guard.
    announceFailOpen(SLUG, e);
  }
  process.exit(0);
}
