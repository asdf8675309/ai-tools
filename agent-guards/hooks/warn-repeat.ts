#!/usr/bin/env bun
/**
 * warn-repeat.ts — UserPromptSubmit hook. NEVER BLOCKS.
 *
 * WHAT IT DOES
 *   Compares your new prompt to your previous one in the same session. If they
 *   are 60%+ similar by n-gram overlap, it injects one line of context saying
 *   so, because a user restating a request usually means the agent answered a
 *   different question than the one asked.
 *
 * WHAT IT DOES NOT DO
 *   Touch the prompt. It never blocks, never rewrites, never delays.
 *
 * THE FAILURE THAT MOTIVATED IT
 *   Intent drift is invisible from the inside. The agent has a coherent thread
 *   and keeps pulling it; the user has now asked twice and is watching the same
 *   wrong work continue. The user repeating themselves is the single most
 *   reliable signal that this has happened, and it is sitting right there in
 *   the input, unread.
 *
 * A REAL BUG IN THE ORIGINAL, FIXED HERE — worth knowing if you port it back
 *   The version this came from exited 2 on a match, with a comment saying
 *   "exit 2 = blocking error, stderr fed to the model". That is true of
 *   PreToolUse. On UserPromptSubmit, exit 2 ERASES THE USER'S PROMPT and shows
 *   the stderr to the user only — so a hook meant to make the agent re-read the
 *   request instead deleted the request, and the model never saw either. The
 *   detection was right and the exit code made it actively harmful. This
 *   version injects additionalContext, which is what the original wanted.
 *
 * ALSO SKIPPED: harness-injected events
 *   Background-task and system notifications arrive through this same hook and
 *   frequently differ by a few characters, so they score as near-duplicates.
 *   They are skipped AND not stored as the baseline, so the comparison stays
 *   anchored to the last real human message.
 *
 * FAIL-OPEN THROUGHOUT. STATE: one small JSON file in the OS temp directory.
 * BYPASS: AGENT_GUARDS_REPEAT=0, or AGENT_GUARDS_OFF=1.
 */

import { join } from 'node:path';
import { announceFailOpen, injectContext, readState, readStdinJson, safeName, stateDir, writeState } from './lib/shared.ts';

const THRESHOLD = 0.6;
const MIN_LENGTH = 20;

interface Saved {
  prompt: string;
  session: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Bigrams and trigrams together — short prompts have no trigrams at all. */
function grams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 2 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  for (let i = 0; i + 1 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

export function similarity(a: string, b: string): number {
  const ga = grams(tokenize(a));
  const gb = grams(tokenize(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  const union = ga.size + gb.size - shared;
  return union === 0 ? 0 : shared / union;
}

function isHarnessEvent(prompt: string): boolean {
  return (
    prompt.includes('<task-notification') ||
    prompt.includes('[SYSTEM NOTIFICATION') ||
    prompt.includes('<system-reminder>')
  );
}

/** `raw`, when passed, is forwarded to readStdinJson instead of real stdin —
 *  the same test-only seam readStdinJson itself exposes. Every production
 *  call site (below) omits it. */
export function main(raw?: string): void {
  if (process.env.AGENT_GUARDS_REPEAT === '0' || process.env.AGENT_GUARDS_OFF === '1') return;

  const input = readStdinJson(raw);
  if (!input) return;

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt || isHarnessEvent(prompt)) return;

  const session = String(input.session_id ?? 'unknown');
  const file = join(stateDir('repeat'), `${safeName(session)}.json`);
  const previous = readState<Saved>(file, { prompt: '', session: '' });

  writeState(file, { prompt, session });

  if (prompt.length < MIN_LENGTH) return; // ack, rating, greeting
  if (previous.session !== session || !previous.prompt) return;

  const score = similarity(prompt, previous.prompt);
  if (score < THRESHOLD) return;

  injectContext(
    'UserPromptSubmit',
    `[REPEATED REQUEST] This message is ${Math.round(score * 100)}% similar to the user's previous one. ` +
      `That usually means the previous answer addressed a different question than the one asked. ` +
      `Stop and re-read what they actually wrote before continuing the current thread — do not simply resume it.`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (e) {
    // Fail-open. Never let this hook stand between a user and their prompt —
    // but report the crash, or it looks like the hook simply had nothing to say.
    announceFailOpen('repeat', e);
  }
  process.exit(0);
}
