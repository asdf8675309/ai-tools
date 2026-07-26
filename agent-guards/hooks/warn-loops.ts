#!/usr/bin/env bun
/**
 * warn-loops.ts — PostToolUse hook (all tools). NEVER BLOCKS.
 *
 * WHAT IT DOES
 *   Watches a rolling window of this session's tool calls and injects one line
 *   of context when the trajectory has degenerated. Three shapes:
 *     exact repeat  the same tool, same input, 3+ times
 *     oscillation   a-b-a-b between two calls
 *     hammering     one tool 5+ times in the last 8 calls, 3+ of them failing
 *
 * WHAT IT DOES NOT DO
 *   Block anything, ever. It emits additionalContext and exits 0. A loop is a
 *   judgement call — sometimes the fourth identical read really is right — so
 *   the correct intervention is information, not a wall.
 *
 * THE FAILURE THAT MOTIVATED IT
 *   The most expensive agent failure is not a wrong action, it is the same
 *   wrong action forty times. From the inside each retry looks locally
 *   reasonable, because nothing in the context says "you already tried this".
 *   Saying it out loud, once, is usually enough to break out.
 *
 * ONE ALERT PER EPISODE
 *   Each detected loop is keyed and recorded, plus a cooldown of 4 calls
 *   between any two alerts. A nudge that fires on every call is noise, and
 *   noise is indistinguishable from no guard at all.
 *
 * FAIL-OPEN THROUGHOUT
 *   Every path exits 0. There is no question here that warrants failing closed:
 *   the worst case of getting this wrong is a missing hint.
 *
 * STATE
 *   A per-session JSON file under the OS temp directory. Nothing durable,
 *   nothing in your project, nothing in your home config.
 *
 * BYPASS: AGENT_GUARDS_LOOPS=0, or AGENT_GUARDS_OFF=1.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  injectContext,
  readState,
  readStdinJson,
  safeName,
  stateDir,
  wrapUntrusted,
  writeState,
  type HookInput,
} from './lib/shared.ts';

const WINDOW = 20;
const COOLDOWN = 4;

export interface Entry {
  sig: string;
  tool: string;
  failed: boolean;
}
export interface State {
  window: Entry[];
  alerted: string[];
  seq: number;
  lastAlert: number;
}
interface Detection {
  key: string;
  message: string;
}

/** Exported with step(): a caller driving the state machine needs the starting
 *  value and its type, and hand-rolling the literal infers `never[]` fields. */
export const EMPTY: State = { window: [], alerted: [], seq: 0, lastAlert: 0 };

function signature(input: HookInput): string {
  const tool = input.tool_name || 'unknown';
  return `${tool}:${createHash('sha256').update(JSON.stringify(input.tool_input ?? {})).digest('hex')}`;
}

/**
 * The looping call's own input, echoed back so the nudge is actionable.
 *
 * Wrapped as untrusted even though the model authored it: this string lands
 * inside a message the model reads as system context, and a tool input that
 * contains text shaped like a directive would otherwise be laundered into that
 * trusted frame by this hook. wrapUntrusted strips the delimiter before
 * wrapping, so the quoted region cannot be closed early from inside.
 */
function summarize(input: unknown): string {
  const compact = JSON.stringify(input ?? {}).replace(/\s+/g, ' ');
  return wrapUntrusted(compact.length > 120 ? `${compact.slice(0, 117)}...` : compact);
}

function detectExactRepeat(state: State, input: HookInput): Detection | null {
  const sig = signature(input);
  const n = state.window.filter((e) => e.sig === sig).length;
  if (n < 3) return null;
  return {
    key: `exact:${sig}`,
    message: `[LOOP] ${input.tool_name ?? 'a tool'} has now been called ${n} times with identical input this session. Repeating an identical call cannot produce new information. Change the input, change the approach, or say what is blocking you. Last input: ${summarize(input.tool_input)}`,
  };
}

function detectOscillation(state: State): Detection | null {
  if (state.window.length < 4) return null;
  const last = state.window.slice(-4);
  const a = last[0]!.sig;
  const b = last[1]!.sig;
  if (a === b) return null;
  if (!last.every((e, i) => e.sig === (i % 2 === 0 ? a : b))) return null;
  return {
    key: `osc:${a}|${b}`,
    message: `[LOOP] Flip-flopping between ${last[0]!.tool} and ${last[1]!.tool} (a-b-a-b) with no progress between them. Two alternatives are being retried against each other; pick one and find out why it fails.`,
  };
}

function detectHammering(state: State): Detection | null {
  const byTool = new Map<string, Entry[]>();
  for (const e of state.window.slice(-8)) byTool.set(e.tool, [...(byTool.get(e.tool) ?? []), e]);
  for (const [tool, entries] of byTool) {
    const failed = entries.filter((e) => e.failed).length;
    if (entries.length >= 5 && failed >= 3) {
      return {
        key: `hammer:${tool}`,
        message: `[LOOP] ${tool} was called ${entries.length} times in quick succession and ${failed} of those failed. The failures are the signal — read one properly before the next attempt.`,
      };
    }
  }
  return null;
}

/** Pure: advance the window, return the message to inject (or null). */
export function step(state: State, input: HookInput): { state: State; message: string | null } {
  const next: State = {
    window: [
      ...state.window,
      { sig: signature(input), tool: input.tool_name || 'unknown', failed: String(input.error ?? '').trim().length > 0 },
    ].slice(-WINDOW),
    alerted: [...state.alerted],
    seq: state.seq + 1,
    lastAlert: state.lastAlert,
  };

  let detection: Detection | null = null;
  for (const d of [detectOscillation(next), detectExactRepeat(next, input), detectHammering(next)]) {
    if (d && !next.alerted.includes(d.key)) {
      detection = d;
      break;
    }
  }
  if (detection && next.lastAlert > 0 && next.seq - next.lastAlert < COOLDOWN) detection = null;
  if (detection) {
    next.alerted.push(detection.key);
    next.lastAlert = next.seq;
  }
  return { state: next, message: detection?.message ?? null };
}

/** `raw`, when passed, is forwarded to readStdinJson instead of real stdin —
 *  the same test-only seam readStdinJson itself exposes. Every production
 *  call site (below) omits it. */
export function main(raw?: string): void {
  if (process.env.AGENT_GUARDS_LOOPS === '0' || process.env.AGENT_GUARDS_OFF === '1') return;

  const input = readStdinJson(raw);
  if (!input || !input.tool_name) return;

  const file = join(stateDir('loops'), `${safeName(input.session_id)}.json`);
  const current = readState<State>(file, EMPTY);
  const { state, message } = step(
    {
      window: Array.isArray(current.window) ? current.window : [],
      alerted: Array.isArray(current.alerted) ? current.alerted : [],
      seq: typeof current.seq === 'number' ? current.seq : 0,
      lastAlert: typeof current.lastAlert === 'number' ? current.lastAlert : 0,
    },
    input,
  );
  writeState(file, state);
  if (message) injectContext('PostToolUse', message);
}

if (import.meta.main) {
  try {
    main();
  } catch {
    // Fail-open. The worst case of a bug here is a missing hint.
  }
  process.exit(0);
}
