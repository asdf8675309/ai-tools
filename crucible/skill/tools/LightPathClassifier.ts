/**
 * Crucible — Light-Path Classifier
 *
 * Deterministic "is this diff provably inert?" classifier. A diff is LIGHT only
 * when EVERY changed file is content-only (extension in the allow-list, or exact
 * path in allow_paths) AND the added-LOC total is under the ceiling. Anything
 * else is FULL. Deny-by-default: an unrecognized extension always forces FULL.
 *
 * `classifyDiff` is PURE (files + addedLoc + config → verdict) so it is unit- and
 * property-testable in isolation. `getDiffFiles` is the only I/O — it shells out
 * to git; a failure THROWS so callers fail closed.
 *
 * CLI:
 *   bun tools/LightPathClassifier.ts classify [--base <ref>] [--json]
 */

import { extname } from "path";
import { emitOutcome, flagValue, type CliOutcome } from "./Cli.ts";
import { numstatTotals } from "./GitDiff.ts";
import { loadLightPathConfig, type LightPathConfig } from "./Config.ts";

export type { CliOutcome };

export type Verdict = "light" | "full";
export interface Classification {
  verdict: Verdict;
  reason: string;
}

/**
 * Behavior-steering documents. In an agent-first repo a Markdown file is
 * frequently NOT inert — CLAUDE.md, AGENTS.md, SKILL.md, agent/command
 * instruction docs, and anything under .claude/ or .github/ change how agents
 * (including Crucible's own review) behave. These force the FULL review even
 * though their extension is allow-listed. HARDCODED, never config-widenable.
 */
export const BEHAVIOR_DOC_RE =
  /(^|\/)(CLAUDE|AGENTS|GEMINI)\.md$|(^|\/)SKILL\.md$|(^|\/)copilot-instructions\.md$|(^|\/)\.cursorrules$|(^|\/)\.claude\/|(^|\/)\.github\/|(^|\/)commands\/|(^|\/)agents\//i;

/**
 * Pure classification. Deny-by-default: the FIRST non-inert file forces FULL, so
 * a diff is LIGHT only if the allow-list covers every file and LOC is under budget.
 */
export function classifyDiff(files: string[], addedLoc: number, cfg: LightPathConfig): Classification {
  if (!cfg.enabled) return { verdict: "full", reason: "light-path disabled" };
  if (files.length === 0) return { verdict: "full", reason: "empty diff — nothing to bypass" };

  const allowExt = new Set(cfg.allow_extensions.map((e) => e.toLowerCase()));
  const allowPath = new Set(cfg.allow_paths);

  for (const f of files) {
    // Checked first so a behavior doc can never be dialed off via allow_paths.
    if (BEHAVIOR_DOC_RE.test(f)) return { verdict: "full", reason: `behavior-steering doc: ${f}` };
    if (allowPath.has(f)) continue;
    const ext = extname(f).toLowerCase();
    if (ext && allowExt.has(ext)) continue;
    return { verdict: "full", reason: `non-inert file: ${f}` };
  }

  if (addedLoc > cfg.max_loc) {
    return { verdict: "full", reason: `${addedLoc} added LOC > ceiling ${cfg.max_loc}` };
  }
  return { verdict: "light", reason: `${files.length} inert file(s), ${addedLoc} added LOC` };
}

export interface DiffStat {
  files: string[];
  addedLoc: number;
}

/**
 * Read the changed files + added-LOC for `<base>...HEAD` via `git diff --numstat`.
 * Binary files (numstat added "-") contribute 0 LOC but still appear in `files`,
 * so their non-doc extension forces FULL through classifyDiff. Throws on any git
 * failure (missing base ref, not a repo) — callers fail closed.
 */
export function getDiffFiles(cwd: string, base = "origin/main"): DiffStat {
  // --no-renames: a rename must land as delete(old)+add(new) on clean
  // single-path lines, or `git mv code.ts doc.md` reaches classifyDiff as the
  // path `code.ts => doc.md`, whose extname reads `.md` — a code change waved
  // through as docs. See GitDiff.ts for the rest of the flag rationale.
  const { files, addedLoc } = numstatTotals(cwd, base, { noRenames: true });
  return { files, addedLoc };
}

// ── CLI ──
// stdout: "light" | "full"   (bare, for shell gating)
// stderr: reason             (audit)

/**
 * CLI body, returning what it would print rather than printing it. Extracted so
 * the fail-closed branch — the one that decides whether an unreadable diff can
 * skip review — is assertable in-process; the `import.meta.main` block below is
 * then just plumbing.
 *
 * `loadCfg` is a thunk, not a value, so the config load stays INSIDE the try: a
 * faulting config must fail closed to `full` exactly like an unreadable diff.
 */
export function runClassifyCli(
  argv: string[],
  cwd: string,
  loadCfg: () => LightPathConfig,
): CliOutcome {
  if (argv[0] !== "classify") {
    return {
      stdout: "",
      stderr: "usage: bun LightPathClassifier.ts classify [--base <ref>] [--json]",
      exitCode: 1,
    };
  }
  const base = flagValue(argv, "--base", "origin/main");
  const asJson = argv.includes("--json");
  try {
    const { files, addedLoc } = getDiffFiles(cwd, base);
    const result = classifyDiff(files, addedLoc, loadCfg());
    if (asJson) {
      return { stdout: JSON.stringify({ ...result, files, addedLoc }, null, 2), stderr: "", exitCode: 0 };
    }
    return { stdout: result.verdict, stderr: `// ${result.verdict}: ${result.reason}`, exitCode: 0 };
  } catch (e) {
    // Fail closed: a diff we cannot read is NOT light.
    return { stdout: "full", stderr: `// full: classifier error — ${(e as Error).message}`, exitCode: 0 };
  }
}

if (import.meta.main) {
  emitOutcome(runClassifyCli(process.argv.slice(2), process.cwd(), loadLightPathConfig));
}
