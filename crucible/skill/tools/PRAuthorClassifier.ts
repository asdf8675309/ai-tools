/**
 * Crucible — PR Author Classifier (R4)
 *
 * Identifies whether a PR was authored end-to-end by a known coding agent or by
 * a human, and returns the agent name for downstream consumers (Pass 1 review
 * emphasis, the R12 removal-tracking gate) so per-author failure patterns can
 * tilt where reviewers look hardest.
 *
 * Detection signals, in order of confidence:
 *
 *   1. `Co-Authored-By: <agent>` footer in the PR commits' bodies. STRONG —
 *      committed metadata, hard to spoof.
 *
 *   2. Branch name prefix: `codex/...`, `cursor/...`, `devin/...`,
 *      `claude/...`. MEDIUM — author convention, easily renamed.
 *
 *   3. GitHub bot author — `...[bot]` logins set by the CI integration. STRONG.
 *
 *   4. PR body footer mentions ("Generated with ...", "via ..."). WEAK —
 *      easily edited.
 *
 * Confidence floors:
 *   - HIGH (signals 1 or 3): return agent, classification confidence 95+
 *   - MEDIUM (signal 2): return agent, classification confidence 70-80
 *   - LOW (signal 4 only): return "unknown", confidence <50 — a false-positive
 *     tilt on a human PR costs more than a missed attribution
 *
 * Usage:
 *   import { classifyPRAuthor } from "./PRAuthorClassifier.ts";
 *   const { agent, confidence, signals } = classifyPRAuthor({
 *     prNumber: 145,
 *     prBody: "...",
 *     branchName: "codex/feat-foo",
 *     commits: [{ author: "...", message: "...", body: "..." }],
 *   });
 *
 * CLI:
 *   bun tools/PRAuthorClassifier.ts --pr 145
 *   echo '{"branchName":"codex/foo"}' | bun tools/PRAuthorClassifier.ts
 */

import { execFileSync } from "child_process";

// ── Types ───────────────────────────────────────────────────────────────────

export type AgentAuthor = "claude" | "codex" | "devin" | "cursor-bg" | "unknown";

export interface ClassificationInput {
  prNumber?: number;
  prBody?: string;
  branchName?: string;
  ghAuthor?: string;
  commits?: Array<{ author?: string; message?: string; body?: string }>;
}

export interface ClassificationResult {
  agent: AgentAuthor;
  confidence: number; // 0-100
  signals: string[]; // human-readable list of what matched
}

// ── Signal detectors ────────────────────────────────────────────────────────

/** Returns an agent based on Co-Authored-By footer matches, or null. */
function detectCoAuthoredBy(commits: ClassificationInput["commits"] | undefined): AgentAuthor | null {
  if (!commits || commits.length === 0) return null;
  for (const c of commits) {
    const text = `${c.message ?? ""}\n${c.body ?? ""}`;
    if (/Co-Authored-By:\s*Claude/i.test(text)) return "claude";
    if (/Co-Authored-By:\s*Devin/i.test(text)) return "devin";
  }
  return null;
}

/** Returns agent from branch-name prefix or null. */
function detectBranchPrefix(branchName: string | undefined): AgentAuthor | null {
  if (!branchName) return null;
  if (/^codex\//i.test(branchName)) return "codex";
  if (/^cursor\//i.test(branchName)) return "cursor-bg";
  if (/^devin\//i.test(branchName)) return "devin";
  if (/^claude\//i.test(branchName)) return "claude";
  return null;
}

/** Returns agent from GitHub bot-author string or null. */
function detectGhBotAuthor(ghAuthor: string | undefined): AgentAuthor | null {
  if (!ghAuthor) return null;
  const a = ghAuthor.toLowerCase();
  if (a.includes("copilot-swe-agent") || a.includes("github-copilot-coding-agent")) return "codex";
  if (a.includes("devin-ai") || a.includes("devin[bot]")) return "devin";
  if (a.includes("cursor-agent") || a.includes("cursor-background-agent")) return "cursor-bg";
  if (a.includes("claude-code[bot]") || a.includes("anthropic-claude")) return "claude";
  return null;
}

/** Weak signal — PR body mentions. Returns agent or null. Don't use alone. */
function detectBodyMention(prBody: string | undefined): AgentAuthor | null {
  if (!prBody) return null;
  if (/generated with\s+devin/i.test(prBody) || /powered by\s+devin/i.test(prBody)) return "devin";
  if (/cursor\s+background\s+agent/i.test(prBody) || /via\s+cursor/i.test(prBody)) return "cursor-bg";
  if (/powered by\s+claude(\s+code)?/i.test(prBody) || /generated with\s+claude/i.test(prBody)) return "claude";
  if (/openai\s+codex/i.test(prBody) || /generated\s+by\s+codex/i.test(prBody)) return "codex";
  return null;
}

// ── Public classifier ──────────────────────────────────────────────────────

export function classifyPRAuthor(input: ClassificationInput): ClassificationResult {
  const signals: string[] = [];
  let agent: AgentAuthor = "unknown";
  let confidence = 0;

  // Signal 1 — Co-Authored-By footer (STRONG)
  const coAuth = detectCoAuthoredBy(input.commits);
  if (coAuth) {
    signals.push(`Co-Authored-By footer = ${coAuth}`);
    agent = coAuth;
    confidence = Math.max(confidence, 95);
  }

  // Signal 3 — GitHub bot author (STRONG)
  const ghBot = detectGhBotAuthor(input.ghAuthor);
  if (ghBot) {
    signals.push(`GitHub bot author = ${ghBot}`);
    if (agent === "unknown" || agent === ghBot) {
      agent = ghBot;
      confidence = Math.max(confidence, 95);
    } else {
      // Conflict between two strong signals — keep the first hit, lower confidence
      signals.push(`CONFLICT: Co-Authored-By said ${agent}, bot author said ${ghBot}; keeping ${agent}`);
      confidence = 70;
    }
  }

  // Signal 2 — Branch prefix (MEDIUM)
  const branch = detectBranchPrefix(input.branchName);
  if (branch) {
    signals.push(`Branch prefix = ${branch}`);
    if (agent === "unknown") {
      agent = branch;
      confidence = Math.max(confidence, 75);
    } else if (agent === branch) {
      confidence = Math.max(confidence, 90);
    } else {
      signals.push(`Branch (${branch}) conflicts with stronger signal (${agent}); keeping ${agent}`);
    }
  }

  // Signal 4 — PR body mention (WEAK)
  const body = detectBodyMention(input.prBody);
  if (body) {
    signals.push(`PR body mention = ${body}`);
    if (agent === "unknown") {
      signals.push("(weak signal only — classified as unknown to avoid false-positive tilt on human PRs)");
      confidence = 30;
    } else if (agent === body) {
      confidence = Math.min(100, confidence + 5);
    }
  }

  return { agent, confidence, signals };
}

// ── gh CLI integration ──────────────────────────────────────────────────────

/**
 * Pull the inputs from `gh pr view` and classify. Requires the `gh` CLI
 * authenticated against the repo.
 */
export function classifyFromPR(prNumber: number, cwd = process.cwd()): ClassificationResult {
  // `gh` has no --end-of-options equivalent, so the argument itself has to be
  // proven safe. The `number` type is compile-time only — a caller reading a PR
  // number from argv or JSON can still hand us `-`-prefixed text at runtime.
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`classifyFromPR: prNumber must be a positive integer, got ${JSON.stringify(prNumber)}`);
  }
  const json = execFileSync(
    "gh",
    ["pr", "view", String(prNumber), "--json", "author,headRefName,body,commits"],
    { cwd, encoding: "utf8" },
  );
  const data = JSON.parse(json) as {
    author: { login: string };
    headRefName: string;
    body: string;
    commits: Array<{ authors: Array<{ login: string; name: string }>; messageHeadline: string; messageBody: string }>;
  };
  const commits = data.commits.map((c) => ({
    author: c.authors.map((a) => a.login).join(","),
    message: c.messageHeadline,
    body: c.messageBody,
  }));
  return classifyPRAuthor({
    prNumber,
    prBody: data.body,
    branchName: data.headRefName,
    ghAuthor: data.author.login,
    commits,
  });
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const prIdx = args.indexOf("--pr");
  const prArg = prIdx >= 0 ? args[prIdx + 1] : undefined;
  if (prArg) {
    console.log(JSON.stringify(classifyFromPR(parseInt(prArg, 10)), null, 2));
  } else if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  bun PRAuthorClassifier.ts --pr <PR#>
  echo '{"branchName":"codex/foo","prBody":"..."}' | bun PRAuthorClassifier.ts`);
  } else {
    // Synthetic mode — read a ClassificationInput as JSON on stdin
    const text = await Bun.stdin.text();
    if (!text.trim()) {
      console.error(`Usage:
  bun PRAuthorClassifier.ts --pr <PR#>
  echo '{"branchName":"codex/foo","prBody":"..."}' | bun PRAuthorClassifier.ts`);
      process.exit(1);
    }
    const input = JSON.parse(text) as ClassificationInput;
    console.log(JSON.stringify(classifyPRAuthor(input), null, 2));
  }
}
