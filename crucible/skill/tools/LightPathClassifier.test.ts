import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { classifyDiff, getDiffFiles, runClassifyCli, type Verdict } from "./LightPathClassifier.ts";
import { DEFAULT_LIGHT_PATH, hardenLightPathForGate, type LightPathConfig } from "./Config.ts";

const CFG = DEFAULT_LIGHT_PATH; // enabled, [.md .txt .rst], [], max_loc 1000

const DOC_EXT = [".md", ".txt", ".rst"];
const NON_DOC_EXT = [".ts", ".js", ".py", ".json", ".yaml", ".jsonc", ".sql", ".sh", ".mdx", ".lock", ""];
const LOC_SAMPLES = [0, 1, 250, 999];
// Names chosen to avoid the behavior-doc deny-list, which is asserted separately.
const docFiles = (n: number): string[] => Array.from({ length: n }, (_, i) => `docs/note${i}${DOC_EXT[i % DOC_EXT.length]}`);

describe("classifyDiff — deny-by-default SAFETY property", () => {
  // Exhaustive over (doc-file count) × (non-inert extension) × (LOC sample):
  // the domain is small enough to enumerate, so this is a proof, not a sample.
  test("∀ diff containing ANY non-inert file ⇒ full (regardless of doc files or LOC)", () => {
    let cases = 0;
    for (let docs = 0; docs <= 3; docs++) {
      for (const ext of NON_DOC_EXT) {
        for (const loc of LOC_SAMPLES) {
          const files = [...docFiles(docs), `src/mod${ext}`];
          expect(classifyDiff(files, loc, CFG).verdict).toBe("full");
          cases++;
        }
      }
    }
    expect(cases).toBe(4 * NON_DOC_EXT.length * LOC_SAMPLES.length);
  });

  test("∀ all-inert diff under the LOC ceiling ⇒ light", () => {
    let cases = 0;
    for (let docs = 1; docs <= 4; docs++) {
      for (const loc of [...LOC_SAMPLES, CFG.max_loc]) {
        expect(classifyDiff(docFiles(docs), loc, CFG).verdict).toBe("light");
        cases++;
      }
    }
    expect(cases).toBe(4 * (LOC_SAMPLES.length + 1));
  });

  test("a non-inert file forces full no matter its position in the list", () => {
    for (let i = 0; i <= 3; i++) {
      const files = docFiles(3);
      files.splice(i, 0, "src/index.ts");
      expect(classifyDiff(files, 10, CFG).verdict).toBe("full");
    }
  });
});

describe("classifyDiff — canonical cases", () => {
  const v = (files: string[], loc: number, cfg: LightPathConfig = CFG): Verdict => classifyDiff(files, loc, cfg).verdict;

  test("docs-only under ceiling ⇒ light", () => {
    expect(v(["README.md", "docs/guide.txt", "notes.rst"], 120)).toBe("light");
  });

  test("docs + a .ts file ⇒ full", () => {
    expect(v(["README.md", "src/index.ts"], 40)).toBe("full");
  });

  test("docs-only OVER the LOC ceiling ⇒ full", () => {
    expect(v(["huge.md"], CFG.max_loc + 1)).toBe("full");
  });

  test(".mdx ⇒ full (MDX compiles JSX)", () => {
    expect(v(["page.mdx"], 10)).toBe("full");
  });

  test("empty diff ⇒ full (nothing to safely bypass)", () => {
    expect(v([], 0)).toBe("full");
  });

  test("extensionless files (LICENSE, .gitignore) ⇒ full unless in allow_paths", () => {
    expect(v(["LICENSE"], 5)).toBe("full");
    expect(v([".gitignore"], 2)).toBe("full");
    expect(v(["LICENSE"], 5, { ...CFG, allow_paths: ["LICENSE"] })).toBe("light");
  });

  test("enabled:false ⇒ full for any diff, even docs-only", () => {
    expect(v(["README.md"], 3, { ...CFG, enabled: false })).toBe("full");
  });

  test("deleted code file (appears in diff) ⇒ full", () => {
    expect(v(["deleted.ts", "README.md"], 0)).toBe("full");
  });
});

describe("behavior-steering docs force full (.md IS behavior here)", () => {
  const v = (files: string[]): Verdict => classifyDiff(files, 5, CFG).verdict;

  test("SKILL.md / CLAUDE.md / AGENTS.md / copilot-instructions.md ⇒ full", () => {
    expect(v(["skills/reviewer/SKILL.md"])).toBe("full");
    expect(v(["CLAUDE.md"])).toBe("full");
    expect(v(["AGENTS.md"])).toBe("full");
    expect(v([".github/copilot-instructions.md"])).toBe("full");
  });

  test("anything under .claude/ , .github/ , commands/ , agents/ ⇒ full", () => {
    expect(v([".claude/settings-notes.md"])).toBe("full");
    expect(v([".github/notes.md"])).toBe("full");
    expect(v(["commands/foo.md"])).toBe("full");
    expect(v(["agents/persona.md"])).toBe("full");
  });

  test("a normal doc that is NOT behavior-steering ⇒ light", () => {
    expect(v(["docs/user-guide.md", "README.md"])).toBe("light");
  });

  test("behavior doc wins even if listed in allow_paths (can't be dialed off)", () => {
    expect(classifyDiff(["CLAUDE.md"], 5, { ...CFG, allow_paths: ["CLAUDE.md"] }).verdict).toBe("full");
  });

  // Case-insensitivity is deliberate, not incidental: on a case-insensitive
  // filesystem `claude.md` IS `CLAUDE.md`, so a casing variant must not be a
  // way to smuggle a behavior doc past the gate.
  test.each([
    "claude.md",
    "Claude.md",
    "agents.md",
    "skill.md",
    "docs/Skill.MD",
    ".Claude/notes.md",
    ".GitHub/notes.md",
    "Commands/foo.md",
    "Agents/persona.md",
  ])("a casing variant (%s) still forces full", (path) => {
    expect(v([path])).toBe("full");
  });
});

// ── getDiffFiles / CLI: the I/O half, exercised against real throwaway repos ──
//
// Everything below builds a git repo under the OS temp dir and removes it in
// afterAll. Nothing touches the repo this suite lives in.

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test Runner", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const put = (root: string, relPath: string, content: string | Uint8Array): void => {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

/**
 * A repo with `base` committed on `main`, then `files` written (and `mutate`
 * applied) on a `feature` branch — so `main...HEAD` is a real two-point diff.
 * Anything that must pre-exist the change belongs in `base`: a file both created
 * and removed on the branch nets out of a three-dot diff entirely.
 */
function makeRepo(opts: {
  base?: Record<string, string | Uint8Array>;
  files?: Record<string, string | Uint8Array>;
  mutate?: (dir: string) => void;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "crucible-lightpath-"));
  sandboxes.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  put(dir, "base.txt", "base\n");
  for (const [path, content] of Object.entries(opts.base ?? {})) put(dir, path, content);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  for (const [path, content] of Object.entries(opts.files ?? {})) put(dir, path, content);
  opts.mutate?.(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "change"]);
  return dir;
}

const emptyDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "crucible-nonrepo-"));
  sandboxes.push(dir);
  return dir;
};

describe("getDiffFiles — reads the real diff", () => {
  test("returns every changed path and the summed added LOC", () => {
    const repo = makeRepo({
      files: { "docs/guide.md": "a\nb\nc\n", "notes.txt": "one\ntwo\n" },
    });
    const stat = getDiffFiles(repo, "main");
    expect(stat.files.sort()).toEqual(["docs/guide.md", "notes.txt"]);
    expect(stat.addedLoc).toBe(5);
  });

  test("no changes on the branch ⇒ empty file list and 0 LOC", () => {
    const dir = mkdtempSync(join(tmpdir(), "crucible-lightpath-"));
    sandboxes.push(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    put(dir, "base.txt", "base\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    git(dir, ["checkout", "-q", "-b", "feature"]);
    expect(getDiffFiles(dir, "main")).toEqual({ files: [], addedLoc: 0 });
  });

  test("a deleted file still appears in the file list", () => {
    const repo = makeRepo({
      base: { "doomed.ts": "export const x = 1;\n" },
      mutate: (dir) => rmSync(join(dir, "doomed.ts")),
    });
    expect(getDiffFiles(repo, "main").files).toContain("doomed.ts");
  });

  // A binary blob has no line count; git prints "-" for added/removed. It must
  // contribute 0 LOC WITHOUT vanishing from `files`, or a binary-only diff would
  // read as an empty, under-budget change.
  test("a binary file contributes 0 LOC but is still listed", () => {
    const blob = new Uint8Array([0, 1, 2, 3, 0, 255, 128, 0]);
    const repo = makeRepo({ files: { "assets/logo.png": blob, "docs/a.md": "x\ny\n" } });
    const stat = getDiffFiles(repo, "main");
    expect(stat.files).toContain("assets/logo.png");
    expect(stat.addedLoc).toBe(2); // only the 2 markdown lines counted
  });

  // The --no-renames guard. Without it git emits a single `code.ts => doc.md`
  // numstat line, whose extname reads `.md` — a code file laundered into an
  // allow-listed extension. With it, both sides land as their own clean paths.
  test("a code→doc rename yields both plain paths, never the `old => new` form", () => {
    const repo = makeRepo({
      base: { "code.ts": "export const value = 1;\n" },
      mutate: (dir) => git(dir, ["mv", "code.ts", "doc.md"]),
    });
    const stat = getDiffFiles(repo, "main");
    expect(stat.files.sort()).toEqual(["code.ts", "doc.md"]);
    for (const f of stat.files) expect(f).not.toContain("=>");
    expect(classifyDiff(stat.files, stat.addedLoc, CFG).verdict).toBe("full");
  });

  // Why the assertion above matters, stated without depending on git's version:
  // if the ambiguous form ever reached the classifier it would be judged on its
  // trailing `.md` and wave a TypeScript rename through as inert.
  test("CONTROL: the ambiguous `old => new` path would classify light", () => {
    expect(classifyDiff(["code.ts => doc.md"], 0, CFG).verdict).toBe("light");
  });

  test("throws outside a git repo (callers must fail closed)", () => {
    expect(() => getDiffFiles(emptyDir(), "main")).toThrow();
  });

  test("throws when the base ref does not exist", () => {
    const repo = makeRepo({ files: { "docs/a.md": "x\n" } });
    expect(() => getDiffFiles(repo, "origin/does-not-exist")).toThrow();
  });
});

describe("runClassifyCli — the gate must never emit `light` on an error", () => {
  const loader = (): LightPathConfig => CFG;

  test("docs-only diff ⇒ light on stdout, reason on stderr, exit 0", () => {
    const repo = makeRepo({ files: { "docs/guide.md": "a\nb\n" } });
    const out = runClassifyCli(["classify", "--base", "main"], repo, loader);
    expect(out.stdout).toBe("light");
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("2 added LOC");
  });

  test("a code file in the diff ⇒ full, naming the offending file", () => {
    const repo = makeRepo({ files: { "docs/guide.md": "a\n", "src/index.ts": "export const x = 1;\n" } });
    const out = runClassifyCli(["classify", "--base", "main"], repo, loader);
    expect(out.stdout).toBe("full");
    expect(out.stderr).toContain("non-inert file: src/index.ts");
  });

  test("--json emits the verdict with the evidence it was based on", () => {
    const repo = makeRepo({ files: { "docs/guide.md": "a\nb\nc\n" } });
    const out = runClassifyCli(["classify", "--base", "main", "--json"], repo, loader);
    expect(out.stderr).toBe("");
    expect(JSON.parse(out.stdout)).toEqual({
      verdict: "light",
      reason: "1 inert file(s), 3 added LOC",
      files: ["docs/guide.md"],
      addedLoc: 3,
    });
  });

  // The three ways the CLI can fail. Each must land on "full": a shell gate reads
  // stdout, so anything else here ships unreviewed code.
  test("an unreadable diff (not a git repo) ⇒ full", () => {
    const out = runClassifyCli(["classify"], emptyDir(), loader);
    expect(out.stdout).toBe("full");
    expect(out.stderr).toContain("classifier error");
    expect(out.exitCode).toBe(0);
  });

  test("a missing base ref ⇒ full", () => {
    const repo = makeRepo({ files: { "docs/guide.md": "a\n" } });
    const out = runClassifyCli(["classify", "--base", "origin/nope"], repo, loader);
    expect(out.stdout).toBe("full");
    expect(out.stderr).toContain("classifier error");
  });

  test("a config load that throws ⇒ full, not a crash", () => {
    const repo = makeRepo({ files: { "docs/guide.md": "a\n" } });
    const out = runClassifyCli(["classify", "--base", "main"], repo, () => {
      throw new Error("unparseable .crucible.yaml");
    });
    expect(out.stdout).toBe("full");
    expect(out.stderr).toContain("unparseable .crucible.yaml");
  });

  test("the default base is origin/main — absent in a bare local repo, so ⇒ full", () => {
    const repo = makeRepo({ files: { "docs/guide.md": "a\n" } });
    expect(runClassifyCli(["classify"], repo, loader).stdout).toBe("full");
  });

  test("an unknown subcommand exits 1 and prints NOTHING on stdout", () => {
    const out = runClassifyCli(["ligtht"], emptyDir(), loader);
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("usage:");
  });

  test("no subcommand at all exits 1 rather than defaulting to a verdict", () => {
    expect(runClassifyCli([], emptyDir(), loader)).toMatchObject({ exitCode: 1, stdout: "" });
  });

  test("the config actually reaches the classifier (a disabled config forces full)", () => {
    const repo = makeRepo({ files: { "docs/guide.md": "a\n" } });
    const out = runClassifyCli(["classify", "--base", "main"], repo, () => ({ ...CFG, enabled: false }));
    expect(out.stdout).toBe("full");
    expect(out.stderr).toContain("light-path disabled");
  });
});

describe("hardenLightPathForGate — config may only NARROW", () => {
  test("a doctored config adding code extensions is clamped to the safe set", () => {
    const doctored: LightPathConfig = { enabled: true, allow_extensions: [".ts", ".js", ".md"], allow_paths: ["evil.ts"], max_loc: 999999 };
    const gated = hardenLightPathForGate(doctored);
    expect(gated.allow_extensions).toEqual([".md"]); // .ts/.js dropped
    expect(gated.allow_paths).toEqual([]); // path-widening dropped
    expect(gated.max_loc).toBe(1000); // capped
    expect(classifyDiff(["evil.ts"], 1, gated).verdict).toBe("full");
  });

  test("config CAN still narrow (disable, drop extensions, lower LOC)", () => {
    const narrowed = hardenLightPathForGate({ enabled: false, allow_extensions: [".md"], allow_paths: [], max_loc: 50 });
    expect(narrowed.enabled).toBe(false);
    expect(narrowed.max_loc).toBe(50);
  });
});
