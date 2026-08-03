/**
 * Registry round-trip.
 *
 * Registry.ts is a CLI whose command switch runs at import, so these drive it as
 * a subprocess rather than importing it. Every run gets its own state directory
 * via SPRINT_STATE_DIR — which also proves the env override works, since a leak
 * back to the default would show up as a test seeing another test's sprint.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "Registry.ts");
const temps: string[] = [];

function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sprint-test-"));
  temps.push(d);
  return d;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function run(dir: string, ...args: string[]) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    env: { ...process.env, SPRINT_STATE_DIR: dir },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const today = () => new Date().toISOString().slice(0, 10);

function dispatch(dir: string, issues = "218,306") {
  return run(dir, "dispatch", "--sprint-id", "s1", "--repo", "octocat/example", "--issues", issues);
}

test("importing the module does not execute the CLI", async () => {
  const mod = await import("./Registry.ts");
  expect(mod).toBeDefined();
});

describe("dispatch", () => {
  test("registers each issue and assigns a worktree path", () => {
    const dir = stateDir();
    const r = dispatch(dir);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe("ok");
    expect(out.issues.map((i: { issue_number: number }) => i.issue_number)).toEqual([218, 306]);
    expect(out.issues[0].worktree_path).toBe("../example-sprint-218-issue-218");
  });

  test("slugs come from the title when given — first five words, kebab-cased", () => {
    const dir = stateDir();
    const r = run(dir, "dispatch", "--sprint-id", "s1", "--repo", "o/example",
      "--issues", "7", "--title-slugs", "Fix the login redirect bug now");
    expect(JSON.parse(r.stdout).issues[0].worktree_path).toBe("../example-sprint-7-fix-the-login-redirect-bug");
  });

  test("a long slug is capped at 32 characters", () => {
    const dir = stateDir();
    const r = run(dir, "dispatch", "--sprint-id", "s1", "--repo", "o/example",
      "--issues", "8", "--title-slugs", "Extraordinarily verbose descriptive issue title");
    const slug = JSON.parse(r.stdout).issues[0].worktree_path.replace("../example-sprint-8-", "");
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test("writes state only under SPRINT_STATE_DIR", () => {
    const dir = stateDir();
    dispatch(dir);
    expect(readdirSync(dir)).toEqual([`${today()}.json`]);
  });

  test("a duplicate sprint id is refused", () => {
    const dir = stateDir();
    dispatch(dir);
    const second = dispatch(dir);
    expect(second.code).toBe(1);
    expect(JSON.parse(second.stderr).error).toContain("already exists");
  });

  test("a missing required flag is refused", () => {
    const dir = stateDir();
    const r = run(dir, "dispatch", "--sprint-id", "s1", "--repo", "o/r");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toBe("missing --issues");
  });

  test("a non-numeric issue list is refused rather than stored as NaN", () => {
    const dir = stateDir();
    const r = run(dir, "dispatch", "--sprint-id", "s1", "--repo", "o/r", "--issues", "12,abc");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("integers");
  });
});

describe("get-running — idempotency signal", () => {
  test("a dispatched issue reads as running", () => {
    const dir = stateDir();
    dispatch(dir);
    const out = JSON.parse(run(dir, "get-running", "--issue", "218").stdout);
    expect(out.status).toBe("running");
    expect(out.sprint_id).toBe("s1");
  });

  test("an undispatched issue reads as not-running", () => {
    const dir = stateDir();
    dispatch(dir);
    expect(JSON.parse(run(dir, "get-running", "--issue", "999").stdout).status).toBe("not-running");
  });

  test("a completed issue no longer reads as running", () => {
    const dir = stateDir();
    dispatch(dir);
    run(dir, "update", "--sprint-id", "s1", "--issue", "218", "--status", "pr-opened");
    expect(JSON.parse(run(dir, "get-running", "--issue", "218").stdout).status).toBe("not-running");
  });

  test("an empty registry reads as not-running rather than erroring", () => {
    const dir = stateDir();
    expect(JSON.parse(run(dir, "get-running", "--issue", "1").stdout).status).toBe("not-running");
  });
});

describe("update", () => {
  test("round trip — an update is visible in list", () => {
    const dir = stateDir();
    dispatch(dir);
    const u = run(dir, "update", "--sprint-id", "s1", "--issue", "218",
      "--pr-url", "https://example.invalid/pull/9", "--verdict", "APPROVE",
      "--files-changed", "7", "--duration", "103", "--status", "pr-opened");
    expect(u.code).toBe(0);

    const records = JSON.parse(run(dir, "list", "--output", "json").stdout);
    const issue = records[0].issues.find((i: { issue_number: number }) => i.issue_number === 218);
    expect(issue.pr_url).toBe("https://example.invalid/pull/9");
    expect(issue.review_verdict).toBe("APPROVE");
    expect(issue.files_changed).toBe(7);
    expect(issue.status).toBe("pr-opened");
    expect(issue.completed).toBeString();
  });

  test("a verdict with no proof-of-run marker is recorded as unverified", () => {
    const dir = stateDir();
    dispatch(dir);
    run(dir, "update", "--sprint-id", "s1", "--issue", "218", "--verdict", "APPROVE",
      "--cwd", dir);
    const records = JSON.parse(run(dir, "list", "--output", "json").stdout);
    const issue = records[0].issues.find((i: { issue_number: number }) => i.issue_number === 218);
    expect(issue.review_verified).toBe(false);
  });

  test("an unknown sprint is refused", () => {
    const dir = stateDir();
    dispatch(dir);
    const r = run(dir, "update", "--sprint-id", "nope", "--issue", "218");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("not found");
  });

  test("an issue outside the sprint is refused", () => {
    const dir = stateDir();
    dispatch(dir);
    const r = run(dir, "update", "--sprint-id", "s1", "--issue", "999");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("not in sprint");
  });

  test("a still-running issue gets no completed timestamp", () => {
    const dir = stateDir();
    dispatch(dir);
    run(dir, "update", "--sprint-id", "s1", "--issue", "218", "--files-changed", "2");
    const records = JSON.parse(run(dir, "list", "--output", "json").stdout);
    const issue = records[0].issues.find((i: { issue_number: number }) => i.issue_number === 218);
    expect(issue.completed).toBeUndefined();
  });
});

describe("list", () => {
  test("an empty date says so rather than printing an empty table", () => {
    const dir = stateDir();
    expect(run(dir, "list").stdout).toContain("No sprints registered");
  });

  test("the table marks an unbacked verdict as unverified", () => {
    const dir = stateDir();
    dispatch(dir);
    run(dir, "update", "--sprint-id", "s1", "--issue", "218", "--verdict", "APPROVE", "--cwd", dir);
    expect(run(dir, "list").stdout).toContain("APPROVE (unverified)");
  });

  test("a failure reason reaches the table", () => {
    const dir = stateDir();
    dispatch(dir);
    run(dir, "update", "--sprint-id", "s1", "--issue", "306",
      "--status", "failed", "--reason", "test framework missing");
    expect(run(dir, "list").stdout).toContain("failed: test framework missing");
  });

  test("malformed state names the file instead of throwing an unhandled error", () => {
    const dir = stateDir();
    writeFileSync(join(dir, `${today()}.json`), "{ not json");
    const r = run(dir, "list");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`${today()}.json`);
  });
});

describe("argument validation — regressions found in review", () => {
  test("--date outside YYYY-MM-DD is refused, so it cannot escape the state dir", () => {
    const dir = stateDir();
    const r = run(dir, "list", "--date", "../evil");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("YYYY-MM-DD");
  });

  test("a traversing --date cannot read a file outside the state dir", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "..", "outside.json"), '[{"sprint_id":"LEAKED","started":"","repo":"","parent_session_id":"","issues":[]}]');
    const r = run(dir, "list", "--date", "../outside", "--output", "json");
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("LEAKED");
  });

  test("--key=value carries a value that itself starts with --", () => {
    const dir = stateDir();
    dispatch(dir, "5");
    run(dir, "update", "--sprint-id", "s1", "--issue", "5",
      "--status", "failed", "--reason=--rate-limited by provider");
    const records = JSON.parse(run(dir, "list", "--output", "json").stdout);
    expect(records[0].issues[0].reason).toBe("--rate-limited by provider");
  });

  test("an unknown verdict is refused rather than stored", () => {
    const dir = stateDir();
    dispatch(dir, "5");
    const r = run(dir, "update", "--sprint-id", "s1", "--issue", "5", "--verdict", "GARBAGE");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("must be one of");
  });

  test("an unknown status is refused — it would break the get-running check", () => {
    const dir = stateDir();
    dispatch(dir, "5");
    const r = run(dir, "update", "--sprint-id", "s1", "--issue", "5", "--status", "runing");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("must be one of");
  });

  test("a non-integer --files-changed is refused rather than stored as null", () => {
    const dir = stateDir();
    dispatch(dir, "5");
    const r = run(dir, "update", "--sprint-id", "s1", "--issue", "5", "--files-changed", "abc");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("integer");
  });

  test("duplicate issue numbers are refused — the second record would be unreachable", () => {
    const dir = stateDir();
    const r = run(dir, "dispatch", "--sprint-id", "s1", "--repo", "o/r", "--issues", "7,7");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("duplicates");
  });

  test("state that parses but is not an array is refused", () => {
    const dir = stateDir();
    writeFileSync(join(dir, `${today()}.json`), '{"not":"an array"}');
    const r = run(dir, "list");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("not a sprint array");
  });
});

describe("locking", () => {
  test("concurrent updates all land — none are lost to last-writer-wins", async () => {
    const dir = stateDir();
    run(dir, "dispatch", "--sprint-id", "s1", "--repo", "o/r", "--issues", "1,2,3,4,5");

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        Bun.spawn(["bun", CLI, "update", "--sprint-id", "s1", "--issue", String(n),
          "--status", "pr-opened", "--pr-url", `http://x/${n}`], {
          env: { ...process.env, SPRINT_STATE_DIR: dir },
        }).exited,
      ),
    );

    const records = JSON.parse(run(dir, "list", "--output", "json").stdout);
    const opened = records[0].issues.filter((i: { status: string }) => i.status === "pr-opened");
    expect(opened).toHaveLength(5);
  });

  test("a lock error that is NOT contention says what it was, instead of a stale-lock timeout", () => {
    const dir = stateDir();
    dispatch(dir, "5");
    // EACCES, not EEXIST. Retrying it 100 times cannot help, and the timeout
    // message ("remove it if stale") points at a lock file that does not exist.
    chmodSync(dir, 0o500);
    try {
      const r = run(dir, "update", "--sprint-id", "s1", "--issue", "5", "--status", "pr-opened");
      expect(r.code).toBe(1);
      const { error } = JSON.parse(r.stderr);
      expect(error).toContain("cannot acquire");
      expect(error).not.toContain("timed out");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a rejected argument leaves no stale lock behind", () => {
    const dir = stateDir();
    dispatch(dir, "5");
    expect(run(dir, "update", "--sprint-id", "s1", "--issue", "5", "--verdict", "NOPE").code).toBe(1);
    expect(readdirSync(dir).filter((f) => f.endsWith(".lock"))).toEqual([]);
    // and the next command still works rather than deadlocking
    expect(run(dir, "update", "--sprint-id", "s1", "--issue", "5", "--verdict", "APPROVE").code).toBe(0);
  });
});

describe("cli surface", () => {
  test("no command prints usage", () => {
    expect(run(stateDir()).stdout).toContain("Usage:");
  });

  test("an unknown command is refused", () => {
    const r = run(stateDir(), "frobnicate");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr).error).toContain("unknown command");
  });

  test("a nested state directory is created on demand", () => {
    const base = stateDir();
    const nested = join(base, "a", "b", "c");
    expect(existsSync(nested)).toBe(false);
    const r = run(nested, "dispatch", "--sprint-id", "s1", "--repo", "o/r", "--issues", "1");
    expect(r.code).toBe(0);
    expect(existsSync(join(nested, `${today()}.json`))).toBe(true);
  });
});
