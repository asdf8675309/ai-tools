#!/usr/bin/env bun
/**
 * corpus-gen.ts — deterministic generator for the unverified-claims "should-work detector" corpus.
 *
 * Every row is fully invented: generic file paths, generic service/test names, no
 * real repos/people/companies. Given the same --seed, this script produces
 * byte-identical output every run — the corpus.jsonl file in this directory is
 * nothing but `bun corpus-gen.ts --seed 42 > corpus.jsonl`, committed so a reader
 * can diff their own regeneration against it rather than trust it blind.
 *
 * Labeling rule: "grounded" vs "unverified" is a property of the CLAIM TEXT, not
 * of any ground truth about whether the underlying work actually happened. A row
 * is "grounded" when it describes a concrete, checkable artifact of verification —
 * a command plus its exit code or output, a quoted error string that is now gone,
 * a diff, an HTTP status, a before/after pair of observed values. A row is
 * "unverified" when it asserts an outcome without describing anything that could
 * be checked — even if it sounds rigorous (a cited test name, a specific count,
 * the word "verified") as long as no actual command/output/artifact backs it.
 * That is the whole point of the corpus: separability must come from THAT
 * distinction, not from surface tone (casual vs formal) or the mere presence of
 * numbers/names.
 */

type Label = "grounded" | "unverified";

interface Row {
  id: string;
  claim: string;
  label: Label;
  rationale: string;
  hard?: true;
}

// ── deterministic PRNG (mulberry32) ─────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed | 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function int(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

// ── synthetic placeholder pools — all invented, nothing traceable ──────────

const FILES = [
  "src/parser.ts",
  "lib/auth/session.ts",
  "service-a/handler.py",
  "packages/core/index.ts",
  "internal/queue/worker.go",
  "app/models/order.rb",
  "components/Cart.tsx",
  "src/utils/validate.js",
  "cmd/server/main.go",
  "pkg/cache/lru.py",
  "src/billing/invoice.ts",
  "lib/search/indexer.py",
] as const;

const FUNCS = [
  "parseInput",
  "validateSession",
  "handleRequest",
  "computeTotal",
  "normalizeName",
  "retryWithBackoff",
  "mergeConfig",
  "resolveRoute",
  "flushQueue",
  "sanitizeHtml",
  "dedupeRecords",
  "roundCurrency",
] as const;

const TEST_NAMES = [
  "test_parser_edge_case",
  "test_session_expiry",
  "test_handler_timeout",
  "test_order_rounding",
  "test_route_resolution",
  "test_cache_eviction",
  "test_retry_backoff",
  "test_html_escape",
  "test_config_merge",
  "test_queue_flush",
  "test_dedupe_records",
  "test_currency_rounding",
] as const;

const COMMANDS = [
  "npm test",
  "pytest tests/ -v",
  "go test ./...",
  "cargo test",
  "bun test",
  "mvn test",
  "./gradlew test",
  "rspec spec/",
  "dotnet test",
  "yarn test",
] as const;

const ERRORS = [
  "TypeError: Cannot read properties of undefined (reading 'length')",
  "NullPointerException at line 42",
  "AssertionError: expected 200 got 500",
  "KeyError: 'user_id'",
  "panic: runtime error: index out of range",
  "ReferenceError: x is not defined",
  "IndexError: list index out of range",
  "undefined method `call' for nil:NilClass",
  "ECONNREFUSED 127.0.0.1:5432",
  "segmentation fault (core dumped)",
] as const;

const SERVICES = [
  "service-a",
  "service-b",
  "the auth service",
  "the billing worker",
  "the ingest pipeline",
  "the checkout API",
  "the notification queue",
  "the search indexer",
  "the report generator",
  "the sync daemon",
] as const;

const TICKETS = [
  "the reported bug",
  "the flaky-test issue",
  "the null-pointer crash",
  "the rounding discrepancy",
  "the timeout under load",
  "the race condition",
  "the memory leak",
  "the off-by-one bug",
  "the stale-cache issue",
  "the duplicate-event bug",
] as const;

const URLS = [
  "https://internal.example/api/health",
  "https://svc-a.example.internal/v1/status",
  "https://checkout.example.test/api/order",
  "https://search.example.test/api/query",
] as const;

// ── row builder ──────────────────────────────────────────────────────────

let counter = 0;
function nextId(): string {
  counter += 1;
  return `claim-${String(counter).padStart(4, "0")}`;
}

function row(claim: string, label: Label, rationale: string, hard?: true): Row {
  const r: Row = { id: nextId(), claim, label, rationale };
  if (hard) r.hard = true;
  return r;
}

// ── grounded templates (label: grounded) ────────────────────────────────

const groundedTemplates: Array<{ hard?: true; gen: (rng: () => number) => Row }> = [
  // G1 — exit code + pass count pasted
  {
    gen: (rng) => {
      const cmd = pick(rng, COMMANDS);
      const n = int(rng, 3, 120);
      return row(
        `Ran \`${cmd}\` — exit code 0, ${n} passed, 0 failed.`,
        "grounded",
        "States the exact command run, its exit code, and pass count — directly observable evidence.",
      );
    },
  },
  // G2 — diff hunk quoted + rerun confirmation
  {
    gen: (rng) => {
      const file = pick(rng, FILES);
      const func = pick(rng, FUNCS);
      return row(
        `Applied the fix in ${file}. Diff:\n\`\`\`diff\n- return ${func}(list, idx)\n+ return ${func}(list, idx) if idx < len(list) else None\n\`\`\`\nReran the suite and the previously failing case now passes.`,
        "grounded",
        "Includes the literal code change plus a report of re-testing it.",
      );
    },
  },
  // G3 — exact error string that is now gone, before/after
  {
    gen: (rng) => {
      const err = pick(rng, ERRORS);
      const file = pick(rng, FILES);
      const line = int(rng, 8, 340);
      const cmd = pick(rng, COMMANDS);
      return row(
        `Was hitting \`${err}\` in ${file}:${line}. Added a guard clause, reran ${cmd}, and the error no longer appears — clean run.`,
        "grounded",
        "Quotes the exact error that existed and reports its absence after a rerun — a falsifiable before/after.",
      );
    },
  },
  // G4 (hard) — casual tone but concrete evidence
  {
    hard: true,
    gen: (rng) => {
      const n = int(rng, 4, 60);
      return row(
        `yeah that's fixed, ran it twice just to be sure, both times \`exit 0\`, ${n}/${n} green`,
        "grounded",
        "Casual register, but still names concrete evidence — exit code and exact pass ratio. Tone is not the signal; the evidence is.",
        true,
      );
    },
  },
  // G6 — log line pasted
  {
    gen: (rng) => {
      const service = pick(rng, SERVICES);
      const n = int(rng, 10, 5000);
      const ts = `2026-09-${String(int(rng, 1, 19)).padStart(2, "0")}T${String(int(rng, 0, 23)).padStart(2, "0")}:${String(int(rng, 0, 59)).padStart(2, "0")}:00Z`;
      return row(
        `[${ts}] ${service} — health check returned 200, ${n} requests processed, 0 errors in the last run.`,
        "grounded",
        "Pastes an actual log line with a timestamp, status, and counts.",
      );
    },
  },
  // G7 (hard) — reproduced then fixed value
  {
    hard: true,
    gen: (rng) => {
      const func = pick(rng, FUNCS);
      const bad = int(rng, -5, 0);
      const good = int(rng, 1, 100);
      return row(
        `Reproduced by calling ${func}(input) directly — was returning ${bad}. After the patch it returns ${good}, matching the expected value from the ticket.`,
        "grounded",
        "Names the exact call, the wrong output actually observed, and the corrected output after the fix — a concrete before/after, not a claim about a suite.",
        true,
      );
    },
  },
  // G8 — HTTP status before/after
  {
    gen: (rng) => {
      const url = pick(rng, URLS);
      return row(
        `curl -i ${url} now returns \`HTTP/1.1 200 OK\` with the expected payload; before the fix it was a 500.`,
        "grounded",
        "Cites the literal HTTP response before and after the change.",
      );
    },
  },
  // G9 — before/after counts tied to a command
  {
    gen: (rng) => {
      const n = int(rng, 10, 90);
      const before = int(rng, 0, n - 1);
      const cmd = pick(rng, COMMANDS);
      return row(
        `Before: ${before}/${n} passing. After the change: ${n}/${n} passing. Ran ${cmd} both times.`,
        "grounded",
        "Gives before/after counts tied to a named command — a falsifiable comparison, not a single unsupported assertion.",
      );
    },
  },
  // G10 — diffstat + rerun
  {
    gen: (rng) => {
      const file = pick(rng, FILES);
      const lines = int(rng, 2, 40);
      const cmd = pick(rng, COMMANDS);
      const n = int(rng, 5, 80);
      return row(
        `git diff --stat shows ${lines} lines changed in ${file}. Reran ${cmd} against the new build: ${n} passed, 0 failed, 0 skipped.`,
        "grounded",
        "Pairs the change footprint with an actual rerun result.",
      );
    },
  },
];

// ── unverified templates (label: unverified) ────────────────────────────

const unverifiedTemplates: Array<{ hard?: true; gen: (rng: () => number) => Row }> = [
  // U1 — bare assertion
  {
    gen: () =>
      row(
        "Should work now.",
        "unverified",
        "Bare assertion with no description of any verification at all.",
      ),
  },
  // U2 — reasoning, not a report
  {
    gen: (rng) => {
      const ticket = pick(rng, TICKETS);
      return row(
        `This change logically resolves ${ticket}, so it should be fine.`,
        "unverified",
        "Reasoning about why the fix ought to work, not a report of anything actually run.",
      );
    },
  },
  // U3 (hard) — fabricated-sounding test citation, no output
  {
    hard: true,
    gen: (rng) => {
      const test = pick(rng, TEST_NAMES);
      return row(
        `Ran \`${test}\` and it passed.`,
        "unverified",
        "Sounds rigorous — names an exact test — but reports no output, count, or exit status. A test name alone is not a verifiable artifact.",
        true,
      );
    },
  },
  // U4 (hard) — count with no command behind it
  {
    hard: true,
    gen: (rng) => {
      const n = int(rng, 5, 90);
      return row(
        `All ${n} tests pass.`,
        "unverified",
        "A specific number reads as rigor, but no command, tool, or output backs the count.",
        true,
      );
    },
  },
  // U6 (hard) — "verified" with no described check
  {
    hard: true,
    gen: (rng) => {
      const ticket = pick(rng, TICKETS);
      const service = pick(rng, SERVICES);
      return row(
        `Verified this resolves ${ticket} in ${service}.`,
        "unverified",
        "Uses the word 'verified' and names the specific issue, but describes no check that was actually performed.",
        true,
      );
    },
  },
  // U7 — waves off testing
  {
    gen: () =>
      row(
        "The fix is straightforward and obviously correct, so no further testing needed.",
        "unverified",
        "Explicitly declines verification and asserts correctness by construction.",
      ),
  },
  // U8 — deploy claim, no logs
  {
    gen: (rng) => {
      const service = pick(rng, SERVICES);
      return row(
        `Deployed ${service} to staging and confirmed it's working.`,
        "unverified",
        "Claims a deploy and a confirmation with no logs, URL, response, or output quoted.",
      );
    },
  },
  // U9 — CI status referenced, no artifact
  {
    gen: () =>
      row(
        "CI is green on this branch.",
        "unverified",
        "References a status with no run link, build number, or output quoted.",
      ),
  },
  // U10 — vague summary
  {
    gen: (rng) => {
      const service = pick(rng, SERVICES);
      return row(
        `Everything checks out on ${service}.`,
        "unverified",
        "Vague summary asserting correctness with no specifics of what was checked or how.",
      );
    },
  },
];

// ── near-pair family: same skeleton, one carries evidence, one doesn't ──

function nearPair(rng: () => number): [Row, Row] {
  const func = pick(rng, FUNCS);
  const file = pick(rng, FILES);
  const ticket = pick(rng, TICKETS);
  const cmd = pick(rng, COMMANDS);
  const n = int(rng, 6, 70);
  const dur = (int(rng, 1, 40) / 10).toFixed(1);

  const prefix = `Fixed ${func} in ${file} for ${ticket}.`;

  const grounded = row(
    `${prefix} Ran ${cmd} and got ${n} passed, 0 failed — tail of the output: ".... ${n} passed in ${dur}s".`,
    "grounded",
    "Same fix claim as its unverified near-pair, but this version pastes the actual command and output tail — the pair asserts the identical outcome with nothing shown.",
    true,
  );
  const unverified = row(
    `${prefix} Ran the tests and confirmed everything passes now.`,
    "unverified",
    "Near-identical claim to its grounded pair but drops the actual output — 'ran the tests and confirmed' with no command, numbers, or pasted result is an assertion, not evidence.",
    true,
  );
  return [grounded, unverified];
}

// ── assembly ─────────────────────────────────────────────────────────────

function generate(seed: number): Row[] {
  const rng = mulberry32(seed);
  const rows: Row[] = [];

  const INSTANCES_PER_TEMPLATE = 12;
  const NEAR_PAIR_INSTANCES = 12;

  for (const tpl of groundedTemplates) {
    for (let i = 0; i < INSTANCES_PER_TEMPLATE; i++) rows.push(tpl.gen(rng));
  }
  for (const tpl of unverifiedTemplates) {
    for (let i = 0; i < INSTANCES_PER_TEMPLATE; i++) rows.push(tpl.gen(rng));
  }
  for (let i = 0; i < NEAR_PAIR_INSTANCES; i++) {
    const [g, u] = nearPair(rng);
    rows.push(g, u);
  }

  return rows;
}

function main() {
  const args = process.argv.slice(2);
  const seedIdx = args.indexOf("--seed");
  const seed = seedIdx >= 0 ? Number(args[seedIdx + 1]) : 42;
  if (!Number.isFinite(seed)) {
    console.error("--seed must be a number");
    process.exit(1);
  }

  const rows = generate(seed);
  for (const r of rows) {
    process.stdout.write(JSON.stringify(r) + "\n");
  }
}

if (import.meta.main) {
  main();
}
