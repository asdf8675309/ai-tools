/**
 * block-task-flood.test.ts — in-process unit tests for the pure predicates
 * extracted from hooks/block-task-flood.ts.
 *
 * REFACTOR: main() originally inlined both blocking conditions directly
 * around bypassReason()/block() calls. `tooShort(description)` and
 * `atOrOverCeiling(count, max)` pull out exactly those two conditions —
 * verbatim, same comparisons — into named, pure, exported predicates, plus
 * `limit()` (parses AGENT_GUARDS_TASK_LIMIT) which was already a private
 * function and just needed `export`. main() is otherwise unchanged; the
 * counter-persistence and ceiling-crossing behavior (state file I/O) is
 * still exercised end to end by the subprocess suite.
 */

import { describe, expect, test } from 'bun:test';
import { atOrOverCeiling, limit, main, tooShort } from '../hooks/block-task-flood.ts';
import { bypassReason } from '../hooks/lib/shared.ts';
import { withExitSpy } from './lib/exit-spy.ts';

describe('tooShort', () => {
  test('true for an empty description', () => {
    expect(tooShort('')).toBe(true);
  });

  test('true for a description under the 10-character floor', () => {
    expect(tooShort('go')).toBe(true);
  });

  test('true for whitespace that trims to nothing', () => {
    expect(tooShort('         ')).toBe(true);
  });

  test('false for a real brief at or above the floor', () => {
    expect(tooShort('Investigate the failing billing typecheck and report the cause.')).toBe(false);
  });

  test('trims before measuring — padding alone does not make a thin brief pass', () => {
    expect(tooShort('   go   ')).toBe(true);
  });
});

describe('atOrOverCeiling', () => {
  test('false below the ceiling', () => {
    expect(atOrOverCeiling(10, 50)).toBe(false);
  });

  test('true exactly at the ceiling', () => {
    expect(atOrOverCeiling(50, 50)).toBe(true);
  });

  test('true past the ceiling', () => {
    expect(atOrOverCeiling(51, 50)).toBe(true);
  });

  test('false for a fresh counter', () => {
    expect(atOrOverCeiling(0, 50)).toBe(false);
  });
});

describe('limit', () => {
  test('defaults to 50 with AGENT_GUARDS_TASK_LIMIT unset', () => {
    delete process.env.AGENT_GUARDS_TASK_LIMIT;
    expect(limit()).toBe(50);
  });

  test('honors a valid override', () => {
    process.env.AGENT_GUARDS_TASK_LIMIT = '5';
    try {
      expect(limit()).toBe(5);
    } finally {
      delete process.env.AGENT_GUARDS_TASK_LIMIT;
    }
  });

  test('floors a fractional override', () => {
    process.env.AGENT_GUARDS_TASK_LIMIT = '5.9';
    try {
      expect(limit()).toBe(5);
    } finally {
      delete process.env.AGENT_GUARDS_TASK_LIMIT;
    }
  });

  test('falls back to the default on a non-numeric, zero, or negative override — a ceiling of 0 would block everything, which is not what "raise or lower" means', () => {
    for (const bad of ['not-a-number', '0', '-5', '']) {
      process.env.AGENT_GUARDS_TASK_LIMIT = bad;
      expect(limit()).toBe(50);
    }
    delete process.env.AGENT_GUARDS_TASK_LIMIT;
  });
});

// ── Bypass: task-flood deliberately calls bypassReason(SLUG) with NO command
//    argument (see the file's own doc comment: "There is no inline token").
//    Confirm that pattern actually closes off inline-token bypass, and that
//    the env-var path still works. ─────────────────────────────────────────

describe('task-flood bypass reason (as main() calls it — WITHOUT a command)', () => {
  test('an inline-token-shaped string in the (unused) description cannot bypass it', () => {
    // main() never passes the description to bypassReason, so even if an
    // agent wrote the token into its own task description, it would have no
    // effect — proven here by calling bypassReason with no second argument,
    // the actual call shape in block-task-flood.ts.
    expect(bypassReason('task-flood')).toBeNull();
  });

  test('AGENT_GUARDS_TASK_FLOOD=0 still bypasses', () => {
    process.env.AGENT_GUARDS_TASK_FLOOD = '0';
    try {
      expect(bypassReason('task-flood')).toBe('AGENT_GUARDS_TASK_FLOOD=0');
    } finally {
      delete process.env.AGENT_GUARDS_TASK_FLOOD;
    }
  });

  test('AGENT_GUARDS_OFF=1 still bypasses globally', () => {
    process.env.AGENT_GUARDS_OFF = '1';
    try {
      expect(bypassReason('task-flood')).toBe('AGENT_GUARDS_OFF=1');
    } finally {
      delete process.env.AGENT_GUARDS_OFF;
    }
  });
});

// ── main() — the real entry point, driven end to end in-process ────────────
//
// Each test uses a fresh, unique session_id so the persisted counter (a real
// file under the OS temp dir — the same one the live hook uses) never
// collides across tests or across a concurrent subprocess-suite run.

function taskCreated(sessionId: string, description: string): string {
  return JSON.stringify({ session_id: sessionId, task_description: description });
}

describe('main(): allow path never calls exit', () => {
  test('a real brief, once', () => {
    const session = `tf-unit-ok-${Date.now()}-${Math.random()}`;
    const r = withExitSpy(() => main(taskCreated(session, 'Investigate the failing billing typecheck and report the cause.')));
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toBe('');
  });

  test('unparseable stdin fails open', () => {
    const r = withExitSpy(() => main('{not json'));
    expect(r.exitCode).toBeUndefined();
  });
});

describe('main(): block — thin brief', () => {
  test('names the actual length and the minimum', () => {
    const session = `tf-unit-thin-${Date.now()}-${Math.random()}`;
    const r = withExitSpy(() => main(taskCreated(session, 'go')));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('TASK-FLOOD');
    expect(r.stderr).toContain('description length: 2 (minimum 10)');
  });
});

describe('main(): block — past the ceiling, and the counter genuinely persists across calls', () => {
  test('the Nth call in a session blocks once AGENT_GUARDS_TASK_LIMIT is reached', () => {
    const session = `tf-unit-ceiling-${Date.now()}-${Math.random()}`;
    process.env.AGENT_GUARDS_TASK_LIMIT = '2';
    try {
      const first = withExitSpy(() => main(taskCreated(session, 'A perfectly reasonable task description.')));
      expect(first.exitCode).toBeUndefined();
      const second = withExitSpy(() => main(taskCreated(session, 'A perfectly reasonable task description.')));
      expect(second.exitCode).toBeUndefined();
      const third = withExitSpy(() => main(taskCreated(session, 'A perfectly reasonable task description.')));
      expect(third.exitCode).toBe(2);
      expect(third.stderr).toContain('ceiling');
      expect(third.stderr).toContain('already created 2 tasks (ceiling 2)');
    } finally {
      delete process.env.AGENT_GUARDS_TASK_LIMIT;
    }
  });
});

describe('main(): bypass never exits and always announces on stderr', () => {
  test('AGENT_GUARDS_TASK_FLOOD=0 bypasses the thin-brief block', () => {
    process.env.AGENT_GUARDS_TASK_FLOOD = '0';
    try {
      const session = `tf-unit-bypass-${Date.now()}-${Math.random()}`;
      const r = withExitSpy(() => main(taskCreated(session, 'go')));
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toContain('BYPASSED via AGENT_GUARDS_TASK_FLOOD=0');
    } finally {
      delete process.env.AGENT_GUARDS_TASK_FLOOD;
    }
  });
});
