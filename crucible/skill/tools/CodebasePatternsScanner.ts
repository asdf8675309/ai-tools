#!/usr/bin/env bun
/**
 * Crucible — Codebase Patterns Scanner
 *
 * Identifies the patterns a repo already uses for auth, validation, errors, DB,
 * logger, tests, HTTP framework, routing, secrets, background work, and tooling.
 * Emits a markdown block that every Pass 1 reviewer reads at Phase 1.
 *
 * Reviewers frame findings as deviations from these paths rather than from
 * abstract best-practice, which is the single highest-leverage move for cutting
 * the false-positive rate.
 *
 * LAYOUT-AGNOSTIC. It auto-detects the repo shape and works on all of:
 *   - a flat single-package repo (source at the root or under src/)
 *   - a monorepo with apps/* and/or packages/* workspaces
 *   - a repo following neither convention
 * An empty block means the repo genuinely has none of these patterns, not that
 * the scanner didn't understand the layout.
 *
 * Usage:
 *   bun tools/CodebasePatternsScanner.ts                  # auto-detect from CWD
 *   bun tools/CodebasePatternsScanner.ts --unit web       # one workspace
 *   bun tools/CodebasePatternsScanner.ts --root ./service # explicit directory
 *   bun tools/CodebasePatternsScanner.ts --list           # show detected units
 *
 * Flags:
 *   --unit <name>   Workspace under apps/ or packages/ (alias: --app)
 *   --root <path>   Directory to scan as a single unit (overrides --unit)
 *   --list          Print detected units and exit
 *   --json          Emit JSON instead of markdown
 *   --quiet         No stderr progress
 *
 * Exit codes:
 *   0  scan succeeded (block printed to stdout)
 *   1  argument or scan error
 *   2  no patterns detected anywhere → caller should ask the user for a manual block
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, resolve, relative } from "node:path";

interface Args {
  unit?: string;
  root?: string;
  list: boolean;
  json: boolean;
  quiet: boolean;
}

export interface Pattern {
  field: string;
  detected: boolean;
  value?: string;
}

export interface Unit {
  name: string;
  dir: string;
}

export interface UnitScan {
  name: string;
  dir: string;
  patterns: Pattern[];
  detectedCount: number;
}

const WORKSPACE_PARENTS = ["apps", "packages", "services", "libs"];
const MAX_UNITS = 12;
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".git", "out",
  "vendor", "target", "__pycache__", ".venv", "venv", ".svelte-kit", ".output",
]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/;

// ── Layout detection ────────────────────────────────────────────────────────

function hasSourceFile(dir: string, depth = 2): boolean {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return false; }
  const subdirs: string[] = [];
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isFile() && SOURCE_RE.test(e)) return true;
    if (st.isDirectory()) subdirs.push(full);
  }
  if (depth <= 0) return false;
  return subdirs.some((d) => hasSourceFile(d, depth - 1));
}

/**
 * Detect the units to scan. A monorepo yields one unit per workspace directory;
 * anything else yields a single unit for the repo root, so the scanner always
 * has something to scan.
 */
export function detectUnits(repoRoot: string): Unit[] {
  const root = resolve(repoRoot);
  const units: Unit[] = [];
  for (const parent of WORKSPACE_PARENTS) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    let entries: string[];
    try { entries = readdirSync(parentDir); } catch { continue; }
    for (const e of entries.sort()) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const dir = join(parentDir, e);
      let st;
      try { st = statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (existsSync(join(dir, "package.json")) || hasSourceFile(dir)) {
        units.push({ name: `${parent}/${e}`, dir });
      }
    }
  }
  // Too many workspaces to profile individually — one repo-wide block instead.
  if (units.length === 0 || units.length > MAX_UNITS) {
    return [{ name: basename(root) || root, dir: root }];
  }
  return units;
}

// ── File walking ────────────────────────────────────────────────────────────

export function walkFiles(root: string, maxFiles = 2000): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && SOURCE_RE.test(e)) out.push(full);
      if (out.length >= maxFiles) return out;
    }
  }
  return out;
}

function findFirst(files: string[], regex: RegExp, maxBytes = 200_000): { path: string; line: number; snippet: string } | null {
  for (const f of files) {
    try {
      if (statSync(f).size > maxBytes) continue;
      const content = readFileSync(f, "utf8");
      const m = content.match(regex);
      if (m) {
        const idx = content.indexOf(m[0]);
        return {
          path: f,
          line: content.slice(0, idx).split("\n").length,
          snippet: m[0].slice(0, 80).replace(/\s+/g, " "),
        };
      }
    } catch { /* skip unreadable */ }
  }
  return null;
}

function rel(root: string, abs: string): string {
  const r = relative(root, abs);
  return r && !r.startsWith("..") ? r : abs;
}

function firstExisting(root: string, names: string[]): string | null {
  for (const n of names) if (existsSync(join(root, n))) return n;
  return null;
}

interface Manifest {
  deps: Record<string, string>;
  scripts: Record<string, string>;
  raw: Record<string, unknown> | null;
}

function readManifest(root: string): Manifest {
  const empty: Manifest = { deps: {}, scripts: {}, raw: null };
  const p = join(root, "package.json");
  if (!existsSync(p)) return empty;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    return {
      deps: {
        ...(raw.dependencies as Record<string, string> ?? {}),
        ...(raw.devDependencies as Record<string, string> ?? {}),
        ...(raw.peerDependencies as Record<string, string> ?? {}),
      },
      scripts: (raw.scripts as Record<string, string>) ?? {},
      raw,
    };
  } catch {
    return empty;
  }
}

/** First dependency from `names` present in the manifest. */
function firstDep(m: Manifest, names: string[]): string | null {
  for (const n of names) if (m.deps[n]) return n;
  return null;
}

function importRe(pkgs: string[]): RegExp {
  const alt = pkgs.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
  return new RegExp(
    // JS/TS `from "pkg"` and `require("pkg")`; Python `import pkg` and `from pkg import ...`
    `(?:from\\s+['"](?:${alt})(?:/[^'"]*)?['"]|require\\(\\s*['"](?:${alt})|^\\s*import\\s+(?:${alt})\\b|^\\s*from\\s+(?:${alt})[\\s.])`,
    "m",
  );
}

// ── Pattern detection ───────────────────────────────────────────────────────

export function detectPatterns(root: string, files: string[]): Pattern[] {
  const patterns: Pattern[] = [];
  const m = readManifest(root);
  const at = (hit: { path: string; line: number }) => `\`${rel(root, hit.path)}:${hit.line}\``;
  const push = (field: string, value: string | undefined) =>
    patterns.push({ field, detected: !!value, value });

  // Auth
  const authFn = findFirst(files, /(export\s+(?:async\s+)?function\s+(withAuth|requireAuth|requireUser|authenticate|verifyAuth|verifyToken|getSession|authMiddleware|login_required)|export\s+const\s+(withAuth|requireAuth|requireUser|authenticate)\s*=|@login_required|@requires_auth)/);
  const authPkg = firstDep(m, ["next-auth", "@auth/core", "passport", "jsonwebtoken", "jose", "lucia", "@clerk/nextjs", "@supabase/auth-helpers-nextjs", "bcrypt", "bcryptjs", "argon2"]);
  push("Auth", authFn
    ? `${at(authFn)} — \`${authFn.snippet}\``
    : authPkg ? `\`${authPkg}\` (from package.json; no central guard helper found)` : undefined);

  // Validation
  const valPkg = firstDep(m, ["zod", "yup", "joi", "valibot", "ajv", "class-validator", "superstruct", "io-ts", "@sinclair/typebox"]);
  const valImport = findFirst(files, importRe(["zod", "yup", "joi", "valibot", "ajv", "class-validator", "superstruct", "io-ts", "pydantic", "marshmallow"]));
  push("Validation", valImport
    ? `\`${valImport.snippet}\` first seen at ${at(valImport)}`
    : valPkg ? `\`${valPkg}\` (declared in package.json)` : undefined);

  // Errors
  const errClass = findFirst(files, /class\s+\w*(Http|Api|App|Domain|Validation|NotFound)?Error\s+extends\s+(Error|Exception)|class\s+\w+Error\(Exception\)/);
  const errModule = firstExisting(root, ["src/errors.ts", "src/error.ts", "src/lib/errors.ts", "errors.ts", "src/exceptions.py", "exceptions.py"]);
  push("Errors", errClass
    ? `${at(errClass)} — \`${errClass.snippet}\``
    : errModule ? `\`${errModule}\` (central error module)` : undefined);

  // DB
  const dbPkg = firstDep(m, ["drizzle-orm", "@prisma/client", "typeorm", "sequelize", "mongoose", "knex", "kysely", "pg", "postgres", "mysql2", "better-sqlite3", "@libsql/client"]);
  const dbImport = findFirst(files, importRe(["drizzle-orm", "@prisma/client", "typeorm", "sequelize", "mongoose", "knex", "kysely", "pg", "postgres", "sqlalchemy"]));
  const d1Raw = findFirst(files, /\b(c\.env\.\w*DB\w*|env\.\w*DB\w*)\.prepare\s*\(/);
  push("DB", dbImport
    ? `\`${dbImport.snippet}\` first seen at ${at(dbImport)}`
    : d1Raw ? `raw prepared statements — \`${d1Raw.snippet}\` at ${at(d1Raw)}`
    : dbPkg ? `\`${dbPkg}\` (declared in package.json)` : undefined);

  // Logger
  const logPkg = firstDep(m, ["pino", "winston", "bunyan", "consola", "loglevel", "signale"]);
  const logger = findFirst(files, /(export\s+(const|function)\s+logger|import\s+\{[^}]*\blogger\b[^}]*\}\s+from|^\s*import\s+logging\b)/m);
  push("Logger", logger
    ? `${at(logger)} — \`${logger.snippet}\``
    : logPkg ? `\`${logPkg}\` (declared in package.json)` : undefined);

  // Tests
  const testCfg = firstExisting(root, [
    "vitest.config.ts", "vitest.config.js", "vitest.config.mts",
    "jest.config.ts", "jest.config.js", "jest.config.json",
    "playwright.config.ts", "cypress.config.ts", "karma.conf.js",
    "pytest.ini", "tox.ini",
  ]);
  const testPkg = firstDep(m, ["vitest", "jest", "@playwright/test", "cypress", "mocha", "ava", "node-tap"]);
  const testScript = m.scripts.test;
  const testFile = files.find((f) => /\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/.test(f));
  push("Tests", testCfg
    ? `config at \`${testCfg}\`${testPkg ? ` (\`${testPkg}\`)` : ""}`
    : testPkg ? `\`${testPkg}\`${testScript ? ` via \`npm test\` → \`${testScript}\`` : ""}`
    : testScript ? `\`npm test\` → \`${testScript}\``
    : testFile ? `test files present, e.g. \`${rel(root, testFile)}\` (no runner config found)` : undefined);

  // HTTP framework
  const httpPkg = firstDep(m, ["hono", "express", "fastify", "koa", "itty-router", "@nestjs/core", "next", "@remix-run/node", "@sveltejs/kit", "elysia"]);
  const httpImport = findFirst(files, importRe(["hono", "express", "fastify", "koa", "itty-router", "flask", "fastapi", "django"]));
  push("HTTP framework", httpImport
    ? `\`${httpImport.snippet}\` first seen at ${at(httpImport)}`
    : httpPkg ? `\`${httpPkg}\` (declared in package.json)` : undefined);

  // Routing
  const routeDir = firstExisting(root, ["src/routes", "routes", "src/app", "app", "src/pages", "pages", "src/api", "api", "src/controllers"]);
  const routerCall = findFirst(files, /\b(new\s+Hono\(|express\.Router\(|Router\(\)|createBrowserRouter\()/);
  push("Routing", routeDir
    ? `\`${routeDir}/\` directory-based`
    : routerCall ? `programmatic — \`${routerCall.snippet}\` at ${at(routerCall)}` : undefined);

  // Secrets
  const cfEnv = findFirst(files, /\bc\.env\.[A-Z_][A-Z0-9_]*/);
  const processEnv = findFirst(files, /\bprocess\.env\.[A-Z_][A-Z0-9_]*/);
  const viteEnv = findFirst(files, /\bimport\.meta\.env\.[A-Z_][A-Z0-9_]*/);
  const osEnv = findFirst(files, /\bos\.environ(\.get)?[.[(]/);
  const envExample = firstExisting(root, [".env.example", ".env.sample", ".dev.vars.example"]);
  push("Secrets", cfEnv
    ? `\`c.env.NAME\` request-bound bindings (first at ${at(cfEnv)})`
    : processEnv ? `\`process.env.NAME\` (first at ${at(processEnv)})`
    : viteEnv ? `\`import.meta.env.NAME\` (first at ${at(viteEnv)})`
    : osEnv ? `\`os.environ\` (first at ${at(osEnv)})`
    : envExample ? `\`${envExample}\` documents the expected variables` : undefined);

  // Background work
  const bgPkg = firstDep(m, ["bullmq", "bull", "agenda", "celery", "node-cron", "graphile-worker"]);
  const waitUntil = findFirst(files, /\b(c\.executionCtx|ctx|event)\.waitUntil\s*\(/);
  push("Background work", waitUntil
    ? `\`waitUntil(...)\` (first at ${at(waitUntil)})`
    : bgPkg ? `\`${bgPkg}\` (declared in package.json)` : undefined);

  // Types / lint / format config — the conventions a reviewer should not fight
  const tsCfg = firstExisting(root, ["tsconfig.json", "jsconfig.json"]);
  const lintCfg = firstExisting(root, ["eslint.config.js", "eslint.config.mjs", ".eslintrc.json", ".eslintrc.cjs", "biome.json", "ruff.toml", ".ruff.toml", ".golangci.yml"]);
  push("Tooling", [tsCfg && `\`${tsCfg}\``, lintCfg && `\`${lintCfg}\``].filter(Boolean).join(" + ") || undefined);

  // Package manager — pins the install/run commands a reviewer suggests
  const lockfile = firstExisting(root, ["bun.lockb", "bun.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "poetry.lock", "requirements.txt", "go.sum", "Cargo.lock"]);
  push("Package manager", lockfile ? `\`${lockfile}\`` : undefined);

  return patterns;
}

// ── Rendering ───────────────────────────────────────────────────────────────

export function renderMarkdown(unitName: string, patterns: Pattern[]): string {
  const lines: string[] = [`## Codebase Patterns — ${unitName}`, ""];
  for (const p of patterns) {
    lines.push(p.detected ? `- **${p.field}:** ${p.value}` : `- **${p.field}:** _(not detected)_`);
  }
  lines.push("");
  lines.push("> Crucible Pass 1 reviewers MUST frame findings as deviations from these paths (where present) rather than from abstract best-practice. Findings with no codebase-pattern reference AND no clear standalone justification are dropped at Phase 5.");
  return lines.join("\n");
}

export function scanUnit(unit: Unit): UnitScan {
  const files = walkFiles(unit.dir);
  const patterns = detectPatterns(unit.dir, files);
  return {
    name: unit.name,
    dir: unit.dir,
    patterns,
    detectedCount: patterns.filter((p) => p.detected).length,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const out: Args = { list: false, json: false, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--unit" || a === "--app") out.unit = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--list") out.list = true;
    else if (a === "--json") out.json = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: bun CodebasePatternsScanner.ts [--unit <name> | --root <path>] [--list] [--json] [--quiet]");
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(1);
    }
  }
  return out;
}

function resolveUnits(args: Args): Unit[] {
  if (args.root) {
    const p = resolve(args.root);
    if (!existsSync(p)) { process.stderr.write(`root not found: ${p}\n`); process.exit(1); }
    return [{ name: basename(p) || p, dir: p }];
  }
  const detected = detectUnits(process.cwd());
  if (args.unit) {
    const match = detected.find((u) => u.name === args.unit || basename(u.dir) === args.unit);
    if (!match) {
      process.stderr.write(`unit not found: ${args.unit}\nknown units: ${detected.map((u) => u.name).join(", ")}\n`);
      process.exit(1);
    }
    return [match];
  }
  return detected;
}

if (import.meta.main) {
  const args = parseArgs(process.argv);
  const log = (msg: string) => { if (!args.quiet) process.stderr.write(`[scanner] ${msg}\n`); };
  const units = resolveUnits(args);

  if (args.list) {
    console.log(JSON.stringify({ units: units.map((u) => u.name) }, null, 2));
    process.exit(0);
  }

  log(`scanning ${units.length} unit(s): ${units.map((u) => u.name).join(", ")}`);
  const scans = units.map((u) => {
    const scan = scanUnit(u);
    log(`${scan.name}: ${scan.detectedCount}/${scan.patterns.length} patterns`);
    return scan;
  });

  if (args.json) {
    console.log(JSON.stringify({ units: scans }, null, 2));
  } else {
    console.log(scans.map((s) => renderMarkdown(s.name, s.patterns)).join("\n\n"));
  }

  const total = scans.reduce((n, s) => n + s.detectedCount, 0);
  if (total === 0) {
    process.stderr.write("[scanner] no patterns detected — caller should ask the user for a manual block\n");
    process.exit(2);
  }
  process.exit(0);
}
