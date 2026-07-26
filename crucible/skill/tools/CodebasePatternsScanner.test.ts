import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectUnits, detectPatterns, walkFiles, renderMarkdown, scanUnit, type Pattern } from "./CodebasePatternsScanner.ts";

let sandbox: string;

/** Look a field up by name, failing loudly rather than silently asserting on undefined. */
function field(patterns: Pattern[], name: string): Pattern {
  const found = patterns.find((p) => p.field === name);
  if (!found) throw new Error(`no pattern field named "${name}" — fields: ${patterns.map((p) => p.field).join(", ")}`);
  return found;
}

/** Write a file, creating parent directories as needed. */
function put(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// Three layouts, built once: flat-with-src, workspace-based, and a repo following
// neither convention.
let flat: string;
let workspaceRepo: string;
let bare: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "crucible-scanner-"));

  flat = join(sandbox, "flat-app");
  put(flat, "package.json", JSON.stringify({
    name: "flat-app",
    scripts: { test: "vitest run" },
    dependencies: { hono: "^4.0.0", zod: "^3.0.0", "drizzle-orm": "^0.30.0" },
    devDependencies: { vitest: "^1.0.0" },
  }));
  put(flat, "tsconfig.json", "{}");
  put(flat, "package-lock.json", "{}");
  put(flat, "src/index.ts", [
    `import { Hono } from "hono";`,
    `import { z } from "zod";`,
    `import { logger } from "./lib/logger";`,
    ``,
    `export function requireAuth(token: string): boolean {`,
    `  return token === process.env.API_TOKEN;`,
    `}`,
  ].join("\n"));
  put(flat, "src/lib/logger.ts", `export const logger = console;`);
  put(flat, "src/errors.ts", `export class AppError extends Error {}`);
  put(flat, "src/routes/health.ts", `export const health = () => "ok";`);
  put(flat, "src/index.test.ts", `it("works", () => {});`);

  workspaceRepo = join(sandbox, "workspace-repo");
  put(workspaceRepo, "package.json", JSON.stringify({ name: "root", workspaces: ["apps/*"] }));
  put(workspaceRepo, "apps/web/package.json", JSON.stringify({ name: "web", dependencies: { express: "^4.0.0" } }));
  put(workspaceRepo, "apps/web/src/server.js", `const express = require("express");\nconst app = express();`);
  put(workspaceRepo, "packages/ui/package.json", JSON.stringify({ name: "ui" }));
  put(workspaceRepo, "packages/ui/src/Button.tsx", `export const Button = () => null;`);

  bare = join(sandbox, "bare-repo");
  put(bare, "main.py", [
    `import logging`,
    `import os`,
    `from flask import Flask`,
    `from pydantic import BaseModel`,
    ``,
    `app = Flask(__name__)`,
    `SECRET = os.environ.get("SECRET")`,
  ].join("\n"));
  put(bare, "test_main.py", `def test_ok():\n    assert True`);
  put(bare, "requirements.txt", "flask\n");
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("detectUnits — layout auto-detection", () => {
  test("a flat single-package repo yields exactly one unit at the repo root", () => {
    const units = detectUnits(flat);
    expect(units).toHaveLength(1);
    expect(units[0]?.dir).toBe(flat);
  });

  test("a workspace-based repo yields one unit per workspace", () => {
    const names = detectUnits(workspaceRepo).map((u) => u.name).sort();
    expect(names).toEqual(["apps/web", "packages/ui"]);
  });

  test("a repo with neither convention still yields one scannable unit", () => {
    const units = detectUnits(bare);
    expect(units).toHaveLength(1);
    expect(units[0]?.dir).toBe(bare);
  });

  test("node_modules is never treated as a workspace", () => {
    const noisy = join(sandbox, "noisy");
    put(noisy, "apps/real/package.json", "{}");
    put(noisy, "apps/node_modules/pkg/index.js", "module.exports = 1;");
    expect(detectUnits(noisy).map((u) => u.name)).toEqual(["apps/real"]);
  });
});

describe("detectPatterns — flat single-package repo produces a NON-EMPTY block", () => {
  test("the default path on a flat repo detects real patterns, not zero", () => {
    const scan = scanUnit({ name: "flat-app", dir: flat });
    expect(scan.detectedCount).toBeGreaterThan(0);
    // The whole point of the block: a reviewer must get concrete paths to compare
    // against, so a handful of fields is the bar, not one.
    expect(scan.detectedCount).toBeGreaterThanOrEqual(6);
  });

  test("each pattern family resolves to the right evidence", () => {
    const patterns = detectPatterns(flat, walkFiles(flat));
    expect(field(patterns, "Auth").detected).toBe(true);
    expect(field(patterns, "Validation").value).toContain("zod");
    expect(field(patterns, "Errors").detected).toBe(true);
    expect(field(patterns, "DB").value).toContain("drizzle-orm");
    expect(field(patterns, "Logger").detected).toBe(true);
    expect(field(patterns, "Tests").value).toContain("vitest");
    expect(field(patterns, "HTTP framework").value).toContain("hono");
    expect(field(patterns, "Routing").value).toContain("src/routes");
    expect(field(patterns, "Secrets").value).toContain("process.env");
    expect(field(patterns, "Tooling").value).toContain("tsconfig.json");
    expect(field(patterns, "Package manager").value).toContain("package-lock.json");
  });

  test("the rendered markdown block names the unit and carries the framing rule", () => {
    const scan = scanUnit({ name: "flat-app", dir: flat });
    const md = renderMarkdown(scan.name, scan.patterns);
    expect(md).toContain("## Codebase Patterns — flat-app");
    expect(md).toContain("deviations from these paths");
    expect(md).not.toContain("**Auth:** _(not detected)_");
  });
});

describe("detectPatterns — other layouts", () => {
  test("a workspace is scanned on its own directory", () => {
    const web = detectUnits(workspaceRepo).find((u) => u.name === "apps/web");
    if (!web) throw new Error("apps/web was not detected as a unit");
    const scan = scanUnit(web);
    expect(field(scan.patterns, "HTTP framework").value).toContain("express");
    expect(scan.detectedCount).toBeGreaterThan(0);
  });

  test("a non-JS repo with no package.json still detects patterns", () => {
    const scan = scanUnit({ name: "bare-repo", dir: bare });
    expect(field(scan.patterns, "HTTP framework").value).toContain("flask");
    expect(field(scan.patterns, "Validation").value).toContain("pydantic");
    expect(field(scan.patterns, "Secrets").value).toContain("os.environ");
    expect(field(scan.patterns, "Logger").detected).toBe(true);
    expect(scan.detectedCount).toBeGreaterThan(0);
  });

  test("an empty directory genuinely detects nothing (exit-2 case stays meaningful)", () => {
    const empty = join(sandbox, "empty-repo");
    mkdirSync(empty, { recursive: true });
    expect(scanUnit({ name: "empty-repo", dir: empty }).detectedCount).toBe(0);
  });
});

// A workspace is claimed on either of two independent signals: a package.json,
// or source files found by a bounded search. The package.json half is covered
// above; this block is the search half, which is what carries non-JS and
// manifest-less workspaces.
describe("detectUnits — a workspace with no package.json", () => {
  test("is still claimed when it contains source files", () => {
    const repo = join(sandbox, "no-manifest");
    put(repo, "packages/engine/lib/run.ts", "export const run = () => 1;");
    expect(detectUnits(repo).map((u) => u.name)).toEqual(["packages/engine"]);
  });

  test("is claimed for a non-JS language too", () => {
    const repo = join(sandbox, "polyglot");
    put(repo, "services/api/app.py", "def main():\n    pass");
    put(repo, "services/worker/main.go", "package main");
    expect(detectUnits(repo).map((u) => u.name).sort()).toEqual(["services/api", "services/worker"]);
  });

  test("is NOT claimed when it holds no source at all", () => {
    const repo = join(sandbox, "docs-only-ws");
    put(repo, "packages/handbook/README.md", "# handbook");
    put(repo, "packages/handbook/notes/tips.txt", "tips");
    // No unit matched ⇒ falls back to the single repo-root unit.
    const units = detectUnits(repo);
    expect(units).toHaveLength(1);
    expect(units[0]?.dir).toBe(join(sandbox, "docs-only-ws"));
  });

  test("is NOT claimed on the strength of vendored dependencies alone", () => {
    const repo = join(sandbox, "vendored-only");
    put(repo, "packages/shim/node_modules/dep/index.js", "module.exports = 1;");
    expect(detectUnits(repo).map((u) => u.name)).not.toContain("packages/shim");
  });

  // The search is depth-bounded, so a source file buried deeper than the bound
  // does not claim the workspace. Recorded as the real limit, not an accident.
  test("finds source up to three levels down, but not four", () => {
    const shallow = join(sandbox, "depth-ok");
    put(shallow, "apps/svc/a/b/index.ts", "export const x = 1;");
    expect(detectUnits(shallow).map((u) => u.name)).toEqual(["apps/svc"]);

    const deep = join(sandbox, "depth-too-far");
    put(deep, "apps/svc/a/b/c/index.ts", "export const x = 1;");
    expect(detectUnits(deep).map((u) => u.name)).not.toContain("apps/svc");
  });
});

describe("detectUnits — too many workspaces collapses to one repo-wide unit", () => {
  test("13 workspaces yield a single root unit instead of 13 separate blocks", () => {
    const many = join(sandbox, "many-workspaces");
    for (let i = 0; i < 13; i++) put(many, `packages/p${i}/package.json`, "{}");
    const units = detectUnits(many);
    expect(units).toHaveLength(1);
    expect(units[0]?.dir).toBe(many);
  });

  test("12 workspaces are still profiled individually (the cap is not off by one)", () => {
    const twelve = join(sandbox, "twelve-workspaces");
    for (let i = 0; i < 12; i++) put(twelve, `packages/p${i}/package.json`, "{}");
    expect(detectUnits(twelve)).toHaveLength(12);
  });
});

describe("detectPatterns — a broken package.json degrades instead of crashing", () => {
  test("an unparseable manifest still yields file-evidence patterns", () => {
    const broken = join(sandbox, "broken-manifest");
    put(broken, "package.json", "{ not: valid json,,,");
    put(broken, "src/index.ts", [
      `import { Hono } from "hono";`,
      `import { z } from "zod";`,
      `const TOKEN = process.env.API_TOKEN;`,
    ].join("\n"));

    const patterns = detectPatterns(broken, walkFiles(broken));
    // Import-derived detection is unaffected by the manifest being garbage.
    expect(field(patterns, "HTTP framework").value).toContain("hono");
    expect(field(patterns, "Validation").value).toContain("zod");
    expect(field(patterns, "Secrets").value).toContain("process.env");
  });

  test("manifest-only fields report not-detected rather than inventing a value", () => {
    const broken = join(sandbox, "broken-manifest-2");
    put(broken, "package.json", "}{");
    put(broken, "src/index.ts", "export const x = 1;");
    const patterns = detectPatterns(broken, walkFiles(broken));
    // `Tests` has no config file, no readable dep, and no test file here.
    expect(field(patterns, "Tests").detected).toBe(false);
    expect(field(patterns, "Tests").value).toBeUndefined();
  });

  test("a valid manifest DOES drive those same fields — the negative above is not vacuous", () => {
    const okRepo = join(sandbox, "valid-manifest");
    put(okRepo, "package.json", JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }));
    put(okRepo, "src/index.ts", "export const x = 1;");
    const patterns = detectPatterns(okRepo, walkFiles(okRepo));
    expect(field(patterns, "Tests").value).toContain("vitest");
  });
});

describe("renderMarkdown — undetected fields are stated, not omitted", () => {
  test("a field with no evidence renders an explicit not-detected marker", () => {
    const empty = join(sandbox, "render-empty");
    mkdirSync(empty, { recursive: true });
    const md = renderMarkdown("render-empty", detectPatterns(empty, []));
    expect(md).toContain("- **Auth:** _(not detected)_");
    expect(md).toContain("- **DB:** _(not detected)_");
  });

  test("every detected field appears with its value", () => {
    const patterns: Pattern[] = [
      { field: "Auth", detected: true, value: "`src/auth.ts:4`" },
      { field: "DB", detected: false },
    ];
    const md = renderMarkdown("unit-x", patterns);
    expect(md).toContain("- **Auth:** `src/auth.ts:4`");
    expect(md).toContain("- **DB:** _(not detected)_");
    expect(md.startsWith("## Codebase Patterns — unit-x")).toBe(true);
  });
});

describe("walkFiles", () => {
  test("skips node_modules and build output", () => {
    const noisy = join(sandbox, "walk-noise");
    put(noisy, "src/a.ts", "export const a = 1;");
    put(noisy, "node_modules/pkg/index.js", "module.exports = 1;");
    put(noisy, "dist/bundle.js", "var x = 1;");
    const found = walkFiles(noisy).map((f) => f.replace(noisy, ""));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("a.ts");
  });

  test("honors the maxFiles cap", () => {
    const many = join(sandbox, "many-files");
    for (let i = 0; i < 20; i++) put(many, `src/f${i}.ts`, `export const f${i} = ${i};`);
    expect(walkFiles(many, 5).length).toBeLessThanOrEqual(5);
  });
});
