/**
 * The two editions must agree on what deletes a finding.
 *
 * They did not. `crucible.workflow.js` carried zero occurrences of "disagree"
 * while its own meta.description asserted "full feature parity", and the prose
 * edition's cross-vendor split rule — the one mechanism that keeps a forced
 * consensus from silently removing a finding — existed in only one of them.
 * The assertion is what stopped anyone looking, so it is now a test.
 *
 * These are structural source assertions, deliberately tolerant: they match on
 * the load-bearing token rather than on exact formatting, because a parity test
 * that false-fails on whitespace gets deleted and takes its coverage with it.
 * They prove a rule is PRESENT in both editions, never that it behaves — the
 * behaviour is DisproveVerdict.test.ts's job.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(join(SKILL, rel), 'utf8');

/** Strip // and /* *\/ comments so a rule mentioned only in prose cannot pass. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

const workflow = read('workflows/crucible.workflow.js');
const workflowCode = code(workflow);
const fullReview = read('workflows/FullReview.md');
const disprovePrompt = read('tools/DisproveSubagentPrompt.md');

describe('both editions resolve verdicts through the same tool', () => {
  test('the workflow edition shells out to DisproveVerdict.ts', () => {
    expect(workflowCode).toContain('tools/DisproveVerdict.ts');
  });

  test('the prose edition names the same tool', () => {
    expect(fullReview).toContain('DisproveVerdict.ts');
  });

  test('both pass the citation threshold through', () => {
    expect(workflowCode).toContain('require_citation_min_severity');
    expect(fullReview).toContain('require_citation_min_severity');
  });
});

describe('only DISPROVEN_EVIDENCE removes a finding', () => {
  test('the workflow survivor filter keys on the verdict, not the old boolean+floor', () => {
    const survivors = workflowCode.match(/const survivors\s*=.*/)?.[0] ?? '';
    expect(survivors).toContain('DISPROVEN_EVIDENCE');
    // The regression this replaces: `!c.disproven && confidence >= FLOOR`,
    // which deleted a finding whenever the verdict was merely uncertain.
    expect(survivors).not.toMatch(/CONFIDENCE_FLOOR/);
  });

  test('the prose edition states the same rule', () => {
    expect(fullReview).toMatch(/leaves the pipeline only on .*DISPROVEN_EVIDENCE/);
  });
});

describe('a cross-vendor split survives in BOTH editions (the parity gap that shipped)', () => {
  test('the workflow edition knows what a disagreement is', () => {
    // This was literally 0 before the fix, while the description claimed parity.
    expect(workflowCode).toContain('disagreement');
  });

  test('the prose edition routes it to a human', () => {
    expect(fullReview).toContain('disagreement: true');
    expect(fullReview).toMatch(/vendor-disagreement/);
  });

  test('neither edition collapses a split by taking a MIN', () => {
    expect(workflowCode).not.toMatch(/MIN of the two/);
    expect(fullReview).not.toMatch(/confidence_after_check = the MIN/);
  });
});

describe('the disprove contract no longer contradicts itself', () => {
  test('the prompt does not promise a drop it no longer performs', () => {
    expect(disprovePrompt).not.toContain('will drop the finding regardless');
  });

  test('the prompt pins the confidence scale so 0.95 is not read as 95', () => {
    expect(disprovePrompt).toMatch(/0\.95 (does not mean|is not) 95/);
  });
});

describe('the parity list itself exists', () => {
  test('the description points at a section that is really there', () => {
    expect(workflow).toContain('Parity with FullReview.md');
    // Present in the body, not only in the meta.description that names it.
    const body = workflow.slice(workflow.indexOf('\n', workflow.indexOf('description:')));
    expect(body).toContain('Parity with FullReview.md');
  });
});
