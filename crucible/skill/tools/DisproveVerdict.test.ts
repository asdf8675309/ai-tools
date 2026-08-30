import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contains,
  extractCitations,
  isOutOfContract,
  resolveCitation,
  resolveVerdict,
  survives,
  type RawVerdict,
} from './DisproveVerdict';

// A real tree to resolve citations against. `src/real.ts` is 5 lines long.
const ROOT = mkdtempSync(join(tmpdir(), 'disprove-verdict-'));
mkdirSync(join(ROOT, 'src'), { recursive: true });
writeFileSync(join(ROOT, 'src/real.ts'), 'a\nb\nc\nd\ne\n');

const OPTS = { repoRoot: ROOT, floor: 80, requireCitationMinSeverity: 'HIGH' };
const v = (raw: Partial<RawVerdict>, severity = 'HIGH') =>
  resolveVerdict({ id: 'X', ...raw } as RawVerdict, { ...OPTS, severity });

describe('confidence contract (P5 — 22 measured instances)', () => {
  test('a 0-1 scale value is out of contract', () => {
    expect(isOutOfContract(0.95)).toBe(true);
    expect(isOutOfContract(0.15)).toBe(true);
  });

  // NEGATIVE CONTROL: normal values must stay in contract, or the guard is
  // just rejecting everything and the floor is effectively disabled.
  test('normal 0-100 values are in contract', () => {
    for (const c of [0, 40, 80, 95, 100]) expect(isOutOfContract(c)).toBe(false);
  });

  test('0.95 "Finding is valid" is NOT deleted by the floor', () => {
    const r = v({ disproven: false, confidence_after_check: 0.95, reason: 'Finding is valid.' });
    expect(r.verdict).toBe('CANNOT_VERIFY');
    expect(survives(r)).toBe(true);
    expect(r.unverified).toBe(true);
  });

  test('a 0.15 kill does NOT land', () => {
    const r = v({ disproven: true, confidence_after_check: 0.15, reason: 'handled upstream' });
    expect(survives(r)).toBe(true);
  });

  // NEGATIVE CONTROL: a genuine low confidence is still low confidence.
  test('a genuine 40 is still treated as uncertain, not rescued', () => {
    const r = v({ disproven: false, confidence_after_check: 40, reason: 'unsure' });
    expect(r.verdict).toBe('CANNOT_VERIFY');
    expect(r.confidence).toBe(80);
  });
});

describe('citation validation (B1 — most kills cite nothing)', () => {
  test('extracts path and line', () => {
    expect(extractCitations('see src/real.ts:3 for the guard')).toEqual([{ path: 'src/real.ts', line: 3 }]);
  });

  test('resolves a real file at an in-range line', () => {
    expect(resolveCitation([{ path: 'src/real.ts', line: 3 }], ROOT)).toBe(true);
  });

  test('rejects a real file at an out-of-range line', () => {
    expect(resolveCitation([{ path: 'src/real.ts', line: 9999 }], ROOT)).toBe(false);
  });

  test('rejects a path that escapes the tree under review', () => {
    expect(resolveCitation([{ path: '../../../etc/passwd' }], ROOT)).toBe(false);
  });

  test('a HIGH kill citing nothing is downgraded, not honoured', () => {
    const r = v({ disproven: true, confidence_after_check: 95, reason: 'handled upstream somewhere' });
    expect(r.verdict).toBe('CANNOT_VERIFY');
    expect(r.downgradeReason).toContain('cites no code');
    expect(survives(r)).toBe(true);
  });

  test('a HIGH kill citing a nonexistent file is downgraded', () => {
    const r = v({ disproven: true, confidence_after_check: 95, reason: 'guarded at src/ghost.ts:2' });
    expect(survives(r)).toBe(true);
  });

  // NEGATIVE CONTROL: the whole point is that GOOD kills still kill. If this
  // test ever goes green alongside the ones above, the filter is disabled.
  test('a HIGH kill citing real resolvable code STILL KILLS', () => {
    const r = v({ disproven: true, confidence_after_check: 95, reason: 'guarded at src/real.ts:2' });
    expect(r.verdict).toBe('DISPROVEN_EVIDENCE');
    expect(r.disproven).toBe(true);
    expect(survives(r)).toBe(false);
  });

  // Severity scoping: the citation requirement is bounded, by design.
  test('a MEDIUM kill citing nothing is still honoured at min-severity HIGH', () => {
    const r = v({ disproven: true, confidence_after_check: 95, reason: 'no citation' }, 'MEDIUM');
    expect(r.verdict).toBe('DISPROVEN_EVIDENCE');
  });
});

describe('the floor is no longer one-directional (A1 — both directions measured)', () => {
  test('a sub-floor KEEP surfaces flagged instead of vanishing', () => {
    const r = v({ disproven: false, confidence_after_check: 72, reason: 'looks real' });
    expect(survives(r)).toBe(true);
    expect(r.unverified).toBe(true);
    expect(r.downgradeReason).toContain('below floor');
  });

  test('a sub-floor KILL cannot delete anything', () => {
    const r = v({ disproven: true, confidence_after_check: 15, reason: 'fine at src/real.ts:1' });
    expect(survives(r)).toBe(true);
  });

  test('a failed call still fails open', () => {
    const r = v({ failed: true, confidence_after_check: null });
    expect(survives(r)).toBe(true);
    expect(r.unverified).toBe(true);
  });
});

describe('cross-vendor split survives (A2)', () => {
  test('a split makes the finding survive, flagged for a human', () => {
    const r = v({ disproven: true, confidence_after_check: 88, disproven_cross_vendor: false, reason: 'x' });
    expect(r.disagreement).toBe(true);
    expect(survives(r)).toBe(true);
  });

  // NEGATIVE CONTROL: agreement is not a disagreement.
  test('both vendors agreeing to kill, with a real citation, still kills', () => {
    const r = v({
      disproven: true,
      confidence_after_check: 88,
      disproven_cross_vendor: true,
      reason: 'guarded at src/real.ts:1',
    });
    expect(r.disagreement).toBe(false);
    expect(survives(r)).toBe(false);
  });
});

describe('unrecognized shapes fail open', () => {
  test('an unknown verdict shape surfaces rather than dropping', () => {
    const r = v({ confidence_after_check: 90, reason: 'no disproven field at all' });
    expect(r.verdict).toBe('AGREE');
    expect(survives(r)).toBe(true);
  });
});

// ── Crucible round 1 findings, each reproduced before it was fixed ──────────

describe('citation containment (CRITICAL — found by Crucible, reproduced)', () => {
  const base = mkdtempSync(join(tmpdir(), 'contain-'));
  const croot = join(base, 'repo');
  const evil = join(base, 'repo-evil');
  mkdirSync(join(croot, 'src'), { recursive: true });
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(croot, 'src/ok.ts'), 'a\nb\nc\n');
  writeFileSync(join(evil, 'secret.ts'), 'a\nb\nc\n');

  test('a sibling dir extending the root name does NOT satisfy containment', () => {
    // `${root}-evil`.startsWith(root) is true; path-segment containment is not.
    expect(resolveCitation([{ path: '../repo-evil/secret.ts', line: 2 }], croot)).toBe(false);
  });

  // NEGATIVE CONTROL: a genuine in-tree citation must still resolve, or the
  // fix has simply disabled citations entirely.
  test('a real in-tree file still resolves', () => {
    expect(resolveCitation([{ path: 'src/ok.ts', line: 2 }], croot)).toBe(true);
  });

  test('contains() is segment-aware in both directions', () => {
    expect(contains('/a/repo', '/a/repo/x.ts')).toBe(true);
    expect(contains('/a/repo', '/a/repo-evil/x.ts')).toBe(false);
    expect(contains('/a/repo', '/a/other/x.ts')).toBe(false);
  });
});

describe('non-code files are not code evidence (HIGH)', () => {
  test('a markdown or yaml citation is not extracted as a code citation', () => {
    expect(extractCitations('documented in README.md')).toEqual([]);
    expect(extractCitations('see config.yaml:3')).toEqual([]);
  });
  test('a real source citation still extracts', () => {
    expect(extractCitations('guarded at src/a.ts:5')).toEqual([{ path: 'src/a.ts', line: 5 }]);
  });
});

describe('the gate fails CLOSED on misconfiguration (HIGH)', () => {
  test('an unrecognized min-severity requires a citation rather than disabling the gate', () => {
    const r = resolveVerdict(
      { id: 'X', disproven: true, confidence_after_check: 95, reason: 'no citation' },
      { repoRoot: ROOT, floor: 80, requireCitationMinSeverity: 'BOGUS', severity: 'HIGH' },
    );
    expect(r.verdict).toBe('CANNOT_VERIFY');
  });

  test('a non-finite floor falls back to 80 instead of disabling confidence checks', () => {
    const r = resolveVerdict(
      { id: 'X', disproven: true, confidence_after_check: 15, reason: 'fine at src/real.ts:1' },
      { repoRoot: ROOT, floor: Number.NaN, requireCitationMinSeverity: 'HIGH', severity: 'HIGH' },
    );
    expect(survives(r)).toBe(true);
  });
});

describe('cross-vendor confidence is actually read (HIGH)', () => {
  test('an agreeing cross-vendor kill below the floor cannot land', () => {
    const r = resolveVerdict(
      {
        id: 'X', disproven: true, confidence_after_check: 95,
        disproven_cross_vendor: true, confidence_cross_vendor: 10,
        reason: 'guarded at src/real.ts:1',
      },
      { repoRoot: ROOT, floor: 80, requireCitationMinSeverity: 'HIGH', severity: 'HIGH' },
    );
    expect(survives(r)).toBe(true);
    expect(r.downgradeReason).toContain('cross-vendor kill');
  });

  // NEGATIVE CONTROL: two confident vendors agreeing, with a citation, still kills.
  test('two confident agreeing vendors with a real citation still kill', () => {
    const r = resolveVerdict(
      {
        id: 'X', disproven: true, confidence_after_check: 95,
        disproven_cross_vendor: true, confidence_cross_vendor: 92,
        reason: 'guarded at src/real.ts:1',
      },
      { repoRoot: ROOT, floor: 80, requireCitationMinSeverity: 'HIGH', severity: 'HIGH' },
    );
    expect(r.verdict).toBe('DISPROVEN_EVIDENCE');
  });
});

// ── Crucible round 2 findings ───────────────────────────────────────────────

describe('a bare filename is not evidence the code was read (round 2, HIGH ×3)', () => {
  test('a citation with no line number does NOT resolve', () => {
    expect(resolveCitation([{ path: 'src/real.ts' }], ROOT)).toBe(false);
  });
  // NEGATIVE CONTROL: with a line, it still resolves.
  test('the same file WITH a line still resolves', () => {
    expect(resolveCitation([{ path: 'src/real.ts', line: 3 }], ROOT)).toBe(true);
  });
  test('a HIGH kill citing a file but no line is downgraded', () => {
    const r = v({ disproven: true, confidence_after_check: 95, reason: 'guarded in src/real.ts' });
    expect(r.verdict).toBe('CANNOT_VERIFY');
  });
});

describe('trailing newline does not invent a final line (round 2, MEDIUM)', () => {
  // src/real.ts is "a\nb\nc\nd\ne\n" — five real lines, split() reports six.
  test('line 5 (the last real line) resolves', () => {
    expect(resolveCitation([{ path: 'src/real.ts', line: 5 }], ROOT)).toBe(true);
  });
  test('line 6 (the phantom from the trailing newline) does NOT resolve', () => {
    expect(resolveCitation([{ path: 'src/real.ts', line: 6 }], ROOT)).toBe(false);
  });
});
