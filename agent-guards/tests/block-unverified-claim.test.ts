/**
 * block-unverified-claim.test.ts — in-process unit tests for the claim
 * classifier and decision logic in hooks/block-unverified-claim.ts.
 *
 * The hook itself already exports its pure decision surface — `decide()`,
 * `classifyClaim()`, `splitIntoUnits()`, `stripNoise()`,
 * `genericFlowClaimUnit()` — so no refactor was needed here. `decide()` takes
 * the HookInput plus an already-parsed event list and returns a Decision, so
 * these tests build synthetic event lists directly rather than writing
 * transcript fixtures to disk (that path is covered by
 * transcript-evidence.test.ts and by the subprocess suite's end-to-end
 * transcript fixtures).
 *
 * `main()` itself — which calls process.exit(0) at the bottom under
 * `if (import.meta.main)` — is intentionally never invoked here; the
 * subprocess suite (tests/guards.test.ts) already exercises it end to end,
 * real transcript file and all, and asserts on the real exit code and stdout.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyClaim,
  decide,
  genericFlowClaimUnit,
  main,
  splitIntoUnits,
  stripNoise,
  type Decision,
} from '../hooks/block-unverified-claim.ts';
import type { TxEvent } from '../hooks/lib/transcript-evidence.ts';
import { withExitSpy } from './lib/exit-spy.ts';

function ev(kind: TxEvent['kind'], seq: number, extra: Partial<TxEvent> = {}): TxEvent {
  return { seq, kind, tool: 'x', target: '', resultText: '', isError: false, isCode: false, ...extra };
}

// ── splitIntoUnits / stripNoise ──────────────────────────────────────────

describe('splitIntoUnits', () => {
  test('splits a run-on summary on sentence and clause boundaries', () => {
    expect(splitIntoUnits('Deployed the site, it is live now. Tests pass.')).toEqual([
      'Deployed the site',
      'it is live now',
      'Tests pass',
    ]);
  });
});

describe('stripNoise', () => {
  test('removes fenced code, inline code, and blockquotes — a quoted spec is not a claim', () => {
    const msg = 'The spec says:\n> the login flow works\n\nAlso `works` and ```works too```.';
    const stripped = stripNoise(msg);
    expect(stripped).not.toContain('the login flow works');
    expect(stripped).not.toContain('works too');
  });
});

// ── classifyClaim ─────────────────────────────────────────────────────────

describe('classifyClaim', () => {
  test('T1: a deploy/liveness claim with a web noun', () => {
    const claim = classifyClaim('The site is live at https://demo.example.com');
    expect(claim?.type).toBe('T1');
  });

  test('T2: a flow-works claim outranks a T1 claim in the same message', () => {
    const claim = classifyClaim('Deployed to production. Login works now.');
    expect(claim?.type).toBe('T2');
  });

  test('T2 does not fire on a visual claim about a flow-adjacent element', () => {
    // "the sign-in button renders" is about pixels, not whether sign-in works.
    const claim = classifyClaim('The sign-in button renders correctly now.');
    expect(claim?.type).not.toBe('T2');
  });

  test('T3: an appearance claim about a visual noun', () => {
    const claim = classifyClaim('The logo renders correctly in the header now.');
    expect(claim?.type).toBe('T3');
  });

  test('T4: a tests-pass claim', () => {
    const claim = classifyClaim('All tests pass now.');
    expect(claim?.type).toBe('T4');
  });

  test('null on a question containing claim words', () => {
    expect(classifyClaim('Is the site live at https://demo.example.com?')).toBeNull();
  });

  test('null on an imperative instruction', () => {
    expect(classifyClaim('Deploy the site and verify it is live.')).toBeNull();
  });

  test('null on narration of past work', () => {
    expect(classifyClaim('The site went live back in 2019.')).toBeNull();
  });

  test('null on attribution/quoting ("you said…", or a quoted phrase)', () => {
    expect(classifyClaim('You said the site should be live at https://demo.example.com')).toBeNull();
  });

  test('null on a plain non-claim sentence', () => {
    expect(classifyClaim('I reviewed the file and left some comments.')).toBeNull();
  });
});

describe('genericFlowClaimUnit', () => {
  test('matches a terse flow assertion with no explicit flow noun', () => {
    expect(genericFlowClaimUnit('Both apps live and verified.')).not.toBeNull();
    expect(genericFlowClaimUnit('Login works.')).not.toBeNull();
  });

  test('null on an ordinary sentence', () => {
    expect(genericFlowClaimUnit('I updated the README.')).toBeNull();
  });
});

// ── decide() — the full decision surface ───────────────────────────────────

const baseInput = { session_id: 'test', last_assistant_message: '' };

describe('decide: pass paths', () => {
  test('a stop_hook_active recovery pass never blocks, regardless of the message', () => {
    const d = decide(
      { ...baseInput, stop_hook_active: true, last_assistant_message: 'Deployed and live at https://x.example.com' },
      [ev('deploy', 0)],
    );
    expect(d).toEqual({ action: 'pass', note: 'stop-hook-recovery' });
  });

  test('an empty message passes', () => {
    const d = decide({ ...baseInput, last_assistant_message: '' }, []);
    expect(d.action).toBe('pass');
    expect(d.note).toBe('empty-message');
  });

  test('an honest downgrade passes even with deploy activity', () => {
    const d = decide(
      { ...baseInput, last_assistant_message: 'Deployed to production, but not verified live yet.' },
      [ev('deploy', 0)],
    );
    expect(d.action).toBe('pass');
    expect(d.note).toBe('honest-downgrade');
  });

  test('a claim with no matching activity at all passes as no-claim', () => {
    const d = decide({ ...baseInput, last_assistant_message: 'I reviewed the code.' }, []);
    expect(d).toEqual({ action: 'pass', note: 'no-claim' });
  });

  test('act-then-claim precondition: a T1 claim in a turn with no deploy passes, unverified', () => {
    const d = decide(
      { ...baseInput, last_assistant_message: 'The site is live at https://demo.example.com' },
      [ev('probe', 0)], // no deploy event at all
    );
    expect(d.action).toBe('pass');
    expect(d.note).toBe('act-then-claim-not-met');
    expect(d.type).toBe('T1');
  });

  test('a T1 claim WITH a probe after the deploy passes as verified', () => {
    const d = decide(
      { ...baseInput, last_assistant_message: 'Deployed. The site is live at https://demo.example.com' },
      [ev('deploy', 0), ev('probe', 1, { isError: false })],
    );
    expect(d).toEqual({ action: 'pass', note: 'verified', type: 'T1' });
  });

  test('a spawned sub-agent confounds detection and always passes — evidence may be in its own context', () => {
    const d = decide(
      { ...baseInput, last_assistant_message: 'Deployed. The site is live at https://demo.example.com' },
      [ev('deploy', 0), ev('agent-result', 1)],
    );
    expect(d).toEqual({ action: 'pass', note: 'subagent-confounder', type: 'T1' });
  });

  test('T4 (tests-pass) is log-only by design — it passes even when unverified', () => {
    const d = decide({ ...baseInput, last_assistant_message: 'All tests pass now.' }, [ev('edit', 0, { isCode: true })]);
    expect(d.action).toBe('pass');
    expect(d.note).toBe('log-only-type');
    expect(d.type).toBe('T4');
  });

  test('a per-type env switch (AGENT_GUARDS_CLAIM_T1=0) disables that type only', () => {
    process.env.AGENT_GUARDS_CLAIM_T1 = '0';
    try {
      const d = decide(
        { ...baseInput, last_assistant_message: 'Deployed. The site is live at https://demo.example.com' },
        [ev('deploy', 0)],
      );
      expect(d.action).toBe('pass');
      expect(d.note).toBe('type-disabled');
    } finally {
      delete process.env.AGENT_GUARDS_CLAIM_T1;
    }
  });
});

describe('decide: block paths — the exact reason must name the missing evidence', () => {
  test('T1: deploy claimed, never probed', () => {
    const d = decide(
      { ...baseInput, last_assistant_message: 'Deployed to production. The site is live at https://demo.example.com' },
      [ev('deploy', 0)],
    );
    expect(d.action).toBe('block');
    expect(d.note).toBe('block-T1');
    expect(d.reason).toContain('DEPLOY CLAIMED, NEVER PROBED');
    expect(d.reason).toContain('1 deploy(s) and no probe of the origin afterwards');
  });

  test('T2: flow claimed, rendered but never exercised', () => {
    const d = decide(
      { ...baseInput, last_assistant_message: 'Login works now.' },
      [ev('edit', 0, { isCode: true, target: '/src/auth.ts' }), ev('browser-capture', 1)],
    );
    expect(d.action).toBe('block');
    expect(d.note).toBe('block-T2');
    expect(d.reason).toContain('FLOW CLAIMED, NEVER EXERCISED');
    expect(d.reason).toContain('1 capture(s), 0 interaction(s)');
  });

  test('T2 via the generic-flow catch: a terse "live and verified" typed from a flow-adjacent edit', () => {
    const d = decide(
      { ...baseInput, last_assistant_message: 'Both apps live and verified.' },
      [ev('edit', 0, { isCode: true, target: '/src/checkout/session.ts' })],
    );
    expect(d.action).toBe('block');
    expect(d.type).toBe('T2');
  });

  test('T3: appearance claimed, never viewed', () => {
    const d = decide(
      { ...baseInput, last_assistant_message: 'The logo renders correctly now.' },
      [ev('edit', 0, { isCode: true, target: '/src/Header.tsx' })],
    );
    expect(d.action).toBe('block');
    expect(d.note).toBe('block-T3');
    expect(d.reason).toContain('APPEARANCE CLAIMED, NEVER VIEWED');
  });

  test('blocking is per specific claim/evidence pairing — a DIFFERENT claim type is not silenced by a disabled one', () => {
    process.env.AGENT_GUARDS_CLAIM_T1 = '0';
    try {
      const d = decide(
        { ...baseInput, last_assistant_message: 'The logo renders correctly now.' },
        [ev('edit', 0, { isCode: true, target: '/src/Header.tsx' })],
      );
      expect(d.action).toBe('block');
      expect(d.type).toBe('T3');
    } finally {
      delete process.env.AGENT_GUARDS_CLAIM_T1;
    }
  });
});

// A lightweight structural check that Decision's shape matches what main()
// destructures — action/note always present, reason/type present on demand.
test('Decision shape', () => {
  const passing: Decision = { action: 'pass', note: 'no-claim' };
  const blocking: Decision = { action: 'block', reason: 'x', note: 'block-T1', type: 'T1' };
  expect(passing.action).toBe('pass');
  expect(blocking.type).toBe('T1');
});

// ── main() — the real entry point, driven end to end in-process ────────────
//
// Unlike the other blocking guards, this Stop hook never calls process.exit —
// it signals a block by writing `{"decision":"block",...}` to stdout — so
// main() is always safe to call directly; withExitSpy is not needed, but its
// stdout capture is still useful for asserting the JSON payload.

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function transcript(lines: unknown[]): string {
  dir = dir || mkdtempSync(join(tmpdir(), 'agent-guards-uc-main-test-'));
  const path = join(dir, `t-${Math.random()}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

const userTurn = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } };
const use = (id: string, name: string, input: unknown) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});

function stopPayload(sessionId: string, message: string, transcriptPath: string): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'Stop',
    transcript_path: transcriptPath,
    last_assistant_message: message,
  });
}

describe('main(): allow paths write nothing to stdout', () => {
  test('empty stdin fails open', () => {
    const r = withExitSpy(() => main(''));
    expect(r.stdout).toBe('');
  });

  test('a claim that was actually verified', () => {
    const path = transcript([
      userTurn,
      use('t1', 'Bash', { command: 'npx wrangler deploy' }),
      result('t1', 'Published demo'),
      use('t2', 'Bash', { command: 'curl -sSI https://demo.example.com' }),
      result('t2', 'HTTP/2 200'),
    ]);
    const session = `uc-main-verified-${Date.now()}`;
    const r = withExitSpy(() =>
      main(stopPayload(session, 'Deployed. The site is live at https://demo.example.com', path)),
    );
    expect(r.stdout).toBe('');
  });
});

describe('main(): block path writes the exact JSON decision envelope, once per distinct claim', () => {
  test('an unverified deploy claim', () => {
    const path = transcript([
      userTurn,
      use('t1', 'Edit', { file_path: '/repo/src/index.ts', old_string: 'a', new_string: 'b' }),
      result('t1', 'ok'),
      use('t2', 'Bash', { command: 'npx wrangler deploy' }),
      result('t2', 'Published demo'),
    ]);
    const session = `uc-main-block-${Date.now()}`;
    const message = 'Deployed to production. The site is live at https://demo.example.com';

    const first = withExitSpy(() => main(stopPayload(session, message, path)));
    const parsed = JSON.parse(first.stdout);
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('DEPLOY CLAIMED, NEVER PROBED');

    // Same session, same claim again: the dedupe file (a real state file
    // under the OS temp dir, keyed by session id) must now suppress it.
    const second = withExitSpy(() => main(stopPayload(session, message, path)));
    expect(second.stdout).toBe('');
  });
});

describe('main(): bypass never blocks and always announces on stderr', () => {
  test('AGENT_GUARDS_UNVERIFIED_CLAIM=0', () => {
    const path = transcript([userTurn, use('t1', 'Bash', { command: 'npx wrangler deploy' }), result('t1', 'Published demo')]);
    const session = `uc-main-bypass-${Date.now()}`;
    process.env.AGENT_GUARDS_UNVERIFIED_CLAIM = '0';
    try {
      const r = withExitSpy(() =>
        main(stopPayload(session, 'Deployed. The site is live at https://demo.example.com', path)),
      );
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('BYPASSED via AGENT_GUARDS_UNVERIFIED_CLAIM=0');
    } finally {
      delete process.env.AGENT_GUARDS_UNVERIFIED_CLAIM;
    }
  });
});
