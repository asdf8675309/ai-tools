/**
 * warn-loops.test.ts — in-process unit tests for hooks/warn-loops.ts.
 *
 * `step()` is already an exported pure state machine (state in, {state,
 * message} out), so no refactor was needed. Never blocks — the SILENT vs
 * WARNS pair is what stands in for allow/block here, plus the
 * once-per-episode + cooldown behavior that keeps a real nudge from becoming
 * noise.
 */

import { describe, expect, test } from 'bun:test';
import { EMPTY, main, step } from '../hooks/warn-loops.ts';
import type { HookInput } from '../hooks/lib/shared.ts';
import { withExitSpy } from './lib/exit-spy.ts';

function call(tool: string, input: Record<string, unknown>, error?: string): HookInput {
  return { tool_name: tool, tool_input: input, ...(error ? { error } : {}) };
}

describe('step: silent cases', () => {
  test('silent on a single call', () => {
    const { message } = step(EMPTY, call('Read', { file_path: '/a.ts' }));
    expect(message).toBeNull();
  });

  test('silent on two identical calls — three is the floor', () => {
    let state = EMPTY;
    for (let i = 0; i < 2; i++) {
      const r = step(state, call('Read', { file_path: '/a.ts' }));
      state = r.state;
    }
    expect(state.window.length).toBe(2);
    const { message } = step(state, call('Bash', { command: 'ls' })); // a third, DIFFERENT call
    expect(message).toBeNull();
  });

  test('silent on distinct calls to the same tool with different input', () => {
    let state = EMPTY;
    for (const p of ['/a.ts', '/b.ts', '/c.ts']) {
      const r = step(state, call('Read', { file_path: p }));
      state = r.state;
    }
    expect(state.alerted).toEqual([]);
  });
});

describe('step: exact repeat detection', () => {
  test('warns on the third identical call, naming the tool and the count', () => {
    let state = EMPTY;
    let message: string | null = null;
    for (let i = 0; i < 3; i++) {
      const r = step(state, call('Read', { file_path: '/a.ts' }));
      state = r.state;
      message = r.message;
    }
    expect(message).toContain('[LOOP]');
    expect(message).toContain('Read');
    expect(message).toContain('3 times with identical input');
  });

  test('does not warn again on the fourth identical call — once per episode', () => {
    let state = EMPTY;
    for (let i = 0; i < 3; i++) state = step(state, call('Read', { file_path: '/a.ts' })).state;
    // Fourth call happens after the alert already fired at call 3; cooldown
    // also applies, so re-asserting the SAME episode key must stay silent.
    const { message } = step(state, call('Read', { file_path: '/a.ts' }));
    expect(message).toBeNull();
  });
});

describe('step: oscillation detection', () => {
  test('warns on an a-b-a-b pattern across the last four calls', () => {
    let state = EMPTY;
    let message: string | null = null;
    const calls = [call('Read', { file_path: '/a.ts' }), call('Read', { file_path: '/b.ts' })];
    for (let i = 0; i < 4; i++) {
      const r = step(state, calls[i % 2]!);
      state = r.state;
      message = r.message;
    }
    expect(message).toContain('[LOOP]');
    expect(message).toContain('Flip-flopping');
  });

  test('does not fire on three-in-a-row of the same call (not an a-b pattern)', () => {
    let state = EMPTY;
    let message: string | null = null;
    for (let i = 0; i < 3; i++) {
      const r = step(state, call('Bash', { command: 'ls' }));
      state = r.state;
      message = r.message;
    }
    // This DOES fire — but as an exact-repeat, not oscillation. Assert it
    // names the tool, not "Flip-flopping".
    expect(message).not.toContain('Flip-flopping');
  });
});

describe('step: hammering detection', () => {
  test('warns when one tool is called 5+ times in the last 8 with 3+ failures', () => {
    let state = EMPTY;
    let message: string | null = null;
    const failing = [true, true, true, false, false];
    for (const failed of failing) {
      const r = step(state, call('Bash', { command: `cmd-${Math.random()}` }, failed ? 'boom' : undefined));
      state = r.state;
      message = r.message;
    }
    expect(message).toContain('[LOOP]');
    expect(message).toContain('3 of those failed');
  });

  test('does not warn when the same tool is called 5+ times but fewer than 3 fail', () => {
    let state = EMPTY;
    let message: string | null = null;
    const failing = [true, true, false, false, false];
    for (const failed of failing) {
      const r = step(state, call('Bash', { command: `cmd-${Math.random()}` }, failed ? 'boom' : undefined));
      state = r.state;
      message = r.message;
    }
    expect(message).toBeNull();
  });
});

describe('step: cooldown', () => {
  test('a second, genuinely DIFFERENT loop within the 4-call cooldown window stays silent', () => {
    let state = EMPTY;
    // Trip the exact-repeat detector on Read at call 3 — lastAlert becomes 3.
    for (let i = 0; i < 3; i++) state = step(state, call('Read', { file_path: '/a.ts' })).state;
    expect(state.lastAlert).toBe(3);

    // A DIFFERENT tool's exact-repeat trips its own, never-yet-alerted key at
    // call 6 (seq 6 − lastAlert 3 = 3, inside the 4-call cooldown) — this is
    // not the dedupe path (the key is new), it is purely the cooldown timer.
    let message: string | null = null;
    for (let i = 0; i < 3; i++) {
      const r = step(state, call('Bash', { command: 'ls -la' }));
      state = r.state;
      message = r.message;
    }
    expect(message).toBeNull();
  });

  test('once the cooldown has elapsed, a new distinct loop DOES warn', () => {
    let state = EMPTY;
    for (let i = 0; i < 3; i++) state = step(state, call('Read', { file_path: '/a.ts' })).state;
    expect(state.lastAlert).toBe(3);

    // Pad with 4 non-repeating, non-failing calls so the next repeat trips at
    // seq 3 + 4 + 3 = 10, i.e. 7 past lastAlert — outside the cooldown window.
    for (const p of ['/p1', '/p2', '/p3', '/p4']) state = step(state, call('Read', { file_path: p })).state;

    let message: string | null = null;
    for (let i = 0; i < 3; i++) {
      const r = step(state, call('Bash', { command: 'ls -la' }));
      state = r.state;
      message = r.message;
    }
    expect(message).toContain('[LOOP]');
  });
});

// ── main() — the real entry point, driven end to end in-process ────────────
//
// Each test uses a fresh, unique session_id so the persisted window (a real
// file under the OS temp dir) never collides across tests or a concurrent
// subprocess-suite run. main() never calls process.exit (PostToolUse has
// nothing to prevent), so withExitSpy is used purely for its stdout capture.

function toolCall(sessionId: string, tool: string, input: Record<string, unknown>): string {
  return JSON.stringify({ session_id: sessionId, tool_name: tool, tool_input: input });
}

describe('main(): silent on a call that has not yet looped', () => {
  test('a single call produces no context injection', () => {
    const session = `wl-main-single-${Date.now()}`;
    const r = withExitSpy(() => main(toolCall(session, 'Read', { file_path: '/a.ts' })));
    expect(r.stdout).toBe('');
  });

  test('a tool_name-less payload is ignored', () => {
    const r = withExitSpy(() => main(JSON.stringify({ session_id: 'x' })));
    expect(r.stdout).toBe('');
  });

  test('AGENT_GUARDS_LOOPS=0 silences it', () => {
    process.env.AGENT_GUARDS_LOOPS = '0';
    try {
      const session = `wl-main-bypass-${Date.now()}`;
      for (let i = 0; i < 3; i++) withExitSpy(() => main(toolCall(session, 'Read', { file_path: '/a.ts' })));
      const r = withExitSpy(() => main(toolCall(session, 'Read', { file_path: '/a.ts' })));
      expect(r.stdout).toBe('');
    } finally {
      delete process.env.AGENT_GUARDS_LOOPS;
    }
  });
});

describe('main(): the persisted window genuinely survives across separate calls, injecting on the third real repeat', () => {
  test('three identical calls in three separate main() invocations trip the warning', () => {
    const session = `wl-main-repeat-${Date.now()}`;
    let last = withExitSpy(() => main(toolCall(session, 'Read', { file_path: '/a.ts' })));
    expect(last.stdout).toBe('');
    last = withExitSpy(() => main(toolCall(session, 'Read', { file_path: '/a.ts' })));
    expect(last.stdout).toBe('');
    last = withExitSpy(() => main(toolCall(session, 'Read', { file_path: '/a.ts' })));
    const injected = JSON.parse(last.stdout);
    expect(injected.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(injected.hookSpecificOutput.additionalContext).toContain('[LOOP]');
    expect(injected.hookSpecificOutput.additionalContext).toContain('3 times with identical input');
  });
});
