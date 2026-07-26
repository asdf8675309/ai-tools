/**
 * Crucible — Python Tabify Preprocessor (R10)
 *
 * Replaces leading 4-space indents with single tabs in Python source. A general
 * purpose BPE tokenizer assigns a separate token to every leading space, so a
 * 4-space Python indent costs 4 tokens per level; one tab costs 1. Reported
 * saving on a typical Python class is roughly 30% of the file's tokens.
 *
 * No semantic change. Python treats tabs and 4-space indents identically when
 * the file uses a consistent indent style, and most editors render a tab as 4
 * columns, so readability is preserved.
 *
 * SKIP when the target model has a code-tuned tokenizer (Codex variants,
 * DeepSeek-Coder, Code Llama, StarCoder, Qwen-Coder) — those already fuse
 * multi-space runs into single tokens, so tabify is a no-op or net negative.
 *
 * Usage:
 *   import { tabifyPython, shouldTabify } from "./TabifyPython.ts";
 *   if (shouldTabify(targetModel)) source = tabifyPython(source);
 *
 * CLI:
 *   bun tools/TabifyPython.ts <file.py>            # tabified source to stdout
 *   bun tools/TabifyPython.ts --stats <file.py>    # token-savings estimate
 */

import { readFileSync } from "fs";
import { loadConfig } from "./Config.ts";

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Replace 4-space leading indents with tabs on every line. Trailing whitespace
 * preserved. Mid-line alignment whitespace preserved. Lines that don't start
 * with at least 4 spaces are returned unchanged.
 */
export function tabifyPython(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      // Leading spaces only — lines mixing tabs and spaces are left alone
      const match = line.match(/^( +)(.*)$/);
      if (!match) return line;
      const spaces = match[1] ?? "";
      const rest = match[2] ?? "";
      const indentLevel = Math.floor(spaces.length / 4);
      const remainder = spaces.length % 4;
      return "\t".repeat(indentLevel) + " ".repeat(remainder) + rest;
    })
    .join("\n");
}

/**
 * Should tabify be applied for this target model? False for known code-tuned
 * tokenizers where multi-space sequences already fuse.
 */
export function shouldTabify(targetModel: string | undefined): boolean {
  if (!targetModel) return true; // safe default — assume general-purpose
  const lower = targetModel.toLowerCase();
  if (lower.includes("codex")) return false;
  if (lower.includes("deepseek-coder")) return false;
  if (lower.includes("code-llama") || lower.includes("codellama")) return false;
  if (lower.includes("qwen") && lower.includes("coder")) return false;
  if (lower.includes("starcoder")) return false;
  return true;
}

/** Estimate token savings from tabify. Crude — chars/4 stands in for a tokenizer. */
export function estimateSavings(source: string): {
  beforeChars: number;
  afterChars: number;
  beforeTokensApprox: number;
  afterTokensApprox: number;
  reductionPct: number;
} {
  const before = source;
  const after = tabifyPython(source);
  const beforeTokens = Math.ceil(before.length / 4);
  const afterTokens = Math.ceil(after.length / 4);
  const reductionPct = beforeTokens === 0
    ? 0
    : +((1 - afterTokens / beforeTokens) * 100).toFixed(2);
  return {
    beforeChars: before.length,
    afterChars: after.length,
    beforeTokensApprox: beforeTokens,
    afterTokensApprox: afterTokens,
    reductionPct,
  };
}

// ── Config integration ──────────────────────────────────────────────────────

/**
 * Entry point used by Crucible workflows. Honors the `flags.python_tabify`
 * config knob and the per-model tokenizer gate.
 *
 * Line-for-line only. An earlier version also collapsed blank-line runs and
 * fused adjacent imports; both shift every subsequent line, so a reviewer
 * reading the result cites line numbers that do not exist in the real file.
 * A few saved tokens are not worth findings that point at the wrong line.
 */
export function preprocessPythonForReview(
  source: string,
  targetModel?: string,
): { source: string; applied: boolean; reason?: string } {
  const cfg = loadConfig();
  if (!cfg.flags.python_tabify) {
    return { source, applied: false, reason: "python_tabify flag disabled in config.yaml" };
  }
  if (!shouldTabify(targetModel)) {
    return {
      source,
      applied: false,
      reason: `target model ${targetModel} has a code-tuned tokenizer; tabify is no-op or net negative`,
    };
  }
  return { source: tabifyPython(source), applied: true };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const stats = args.includes("--stats");
  const filePath = args.find((a) => !a.startsWith("--"));
  if (!filePath) {
    console.error("Usage: bun TabifyPython.ts <file.py> [--stats]");
    process.exit(1);
  }
  const source = readFileSync(filePath, "utf8");
  if (stats) {
    console.log(JSON.stringify(estimateSavings(source), null, 2));
  } else {
    process.stdout.write(tabifyPython(source));
  }
}
