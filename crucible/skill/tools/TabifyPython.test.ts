import { describe, expect, test } from "bun:test";
import { preprocessPythonForReview, shouldTabify, tabifyPython } from "./TabifyPython.ts";

const SOURCE = [
  "import os",
  "",
  "",
  "class Loader:",
  "    def __init__(self, path):",
  "        self.path = path",
  "",
  "    def read(self):",
  "        with open(self.path) as fh:",
  "            return fh.read()",
  "",
].join("\n");

const CODE_TUNED = ["codex-mini", "deepseek-coder-v3", "CodeLlama-70b", "qwen-2.5-coder", "starcoder2"];
const GENERAL = ["claude-opus-5", "gpt-5.5", undefined];

describe("shouldTabify", () => {
  for (const model of CODE_TUNED) {
    test(`false for ${model}`, () => expect(shouldTabify(model)).toBe(false));
  }
  for (const model of GENERAL) {
    test(`true for ${model ?? "an unspecified model"}`, () => expect(shouldTabify(model)).toBe(true));
  }
});

describe("tabifyPython — indentation", () => {
  test("four spaces become one tab, eight become two", () => {
    expect(tabifyPython("    a = 1")).toBe("\ta = 1");
    expect(tabifyPython("        a = 1")).toBe("\t\ta = 1");
  });

  test("a remainder under four spaces is preserved", () => {
    expect(tabifyPython("      a = 1")).toBe("\t  a = 1");
  });

  test("unindented lines are untouched", () => {
    expect(tabifyPython("import os")).toBe("import os");
  });

  test("mid-line alignment whitespace is preserved", () => {
    expect(tabifyPython("    a   =   1")).toBe("\ta   =   1");
  });

  // ISC-15
  test("a line mixing a leading tab with spaces is left alone", () => {
    const mixed = "\t    a = 1";
    expect(tabifyPython(mixed)).toBe(mixed);
  });

  test("a file that already uses tabs is byte-identical", () => {
    const tabbed = ["def f():", "\treturn 1", ""].join("\n");
    expect(tabifyPython(tabbed)).toBe(tabbed);
  });
});

// ISC-14 — the pre-mortem failure: any line shift makes every finding cite a
// line number that does not exist in the real file.
describe("line fidelity", () => {
  test("line count is preserved exactly", () => {
    expect(tabifyPython(SOURCE).split("\n")).toHaveLength(SOURCE.split("\n").length);
  });

  test("blank lines are neither collapsed nor removed", () => {
    const out = tabifyPython(SOURCE).split("\n");
    const src = SOURCE.split("\n");
    for (let i = 0; i < src.length; i++) {
      expect(out[i] === "").toBe(src[i] === "");
    }
  });

  test("every line maps to the same index after its content", () => {
    const out = tabifyPython(SOURCE).split("\n");
    expect(out[3]).toBe("class Loader:");
    expect(out[9]).toContain("return fh.read()");
  });

  test("the review entry point preserves line count too", () => {
    const { source } = preprocessPythonForReview(SOURCE, "claude-opus-5");
    expect(source.split("\n")).toHaveLength(SOURCE.split("\n").length);
  });
});

describe("preprocessPythonForReview", () => {
  // ISC-12
  test("applies tabify for a general-purpose model", () => {
    const result = preprocessPythonForReview(SOURCE, "claude-opus-5");
    expect(result.applied).toBe(true);
    expect(result.source).not.toBe(SOURCE);
    expect(result.source).toContain("\tdef __init__");
  });

  // ISC-13 — the skip path, asserted rather than assumed.
  for (const model of CODE_TUNED) {
    test(`returns ${model} source byte-identical`, () => {
      const result = preprocessPythonForReview(SOURCE, model);
      expect(result.applied).toBe(false);
      expect(result.source).toBe(SOURCE);
      expect(result.reason).toContain("code-tuned");
    });
  }
});
