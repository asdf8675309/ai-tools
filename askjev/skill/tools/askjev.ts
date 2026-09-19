#!/usr/bin/env bun
// AskJev CLI — takes a framed decision payload on stdin, calls TypeSafe Jev via
// the Cloudflare Workers AI `ai/run` endpoint, and prints an honest report.
//
// This file is deliberately dumb. The hard part — turning an open question into
// a well-framed payload — is the model's job, done in skill/SKILL.md *before*
// this tool runs. This tool's only opinions are structural ones it can actually
// enforce: `framedBy` is required, probabilities are never collapsed to a single
// winner, and a close top-two is called out rather than hidden.
//
// Usage:
//   echo '{"state": "...", "framedBy": "...", "questions": {...}}' | bun askjev.ts
//   bun askjev.ts payload.json

import { decide, maxGate, type JevAnswer, type JevQuestion } from './decide.ts';

interface AskJevInput {
  /** What's actually being decided — the framed state, not raw conversation. */
  state: string;
  /** Who wrote the options/state below. Required — a decision tool that hides
   * its own framing bias is worse than no tool. Examples: "the assistant, no
   * options declined by name", "the user", "assistant + user jointly". */
  framedBy: string;
  questions: Record<string, JevQuestion>;
  /** Restrict maxGate escalation reporting to these keys (default: all `noul`
   * questions in the payload). */
  gateKeys?: string[];
  /** Escalation threshold for the max-gate summary line. Default 0.5. */
  gateThreshold?: number;
}

const CLOSE_MARGIN = 0.15; // heuristic display threshold, not a measured constant

function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

function fail(message: string): never {
  console.error(`askjev: ${message}`);
  process.exit(1);
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function renderAnswer(key: string, q: JevQuestion, a: JevAnswer): string {
  const lines: string[] = [`\n## ${key} (${q.type})`, `> ${q.instructions}`];

  if (a.type === 'noul' && typeof a.noul === 'number') {
    lines.push(`probability(true): ${formatPct(a.noul)}`);
    lines.push('note: noul carries no confidence field — the probability IS the calibration signal.');
    return lines.join('\n');
  }

  if (a.type === 'choice' && a.probabilities) {
    const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]);
    lines.push(`winner: ${a.choice} (confidence ${a.confidence !== undefined ? formatPct(a.confidence) : 'n/a'})`);
    lines.push('full spread:');
    for (const [opt, p] of ranked) lines.push(`  - ${opt}: ${formatPct(p)}`);
    if (ranked.length >= 2) {
      const [, top] = ranked[0]!;
      const [, second] = ranked[1]!;
      if (top - second < CLOSE_MARGIN) {
        lines.push(`⚠️  top two are within ${formatPct(CLOSE_MARGIN)} of each other — this reads as a genuinely open question, not a settled one.`);
      }
    }
    return lines.join('\n');
  }

  if (a.type === 'score' && typeof a.score === 'number') {
    lines.push(`score: ${a.score.toFixed(2)} (confidence ${a.confidence !== undefined ? formatPct(a.confidence) : 'n/a'})`);
    if (a.legend) {
      lines.push('legend:');
      for (const [idx, desc] of Object.entries(a.legend)) lines.push(`  [${idx}] ${desc}`);
    }
    return lines.join('\n');
  }

  lines.push(`(unrecognized answer shape: ${JSON.stringify(a)})`);
  return lines.join('\n');
}

async function main() {
  const argPath = process.argv[2];
  const raw = argPath ? await Bun.file(argPath).text() : await readStdin();

  let input: AskJevInput;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    fail(`payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!input.state || typeof input.state !== 'string') fail('"state" is required and must be a string');
  if (!input.framedBy || typeof input.framedBy !== 'string' || !input.framedBy.trim()) {
    fail('"framedBy" is required — state who wrote the options/state being judged (see skill/SKILL.md § Framing discipline)');
  }
  if (!input.questions || typeof input.questions !== 'object' || Object.keys(input.questions).length === 0) {
    fail('"questions" is required and must be a non-empty object');
  }

  const noulKeys = Object.entries(input.questions)
    .filter(([, q]) => q.type === 'noul')
    .map(([k]) => k);
  if (noulKeys.length > 1) {
    // Not a hard block — some batteries legitimately mix a couple of noul
    // checks with a choice/score decision — but a battery this size sharing
    // one instructions string is exactly the compound-question failure mode
    // this tool exists to avoid. Warn loudly rather than silently proceed.
    console.error(`askjev: note — ${noulKeys.length} noul questions in this batch (${noulKeys.join(', ')}). Confirm each is a SEPARATE narrow disqualifier, not one compound question split cosmetically. Aggregate with max, never mean.`);
  }

  const result = await decide({ state: input.state, questions: input.questions, role: 'askjev' });

  console.log(`# AskJev decision\n`);
  console.log(`Framed by: ${input.framedBy}`);
  console.log('(Whoever writes the options tends to win them. Weigh this result accordingly.)');

  if (!result.ok) {
    if (result.status === 429) {
      console.error(`askjev: throttled (HTTP 429) — ${result.error}`);
    } else {
      console.error(`askjev: request failed — ${result.error}`);
    }
    process.exit(1);
  }

  const answers = result.answers!;
  for (const [key, q] of Object.entries(input.questions)) {
    const a = answers[key];
    if (!a) {
      console.log(`\n## ${key} (${q.type})\n(no answer returned for this key)`);
      continue;
    }
    console.log(renderAnswer(key, q, a));
  }

  if (noulKeys.length > 0) {
    const gate = maxGate(answers, input.gateThreshold ?? 0.5, input.gateKeys ?? noulKeys);
    console.log(`\n## escalation (max over ${noulKeys.length} noul question${noulKeys.length === 1 ? '' : 's'})`);
    console.log(`max probability: ${formatPct(gate.value)}${gate.top ? ` (driven by "${gate.top}")` : ''}`);
    console.log(`fired at threshold ${input.gateThreshold ?? 0.5}: ${gate.fired}`);
  }

  console.log(`\n(${result.durationMs}ms, ${result.usage?.input_tokens ?? '?'} in / ${result.usage?.output_tokens ?? '?'} out tokens)`);
}

if (import.meta.main) {
  main();
}
