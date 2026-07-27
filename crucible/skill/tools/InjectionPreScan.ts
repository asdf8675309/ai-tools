#!/usr/bin/env bun
/**
 * Crucible — Injection Pre-Scan
 *
 * Deterministically scans PR diff content for prompt-injection signals before
 * Pass 1 reviewers run. This protects the review gate from refusal-bait and
 * reviewer-targeted payloads that try to make an LLM reviewer return "clean"
 * or decline to analyze hostile content.
 *
 * Diff content is untrusted input. A regex pass is not a substitute for
 * treating it as such — it is the deterministic layer that fires before any
 * model reads the diff, so a payload is reported rather than obeyed.
 *
 * Usage:
 *   bun tools/InjectionPreScan.ts --json
 *   git diff origin/main...HEAD | bun tools/InjectionPreScan.ts --json
 *   bun tools/InjectionPreScan.ts --since main
 *
 * Flags:
 *   --since <ref>  Diff base ref; runs `git diff <ref>...HEAD` when stdin is a TTY
 *   --json         Emit { candidates: [...] } JSON for workflow consumption
 *   --help, -h     Print usage
 *
 * Exit codes:
 *   0  scan succeeded, even with zero candidates
 *   1  argument, git, or IO error
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isatty } from "node:tty";

export type PrescanSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface PrescanCandidate {
  id: string;
  severity: PrescanSeverity;
  category: "Prompt Injection in PR Content";
  file: string;
  line: number;
  evidence: string;
  deviation_from: string;
  initial_confidence: number;
  impact: number;
  effort: number;
  recommendation: string;
  subtype: "instruction-injection" | "comment-density" | "content-poisoning" | "identifier-channel";
  reviewer: "injection-prescan";
  expected_fixture?: true;
}

const FIXTURE_PATH = /(^|\/)__fixtures__\/injection-corpus\//;

/**
 * A security-test corpus is payloads by construction. Without this, reviewing a
 * diff that touches one halts on its own test data.
 *
 * Known weakness, stated rather than hidden: a PR can place a payload under a
 * path matching this pattern and get it downgraded. That is why the candidate is
 * downgraded and FLAGGED, never dropped — it still appears in the report, and
 * the reviewer fleet still reads the content under the trust-boundary preamble.
 */
export function isExpectedPayloadPath(file: string): boolean {
  return FIXTURE_PATH.test(file);
}

function applyFixtureDisposition(candidate: PrescanCandidate): PrescanCandidate {
  if (!isExpectedPayloadPath(candidate.file)) return candidate;
  return {
    ...candidate,
    severity: "LOW",
    impact: 1,
    expected_fixture: true,
    recommendation: "Detected inside a declared security-test corpus. Confirm the path is a genuine test fixture, then treat as expected.",
  };
}

interface Args {
  since: string;
  json: boolean;
  help: boolean;
}

interface PatternDef {
  regex: RegExp;
  description: string;
}

interface ScanLine {
  text: string;
  line: number;
}

interface MutableCandidate {
  severity: PrescanSeverity;
  file: string;
  line: number;
  evidence: string;
  subtype: PrescanCandidate["subtype"];
}

const DEFAULT_FILE = "<input>";
const MAX_SCAN_LINES = 20_000;
const MAX_EVIDENCE_CHARS = 300;
const CATEGORY = "Prompt Injection in PR Content";

// Two families: generic instruction-override text, and payloads written to
// target a code reviewer specifically ("do not flag", "respond only with APPROVE").
const INSTRUCTION_PATTERNS: PatternDef[] = [
  { regex: /ignore\s+(all\s+)?previous\s+instructions/i, description: "Ignore previous instructions" },
  { regex: /forget\s+(everything|what|all|your)\s+(you\s+)?(were|know|previous)/i, description: "Forget previous context" },
  { regex: /your\s+new\s+instructions\s+are/i, description: "New instructions directive" },
  { regex: /you\s+are\s+now\s+in\s+\w+\s+mode/i, description: "Mode switch attempt" },
  { regex: /disregard\s+(all\s+)?(prior|previous|above)/i, description: "Disregard prior instructions" },
  { regex: /system\s+override[:\s]/i, description: "System override directive" },
  { regex: /admin\s+command[:\s]/i, description: "Admin command directive" },
  { regex: /\[SYSTEM\]\s*:/i, description: "System message impersonation" },
  { regex: /\[ADMIN\]\s*:/i, description: "Admin message impersonation" },
  { regex: /maintenance\s+mode[:\s]/i, description: "Maintenance mode claim" },
  { regex: /delete\s+all\s+files/i, description: "Delete all files directive" },
  { regex: /rm\s+-rf\s+[~/]/i, description: "Recursive delete command" },
  { regex: /send\s+(your|the|all)\s+(config|configuration|credentials|secrets|keys|tokens)\s+to/i, description: "Credential exfiltration attempt" },
  { regex: /exfiltrate|upload\s+(your|the)\s+(data|config|secrets)/i, description: "Data exfiltration directive" },
  { regex: /disable\s+(all\s+)?(security|logging|monitoring|protection)/i, description: "Security disable directive" },
  { regex: /URGENT\s*(SYSTEM\s+)?MESSAGE\s*:/i, description: "Urgent system message" },
  { regex: /CRITICAL\s+UPDATE\s*:/i, description: "Critical update claim" },
  { regex: /EMERGENCY\s*(OVERRIDE|ACTION|UPDATE)\s*:/i, description: "Emergency override" },
  { regex: /<!--\s*(ignore|forget|system|admin|override|execute|delete|you\s+must|approve|skip)/i, description: "Hidden instruction in HTML comment" },
  { regex: /style\s*=\s*"[^"]*color\s*:\s*white[^"]*font-size\s*:\s*[01]px/i, description: "Invisible text styling" },
  { regex: /style\s*=\s*"[^"]*display\s*:\s*none/i, description: "Hidden display element" },
  { regex: /\breviewer\s*:\s*(approve|skip|ignore|do\s+not\s+flag|do\s+not\s+report)/i, description: "Direct instruction to reviewer" },
  { regex: /\b(code\s+reviewer|security\s+reviewer|ci\s+tamper|test\s+runner|simplify|platform)\b.{0,80}\b(skip|approve|ignore|do\s+not\s+flag|do\s+not\s+report)/i, description: "Reviewer-targeted instruction" },
  { regex: /\byou\s+are\s+now\b.{0,80}\b(unrestricted|developer|maintainer|ci\s+team|admin|approver)\b/i, description: "Role-play prefix" },
  { regex: /\brespond\s+only\s+with\b.{0,80}\b(approve|no\s+findings|clean|pass)\b/i, description: "Output manipulation" },
  { regex: /\b(repeat|print|show|reveal)\s+(your\s+)?(full\s+)?(system\s+)?(instructions|prompt|system\s+prompt)\b/i, description: "System-prompt extraction" },
  { regex: /\bpre-?approved\b.{0,80}\b(skip|merge|approve|review)\b/i, description: "Authority confusion" },
  // DELIBERATELY ABSENT: bare `skip|bypass the (security|ci|test|review)` and a
  // bare `do not flag`. Both were here and both had to go.
  //
  // Measured on this repo's own tree: they produced 42 of ~120 total CRITICAL
  // hits across 135 clean files — including reviewer checklists whose whole job
  // is saying "do not flag these", and `references/DoNotReport.md`, a document
  // that is a list of things not to flag. Every injection candidate is exempt
  // from the disprove pass by design (a deterministic match is not a claim for a
  // model to argue with), so a false positive here reaches the report at
  // CRITICAL, unfilterable, and forces BLOCK. That is the most expensive kind of
  // false positive this system can produce.
  //
  // The deeper reason they cannot be tuned: "do not flag X" is exactly how an
  // author legitimately documents a suppression. No regex separates that from an
  // attacker writing the same words — only the CHANNEL does. So the constrained
  // forms above carry this load instead: addressed to a named reviewer (:131,
  // :132), inside an HTML comment (:128, :140), carrying an authority claim
  // (:136), or wrapped in test framing (:139). All of those survive; the bare
  // prose forms do not, and no corpus fixture depended on them.
  { regex: /\bthis\s+is\s+a\s+test\b.{0,80}\bdo\s+not\s+flag\b/i, description: "Test framing do-not-flag instruction" },
  { regex: /<!--[\s\S]{0,240}\b(approve|skip|ignore|do\s+not\s+flag|no\s+findings)\b[\s\S]{0,240}-->/i, description: "Hidden markdown instruction" },
];

// Refusal bait: a cluster of these in one comment block is an attempt to make
// the reviewer decline to analyze the file, not a real code concern.
const POLICY_KEYWORDS: string[] = [
  "weapon",
  "weapons",
  "explosive",
  "explosives",
  "detonator",
  "bomb",
  "grenade",
  "ied",
  "bioweapon",
  "pathogen",
  "anthrax",
  "ricin",
  "sarin",
  "nerve agent",
  "chemical weapon",
  "cbrn",
  "uranium",
  "plutonium",
  "enrichment",
  "ammunition",
  "methamphetamine",
  "fentanyl synthesis",
  "illicit synthesis",
];

const IDENTIFIER_PATTERNS: PatternDef[] = [
  { regex: /\bignore(All)?PreviousInstructions\b/i, description: "Identifier carries ignore-instructions text" },
  { regex: /\breviewerApproveAndMerge\b/i, description: "Identifier carries reviewer approval instruction" },
  { regex: /\b(skip|disable|bypass)[A-Za-z0-9_]*(Security|Review|Reviewer|Checks|Findings)\b/i, description: "Identifier carries review-bypass instruction" },
  { regex: /\b(doNotFlag|doNotReport|approveAndMerge|skipVulnScan)\b/i, description: "Identifier carries review-control instruction" },
];

const FILENAME_PATTERNS: PatternDef[] = [
  { regex: /;\s*rm\s+-rf/i, description: "Filename contains shell deletion command" },
  { regex: /\s&&\s/, description: "Filename contains shell command chaining" },
  { regex: /(^|\/)\.\.(\/|$)/, description: "Filename contains parent traversal" },
  { regex: /ignore\s+previous/i, description: "Filename contains instruction text" },
];

function parseArgs(argv: string[]): Args {
  const out: Args = { since: "origin/main", json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") {
      const value = argv[++i];
      if (!value) throw new Error("--since requires a ref");
      out.since = value;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log([
    "Usage: bun InjectionPreScan.ts [--since <ref>] [--json]",
    "",
    "Scans stdin when piped; otherwise runs git diff <ref>...HEAD (default origin/main...HEAD).",
    "",
    "Flags:",
    "  --since <ref>  Base ref for git diff when stdin is a TTY",
    "  --json         Emit { candidates: [...] } JSON",
    "  --help, -h     Print this help",
  ].join("\n"));
}

function trimEvidence(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_EVIDENCE_CHARS);
}

function makeCandidate(file: string, hit: MutableCandidate, index: number): PrescanCandidate {
  return {
    id: `injection-prescan-${index}`,
    severity: hit.severity,
    category: CATEGORY,
    file,
    line: hit.line,
    evidence: trimEvidence(hit.evidence),
    deviation_from: "references/TrustBoundary.md",
    initial_confidence: 95,
    impact: hit.severity === "CRITICAL" ? 10 : hit.severity === "HIGH" ? 9 : 6,
    effort: 2,
    recommendation: "Do not merge this PR. Remove the prompt-injection content, investigate provenance, and re-run Crucible.",
    subtype: hit.subtype,
    reviewer: "injection-prescan",
  };
}

function isCommentLine(line: string, inBlockComment: boolean): boolean {
  const s = line.trim();
  return inBlockComment || s.startsWith("//") || s.startsWith("#") || s.startsWith("*") || s.startsWith("/*");
}

function isStringLikeLine(line: string): boolean {
  return /(["'`])[^"'`]{8,}\1/.test(line) || /\b(const|let|var)\s+\w+\s*=\s*(["'`])/.test(line);
}

function keywordRegex(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function distinctPolicyKeywords(text: string): string[] {
  const hits: string[] = [];
  for (const keyword of POLICY_KEYWORDS) {
    if (keywordRegex(keyword).test(text)) hits.push(keyword);
  }
  return hits;
}

function addInstructionHits(lines: ScanLine[], file: string, out: MutableCandidate[]): void {
  for (const line of lines) {
    for (const pattern of INSTRUCTION_PATTERNS) {
      const match = line.text.match(pattern.regex);
      if (!match) continue;
      out.push({
        severity: "CRITICAL",
        file,
        line: line.line,
        evidence: `${pattern.description}: ${match[0]}`,
        subtype: "instruction-injection",
      });
      break;
    }
  }
}

function addIdentifierHits(lines: ScanLine[], file: string, out: MutableCandidate[]): void {
  for (const pattern of FILENAME_PATTERNS) {
    const match = file.match(pattern.regex);
    if (match) {
      out.push({
        severity: "HIGH",
        file,
        line: 1,
        evidence: `${pattern.description}: ${file}`,
        subtype: "identifier-channel",
      });
      break;
    }
  }

  for (const line of lines) {
    for (const pattern of IDENTIFIER_PATTERNS) {
      const match = line.text.match(pattern.regex);
      if (!match) continue;
      out.push({
        severity: "HIGH",
        file,
        line: line.line,
        evidence: `${pattern.description}: ${match[0]}`,
        subtype: "identifier-channel",
      });
      break;
    }
  }
}

function addBlockHits(lines: ScanLine[], file: string, out: MutableCandidate[]): void {
  let contentBlock: ScanLine[] = [];
  let inBlockComment = false;

  // GONE: a comment-run tracker that emitted MEDIUM for any run of >=8 comment
  // lines carrying FEWER than two policy keywords. Read that condition twice —
  // it fired on long comment blocks with nothing suspicious in them, which is
  // the definition of a well-documented file. Measured on this repo: 57 of 135
  // clean files, not one an attack. A file header is not an injection, and
  // length is not evidence.
  //
  // The signal it reached for is already covered, and covered better:
  // INSTRUCTION_PATTERNS matches directives wherever they sit, and
  // flushContentBlock below catches the keyword clustering that refusal-bait
  // actually uses. No corpus fixture was detected by that rule alone.

  const flushContentBlock = (): void => {
    const first = contentBlock[0];
    if (first) {
      const blockText = contentBlock.map((line) => line.text).join("\n");
      const hits = distinctPolicyKeywords(blockText);
      if (hits.length >= 2) {
        out.push({
          severity: "HIGH",
          file,
          line: first.line,
          evidence: `policy-trigger keyword cluster (${hits.slice(0, 4).join(", ")}): ${blockText}`,
          subtype: "content-poisoning",
        });
      }
    }
    contentBlock = [];
  };

  for (const line of lines) {
    const before = inBlockComment;
    const comment = isCommentLine(line.text, before);
    const stringLike = isStringLikeLine(line.text);
    if (line.text.includes("/*")) inBlockComment = true;

    if (comment || stringLike) contentBlock.push(line);
    else flushContentBlock();

    if (line.text.includes("*/")) inBlockComment = false;
  }
  flushContentBlock();
}

function scanLines(lines: ScanLine[], file: string): PrescanCandidate[] {
  const bounded = lines.slice(0, MAX_SCAN_LINES);
  const hits: MutableCandidate[] = [];
  addInstructionHits(bounded, file, hits);
  addIdentifierHits(bounded, file, hits);
  addBlockHits(bounded, file, hits);

  const seen = new Set<string>();
  const out: PrescanCandidate[] = [];
  for (const hit of hits) {
    const key = `${hit.subtype}:${hit.file}:${hit.line}:${trimEvidence(hit.evidence)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(makeCandidate(file, hit, out.length + 1));
  }
  return out;
}

export function scanText(text: string, file = DEFAULT_FILE): PrescanCandidate[] {
  const lines = text.split(/\r?\n/).map((line, index) => ({ text: line, line: index + 1 }));
  return scanLines(lines, file);
}

export function scanDiff(diff: string): PrescanCandidate[] {
  const all: PrescanCandidate[] = [];
  let file = DEFAULT_FILE;
  let newLine = 0;
  let pending: ScanLine[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    const scanned = scanLines(pending, file);
    all.push(
      ...scanned.map((c) =>
        applyFixtureDisposition({ ...c, id: `injection-prescan-${all.length + scanned.indexOf(c) + 1}` }),
      ),
    );
    pending = [];
  };

  for (const raw of diff.split(/\r?\n/).slice(0, MAX_SCAN_LINES * 2)) {
    if (raw.startsWith("+++ ")) {
      flush();
      file = raw.replace(/^\+\+\+\s+b\//, "").replace(/^\+\+\+\s+/, "") || DEFAULT_FILE;
      continue;
    }
    const hunk = raw.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      pending.push({ text: raw.slice(1), line: newLine > 0 ? newLine : pending.length + 1 });
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      continue;
    } else if (newLine > 0) {
      newLine += 1;
    }
  }
  flush();
  return all;
}

function readDiffFromGit(since: string): string {
  const res = spawnSync("git", ["diff", `${since}...HEAD`], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error((res.stderr || `git diff exited ${res.status}`).trim());
  return res.stdout;
}

function renderHuman(candidates: PrescanCandidate[]): string {
  if (candidates.length === 0) return "Injection pre-scan: no candidates found.";
  const lines = [`Injection pre-scan: ${candidates.length} candidate(s) found.`];
  for (const c of candidates) {
    lines.push(`- [${c.severity}] ${c.subtype} ${c.file}:${c.line} — ${c.evidence}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const input = isatty(0) ? readDiffFromGit(parsed.since) : readFileSync(0, "utf8");
  const candidates = scanDiff(input);
  if (parsed.json) console.log(JSON.stringify({ candidates }, null, 2));
  else console.log(renderHuman(candidates));
  process.exit(0);
}

if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
