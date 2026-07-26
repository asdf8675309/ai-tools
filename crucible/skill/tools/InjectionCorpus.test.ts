import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isExpectedPayloadPath, scanDiff, scanText } from "./InjectionPreScan.ts";

const CORPUS = join(import.meta.dir, "__fixtures__", "injection-corpus");
const FIXTURES = readdirSync(CORPUS)
  .filter((name) => !name.startsWith("."))
  .sort();

describe("injection corpus — every fixture must be flagged", () => {
  test("the corpus has not shrunk", () => {
    expect(FIXTURES).toEqual([
      "identifier-channel.ts",
      "refusal-bait-content-poisoning.ts",
      "xpia-tc05-ci-tamper.yml",
      "xpia-tc06-roleplay-output.ts",
      "xpia-tc09-system-extraction.test.ts.txt",
    ]);
  });

  for (const name of FIXTURES) {
    test(`flags ${name}`, () => {
      const candidates = scanText(readFileSync(join(CORPUS, name), "utf8"), name);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((c) => c.category === "Prompt Injection in PR Content")).toBe(true);
    });
  }
});

describe("allow cases — the scanner must not flag ordinary code", () => {
  test("a plain module produces no candidates", () => {
    const clean = [
      "import { readFileSync } from 'node:fs';",
      "",
      "// Reads the config file and returns the parsed object.",
      "export function loadSettings(path: string): Record<string, unknown> {",
      "  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;",
      "}",
      "",
    ].join("\n");
    expect(scanText(clean, "src/settings.ts")).toEqual([]);
  });

  test("prose about review does not trip the instruction patterns", () => {
    const doc = [
      "# Contributing",
      "",
      "Open a pull request and wait for the security review to finish before merging.",
      "Reviewers check auth, validation, and error handling.",
    ].join("\n");
    expect(scanText(doc, "CONTRIBUTING.md")).toEqual([]);
  });
});

describe("expected-payload paths", () => {
  test("recognises the corpus directory and nothing adjacent", () => {
    expect(isExpectedPayloadPath("skill/tools/__fixtures__/injection-corpus/a.ts")).toBe(true);
    expect(isExpectedPayloadPath("__fixtures__/injection-corpus/a.ts")).toBe(true);
    expect(isExpectedPayloadPath("skill/tools/__fixtures__/other/a.ts")).toBe(false);
    expect(isExpectedPayloadPath("src/injection-corpus/a.ts")).toBe(false);
  });

  // ISC-6: reviewing a diff that touches the corpus must not halt on its own test data.
  test("a diff touching the corpus yields no CRITICAL and is flagged, not dropped", () => {
    const payload = readFileSync(join(CORPUS, "identifier-channel.ts"), "utf8");
    const diff = [
      "diff --git a/skill/tools/__fixtures__/injection-corpus/identifier-channel.ts b/skill/tools/__fixtures__/injection-corpus/identifier-channel.ts",
      "+++ b/skill/tools/__fixtures__/injection-corpus/identifier-channel.ts",
      "@@ -0,0 +1,20 @@",
      ...payload.split("\n").map((l) => `+${l}`),
    ].join("\n");

    const candidates = scanDiff(diff);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.severity === "CRITICAL")).toBe(false);
    expect(candidates.every((c) => c.expected_fixture === true)).toBe(true);
  });

  test("the same payload outside the corpus keeps its real severity", () => {
    const payload = readFileSync(join(CORPUS, "identifier-channel.ts"), "utf8");
    const diff = [
      "+++ b/src/handlers/users.ts",
      "@@ -0,0 +1,20 @@",
      ...payload.split("\n").map((l) => `+${l}`),
    ].join("\n");

    const candidates = scanDiff(diff);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.expected_fixture === undefined)).toBe(true);
    expect(candidates.some((c) => c.severity === "CRITICAL" || c.severity === "HIGH")).toBe(true);
  });
});
