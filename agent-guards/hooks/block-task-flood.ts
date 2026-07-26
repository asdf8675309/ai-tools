#!/usr/bin/env bun
/**
 * block-task-flood.ts — TaskCreated hook
 *
 * REQUIRES A HARNESS THAT EMITS `TaskCreated` (Claude Code builds with the
 * agent/task system). If yours does not, this hook simply never runs — it costs
 * nothing, but it also does nothing. Check before installing it.
 *
 * WHAT IT BLOCKS
 *   1. A task whose description is under 10 characters. A subagent given no
 *      brief will invent one.
 *   2. Task number N+1 in a session, default N = 50.
 *
 * WHAT IT ALLOWS
 *   Every task with a real description, up to the ceiling. The ceiling is high
 *   on purpose: it is a circuit breaker for runaway spawning, not a budget.
 *
 * THE FAILURE THAT MOTIVATED IT
 *   Delegation composes with itself. An agent that spawns subagents can spawn
 *   subagents that spawn subagents, and the growth is multiplicative while each
 *   individual decision to delegate looks sound. Nothing in the loop notices
 *   the total. A hard ceiling is the only thing that reliably ends it, and 50
 *   sits far enough above real work that hitting it IS the diagnosis.
 *
 * THE COUNTER IS PER SESSION, AND HOW IT KNOWS
 *   Keyed on session_id when the harness provides one, otherwise on the parent
 *   process id, which changes when the session does. A new session starts at
 *   zero; state lives in the OS temp directory and never accumulates.
 *
 * FAIL-OPEN ON OUR OWN BUGS, FAIL-CLOSED ON THE QUESTION ASKED
 *   Unreadable payload or internal crash: allow. Over the ceiling: block.
 *
 * BYPASS (announced on stderr, never silent)
 *   AGENT_GUARDS_TASK_FLOOD=0 disables it. AGENT_GUARDS_TASK_LIMIT=<n> raises
 *   or lowers the ceiling — prefer this over disabling, so a ceiling still
 *   exists. There is no inline token: the agent writes the task text, so a
 *   token in it would be a bypass the agent could invoke on its own.
 */

import { join } from 'node:path';
import { announceBypass, block, bypassReason, readState, readStdinJson, safeName, stateDir, writeState } from './lib/shared.ts';

const SLUG = 'task-flood';
const DEFAULT_LIMIT = 50;
const MIN_DESCRIPTION = 10;

interface Counter {
  key: string;
  count: number;
}

export function limit(): number {
  const raw = Number(process.env.AGENT_GUARDS_TASK_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_LIMIT;
}

/** Pure: the exact condition main() uses to block on a thin brief. */
export function tooShort(description: string): boolean {
  return description.trim().length < MIN_DESCRIPTION;
}

/** Pure: the exact condition main() uses to block past the ceiling. */
export function atOrOverCeiling(count: number, max: number): boolean {
  return count >= max;
}

/** `raw`, when passed, is forwarded to readStdinJson instead of real stdin —
 *  the same test-only seam readStdinJson itself exposes. Every production
 *  call site (below) omits it. */
export function main(raw?: string): void {
  const input = readStdinJson(raw);
  if (!input) return;

  const description = typeof input.task_description === 'string' ? input.task_description : '';
  const key = String(input.session_id ?? process.ppid);

  if (tooShort(description)) {
    const why = bypassReason(SLUG);
    if (why) return announceBypass(SLUG, why, `${description.trim().length}-character description`);

    block(SLUG, [
      `description length: ${description.trim().length} (minimum ${MIN_DESCRIPTION})`,
      '',
      'A subagent with no brief writes its own, and you will not find out which',
      'one it chose until you read the result. State the task.',
      '',
      'Bypass: AGENT_GUARDS_TASK_FLOOD=0',
    ]);
  }

  const file = join(stateDir('task-flood'), `${safeName(key)}.json`);
  const stored = readState<Counter>(file, { key, count: 0 });
  const count = stored.key === key && typeof stored.count === 'number' ? stored.count : 0;
  const max = limit();

  if (atOrOverCeiling(count, max)) {
    const why = bypassReason(SLUG);
    if (why) return announceBypass(SLUG, why, `task ${count + 1} past the ceiling of ${max}`);

    block(SLUG, [
      `this session has already created ${count} tasks (ceiling ${max})`,
      '',
      'Delegation compounds: each spawn looks locally reasonable while the total',
      'grows multiplicatively, and nothing inside the loop is watching the total.',
      'Hitting this ceiling is itself the finding — finish or cancel the open',
      'tasks rather than adding one.',
      '',
      'Bypass: AGENT_GUARDS_TASK_LIMIT=<n> to raise the ceiling (preferred — a',
      'higher ceiling is still a ceiling), or AGENT_GUARDS_TASK_FLOOD=0 to remove it.',
    ]);
  }

  writeState(file, { key, count: count + 1 });
}

if (import.meta.main) {
  try {
    main();
  } catch {
    // Fail-open on our OWN bugs; block() exits before reaching here.
  }
  process.exit(0);
}
