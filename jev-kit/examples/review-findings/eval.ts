#!/usr/bin/env bun
// Scores the review-findings corpus through Jev and reports separation.
//
// The question is framed so the case we want to catch is TRUE: "this finding is
// a false positive". A high score therefore means drop it. That direction
// matters more here than in most gates, because the two errors are not
// symmetric — a wrongly-kept finding costs a reviewer a minute, while a wrongly
// dropped one is never looked at again. The reported threshold reflects that.
//
//   bun run findings:eval [--limit N] [--concurrency 3]

import { decide, maxGate } from '../../src/decide';

type Row = { id: string; severity: string; file: string; line: number; title: string;
  why: string; label: 'real' | 'false_positive'; family: string; hard?: boolean };

const args = process.argv.slice(2);
const num = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const CONCURRENCY = Math.min(num('--concurrency', 3), 3);
const LIMIT = num('--limit', 0);

const corpusPath = new URL('./corpus.jsonl', import.meta.url).pathname;
let rows: Row[] = (await Bun.file(corpusPath).text()).trim().split('\n').map((l) => JSON.parse(l));
if (LIMIT) rows = rows.slice(0, LIMIT);

// A battery, not one compound question. The first version of this eval asked a
// single noul listing five disqualifiers at once and scored -0.120 separation —
// the WRONG direction, at chance. The model was reading how technical the text
// sounded rather than answering a five-way disjunction, so the most mechanism-
// dense real defects scored highest on "is this a false positive".
//
// This is the SDE cascade the vendor's own cookbook prescribes: one narrow
// question per failure mode, aggregated with max. Each is framed so the bad
// case is TRUE, which is what makes max meaningful.
const BATTERY = {
  evidence_is_comment: {
    type: 'noul' as const,
    instructions: 'The finding\'s only support is a comment, docstring or README text rather than the behaviour of the code itself.',
  },
  never_confirmed: {
    type: 'noul' as const,
    instructions: 'The finding states that it could not locate, read or confirm the relevant code, and reasons from an assumption instead.',
  },
  mechanics_not_risk: {
    type: 'noul' as const,
    instructions: 'The finding describes how a pattern, matcher or tool is written, without establishing that any real input reaches it.',
  },
  title_overreaches: {
    type: 'noul' as const,
    instructions: 'The finding\'s title claims a more severe problem than its own body describes.',
  },
  abstract_advice: {
    type: 'noul' as const,
    instructions: 'The finding deviates from general best practice rather than from a convention this codebase itself follows.',
  },
  already_fixed: {
    type: 'noul' as const,
    instructions: 'The finding is filed against a version of the code that the change under review has already replaced.',
  },
  no_mechanism: {
    type: 'noul' as const,
    instructions: 'The finding does not name any specific mechanism by which the code produces a wrong result.',
  },
};

const scored: Array<Row & { score: number; top?: string }> = [];
let failed = 0;

async function score(r: Row): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await decide({
      role: 'jevkit-review-findings',
      state: `severity: ${r.severity}\nfile: ${r.file}:${r.line}\ntitle: ${r.title}\n\n${r.why}`,
      questions: BATTERY,
    });
    if (res.ok && res.answers) {
      // max, never a mean: one confident disqualifier is enough, and averaging
      // seven heads buries the single head that fired.
      const gate = maxGate(res.answers, 1.01);
      // `scored`, not `isFinite`: value starts at 0, so isFinite is ALWAYS true
      // and a response carrying no usable noul would be recorded as a genuine
      // score of 0 — a model failure entering the corpus as a confident "not a
      // false positive".
      if (gate.scored > 0) {
        scored.push({ ...r, score: gate.value, top: gate.top });
        return;
      }
    }
    // A throttle is not a bad row. Back off and retry rather than counting it
    // as a failure, which would silently shrink the measured corpus.
    if (res.status === 429 || (res.status ?? 500) >= 500) {
      await Bun.sleep(600 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    break;
  }
  failed++;
}

console.error(`scoring ${rows.length} findings (concurrency ${CONCURRENCY})...`);
for (let i = 0; i < rows.length; i += CONCURRENCY) {
  await Promise.all(rows.slice(i, i + CONCURRENCY).map(score));
  if ((i + CONCURRENCY) % 30 === 0) console.error(`  ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length}`);
}

if (failed) console.error(`\n${failed} rows failed to score`);
// A headline number computed over a corpus that partly failed to score is not
// a result for that corpus. Refuse rather than print something quotable.
const lossRate = failed / rows.length;
if (lossRate > 0.1) {
  console.error(`REFUSING to report: ${(lossRate * 100).toFixed(0)}% of rows failed to score. ` +
    `Any accuracy computed on the remainder is a number for a different, smaller corpus.`);
  process.exit(1);
}
if (scored.length < 2) { console.error('too few scored rows'); process.exit(1); }

const mean = (a: Array<{ score: number }>) => a.reduce((s, r) => s + r.score, 0) / a.length;
const real = scored.filter((r) => r.label === 'real');
const fp = scored.filter((r) => r.label === 'false_positive');

/** Balanced accuracy: mean of true-negative and true-positive rate, so class
 * imbalance cannot flatter the number. */
function balanced(t: number, set: typeof scored): number {
  const a = set.filter((r) => r.label === 'real');
  const b = set.filter((r) => r.label === 'false_positive');
  if (!a.length || !b.length) return 0;
  return (a.filter((r) => r.score < t).length / a.length + b.filter((r) => r.score >= t).length / b.length) / 2;
}

let best = 0, bestT = 0;
for (let t = 0; t <= 1.0001; t += 0.01) { const v = balanced(t, scored); if (v > best) { best = v; bestT = t; } }

/** The asymmetric threshold: the lowest cut at which no real defect is dropped.
 * This is the number a disprove gate should actually ship, because a wrongly
 * dropped finding is never revisited. */
let safeT = 1.0;
for (let t = 1.0; t >= 0; t -= 0.01) {
  if (real.every((r) => r.score < t)) safeT = t; else break;
}
const caughtAtSafe = fp.filter((r) => r.score >= safeT).length;

console.log(`\nscored ${scored.length}/${rows.length}  (real ${real.length}, false-positive ${fp.length})`);
console.log(`\nmean score  real ${mean(real).toFixed(3)}   false-positive ${mean(fp).toFixed(3)}   separation ${(mean(fp) - mean(real)).toFixed(3)}`);
console.log(`\nbest balanced accuracy   ${(best * 100).toFixed(1)}%  at threshold ${bestT.toFixed(2)}`);
const hard = scored.filter((r) => r.hard);
if (hard.length) console.log(`  on hard rows (n=${hard.length})       ${(balanced(bestT, hard) * 100).toFixed(1)}%`);

console.log(`\nzero-false-drop threshold ${safeT.toFixed(2)} — catches ${caughtAtSafe}/${fp.length} (${(caughtAtSafe / fp.length * 100).toFixed(0)}%) of false positives with 0/${real.length} real defects dropped`);

const byFamily = new Map<string, { n: number; sum: number }>();
for (const r of scored) {
  const e = byFamily.get(r.family) ?? { n: 0, sum: 0 };
  byFamily.set(r.family, { n: e.n + 1, sum: e.sum + r.score });
}
console.log('\nmean score by family:');
for (const [f, e] of [...byFamily.entries()].sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)) {
  console.log(`  ${(e.sum / e.n).toFixed(2)}  ${f} (n=${e.n})`);
}

await Bun.write(new URL('./corpus-scored.jsonl', import.meta.url).pathname,
  scored.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`\nper-row scores written to examples/review-findings/corpus-scored.jsonl`);

