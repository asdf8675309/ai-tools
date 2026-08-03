/**
 * Crucible — Removal Tracking Gate (R12)
 *
 * Detects the "AI adds, doesn't subtract" pattern. Empirical work on
 * AI-authored pull requests finds they remove far less existing code than
 * human-authored ones and add more LOC than they remove — leaving redundancy
 * behind even on PRs that look productive on the surface.
 *
 * This tool runs in Phase 1 alongside CodebasePatternsScanner. It computes the
 * diff's added-vs-removed LOC ratio and the added-vs-removed multi-line-string
 * count. When the ratio exceeds the configured threshold AND the PR author was
 * classified as an agent (R4 PRAuthorClassifier), it emits a Code-Quality
 * candidate that joins the Pass 1 fan-out.
 *
 * The candidate is NOT a vulnerability — it's a structural signal for the
 * reviewer agent: "this PR is heavily additive; verify the new code isn't
 * duplicating existing logic." Pairs with R1 (SemanticCloneDetector), which
 * catches the specific duplicate instances.
 *
 * Usage:
 *   import { computeRemovalRatio, emitRemovalCandidate } from "./RemovalTrackingGate.ts";
 *   const stats = computeRemovalRatio({ sinceRef: "origin/main" });
 *   const candidate = emitRemovalCandidate(stats, { agentAuthor: "claude" });
 *
 * CLI:
 *   bun tools/RemovalTrackingGate.ts --since origin/main --pr 145
 */

import { flagValue } from "./Cli.ts";
import { numstatTotals, unifiedDiff } from "./GitDiff.ts";
import { loadConfig } from "./Config.ts";
import type { AgentAuthor } from "./PRAuthorClassifier.ts";

// ── Public types ────────────────────────────────────────────────────────────

export interface DiffStats {
  added_loc: number;
  removed_loc: number;
  added_multiline_strings: number;
  removed_multiline_strings: number;
  add_remove_ratio: number;
  files_changed: number;
}

export interface RemovalCandidate {
  id: string;
  severity: "MEDIUM" | "LOW";
  category: "High Add/Remove Ratio (R12)";
  file: string;
  line: number;
  evidence: string;
  deviation_from: string;
  initial_confidence: number;
  impact: number;
  effort_to_fix: number;
}

// ── Diff stats ──────────────────────────────────────────────────────────────

/**
 * Compute LOC + multi-line-string add/remove counts from the diff. Multi-line
 * strings are counted heuristically (template literals, triple-quoted strings)
 * rather than by parsing.
 */
export function computeRemovalRatio(opts: {
  sinceRef?: string;
  cwd?: string;
}): DiffStats {
  const since = opts.sinceRef ?? "origin/main";
  const cwd = opts.cwd ?? process.cwd();

  // Renames are NOT split here (unlike the classifiers): a rename genuinely
  // removes as much as it adds, and splitting it would inflate the additive
  // signal this gate exists to measure.
  const { files, addedLoc: added_loc, removedLoc: removed_loc } = numstatTotals(cwd, since);
  const files_changed = files.length;

  const fullDiff = unifiedDiff(cwd, since);
  const added_multiline_strings = countMultilineStringsInHunk(fullDiff, "+");
  const removed_multiline_strings = countMultilineStringsInHunk(fullDiff, "-");

  const add_remove_ratio = removed_loc === 0
    ? added_loc // nothing removed — the raw added count stands in as the ratio
    : +(added_loc / removed_loc).toFixed(2);

  return { added_loc, removed_loc, added_multiline_strings, removed_multiline_strings, add_remove_ratio, files_changed };
}

/**
 * Count multi-line strings inside hunk lines starting with the given prefix —
 * template literals, triple-quoted strings — counted when the literal opens on
 * a hunk-prefixed line and closes on a later one.
 */
function countMultilineStringsInHunk(diff: string, prefix: "+" | "-"): number {
  let count = 0;
  let insideMultiline = false;
  let openDelim = "";

  for (const line of diff.split("\n")) {
    if (!line.startsWith(prefix) || line.startsWith(`${prefix}${prefix}`)) {
      // ++/-- is a file header; leaving the prefix scope resets the literal
      if (insideMultiline) {
        insideMultiline = false;
        openDelim = "";
      }
      continue;
    }
    const body = line.slice(1);

    if (!insideMultiline) {
      if (/`[^`]*$/.test(body)) {
        insideMultiline = true;
        openDelim = "`";
      } else if (/"""[^"]*$/.test(body) || /'''[^']*$/.test(body)) {
        insideMultiline = true;
        openDelim = body.includes(`"""`) ? `"""` : `'''`;
      }
    } else if (body.includes(openDelim)) {
      count++;
      insideMultiline = false;
      openDelim = "";
    }
  }
  return count;
}

// ── Emit candidate ──────────────────────────────────────────────────────────

/** Convert diff stats to a Pass 1 candidate, or null when the gate doesn't fire. */
export function emitRemovalCandidate(
  stats: DiffStats,
  opts: { agentAuthor: AgentAuthor; authorConfidence?: number },
): RemovalCandidate | null {
  const cfg = loadConfig();

  // Gate 1: the signal needs a classified agent author to mean anything, so it
  // rides on the same flag rather than carrying one of its own.
  if (!cfg.flags.agent_author_profile) return null;

  // Gate 2: ratio threshold
  if (stats.add_remove_ratio < cfg.thresholds.removal_tracking_max_ratio) return null;

  // Gate 3: agent author classified with reasonable confidence
  if (opts.agentAuthor === "unknown") return null;
  if ((opts.authorConfidence ?? 0) < 70) return null;

  // Gate 4: minimum size — on a tiny PR the ratio is noise
  if (stats.added_loc < 50) return null;

  const severity: "MEDIUM" | "LOW" =
    stats.add_remove_ratio >= cfg.thresholds.removal_tracking_max_ratio * 2 ? "MEDIUM" : "LOW";

  return {
    id: "R12-1",
    severity,
    category: "High Add/Remove Ratio (R12)",
    file: "(PR-wide)",
    line: 0,
    evidence:
      `PR adds ${stats.added_loc} LOC, removes ${stats.removed_loc} LOC ` +
      `(ratio ${stats.add_remove_ratio.toFixed(2)}× over ${stats.files_changed} files); ` +
      `multi-line strings: ${stats.added_multiline_strings} added vs ${stats.removed_multiline_strings} removed. ` +
      `Agent-authored PRs measurably add without subtracting — verify the new code doesn't duplicate existing logic. ` +
      `Author classified as agent (${opts.agentAuthor}, confidence ${opts.authorConfidence}%). ` +
      `Pair with SemanticCloneDetector output for specific duplicate instances.`,
    deviation_from: `(none — structural signal, not a path comparison)`,
    initial_confidence: severity === "MEDIUM" ? 85 : 75,
    impact: severity === "MEDIUM" ? 5 : 3,
    effort_to_fix: 4,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun RemovalTrackingGate.ts [--since <ref>] [--pr <N>]");
    process.exit(0);
  }
  const since = flagValue(args, "--since", "origin/main");
  const prIdx = args.indexOf("--pr");
  const prArg = prIdx >= 0 ? args[prIdx + 1] : undefined;

  const stats = computeRemovalRatio({ sinceRef: since });
  console.log("=== Diff Stats ===");
  console.log(JSON.stringify(stats, null, 2));

  if (prArg) {
    const { classifyFromPR } = await import("./PRAuthorClassifier.ts");
    const auth = classifyFromPR(parseInt(prArg, 10));
    console.log("\n=== Author Classification ===");
    console.log(JSON.stringify(auth, null, 2));
    const candidate = emitRemovalCandidate(stats, {
      agentAuthor: auth.agent,
      authorConfidence: auth.confidence,
    });
    console.log("\n=== Removal Candidate ===");
    console.log(candidate ? JSON.stringify(candidate, null, 2) : "(no candidate — gate did not fire)");
  } else {
    console.log("\n(use --pr <N> to also classify author and emit gate candidate)");
  }
}
