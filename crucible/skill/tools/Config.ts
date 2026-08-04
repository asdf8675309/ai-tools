/**
 * Crucible — typed configuration loader.
 *
 * Resolves the skill's `config.yaml`, deep-merged with an optional per-project
 * `.crucible.yaml` found in the current working directory, and turns a reviewer
 * role into a concrete runtime descriptor.
 *
 * Two-level resolution:
 *   1. `models.<role>` names a provider-key   (reviewer_security -> claude-sonnet)
 *   2. the matching provider map turns that key into a runtime descriptor
 *
 * Every optional integration is off by default. A provider-key whose integration
 * is disabled, unconfigured, or missing its API-key env var is not an error: the
 * role falls back down `reviewer_fallback_chain` and, failing that, to a Claude
 * subagent. A reviewer slot can never resolve to nothing.
 *
 * Secrets are referenced by env-var NAME only. This module never reads a key
 * value and never prints one.
 *
 * Usage (from the skill directory):
 *   bun tools/Config.ts                      # full resolved config
 *   bun tools/Config.ts reviewer_security    # one reviewer's runtime descriptor
 *   bun tools/Config.ts resolve gateway-gpt  # one provider-key
 *   bun tools/Config.ts integrations         # availability of each integration
 *   bun tools/Config.ts integration gateway  # bare true/false, for shell gating
 *   bun tools/Config.ts metis-env [repoRoot] # KEY='value' lines for the scan scripts
 *   bun tools/Config.ts thresholds | flags | light-path | risk-tiers | fallback-chain
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

// Zero runtime dependencies: the installer copies this directory without
// node_modules and never runs an install, so YAML parsing uses Bun's built-in.
const parseYaml = (text: string): unknown => Bun.YAML.parse(text);

const SKILL_CONFIG_PATH = join(import.meta.dir, "..", "config.yaml");
const PROJECT_OVERRIDE_FILENAME = ".crucible.yaml";

// ── Public types ────────────────────────────────────────────────────────────

export type ReviewerRole =
  | "code_quality"
  | "security"
  | "simplify"
  | "typescript"
  | "platform"
  | "test_runner"
  | "clone_detector"
  | "ci_tamper"
  | "history_analyzer"
  | "pr_continuity";

export const REVIEWER_ROLES: readonly ReviewerRole[] = [
  "code_quality",
  "security",
  "simplify",
  "typescript",
  "platform",
  "test_runner",
  "clone_detector",
  "ci_tamper",
  "history_analyzer",
  "pr_continuity",
];

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface LocalModelEntry {
  endpoint: string;
  model: string;
  dim?: number;
}

export interface ExternalCliEntry {
  command: string;
  args?: string[];
  reasoning_effort?: string;
  /** Provider-key tried before the global chain when this CLI is unavailable. */
  fallback?: string;
}

export interface GatewayIntegration {
  enabled: boolean;
  base_url: string;
  /** NAME of the env var holding the key — never the key itself. */
  api_key_env: string;
  timeout_ms: number;
}

export interface ToggleIntegration {
  enabled: boolean;
}

export interface VerdictLogIntegration {
  enabled: boolean;
  path: string;
}

export interface MetisDbConfig {
  user: string;
  password: string;
  name: string;
  host: string;
  port: number;
}

export interface MetisLlmConfig {
  /** NAME of the env var holding the endpoint — never the endpoint itself. */
  base_url_env: string;
  /** NAME of the env var holding the key — never the key itself. */
  api_key_env: string;
  model: string;
  reasoning_effort: string;
  code_embedding_model: string;
  docs_embedding_model: string;
  embed_dim: number;
}

export interface MetisIssueConfig {
  enabled: boolean;
  /** "owner/name". Never inferred from the git remote. */
  repo: string;
  labels: string[];
}

export interface MetisIntegration {
  enabled: boolean;
  compose_dir: string;
  postgres_container: string;
  scan_image: string;
  network: string;
  db: MetisDbConfig;
  schema: string;
  llm: MetisLlmConfig;
  autostart_docker: boolean;
  idle_reap_minutes: number;
  issue_on_unavailable: MetisIssueConfig;
}

export interface Integrations {
  gateway: GatewayIntegration;
  local_models: ToggleIntegration;
  external_cli: ToggleIntegration;
  verdict_log: VerdictLogIntegration;
  metis: MetisIntegration;
}

export type IntegrationName = keyof Integrations;

export interface ModelAssignments {
  reviewer_code_quality: string;
  reviewer_security: string;
  reviewer_simplify: string;
  reviewer_typescript: string;
  reviewer_platform: string;
  reviewer_test_runner: string;
  reviewer_clone_detector: string;
  reviewer_ci_tamper: string;
  reviewer_history_analyzer: string;
  reviewer_pr_continuity: string;
  disprove_primary: string;
  disprove_cross_vendor: string | null;
  embedding_primary: string | null;
}

export interface LightPathConfig {
  enabled: boolean;
  allow_extensions: string[];
  allow_paths: string[];
  max_loc: number;
}

export interface RiskTierConfig {
  sensitive_paths: string[];
}

export interface Thresholds {
  confidence_floor: number;
  per_reviewer_cap: number;
  large_pr_warn_loc: number;
  large_pr_block_loc: number;
  cross_vendor_disprove_min_severity: Severity;
  clone_mrs_threshold: number;
  removal_tracking_max_ratio: number;
}

export interface Flags {
  packet_input: boolean;
  yaml_output_contract: boolean;
  scope_constrain_split_severity: boolean;
  fail_on_revert_gate: boolean;
  auto_route_delta_review: boolean;
  python_tabify: boolean;
  agent_author_profile: boolean;
  cross_vendor_disprove: boolean;
}

export interface CrucibleConfig {
  models: ModelAssignments;
  reviewer_fallback_chain: string[];
  claude_model_map: Record<string, string>;
  gateway_model_map: Record<string, string>;
  local_model_map: Record<string, LocalModelEntry>;
  external_cli_map: Record<string, ExternalCliEntry>;
  integrations: Integrations;
  light_path: LightPathConfig;
  risk_tiers: RiskTierConfig;
  thresholds: Thresholds;
  flags: Flags;
}

// ── Defaults ────────────────────────────────────────────────────────────────
// Structural floor, so a truncated or partial config.yaml degrades instead of
// crashing. Everything integration-shaped is off here by construction.

export const DEFAULT_LIGHT_PATH: LightPathConfig = {
  enabled: true,
  allow_extensions: [".md", ".txt", ".rst"],
  allow_paths: [],
  max_loc: 1000,
};

export const DEFAULT_RISK_TIERS: RiskTierConfig = { sensitive_paths: [] };

export const LAST_RESORT_PROVIDER_KEY = "claude-sonnet";
export const LAST_RESORT_MODEL = "sonnet";

export const DEFAULT_CONFIG: CrucibleConfig = {
  models: {
    reviewer_code_quality: LAST_RESORT_PROVIDER_KEY,
    reviewer_security: LAST_RESORT_PROVIDER_KEY,
    reviewer_simplify: LAST_RESORT_PROVIDER_KEY,
    reviewer_typescript: LAST_RESORT_PROVIDER_KEY,
    reviewer_platform: LAST_RESORT_PROVIDER_KEY,
    reviewer_test_runner: LAST_RESORT_PROVIDER_KEY,
    reviewer_clone_detector: LAST_RESORT_PROVIDER_KEY,
    reviewer_ci_tamper: LAST_RESORT_PROVIDER_KEY,
    reviewer_history_analyzer: LAST_RESORT_PROVIDER_KEY,
    reviewer_pr_continuity: LAST_RESORT_PROVIDER_KEY,
    disprove_primary: LAST_RESORT_PROVIDER_KEY,
    disprove_cross_vendor: null,
    embedding_primary: null,
  },
  reviewer_fallback_chain: [LAST_RESORT_PROVIDER_KEY],
  claude_model_map: { "claude-opus": "opus", "claude-sonnet": "sonnet", "claude-haiku": "haiku" },
  gateway_model_map: {},
  local_model_map: {},
  external_cli_map: {},
  integrations: {
    gateway: { enabled: false, base_url: "", api_key_env: "", timeout_ms: 60000 },
    local_models: { enabled: false },
    external_cli: { enabled: false },
    verdict_log: { enabled: false, path: ".crucible/verdicts.jsonl" },
    metis: {
      enabled: false,
      compose_dir: "",
      postgres_container: "metis_postgres",
      scan_image: "metis",
      network: "metis_default",
      db: { user: "metis_user", password: "metis_password", name: "metis_db", host: "metis_postgres", port: 5432 },
      schema: "",
      llm: {
        base_url_env: "OPENAI_BASE_URL",
        api_key_env: "OPENAI_API_KEY",
        model: "gpt-5.5",
        reasoning_effort: "medium",
        code_embedding_model: "text-embedding-3-large",
        docs_embedding_model: "text-embedding-3-large",
        embed_dim: 3072,
      },
      autostart_docker: true,
      idle_reap_minutes: 10,
      issue_on_unavailable: { enabled: false, repo: "", labels: [] },
    },
  },
  light_path: DEFAULT_LIGHT_PATH,
  risk_tiers: DEFAULT_RISK_TIERS,
  thresholds: {
    confidence_floor: 80,
    per_reviewer_cap: 5,
    large_pr_warn_loc: 400,
    large_pr_block_loc: 1000,
    cross_vendor_disprove_min_severity: "HIGH",
    clone_mrs_threshold: 0.8,
    removal_tracking_max_ratio: 3.0,
  },
  flags: {
    packet_input: true,
    yaml_output_contract: true,
    scope_constrain_split_severity: true,
    fail_on_revert_gate: true,
    auto_route_delta_review: true,
    python_tabify: true,
    agent_author_profile: true,
    cross_vendor_disprove: false,
  },
};

// ── Merging ─────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursive merge for plain objects; arrays and scalars replace wholesale. */
function deepMerge<T>(base: T, overlay: unknown): T {
  if (overlay === undefined) return base;
  if (!isPlainObject(overlay) || !isPlainObject(base)) return overlay as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Union merge: an overlay ADDS sensitive paths, so a project can only escalate. */
export function mergeRiskTiers(
  base: RiskTierConfig = DEFAULT_RISK_TIERS,
  overlay?: Partial<RiskTierConfig>,
): RiskTierConfig {
  const b = base ?? DEFAULT_RISK_TIERS;
  if (!overlay?.sensitive_paths) return b;
  return { sensitive_paths: [...new Set([...(b.sensitive_paths ?? []), ...overlay.sensitive_paths])] };
}

export function mergeConfig(base: CrucibleConfig, overlay: unknown): CrucibleConfig {
  const merged = deepMerge(base, overlay);
  merged.risk_tiers = mergeRiskTiers(base.risk_tiers, (overlay as Partial<CrucibleConfig>)?.risk_tiers);
  return merged;
}

/** Base-preserving light-path merge; a provided array replaces wholesale. Pure. */
export function mergeLightPath(
  base: LightPathConfig = DEFAULT_LIGHT_PATH,
  overlay?: Partial<LightPathConfig>,
): LightPathConfig {
  const b = base ?? DEFAULT_LIGHT_PATH;
  if (!overlay) return b;
  return {
    enabled: overlay.enabled ?? b.enabled,
    allow_extensions: overlay.allow_extensions ?? b.allow_extensions,
    allow_paths: overlay.allow_paths ?? b.allow_paths,
    max_loc: overlay.max_loc ?? b.max_loc,
  };
}

// ── Project-overlay hardening ───────────────────────────────────────────────
// `.crucible.yaml` lives in the working tree of the repository under review, so
// it is the same untrusted input the diff is (references/TrustBoundary.md). The
// light path already refuses to be widened by it (hardenLightPathForGate) and
// risk tiers already union rather than replace; these are the remaining fields
// where an overlay would not tune a review but redirect it — a command to run, an
// endpoint to reach, or the NAME of an env var whose value is then handed over.
//
// Policy: an overlay may narrow, never widen. It may turn an integration off; it
// may not turn one on, and it may not name a target.

/** Dotted paths a project overlay may never set. */
export const OVERLAY_PROTECTED_PATHS: readonly string[] = [
  // A map entry is a command line (`external_cli_map`) or an endpoint
  // (`local_model_map`) that a reviewer role can then be pointed at.
  "external_cli_map",
  "local_model_map",
  "integrations.gateway.base_url",
  "integrations.gateway.api_key_env",
  "integrations.verdict_log.path",
  "integrations.metis.compose_dir",
  "integrations.metis.scan_image",
  "integrations.metis.network",
  "integrations.metis.llm.base_url_env",
  "integrations.metis.llm.api_key_env",
  // `gateway_model_map` doesn't reach a new endpoint (base_url/api_key_env
  // above stay protected) but it does rename which model answers at the
  // already-trusted gateway — an overlay could still point reviewer_security
  // at a weaker model. `models` and `reviewer_fallback_chain` are the same
  // redirection one layer up: which provider-key a role resolves to. All
  // three tune WHICH reviewer looks, not just how loudly — that's a review
  // redirection, not a narrowing.
  "gateway_model_map",
  "models",
  "reviewer_fallback_chain",
];

function deleteAtPath(root: Record<string, unknown>, path: string): boolean {
  const parts = path.split(".");
  const leaf = parts.pop();
  if (!leaf) return false;
  let node: Record<string, unknown> = root;
  for (const part of parts) {
    const next = node[part];
    if (!isPlainObject(next)) return false;
    node = next;
  }
  if (!(leaf in node)) return false;
  delete node[leaf];
  return true;
}

/**
 * Strip the fields a working-tree overlay is not allowed to set, returning the
 * surviving overlay and every dropped path so the caller can say so out loud.
 * Non-object input passes through as an empty overlay — merging it would replace
 * the whole config. Pure apart from cloning its input.
 */
export function hardenProjectOverlay(overlay: unknown): { overlay: unknown; dropped: string[] } {
  if (!isPlainObject(overlay)) return { overlay: {}, dropped: [] };
  const clone = structuredClone(overlay) as Record<string, unknown>;
  const dropped: string[] = [];

  for (const path of OVERLAY_PROTECTED_PATHS) {
    if (deleteAtPath(clone, path)) dropped.push(path);
  }

  // `enabled: false` is a narrowing, so it survives; anything else is an attempt
  // to switch an integration on from inside the reviewed tree.
  const integrations = clone.integrations;
  if (isPlainObject(integrations)) {
    for (const name of INTEGRATION_NAMES) {
      const entry = integrations[name];
      if (!isPlainObject(entry) || !("enabled" in entry)) continue;
      if (entry.enabled === false) continue;
      delete entry.enabled;
      dropped.push(`integrations.${name}.enabled`);
    }
  }

  return { overlay: clone, dropped };
}

// ── Loader (cached per cwd) ─────────────────────────────────────────────────

let cached: CrucibleConfig | null = null;
let cachedCwd: string | null = null;
let resolvedOverlayPath: string | null = null;

export function loadConfig(): CrucibleConfig {
  const cwd = process.cwd();
  if (cached && cachedCwd === cwd) return cached;

  let cfg = DEFAULT_CONFIG;
  try {
    cfg = mergeConfig(DEFAULT_CONFIG, parseYaml(readFileSync(SKILL_CONFIG_PATH, "utf8")));
  } catch (e) {
    console.error(`⚠ Crucible: using built-in defaults, ${SKILL_CONFIG_PATH} unreadable (${(e as Error).message})`);
  }

  // A malformed overlay must not take out models/thresholds/reviewers with it.
  resolvedOverlayPath = null;
  const overlayPath = join(cwd, PROJECT_OVERRIDE_FILENAME);
  if (existsSync(overlayPath)) {
    try {
      const { overlay, dropped } = hardenProjectOverlay(parseYaml(readFileSync(overlayPath, "utf8")));
      if (dropped.length > 0) {
        console.error(
          `⚠ Crucible: ignored ${dropped.length} protected field(s) in ${overlayPath} — ` +
            `a working-tree overlay cannot name an execution target, an endpoint, or a credential ` +
            `env var, nor enable an integration: ${dropped.join(", ")}`,
        );
      }
      cfg = mergeConfig(cfg, overlay);
      resolvedOverlayPath = overlayPath;
    } catch (e) {
      console.error(`⚠ Crucible: ignoring unparseable ${overlayPath} — using skill defaults (${(e as Error).message})`);
    }
  }

  cached = cfg;
  cachedCwd = cwd;
  return cfg;
}

/** Where the last loadConfig() found its overlay — provenance for gate output. */
export function overlaySource(): string {
  return resolvedOverlayPath ? `overlay: ${resolvedOverlayPath}` : `no overlay at ${process.cwd()}`;
}

export function _resetCache(): void {
  cached = null;
  cachedCwd = null;
  resolvedOverlayPath = null;
}

// ── Integration gates ───────────────────────────────────────────────────────

export function integrationEnabled(name: IntegrationName, cfg: CrucibleConfig = loadConfig()): boolean {
  return cfg.integrations?.[name]?.enabled === true;
}

export function gatewayEnabled(cfg: CrucibleConfig = loadConfig()): boolean {
  return integrationEnabled("gateway", cfg);
}
export function localModelsEnabled(cfg: CrucibleConfig = loadConfig()): boolean {
  return integrationEnabled("local_models", cfg);
}
export function externalCliEnabled(cfg: CrucibleConfig = loadConfig()): boolean {
  return integrationEnabled("external_cli", cfg);
}
export function verdictLogEnabled(cfg: CrucibleConfig = loadConfig()): boolean {
  return integrationEnabled("verdict_log", cfg);
}
export function metisEnabled(cfg: CrucibleConfig = loadConfig()): boolean {
  return integrationEnabled("metis", cfg);
}

export interface IntegrationStatus {
  available: boolean;
  reason: string;
}

/** Presence check only — the value is never read into a variable or logged. */
function envIsSet(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name] !== "";
}

/** Enabled AND fully configured. An enabled-but-unconfigured integration is unavailable, not fatal. */
export function integrationAvailable(
  name: IntegrationName,
  cfg: CrucibleConfig = loadConfig(),
): IntegrationStatus {
  if (!integrationEnabled(name, cfg)) return { available: false, reason: `integrations.${name} disabled` };
  if (name === "gateway") {
    const g = cfg.integrations.gateway;
    if (!g.base_url) return { available: false, reason: "integrations.gateway.base_url unset" };
    if (!g.api_key_env) return { available: false, reason: "integrations.gateway.api_key_env unset" };
    if (!envIsSet(g.api_key_env)) return { available: false, reason: `env var ${g.api_key_env} unset` };
  }
  if (name === "metis") {
    const m = cfg.integrations.metis;
    if (!m?.compose_dir) return { available: false, reason: "integrations.metis.compose_dir unset" };
    if (!m.llm?.api_key_env) return { available: false, reason: "integrations.metis.llm.api_key_env unset" };
    if (!envIsSet(m.llm.api_key_env)) return { available: false, reason: `env var ${m.llm.api_key_env} unset` };
  }
  return { available: true, reason: "enabled" };
}

export const INTEGRATION_NAMES: readonly IntegrationName[] = [
  "gateway",
  "local_models",
  "external_cli",
  "verdict_log",
  "metis",
];

export function integrationReport(cfg: CrucibleConfig = loadConfig()): Record<IntegrationName, IntegrationStatus> {
  const out = {} as Record<IntegrationName, IntegrationStatus>;
  for (const n of INTEGRATION_NAMES) out[n] = integrationAvailable(n, cfg);
  return out;
}

// ── Model resolution ────────────────────────────────────────────────────────

export interface FallbackHop {
  /** Provider-key that could not be used. */
  from: string;
  reason: string;
}

/** How the caller must dispatch this reviewer, carrying only that runtime's fields. */
export type ModelRuntime =
  | { kind: "claude"; provider_key: string; model: string }
  | { kind: "gateway"; provider_key: string; model: string; base_url: string; api_key_env: string; timeout_ms: number }
  | { kind: "local"; provider_key: string; endpoint: string; model: string; dim?: number }
  | { kind: "cli"; provider_key: string; command: string; args: string[]; reasoning_effort?: string };

export type ResolvedModel = ModelRuntime & {
  /** Empty when the configured key resolved directly; one entry per hop otherwise. */
  fallbacks: FallbackHop[];
};

type ProbeResult = { ok: true; runtime: ModelRuntime } | { ok: false; reason: string };

function probe(providerKey: string, cfg: CrucibleConfig): ProbeResult {
  if (providerKey.startsWith("claude-")) {
    const model = cfg.claude_model_map?.[providerKey];
    if (!model) return { ok: false, reason: `not in claude_model_map` };
    return { ok: true, runtime: { kind: "claude", provider_key: providerKey, model } };
  }

  if (providerKey.startsWith("gateway-")) {
    const status = integrationAvailable("gateway", cfg);
    if (!status.available) return { ok: false, reason: status.reason };
    const model = cfg.gateway_model_map?.[providerKey];
    if (!model) return { ok: false, reason: `not in gateway_model_map` };
    const g = cfg.integrations.gateway;
    return {
      ok: true,
      runtime: {
        kind: "gateway",
        provider_key: providerKey,
        model,
        base_url: g.base_url,
        api_key_env: g.api_key_env,
        timeout_ms: g.timeout_ms ?? DEFAULT_CONFIG.integrations.gateway.timeout_ms,
      },
    };
  }

  if (providerKey.startsWith("local-")) {
    const status = integrationAvailable("local_models", cfg);
    if (!status.available) return { ok: false, reason: status.reason };
    const entry = cfg.local_model_map?.[providerKey];
    if (!entry) return { ok: false, reason: `not in local_model_map` };
    if (!entry.endpoint || !entry.model) return { ok: false, reason: `local_model_map entry incomplete` };
    return {
      ok: true,
      runtime: { kind: "local", provider_key: providerKey, endpoint: entry.endpoint, model: entry.model, dim: entry.dim },
    };
  }

  if (providerKey.startsWith("cli-")) {
    const status = integrationAvailable("external_cli", cfg);
    if (!status.available) return { ok: false, reason: status.reason };
    const entry = cfg.external_cli_map?.[providerKey];
    if (!entry?.command) return { ok: false, reason: `not in external_cli_map` };
    return {
      ok: true,
      runtime: {
        kind: "cli",
        provider_key: providerKey,
        command: entry.command,
        args: entry.args ?? [],
        reasoning_effort: entry.reasoning_effort,
      },
    };
  }

  return { ok: false, reason: `unrecognized provider-key prefix` };
}

/**
 * The chain actually used. A `claude-*` terminator is appended when config's own
 * chain does not end in one, so the guarantee is structural rather than advisory.
 */
export function fallbackChain(cfg: CrucibleConfig = loadConfig()): string[] {
  const chain = (cfg.reviewer_fallback_chain ?? []).filter((k) => typeof k === "string" && k.length > 0);
  const last = chain[chain.length - 1];
  return last?.startsWith("claude-") ? chain : [...chain, LAST_RESORT_PROVIDER_KEY];
}

/** Resolve a provider-key, walking the fallback chain and recording every hop. Never throws. */
export function resolveProviderKey(
  providerKey: string | null | undefined,
  cfg: CrucibleConfig = loadConfig(),
): ResolvedModel {
  const hops: FallbackHop[] = [];
  const tried = new Set<string>();

  const candidates: string[] = [];
  if (typeof providerKey === "string" && providerKey.length > 0) {
    candidates.push(providerKey);
    const entryFallback = cfg.external_cli_map?.[providerKey]?.fallback;
    if (entryFallback) candidates.push(entryFallback);
  } else {
    hops.push({ from: "(unset)", reason: "no provider-key assigned" });
  }
  candidates.push(...fallbackChain(cfg));

  for (const key of candidates) {
    if (tried.has(key)) continue;
    tried.add(key);
    const result = probe(key, cfg);
    if (result.ok) return { ...result.runtime, fallbacks: hops } as ResolvedModel;
    hops.push({ from: key, reason: result.reason });
  }

  // Nothing in config resolved: a Claude subagent is always dispatchable.
  return { kind: "claude", provider_key: LAST_RESORT_PROVIDER_KEY, model: LAST_RESORT_MODEL, fallbacks: hops };
}

export function resolveAssignment(
  roleKey: keyof ModelAssignments,
  cfg: CrucibleConfig = loadConfig(),
): ResolvedModel {
  return resolveProviderKey(cfg.models?.[roleKey], cfg);
}

export function resolveReviewer(role: ReviewerRole, cfg: CrucibleConfig = loadConfig()): ResolvedModel {
  return resolveAssignment(`reviewer_${role}` as keyof ModelAssignments, cfg);
}

/** Null when the second opinion is off by config — never a silent Claude substitute. */
export function resolveCrossVendorDisprove(cfg: CrucibleConfig = loadConfig()): ResolvedModel | null {
  if (cfg.flags?.cross_vendor_disprove !== true) return null;
  const key = cfg.models?.disprove_cross_vendor;
  if (!key) return null;
  const resolved = resolveProviderKey(key, cfg);
  return resolved.fallbacks.length === 0 ? resolved : null;
}

/** Null when no embedding model is configured or its integration is unavailable. */
export function resolveEmbeddingModel(cfg: CrucibleConfig = loadConfig()): ResolvedModel | null {
  const key = cfg.models?.embedding_primary;
  if (!key) return null;
  const resolved = resolveProviderKey(key, cfg);
  return resolved.fallbacks.length === 0 ? resolved : null;
}

const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export function severityAtLeast(s: Severity, floor: Severity): boolean {
  return (SEVERITY_RANK[s] ?? 0) >= (SEVERITY_RANK[floor] ?? 0);
}

// ── Light path ──────────────────────────────────────────────────────────────

export function loadLightPathConfig(cfg: CrucibleConfig = loadConfig()): LightPathConfig {
  return mergeLightPath(DEFAULT_LIGHT_PATH, cfg.light_path);
}

export function loadRiskTierConfig(cfg: CrucibleConfig = loadConfig()): RiskTierConfig {
  return mergeRiskTiers(DEFAULT_RISK_TIERS, cfg.risk_tiers);
}

/**
 * cwd-independent light-path resolution for a KNOWN repo root — for a hook that
 * must classify a specific repo rather than process.cwd(). Every failure path
 * fails safe to the skill default.
 */
export function loadLightPathConfigForRepo(repoRoot: string): LightPathConfig {
  let base = DEFAULT_LIGHT_PATH;
  try {
    const skillCfg = parseYaml(readFileSync(SKILL_CONFIG_PATH, "utf8")) as Partial<CrucibleConfig>;
    base = mergeLightPath(DEFAULT_LIGHT_PATH, skillCfg?.light_path);
  } catch {
    /* unreadable skill config → hard default */
  }
  const overlayPath = join(repoRoot, PROJECT_OVERRIDE_FILENAME);
  if (!existsSync(overlayPath)) return base;
  try {
    const ov = parseYaml(readFileSync(overlayPath, "utf8")) as Partial<CrucibleConfig>;
    return mergeLightPath(base, ov?.light_path);
  } catch {
    return base;
  }
}

export const GATE_SAFE_EXTENSIONS = [".md", ".txt", ".rst"];
export const GATE_MAX_LOC = 1000;

/**
 * Clamp a light-path config to the hardcoded ceiling, so no config edit — least
 * of all an uncommitted working-tree one — can widen the light path to admit
 * code. Config may disable, drop extensions, or lower max_loc; never widen. Pure.
 */
export function hardenLightPathForGate(cfg: LightPathConfig): LightPathConfig {
  const safe = new Set(GATE_SAFE_EXTENSIONS);
  return {
    enabled: cfg?.enabled === true,
    allow_extensions: (cfg?.allow_extensions ?? []).map((e) => String(e).toLowerCase()).filter((e) => safe.has(e)),
    allow_paths: [],
    max_loc: Math.min(Number(cfg?.max_loc) || 0, GATE_MAX_LOC),
  };
}

// ── Metis ───────────────────────────────────────────────────────────────────
// The scan scripts are bash, so config reaches them as shell-eval-safe
// `KEY='value'` lines rather than JSON. Nothing here ever emits a key or an
// endpoint: `llm.*_env` values are env-var NAMES, and the scripts pass the
// values through to the container by name without ever expanding them.

export function metisConfig(cfg: CrucibleConfig = loadConfig()): MetisIntegration {
  return cfg.integrations?.metis ?? DEFAULT_CONFIG.integrations.metis;
}

const PG_IDENT_MAX = 63;

/**
 * Fold arbitrary text into a safe Postgres identifier. The schema name reaches
 * a `psql` query, and it defaults to a directory name the adopter did not
 * choose with SQL in mind, so restricting the charset here is what stops a
 * repository called `foo'; drop schema bar; --` from becoming an injection. Pure.
 */
export function sanitizePgSchema(raw: string, fallback = "crucible"): string {
  let s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) return fallback;
  if (!/^[a-z_]/.test(s)) s = `p_${s}`;
  return s.slice(0, PG_IDENT_MAX);
}

/** Configured schema, else the repository directory name — always sanitized. */
export function resolveMetisSchema(repoRoot: string, cfg: CrucibleConfig = loadConfig()): string {
  const configured = metisConfig(cfg).schema?.trim();
  if (configured) return sanitizePgSchema(configured);
  const dir = basename(resolve(repoRoot || "."));
  return sanitizePgSchema(dir);
}

export interface MetisIssuePolicy {
  enabled: boolean;
  repo: string;
  labels: string[];
  /** Non-null when the config asked for filing but could not get it. */
  warning: string | null;
}

/**
 * Filing is OFF unless an explicit `owner/name` is configured. A tool that opens
 * issues in a repository nobody named is a bad surprise, so an empty or
 * malformed `repo` resolves to off-with-a-warning rather than to a guess.
 */
export function resolveMetisIssuePolicy(cfg: CrucibleConfig = loadConfig()): MetisIssuePolicy {
  const raw = metisConfig(cfg).issue_on_unavailable ?? DEFAULT_CONFIG.integrations.metis.issue_on_unavailable;
  const repo = String(raw.repo ?? "").trim();
  const labels = (raw.labels ?? []).map((l) => String(l)).filter((l) => l.length > 0);
  if (raw.enabled !== true) return { enabled: false, repo, labels, warning: null };
  if (!repo) {
    return {
      enabled: false,
      repo: "",
      labels,
      warning: "integrations.metis.issue_on_unavailable.enabled is true but repo is empty — filing stays off",
    };
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return {
      enabled: false,
      repo: "",
      labels,
      warning: `integrations.metis.issue_on_unavailable.repo "${repo}" is not owner/name — filing stays off`,
    };
  }
  return { enabled: true, repo, labels, warning: null };
}

/** POSIX single-quoting — the one form in which no character keeps meaning. */
export function shellQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** One key per line, so a value can never smuggle in a second assignment. */
function shellLine(key: string, value: unknown): string {
  return `${key}=${shellQuote(String(value).replace(/[\r\n\t\v\f\0]/g, " "))}`;
}

/**
 * Resolved Metis config as `KEY='value'` lines for `eval` in the scan scripts.
 * `repoRoot` only supplies the schema default; pass null when it is unknown.
 */
export function metisShellEnv(repoRoot: string | null, cfg: CrucibleConfig = loadConfig()): string {
  const m = metisConfig(cfg);
  const status = integrationAvailable("metis", cfg);
  const issue = resolveMetisIssuePolicy(cfg);
  const lines = [
    shellLine("CRUCIBLE_METIS_AVAILABLE", status.available ? "true" : "false"),
    shellLine("CRUCIBLE_METIS_REASON", status.reason),
    shellLine("CRUCIBLE_METIS_ENABLED", m.enabled === true ? "true" : "false"),
    shellLine("CRUCIBLE_METIS_COMPOSE_DIR", m.compose_dir ?? ""),
    shellLine("CRUCIBLE_METIS_POSTGRES_CONTAINER", m.postgres_container ?? ""),
    shellLine("CRUCIBLE_METIS_SCAN_IMAGE", m.scan_image ?? ""),
    shellLine("CRUCIBLE_METIS_NETWORK", m.network ?? ""),
    shellLine("CRUCIBLE_METIS_DB_USER", m.db?.user ?? ""),
    shellLine("CRUCIBLE_METIS_DB_PASSWORD", m.db?.password ?? ""),
    shellLine("CRUCIBLE_METIS_DB_NAME", m.db?.name ?? ""),
    shellLine("CRUCIBLE_METIS_DB_HOST", m.db?.host ?? ""),
    shellLine("CRUCIBLE_METIS_DB_PORT", m.db?.port ?? 5432),
    shellLine("CRUCIBLE_METIS_SCHEMA", repoRoot === null ? sanitizePgSchema(m.schema ?? "") : resolveMetisSchema(repoRoot, cfg)),
    shellLine("CRUCIBLE_METIS_LLM_BASE_URL_ENV", m.llm?.base_url_env ?? ""),
    shellLine("CRUCIBLE_METIS_LLM_API_KEY_ENV", m.llm?.api_key_env ?? ""),
    shellLine("CRUCIBLE_METIS_LLM_MODEL", m.llm?.model ?? ""),
    shellLine("CRUCIBLE_METIS_LLM_REASONING_EFFORT", m.llm?.reasoning_effort ?? ""),
    shellLine("CRUCIBLE_METIS_LLM_CODE_EMBEDDING_MODEL", m.llm?.code_embedding_model ?? ""),
    shellLine("CRUCIBLE_METIS_LLM_DOCS_EMBEDDING_MODEL", m.llm?.docs_embedding_model ?? ""),
    shellLine("CRUCIBLE_METIS_LLM_EMBED_DIM", m.llm?.embed_dim ?? 3072),
    shellLine("CRUCIBLE_METIS_AUTOSTART_DOCKER", m.autostart_docker === true ? "true" : "false"),
    shellLine("CRUCIBLE_METIS_IDLE_REAP_MINUTES", Number(m.idle_reap_minutes) || 0),
    shellLine("CRUCIBLE_METIS_ISSUE_ENABLED", issue.enabled ? "true" : "false"),
    shellLine("CRUCIBLE_METIS_ISSUE_REPO", issue.repo),
    shellLine("CRUCIBLE_METIS_ISSUE_WARNING", issue.warning ?? ""),
    shellLine("CRUCIBLE_METIS_ISSUE_LABEL_COUNT", issue.labels.length),
  ];
  // Indexed rather than delimited: a GitHub label may contain any separator.
  issue.labels.forEach((label, i) => lines.push(shellLine(`CRUCIBLE_METIS_ISSUE_LABEL_${i}`, label)));
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [arg, arg2] = process.argv.slice(2);
  const cfg = loadConfig();
  const emit = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  if (!arg) {
    console.error(`// ${overlaySource()}`);
    emit(cfg);
  } else if (arg.startsWith("reviewer_")) {
    emit(resolveReviewer(arg.replace("reviewer_", "") as ReviewerRole, cfg));
  } else if (arg === "resolve") {
    if (!arg2) {
      console.error("Usage: bun tools/Config.ts resolve <provider-key>");
      process.exit(1);
    }
    emit(resolveProviderKey(arg2, cfg));
  } else if (arg === "integrations") {
    console.error(`// ${overlaySource()}`);
    emit(integrationReport(cfg));
  } else if (arg === "integration") {
    // Bare boolean on stdout for shell gating; provenance on stderr so a silent
    // false (wrong cwd, no overlay, bad YAML) is auditable in the transcript.
    const name = arg2 as IntegrationName;
    if (!name || !(name in cfg.integrations)) {
      console.error(`Usage: bun tools/Config.ts integration <${INTEGRATION_NAMES.join("|")}>`);
      process.exit(1);
    }
    const status = integrationAvailable(name, cfg);
    console.error(`// ${name}=${status.available} (${status.reason}; ${overlaySource()})`);
    console.log(status.available ? "true" : "false");
  } else if (arg === "metis-env") {
    // Consumed by `eval` in tools/metis/*.sh — plain text, not JSON.
    console.log(metisShellEnv(arg2 ?? process.cwd(), cfg));
  } else if (arg === "fallback-chain") {
    emit(fallbackChain(cfg));
  } else if (arg === "thresholds") {
    emit(cfg.thresholds);
  } else if (arg === "flags") {
    emit(cfg.flags);
  } else if (arg === "light-path") {
    emit(loadLightPathConfig(cfg));
  } else if (arg === "risk-tiers") {
    emit(loadRiskTierConfig(cfg));
  } else {
    console.error(`Unknown arg: ${arg}`);
    process.exit(1);
  }
}
