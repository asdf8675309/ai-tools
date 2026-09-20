#!/usr/bin/env bun
// Smoke test: exercises all three question shapes against the live model and
// asserts the contract each one is documented to have. Exits non-zero on any
// failure, so it is usable as a CI gate.
//
//   CF_ACCOUNT_ID=... CF_API_TOKEN=... bun src/smoke.ts

import { decide, maxGate, confidenceBand, type JevAnswer } from './decide';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const res = await decide({
  role: 'jev-kit-smoke',
  state: [
    'The deploy finished and the health endpoint returns 200.',
    'The migration was applied to production at 14:02 UTC.',
    'All 412 tests should pass now.',
  ].join('\n'),
  questions: {
    unsupported_claim: {
      type: 'noul',
      instructions: 'The text asserts a result that no evidence in the text supports.',
    },
    kind: {
      type: 'choice',
      instructions: 'What kind of statement is this overall?',
      criteria: {
        verified: 'every claim is backed by a stated observation',
        partial: 'some claims are observed, others merely asserted',
        asserted: 'claims are stated with no observation behind them',
      },
    },
    rigour: {
      type: 'score',
      instructions: 'How rigorous is the evidence offered?',
      // ARRAY, lowest first. A record is rejected with HTTP 400.
      criteria: [
        'no evidence at all',
        'vague gestures at evidence',
        'specific but unverifiable references',
        'concrete, checkable observations',
      ],
    },
  },
});

if (!res.ok) {
  console.error(`request failed: ${res.error}`);
  process.exit(1);
}
console.log(`\nresponded in ${res.durationMs}ms, input_tokens=${res.usage?.input_tokens ?? '?'}\n`);

const a = res.answers as Record<string, JevAnswer>;

// noul: a calibrated probability, and deliberately NO confidence field.
const n = a.unsupported_claim;
check('noul returns a number in [0,1]', typeof n?.noul === 'number' && n.noul >= 0 && n.noul <= 1, `noul=${n?.noul}`);
check('noul carries NO confidence field', n?.confidence === undefined, `confidence=${n?.confidence}`);

// choice: one of the offered keys, plus a confidence and a probability spread.
const c = a.kind;
check('choice returns one of the offered options', ['verified', 'partial', 'asserted'].includes(c?.choice ?? ''), `choice=${c?.choice}`);
check('choice carries confidence', typeof c?.confidence === 'number', `confidence=${c?.confidence}`);
check('choice carries probabilities', !!c?.probabilities && Object.keys(c.probabilities).length > 1);

// score: an interpolated float across the rubric, not an index, plus a legend.
const s = a.rigour;
check('score returns a number within the rubric range', typeof s?.score === 'number' && s.score >= 0 && s.score <= 3, `score=${s?.score}`);
check('score carries a legend mapping index -> level', !!s?.legend && Object.keys(s.legend).length === 4);

// Helpers are pure, so they assert without spending a call.
check('maxGate fires at or above threshold', maxGate({ x: { type: 'noul', noul: 0.9 } }, 0.8).fired === true);
check('maxGate holds below threshold', maxGate({ x: { type: 'noul', noul: 0.7 } }, 0.8).fired === false);
check('maxGate takes the max, not the mean',
  maxGate({ lo: { type: 'noul', noul: 0.1 }, hi: { type: 'noul', noul: 0.95 } }, 0.8).top === 'hi');
check('confidenceBand routes three ways',
  confidenceBand(0.95, 0.9, 0.5) === 'act' &&
  confidenceBand(0.7, 0.9, 0.5) === 'review' &&
  confidenceBand(0.2, 0.9, 0.5) === 'hold');
check('confidenceBand treats a missing confidence as review', confidenceBand(undefined, 0.9, 0.5) === 'review');

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
