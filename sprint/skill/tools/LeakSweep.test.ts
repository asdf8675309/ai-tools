/**
 * Leak sweep — asserts nothing private reached the published tool.
 *
 * Two sources of terms:
 *
 *   BUILTIN   generic patterns that are safe to publish and apply to anyone
 *             (absolute home paths, which leak a username on any machine).
 *
 *   LOCAL     your own banned terms — organisation names, internal ticket
 *             prefixes, private paths. These live OUTSIDE the repo, because a
 *             checked-in list of the strings you are hiding is itself the leak.
 *             Obfuscating them in source does not help: splitting "ab"+"cd"
 *             defeats grep, not a reader, and a labelled inventory of what you
 *             consider sensitive is worse than an incidental mention.
 *
 * Point LOCAL at a file:
 *
 *   sprint/.leak-terms.json        (gitignored; the default location)
 *   $SPRINT_LEAK_TERMS=/some/path  (anywhere else)
 *
 * Shape — see .leak-terms.example.json:
 *
 *   [{ "label": "organisation names", "terms": ["acme", "acme-corp"] }]
 *
 * With no local file the local half skips and only BUILTIN runs, so a fresh
 * clone is green rather than red for a config it was never given.
 *
 * An empty result only counts as evidence once the pattern is known to match
 * something, so every pattern is fired at a synthetic canary first.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TOOL_ROOT = join(import.meta.dir, "..", "..");
const TERMS_FILE = process.env.SPRINT_LEAK_TERMS ?? join(TOOL_ROOT, ".leak-terms.json");

interface Check {
  label: string;
  pattern: RegExp;
  canary: string;
}

const BUILTIN: Check[] = [
  {
    label: "absolute home paths",
    pattern: /\/Users\/[a-zA-Z][a-zA-Z0-9._-]*|\/home\/[a-zA-Z][a-zA-Z0-9._-]*/,
    canary: "/Users/" + "someone",
  },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Null when no local term file exists — the caller skips rather than fails. */
export function loadLocalChecks(path = TERMS_FILE): Check[] | null {
  if (!existsSync(path)) return null;
  const groups = JSON.parse(readFileSync(path, "utf8")) as Array<{ label: string; terms: string[] }>;
  return groups
    .filter((g) => g.terms.length > 0)
    .map((g) => ({
      label: g.label,
      pattern: new RegExp(g.terms.map(escapeRe).join("|"), "i"),
      canary: g.terms[0]!,
    }));
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|js|md|sh|json|ya?ml)$/.test(entry)) acc.push(full);
  }
  return acc;
}

function offenders(pattern: RegExp): string[] {
  return sourceFiles(TOOL_ROOT)
    // The terms file is the one place the banned strings legitimately appear.
    .filter((f) => f !== TERMS_FILE)
    .filter((f) => pattern.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(TOOL_ROOT.length + 1));
}

describe("leak sweep — builtin", () => {
  test("the sweep actually reads files", () => {
    expect(sourceFiles(TOOL_ROOT).length).toBeGreaterThan(5);
  });

  for (const { label, pattern, canary } of BUILTIN) {
    test(`${label}: the pattern matches a canary`, () => {
      expect(pattern.test(canary)).toBe(true);
    });

    test(`no ${label}`, () => {
      expect(offenders(pattern)).toEqual([]);
    });
  }
});

describe("leak sweep — local terms", () => {
  const local = loadLocalChecks();

  test.skipIf(local !== null)("no local term file — local sweep skipped, builtin still ran", () => {
    expect(local).toBeNull();
  });

  for (const { label, pattern, canary } of local ?? []) {
    test(`${label}: the pattern matches a canary`, () => {
      expect(pattern.test(canary)).toBe(true);
    });

    test(`no ${label}`, () => {
      expect(offenders(pattern)).toEqual([]);
    });
  }
});
