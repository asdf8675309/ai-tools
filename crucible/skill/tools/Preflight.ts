#!/usr/bin/env bun
/**
 * Crucible — bundled deterministic preflight. Emits ONE object matching
 * PREFLIGHT_SCHEMA in workflows/crucible.workflow.js.
 *
 * Every step fails LOUDLY: a partial object is indistinguishable from a fast success.
 *
 * Usage:
 *   bun tools/Preflight.ts                       # JSON to stdout
 *   bun tools/Preflight.ts --pr 42 --out /tmp/p.json
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  loadConfig,
  loadRiskTierConfig,
  resolveReviewer,
  REVIEWER_ROLES,
  type CrucibleConfig,
  type ResolvedModel,
  type ReviewerRole,
} from "./Config.ts";
import { detectUnits, renderMarkdown, scanUnit, type Unit } from "./CodebasePatternsScanner.ts";
import { changedFiles, numstatTotals, unifiedDiff } from "./GitDiff.ts";
import { chunkDiff, generatePacket } from "./ReviewPacketGenerator.ts";
import { scanDiff } from "./InjectionPreScan.ts";
import { computeRemovalRatio, emitRemovalCandidate } from "./RemovalTrackingGate.ts";
import { classifyRisk } from "./RiskTierClassifier.ts";
import { preprocessPythonForReview, shouldTabify } from "./TabifyPython.ts";
import { classifyFromPR, classifyPRAuthor, type ClassificationResult } from "./PRAuthorClassifier.ts";

const SKILL_ROOT = dirname(import.meta.dir);

/** Resolver vocabulary → schema vocabulary. An unmapped `cli` falls through the
 *  workflow's if-chain to the gateway branch and POSTs to an undefined endpoint. */
export const SCHEMA_KIND = {
  claude: "claude",
  gateway: "gateway",
  local: "local",
  cli: "external_cli",
} as const;

export interface PreflightReviewer {
  role: string;
  kind: (typeof SCHEMA_KIND)[keyof typeof SCHEMA_KIND];
  modelOrSlug: string;
  providerKey: string;
  checklistPath: string;
  /** gateway base_url or local endpoint — absent for claude/external_cli. */
  endpoint?: string;
  /** gateway only. The NAME of the env var holding the key, never its value. */
  apiKeyEnv?: string;
  /** gateway only — resolved per-route, so it must travel with the descriptor. */
  timeoutMs?: number;
  /** gateway only. Below a reviewer-sized ceiling the finding list truncates mid-JSON. */
  maxTokens?: number;
  /** external_cli only. */
  reasoningEffort?: string;
  /** external_cli only — provider-key tried before the global fallback chain. */
  fallback?: string;
}

export interface PreflightResult {
  eligible: boolean;
  stopReason?: string;
  mergeState?: string;
  diffLoc: number;
  affectedApps: string[];
  patternsBlock: string;
  packet: string;
  diffChunks: string;
  injectionCandidates: unknown[];
  removalCandidates: unknown[];
  pythonTabified: number;
  denylist: string;
  positivePrecedents: string;
  riskTier: { tier: "sensitive" | "normal"; reasons: string[] };
  config: {
    thresholds: CrucibleConfig["thresholds"];
    flags: CrucibleConfig["flags"];
    models: CrucibleConfig["models"];
    integrations: CrucibleConfig["integrations"];
  };
  reviewers: PreflightReviewer[];
}

class StepError extends Error {
  constructor(step: string, cause: unknown) {
    super(`preflight step "${step}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function step<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new StepError(name, e);
  }
}

function repoRootOf(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Repo override → shipped checklist → "inline". A missing file degrades the
 *  review, it never stops it. */
export function resolveChecklistPath(repoRoot: string, role: string): string {
  const hyphen = `${role.replace(/_/g, "-")}-reviewer.md`;
  const candidates = [join(repoRoot, ".github", "agents", hyphen), join(SKILL_ROOT, "agents", hyphen)];
  for (const c of candidates) if (existsSync(c)) return c;
  return "inline";
}

export function toReviewer(
  role: ReviewerRole,
  resolved: ResolvedModel,
  cfg: CrucibleConfig,
  repoRoot: string,
): PreflightReviewer {
  const base = {
    role,
    kind: SCHEMA_KIND[resolved.kind],
    providerKey: resolved.provider_key,
    checklistPath: resolveChecklistPath(repoRoot, role),
  };
  switch (resolved.kind) {
    case "gateway":
      return {
        ...base,
        modelOrSlug: resolved.model,
        endpoint: resolved.base_url,
        apiKeyEnv: resolved.api_key_env,
        timeoutMs: resolved.timeout_ms,
        maxTokens: resolved.max_tokens,
      };
    case "local":
      return { ...base, modelOrSlug: resolved.model, endpoint: resolved.endpoint };
    case "cli":
      return {
        ...base,
        // The workflow prints this as the reviewer's model; the command is what
        // actually runs, and it is resolved again from external_cli_map there.
        modelOrSlug: resolved.command,
        reasoningEffort: resolved.reasoning_effort,
        fallback: cfg.external_cli_map?.[resolved.provider_key]?.fallback,
      };
    default:
      return { ...base, modelOrSlug: resolved.model };
  }
}

/** No-PR path: build classifyFromPR's input shape from local git rather than
 *  skipping the gate on a local branch. */
function classifyLocalBranch(cwd: string, sinceRef: string): ClassificationResult {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const branchName = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  // Two-dot: commits on HEAD but not on sinceRef. Three-dot here would be the
  // symmetric difference and would pull in the base branch's own commits.
  const raw = run(["log", "--format=%an%x1f%s%x1f%b%x1e", "--end-of-options", `${sinceRef}..HEAD`]);
  const commits = raw
    .split("\x1e")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [author, message, body] = c.split("\x1f");
      return { author: author ?? "", message: message ?? "", body: body ?? "" };
    });
  return classifyPRAuthor({ branchName, commits });
}

function readReference(name: string): string {
  const p = join(SKILL_ROOT, "references", name);
  // An empty deny-list changes what Crucible reports, so absence must throw.
  if (!existsSync(p)) throw new Error(`missing reference file: ${p}`);
  return readFileSync(p, "utf8");
}

/** Units whose directory contains at least one changed file; all units if none match. */
function affectedUnits(repoRoot: string, files: string[]): Unit[] {
  const units = detectUnits(repoRoot);
  const touched = units.filter((u) => {
    const rel = u.dir === repoRoot ? "" : u.dir.slice(repoRoot.length + 1);
    return rel === "" || files.some((f) => f === rel || f.startsWith(`${rel}/`));
  });
  return touched.length > 0 ? touched : units;
}

/**
 * R10 — counts what tabify would compress; does NOT apply it. All reviewers share
 * one context, so the transform cannot be per-reviewer, and rewriting reviewer
 * input would change what Crucible finds. Gated on every reviewer agreeing: one
 * code-tuned tokenizer makes it net negative.
 */
export function countTabifiable(cwd: string, files: string[], reviewers: PreflightReviewer[]): number {
  const targets = reviewers.map((r) => r.modelOrSlug);
  if (!targets.every((m) => shouldTabify(m))) return 0;
  let applied = 0;
  for (const f of files.filter((p) => p.endsWith(".py"))) {
    let source: string;
    try {
      source = readFileSync(join(cwd, f), "utf8");
    } catch {
      continue; // deleted in this diff — nothing to preprocess
    }
    if (preprocessPythonForReview(source, targets[0]).applied) applied++;
  }
  return applied;
}

export interface PreflightOptions {
  cwd?: string;
  sinceRef?: string;
  pr?: number | null;
  /** Operating band, e.g. "AMBER". Applies degraded_overrides. Absent → no override. */
  band?: string;
}

export async function runPreflight(opts: PreflightOptions = {}): Promise<PreflightResult> {
  const cwd = opts.cwd ?? process.cwd();
  const sinceRef = opts.sinceRef ?? "origin/main";
  const pr = opts.pr ?? null;

  const cfg = step("config", () => loadConfig());
  const { thresholds, flags } = cfg;

  const repoRoot = step("repo-root", () => repoRootOf(cwd));

  const reviewers: PreflightReviewer[] = step("reviewers", () =>
    REVIEWER_ROLES.map((role) => toReviewer(role, resolveReviewer(role, cfg, opts.band), cfg, repoRoot)),
  );

  const { addedLoc, removedLoc } = step("diff-numstat", () => numstatTotals(cwd, sinceRef));
  const diffLoc = addedLoc + removedLoc;
  const files = step("diff-names", () => changedFiles(cwd, sinceRef));

  const units = step("unit-detect", () => affectedUnits(repoRoot, files));
  const affectedApps = units.map((u) => u.name);

  let eligible = true;
  let stopReason: string | undefined;
  let mergeState: string | undefined;

  if (pr !== null) {
    const prState = step("pr-state", () => {
      const raw = execFileSync("gh", ["pr", "view", String(pr), "--json", "mergeStateStatus,statusCheckRollup,mergeable"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return JSON.parse(raw) as {
        mergeStateStatus?: string;
        mergeable?: string;
        statusCheckRollup?: { conclusion?: string; state?: string }[];
      };
    });
    mergeState = prState.mergeStateStatus;
    if (["CONFLICTING", "BLOCKED", "DIRTY"].includes(String(prState.mergeStateStatus))) {
      eligible = false;
      stopReason = `PR #${pr} is ${prState.mergeStateStatus}`;
    }
    if (eligible && (prState.statusCheckRollup ?? []).some((c) => (c.conclusion ?? c.state) === "FAILURE")) {
      eligible = false;
      stopReason = `PR #${pr} has a FAILURE status check`;
    }
  }

  if (eligible && diffLoc > thresholds.large_pr_block_loc) {
    eligible = false;
    stopReason = `diff is ${diffLoc} LOC, over large_pr_block_loc=${thresholds.large_pr_block_loc}`;
  } else if (eligible && diffLoc > thresholds.large_pr_warn_loc) {
    stopReason = `WARNING (non-blocking): diff is ${diffLoc} LOC, over large_pr_warn_loc=${thresholds.large_pr_warn_loc}`;
  }

  const patternsBlock = step("pattern-survey", () =>
    units.map((u) => renderMarkdown(u.name, scanUnit(u).patterns)).join("\n\n"),
  );

  const rawDiff = step("raw-diff", () => unifiedDiff(cwd, sinceRef));
  const diffChunks = chunkDiff(rawDiff).join("\n\n");

  let packet = "";
  if (flags.packet_input) {
    try {
      packet = JSON.stringify(await generatePacket({ sinceRef, cwd }), null, 2);
    } catch (e) {
      // Documented fallback, not a silent one: the caller reads why in stopReason,
      // and diffChunks is already populated, so the review still has its input.
      const note = `packet generation failed (${e instanceof Error ? e.message : String(e)}) — falling back to chunked diff`;
      stopReason = stopReason ? `${stopReason}; ${note}` : `WARNING (non-blocking): ${note}`;
    }
  }

  const pythonTabified = step("python-tabify", () =>
    flags.python_tabify ? countTabifiable(cwd, files, reviewers) : 0,
  );

  const injectionCandidates = step("injection-prescan", () => scanDiff(rawDiff));

  let removalCandidates: unknown[] = [];
  if (flags.agent_author_profile) {
    removalCandidates = step("removal-gate", () => {
      const stats = computeRemovalRatio({ sinceRef, cwd });
      const author = pr !== null ? classifyFromPR(pr, cwd) : classifyLocalBranch(cwd, sinceRef);
      const c = emitRemovalCandidate(stats, { agentAuthor: author.agent, authorConfidence: author.confidence });
      return c ? [c] : [];
    });
  }

  const denylist = step("denylist", () => readReference("DoNotReport.md"));
  const positivePrecedents = step("precedents", () => readReference("PositivePrecedents.md"));

  // classifyRisk catches internally and returns sensitive on fault; a throw here
  // is a bug, never a reason to review a sensitive diff as normal.
  const riskTier = step("risk-tier", () => classifyRisk(files, loadRiskTierConfig(cfg)));

  return {
    eligible,
    ...(stopReason ? { stopReason } : {}),
    ...(mergeState ? { mergeState } : {}),
    diffLoc,
    affectedApps,
    patternsBlock,
    packet,
    diffChunks,
    injectionCandidates,
    removalCandidates,
    pythonTabified,
    denylist,
    positivePrecedents,
    riskTier,
    config: { thresholds, flags, models: cfg.models, integrations: cfg.integrations },
    reviewers,
  };
}

function parseArgs(argv: string[]): PreflightOptions & { out?: string } {
  const out: PreflightOptions & { out?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") out.pr = Number(argv[++i]);
    else if (a === "--since") out.sinceRef = argv[++i];
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--band") out.band = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun tools/Preflight.ts [--pr <n>] [--since <ref>] [--cwd <path>] [--band <b>] [--out <file>]\n" +
          "Default: emits one JSON object matching PREFLIGHT_SCHEMA on stdout.\n" +
          "--out:   writes that JSON to <file> and prints only a one-line summary.",
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown arg: ${a}\n`);
      process.exit(1);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const result = await runPreflight(opts);
  const json = JSON.stringify(result, null, 2);

  // Tens of KB on stdout overflows one tool result; the harness spills it to a file
  // and the agent burns extra calls reading it back. --out keeps stdout to one line.
  if (opts.out) {
    writeFileSync(opts.out, `${json}\n`);
    console.log(
      `preflight OK -> ${opts.out} (${json.length} bytes, ${result.reviewers.length} reviewers, ` +
        `${result.diffLoc} LOC, eligible=${result.eligible}, risk=${result.riskTier.tier})`,
    );
  } else {
    console.log(json);
  }
}

// Guarded: without this, importing anything from this file runs the whole
// preflight with default arguments as a side effect of the import.
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
