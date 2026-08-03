/**
 * Crucible — Risk-Tier Classifier
 *
 * Deterministic "is this a sensitive change?" classifier. A diff is SENSITIVE
 * when any changed file matches the hardcoded baseline sensitive set (auth /
 * secrets / billing / migrations / infra-CI / agent-behaviour docs) OR a
 * project-added pattern. A sensitive diff makes Crucible force the security
 * reviewer, disable autopilot auto-fix, and downgrade a clean APPROVE to
 * REVIEW-REQUIRED.
 *
 * Security posture:
 *  - FAIL TOWARD SENSITIVE. Under-escalation is the risk; over-escalation only
 *    costs a human ack. A bad regex is skipped; a total fault → `sensitive`.
 *  - CONFIG EXTENDS, NEVER SHRINKS. The baseline is hardcoded; a project's
 *    `.crucible.yaml` can only ADD patterns, so a de-escalating config can never
 *    hide auth/secrets/migrations. There is no `enabled:false` off-switch.
 *
 * classifyRisk / escalateVerdict / effectiveAutopilot are PURE + exported so the
 * whole decision surface is unit-testable without running a full Crucible.
 *
 * CLI:
 *   bun tools/RiskTierClassifier.ts classify [--base <ref>] [--json]
 */

import { execFileSync } from "child_process";
import type { RiskTierConfig } from "./Config.ts";

export type RiskTier = "sensitive" | "normal";
export interface RiskClassification {
  tier: RiskTier;
  reasons: string[];
}

/** Hardcoded baseline — a project config may ADD to this, never remove from it.
 *  DISTINCTIVE keywords match as a case-insensitive SUBSTRING anywhere in the path,
 *  NOT just as a whole path segment — so camelCase filenames (stripeWebhook.ts,
 *  authMiddleware.ts, sessionStore.ts, jwtVerify.ts) are caught, which a
 *  `(^|/)kw([/._-]|$)` segment shape misses. Over-matching (author.ts → sensitive)
 *  is the SAFE direction. Short/ambiguous keywords stay segment-anchored. */
export const HARDCODED_SENSITIVE: string[] = [
  // identity / access — SUBSTRING match (camelCase-safe)
  "auth", "oauth", "oidc", "session", "login", "logout", "jwt", "rbac",
  "permission", "access-control", "accesscontrol",
  // secrets / credentials / keys
  "secret", "credential", "vault", "apikey", "api-key", "privatekey",
  "private-key", "keystore",
  // money
  "billing", "payment", "stripe", "invoice", "charge", "subscription",
  "checkout", "refund", "payout",
  // network policy
  "allowlist", "blocklist", "firewall",
  // schema / data migration
  "migration", "backfill", "drizzle",
  // short / ambiguous keywords — segment-anchored so they don't match prose filenames
  "(^|/)[^/]*\\b(iam|sso|waf|cors|csrf|xss|saml)\\b",
  // secret-bearing files
  "\\.env(\\.|$)", "(^|/)\\.dev\\.vars$", "\\.pem$", "\\.key$", "(^|/)id_rsa",
  // migrations / schema / SQL (incl. numbered TS/JS migration files)
  "(^|/)migrations?([/._-]|$)", "\\.sql$", "(^|/)schema\\.(ts|sql|prisma)$",
  "(^|/)[0-9]{3,}[_-].*\\.(ts|js|sql)$",
  // CI / deploy / infrastructure config
  "(^|/)\\.github/", "(^|/)\\.gitlab-ci\\.ya?ml$", "(^|/)\\.circleci/",
  "(^|/)Jenkinsfile", "(^|/)Dockerfile", "(^|/)docker-compose",
  "(^|/)terraform/", "\\.tf$", "(^|/)k8s/", "(^|/)helm/",
  "(^|/)wrangler\\.(jsonc?|toml)$", "(^|/)serverless\\.ya?ml$",
  // agent-behaviour steering — these files change how an agent (including this
  // reviewer) behaves, which makes them executable in every sense that matters.
  // Scoped so they do not over-fire on a React `src/hooks/` directory.
  "(^|/)\\.claude/", "(^|/)CLAUDE\\.md$", "(^|/)AGENTS\\.md$",
  "(^|/)copilot-instructions\\.md$", "(^|/)\\.cursorrules$",
  // the review-disposition config itself — un-removable baseline, so a repo-root
  // `.crucible.yaml` can't be gutted via a PR judged under its own weakened overlay.
  "(^|/)\\.crucible\\.yaml$",
];

/**
 * Pure classification. Baseline ∪ config patterns; the first matching pattern
 * marks a file sensitive. Fails toward SENSITIVE on any unexpected fault.
 */
export function classifyRisk(files: string[], cfg?: RiskTierConfig): RiskClassification {
  try {
    const extra = Array.isArray(cfg?.sensitive_paths) ? cfg.sensitive_paths : [];
    const sources = [...HARDCODED_SENSITIVE, ...extra];
    const compiled: { re: RegExp; src: string }[] = [];
    for (const src of sources) {
      try {
        compiled.push({ re: new RegExp(src, "i"), src });
      } catch {
        /* skip a bad pattern — never let one typo drop the whole baseline */
      }
    }
    const reasons: string[] = [];
    for (const f of files) {
      for (const { re, src } of compiled) {
        if (re.test(f)) {
          reasons.push(`${f} ~ /${src}/`);
          break;
        }
      }
    }
    return { tier: reasons.length > 0 ? "sensitive" : "normal", reasons };
  } catch {
    return { tier: "sensitive", reasons: ["classifier fault → fail-safe sensitive"] };
  }
}

/** A sensitive diff downgrades a clean APPROVE to REVIEW-REQUIRED; BLOCK/WARNING/
 *  ERROR are untouched, and a non-sensitive diff is the identity. */
export function escalateVerdict(verdict: string, sensitive: boolean): string {
  return sensitive && verdict === "APPROVE" ? "REVIEW-REQUIRED" : verdict;
}

/** A sensitive diff disables autopilot auto-fix (findings surface, human applies). */
export function effectiveAutopilot(autopilot: boolean, sensitive: boolean): boolean {
  return autopilot && !sensitive;
}

/**
 * Fail-safe consumer test: a diff is treated as sensitive UNLESS the classifier
 * explicitly said `normal`. A missing/malformed/absent classification resolves to
 * sensitive — the fail-safe must live at the point of consumption, not only inside
 * the classifier, or a lost result silently fails OPEN.
 */
export function isSensitiveTier(riskTier: { tier?: string } | undefined | null): boolean {
  return riskTier?.tier !== "normal";
}

// ── CLI ──
//   stdout: "sensitive" | "normal"
//   stderr: matched reasons

export interface CliOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * CLI body, returning what it would print rather than printing it. Extracted so
 * the fail-toward-sensitive branch is assertable in-process; the
 * `import.meta.main` block below is then just plumbing. The Config import stays
 * INSIDE the try for the reason the original comment gives.
 */
export async function runClassifyRiskCli(argv: string[], cwd: string): Promise<CliOutcome> {
  if (argv[0] !== "classify") {
    return {
      stdout: "",
      stderr: "usage: bun RiskTierClassifier.ts classify [--base <ref>] [--json]",
      exitCode: 1,
    };
  }
  const baseIdx = argv.indexOf("--base");
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : "origin/main";
  const asJson = argv.includes("--json");
  try {
    // `--end-of-options` so `--base --output=<path>` is a bad revision rather than
    // a git option that writes a file where the caller asked.
    const out = execFileSync("git", ["diff", "--name-only", "--no-renames", "--end-of-options", `${base}...HEAD`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const files = out.split("\n").map((l) => l.trim()).filter(Boolean);
    // Late import so a Config fault fails toward sensitive rather than crashing.
    const { loadRiskTierConfig } = await import("./Config.ts");
    const result = classifyRisk(files, loadRiskTierConfig());
    if (asJson) {
      return { stdout: JSON.stringify({ ...result, files }, null, 2), stderr: "", exitCode: 0 };
    }
    return {
      stdout: result.tier,
      stderr: result.reasons.length ? `// sensitive: ${result.reasons.slice(0, 5).join("; ")}` : "",
      exitCode: 0,
    };
  } catch (e) {
    // Fail toward sensitive: a diff we cannot read is escalated, not skipped.
    const msg = (e as Error).message;
    if (asJson) {
      return {
        stdout: JSON.stringify({ tier: "sensitive", reasons: [`classifier error — ${msg}`], files: [] }, null, 2),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "sensitive", stderr: `// sensitive: classifier error — ${msg}`, exitCode: 0 };
  }
}

if (import.meta.main) {
  const outcome = await runClassifyRiskCli(process.argv.slice(2), process.cwd());
  if (outcome.stderr) console.error(outcome.stderr);
  if (outcome.stdout) console.log(outcome.stdout);
  process.exit(outcome.exitCode);
}
