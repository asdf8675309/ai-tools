/**
 * Preflight — the reviewer-descriptor contract with crucible.workflow.js.
 *
 * Unit-level because a default checkout ships every integration disabled: every
 * reviewer resolves to `kind: "claude"`, so a live run never exercises the gateway,
 * local, or external-CLI branches. These drive each one directly.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, mergeConfig, REVIEWER_ROLES, resolveReviewer, type CrucibleConfig, type ResolvedModel } from "./Config.ts";
import { countTabifiable, resolveChecklistPath, SCHEMA_KIND, toReviewer } from "./Preflight.ts";

const KEY_ENV = "CRUCIBLE_TEST_PREFLIGHT_KEY";
const SECRET = "sk-preflight-must-never-appear";

const cfgWith = (overlay: Record<string, unknown>): CrucibleConfig => mergeConfig(DEFAULT_CONFIG, overlay);

const REPO = "/repo";

describe("kind mapping (schema enum, not resolver vocabulary)", () => {
  // An unmapped value does not throw — it falls through the workflow's if-chain
  // to the GATEWAY branch and POSTs to `undefined/chat/completions`.
  test("cli maps to external_cli", () => {
    const resolved = {
      kind: "cli",
      provider_key: "cli-codex",
      command: "codex",
      args: ["exec"],
      reasoning_effort: "high",
      fallbacks: [],
    } as ResolvedModel;
    expect(toReviewer("security", resolved, cfgWith({}), REPO).kind).toBe("external_cli");
  });

  test("every ModelRuntime kind maps to a value the workflow schema declares", () => {
    // Read the enum out of the SHIPPED workflow rather than restating it here —
    // a test that hardcodes its own copy passes happily while the two drift.
    const wf = Bun.file(join(import.meta.dir, "..", "workflows", "crucible.workflow.js"));
    const src = wf.text();
    return src.then((text) => {
      const m = text.match(/kind:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]+)\]/);
      expect(m).not.toBeNull();
      const declared = (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, ""));
      expect(declared.length).toBeGreaterThan(0);
      for (const mapped of Object.values(SCHEMA_KIND)) expect(declared).toContain(mapped);
    });
  });
});

describe("dispatch fields the workflow actually reads", () => {
  test("gateway carries endpoint and apiKeyEnv", () => {
    // The workflow POSTs to `${r.endpoint}/chat/completions` with the env var
    // NAMED by r.apiKeyEnv. Omit either and every gateway reviewer dies.
    const resolved = {
      kind: "gateway",
      provider_key: "gateway-alt",
      model: "vendor/some-model",
      base_url: "https://gw.example/v1",
      api_key_env: KEY_ENV,
      timeout_ms: 1000,
      max_tokens: 16384,
      fallbacks: [],
    } as ResolvedModel;
    const r = toReviewer("security", resolved, cfgWith({}), REPO);
    expect(r.endpoint).toBe("https://gw.example/v1");
    expect(r.apiKeyEnv).toBe(KEY_ENV);
    expect(r.modelOrSlug).toBe("vendor/some-model");
  });

  test("gateway carries the resolved timeout and token ceiling", () => {
    // Config resolves these (including the per-route gateway_model_timeouts
    // override) and they are useless unless the descriptor carries them to the
    // dispatch path. Testing resolveReviewer alone passes while they are dropped.
    const resolved = {
      kind: "gateway",
      provider_key: "gateway-alt",
      model: "vendor/some-model",
      base_url: "https://gw.example/v1",
      api_key_env: KEY_ENV,
      timeout_ms: 45_000,
      max_tokens: 32_000,
      fallbacks: [],
    } as ResolvedModel;
    const r = toReviewer("security", resolved, cfgWith({}), REPO);
    expect(r.timeoutMs).toBe(45_000);
    expect(r.maxTokens).toBe(32_000);
  });

  test("non-gateway kinds carry no timeout or token ceiling", () => {
    const claude = { kind: "claude", provider_key: "claude-sonnet", model: "sonnet", fallbacks: [] } as ResolvedModel;
    const r = toReviewer("code_quality", claude, cfgWith({}), REPO);
    expect(r.timeoutMs).toBeUndefined();
    expect(r.maxTokens).toBeUndefined();
  });

  test("apiKeyEnv is the variable NAME — the value never enters the payload", () => {
    process.env[KEY_ENV] = SECRET;
    try {
      const resolved = {
        kind: "gateway",
        provider_key: "gateway-alt",
        model: "vendor/some-model",
        base_url: "https://gw.example/v1",
        api_key_env: KEY_ENV,
        timeout_ms: 1000,
        max_tokens: 16384,
        fallbacks: [],
      } as ResolvedModel;
      const serialized = JSON.stringify(toReviewer("security", resolved, cfgWith({}), REPO));
      expect(serialized).toContain(KEY_ENV);
      expect(serialized).not.toContain(SECRET);
    } finally {
      delete process.env[KEY_ENV];
    }
  });

  test("local carries endpoint", () => {
    const resolved = {
      kind: "local",
      provider_key: "local-embed",
      endpoint: "http://127.0.0.1:1234/v1",
      model: "some-embedding-model",
      fallbacks: [],
    } as ResolvedModel;
    const r = toReviewer("clone_detector", resolved, cfgWith({}), REPO);
    expect(r.endpoint).toBe("http://127.0.0.1:1234/v1");
    expect(r.apiKeyEnv).toBeUndefined();
  });

  test("external_cli carries reasoningEffort and fallback, in the schema's camelCase", () => {
    // `fallback` lives on the external_cli_map ENTRY, not on ModelRuntime, so it
    // is the one field that cannot come from the resolved runtime alone.
    const cfg = cfgWith({
      external_cli_map: { "cli-codex": { command: "codex", args: ["exec"], reasoning_effort: "high", fallback: "claude-sonnet" } },
    });
    const resolved = {
      kind: "cli",
      provider_key: "cli-codex",
      command: "codex",
      args: ["exec"],
      reasoning_effort: "high",
      fallbacks: [],
    } as ResolvedModel;
    const r = toReviewer("test_runner", resolved, cfg, REPO);
    expect(r.reasoningEffort).toBe("high");
    expect(r.fallback).toBe("claude-sonnet");
    // snake_case would read as undefined at `r.reasoningEffort` in the workflow.
    expect(Object.keys(r)).not.toContain("reasoning_effort");
  });

  test("claude carries no endpoint or credential fields at all", () => {
    const resolved = { kind: "claude", provider_key: "claude-sonnet", model: "sonnet", fallbacks: [] } as ResolvedModel;
    const r = toReviewer("code_quality", resolved, cfgWith({}), REPO);
    expect(r.endpoint).toBeUndefined();
    expect(r.apiKeyEnv).toBeUndefined();
    expect(r.modelOrSlug).toBe("sonnet");
  });
});

describe("checklist resolution", () => {
  const dirs: string[] = [];
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), "crucible-preflight-"));
    dirs.push(d);
    return d;
  };
  const cleanup = () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  };

  test("the repo's own override wins over the skill's shipped checklist", () => {
    const repo = mk();
    const override = join(repo, ".github", "agents", "security-reviewer.md");
    mkdirSync(dirname(override), { recursive: true });
    writeFileSync(override, "# repo override\n");
    expect(resolveChecklistPath(repo, "security")).toBe(override);
    cleanup();
  });

  test("falls back to the skill's shipped checklist, and it really exists", () => {
    const repo = mk();
    const p = resolveChecklistPath(repo, "security");
    expect(p).not.toBe("inline");
    expect(p.endsWith("/agents/security-reviewer.md")).toBe(true);
    cleanup();
  });

  test("underscored roles map onto hyphenated checklist filenames", () => {
    // code_quality → code-quality-reviewer.md. Getting this wrong degrades every
    // multi-word reviewer to "inline" without any error.
    const repo = mk();
    expect(resolveChecklistPath(repo, "code_quality").endsWith("/agents/code-quality-reviewer.md")).toBe(true);
    cleanup();
  });

  test("an unknown role degrades to inline rather than throwing", () => {
    const repo = mk();
    expect(resolveChecklistPath(repo, "no_such_role")).toBe("inline");
    cleanup();
  });
});

describe("roster", () => {
  test("all 10 roles resolve, pr_continuity included", () => {
    expect(REVIEWER_ROLES.length).toBe(10);
    expect(REVIEWER_ROLES).toContain("pr_continuity");
    const cfg = cfgWith({});
    const rs = REVIEWER_ROLES.map((role) => toReviewer(role, resolveReviewer(role, cfg), cfg, REPO));
    expect(rs.length).toBe(10);
    for (const r of rs) {
      expect(Object.values(SCHEMA_KIND)).toContain(r.kind);
      expect(r.modelOrSlug.length).toBeGreaterThan(0);
      expect(r.providerKey.length).toBeGreaterThan(0);
    }
  });
});

describe("R10 tabify count", () => {
  // The repo under test has no Python, so a live preflight reports 0 whether the
  // counter works or is hardcoded. These give it something to count.
  const dirs: string[] = [];
  const mkRepo = (files: Record<string, string>) => {
    const d = mkdtempSync(join(tmpdir(), "crucible-tabify-"));
    dirs.push(d);
    for (const [name, body] of Object.entries(files)) {
      const p = join(d, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    return d;
  };
  const cleanup = () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  };
  const claude = [{ role: "code_quality", kind: "claude", modelOrSlug: "sonnet", providerKey: "claude-sonnet", checklistPath: "inline" }] as const;

  test("counts the indented Python sources it would compress", () => {
    const repo = mkRepo({ "a.py": "def f():\n    return 1\n", "b.py": "def g():\n    return 2\n", "c.ts": "export const x = 1\n" });
    expect(countTabifiable(repo, ["a.py", "b.py", "c.ts"], [...claude])).toBe(2);
    cleanup();
  });

  test("a code-tuned reviewer in the roster zeroes it — tabify is net negative there", () => {
    // Every reviewer receives the SAME shared context, so the transform cannot be
    // per-reviewer: one codex-family lens makes it the wrong call for everyone.
    const repo = mkRepo({ "a.py": "def f():\n    return 1\n" });
    const mixed = [...claude, { role: "test_runner", kind: "external_cli" as const, modelOrSlug: "codex", providerKey: "cli-codex", checklistPath: "inline" }];
    expect(countTabifiable(repo, ["a.py"], mixed)).toBe(0);
    cleanup();
  });

  test("a file deleted in the diff is skipped, not counted and not fatal", () => {
    const repo = mkRepo({ "kept.py": "def f():\n    return 1\n" });
    expect(countTabifiable(repo, ["kept.py", "gone.py"], [...claude])).toBe(1);
    cleanup();
  });
});

describe("import safety", () => {
  test("importing this module does not run the CLI", () => {
    // Without the `import.meta.main` guard, importing Preflight.ts at the top of
    // this file would run a full preflight and process.exit before we got here.
    expect(true).toBe(true);
  });
});
