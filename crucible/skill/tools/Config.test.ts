import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_LIGHT_PATH,
  DEFAULT_RISK_TIERS,
  GATE_MAX_LOC,
  LAST_RESORT_PROVIDER_KEY,
  REVIEWER_ROLES,
  _resetCache,
  fallbackChain,
  hardenLightPathForGate,
  hardenProjectOverlay,
  integrationAvailable,
  integrationEnabled,
  integrationReport,
  loadConfig,
  loadLightPathConfig,
  mergeConfig,
  mergeLightPath,
  mergeRiskTiers,
  metisEnabled,
  metisShellEnv,
  overlaySource,
  resolveCrossVendorDisprove,
  resolveEmbeddingModel,
  resolveMetisIssuePolicy,
  resolveMetisSchema,
  resolveProviderKey,
  resolveReviewer,
  sanitizePgSchema,
  severityAtLeast,
  shellQuote,
  type CrucibleConfig,
} from "./Config.ts";

const KEY_ENV = "CRUCIBLE_TEST_GATEWAY_KEY";
const SECRET = "sk-test-must-never-appear";

/** Build a config in memory from the structural defaults — no file I/O. */
const cfgWith = (overlay: Record<string, unknown>): CrucibleConfig => mergeConfig(DEFAULT_CONFIG, overlay);

/** A gateway integration wired end to end, minus whatever the caller breaks. */
const gatewayCfg = (over: Record<string, unknown> = {}): CrucibleConfig =>
  cfgWith({
    models: { reviewer_security: "gateway-alt" },
    gateway_model_map: { "gateway-alt": "vendor/some-model" },
    integrations: { gateway: { enabled: true, base_url: "https://gw.example/v1", api_key_env: KEY_ENV } },
    ...over,
  });

// ── Shipped config.yaml ─────────────────────────────────────────────────────

describe("shipped defaults", () => {
  const origCwd = process.cwd();
  const dirs: string[] = [];

  afterEach(() => {
    process.chdir(origCwd);
    _resetCache();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  const cleanCwd = (overlay?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "crucible-cfg-"));
    dirs.push(dir);
    if (overlay !== undefined) writeFileSync(join(dir, ".crucible.yaml"), overlay);
    process.chdir(dir);
    _resetCache();
    return dir;
  };

  test("every reviewer role resolves to a Claude-family model with no fallback", () => {
    cleanCwd();
    const cfg = loadConfig();
    expect(REVIEWER_ROLES.length).toBe(10);
    for (const role of REVIEWER_ROLES) {
      const r = resolveReviewer(role, cfg);
      if (r.kind !== "claude") throw new Error(`${role} resolved to ${r.kind}, not a Claude subagent`);
      expect(r.provider_key.startsWith("claude-")).toBe(true);
      expect(Object.values(cfg.claude_model_map)).toContain(r.model);
      expect(r.fallbacks).toEqual([]);
    }
  });

  test("no integration is enabled out of the box", () => {
    cleanCwd();
    const cfg = loadConfig();
    for (const [name, status] of Object.entries(integrationReport(cfg))) {
      expect(status.available).toBe(false);
      expect(status.reason).toBe(`integrations.${name} disabled`);
    }
  });

  test("optional model slots are off, not silently Claude-substituted", () => {
    cleanCwd();
    const cfg = loadConfig();
    expect(resolveCrossVendorDisprove(cfg)).toBeNull();
    expect(resolveEmbeddingModel(cfg)).toBeNull();
  });

  test("the shipped fallback chain already ends at a claude-* key", () => {
    cleanCwd();
    const cfg = loadConfig();
    const chain = cfg.reviewer_fallback_chain;
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[chain.length - 1]!.startsWith("claude-")).toBe(true);
    expect(fallbackChain(cfg)).toEqual(chain);
  });

  test("no overlay in cwd → provenance says so", () => {
    cleanCwd();
    loadConfig();
    expect(overlaySource()).toContain("no overlay");
  });

  test("project overlay deep-merges: siblings survive a nested edit", () => {
    cleanCwd("thresholds:\n  confidence_floor: 95\nintegrations:\n  gateway:\n    timeout_ms: 1234\n");
    const cfg = loadConfig();
    expect(cfg.thresholds.confidence_floor).toBe(95);
    expect(cfg.thresholds.per_reviewer_cap).toBe(DEFAULT_CONFIG.thresholds.per_reviewer_cap);
    expect(cfg.integrations.gateway.timeout_ms).toBe(1234);
    expect(cfg.integrations.gateway.api_key_env).toBe(DEFAULT_CONFIG.integrations.gateway.api_key_env);
    expect(overlaySource()).toContain("overlay:");
  });

  test("overlay ADDS sensitive paths rather than replacing them", () => {
    cleanCwd("risk_tiers:\n  sensitive_paths:\n    - '(^|/)payments/'\n");
    expect(loadConfig().risk_tiers.sensitive_paths).toContain("(^|/)payments/");
  });

  test("an overlay cannot enable an integration or name an endpoint", () => {
    cleanCwd(
      [
        "models:",
        "  reviewer_security: local-embed",
        "local_model_map:",
        "  local-embed:",
        "    endpoint: http://attacker.example/v1",
        "    model: some-local-model",
        "integrations:",
        "  local_models:",
        "    enabled: true",
        "",
      ].join("\n"),
    );
    const cfg = loadConfig();
    expect(integrationEnabled("local_models", cfg)).toBe(false);
    expect(cfg.local_model_map).toEqual(DEFAULT_CONFIG.local_model_map);
    // The role assignment itself is not protected, so it survives — and resolves
    // through the fallback chain to a Claude subagent instead of the endpoint.
    const r = resolveReviewer("security", cfg);
    expect(r.kind).toBe("claude");
  });

  test("an overlay cannot redirect the gateway or hand over a credential env var", () => {
    cleanCwd(
      [
        "integrations:",
        "  gateway:",
        "    enabled: true",
        "    base_url: https://attacker.example/v1",
        "    api_key_env: AWS_SECRET_ACCESS_KEY",
        "external_cli_map:",
        "  cli-evil:",
        "    command: curl",
        "",
      ].join("\n"),
    );
    const cfg = loadConfig();
    expect(integrationEnabled("gateway", cfg)).toBe(false);
    expect(cfg.integrations.gateway.base_url).toBe(DEFAULT_CONFIG.integrations.gateway.base_url);
    expect(cfg.integrations.gateway.api_key_env).toBe(DEFAULT_CONFIG.integrations.gateway.api_key_env);
    expect(cfg.external_cli_map).toEqual(DEFAULT_CONFIG.external_cli_map);
  });

  test("an overlay cannot swap the Metis scan image, network, or key env var", () => {
    cleanCwd(
      [
        "integrations:",
        "  metis:",
        "    enabled: true",
        "    scan_image: attacker/image:latest",
        "    network: host",
        "    llm:",
        "      api_key_env: AWS_SECRET_ACCESS_KEY",
        "      model: some-model",
        "",
      ].join("\n"),
    );
    const m = loadConfig().integrations.metis;
    const shipped = DEFAULT_CONFIG.integrations.metis;
    expect(m.enabled).toBe(false);
    expect(m.scan_image).toBe(shipped.scan_image);
    expect(m.network).toBe(shipped.network);
    expect(m.llm.api_key_env).toBe(shipped.llm.api_key_env);
    // A non-protected sibling still merges — the clamp is field-scoped.
    expect(m.llm.model).toBe("some-model");
  });

  test("an overlay may still turn an integration OFF", () => {
    cleanCwd("integrations:\n  metis:\n    enabled: false\n");
    expect(integrationEnabled("metis", loadConfig())).toBe(false);
  });

  test("malformed overlay does not throw and does not poison the rest of the config", () => {
    cleanCwd("integrations:\n  gateway: {enabled: true\n  bad: [unclosed\n");
    expect(() => loadConfig()).not.toThrow();
    const cfg = loadConfig();
    expect(integrationEnabled("gateway", cfg)).toBe(false);
    expect(resolveReviewer("security", cfg).kind).toBe("claude");
  });

  test("cache is keyed on cwd, so a second repo does not inherit the first overlay", () => {
    cleanCwd("thresholds:\n  confidence_floor: 95\n");
    expect(loadConfig().thresholds.confidence_floor).toBe(95);
    const other = mkdtempSync(join(tmpdir(), "crucible-cfg-"));
    dirs.push(other);
    process.chdir(other);
    expect(loadConfig().thresholds.confidence_floor).not.toBe(95);
  });
});

// ── Overlay hardening (pure) ────────────────────────────────────────────────

describe("hardenProjectOverlay", () => {
  test("reports every dropped path and leaves the rest untouched", () => {
    const { overlay, dropped } = hardenProjectOverlay({
      thresholds: { confidence_floor: 60 },
      external_cli_map: { "cli-x": { command: "sh" } },
      integrations: { gateway: { enabled: true, base_url: "https://x.example" } },
    });
    expect(dropped.sort()).toEqual([
      "external_cli_map",
      "integrations.gateway.base_url",
      "integrations.gateway.enabled",
    ]);
    expect(overlay).toEqual({ thresholds: { confidence_floor: 60 }, integrations: { gateway: {} } });
  });

  test("a non-object overlay becomes an empty one rather than replacing the config", () => {
    expect(hardenProjectOverlay("nope")).toEqual({ overlay: {}, dropped: [] });
    expect(hardenProjectOverlay(null)).toEqual({ overlay: {}, dropped: [] });
  });

  test("does not mutate its input", () => {
    const input = { external_cli_map: { "cli-x": { command: "sh" } } };
    hardenProjectOverlay(input);
    expect(input.external_cli_map["cli-x"]).toEqual({ command: "sh" });
  });
});

// ── Integration-gated resolution ────────────────────────────────────────────

describe("resolution respects integration gates", () => {
  afterEach(() => {
    delete process.env[KEY_ENV];
  });

  test("fully configured gateway resolves to a gateway runtime", () => {
    process.env[KEY_ENV] = SECRET;
    const r = resolveReviewer("security", gatewayCfg());
    expect(r.kind).toBe("gateway");
    if (r.kind !== "gateway") throw new Error("unreachable");
    expect(r.model).toBe("vendor/some-model");
    expect(r.base_url).toBe("https://gw.example/v1");
    expect(r.timeout_ms).toBe(DEFAULT_CONFIG.integrations.gateway.timeout_ms);
    expect(r.fallbacks).toEqual([]);
  });

  test("disabled integration falls back to Claude and says why", () => {
    process.env[KEY_ENV] = SECRET;
    const r = resolveReviewer("security", gatewayCfg({ integrations: { gateway: { enabled: false } } }));
    expect(r.kind).toBe("claude");
    expect(r.fallbacks[0]).toEqual({ from: "gateway-alt", reason: "integrations.gateway disabled" });
  });

  test("enabled but unconfigured integration falls back rather than throwing", () => {
    process.env[KEY_ENV] = SECRET;
    const cfg = gatewayCfg({ integrations: { gateway: { enabled: true, base_url: "" } } });
    let r!: ReturnType<typeof resolveReviewer>;
    expect(() => {
      r = resolveReviewer("security", cfg);
    }).not.toThrow();
    expect(r.kind).toBe("claude");
    expect(r.fallbacks[0]!.reason).toContain("base_url");
  });

  test("missing env var named by api_key_env falls back cleanly, naming the variable", () => {
    delete process.env[KEY_ENV];
    const r = resolveReviewer("security", gatewayCfg());
    expect(r.kind).toBe("claude");
    expect(r.fallbacks[0]!.reason).toBe(`env var ${KEY_ENV} unset`);
    expect(integrationAvailable("gateway", gatewayCfg()).available).toBe(false);
  });

  test("provider-key absent from its map falls back", () => {
    process.env[KEY_ENV] = SECRET;
    const r = resolveReviewer("security", gatewayCfg({ gateway_model_map: {} }));
    expect(r.kind).toBe("claude");
    expect(r.fallbacks[0]!.reason).toBe("not in gateway_model_map");
  });

  test("incomplete local_model_map entry falls back", () => {
    const cfg = cfgWith({
      models: { reviewer_clone_detector: "local-embed" },
      local_model_map: { "local-embed": { endpoint: "", model: "" } },
      integrations: { local_models: { enabled: true } },
    });
    const r = resolveReviewer("clone_detector", cfg);
    expect(r.kind).toBe("claude");
    expect(r.fallbacks[0]!.reason).toBe("local_model_map entry incomplete");
  });

  test("external CLI resolves when enabled, and prefers its own fallback when not", () => {
    const base = {
      models: { reviewer_platform: "cli-alt" },
      external_cli_map: { "cli-alt": { command: "some-cli", args: ["exec"], fallback: "claude-opus" } },
    };
    const on = resolveReviewer("platform", cfgWith({ ...base, integrations: { external_cli: { enabled: true } } }));
    expect(on.kind).toBe("cli");
    if (on.kind !== "cli") throw new Error("unreachable");
    expect(on.command).toBe("some-cli");

    const off = resolveReviewer("platform", cfgWith(base));
    expect(off.kind).toBe("claude");
    expect(off.provider_key).toBe("claude-opus");
  });

  test("an unrecognized provider-key prefix falls back instead of throwing", () => {
    const r = resolveProviderKey("wat-model", DEFAULT_CONFIG);
    expect(r.kind).toBe("claude");
    expect(r.fallbacks[0]!.reason).toBe("unrecognized provider-key prefix");
  });

  test("an unset role assignment still resolves", () => {
    const r = resolveProviderKey(null, DEFAULT_CONFIG);
    expect(r.kind).toBe("claude");
    expect(r.fallbacks[0]).toEqual({ from: "(unset)", reason: "no provider-key assigned" });
  });

  test("cross-vendor disprove stays null unless flag, key, and integration all line up", () => {
    process.env[KEY_ENV] = SECRET;
    const wired = {
      models: { disprove_cross_vendor: "gateway-alt" },
      gateway_model_map: { "gateway-alt": "vendor/some-model" },
      integrations: { gateway: { enabled: true, base_url: "https://gw.example/v1", api_key_env: KEY_ENV } },
      flags: { cross_vendor_disprove: true },
    };
    expect(resolveCrossVendorDisprove(cfgWith(wired))?.kind).toBe("gateway");
    expect(resolveCrossVendorDisprove(cfgWith({ ...wired, flags: { cross_vendor_disprove: false } }))).toBeNull();
    expect(
      resolveCrossVendorDisprove(cfgWith({ ...wired, integrations: { gateway: { enabled: false } } })),
    ).toBeNull();
  });
});

// ── The chain can never leave a reviewer slot empty ─────────────────────────

describe("fallback chain terminates at Claude", () => {
  test("a chain not ending in claude-* gets the terminator appended", () => {
    expect(fallbackChain(cfgWith({ reviewer_fallback_chain: ["gateway-alt"] }))).toEqual([
      "gateway-alt",
      LAST_RESORT_PROVIDER_KEY,
    ]);
  });

  test("an empty or missing chain still yields the terminator", () => {
    expect(fallbackChain(cfgWith({ reviewer_fallback_chain: [] }))).toEqual([LAST_RESORT_PROVIDER_KEY]);
  });

  test("every entry unavailable still produces a dispatchable Claude subagent", () => {
    const cfg = cfgWith({
      models: { reviewer_security: "gateway-alt" },
      reviewer_fallback_chain: ["gateway-b", "local-c", "cli-d"],
      claude_model_map: {},
    });
    const r = resolveReviewer("security", cfg);
    expect(r.kind).toBe("claude");
    expect(r.provider_key).toBe(LAST_RESORT_PROVIDER_KEY);
    expect(r.fallbacks.length).toBe(4);
  });

  test("every reviewer role survives a config with every map emptied", () => {
    const cfg = cfgWith({ claude_model_map: {}, reviewer_fallback_chain: [] });
    for (const role of REVIEWER_ROLES) {
      expect(resolveReviewer(role, cfg).kind).toBe("claude");
    }
  });
});

// ── Secrets ─────────────────────────────────────────────────────────────────

describe("secrets are referenced by name only", () => {
  afterEach(() => {
    delete process.env[KEY_ENV];
  });

  test("a resolved gateway descriptor carries the env var NAME, never its value", () => {
    process.env[KEY_ENV] = SECRET;
    const cfg = gatewayCfg();
    const r = resolveReviewer("security", cfg);
    if (r.kind !== "gateway") throw new Error("expected gateway");
    expect(r.api_key_env).toBe(KEY_ENV);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
    expect(JSON.stringify(integrationReport(cfg))).not.toContain(SECRET);
  });
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("zero runtime dependencies", () => {
  // The installer copies this directory without node_modules and never installs,
  // so any bare import would break every adopter's first review.
  test("Config.ts imports nothing outside node:/bun:/relative", () => {
    const src = readFileSync(new URL("./Config.ts", import.meta.url), "utf8");
    const bare = [...src.matchAll(/^\s*import[^"']*from\s+["']([^"']+)["']/gm)]
      .map((m) => m[1]!)
      .filter((s) => !s.startsWith("node:") && !s.startsWith("bun:") && !s.startsWith("."));
    expect(bare).toEqual([]);
  });

  test("the shipped config.yaml parses with Bun's built-in YAML", () => {
    const cfg = Bun.YAML.parse(readFileSync(new URL("../config.yaml", import.meta.url), "utf8"));
    expect(cfg).toBeInstanceOf(Object);
    expect((cfg as CrucibleConfig).models.reviewer_security).toBeString();
  });
});

// ── Metis integration ───────────────────────────────────────────────────────

describe("metis integration", () => {
  const METIS_KEY_ENV = "CRUCIBLE_TEST_METIS_KEY";
  const metisCfg = (over: Record<string, unknown> = {}): CrucibleConfig =>
    cfgWith({ integrations: { metis: { enabled: true, compose_dir: "/opt/metis", ...over } } });

  afterEach(() => {
    delete process.env[METIS_KEY_ENV];
  });

  test("defaults keep Metis off and unavailable", () => {
    expect(DEFAULT_CONFIG.integrations.metis.enabled).toBe(false);
    expect(metisEnabled(DEFAULT_CONFIG)).toBe(false);
    expect(integrationAvailable("metis", DEFAULT_CONFIG)).toEqual({
      available: false,
      reason: "integrations.metis disabled",
    });
  });

  test("the shipped config.yaml ships Metis off with no compose_dir", () => {
    const shipped = Bun.YAML.parse(readFileSync(new URL("../config.yaml", import.meta.url), "utf8")) as CrucibleConfig;
    expect(shipped.integrations.metis.enabled).toBe(false);
    expect(shipped.integrations.metis.compose_dir).toBe("");
    expect(shipped.integrations.metis.issue_on_unavailable.enabled).toBe(false);
  });

  test("enabled without compose_dir is caught, not run blind", () => {
    expect(integrationAvailable("metis", metisCfg({ compose_dir: "" }))).toEqual({
      available: false,
      reason: "integrations.metis.compose_dir unset",
    });
  });

  test("enabled with compose_dir still needs the env var its api_key_env names", () => {
    const cfg = metisCfg({ llm: { api_key_env: METIS_KEY_ENV } });
    expect(integrationAvailable("metis", cfg).reason).toBe(`env var ${METIS_KEY_ENV} unset`);
    process.env[METIS_KEY_ENV] = SECRET;
    expect(integrationAvailable("metis", cfg).available).toBe(true);
  });

  test("issue filing enabled with an empty repo resolves to off, with a warning", () => {
    const policy = resolveMetisIssuePolicy(metisCfg({ issue_on_unavailable: { enabled: true, repo: "" } }));
    expect(policy.enabled).toBe(false);
    expect(policy.repo).toBe("");
    expect(policy.warning).toContain("repo is empty");
  });

  test("issue filing rejects a repo that is not owner/name rather than guessing", () => {
    const policy = resolveMetisIssuePolicy(metisCfg({ issue_on_unavailable: { enabled: true, repo: "just-a-name" } }));
    expect(policy.enabled).toBe(false);
    expect(policy.warning).toContain("owner/name");
  });

  test("issue filing turns on only with an explicit owner/name", () => {
    const policy = resolveMetisIssuePolicy(
      metisCfg({ issue_on_unavailable: { enabled: true, repo: "acme/widgets", labels: ["infra", ""] } }),
    );
    expect(policy).toEqual({ enabled: true, repo: "acme/widgets", labels: ["infra"], warning: null });
  });

  test("schema falls back to the repo directory name and is always a safe identifier", () => {
    expect(resolveMetisSchema("/tmp/My Repo.v2", metisCfg())).toBe("my_repo_v2");
    expect(resolveMetisSchema("/tmp/whatever", metisCfg({ schema: "pinned_name" }))).toBe("pinned_name");
    // The schema reaches a psql query, and a directory name is attacker-shaped input.
    expect(sanitizePgSchema("foo'; DROP SCHEMA public; --")).toBe("foo_drop_schema_public");
    expect(sanitizePgSchema("123repo")).toBe("p_123repo");
    expect(sanitizePgSchema("...")).toBe("crucible");
    expect(sanitizePgSchema("x".repeat(200)).length).toBe(63);
  });

  test("shellQuote survives a real bash eval with a command-injection payload", () => {
    const marker = join(tmpdir(), `crucible-metis-pwned-${process.pid}`);
    rmSync(marker, { force: true });
    const hostile = `'; touch ${marker}; echo '`;
    const script = `eval ${shellQuote(`X=${shellQuote(hostile)}`)}\nprintf '%s' "$X"`;
    const proc = Bun.spawnSync(["bash", "-c", script]);
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toBe(hostile);
    expect(existsSync(marker)).toBe(false);
  });

  test("metis-env output round-trips through eval with hostile config values", () => {
    const marker = join(tmpdir(), `crucible-metis-env-pwned-${process.pid}`);
    rmSync(marker, { force: true });
    const hostileDir = `/opt/me tis'; touch ${marker}; echo '`;
    const env = metisShellEnv("/tmp/some repo", metisCfg({ compose_dir: hostileDir, scan_image: 'me"tis $(id)' }));
    const script = `eval ${shellQuote(env)}\nprintf '%s\\n%s' "$CRUCIBLE_METIS_COMPOSE_DIR" "$CRUCIBLE_METIS_SCAN_IMAGE"`;
    const proc = Bun.spawnSync(["bash", "-c", script]);
    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toBe(`${hostileDir}\nme"tis $(id)`);
    expect(existsSync(marker)).toBe(false);
  });

  test("metis-env emits one assignment per line, all namespaced", () => {
    const lines = metisShellEnv("/tmp/repo", metisCfg({ compose_dir: "/a\nb" })).split("\n");
    for (const line of lines) expect(line).toMatch(/^CRUCIBLE_METIS_[A-Z0-9_]+='/);
    expect(lines.filter((l) => l.startsWith("CRUCIBLE_METIS_COMPOSE_DIR=")).length).toBe(1);
  });

  test("metis-env carries env var NAMES, never the values behind them", () => {
    process.env[METIS_KEY_ENV] = SECRET;
    const env = metisShellEnv("/tmp/repo", metisCfg({ llm: { api_key_env: METIS_KEY_ENV } }));
    expect(env).toContain(`CRUCIBLE_METIS_LLM_API_KEY_ENV='${METIS_KEY_ENV}'`);
    expect(env).not.toContain(SECRET);
  });

  test("labels are emitted indexed, so a separator inside a label cannot split it", () => {
    const env = metisShellEnv(
      "/tmp/repo",
      metisCfg({ issue_on_unavailable: { enabled: true, repo: "acme/widgets", labels: ["needs, triage", "infra"] } }),
    );
    expect(env).toContain("CRUCIBLE_METIS_ISSUE_LABEL_COUNT='2'");
    expect(env).toContain("CRUCIBLE_METIS_ISSUE_LABEL_0='needs, triage'");
    expect(env).toContain("CRUCIBLE_METIS_ISSUE_LABEL_1='infra'");
  });
});

describe("pure merge helpers", () => {
  test("mergeRiskTiers unions and dedupes; an absent overlay returns base", () => {
    expect(mergeRiskTiers({ sensitive_paths: ["a"] }, { sensitive_paths: ["a", "b"] })).toEqual({
      sensitive_paths: ["a", "b"],
    });
    expect(mergeRiskTiers({ sensitive_paths: ["a"] }, undefined)).toEqual({ sensitive_paths: ["a"] });
    expect(mergeRiskTiers(undefined, { sensitive_paths: ["x"] })).toEqual({
      sensitive_paths: [...DEFAULT_RISK_TIERS.sensitive_paths, "x"],
    });
  });

  test("mergeLightPath replaces only provided fields", () => {
    expect(mergeLightPath(DEFAULT_LIGHT_PATH, undefined)).toEqual(DEFAULT_LIGHT_PATH);
    expect(mergeLightPath(DEFAULT_LIGHT_PATH, { max_loc: 10 })).toEqual({ ...DEFAULT_LIGHT_PATH, max_loc: 10 });
  });

  test("hardenLightPathForGate can only narrow", () => {
    const widened = hardenLightPathForGate({
      enabled: true,
      allow_extensions: [".md", ".TS", ".mdx"],
      allow_paths: ["anything"],
      max_loc: 999999,
    });
    expect(widened.allow_extensions).toEqual([".md"]);
    expect(widened.allow_paths).toEqual([]);
    expect(widened.max_loc).toBe(GATE_MAX_LOC);
    expect(hardenLightPathForGate({ ...DEFAULT_LIGHT_PATH, max_loc: 10 }).max_loc).toBe(10);
  });

  test("loadLightPathConfig returns the resolved light path", () => {
    expect(loadLightPathConfig(cfgWith({ light_path: { max_loc: 5 } })).max_loc).toBe(5);
  });

  test("severityAtLeast ranks correctly", () => {
    expect(severityAtLeast("CRITICAL", "HIGH")).toBe(true);
    expect(severityAtLeast("MEDIUM", "HIGH")).toBe(false);
    expect(severityAtLeast("HIGH", "HIGH")).toBe(true);
  });
});
