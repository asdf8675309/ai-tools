/**
 * `args` normalization in crucible.workflow.js.
 *
 * Workflow scripts have no module system, so this extracts the real IIFE source
 * from the shipped file and evaluates it. Reimplementing the normalization would
 * only prove the reimplementation works.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = join(import.meta.dir, "..", "workflows", "crucible.workflow.js");

function workflowSource(): string {
  return readFileSync(WORKFLOW, "utf8");
}

function extractArgsNormalizer(): string {
  const src = workflowSource();
  const start = src.indexOf("const ARGS = (() => {");
  if (start === -1) throw new Error("ARGS normalizer not found in crucible.workflow.js");
  const end = src.indexOf("})()", start);
  if (end === -1) throw new Error("ARGS normalizer has no closing '})()'");
  return src.slice(start, end + 4);
}

/** Run the REAL normalizer source against a given `args` value. */
function normalize(argsValue: unknown): Record<string, unknown> {
  const fn = new Function("args", `${extractArgsNormalizer()}\nreturn ARGS`);
  return fn(argsValue) as Record<string, unknown>;
}

describe("ARGS normalization", () => {
  test("the normalizer is actually present in the shipped workflow", () => {
    // Guards the extraction: a deleted or renamed IIFE fails loudly here rather
    // than silently testing nothing.
    expect(extractArgsNormalizer()).toContain("JSON.parse");
  });

  test("args delivered as a JSON string still resolves repo", () => {
    const out = normalize('{"repo":"/tmp/some-repo","pr":42}');
    expect(out.repo).toBe("/tmp/some-repo");
    expect(out.pr).toBe(42);
  });

  test("args delivered as an object still resolves repo", () => {
    const out = normalize({ repo: "/tmp/some-repo", pr: 42 });
    expect(out.repo).toBe("/tmp/some-repo");
    expect(out.pr).toBe(42);
  });

  test("absent args yields an empty object, never a throw", () => {
    expect(normalize(undefined)).toEqual({});
    expect(normalize(null)).toEqual({});
  });

  test("malformed JSON string degrades to {} instead of throwing", () => {
    expect(normalize("{not valid json")).toEqual({});
  });

  test("regression: a JSON string must NOT leave repo undefined", () => {
    // The exact bug: `args?.repo` on a string returned undefined, IN_REPO became
    // '', and every agent ran in the launch cwd. A silent no-op, not an error.
    expect(normalize('{"repo":"/pinned"}').repo).not.toBeUndefined();
  });
});

describe("every option reads through the normalizer", () => {
  // An option still reading the raw global keeps the original bug. Assert on the
  // shipped text, not a hand-maintained list, since options get added over time.
  test("no option reads the raw `args` global outside the normalizer itself", () => {
    const lines = workflowSource().split("\n");
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      const code = line.split("//")[0] ?? "";           // strip trailing comments
      if (code.trimStart().startsWith("//")) return;     // whole-line comment
      if (code.includes("const ARGS = (() =>")) return;  // the normalizer's own
      if (/\btypeof args\b|\breturn args \?\?/.test(code)) return;
      // The trailing identifier class matters: prompt text contains the prose
      // "<resolved args...>", and a pattern ending at the dot reports that as a
      // property read. A real read is always `args.<name>` / `args?.<name>`.
      if (/(^|[^A-Za-z_$.])args\s*\??\.\s*[A-Za-z_$]/.test(code)) offenders.push(`${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });

  test("the documented options are all read from ARGS", () => {
    const src = workflowSource();
    for (const opt of ["pr", "autopilot", "securityOnly", "repo", "skillDir", "splitSeverity", "crossVendor", "enumerationModel"]) {
      expect(src).toContain(`ARGS.${opt}`);
    }
  });
});

describe("preflight is one tool call, not eight narrated steps", () => {
  test("the preflight prompt invokes tools/Preflight.ts", () => {
    expect(workflowSource()).toContain("tools/Preflight.ts");
  });

  test("the per-step tool invocations the bundle replaced are gone from the prompt", () => {
    // Each was a numbered step the agent had to discover how to drive. They are
    // imports inside Preflight.ts now; if one returns, so does its call cost.
    const src = workflowSource();
    for (const cmd of [
      "bun ${skillPath('tools/Config.ts')}",
      "bun ${skillPath('tools/CodebasePatternsScanner.ts')}",
      "bun ${skillPath('tools/ReviewPacketGenerator.ts')}",
      "bun ${skillPath('tools/InjectionPreScan.ts')}",
      "bun ${skillPath('tools/RemovalTrackingGate.ts')}",
      "bun ${skillPath('tools/RiskTierClassifier.ts')}",
    ]) {
      expect(src).not.toContain(cmd);
    }
  });
});
