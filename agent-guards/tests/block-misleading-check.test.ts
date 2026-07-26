/**
 * block-misleading-check.test.ts — in-process unit tests for the three
 * checks in hooks/block-misleading-check.ts.
 *
 * REFACTOR: each of the three checks' `block()`-calling wrapper
 * (checkBareTsc / checkWrongTree / checkPipedCheck) was split into a pure
 * judgement function — `findBareTscSegment`, `evaluateWrongTree`,
 * `findPipedCheckSegments` — that returns a verdict with no bypass check and
 * no exit, plus `effectiveRunDir` and `standDown`, which were already pure
 * and just needed `export`. The wrappers are unchanged in behavior; they now
 * call the pure function and do exactly what they did before with the
 * result. `main()` gained the standard optional `raw`-stdin seam. Its
 * git-touching check (checkWrongTree, via repoCtx()) is exercised through
 * main() with a real temp git repo + linked worktree fixture, same
 * convention as the previous subprocess suite; block()'s process.exit is
 * intercepted via withExitSpy so it can be called safely in-process.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  effectiveRunDir,
  evaluateWrongTree,
  findBareTscSegment,
  findPipedCheckSegments,
  main,
  standDown,
  type RepoCtx,
} from '../hooks/block-misleading-check.ts';
import { withExitSpy } from './lib/exit-spy.ts';

// ── findBareTscSegment ──────────────────────────────────────────────────────

describe('findBareTscSegment', () => {
  test('null for an unrelated command', () => {
    expect(findBareTscSegment('ls -la')).toBeNull();
  });

  test('null for npm run typecheck', () => {
    expect(findBareTscSegment('npm run typecheck')).toBeNull();
  });

  test('null for tsc -b (explicit build graph)', () => {
    expect(findBareTscSegment('tsc -b')).toBeNull();
  });

  test('null for tsc --noEmit with an explicit -p project file', () => {
    expect(findBareTscSegment('npx tsc --noEmit -p tsconfig.json')).toBeNull();
  });

  test('null when the string is inside quotes — data, not a command', () => {
    expect(findBareTscSegment('echo "run tsc --noEmit here" > note.txt')).toBeNull();
  });

  test('the offending segment for bare tsc --noEmit', () => {
    expect(findBareTscSegment('tsc --noEmit')).toBe('tsc --noEmit');
  });

  test('the offending segment for npx tsc --noEmit', () => {
    expect(findBareTscSegment('npx tsc --noEmit')).toBe('npx tsc --noEmit');
  });
});

// ── effectiveRunDir ─────────────────────────────────────────────────────────

describe('effectiveRunDir', () => {
  test('no cd at all — stays in the session cwd', () => {
    expect(effectiveRunDir('npm test', '/repo/main')).toBe('/repo/main');
  });

  test('resolves a relative cd against the session cwd', () => {
    expect(effectiveRunDir('cd ../sibling && npm test', '/repo/main')).toBe('/repo/sibling');
  });

  test('an absolute cd is used as-is', () => {
    expect(effectiveRunDir('cd /repo/other && npm test', '/repo/main')).toBe('/repo/other');
  });

  test('uses the LAST cd when there are several', () => {
    expect(effectiveRunDir('cd /a && cd /b && npm test', '/repo/main')).toBe('/b');
  });

  test('an unexpanded shell variable is not guessed at — falls back to session cwd', () => {
    expect(effectiveRunDir('cd $REPO_DIR && npm test', '/repo/main')).toBe('/repo/main');
  });
});

// ── evaluateWrongTree ────────────────────────────────────────────────────────

const repoA: RepoCtx = { topLevel: '/repo/main', commonDir: '/repo/.git' };
const repoASibling: RepoCtx = { topLevel: '/repo/linked', commonDir: '/repo/.git' };
const repoB: RepoCtx = { topLevel: '/other/repo', commonDir: '/other/repo/.git' };

describe('evaluateWrongTree', () => {
  test('not blocked when either context is null — undetectable is allow, not uncertain', () => {
    expect(evaluateWrongTree(null, repoA)).toEqual({ blocked: false });
    expect(evaluateWrongTree(repoA, null)).toEqual({ blocked: false });
    expect(evaluateWrongTree(null, null)).toEqual({ blocked: false });
  });

  test('not blocked when session and run are the same tree', () => {
    expect(evaluateWrongTree(repoA, repoA)).toEqual({ blocked: false });
  });

  test('not blocked when they are different repos entirely (different commonDir)', () => {
    expect(evaluateWrongTree(repoA, repoB)).toEqual({ blocked: false });
  });

  test('blocked when they share a commonDir but have different top levels — the cross-tree case', () => {
    expect(evaluateWrongTree(repoA, repoASibling)).toEqual({
      blocked: true,
      sessionTop: '/repo/main',
      runTop: '/repo/linked',
    });
  });
});

// ── findPipedCheckSegments ───────────────────────────────────────────────────

describe('findPipedCheckSegments', () => {
  test('null when pipefail is already set', () => {
    expect(findPipedCheckSegments('set -o pipefail; npm test | tail -5')).toBeNull();
  });

  test('null for an ordinary pipe into tail (not a verify command)', () => {
    expect(findPipedCheckSegments('ls -la | tail -5')).toBeNull();
  });

  test('null for a verify command piped into something that is not a pager/filter', () => {
    expect(findPipedCheckSegments('npm test | mail -s results me@example.com')).toBeNull();
  });

  test('the segments for a verify command piped into tail', () => {
    expect(findPipedCheckSegments('npm test | tail -5')).toEqual({ left: 'npm test ', right: ' tail -5' });
  });

  test('does not fire on || (not a pipe)', () => {
    expect(findPipedCheckSegments('npm test || echo failed')).toBeNull();
  });
});

// ── standDown — child-slug-first, parent-fallback bypass precedence ────────

describe('standDown', () => {
  afterEach(() => {
    delete process.env.AGENT_GUARDS_BARE_TSC;
    delete process.env.AGENT_GUARDS_MISLEADING_CHECK;
  });

  test('null with nothing set', () => {
    expect(standDown('bare-tsc', 'tsc --noEmit')).toBeNull();
  });

  test('the child slug env var bypasses', () => {
    process.env.AGENT_GUARDS_BARE_TSC = '0';
    expect(standDown('bare-tsc', 'tsc --noEmit')).toBe('AGENT_GUARDS_BARE_TSC=0');
  });

  test('the parent (whole-hook) env var bypasses when the child is not set', () => {
    process.env.AGENT_GUARDS_MISLEADING_CHECK = '0';
    expect(standDown('bare-tsc', 'tsc --noEmit')).toBe('AGENT_GUARDS_MISLEADING_CHECK=0');
  });

  test('the child-specific inline token bypasses', () => {
    expect(standDown('bare-tsc', 'tsc --noEmit [skip-bare-tsc]')).toBe('inline token [skip-bare-tsc]');
  });
});

// ── main() — the real entry point, driven end to end in-process ────────────

function bash(command: string, cwd?: string): string {
  return JSON.stringify({ session_id: 'test', tool_name: 'Bash', tool_input: { command }, ...(cwd ? { cwd } : {}) });
}

describe('main(): allow paths never call exit', () => {
  test('an unrelated command', () => {
    const r = withExitSpy(() => main(bash('ls -la')));
    expect(r.exitCode).toBeUndefined();
  });

  test('npm run typecheck', () => {
    const r = withExitSpy(() => main(bash('npm run typecheck')));
    expect(r.exitCode).toBeUndefined();
  });

  test('a piped verify command WITH pipefail set', () => {
    const r = withExitSpy(() => main(bash('set -o pipefail; npm test | tail -5')));
    expect(r.exitCode).toBeUndefined();
  });

  test('a non-Bash tool is ignored', () => {
    const r = withExitSpy(() => main(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tsc --noEmit' } })));
    expect(r.exitCode).toBeUndefined();
  });
});

describe('main(): block — bare tsc --noEmit, naming the offending segment', () => {
  test('names the segment and the reason', () => {
    const r = withExitSpy(() => main(bash('tsc --noEmit')));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BARE-TSC');
    expect(r.stderr).toContain('segment: tsc --noEmit');
    expect(r.stderr).toContain('ignores project');
  });

  test('bypass via inline token never exits and announces on stderr', () => {
    const r = withExitSpy(() => main(bash('tsc --noEmit [skip-bare-tsc]')));
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toContain('BYPASSED via inline token [skip-bare-tsc]');
  });

  test('bypass via env var never exits and announces on stderr', () => {
    process.env.AGENT_GUARDS_BARE_TSC = '0';
    try {
      const r = withExitSpy(() => main(bash('tsc --noEmit')));
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toContain('BYPASSED via AGENT_GUARDS_BARE_TSC=0');
    } finally {
      delete process.env.AGENT_GUARDS_BARE_TSC;
    }
  });
});

describe('main(): block — a test piped into tail with no pipefail', () => {
  test('names the pipeline and the reason', () => {
    const r = withExitSpy(() => main(bash('npm test | tail -5')));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('PIPED-CHECK');
    expect(r.stderr).toContain("filter's exit code, not the check's");
  });
});

describe('main(): block — cross-tree verify, using a REAL git repo + linked worktree', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function realGitFixture(): { main: string; linked: string } | null {
    // realpathSync: on macOS, the OS temp dir is itself a symlink
    // (/tmp -> /private/tmp), and `git rev-parse` resolves symlinks, so the
    // path the guard reports would otherwise never match the one we made.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-guards-misleading-test-')));
    const mainDir = join(root, 'main');
    const linked = join(root, 'linked');
    const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, encoding: 'utf-8' });
    mkdirSync(mainDir, { recursive: true });
    git(['init', '-q', '-b', 'main'], mainDir);
    git(['config', 'user.email', 'test@example.invalid'], mainDir);
    git(['config', 'user.name', 'test'], mainDir);
    writeFileSync(join(mainDir, 'file.txt'), 'x\n');
    git(['add', '.'], mainDir);
    git(['commit', '-qm', 'init'], mainDir);
    const wt = git(['worktree', 'add', '-q', '-b', 'side', linked], mainDir);
    if (wt.status !== 0) return null;
    return { main: mainDir, linked };
  }

  test('a verify command in the session\'s own tree is allowed', () => {
    const fixture = realGitFixture();
    if (!fixture) return; // git worktree unavailable in this environment
    const r = withExitSpy(() => main(bash('npm test', fixture.main)));
    expect(r.exitCode).toBeUndefined();
  });

  test('a verify command cd\'d into a sibling worktree is blocked, naming both trees', () => {
    const fixture = realGitFixture();
    if (!fixture) return;
    const r = withExitSpy(() => main(bash(`cd ${fixture.linked} && npm test`, fixture.main)));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('CROSS-TREE');
    expect(r.stderr).toContain(`session edits in : ${fixture.main}`);
    expect(r.stderr).toContain(`command runs in  : ${fixture.linked}`);
  });

  test('bypass via inline token never exits and announces on stderr', () => {
    const fixture = realGitFixture();
    if (!fixture) return;
    const r = withExitSpy(() => main(bash(`cd ${fixture.linked} && npm test [skip-cross-tree]`, fixture.main)));
    expect(r.exitCode).toBeUndefined();
    expect(r.stderr).toContain('BYPASSED via inline token');
  });

  test('a non-verify command in another tree is allowed', () => {
    const fixture = realGitFixture();
    if (!fixture) return;
    const r = withExitSpy(() => main(bash(`cd ${fixture.linked} && ls`, fixture.main)));
    expect(r.exitCode).toBeUndefined();
  });
});
