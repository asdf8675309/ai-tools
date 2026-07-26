// FIRST import — the module snapshots its env at init. See coordinator-test-env.ts.
import "./coordinator-test-env.ts";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { parseStateComment } from "./parse-state.ts";
import { captureStderrAsync } from "./test-helpers.ts";

const cc = await import("./call-coordinator.ts");

// End-to-end tests for main(). Only the two real I/O boundaries are stubbed —
// the model endpoint (globalThis.fetch) and the `gh` CLI (execFileSync). The
// filesystem is NOT stubbed: main() hardcodes these /tmp paths, so the tests
// write and read the real files and assert on what the workflow's artifact
// upload would actually contain. Everything is removed again in afterAll.
//
// Almost every case here is a failure path. The coordinator posts one sticky
// comment that is the entire human-visible result of the job; when the model
// call fails, "no comment" and "a clean comment" look identical to a reader, so
// the degraded paths are the ones worth pinning down.

const PROMPT_PATH = "/tmp/coordinator-prompt.md";
const COMMENTS_PATH = "/tmp/comments.json";
const OUT_PATH = "/tmp/coordinator.json";
const META_PATH = "/tmp/coordinator-meta.json";
const RAW_PATH = "/tmp/coordinator-raw.json";
const RAW_ERROR_PATH = "/tmp/coordinator-raw-error.txt";
const COMMENT_BODY_PATH = "/tmp/coordinator-comment-body.md";
const STATE_BODY_PATH = "/tmp/coordinator-state-comment-body.md";
const ALL_PATHS = [
  PROMPT_PATH,
  COMMENTS_PATH,
  OUT_PATH,
  META_PATH,
  RAW_PATH,
  RAW_ERROR_PATH,
  COMMENT_BODY_PATH,
  STATE_BODY_PATH,
];

const TEMPLATE = "Coordinate PR {PR_NUMBER}.\n\n{INJECTED_COMMENTS_JSON}\n";

type Surfaces = Parameters<typeof cc.sourceFindingsFromSurfaces>[0];

const surfacesFixture = (over: Partial<Surfaces> = {}): Surfaces => ({
  pr: 1,
  surface_count: 2,
  finding_count: 2,
  surfaces_present: ["static-analysis", "reviewer"],
  findings: [
    {
      surface: "static-analysis",
      severity_hint: "CRITICAL",
      file: "src/handler.ts",
      line: 42,
      body: "Unvalidated redirect target",
      author: "scanner-bot",
      posted_at: "2026-02-01T00:00:00.000Z",
      comment_url: "https://github.example.test/c/1",
    },
    {
      surface: "reviewer",
      severity_hint: "SUGGESTION",
      file: "src/util.ts",
      line: 7,
      body: "Prefer the shared helper",
      author: "review-bot",
      posted_at: "2026-02-01T00:01:00.000Z",
      comment_url: "https://github.example.test/c/2",
    },
  ],
  ...over,
});

const modelOutput = {
  verdict: "BLOCK",
  summary_line: "One critical finding survived.",
  findings_kept: [
    {
      severity: "CRITICAL",
      file: "src/handler.ts",
      title: "Unvalidated redirect target",
      rationale: "Reachable from user input.",
      source_surface: "static-analysis",
    },
  ],
  findings_dropped: [
    { title: "Prefer the shared helper", source_surface: "reviewer", drop_reason: "style-only" },
  ],
  verification_criteria: ["redirect targets are allowlisted"],
};

// ── stubs ───────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let respond: () => Promise<Response>;
let execCalls: Array<{ file: string; args: string[] }> = [];
let execSpy: Mock<typeof childProcess.execFileSync>;
const originalFetch = globalThis.fetch;

/** stdout for the sticky lookups; "" means "no existing comment" → POST. */
let stickyLookup = "";

beforeEach(() => {
  for (const p of ALL_PATHS) rmSync(p, { force: true });
  writeFileSync(PROMPT_PATH, TEMPLATE);
  writeFileSync(COMMENTS_PATH, JSON.stringify(surfacesFixture()));

  fetchCalls = [];
  respond = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(modelOutput) } }],
        usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 },
        model: "test-model-standard-2026-02",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} });
    return respond();
  }) as typeof fetch;

  execCalls = [];
  stickyLookup = "";
  execSpy = spyOn(childProcess, "execFileSync").mockImplementation(((
    file: string,
    args: string[],
  ) => {
    execCalls.push({ file, args });
    if (args.includes("-X")) return "";
    if (args.join(" ").includes("user.login != ")) return "[]";
    return stickyLookup;
  }) as never);
});

afterEach(() => {
  execSpy.mockRestore();
  globalThis.fetch = originalFetch;
  // Several paths set a failure exit code on the shared process object; clear it
  // so one degraded-path test cannot fail the whole run.
  process.exitCode = 0;
});

afterAll(() => {
  for (const p of ALL_PATHS) rmSync(p, { force: true });
});

const run = () => captureStderrAsync(async () => cc.main({ sleep: async () => {} }));
const postedBody = (): string => readFileSync(COMMENT_BODY_PATH, "utf8");
const requestBody = (): Record<string, unknown> =>
  JSON.parse(String(fetchCalls[0]?.init.body ?? "{}")) as Record<string, unknown>;
const writeComments = (s: Surfaces): void => writeFileSync(COMMENTS_PATH, JSON.stringify(s));

// ── happy path ──────────────────────────────────────────────────────────────

describe("main — successful coordination", () => {
  test("calls the configured endpoint with the substituted prompt and the bearer token", async () => {
    await run();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://models.example.test/v1/chat/completions");

    const headers = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = requestBody();
    expect(body.model).toBe("test-model-standard");
    expect(body.max_tokens).toBe(8192);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("Coordinate PR 1.");
    expect(messages[0]?.content).toContain("Unvalidated redirect target");
  });

  test("posts the rendered verdict, findings and all, as the sticky comment", async () => {
    await run();
    const body = postedBody();
    expect(body).toContain("<!-- coordinator-judge -->");
    expect(body).toContain("verdict: **BLOCK**");
    expect(body).toContain("One critical finding survived.");
    expect(body).toContain("| CRITICAL | `src/handler.ts` | Unvalidated redirect target | static-analysis |");
    expect(body).toContain("`[style-only]` Prefer the shared helper (from `reviewer`)");
    expect(body).toContain("- [ ] redirect targets are allowlisted");
    expect(body).toContain("Reviewed **2** findings across **2** surface(s)");

    const post = execCalls.find((c) => c.args.includes("-X"));
    expect(post?.args).toEqual([
      "api",
      "-X",
      "POST",
      "repos/example-org/example-repo/issues/1/comments",
      "-F",
      `body=@${COMMENT_BODY_PATH}`,
    ]);
    expect(process.exitCode).not.toBe(1);
  });

  test("writes the raw output and a telemetry record the artifact upload can read", async () => {
    await run();
    expect(readFileSync(OUT_PATH, "utf8")).toBe(JSON.stringify(modelOutput));
    expect(JSON.parse(readFileSync(META_PATH, "utf8")) as Record<string, unknown>).toMatchObject({
      pr: 1,
      model_requested: "test-model-standard",
      model_resolved: "test-model-standard-2026-02",
      input_tokens: 1200,
      output_tokens: 340,
      total_tokens: 1540,
      size_tag: "standard",
      surface_count: 2,
    });
  });

  test("the footer reports the model the endpoint actually resolved, not the one requested", async () => {
    await run();
    expect(postedBody()).toContain("`test-model-standard-2026-02`");
    expect(postedBody()).toContain("Tokens: 1200 in / 340 out");
  });

  test("writes a state comment that the next run's reader can parse back", async () => {
    await run();
    const state = parseStateComment(readFileSync(STATE_BODY_PATH, "utf8"));
    expect(state).not.toBeNull();
    expect(state?.last_head_sha).toBe("c".repeat(40));
    expect(state?.last_run_id).toBe("4242");
    // Both source findings are seeded into state, with severity derived from the
    // surface hint.
    expect(state?.findings.map((f) => f.severity).sort()).toEqual(["CRITICAL", "SUGGESTION"]);
    expect(state?.findings.map((f) => f.file).sort()).toEqual(["src/handler.ts", "src/util.ts"]);
  });

  test("tolerates a single ```json fence around the model's JSON", async () => {
    respond = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "```json\n" + JSON.stringify(modelOutput) + "\n```" } }],
          model: "test-model-standard-2026-02",
        }),
        { status: 200 },
      );
    await run();
    expect(postedBody()).toContain("verdict: **BLOCK**");
    expect(postedBody()).not.toContain("PARSE_ERROR");
  });

  test("updates the existing sticky instead of posting a duplicate on a re-run", async () => {
    stickyLookup = JSON.stringify({ id: 314, body: "<!-- coordinator-judge -->\nstale" });
    await run();
    const patches = execCalls.filter((c) => c.args.includes("PATCH"));
    expect(patches).toHaveLength(2); // verdict comment + state comment
    expect(patches[0]?.args).toContain("repos/example-org/example-repo/issues/comments/314");
    expect(execCalls.some((c) => c.args.includes("POST"))).toBe(false);
  });
});

// ── model / size routing ────────────────────────────────────────────────────

describe("main — model size routing", () => {
  const bigSurfaces = (chars: number): Surfaces => {
    const base = surfacesFixture();
    const first = base.findings[0];
    if (!first) throw new Error("fixture has no findings");
    return { ...base, findings: [{ ...first, body: "x".repeat(chars) }] };
  };

  test("a prompt over the large threshold is routed to the large model", async () => {
    writeComments(bigSurfaces(40_000));
    await run();
    expect(requestBody().model).toBe("test-model-large");
    expect((JSON.parse(readFileSync(META_PATH, "utf8")) as { size_tag: string }).size_tag).toBe("large");
  });

  test("a prompt under the threshold stays on the standard model", async () => {
    writeComments(bigSurfaces(1_000));
    await run();
    expect(requestBody().model).toBe("test-model-standard");
    expect((JSON.parse(readFileSync(META_PATH, "utf8")) as { size_tag: string }).size_tag).toBe("standard");
  });

  // The budget guard exists to stop a runaway spend, so "did it skip the call"
  // is the assertion that matters — a TOO_LARGE comment posted after paying for
  // the call would be worse than useless.
  test("a prompt over the token budget posts TOO_LARGE without calling the model", async () => {
    writeComments(bigSurfaces(400_000));
    await run();
    expect(fetchCalls).toHaveLength(0);
    const body = postedBody();
    expect(body).toContain("TOO_LARGE");
    expect(body).toContain("over the coordinator's 80K-token budget");
    expect(body).toContain("Individual source-surface comments above remain authoritative.");
    expect(existsSync(OUT_PATH)).toBe(false);
  });

  test("the budget-blocked path still writes the state comment", async () => {
    writeComments(bigSurfaces(400_000));
    await run();
    expect(parseStateComment(readFileSync(STATE_BODY_PATH, "utf8"))).not.toBeNull();
  });
});

// ── degraded paths ──────────────────────────────────────────────────────────

describe("main — model call failures", () => {
  test("an HTTP error posts DEGRADED with the status and marks the run failed", async () => {
    respond = async () => new Response("upstream capacity exceeded", { status: 503 });
    const { stderr } = await run();
    const body = postedBody();
    expect(body).toContain("Coordinator Judge — DEGRADED");
    expect(body).toContain("HTTP 503");
    expect(body).toContain("upstream capacity exceeded");
    expect(stderr).toContain("[coordinator] model error 503");
    expect(process.exitCode).toBe(1);
  });

  // The error body goes into a PUBLIC PR comment verbatim apart from this
  // scrub, and upstreams do echo request headers back in error payloads.
  test("a token echoed in the error body never reaches the public comment", async () => {
    respond = async () =>
      new Response('{"error":"bad key","request":{"authorization":"Bearer sk-ant-abcdef0123456789"}}', {
        status: 401,
      });
    const { stderr } = await run();
    const body = postedBody();
    expect(body).toContain("HTTP 401");
    expect(body).toContain("Bearer [REDACTED]");
    expect(body).not.toContain("sk-ant-abcdef0123456789");
    expect(stderr).not.toContain("sk-ant-abcdef0123456789");
  });

  test("a transport failure posts DEGRADED rather than crashing the job", async () => {
    respond = async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED");
    };
    const { stderr } = await run();
    expect(postedBody()).toContain("Coordinator Judge — DEGRADED");
    expect(postedBody()).toContain("connect ECONNREFUSED");
    expect(stderr).toContain("[coordinator] fetch failed");
    expect(process.exitCode).toBe(1);
    // The finally block still runs on this path.
    expect(parseStateComment(readFileSync(STATE_BODY_PATH, "utf8"))).not.toBeNull();
  });

  test("a secret in a transport error message is scrubbed before posting", async () => {
    respond = async () => {
      throw new Error("proxy rejected Authorization: Bearer ghp_EXAMPLENOTREALtoken123456");
    };
    await run();
    expect(postedBody()).not.toContain("ghp_EXAMPLENOTREALtoken123456");
    expect(postedBody()).toContain("[REDACTED]");
  });

  test("an empty completion posts DEGRADED and still preserves the raw response", async () => {
    respond = async () =>
      new Response(JSON.stringify({ choices: [{ message: {} }], model: "test-model-standard" }), {
        status: 200,
      });
    const { stderr } = await run();
    expect(postedBody()).toContain("Empty response from the model endpoint");
    expect(stderr).toContain("[coordinator] empty response");
    expect(process.exitCode).toBe(1);
    // Documented invariant: the raw response is persisted BEFORE the
    // empty-content check, so the artifact can explain WHY it was empty.
    const raw = JSON.parse(readFileSync(RAW_PATH, "utf8")) as { model: string };
    expect(raw.model).toBe("test-model-standard");
  });

  test("unparseable content posts PARSE_ERROR and keeps the raw text for triage", async () => {
    respond = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Sure! Here is my review in prose, not JSON." } }],
          model: "test-model-standard",
        }),
        { status: 200 },
      );
    const { stderr } = await run();
    expect(postedBody()).toContain("Coordinator Judge — PARSE_ERROR");
    expect(postedBody()).toContain("Sure! Here is my review in prose, not JSON.");
    expect(readFileSync(RAW_ERROR_PATH, "utf8")).toBe("Sure! Here is my review in prose, not JSON.");
    expect(stderr).toContain("failed to parse JSON");
    expect(process.exitCode).toBe(1);
  });

  test("the PARSE_ERROR excerpt is capped at 500 chars and scrubbed", async () => {
    const content = `ghp_${"a".repeat(30)} ` + "z".repeat(900);
    respond = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    await run();
    const body = postedBody();
    expect(body).not.toContain("ghp_aaaa");
    expect(body).toContain("[REDACTED-PREFIXED-TOKEN]");
    // The 900-char tail is truncated: the excerpt is a fraction of the output.
    expect(body).not.toContain("z".repeat(600));
    expect(body).toContain("z".repeat(400));
    // The full text is still on disk for triage.
    expect(readFileSync(RAW_ERROR_PATH, "utf8")).toBe(content);
  });
});

describe("main — unusable surface input", () => {
  test("a missing comments.json posts DEGRADED and exits before any state is written", async () => {
    rmSync(COMMENTS_PATH, { force: true });
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    const { stderr, value } = await captureStderrAsync(async () => {
      try {
        await cc.main({ sleep: async () => {} });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    exitSpy.mockRestore();

    expect(value).toBe("process.exit(1)");
    expect(stderr).toContain("failed to read/parse /tmp/comments.json");
    expect(postedBody()).toContain("Coordinator Judge — DEGRADED");
    expect(postedBody()).toContain("Failed to read /tmp/comments.json");
    // This path runs BEFORE the delta exists, so there is deliberately no state
    // comment — writing one here would persist an empty state over a good one.
    expect(existsSync(STATE_BODY_PATH)).toBe(false);
  });

  test("malformed comments.json takes the same guarded path", async () => {
    writeFileSync(COMMENTS_PATH, "{ not json");
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { value } = await captureStderrAsync(async () => {
      try {
        await cc.main({ sleep: async () => {} });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    });
    exitSpy.mockRestore();

    expect(value).toBe("process.exit(1)");
    expect(postedBody()).toContain("Coordinator Judge — DEGRADED");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("main — comment posting failures", () => {
  // safePostComment swallows gh failures on purpose: a failure while reporting a
  // failure must not mask the original one in the run log.
  test("a gh failure is logged and does not stop the state write", async () => {
    execSpy.mockImplementation(((file: string, args: string[]) => {
      execCalls.push({ file, args });
      if (args.includes("-X")) throw new Error("gh: HTTP 403");
      if (args.join(" ").includes("user.login != ")) return "[]";
      return "";
    }) as never);

    const { stderr } = await run();
    expect(stderr).toContain("postComment failed: gh: HTTP 403");
    expect(stderr).toContain("postStateComment failed: gh: HTTP 403");
    // Both posts were still attempted — the verdict failing does not skip state.
    expect(execCalls.filter((c) => c.args.includes("-X"))).toHaveLength(2);
  });
});
