import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  classifyRisk,
  escalateVerdict,
  effectiveAutopilot,
  isSensitiveTier,
  runClassifyRiskCli,
  HARDCODED_SENSITIVE,
} from "./RiskTierClassifier.ts";
import { DEFAULT_RISK_TIERS, type RiskTierConfig } from "./Config.ts";

const tier = (files: string[], cfg: RiskTierConfig = DEFAULT_RISK_TIERS) => classifyRisk(files, cfg).tier;

describe("classifyRisk — baseline sensitive categories", () => {
  test("auth / secrets / billing / migrations / infra-CI ⇒ sensitive", () => {
    expect(tier(["packages/identity/src/jwt.ts"])).toBe("sensitive");
    expect(tier(["apps/x/src/oauth/callback.ts"])).toBe("sensitive");
    expect(tier(["config/secrets.ts"])).toBe("sensitive");
    expect(tier([".env.production"])).toBe("sensitive");
    expect(tier(["apps/x/wrangler.jsonc"])).toBe("sensitive");
    expect(tier(["apps/store/src/billing/stripe.ts"])).toBe("sensitive");
    expect(tier(["apps/x/migrations/0042_add_users.sql"])).toBe("sensitive");
    expect(tier(["apps/x/drizzle/schema.ts"])).toBe("sensitive");
    expect(tier([".github/workflows/ci.yml"])).toBe("sensitive");
    expect(tier(["Dockerfile"])).toBe("sensitive");
    expect(tier(["infra/terraform/main.tf"])).toBe("sensitive");
    expect(tier(["Jenkinsfile"])).toBe("sensitive");
  });

  test("agent-behaviour-steering files ⇒ sensitive", () => {
    expect(tier(["CLAUDE.md"])).toBe("sensitive");
    expect(tier(["AGENTS.md"])).toBe("sensitive");
    expect(tier([".claude/hooks/pre-commit.ts"])).toBe("sensitive");
    expect(tier([".github/copilot-instructions.md"])).toBe("sensitive");
    expect(tier([".cursorrules"])).toBe("sensitive");
  });

  test("ordinary source / docs ⇒ normal", () => {
    expect(tier(["apps/x/src/util/format.ts"])).toBe("normal");
    expect(tier(["README.md", "apps/x/src/components/Button.tsx"])).toBe("normal");
    expect(tier(["packages/ui/src/theme.ts"])).toBe("normal");
  });

  test("one sensitive file among many normals ⇒ sensitive (deny-toward-escalate)", () => {
    expect(tier(["a.ts", "b.tsx", "packages/identity/auth.ts", "c.md"])).toBe("sensitive");
    expect(classifyRisk(["x.ts", "migrations/1.sql"], DEFAULT_RISK_TIERS).reasons.length).toBeGreaterThan(0);
  });
});

describe("classifyRisk — config extends, never shrinks", () => {
  test("empty config still flags the hardcoded baseline", () => {
    expect(classifyRisk(["src/auth/login.ts"], { sensitive_paths: [] }).tier).toBe("sensitive");
    expect(classifyRisk(["migrations/x.sql"], { sensitive_paths: [] }).tier).toBe("sensitive");
  });

  test("a project pattern ADDS new sensitive paths", () => {
    expect(tier(["internal-tools/payroll.ts"])).toBe("normal"); // not baseline
    expect(tier(["internal-tools/payroll.ts"], { sensitive_paths: ["(^|/)internal-tools/"] })).toBe("sensitive");
  });

  test("HARDCODED_SENSITIVE is non-empty (the floor exists)", () => {
    expect(HARDCODED_SENSITIVE.length).toBeGreaterThan(10);
  });

  test(".crucible.yaml is baseline-sensitive, NOT overlay-dependent", () => {
    // no cfg → only the hardcoded baseline applies; the review config must still flag
    expect(classifyRisk([".crucible.yaml"]).tier).toBe("sensitive");
    expect(classifyRisk(["some/dir/.crucible.yaml"]).tier).toBe("sensitive");
    // even an overlay that omits the pattern cannot un-protect it
    expect(classifyRisk([".crucible.yaml"], { sensitive_paths: [] }).tier).toBe("sensitive");
  });
});

describe("escalateVerdict — sensitive downgrades APPROVE only", () => {
  test("truth table", () => {
    expect(escalateVerdict("APPROVE", true)).toBe("REVIEW-REQUIRED");
    expect(escalateVerdict("APPROVE", false)).toBe("APPROVE"); // normal path identity
    expect(escalateVerdict("BLOCK", true)).toBe("BLOCK");
    expect(escalateVerdict("WARNING", true)).toBe("WARNING");
    expect(escalateVerdict("ERROR", true)).toBe("ERROR");
  });
});

describe("effectiveAutopilot — sensitive disables autopilot", () => {
  test("truth table", () => {
    expect(effectiveAutopilot(true, true)).toBe(false); // sensitive kills autopilot
    expect(effectiveAutopilot(true, false)).toBe(true); // normal path identity
    expect(effectiveAutopilot(false, true)).toBe(false);
    expect(effectiveAutopilot(false, false)).toBe(false);
  });
});

describe("isSensitiveTier — fail-safe consumer", () => {
  test("only explicit 'normal' is not sensitive; missing/malformed → sensitive", () => {
    expect(isSensitiveTier({ tier: "normal" })).toBe(false);
    expect(isSensitiveTier({ tier: "sensitive" })).toBe(true);
    expect(isSensitiveTier(undefined)).toBe(true); // lost classification fails CLOSED
    expect(isSensitiveTier(null)).toBe(true);
    expect(isSensitiveTier({})).toBe(true); // no tier field
    expect(isSensitiveTier({ tier: "garbage" })).toBe(true);
  });
});

describe("baseline breadth — no false-negatives, no over-fire", () => {
  test("ip-allowlist and the review config itself classify sensitive", () => {
    expect(tier(["packages/utils/src/ip-allowlist.ts"])).toBe("sensitive");
    expect(tier([".crucible.yaml"])).toBe("sensitive");
  });

  test("React src/hooks/ is NOT over-escalated (precision check)", () => {
    expect(tier(["apps/x/src/hooks/useDebounce.ts"])).toBe("normal");
    expect(tier(["src/components/Card.tsx"])).toBe("normal");
  });
});

describe("camelCase filenames — must classify sensitive", () => {
  test("distinctive keywords match inside camelCase names, not just path segments", () => {
    for (const p of [
      "apps/storefront/src/lib/stripeWebhook.ts",
      "apps/x/src/authMiddleware.ts",
      "apps/api/src/worker/sessionStore.ts",
      "apps/x/src/checkoutSession.ts",
      "apps/x/src/paymentProcessor.ts",
      "apps/x/src/permissionCheck.ts",
      "apps/x/src/secretManager.ts",
      "apps/x/src/loginHandler.ts",
      "apps/x/src/jwtVerify.ts",
      "apps/x/src/oauthClient.ts",
      "apps/x/src/refundHandler.ts",
      "apps/x/src/subscriptionManager.ts",
    ]) {
      expect(tier([p])).toBe("sensitive");
    }
  });

  test(".dev.vars / pem / key files and TS migrations classify sensitive", () => {
    expect(tier(["apps/api/.dev.vars"])).toBe("sensitive");
    expect(tier(["certs/server.pem"])).toBe("sensitive");
    expect(tier(["apps/api/src/db/0007_add_line_items.ts"])).toBe("sensitive");
    expect(tier(["apps/api/src/db/migration.ts"])).toBe("sensitive");
  });

  // Patterns compile with the "i" flag on purpose — a casing variant must not
  // be a way to slip a sensitive path past the classifier.
  test.each([
    "src/Auth/Login.ts",
    "src/OAuth/callback.ts",
    "config/Secrets.ts",
    "DOCKERFILE",
    "src/Migrations/0001_init.ts",
    "apps/x/Wrangler.jSoNc",
    "claude.md",
  ])("a casing variant (%s) still classifies sensitive", (path) => {
    expect(tier([path])).toBe("sensitive");
  });

  test("precision preserved — ordinary camelCase stays normal", () => {
    expect(tier(["apps/x/src/hooks/useDebounce.ts", "src/format.ts", "components/Card.tsx"])).toBe("normal");
    expect(tier(["packages/ui/src/theme.ts", "src/database.ts"])).toBe("normal");
  });
});

describe("classifyRisk — fails SAFE", () => {
  test("a single bad regex is skipped; the baseline still matches", () => {
    // "(" is an invalid regex source; must not throw, must not drop the baseline
    const r = classifyRisk(["src/auth/x.ts"], { sensitive_paths: ["("] });
    expect(r.tier).toBe("sensitive");
  });

  test("a bad regex does not suppress the OTHER config patterns either", () => {
    const r = classifyRisk(["internal/payroll.ts"], { sensitive_paths: ["(", "payroll"] });
    expect(r.tier).toBe("sensitive");
    expect(r.reasons.join()).toContain("payroll");
  });

  test("a non-array sensitive_paths is ignored, and the baseline still classifies", () => {
    const bad = { sensitive_paths: "oops" } as unknown as RiskTierConfig;
    // Asserting the VERDICT, not merely that it didn't throw: a swallowed fault
    // that returned "normal" would satisfy a no-throw check while disabling the
    // whole gate.
    expect(classifyRisk(["src/auth/login.ts"], bad).tier).toBe("sensitive");
    expect(classifyRisk(["src/util/format.ts"], bad).tier).toBe("normal");
  });

  // The classifier's own catch-all. Under-escalation is the risk it exists to
  // prevent, so a fault must resolve to "sensitive", never to "normal".
  test.each([
    ["a null file list", null],
    ["an undefined file list", undefined],
    ["a non-iterable file list", 42],
  ])("%s resolves to sensitive rather than throwing or under-escalating", (_label, files) => {
    const r = classifyRisk(files as unknown as string[]);
    expect(r.tier).toBe("sensitive");
    expect(r.reasons).toEqual(["classifier fault → fail-safe sensitive"]);
  });
});

// ── CLI: the I/O half, exercised against real throwaway repos ───────────────

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

/** A repo whose `feature` branch changes exactly `paths`, relative to `main`. */
function makeRepo(paths: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "crucible-risktier-"));
  sandboxes.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["checkout", "-q", "-b", "feature"]);
  for (const p of paths) {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "changed\n");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "change"]);
  return dir;
}

const emptyDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "crucible-risktier-nonrepo-"));
  sandboxes.push(dir);
  return dir;
};

describe("runClassifyRiskCli — an unreadable diff escalates, never skips", () => {
  test("a diff touching auth ⇒ sensitive, with the matched reason on stderr", async () => {
    const out = await runClassifyRiskCli(["classify", "--base", "main"], makeRepo(["src/auth/login.ts"]));
    expect(out.stdout).toBe("sensitive");
    expect(out.stderr).toContain("src/auth/login.ts");
    expect(out.exitCode).toBe(0);
  });

  test("a diff touching only ordinary source ⇒ normal, with no reasons", async () => {
    const out = await runClassifyRiskCli(["classify", "--base", "main"], makeRepo(["src/util/format.ts"]));
    expect(out.stdout).toBe("normal");
    expect(out.stderr).toBe("");
  });

  test("one sensitive file among ordinary ones escalates the whole diff", async () => {
    const repo = makeRepo(["src/util/format.ts", "src/components/Card.tsx", "migrations/0001_init.sql"]);
    expect((await runClassifyRiskCli(["classify", "--base", "main"], repo)).stdout).toBe("sensitive");
  });

  test("--json carries the tier, the reasons, and the files it judged", async () => {
    const repo = makeRepo(["src/billing/stripe.ts"]);
    const out = await runClassifyRiskCli(["classify", "--base", "main", "--json"], repo);
    expect(out.stderr).toBe("");
    const parsed = JSON.parse(out.stdout) as { tier: string; reasons: string[]; files: string[] };
    expect(parsed.tier).toBe("sensitive");
    expect(parsed.files).toEqual(["src/billing/stripe.ts"]);
    expect(parsed.reasons[0]).toContain("src/billing/stripe.ts");
  });

  test("not a git repo ⇒ sensitive (escalate, do not skip)", async () => {
    const out = await runClassifyRiskCli(["classify"], emptyDir());
    expect(out.stdout).toBe("sensitive");
    expect(out.stderr).toContain("classifier error");
    expect(out.exitCode).toBe(0);
  });

  test("a missing base ref ⇒ sensitive", async () => {
    const out = await runClassifyRiskCli(["classify", "--base", "origin/nope"], makeRepo(["src/util/a.ts"]));
    expect(out.stdout).toBe("sensitive");
    expect(out.stderr).toContain("classifier error");
  });

  test("the error path in --json mode is also sensitive, with an empty file list", async () => {
    const out = await runClassifyRiskCli(["classify", "--json"], emptyDir());
    const parsed = JSON.parse(out.stdout) as { tier: string; reasons: string[]; files: string[] };
    expect(parsed.tier).toBe("sensitive");
    expect(parsed.files).toEqual([]);
    expect(parsed.reasons[0]).toContain("classifier error");
  });

  test("an unknown subcommand exits 1 and prints NOTHING on stdout", async () => {
    const out = await runClassifyRiskCli(["sensitve"], emptyDir());
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("usage:");
  });

  test("the CLI cannot be talked out of the hardcoded baseline by the repo it scans", async () => {
    // A repo-local overlay is loaded from process.cwd(), not from the scanned
    // tree — but even a permissive overlay only ADDS patterns, so a sensitive
    // path stays sensitive. Asserted here end-to-end through the real loader.
    const repo = makeRepo([".github/workflows/deploy.yml", "src/util/format.ts"]);
    expect((await runClassifyRiskCli(["classify", "--base", "main"], repo)).stdout).toBe("sensitive");
  });
});
