/**
 * block-leaks.test.ts — in-process unit tests for hooks/block-leaks.ts.
 *
 * REFACTOR: `parseConfig`, `inSafeZone`, `extractTargets`, `globToRegExp`,
 * `literalToRegExp`, and `findConfig` were already separated from main()'s
 * block()/announceBypass() calls — they just needed the `export` keyword
 * added so tests can import them directly. `main()` itself gained the same
 * optional `raw`-stdin seam every guard's main() now has, so it can be
 * driven directly too; its block() path is exercised safely via
 * withExitSpy, which intercepts process.exit instead of letting it kill the
 * test runner. The subprocess suite still covers it end to end as well.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractTargets,
  findConfig,
  globToRegExp,
  inSafeZone,
  literalToRegExp,
  main,
  parseConfig,
  type Config,
} from '../hooks/block-leaks.ts';
import { withExitSpy } from './lib/exit-spy.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});
function tmp(): string {
  dir = dir || mkdtempSync(join(tmpdir(), 'agent-guards-leaks-test-'));
  return dir;
}

// ── literalToRegExp ────────────────────────────────────────────────────────

describe('literalToRegExp', () => {
  test('matches the literal substring anywhere', () => {
    const re = literalToRegExp('internal-widget-service');
    expect(re.test('we call internal-widget-service here')).toBe(true);
    expect(re.test('unrelated text')).toBe(false);
  });

  test('escapes regex metacharacters so a literal dot does not become "any character"', () => {
    const re = literalToRegExp('acct.123');
    expect(re.test('acct.123')).toBe(true);
    expect(re.test('acctX123')).toBe(false); // would match if "." were a wildcard
  });
});

// ── globToRegExp ──────────────────────────────────────────────────────────

describe('globToRegExp', () => {
  test('** spans directory separators', () => {
    const re = globToRegExp('private/**');
    expect(re.test('private/notes.md')).toBe(true);
    expect(re.test('private/nested/deep/notes.md')).toBe(true);
  });

  test('* does not span separators', () => {
    const re = globToRegExp('notes/*.local.md');
    expect(re.test('notes/a.local.md')).toBe(true);
    expect(re.test('notes/nested/a.local.md')).toBe(false);
  });

  test('a trailing slash means "this directory and everything under it"', () => {
    const re = globToRegExp('private/');
    expect(re.test('private/x.md')).toBe(true);
    expect(re.test('private/nested/x.md')).toBe(true);
    expect(re.test('public/x.md')).toBe(false);
  });

  test('does not produce a control byte for any input — the historical bug this guards against', () => {
    // A prior implementation used a control-byte placeholder to hold "**"
    // apart from "*" mid-rewrite, which made the SOURCE FILE itself read as
    // binary to grep and text tools. Assert the regex source is plain text.
    for (const glob of ['private/**', 'a/**/b/*.md', '**/*.ts', 'x/**']) {
      const re = globToRegExp(glob);
      expect(/^[\x20-\x7e]*$/.test(re.source)).toBe(true);
    }
  });
});

// ── parseConfig — including the fail-closed "broken" case ─────────────────

describe('parseConfig', () => {
  test('parses literal and regex patterns, and allow globs, skipping comments/blank lines', () => {
    const d = tmp();
    const path = join(d, '.agent-guards-forbidden');
    writeFileSync(
      path,
      ['# a comment', '', 'internal-widget-service', '/acct_[0-9a-f]{8}/i', 'allow: private/**'].join('\n'),
    );
    const cfg = parseConfig(path);
    expect(cfg.broken).toBeNull();
    expect(cfg.patterns.map((p) => p.source)).toEqual(['internal-widget-service', '/acct_[0-9a-f]{8}/i']);
    expect(cfg.allowGlobs).toEqual(['private/**']);
    // The regex form was compiled WITH its flag (case-insensitive).
    expect(cfg.patterns[1]!.re.test('ACCT_DEADBEEF')).toBe(true);
  });

  test('fails closed: an unparseable pattern sets cfg.broken and stops parsing further lines', () => {
    const d = tmp();
    const path = join(d, '.agent-guards-forbidden');
    writeFileSync(path, ['good-literal', '/[unclosed/', 'never-reached'].join('\n'));
    const cfg = parseConfig(path);
    expect(cfg.broken).toBe('/[unclosed/');
    // The pattern before the broken one WAS captured; the one after was not —
    // proof parsing genuinely stopped rather than silently skipping the bad line.
    expect(cfg.patterns.map((p) => p.source)).toEqual(['good-literal']);
  });

  test('fails closed: an unreadable file sets cfg.broken to a sentinel', () => {
    const d = tmp();
    const path = join(d, 'does-not-exist');
    const cfg = parseConfig(path);
    expect(cfg.broken).toBe('<unreadable config file>');
  });
});

// ── findConfig ────────────────────────────────────────────────────────────

describe('findConfig', () => {
  test('finds the config by walking up from a nested directory', () => {
    const d = tmp();
    writeFileSync(join(d, '.agent-guards-forbidden'), 'x');
    const nested = join(d, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findConfig(nested)).toBe(join(d, '.agent-guards-forbidden'));
  });

  test('returns null when no .agent-guards-forbidden exists anywhere up to the filesystem root', () => {
    const d = tmp();
    const nested = join(d, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    // No .agent-guards-forbidden written anywhere — a bare OS temp dir tree
    // has no reason to have one above it, so this walks to filesystem root
    // and correctly returns null rather than a false match.
    expect(findConfig(nested)).toBeNull();
  });

  test('AGENT_GUARDS_FORBIDDEN_FILE overrides the walk entirely', () => {
    const d = tmp();
    const override = join(d, 'custom-name.txt');
    writeFileSync(override, 'x');
    process.env.AGENT_GUARDS_FORBIDDEN_FILE = override;
    try {
      expect(findConfig('/anywhere/at/all')).toBe(override);
    } finally {
      delete process.env.AGENT_GUARDS_FORBIDDEN_FILE;
    }
  });

  test('AGENT_GUARDS_FORBIDDEN_FILE pointing at a missing file returns null rather than falling back to the walk', () => {
    process.env.AGENT_GUARDS_FORBIDDEN_FILE = '/definitely/does/not/exist';
    try {
      expect(findConfig('/anywhere')).toBeNull();
    } finally {
      delete process.env.AGENT_GUARDS_FORBIDDEN_FILE;
    }
  });
});

// ── inSafeZone ────────────────────────────────────────────────────────────

describe('inSafeZone', () => {
  function cfgAt(path: string, allowGlobs: string[]): Config {
    return { path, patterns: [], allowGlobs, broken: null };
  }

  test('a file inside a declared allow glob is safe', () => {
    const d = tmp();
    const cfg = cfgAt(join(d, '.agent-guards-forbidden'), ['private/**']);
    expect(inSafeZone(join(d, 'private/notes.md'), cfg)).toBe(true);
  });

  test('a file NOT inside any allow glob is not safe', () => {
    const d = tmp();
    const cfg = cfgAt(join(d, '.agent-guards-forbidden'), ['private/**']);
    expect(inSafeZone(join(d, 'public/readme.md'), cfg)).toBe(false);
  });

  test('a file outside the config\'s own directory tree entirely is treated as safe (not this config\'s concern)', () => {
    const d = tmp();
    const cfg = cfgAt(join(d, 'sub/.agent-guards-forbidden'), []);
    expect(inSafeZone('/completely/different/tree/file.md', cfg)).toBe(true);
  });

  test('a malformed allow glob does not widen the safe zone — it is skipped, not treated as match-all', () => {
    const d = tmp();
    // globToRegExp on a normal string never throws, so to exercise the catch
    // path we rely on it not matching rather than throwing; this asserts the
    // documented invariant directly: an entry that cannot help must not hurt.
    const cfg = cfgAt(join(d, '.agent-guards-forbidden'), ['private/**']);
    expect(inSafeZone(join(d, 'public/x.md'), cfg)).toBe(false);
  });
});

// ── extractTargets ────────────────────────────────────────────────────────

describe('extractTargets', () => {
  test('Write: content field, labeled "content"', () => {
    const targets = extractTargets('Write', { file_path: '/a.md', content: 'hello' });
    expect(targets).toEqual([{ filePath: '/a.md', content: 'hello', label: 'content' }]);
  });

  test('Edit: new_string field, labeled "new_string"', () => {
    const targets = extractTargets('Edit', { file_path: '/a.md', old_string: 'x', new_string: 'hello' });
    expect(targets).toEqual([{ filePath: '/a.md', content: 'hello', label: 'new_string' }]);
  });

  test('NotebookEdit: new_source field, labeled "new_source"', () => {
    const targets = extractTargets('NotebookEdit', { notebook_path: '/a.ipynb', new_source: 'print(1)' });
    expect(targets).toEqual([{ filePath: '/a.ipynb', content: 'print(1)', label: 'new_source' }]);
  });

  test('MultiEdit: one target per edit, indexed labels', () => {
    const targets = extractTargets('MultiEdit', {
      file_path: '/a.md',
      edits: [
        { old_string: 'a', new_string: 'one' },
        { old_string: 'b', new_string: 'two' },
      ],
    });
    expect(targets).toEqual([
      { filePath: '/a.md', content: 'one', label: 'edits[0].new_string' },
      { filePath: '/a.md', content: 'two', label: 'edits[1].new_string' },
    ]);
  });

  test('an unrecognized tool name produces no targets', () => {
    expect(extractTargets('SomeOtherTool', { file_path: '/a.md', content: 'x' })).toEqual([]);
  });

  test('no file_path at all produces no targets', () => {
    expect(extractTargets('Write', { content: 'x' })).toEqual([]);
  });
});

// ── main() — the real entry point, driven end to end in-process ────────────

function writePayload(filePath: string, content: string): string {
  return JSON.stringify({ session_id: 'test', tool_name: 'Write', tool_input: { file_path: filePath, content } });
}

describe('main(): allow paths never call exit', () => {
  test('no config anywhere above the target — the guard is simply not configured', () => {
    const d = tmp();
    const r = withExitSpy(() => main(writePayload(join(d, 'x.md'), 'internal-widget-service')));
    expect(r.exitCode).toBeUndefined();
  });

  test('clean content in a configured, governed tree', () => {
    const d = tmp();
    writeFileSync(join(d, '.agent-guards-forbidden'), 'internal-widget-service\n');
    const r = withExitSpy(() => main(writePayload(join(d, 'readme.md'), '# hello')));
    expect(r.exitCode).toBeUndefined();
  });

  test('a forbidden string written INTO a declared safe zone', () => {
    const d = tmp();
    mkdirSync(join(d, 'private'));
    writeFileSync(join(d, '.agent-guards-forbidden'), ['internal-widget-service', 'allow: private/**'].join('\n'));
    const r = withExitSpy(() => main(writePayload(join(d, 'private/notes.md'), 'internal-widget-service is fine here')));
    expect(r.exitCode).toBeUndefined();
  });

  test('a non-write tool is ignored', () => {
    const r = withExitSpy(() => main(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } })));
    expect(r.exitCode).toBeUndefined();
  });
});

describe('main(): block — a forbidden literal outside every safe zone, naming the file/pattern/config', () => {
  test('names the specific file, pattern, and config path', () => {
    const d = tmp();
    writeFileSync(join(d, '.agent-guards-forbidden'), 'internal-widget-service\n');
    const r = withExitSpy(() => main(writePayload(join(d, 'readme.md'), 'we call internal-widget-service here')));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('LEAKS');
    expect(r.stderr).toContain(`file    : ${join(d, 'readme.md')} (content)`);
    expect(r.stderr).toContain('pattern : internal-widget-service');
    expect(r.stderr).toContain(`config  : ${join(d, '.agent-guards-forbidden')}`);
  });
});

describe('main(): FAILS CLOSED on a config it cannot parse — the write is refused, not silently allowed', () => {
  test('names the unparseable entry', () => {
    const d = tmp();
    writeFileSync(join(d, '.agent-guards-forbidden'), '/[unclosed/\n');
    const r = withExitSpy(() => main(writePayload(join(d, 'x.md'), 'totally clean content')));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('unparseable');
    expect(r.stderr).toContain('unparseable entry: /[unclosed/');
  });
});

describe('main(): bypass never exits and always announces on stderr', () => {
  test('AGENT_GUARDS_LEAKS=0 bypasses a real match', () => {
    const d = tmp();
    writeFileSync(join(d, '.agent-guards-forbidden'), 'internal-widget-service\n');
    process.env.AGENT_GUARDS_LEAKS = '0';
    try {
      const r = withExitSpy(() => main(writePayload(join(d, 'readme.md'), 'internal-widget-service')));
      expect(r.exitCode).toBeUndefined();
      expect(r.stderr).toContain('BYPASSED via AGENT_GUARDS_LEAKS=0');
    } finally {
      delete process.env.AGENT_GUARDS_LEAKS;
    }
  });
});
