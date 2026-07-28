#!/usr/bin/env bun
/**
 * Sprint registry — persistent state for parallel issue-queue orchestration.
 *
 * Storage: $SPRINT_STATE_DIR/<YYYY-MM-DD>.json  (default ~/.sprint/state)
 * Format: JSON array of sprint records, append-only per sprint, per-issue updates.
 *
 *   dispatch     register a new sprint with N issues (status=running)
 *   update       update one issue within a sprint
 *   list         list sprints for a date
 *   get-running  is this issue already running? (idempotency check)
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getMarkerContext, markerPath } from "./MarkerPath.ts";

const STATE_DIR =
  process.env.SPRINT_STATE_DIR ?? join(homedir(), ".sprint", "state");

const ISSUE_STATUSES = ["running", "pr-opened", "failed", "stale"] as const;
type IssueStatus = (typeof ISSUE_STATUSES)[number];

// REVIEW-REQUIRED = the review flagged a sensitive change, so auto-fix and
// auto-approve are off and a human signs off. Blocking for shipping: merge
// only on APPROVE.
const REVIEW_VERDICTS = [
  "APPROVE",
  "WARNING",
  "BLOCK",
  "REVIEW-REQUIRED",
  "FAILED",
] as const;
type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

interface IssueRecord {
  issue_number: number;
  agent_id?: string;
  worktree_path: string;
  status: IssueStatus;
  started: string;
  completed?: string;
  pr_url?: string;
  review_verdict?: ReviewVerdict;
  review_verified?: boolean;
  // Which branch+SHA the proof-of-run marker was found under. Recorded so a
  // verified claim is auditable: two issues reporting the same branch+sha means
  // one of them verified against the other's review.
  review_marker?: { branch: string; sha: string };
  files_changed?: number;
  duration_s?: number;
  reason?: string;
}

interface SprintRecord {
  sprint_id: string;
  started: string;
  repo: string;
  parent_session_id: string;
  issues: IssueRecord[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// `date` becomes a filename, so it is validated before it can contribute path
// segments. Without this, `--date ../foo` escapes STATE_DIR entirely.
function pathForDate(date: string): string {
  if (!DATE_RE.test(date)) fail(`--date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  return join(STATE_DIR, `${date}.json`);
}

function loadDate(date: string): SprintRecord[] {
  const p = pathForDate(date);
  if (!existsSync(p)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    fail(`failed to parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) fail(`${p} is not a sprint array`);
  return parsed as SprintRecord[];
}

// Every command is a read-modify-write against one shared file, and Sprint's
// whole point is N agents finishing at once. Without a lock the last writer
// wins and earlier updates vanish silently. Lock via exclusive create + spin,
// write via temp-and-rename so a reader never sees a half-written file.
const LOCK_RETRIES = 100;
const LOCK_WAIT_MS = 20;

// fail() exits the process, which skips `finally`. Without this the first
// validation error inside a lock strands the lock file and every later command
// deadlocks on it — a worse bug than the race the lock exists to fix.
let heldLock: string | undefined;
process.on("exit", () => {
  if (heldLock) rmSync(heldLock, { force: true });
});

function withLock<T>(date: string, fn: () => T): T {
  const lockPath = `${pathForDate(date)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number | undefined;
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch {
      Bun.sleepSync(LOCK_WAIT_MS);
    }
  }
  if (fd === undefined) fail(`timed out waiting for ${lockPath} — remove it if stale`);
  heldLock = lockPath;
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
    heldLock = undefined;
  }
}

function saveDate(date: string, records: SprintRecord[]): void {
  const p = pathForDate(date);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, p);
}

function slugify(title: string, maxLen = 32): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-")
    .slice(0, maxLen);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

// `--key value` is the common form, but a value that itself starts with `--`
// (a failure reason like "--rate-limited") is indistinguishable from the next
// flag. `--key=value` is the unambiguous form and always wins.
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 2) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? (i++, next) : "true";
  }
  return out;
}

function oneOf<T extends readonly string[]>(
  value: string,
  allowed: T,
  flag: string,
): T[number] {
  if (!allowed.includes(value)) fail(`--${flag} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
  return value as T[number];
}

function intArg(value: string, flag: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) fail(`--${flag} must be an integer, got ${JSON.stringify(value)}`);
  return n;
}

function fail(msg: string): never {
  console.error(JSON.stringify({ status: "error", error: msg }));
  process.exit(1);
}

// -------- dispatch --------------------------------------------------------

function cmdDispatch(args: Record<string, string>): void {
  for (const r of ["sprint-id", "repo", "issues"]) if (!args[r]) fail(`missing --${r}`);

  const sprintId = args["sprint-id"]!;
  const repo = args["repo"]!;
  const parentSession = args["parent-session"] ?? "unknown";
  const issueNumbers = args["issues"]!.split(",").map((s) => parseInt(s.trim(), 10));
  if (issueNumbers.some(Number.isNaN)) fail(`--issues must be comma-separated integers`);
  const dupes = issueNumbers.filter((n, i) => issueNumbers.indexOf(n) !== i);
  if (dupes.length) fail(`--issues contains duplicates: ${[...new Set(dupes)].join(",")}`);
  const titleSlugs = args["title-slugs"]?.split(",") ?? [];

  const repoName = repo.split("/").pop() ?? "repo";
  const date = todayDate();
  const now = nowIso();

  withLock(date, () => {
  const records = loadDate(date);
  if (records.find((r) => r.sprint_id === sprintId)) {
    fail(`sprint_id ${sprintId} already exists for ${date}`);
  }

  const sprint: SprintRecord = {
    sprint_id: sprintId,
    started: now,
    repo,
    parent_session_id: parentSession,
    issues: issueNumbers.map((num, idx) => {
      const raw = titleSlugs[idx];
      const slug = raw ? slugify(raw) : `issue-${num}`;
      return {
        issue_number: num,
        worktree_path: `../${repoName}-sprint-${num}-${slug}`,
        status: "running" as IssueStatus,
        started: now,
      };
    }),
  };

  records.push(sprint);
  saveDate(date, records);

  console.log(
    JSON.stringify(
      {
        status: "ok",
        sprint_id: sprintId,
        date,
        issues: sprint.issues.map((i) => ({
          issue_number: i.issue_number,
          worktree_path: i.worktree_path,
        })),
      },
      null,
      2,
    ),
  );
  });
}

// -------- update ----------------------------------------------------------

// A --verdict string is self-reported: a stalled or skipped review can still
// claim APPROVE. review_verified records whether a proof-of-run marker exists
// for the current branch+SHA. Derivation must match the review tool's exactly
// or this silently always-fails — MarkerPath.test.ts is what holds that.
function reviewMarker(cwd: string): { branch: string; sha: string } | null {
  const ctx = getMarkerContext(cwd);
  if (!ctx) return null;
  if (!existsSync(markerPath(ctx.stateDir, ctx.branch, ctx.sha))) return null;
  return { branch: ctx.branch, sha: ctx.sha };
}

function cmdUpdate(args: Record<string, string>): void {
  for (const r of ["sprint-id", "issue"]) if (!args[r]) fail(`missing --${r}`);

  const sprintId = args["sprint-id"]!;
  const issueNum = parseInt(args["issue"]!, 10);
  const date = args["date"] ?? todayDate();

  // Validate everything BEFORE taking the lock. A fail() inside the critical
  // section exits the process mid-write; keeping validation out here means the
  // locked region only ever does I/O that is expected to succeed.
  const verdict = args["verdict"] ? oneOf(args["verdict"], REVIEW_VERDICTS, "verdict") : undefined;
  const status = args["status"] ? oneOf(args["status"], ISSUE_STATUSES, "status") : undefined;
  const filesChanged = args["files-changed"] ? intArg(args["files-changed"], "files-changed") : undefined;
  const duration = args["duration"] ? intArg(args["duration"], "duration") : undefined;
  const marker = verdict ? reviewMarker(args["cwd"] ?? process.cwd()) : undefined;

  withLock(date, () => {
    const records = loadDate(date);
    const sprint = records.find((r) => r.sprint_id === sprintId);
    if (!sprint) fail(`sprint ${sprintId} not found on ${date}`);

    const issue = sprint.issues.find((i) => i.issue_number === issueNum);
    if (!issue) fail(`issue ${issueNum} not in sprint ${sprintId}`);

    if (args["agent-id"]) issue.agent_id = args["agent-id"];
    if (args["pr-url"]) issue.pr_url = args["pr-url"];
    if (verdict) {
      issue.review_verdict = verdict;
      issue.review_verified = marker != null;
      if (marker) issue.review_marker = marker;
    }
    if (filesChanged !== undefined) issue.files_changed = filesChanged;
    if (duration !== undefined) issue.duration_s = duration;
    if (status) issue.status = status;
    if (args["reason"]) issue.reason = args["reason"];
    if (issue.status !== "running") issue.completed = nowIso();

    saveDate(date, records);
    console.log(JSON.stringify({ status: "ok", sprint_id: sprintId, issue: issueNum }));
  });
}

// -------- list ------------------------------------------------------------

function cmdList(args: Record<string, string>): void {
  const date = args["date"] ?? todayDate();
  const records = loadDate(date);

  if ((args["output"] ?? "table") === "json") {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log(`No sprints registered for ${date}.`);
    return;
  }

  for (const sprint of records) {
    console.log(`\n## Sprint ${sprint.sprint_id} — started ${sprint.started}`);
    console.log(`Repo: ${sprint.repo}  ·  Parent: ${sprint.parent_session_id}\n`);
    console.log("| # | Issue | Status | Worktree | PR | Review | Files | Duration |");
    console.log("|---|-------|--------|----------|----|--------|-------|----------|");
    sprint.issues.forEach((i, idx) => {
      const pr = i.pr_url ?? "—";
      const verdict = i.review_verdict
        ? i.review_verified === false
          ? `${i.review_verdict} (unverified)`
          : i.review_verdict
        : "—";
      const files = i.files_changed ?? "—";
      const dur = i.duration_s
        ? `${Math.floor(i.duration_s / 60)}m ${i.duration_s % 60}s`
        : "—";
      const status =
        i.status === "failed" && i.reason ? `failed: ${i.reason.slice(0, 40)}` : i.status;
      console.log(
        `| ${idx + 1} | #${i.issue_number} | ${status} | ${i.worktree_path} | ${pr} | ${verdict} | ${files} | ${dur} |`,
      );
    });
  }

  const all = records.flatMap((r) => r.issues);
  const count = (s: IssueStatus) => all.filter((i) => i.status === s).length;
  console.log(
    `\nTotal: ${records.length} sprints · ${all.length} issues · ${count("pr-opened")} PRs · ${count("failed")} failures · ${count("running")} still running`,
  );
}

// -------- get-running -----------------------------------------------------

function cmdGetRunning(args: Record<string, string>): void {
  if (!args["issue"]) fail("missing --issue");
  const issueNum = parseInt(args["issue"], 10);
  const date = args["date"] ?? todayDate();

  for (const sprint of loadDate(date)) {
    const found = sprint.issues.find(
      (i) => i.issue_number === issueNum && i.status === "running",
    );
    if (found) {
      console.log(
        JSON.stringify({
          status: "running",
          sprint_id: sprint.sprint_id,
          issue: issueNum,
          worktree_path: found.worktree_path,
          started: found.started,
        }),
      );
      return;
    }
  }
  console.log(JSON.stringify({ status: "not-running", issue: issueNum }));
}

// -------- main ------------------------------------------------------------

if (import.meta.main) main();

function main(): void {
const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);

switch (cmd) {
  case "dispatch":
    cmdDispatch(args);
    break;
  case "update":
    cmdUpdate(args);
    break;
  case "list":
    cmdList(args);
    break;
  case "get-running":
    cmdGetRunning(args);
    break;
  case undefined:
  case "help":
  case "--help":
    console.log(`
Sprint registry — persistent state for parallel issue-queue orchestration.

Usage:
  bun Registry.ts dispatch     --sprint-id <id> --repo <owner/name> --issues <N,N,N> [--parent-session <id>] [--title-slugs <s,s,s>]
  bun Registry.ts update       --sprint-id <id> --issue <N> [--pr-url <url>] [--verdict APPROVE|WARNING|BLOCK|REVIEW-REQUIRED|FAILED] [--files-changed <N>] [--duration <s>] [--status pr-opened|failed|running] [--reason <text>] [--agent-id <id>] [--cwd <path>]
  bun Registry.ts list         [--date YYYY-MM-DD] [--output table|json]
  bun Registry.ts get-running  --issue <N> [--date YYYY-MM-DD]

Storage: \${SPRINT_STATE_DIR:-~/.sprint/state}/<date>.json
`);
    break;
  default:
    fail(`unknown command: ${cmd}`);
}
}
