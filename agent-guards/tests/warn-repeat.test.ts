/**
 * warn-repeat.test.ts — in-process unit tests for hooks/warn-repeat.ts.
 * `similarity()` was already an exported pure function. Never blocks; the
 * SILENT vs WARNS pair (and the threshold that separates them) is what's
 * under test. `main()` gained the standard optional `raw`-stdin seam; it
 * never calls process.exit, so it is always safe to call directly.
 */

import { describe, expect, test } from 'bun:test';
import { main, similarity } from '../hooks/warn-repeat.ts';
import { withExitSpy } from './lib/exit-spy.ts';

describe('similarity', () => {
  test('1.0 for identical text', () => {
    const text = 'please fix the failing typecheck in the billing package before anything else';
    expect(similarity(text, text)).toBe(1);
  });

  test('0 for completely unrelated text', () => {
    expect(similarity('deploy the worker to production now', 'what time is the meeting tomorrow')).toBe(0);
  });

  test('0 when either side has no bigrams (fewer than 2 meaningful tokens)', () => {
    expect(similarity('ok', 'please fix the failing typecheck in the billing package')).toBe(0);
    expect(similarity('please fix the failing typecheck in the billing package', '')).toBe(0);
  });

  test('high similarity for a near-restatement — above the 0.6 warn threshold', () => {
    const a = 'please fix the failing typecheck in the billing package before anything else';
    const b = 'can you fix the failing typecheck in the billing package before anything else';
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.6);
  });

  test('low similarity for two prompts sharing only a couple of common words', () => {
    const a = 'please review the pull request for the billing service';
    const b = 'please schedule a meeting about the marketing budget';
    expect(similarity(a, b)).toBeLessThan(0.6);
  });

  test('is case-insensitive and punctuation-insensitive', () => {
    const a = 'Fix the Billing Typecheck, please!';
    const b = 'fix the billing typecheck please';
    expect(similarity(a, b)).toBeGreaterThan(0.9);
  });
});

// ── main() — the real entry point, driven end to end in-process ────────────
//
// Each test uses a fresh, unique session_id so the persisted "previous
// prompt" (a real file under the OS temp dir) never collides across tests.

function prompt(sessionId: string, text: string): string {
  return JSON.stringify({ session_id: sessionId, prompt: text });
}

const REAL_PROMPT = 'please fix the failing typecheck in the billing package before anything else';

describe('main(): silent cases never write to stdout', () => {
  test('a first prompt in a session has nothing to compare against', () => {
    const session = `wr-main-first-${Date.now()}`;
    const r = withExitSpy(() => main(prompt(session, REAL_PROMPT)));
    expect(r.stdout).toBe('');
  });

  test('a short ack/greeting is ignored, even after a real prompt', () => {
    const session = `wr-main-ack-${Date.now()}`;
    withExitSpy(() => main(prompt(session, REAL_PROMPT)));
    const r = withExitSpy(() => main(prompt(session, 'thanks')));
    expect(r.stdout).toBe('');
  });

  test('a harness-injected notification is ignored and does not overwrite the stored baseline', () => {
    const session = `wr-main-harness-${Date.now()}`;
    withExitSpy(() => main(prompt(session, REAL_PROMPT)));
    withExitSpy(() => main(prompt(session, '<task-notification>agent finished</task-notification>')));
    // The baseline should still be REAL_PROMPT, so a genuine restatement now
    // must still be caught — proving the notification did not overwrite it.
    const r = withExitSpy(() =>
      main(prompt(session, 'can you fix the failing typecheck in the billing package before anything else')),
    );
    expect(r.stdout).not.toBe('');
  });

  test('AGENT_GUARDS_REPEAT=0 silences a genuine restatement', () => {
    const session = `wr-main-bypass-${Date.now()}`;
    withExitSpy(() => main(prompt(session, REAL_PROMPT)));
    process.env.AGENT_GUARDS_REPEAT = '0';
    try {
      const r = withExitSpy(() => main(prompt(session, REAL_PROMPT)));
      expect(r.stdout).toBe('');
    } finally {
      delete process.env.AGENT_GUARDS_REPEAT;
    }
  });
});

describe('main(): a genuine restatement injects UserPromptSubmit context, naming the similarity score', () => {
  test('two prompts across two separate main() invocations trip the warning', () => {
    const session = `wr-main-warn-${Date.now()}`;
    withExitSpy(() => main(prompt(session, REAL_PROMPT)));
    const r = withExitSpy(() => main(prompt(session, REAL_PROMPT)));
    const injected = JSON.parse(r.stdout);
    expect(injected.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(injected.hookSpecificOutput.additionalContext).toContain('[REPEATED REQUEST]');
    expect(injected.hookSpecificOutput.additionalContext).toContain('100% similar');
  });
});
