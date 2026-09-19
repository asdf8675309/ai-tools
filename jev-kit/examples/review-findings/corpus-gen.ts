#!/usr/bin/env bun
// Generates a synthetic, labelled corpus of code-review findings for the review-findings example:
// deciding whether a reviewer's finding is a real defect or a false positive.
//
// Everything here is invented. The VALUE is in the taxonomy, not the text: both
// classes are drawn from failure shapes observed repeatedly in real multi-model
// review loops, so the corpus tests the distinction that actually costs time
// rather than an easy one.
//
// Deterministic: `--seed 42` reproduces byte-identically.
//
//   bun run findings:gen

const seedArg = process.argv.indexOf('--seed');
const SEED = seedArg >= 0 ? Number(process.argv[seedArg + 1]) : 42;

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry(SEED);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;

const FILES = ['src/router.ts', 'src/queue/worker.ts', 'pkg/store/index.ts', 'lib/auth/session.ts',
  'src/parser/tokens.ts', 'internal/cache/lru.ts', 'src/handlers/upload.ts', 'pkg/config/load.ts'] as const;
const FNS = ['resolveRoute', 'flushQueue', 'parseHeader', 'loadConfig', 'normalizeKey',
  'applyMigration', 'buildIndex', 'checkQuota'] as const;
const SEV = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

type Row = { id: string; severity: string; file: string; line: number; title: string; why: string;
  label: 'real' | 'false_positive'; family: string; hard?: boolean };

// ── real defect families ───────────────────────────────────────────────────
// Each names a failure shape that genuinely bites, stated the way a good
// reviewer states it: a specific mechanism, not a vibe.
const REAL: Array<(f: string, fn: string, n: number) => { title: string; why: string; family: string; hard?: boolean }> = [
  (f, fn, n) => ({
    family: 'partial-update-no-rollback',
    title: 'Partial write leaves the store inconsistent',
    why: `${fn} writes and verifies each record independently. If a later write throws, earlier records stay changed and nothing rolls back, so a mid-loop failure leaves the store in a state the caller believes is atomic. The doc comment above ${f}:${n} claims all-or-nothing.`,
  }),
  (_f, fn, _n) => ({
    family: 'widened-failure-path',
    title: 'Error path now returns a partial result',
    why: `${fn} used to return null on failure and now returns a partial object with an id. Three call sites branch on the absence of that object, so each will read the failure as a success. No type error catches this because the field was optional already.`,
  }),
  (f, fn, n) => ({
    family: 'absence-probe-cannot-fail',
    title: 'The guard can never report a violation',
    why: `The check at ${f}:${n} greps for a pattern that the surrounding code no longer emits, so it returns zero hits on every input and the suite stays green. Its pass condition is an absence that was never proven able to fail.`,
    hard: true,
  }),
  (f, fn, _n) => ({
    family: 'claim-decoupled-from-claimed',
    title: 'Reported count is not the count that ran',
    why: `${fn} reports the configured roster length rather than the number of items that actually executed. When a member is skipped the report is unchanged, so the log asserts work that did not happen. Deriving the number from the executed set would fix it.`,
    hard: true,
  }),
  (f, fn, _n) => ({
    family: 'cwd-relative-path',
    title: 'Path resolves against the working directory',
    why: `${fn} loads its data file with a bare relative path, so it only works when invoked from ${f.split('/')[0]}/. The documented command runs from the repo root and will fail with ENOENT.`,
  }),
  (_f, fn, _n) => ({
    family: 'unchecked-status',
    title: 'HTTP status is never checked before parsing',
    why: `${fn} passes the response body straight to JSON.parse without reading res.ok. A 429 body is not JSON, so a throttle is indistinguishable from a malformed payload and the retry path never triggers.`,
  }),
  (f, fn, n) => ({
    family: 'shared-mutable-state',
    title: 'Module-level cache is shared across tenants',
    why: `The map declared at ${f}:${n} is module scope, so entries written for one tenant are readable by the next request regardless of caller. ${fn} keys on the record id alone, which is not tenant-scoped.`,
  }),
];

// ── false-positive families ────────────────────────────────────────────────
// Drawn from the ways review findings are actually wrong. These are written to
// SOUND rigorous, because the ones that sound sloppy were never the problem.
const FP: Array<(f: string, fn: string, n: number) => { title: string; why: string; family: string; hard?: boolean }> = [
  (f, fn, n) => ({
    family: 'evidence-is-a-comment',
    title: 'Rollback appears to be unimplemented',
    why: `The comment above ${f}:${n} says "TODO: transactional", which suggests ${fn} does not roll back. The behaviour itself was not examined.`,
    hard: true,
  }),
  (f, fn, n) => ({
    family: 'gate-mechanics-not-risk',
    title: 'Validation rule does not match this input shape',
    why: `The validator's pattern at ${f}:${n} would not match a key containing a dot. Whether such a key can reach ${fn} was not established; the finding is about the matcher's syntax rather than about any input that occurs.`,
    hard: true,
  }),
  (_f, fn, _n) => ({
    family: 'self-invalidating',
    title: 'Possible missing authorization check',
    why: `I could not locate the signature for ${fn}, so I could not confirm whether an authorization argument is passed. On the assumption that it is not, this would be an access-control gap.`,
  }),
  (f, fn, n) => ({
    family: 'stale-against-prefix-code',
    title: 'Deprecated helper still in use',
    why: `${f}:${n} calls the old helper, which was scheduled for removal. This is filed against the pre-change version of the file; the current diff already replaced that call.`,
  }),
  (_f, fn, _n) => ({
    family: 'title-escalates-beyond-body',
    title: 'Unintended privilege escalation',
    why: `The README describes ${fn} as internal-only while the exported symbol is public. This is a documentation and intent mismatch; no caller outside the package was found and no privilege is actually granted.`,
    hard: true,
  }),
  (f, fn, n) => ({
    family: 'abstract-best-practice',
    title: 'Missing input validation layer',
    why: `${fn} does not validate its arguments with a schema library. The codebase does not use schema validation anywhere in this package and validates at the boundary instead, so this deviates from general advice rather than from the codebase's own pattern.`,
  }),
  (f, fn, n) => ({
    family: 'style-as-defect',
    title: 'Inconsistent error construction',
    why: `${f}:${n} throws a bare Error while neighbouring modules use a typed error class. Behaviour is unchanged and both are caught by the same handler.`,
  }),
];

const rows: Row[] = [];
let i = 0;
const TARGET_PER_CLASS = 100;

while (rows.filter((r) => r.label === 'real').length < TARGET_PER_CLASS) {
  const f = pick(FILES), fn = pick(FNS), n = 20 + Math.floor(rand() * 400);
  const body = pick(REAL)(f, fn, n);
  rows.push({ id: `R-${String(++i).padStart(3, '0')}`, severity: pick(SEV), file: f, line: n, label: 'real', ...body });
}
while (rows.filter((r) => r.label === 'false_positive').length < TARGET_PER_CLASS) {
  const f = pick(FILES), fn = pick(FNS), n = 20 + Math.floor(rand() * 400);
  const body = pick(FP)(f, fn, n);
  rows.push({ id: `F-${String(++i).padStart(3, '0')}`, severity: pick(SEV), file: f, line: n, label: 'false_positive', ...body });
}

for (const r of rows) console.log(JSON.stringify(r));
