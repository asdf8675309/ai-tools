/**
 * Pass-2 disprove verdict resolution.
 *
 * The disprove filter's highest-consequence decision — delete this finding —
 * was reachable three ways that all look like success in a log:
 *
 *   1. A kill verdict that cites no code. Measured at roughly four in five kills across real runs. An agent that cannot find the code will tell
 *      you the code is fine.
 *   2. A verdict whose confidence arrived on a 0-1 scale into a 0-100 field.
 *      Seen repeatedly in real runs; one read "Finding is valid" at 0.95 and was
 *      compared against a floor of 80.
 *   3. A `disproven: true` issued below the floor. Seen repeatedly. The floor
 *      gated survival but never gated the kill, so uncertainty had exactly one
 *      outcome in both directions: the finding disappeared.
 *
 * Everything here is pure except `resolveCitation`, which stats the tree under
 * review. `disproven` is still emitted so existing consumers keep working, and
 * anything unrecognized resolves to AGREE — surface, never drop.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type Verdict = 'AGREE' | 'DISPROVEN_EVIDENCE' | 'CANNOT_VERIFY';

export const SEVERITY_RANK: Record<string, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export interface RawVerdict {
  id: string;
  disproven?: boolean | null;
  confidence_after_check?: number | null;
  reason?: string | null;
  failed?: boolean;
  disproven_cross_vendor?: boolean | null;
  confidence_cross_vendor?: number | null;
}

export interface ResolveOptions {
  /** Absolute path to the tree under review. Citations resolve against it. */
  repoRoot: string;
  /** Phase 5 confidence floor. */
  floor: number;
  /** Kills at or above this severity must cite resolvable code. */
  requireCitationMinSeverity: string;
  /** Candidate severity, used against requireCitationMinSeverity. */
  severity?: string;
}

export interface ResolvedVerdict {
  id: string;
  verdict: Verdict;
  /** Back-compat: true only for DISPROVEN_EVIDENCE. */
  disproven: boolean;
  confidence: number;
  /** Surfaced but not adjudicated. Renders as the disprove-unverified flag. */
  unverified: boolean;
  /** The two vendors split. Survives, routes to human review. */
  disagreement: boolean;
  reason: string;
  /** Present when the raw verdict was downgraded, naming why. */
  downgradeReason?: string;
}

// Only real source extensions. A citation requirement satisfied by README.md
// or a yaml file is not evidence that the code was read.
const CITATION = /([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|sql|sh|rs|go|java|rb|c|h|cpp|cs|php|swift|kt|scala|sc))(?::(\d+))?/g;

/**
 * A confidence in (0,1] is out of contract. The field is documented 0-100, so
 * such a value is either a scale collision or meaningless — and we cannot tell
 * which. Rescaling would be a guess; comparing it against the floor deletes the
 * finding. Neither is acceptable, so it becomes CANNOT_VERIFY.
 */
export function isOutOfContract(c: number | null | undefined): boolean {
  if (typeof c !== 'number' || !Number.isFinite(c)) return true;
  if (c > 0 && c <= 1) return true;
  return c < 0 || c > 100;
}

export function extractCitations(reason: string | null | undefined): Array<{ path: string; line?: number }> {
  if (!reason) return [];
  const out: Array<{ path: string; line?: number }> = [];
  for (const m of reason.matchAll(CITATION)) {
    const path = m[1];
    if (!path) continue;
    out.push({ path, line: m[2] ? Number(m[2]) : undefined });
  }
  return out;
}

/**
 * Path-segment-aware containment. `startsWith` is not sufficient: for root
 * `/a/repo`, the string `/a/repo-evil/x.ts` starts with it but is outside it.
 */
export function contains(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  if (c === r) return true;
  const rel = relative(r, c);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}

/** True when at least one citation names a file that exists, at a line in range. */
export function resolveCitation(
  citations: Array<{ path: string; line?: number }>,
  repoRoot: string,
): boolean {
  // Canonicalize the root too. On macOS `tmpdir()` is /var/... which realpath
  // resolves to /private/var/..., so comparing a realpath'd candidate against a
  // raw root rejects every legitimate citation. Caught by the negative controls.
  let root: string;
  try {
    root = realpathSync(resolve(repoRoot));
  } catch {
    root = resolve(repoRoot);
  }
  for (const c of citations) {
    const abs = isAbsolute(c.path) ? c.path : resolve(root, c.path);
    // Containment must be path-segment-aware, not a string prefix: a sibling
    // directory whose name EXTENDS the root ("<root>-evil") satisfies
    // startsWith() and escapes the tree. Reproduced before this fix.
    if (!contains(root, abs)) continue;
    if (!existsSync(abs)) continue;
    // Resolve symlinks and re-check. existsSync/statSync both follow links, so
    // a link inside the tree pointing outside it would otherwise pass.
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue;
    }
    if (!contains(root, real)) continue;
    let st;
    try {
      st = statSync(real);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (c.line === undefined) return true;
    if (c.line < 1) continue;
    try {
      const lines = readFileSync(real, 'utf8').split('\n').length;
      if (c.line <= lines) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Fails CLOSED. An unrecognized severity or a misconfigured threshold used to
 * return false, which silently disabled the evidence gate for every candidate —
 * a config typo turning off a security control with no error. Unknown now means
 * "require the citation".
 */
function needsCitation(severity: string | undefined, min: string): boolean {
  const s = SEVERITY_RANK[(severity ?? '').toUpperCase()];
  const m = SEVERITY_RANK[(min ?? '').toUpperCase()];
  if (m === undefined) return true;
  if (s === undefined) return true;
  return s >= m;
}

export function resolveVerdict(raw: RawVerdict, opts: ResolveOptions): ResolvedVerdict {
  // A NaN/Infinity/missing floor makes every `< floor` comparison false and
  // quietly disables the confidence gate. Fall back to the documented default.
  const floor =
    typeof opts.floor === 'number' && Number.isFinite(opts.floor) && opts.floor >= 0
      ? opts.floor
      : 80;
  opts = { ...opts, floor };
  const base = { id: raw.id, reason: raw.reason ?? '', disagreement: false };
  const cannot = (why: string): ResolvedVerdict => ({
    ...base,
    verdict: 'CANNOT_VERIFY',
    disproven: false,
    confidence: opts.floor,
    unverified: true,
    downgradeReason: why,
  });

  // 1. The call died. Pre-existing fail-open path, kept.
  if (raw.failed === true) return cannot('disprove call failed');

  // 2. Out-of-contract confidence. Cannot be compared against the floor.
  if (isOutOfContract(raw.confidence_after_check)) {
    return cannot(
      raw.confidence_after_check === null || raw.confidence_after_check === undefined
        ? 'no confidence returned'
        : `confidence ${raw.confidence_after_check} is outside the documented 0-100 contract`,
    );
  }
  const confidence = raw.confidence_after_check as number;

  // 3. Cross-vendor split. The disagreement is itself the signal: survive,
  //    flag, route to a human. Never resolve it by picking a side.
  if (
    typeof raw.disproven_cross_vendor === 'boolean' &&
    typeof raw.disproven === 'boolean' &&
    raw.disproven_cross_vendor !== raw.disproven
  ) {
    return {
      ...base,
      verdict: 'AGREE',
      disproven: false,
      confidence: Math.max(confidence, opts.floor),
      unverified: false,
      disagreement: true,
      downgradeReason: 'vendors split on this candidate — human review',
    };
  }

  // 4. A kill.
  if (raw.disproven === true) {
    // When a second vendor agreed, its confidence must clear the bar too. It
    // was previously collected and never read, so a cross-vendor kill at
    // confidence 10 rode in on the primary's 95.
    // Only when a cross-vendor confidence was actually returned. An absent one
    // means the augmentation did not report, and augmentation never blocks —
    // fall back to the primary verdict alone.
    if (
      raw.disproven_cross_vendor === true &&
      raw.confidence_cross_vendor != null &&
      isOutOfContract(raw.confidence_cross_vendor)
    ) {
      return cannot('cross-vendor verdict returned an out-of-contract confidence');
    }
    if (
      raw.disproven_cross_vendor === true &&
      typeof raw.confidence_cross_vendor === 'number' &&
      raw.confidence_cross_vendor < opts.floor
    ) {
      return cannot(
        `cross-vendor kill at confidence ${raw.confidence_cross_vendor}, below floor ${opts.floor}`,
      );
    }
    // A kill issued below the floor is not confident enough to delete anything.
    if (confidence < opts.floor) {
      return cannot(`kill verdict issued at confidence ${confidence}, below floor ${opts.floor}`);
    }
    if (needsCitation(opts.severity, opts.requireCitationMinSeverity)) {
      const cites = extractCitations(raw.reason);
      if (!resolveCitation(cites, opts.repoRoot)) {
        return cannot(
          cites.length === 0
            ? 'kill verdict cites no code'
            : 'kill verdict cites code that does not resolve in the tree under review',
        );
      }
    }
    return { ...base, verdict: 'DISPROVEN_EVIDENCE', disproven: true, confidence, unverified: false };
  }

  // 5. Not disproven, but under the floor. This is the largest measured class: the
  //    model said keep and the floor deleted it anyway. Surface it flagged.
  if (confidence < opts.floor) {
    return cannot(`finding stands but confidence ${confidence} is below floor ${opts.floor}`);
  }

  // 6. Anything else — including an unrecognized shape — surfaces.
  return { ...base, verdict: 'AGREE', disproven: false, confidence, unverified: false };
}

/** A candidate survives Phase 5 unless it was positively disproven with evidence. */
export function survives(v: ResolvedVerdict): boolean {
  return v.verdict !== 'DISPROVEN_EVIDENCE';
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// The workflow edition runs as a plain-JS script with no filesystem access, so
// it cannot import this module. It shells out here instead, which also keeps
// the highest-consequence decision in tested code rather than in prose an
// agent executes.
//
//   bun DisproveVerdict.ts --repo-root <abs> --floor 80 \
//     --require-citation-min-severity HIGH --verdicts <file.json|-> 
//
// Input:  [{ id, severity, disproven, confidence_after_check, reason, ... }]
// Output: { resolved: [ResolvedVerdict & { severity }], summary: {...} }

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i++, next) : 'true';
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args['repo-root'] ?? process.cwd();
  const floor = Number(args.floor ?? 80);
  const requireCitationMinSeverity = args['require-citation-min-severity'] ?? 'HIGH';
  const src = args.verdicts ?? '-';

  const rawText =
    src === '-'
      ? await new Response(Bun.stdin.stream()).text()
      : readFileSync(src, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // A malformed payload must never be read as "nothing to surface".
    console.error('DisproveVerdict: could not parse verdicts JSON');
    process.exit(2);
  }
  const list: Array<RawVerdict & { severity?: string }> = Array.isArray(parsed)
    ? (parsed as Array<RawVerdict & { severity?: string }>)
    : ((parsed as { verdicts?: Array<RawVerdict & { severity?: string }> }).verdicts ?? []);

  const resolved = list.map((raw) => ({
    ...resolveVerdict(raw, { repoRoot, floor, requireCitationMinSeverity, severity: raw.severity }),
    severity: raw.severity,
  }));

  const summary = {
    total: resolved.length,
    killed: resolved.filter((r) => r.verdict === 'DISPROVEN_EVIDENCE').length,
    surfaced: resolved.filter((r) => r.verdict === 'AGREE').length,
    unverified: resolved.filter((r) => r.verdict === 'CANNOT_VERIFY').length,
    disagreements: resolved.filter((r) => r.disagreement).length,
    downgraded_uncited: resolved.filter((r) => r.downgradeReason?.includes('cites no code')).length,
    downgraded_out_of_contract: resolved.filter((r) => r.downgradeReason?.includes('outside the documented')).length,
  };

  console.log(JSON.stringify({ resolved, summary }, null, 2));
}

if (import.meta.main) {
  await main();
}
