#!/usr/bin/env bun
// Sabotage arm for the review-findings disprove gate.
//
// A measured accuracy is only meaningful if the measurement could have come out
// badly. This flips every label in the scored corpus and re-runs the identical
// sweep: if separation survives a full label flip, the metric was never reading
// the labels and the headline number means nothing.
//
// Two rules this file exists to enforce:
//   1. Assert the arm APPLIED before reading its number. A sabotage whose edit
//      silently failed reports the baseline and reads as a redundant control.
//   2. Compare counts, not exit codes. Both arms "run fine"; only the numbers differ.
//
//   bun run findings:sabotage
// exit 0 = sabotage bites (good), 1 = it does not (the metric is broken)

import { readFileSync } from 'node:fs';

type Row = { id: string; label: 'real' | 'false_positive'; score: number; hard?: boolean };

const path = new URL('./corpus-scored.jsonl', import.meta.url).pathname;
const rows: Row[] = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
if (rows.length === 0) { console.error('empty corpus'); process.exit(1); }

/** Balanced accuracy at a threshold: the mean of true-negative and true-positive
 * rate, so a class imbalance cannot flatter the result. */
function balanced(t: number, set: Row[]): number {
  const g = set.filter((r) => r.label === 'real');
  const u = set.filter((r) => r.label === 'false_positive');
  if (!g.length || !u.length) return 0;
  const tnr = g.filter((r) => r.score < t).length / g.length;
  const tpr = u.filter((r) => r.score >= t).length / u.length;
  return (tnr + tpr) / 2;
}

function sweep(set: Row[]): { best: number; threshold: number } {
  let best = 0, threshold = 0;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const v = balanced(t, set);
    if (v > best) { best = v; threshold = t; }
  }
  return { best, threshold };
}

const base = sweep(rows);

const flipped: Row[] = rows.map((r) => ({ ...r, label: r.label === 'real' ? 'false_positive' : 'real' }));
const changed = flipped.filter((r, i) => r.label !== rows[i].label).length;
if (changed !== rows.length) {
  console.error(`ARM DID NOT APPLY: ${changed}/${rows.length} labels flipped — the result below would be meaningless`);
  process.exit(1);
}
console.log(`sabotage arm APPLIED: ${changed}/${rows.length} labels flipped`);

const sab = sweep(flipped);
console.log(`\n  baseline   threshold ${base.threshold.toFixed(2)}   balanced accuracy ${(base.best * 100).toFixed(1)}%`);
console.log(`  sabotaged  threshold ${sab.threshold.toFixed(2)}   balanced accuracy ${(sab.best * 100).toFixed(1)}%`);

// Chance is 50%. A flipped corpus should not beat it by any meaningful margin.
const bites = sab.best < 0.60 && base.best > 0.80;
console.log(bites
  ? '\nSABOTAGE BITES — separation collapses to chance, so the baseline is measuring the labels'
  : '\nSABOTAGE DID NOT BITE — the headline number is not reading the labels');
// ── ARM 2: constant scores ────────────────────────────────────────────────
// Flipping labels proves the metric reads the LABELS. It does not prove the
// metric reads the MODEL. Replacing every score with a constant answers the
// second question: if accuracy survives that, the number was never about the
// model's output at all. Two arms, because one cannot tell a load-bearing
// control from a decorative one.
const flat: Row[] = rows.map((r) => ({ ...r, score: 0.5 }));
const changedScores = flat.filter((r, i) => r.score !== rows[i].score).length;
if (changedScores === 0) {
  console.error('ARM 2 DID NOT APPLY: no score changed — result below would be meaningless');
  process.exit(1);
}
console.log(`\narm 2 APPLIED: ${changedScores}/${rows.length} scores replaced with a constant`);
const flatSweep = sweep(flat);
console.log(`  constant-score  threshold ${flatSweep.threshold.toFixed(2)}   balanced accuracy ${(flatSweep.best * 100).toFixed(1)}%`);
const arm2Bites = flatSweep.best < 0.60;
console.log(arm2Bites
  ? '  ARM 2 BITES — accuracy collapses without real scores'
  : '  ARM 2 DID NOT BITE — the headline number does not depend on the model output');

process.exit(bites && arm2Bites ? 0 : 1);
