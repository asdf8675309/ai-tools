// FIRST import — the module snapshots its env at init. See coordinator-test-env.ts.
import "./coordinator-test-env.ts";
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseStateComment } from "./parse-state.ts";
import { captureStderr, captureStderrAsync, makeFinding, makeState } from "./test-helpers.ts";

const cc = await import("./call-coordinator.ts");

// Everything in this file exercises the `gh`/`git` shell-out layer. The single
// I/O boundary is execFileSync, so that is the only thing stubbed: no network,
// no real gh, and the arguments the code would have sent are recorded and
// asserted on — the argv IS the contract with GitHub.
//
// process.env.PATH cannot be used to shim a fake binary here: Bun snapshots the
// environment used for executable resolution at startup, so a mutated PATH does
// not reach the child. Verified before writing these tests.

interface ExecCall {
  file: string;
  args: string[];
}

let calls: ExecCall[] = [];
let spy: Mock<typeof childProcess.execFileSync>;

/** Canned stdout per logical `gh`/`git` request, replaced per test. */
interface FakeResponses {
  stateSticky: string;
  judgeSticky: string;
  impostors: string;
  ndjson: string;
  prAuthor: string;
  gitDiff: string;
  /** Commands whose first arg is in this set throw, simulating a failed call. */
  failing: Set<string>;
}

let responses: FakeResponses;

function route(file: string, args: string[]): string {
  const joined = args.join(" ");
  if (responses.failing.has(`${file} ${args[0] ?? ""}`)) {
    throw new Error(`simulated ${file} failure`);
  }
  if (file === "git") {
    if (args[0] === "diff") return responses.gitDiff;
    return "";
  }
  // gh: the upsert calls carry an explicit method; the read calls are
  // distinguished by their URL / jq expression, exactly as the source builds them.
  if (args.includes("-X")) return "";
  if (joined.includes("/pulls/")) return responses.prAuthor;
  if (joined.includes("per_page=100")) return responses.ndjson;
  if (joined.includes("user.login != ")) return responses.impostors;
  if (joined.includes("coordinator-state")) return responses.stateSticky;
  if (joined.includes("coordinator-judge")) return responses.judgeSticky;
  return "";
}

beforeEach(() => {
  calls = [];
  responses = {
    stateSticky: "",
    judgeSticky: "",
    impostors: "[]",
    ndjson: "",
    prAuthor: "pr-author",
    gitDiff: "",
    failing: new Set<string>(),
  };
  spy = spyOn(childProcess, "execFileSync").mockImplementation(((
    file: string,
    args: string[],
  ) => {
    calls.push({ file, args });
    return route(file, args);
  }) as never);
});

afterEach(() => {
  spy.mockRestore();
});

const ghCalls = (): ExecCall[] => calls.filter((c) => c.file === "gh");
const gitCalls = (): ExecCall[] => calls.filter((c) => c.file === "git");

describe("loadPriorContext — seed mode", () => {
  // Seed mode is the default in the shipped workflow. If it ever starts issuing
  // gh/git calls, every run pays for them and gains a new way to fail on a
  // check whose failure is easy to miss.
  test("makes no gh or git call at all", () => {
    const ctx = cc.loadPriorContext("2026-02-01T00:00:00.000Z", "77", false);
    expect(calls).toHaveLength(0);
    expect(ctx.priorState).toBeNull();
  });

  test("supplies inert delta options — nothing carried, nothing dismissed", () => {
    const ctx = cc.loadPriorContext("2026-02-01T00:00:00.000Z", "77", false);
    expect(ctx.opts.forcePushed).toBe(false);
    expect(ctx.opts.dismissalRecords).toEqual([]);
    expect(ctx.opts.renameMap.size).toBe(0);
    expect(ctx.opts.currentRunId).toBe("77");
    expect(ctx.opts.currentTs).toBe("2026-02-01T00:00:00.000Z");
    expect(ctx.opts.currentHeadSha).toBe("c".repeat(40));
    expect(ctx.opts.baseSha).toBe("b".repeat(40));
    expect(ctx.opts.currentRunUrl).toBe("https://ci.example.test/run/4242");
  });
});

describe("loadPriorContext — incremental mode", () => {
  const priorSha = "1".repeat(40);

  /** A state comment produced by the real writer, so the read side is a genuine round-trip. */
  const stickyWith = (body: string): string => JSON.stringify({ id: 55, body });

  test("round-trips the prior state through the real writer and reader", () => {
    const prior = makeState([makeFinding({ id: "SUG-KEEP", status: "open" })], {
      last_head_sha: priorSha,
    });
    responses.stateSticky = stickyWith(cc.buildStateComment(prior));

    const ctx = captureStderrCtx(() => cc.loadPriorContext("2026-02-01T00:00:00.000Z", "77", true));
    expect(ctx.priorState?.last_head_sha).toBe(priorSha);
    expect(ctx.priorState?.findings.map((f) => f.id)).toEqual(["SUG-KEEP"]);
  });

  test("a rename shows up in the delta options, keyed old → new", () => {
    responses.gitDiff = ["R096\tsrc/old name.ts\tsrc/new name.ts", "M\tsrc/other.ts", ""].join("\n");
    const ctx = captureStderrCtx(() => cc.loadPriorContext("2026-02-01T00:00:00.000Z", "77", true));
    expect(ctx.opts.renameMap.get("src/old name.ts")).toBe("src/new name.ts");
    expect(ctx.opts.renameMap.size).toBe(1);
  });

  test("an authorized /dismiss on the PR becomes a dismissal record", () => {
    responses.ndjson = [
      JSON.stringify({
        body: "/dismiss SUG-KEEP known flake",
        user: { login: "reviewer-one" },
        author_association: "MEMBER",
        created_at: "2026-02-02T00:00:00.000Z",
      }),
      JSON.stringify({
        body: "nothing actionable here",
        user: { login: "someone-else" },
        author_association: "NONE",
        created_at: "2026-02-02T01:00:00.000Z",
      }),
    ].join("\n");

    const ctx = captureStderrCtx(() => cc.loadPriorContext("2026-02-01T00:00:00.000Z", "77", true));
    expect(ctx.opts.dismissalRecords).toEqual([
      {
        finding_id: "SUG-KEEP",
        reason: "known flake",
        author: "reviewer-one",
        ts: "2026-02-02T00:00:00.000Z",
      },
    ]);
  });

  test("force-push is reported when the prior head is no longer an ancestor", () => {
    responses.stateSticky = stickyWith(cc.buildStateComment(makeState([], { last_head_sha: priorSha })));
    responses.failing.add("git merge-base");

    const ctx = captureStderrCtx(() => cc.loadPriorContext("2026-02-01T00:00:00.000Z", "77", true));
    expect(ctx.opts.forcePushed).toBe(true);

    // The ancestry probe must carry --end-of-options ahead of the SHAs, or a
    // `-`-prefixed SHA is parsed by git as a flag.
    const probe = gitCalls().find((c) => c.args[0] === "merge-base");
    expect(probe?.args).toEqual([
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      priorSha,
      "c".repeat(40),
    ]);
  });

  test("no force-push when the ancestry probe succeeds", () => {
    responses.stateSticky = stickyWith(cc.buildStateComment(makeState([], { last_head_sha: priorSha })));
    const ctx = captureStderrCtx(() => cc.loadPriorContext("2026-02-01T00:00:00.000Z", "77", true));
    expect(ctx.opts.forcePushed).toBe(false);
  });

  // The degraded path that matters most: this runs BEFORE main()'s try/finally,
  // so an unguarded throw kills the job with no comment posted — and a dead run
  // on a non-required check reads exactly like a clean one.
  test("a gh failure degrades to seed mode, loudly, instead of throwing", () => {
    responses.failing.add("gh api");
    let ctx: ReturnType<typeof cc.loadPriorContext> | undefined;
    const stderr = captureStderr(() => {
      ctx = cc.loadPriorContext("2026-02-01T00:00:00.000Z", "77", true);
    });
    expect(stderr).toContain("falling back to seed mode");
    expect(ctx?.priorState).toBeNull();
    expect(ctx?.opts.forcePushed).toBe(false);
    expect(ctx?.opts.dismissalRecords).toEqual([]);
    expect(ctx?.opts.renameMap.size).toBe(0);
    // Still reports the current run's identity — the delta is seeded, not lost.
    expect(ctx?.opts.currentRunId).toBe("77");
  });

  test("a corrupt prior state comment degrades to a null prior state, not a throw", () => {
    responses.stateSticky = stickyWith("<!-- coordinator-state -->\n\n```json\n{ nope }\n```\n");
    const ctx = captureStderrCtx(() => cc.loadPriorContext("2026-02-01T00:00:00.000Z", "77", true));
    expect(ctx.priorState).toBeNull();
    // Reaching here at all means the corrupt body did not escape as an exception.
    expect(ctx.opts.currentHeadSha).toBe("c".repeat(40));
  });
});

/** loadPriorContext logs on several paths; swallow it and hand back the value. */
function captureStderrCtx(fn: () => ReturnType<typeof cc.loadPriorContext>) {
  let out: ReturnType<typeof cc.loadPriorContext> | undefined;
  captureStderr(() => {
    out = fn();
  });
  if (!out) throw new Error("loadPriorContext did not return");
  return out;
}

describe("fetchExistingStateComment — sticky lookup and impostor scan", () => {
  // The author allowlist is the whole defense against a pre-poisoned state
  // comment: an attacker can post a comment carrying our marker plus
  // schema-valid state before the bot ever runs.
  test("the lookup query restricts the match to the bot's own comments", () => {
    captureStderr(() => cc.fetchExistingStateComment());
    const lookup = ghCalls().find((c) => c.args.join(" ").includes("user.login == "));
    expect(lookup).toBeDefined();
    const jq = lookup?.args.join(" ") ?? "";
    expect(jq).toContain('select(.user.login == "github-actions[bot]")');
    expect(jq).toContain('contains("<!-- coordinator-state -->")');
  });

  test("a non-bot comment carrying the state marker is logged as a security event", () => {
    responses.impostors = '[{"id":9001,"user":"not-the-bot"}]';
    const stderr = captureStderr(() => cc.fetchExistingStateComment());
    expect(stderr).toContain("[coordinator-security]");
    expect(stderr).toContain("possible pre-poisoning");
    expect(stderr).toContain("not-the-bot");
  });

  test("an empty impostor list is not reported as an event", () => {
    responses.impostors = "[]";
    const stderr = captureStderr(() => cc.fetchExistingStateComment());
    expect(stderr).not.toContain("[coordinator-security]");
  });

  test("a failed impostor scan does not stop the state read", () => {
    // Only the scan (the first call) fails; the sticky lookup still answers.
    const body = cc.buildStateComment(makeState([]));
    responses.stateSticky = JSON.stringify({ id: 42, body });
    const seen: Array<{ id: number; body: string } | null> = [];
    const stderr = captureStderr(() => {
      spy.mockImplementationOnce((() => {
        throw new Error("rate limited");
      }) as never);
      seen.push(cc.fetchExistingStateComment());
    });
    expect(stderr).toContain("impostor scan failed");
    expect(seen[0]?.id).toBe(42);
    expect(seen[0]?.body).toBe(body);
  });

  test("no existing sticky → null, which is what makes the next post a fresh comment", () => {
    responses.stateSticky = "";
    const seen: Array<{ id: number; body: string } | null> = [];
    captureStderr(() => {
      seen.push(cc.fetchExistingStateComment());
    });
    expect(seen[0]).toBeNull();
  });
});

describe("fetchIssueCommentsForDismissal", () => {
  test("maps the NDJSON stream onto DismissalComment fields", () => {
    responses.ndjson = [
      JSON.stringify({
        body: "/dismiss WRN-1 wontfix",
        user: { login: "maintainer" },
        author_association: "OWNER",
        created_at: "2026-02-03T00:00:00.000Z",
      }),
    ].join("\n");
    expect(cc.fetchIssueCommentsForDismissal()).toEqual([
      {
        body: "/dismiss WRN-1 wontfix",
        user: { login: "maintainer" },
        author_association: "OWNER",
        created_at: "2026-02-03T00:00:00.000Z",
      },
    ]);
  });

  test("requests every page — a truncated fetch would silently drop dismissals", () => {
    cc.fetchIssueCommentsForDismissal();
    const call = ghCalls()[0];
    expect(call?.args).toContain("--paginate");
    expect(call?.args.some((a) => a.includes("per_page=100"))).toBe(true);
    expect(call?.args).toContain(".[]");
  });

  // Valid JSON of the wrong TYPE is the case a `try { JSON.parse }` guard alone
  // misses: it parses fine, then every field read yields undefined.
  test("a line that is valid JSON but not an object is dropped, not mapped to blanks", () => {
    responses.ndjson = ['"a bare string"', "[1,2,3]", "null", JSON.stringify({ body: "kept" })].join("\n");
    const parsed = cc.fetchIssueCommentsForDismissal();
    expect(parsed).toEqual([
      { body: "kept", user: { login: "" }, author_association: "", created_at: "" },
    ]);
  });
});

describe("readRenameMap", () => {
  test("keeps rename lines and ignores every other status", () => {
    responses.gitDiff = [
      "R100\tsrc/a.ts\tsrc/b.ts",
      "M\tsrc/c.ts",
      "A\tsrc/d.ts",
      "D\tsrc/e.ts",
      "R085\tdocs/old guide.md\tdocs/new guide.md",
      "",
    ].join("\n");
    const map = cc.readRenameMap();
    expect([...map.entries()]).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["docs/old guide.md", "docs/new guide.md"],
    ]);
  });

  test("a diff with no renames yields an empty map rather than a bogus entry", () => {
    responses.gitDiff = "M\tsrc/a.ts\nM\tsrc/b.ts\n";
    expect(cc.readRenameMap().size).toBe(0);
  });

  test("the diff is taken against the base SHA with --end-of-options and rename detection on", () => {
    cc.readRenameMap();
    expect(gitCalls()[0]?.args).toEqual([
      "diff",
      "--find-renames=80%",
      "--name-status",
      "--end-of-options",
      `${"b".repeat(40)}...HEAD`,
    ]);
  });
});

describe("runGit", () => {
  test("a successful command reports ok", () => {
    expect(cc.runGit(["merge-base", "--is-ancestor", "x", "y"])).toEqual({ ok: true });
  });

  test("a failing command reports not-ok instead of throwing", () => {
    responses.failing.add("git merge-base");
    expect(cc.runGit(["merge-base", "--is-ancestor", "x", "y"])).toEqual({ ok: false });
  });
});

describe("postSticky — upsert", () => {
  let dir = "";
  let bodyPath = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "coordinator-sticky-"));
    bodyPath = join(dir, "body.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("PATCHes the existing bot comment rather than posting a second one", async () => {
    responses.judgeSticky = JSON.stringify({ id: 99, body: "<!-- coordinator-judge -->\nold" });
    const { stderr } = await captureStderrAsync(() =>
      cc.postSticky("<!-- coordinator-judge -->", "fresh body", "comment", bodyPath),
    );

    const write = ghCalls().find((c) => c.args.includes("-X"));
    expect(write?.args).toEqual([
      "api",
      "-X",
      "PATCH",
      "repos/example-org/example-repo/issues/comments/99",
      "-F",
      `body=@${bodyPath}`,
    ]);
    expect(readFileSync(bodyPath, "utf8")).toBe("fresh body");
    expect(stderr).toContain("updated existing comment 99");
  });

  test("POSTs a new comment when the bot has not commented yet", async () => {
    responses.judgeSticky = "";
    const { stderr } = await captureStderrAsync(() =>
      cc.postSticky("<!-- coordinator-judge -->", "first body", "comment", bodyPath),
    );

    const write = ghCalls().find((c) => c.args.includes("-X"));
    expect(write?.args).toEqual([
      "api",
      "-X",
      "POST",
      "repos/example-org/example-repo/issues/1/comments",
      "-F",
      `body=@${bodyPath}`,
    ]);
    expect(stderr).toContain("posted new comment on PR #1");
  });

  // Malformed gh output must read as "no sticky yet" — the alternative is a
  // throw on the hot post path, which loses the comment entirely.
  test("malformed lookup output falls back to POST rather than throwing", async () => {
    responses.judgeSticky = '{"id": 5, "body"';
    await captureStderrAsync(() =>
      cc.postSticky("<!-- coordinator-judge -->", "body", "comment", bodyPath),
    );
    expect(ghCalls().find((c) => c.args.includes("-X"))?.args).toContain("POST");
  });

  test("the state comment it writes parses back through the real state reader", async () => {
    const state = makeState([makeFinding({ id: "SUG-RT", status: "open" })]);
    await captureStderrAsync(() =>
      cc.postSticky("<!-- coordinator-state -->", cc.buildStateComment(state), "state comment", bodyPath),
    );
    const written = readFileSync(bodyPath, "utf8");
    const readBack = captureStderr(() => parseStateComment(written));
    expect(readBack).toBe("");
    const parsed = parseStateComment(written);
    expect(parsed?.findings.map((f) => f.id)).toEqual(["SUG-RT"]);
    expect(parsed?.last_head_sha).toBe(state.last_head_sha);
  });
});
