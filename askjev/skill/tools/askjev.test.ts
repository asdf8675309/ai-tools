import { test, expect } from 'bun:test';
import { spawnSync } from 'bun';
import path from 'node:path';

const CLI = path.join(import.meta.dir, 'askjev.ts');

function run(stdin: string, env: Record<string, string> = {}) {
  return spawnSync({
    cmd: ['bun', CLI],
    stdin: Buffer.from(stdin),
    env: { ...process.env, ...env },
  });
}

test('rejects a payload missing framedBy — the framing-disclosure requirement is structural, not just prose', () => {
  const result = run(JSON.stringify({
    state: 'should we ship X or Y?',
    questions: { q: { type: 'noul', instructions: 'is X ready?' } },
  }));

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('framedBy');
});

test('rejects a payload missing state', () => {
  const result = run(JSON.stringify({
    framedBy: 'assistant',
    questions: { q: { type: 'noul', instructions: 'is X ready?' } },
  }));

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('state');
});

test('rejects a payload with no questions', () => {
  const result = run(JSON.stringify({ state: 's', framedBy: 'assistant', questions: {} }));

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('questions');
});

test('rejects invalid JSON with a clear error rather than a stack trace', () => {
  const result = run('not json');

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('not valid JSON');
});

test('warns when a batch carries more than one noul question, without blocking it', () => {
  // Missing credentials will fail the actual call, but the warning must fire
  // before that — it's a framing check, not a network check.
  const result = run(JSON.stringify({
    state: 's',
    framedBy: 'assistant',
    questions: {
      a: { type: 'noul', instructions: 'disqualifier A?' },
      b: { type: 'noul', instructions: 'disqualifier B?' },
    },
  }), { CF_ACCOUNT_ID: '', CF_API_TOKEN: '' });

  expect(result.stderr.toString()).toContain('2 noul questions');
});
