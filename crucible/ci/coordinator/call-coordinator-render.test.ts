// FIRST import — same module-init contract as every coordinator test file: the
// env the module snapshots must be set before the dynamic import below.
import "./coordinator-test-env.ts";
import { describe, expect, test } from "bun:test";
import { isCoordinatorState } from "./state-schema.ts";
import { makeFinding, makeState, captureStderr } from "./test-helpers.ts";

const cc = await import("./call-coordinator.ts");

type Verdict = Parameters<typeof cc.buildVerdictComment>[0];
type Meta = Parameters<typeof cc.buildVerdictComment>[1];

const meta = (over: Partial<Meta> = {}): Meta => ({
  modelResolved: "test-model",
  inputTokens: 100,
  outputTokens: 200,
  durationMs: 1500,
  surfaceCount: 2,
  surfacesPresent: ["reviewer", "scanner"],
  runUrl: "https://example.test/run/1",
  ...over,
});

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  verdict: "APPROVE",
  summary_line: "Nothing blocking.",
  findings_kept: [],
  findings_dropped: [],
  verification_criteria: [],
  ...over,
});

// The verdict comment is the coordinator's entire human-visible output. A
// finding that survives the model but is lost in rendering is indistinguishable
// from one that was never found, so the assertions below are about what
// actually reaches the reader.
describe("buildVerdictComment — kept findings", () => {
  test("an empty kept list says so rather than emitting a headerless table", () => {
    const body = cc.buildVerdictComment(verdict(), meta());
    expect(body).toContain("_No findings kept._");
    expect(body).not.toContain("| Severity | File |");
  });

  test("each kept finding becomes a row carrying severity, file, title and source", () => {
    const body = cc.buildVerdictComment(
      verdict({
        verdict: "BLOCK",
        findings_kept: [
          { severity: "CRITICAL", file: "src/a.ts", title: "Unchecked input", rationale: "r", source_surface: "scanner" },
          { severity: "WARNING", file: "src/b.ts", title: "Race condition", rationale: "r", source_surface: "reviewer" },
        ],
      }),
      meta(),
    );
    expect(body).toContain("| CRITICAL | `src/a.ts` | Unchecked input | scanner |");
    expect(body).toContain("| WARNING | `src/b.ts` | Race condition | reviewer |");
    expect(body).not.toContain("_No findings kept._");
  });

  test("the headline counts reconcile kept + dropped against the total reviewed", () => {
    const body = cc.buildVerdictComment(
      verdict({
        findings_kept: [
          { severity: "WARNING", file: "a.ts", title: "k1", rationale: "r", source_surface: "reviewer" },
          { severity: "WARNING", file: "b.ts", title: "k2", rationale: "r", source_surface: "reviewer" },
        ],
        findings_dropped: [{ title: "d1", source_surface: "scanner", drop_reason: "false-positive" }],
      }),
      meta({ surfaceCount: 2, surfacesPresent: ["reviewer", "scanner"] }),
    );
    expect(body).toContain("Reviewed **3** findings across **2** surface(s) (reviewer, scanner) — **kept 2, dropped 1**.");
  });

  test("the verdict word and its emoji both appear in the heading", () => {
    expect(cc.buildVerdictComment(verdict({ verdict: "BLOCK" }), meta())).toContain("🛑 Coordinator Judge — verdict: **BLOCK**");
    expect(cc.buildVerdictComment(verdict({ verdict: "APPROVE_WITH_COMMENTS" }), meta())).toContain("⚠️ Coordinator Judge");
    expect(cc.buildVerdictComment(verdict(), meta())).toContain("✅ Coordinator Judge");
  });

  test("the sticky marker is present — without it the next run posts a duplicate instead of updating", () => {
    expect(cc.buildVerdictComment(verdict(), meta())).toContain("<!-- coordinator-judge -->");
  });
});

describe("buildVerdictComment — dropped findings and criteria", () => {
  test("dropped findings are disclosed in a collapsed block with their reason", () => {
    const body = cc.buildVerdictComment(
      verdict({
        findings_dropped: [
          { title: "Style nit", source_surface: "scanner", drop_reason: "not-in-diff" },
          { title: "Duplicate", source_surface: "reviewer", drop_reason: "already-reported" },
        ],
      }),
      meta(),
    );
    expect(body).toContain("<summary>Click to see the 2 dropped findings</summary>");
    expect(body).toContain("`[not-in-diff]` Style nit (from `scanner`)");
    expect(body).toContain("`[already-reported]` Duplicate (from `reviewer`)");
  });

  test("no dropped findings ⇒ no dropped section at all", () => {
    const body = cc.buildVerdictComment(verdict(), meta());
    expect(body).not.toContain("Dropped findings");
  });

  test("verification criteria render as an unchecked markdown checklist", () => {
    const body = cc.buildVerdictComment(
      verdict({ verification_criteria: ["tests pass", "no new lint errors"] }),
      meta(),
    );
    expect(body).toContain("- [ ] tests pass");
    expect(body).toContain("- [ ] no new lint errors");
  });

  test("no criteria ⇒ no criteria section", () => {
    expect(cc.buildVerdictComment(verdict(), meta())).not.toContain("Verification criteria");
  });

  test("an absent run URL degrades to plain text instead of an empty link", () => {
    const body = cc.buildVerdictComment(verdict(), meta({ runUrl: "" }));
    expect(body).toContain("Run log unavailable");
    expect(body).not.toContain("[Run log]()");
  });

  test("the telemetry footer reports the resolved model and token split", () => {
    const body = cc.buildVerdictComment(verdict(), meta({ modelResolved: "model-x", inputTokens: 11, outputTokens: 22, durationMs: 2500 }));
    expect(body).toContain("`model-x`");
    expect(body).toContain("Tokens: 11 in / 22 out");
    expect(body).toContain("Duration: 2.5s");
  });
});

// These two build a 2000-commit history and trim it against the 60K comment
// ceiling — inherently heavy string work (~7-8s). Bun's 5s default made them
// fail as a TIMEOUT on a loaded machine, which reads exactly like a real
// assertion failure. Shrinking the fixture would weaken what they test, so
// give them an explicit budget instead. A test whose result depends on
// machine load is not testing what it claims to.
const TRIM_TIMEOUT_MS = 60_000;

describe("buildStateComment — the state a later run reads back", () => {
  /** Pull the state JSON back out of the rendered comment. */
  const extractJson = (body: string): unknown => {
    const match = /```json\n([\s\S]*?)\n```/.exec(body);
    if (!match?.[1]) throw new Error("no ```json block in the state comment");
    return JSON.parse(match[1]) as unknown;
  };

  // Writer/reader agreement. The next run parses this comment and validates it
  // with isCoordinatorState; if the renderer and the validator ever disagree,
  // every run silently degrades to seed mode and the delta is lost.
  test("the rendered state parses back as a VALID CoordinatorState", () => {
    const body = cc.buildStateComment(makeState([makeFinding({ status: "open" })]));
    expect(isCoordinatorState(extractJson(body))).toBe(true);
  });

  test("it carries the state marker, which is what the reader locates it by", () => {
    expect(cc.buildStateComment(makeState([]))).toContain("<!-- coordinator-state -->");
  });

  test("the human summary reports commit count and the per-status counters", () => {
    const state = makeState([], {
      counters: { open: 3, resolved: 2, dismissed: 1, reemerged: 4, total_ever_seen: 10 },
    });
    const body = cc.buildStateComment(state);
    expect(body).toContain("**Commits reviewed:** 1");
    expect(body).toContain("10 (3 open · 2 resolved · 1 dismissed · 4 re-emerged)");
  });

  test("the head SHA is abbreviated to 12 chars in the summary but kept whole in the JSON", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const body = cc.buildStateComment(makeState([], { last_head_sha: sha }));
    expect(body).toContain("**Last head SHA:** `0123456789ab`");
    expect((extractJson(body) as { last_head_sha: string }).last_head_sha).toBe(sha);
  });

  // Not cosmetic: a redacted SHA round-trips into the next run's force-push
  // probe (`git merge-base --is-ancestor <sha> <head>`), which then always
  // fails — a blanket state reset on every run.
  test("commit SHAs survive rendering unredacted", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const body = cc.buildStateComment(makeState([makeFinding({ first_seen_commit: sha })], { last_head_sha: sha }));
    expect(body).not.toContain("REDACTED");
    expect(body).toContain(sha);
  });
});

describe("buildStateComment — fitting inside GitHub's comment limit", () => {
  test("an ordinary state is emitted whole, with nothing trimmed", () => {
    const stderr = captureStderr(() => {
      const body = cc.buildStateComment(makeState([makeFinding()]));
      expect(body.length).toBeLessThan(cc.MAX_COMMENT_BODY);
    });
    expect(stderr).toBe("");
  });

  // Oldest-first commit trimming. commits_reviewed is append-only across a long
  // PR, so it is the first thing to overflow.
  test("an overlong commit history is trimmed oldest-first, and the trim is logged", () => {
    const commits = Array.from({ length: 2000 }, (_, i) => ({
      sha: i.toString(16).padStart(40, "0"),
      ts: "2020-01-01T00:00:00.000Z",
      run_id: String(i),
    }));
    let body = "";
    const stderr = captureStderr(() => {
      body = cc.buildStateComment(makeState([], { commits_reviewed: commits }));
    });
    expect(body.length).toBeLessThanOrEqual(cc.MAX_COMMENT_BODY);
    expect(stderr).toContain("truncated state comment");
    expect(stderr).toContain("dropped_commits=");
    // It trims only as far as it must: some commits are dropped, but the list is
    // neither emptied nor left at the original length.
    const kept = (JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)?.[1] ?? "null") as {
      commits_reviewed: unknown[];
    }).commits_reviewed.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(2000);
    expect(body).toContain(`**Commits reviewed:** ${kept}`);
  }, TRIM_TIMEOUT_MS);

  test("trimming keeps the NEWEST commit, not the oldest", () => {
    const commits = Array.from({ length: 2000 }, (_, i) => ({
      sha: i.toString(16).padStart(40, "0"),
      ts: "2020-01-01T00:00:00.000Z",
      run_id: String(i),
    }));
    let body = "";
    captureStderr(() => {
      body = cc.buildStateComment(makeState([], { commits_reviewed: commits }));
    });
    expect(body).toContain((1999).toString(16).padStart(40, "0"));
    expect(body).not.toContain((0).toString(16).padStart(40, "0"));
  }, TRIM_TIMEOUT_MS);

  // Open findings are the ones a later run still needs; closed ones are
  // history. Overflow must sacrifice history, never live state.
  //
  // The open findings are placed FIRST on purpose. Dropping walks the array in
  // index order, so a version that ignored status would take them in its very
  // first batch — with them at the end, the array would run out of room before
  // reaching them and the test would pass without discriminating anything.
  const overflowing = (): ReturnType<typeof makeFinding>[] => {
    const big = "x".repeat(1000);
    return [
      makeFinding({ id: "STILL-OPEN", status: "open" }),
      makeFinding({ id: "ALSO-OPEN", status: "reemerged" }),
      ...Array.from({ length: 300 }, (_, i) =>
        makeFinding({ id: `RES-${i}`, status: "resolved", title_original: big, title_normalized: big }),
      ),
    ];
  };

  test("when findings must be dropped, OPEN findings are the ones kept", () => {
    let body = "";
    const stderr = captureStderr(() => {
      body = cc.buildStateComment(makeState(overflowing()));
    });
    expect(body.length).toBeLessThanOrEqual(cc.MAX_COMMENT_BODY);
    expect(body).toContain("STILL-OPEN");
    expect(body).toContain("ALSO-OPEN");
    expect(stderr).toContain("dropped_findings=");
  });

  test("a trimmed state is still a VALID state — trimming must not corrupt the schema", () => {
    let body = "";
    captureStderr(() => {
      body = cc.buildStateComment(makeState(overflowing()));
    });
    const match = /```json\n([\s\S]*?)\n```/.exec(body);
    expect(match?.[1]).toBeDefined();
    const parsed: unknown = JSON.parse(match?.[1] ?? "null");
    expect(isCoordinatorState(parsed)).toBe(true);
    // Counters are recomputed after a drop rather than left describing findings
    // that are no longer there.
    const state = parsed as { findings: unknown[]; counters: { total_ever_seen: number } };
    expect(state.counters.total_ever_seen).toBe(state.findings.length);
  });
});
