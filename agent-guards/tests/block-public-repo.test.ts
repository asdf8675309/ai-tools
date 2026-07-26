/**
 * block-public-repo.test.ts — in-process unit tests for the pure decision
 * predicate extracted from hooks/block-public-repo.ts.
 *
 * REFACTOR: main() originally looped over RULES and called block()/
 * announceBypass() inline. `evaluatePublicRepo(cmd)` pulls the "which rule
 * (if any) matches" judgement into a pure function — first match wins, same
 * order as RULES — with no bypass check and no exit. main() now calls it and
 * does exactly what it did before; the subprocess suite is unchanged.
 */

import { describe, expect, test } from 'bun:test';
import { evaluatePublicRepo, main } from '../hooks/block-public-repo.ts';
import { bypassReason } from '../hooks/lib/shared.ts';
import { withExitSpy } from './lib/exit-spy.ts';

describe('evaluatePublicRepo: allow', () => {
  test('creating a private repo', () => {
    expect(evaluatePublicRepo('gh repo create demo --private')).toEqual({ action: 'allow' });
  });

  test('reading visibility is not changing it', () => {
    expect(evaluatePublicRepo('gh repo view owner/demo --json visibility')).toEqual({ action: 'allow' });
  });

  test('an unrelated gh command', () => {
    expect(evaluatePublicRepo('gh pr list --limit 5')).toEqual({ action: 'allow' });
  });

  test('gh repo edit with no visibility flag at all', () => {
    expect(evaluatePublicRepo('gh repo edit owner/demo --description "hello"')).toEqual({ action: 'allow' });
  });
});

describe('evaluatePublicRepo: block, with the specific matched rule', () => {
  test('gh repo create --public', () => {
    const v = evaluatePublicRepo('gh repo create demo --public');
    expect(v.action).toBe('block');
    expect(v.action === 'block' && v.rule.what).toBe('gh repo create/edit with a public visibility flag');
  });

  test('gh repo edit --visibility=public', () => {
    const v = evaluatePublicRepo('gh repo edit owner/demo --visibility=public --accept-visibility-change-consequences');
    expect(v.action).toBe('block');
    expect(v.action === 'block' && v.rule.what).toBe('gh repo create/edit with a public visibility flag');
  });

  test('gh api call setting visibility=public', () => {
    const v = evaluatePublicRepo('gh api -X PATCH /repos/owner/demo -f visibility=public');
    expect(v.action).toBe('block');
    expect(v.action === 'block' && v.rule.what).toBe('gh api call setting visibility=public or private=false');
  });

  test('gh api call setting private=false', () => {
    const v = evaluatePublicRepo('gh api -X PATCH /repos/owner/demo -f private=false');
    expect(v.action).toBe('block');
    expect(v.action === 'block' && v.rule.what).toBe('gh api call setting visibility=public or private=false');
  });

  test('a raw HTTP call to api.github.com flipping private to false', () => {
    const v = evaluatePublicRepo(`curl -X PATCH https://api.github.com/repos/owner/demo -d '{"private": false}'`);
    expect(v.action).toBe('block');
    expect(v.action === 'block' && v.rule.what).toBe(
      'HTTP call to api.github.com setting visibility public / private false',
    );
  });

  test('a raw HTTP call setting visibility=public as a query-style param', () => {
    const v = evaluatePublicRepo('curl -X PATCH https://api.github.com/repos/owner/demo -d visibility=public');
    expect(v.action).toBe('block');
  });
});

describe('public-repo bypass reason (as main() calls it — with the command)', () => {
  test('inline token bypasses', () => {
    expect(bypassReason('public-repo', 'gh repo create demo --public [skip-public-repo]')).toBe(
      'inline token [skip-public-repo]',
    );
  });

  test('AGENT_GUARDS_PUBLIC_REPO=0 bypasses', () => {
    process.env.AGENT_GUARDS_PUBLIC_REPO = '0';
    try {
      expect(bypassReason('public-repo', 'gh repo create demo --public')).toBe('AGENT_GUARDS_PUBLIC_REPO=0');
    } finally {
      delete process.env.AGENT_GUARDS_PUBLIC_REPO;
    }
  });
});

// ── main() — the real entry point, driven end to end in-process ────────────

function bash(command: string): string {
  return JSON.stringify({ session_id: 'test', tool_name: 'Bash', tool_input: { command } });
}

describe('main(): allow paths never call exit', () => {
  test('creating a private repo', () => {
    const r = withExitSpy(() => main(bash('gh repo create demo --private')));
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toBe('');
  });

  test('a non-Bash tool is ignored', () => {
    const r = withExitSpy(() => main(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } })));
    expect(r.exitCode).toBeUndefined();
  });
});

describe('main(): block paths call exit(2) and name the matched rule', () => {
  test('gh repo create --public', () => {
    const r = withExitSpy(() => main(bash('gh repo create demo --public')));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('PUBLIC-REPO');
    expect(r.stderr).toContain('gh repo create/edit with a public visibility flag');
    expect(r.stderr).toContain('one-way door');
  });
});

describe('main(): bypass never exits and always announces on stderr', () => {
  test('inline token', () => {
    const r = withExitSpy(() => main(bash('gh repo create demo --public [skip-public-repo]')));
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toContain('BYPASSED via inline token [skip-public-repo]');
  });
});
