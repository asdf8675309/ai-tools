// FIRST import — sets the env the module snapshots at init, so module-init has
// no side effects (no process.exit on a missing token, no git shell-out for the
// SHAs). The import.meta.main guard keeps main() from running under the test
// runner. See coordinator-test-env.ts for why this is a module and not inline.
import "./coordinator-test-env.ts";
import { describe, expect, test } from "bun:test";
import { computeDelta } from "./compute-delta.ts";
import { makeFinding, makeOpts, makeSourceFinding, makeState } from "./test-helpers.ts";

const cc = await import("./call-coordinator.ts");

describe("scrubSecrets", () => {
  test("redacts Bearer tokens", () => {
    expect(cc.scrubSecrets("got Bearer abc.def_ghi-123 here")).toContain("Bearer [REDACTED]");
  });

  test("redacts known-prefix tokens (ghp_)", () => {
    const out = cc.scrubSecrets(`token ghp_${"a".repeat(20)} done`);
    expect(out).toContain("[REDACTED-PREFIXED-TOKEN]");
    expect(out).not.toContain("ghp_a");
  });

  // Load-bearing, not cosmetic: a redacted SHA round-trips into state and the
  // next run's force-push probe (`git merge-base --is-ancestor <sha> <head>`)
  // then always fails, resetting the whole state every run.
  test("lets a 40-hex commit SHA pass through", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(cc.scrubSecrets(sha)).toBe(sha);
  });

  test("redacts a long mixed-case token by shape", () => {
    expect(cc.scrubSecrets("Ab1".repeat(20))).toContain("[REDACTED-TOKEN-SHAPE]");
  });
});

describe("parseStickyComment — malformed-JSON tolerance", () => {
  test("empty input → null", () => {
    expect(cc.parseStickyComment("")).toBeNull();
  });

  test("malformed JSON → null (no throw)", () => {
    expect(cc.parseStickyComment('{"id": 5, "body"')).toBeNull();
  });

  test("wrong shape → null", () => {
    expect(cc.parseStickyComment('{"id": "5"}')).toBeNull();
  });

  test("valid sticky → {id, body}", () => {
    expect(cc.parseStickyComment('{"id": 5, "body": "hi"}')).toEqual({ id: 5, body: "hi" });
  });
});

describe("parseDismissalNdjson — malformed-line tolerance", () => {
  test("empty input → []", () => {
    expect(cc.parseDismissalNdjson("")).toEqual([]);
  });

  test("skips malformed lines but keeps valid ones (no throw)", () => {
    const raw = [
      '{"body": "/dismiss SUG-1", "user": {"login": "alice"}, "author_association": "MEMBER", "created_at": "t1"}',
      "{ this is not json",
      '{"body": "/dismiss SUG-2", "user": {"login": "bob"}, "author_association": "OWNER", "created_at": "t2"}',
    ].join("\n");
    const out = cc.parseDismissalNdjson(raw);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.user.login)).toEqual(["alice", "bob"]);
  });
});

describe("buildStateComment — truncation", () => {
  test("trims closed findings so the body fits MAX_COMMENT_BODY", () => {
    const big = "x".repeat(1000);
    const findings = Array.from({ length: 200 }, (_, i) =>
      makeFinding({ id: `SUG-${i}`, status: "resolved", title_original: big, title_normalized: big }),
    );
    findings.push(makeFinding({ id: "OPEN-1", status: "open" }));
    const body = cc.buildStateComment(makeState(findings));
    expect(body.length).toBeLessThanOrEqual(cc.MAX_COMMENT_BODY);
  });
});

describe("buildVerdictComment — stateless-path body preservation", () => {
  test("renders no delta surface when incremental mode is off, even though a delta is supplied", () => {
    // Seed delta with a populated newly_introduced bucket — it would render a
    // "New findings" table if the gate were not inside renderDeltaSection.
    const delta = computeDelta(null, [makeSourceFinding()], makeOpts());
    expect(delta.newly_introduced.length).toBeGreaterThan(0);

    const out: Parameters<typeof cc.buildVerdictComment>[0] = {
      verdict: "APPROVE",
      summary_line: "All good.",
      findings_kept: [],
      findings_dropped: [],
      verification_criteria: [],
    };
    const meta: Parameters<typeof cc.buildVerdictComment>[1] = {
      modelResolved: "test-model",
      inputTokens: 1,
      outputTokens: 2,
      durationMs: 100,
      surfaceCount: 2,
      surfacesPresent: ["crucible", "semgrep"],
      runUrl: "https://example.test/run",
      delta,
    };

    const body = cc.buildVerdictComment(out, meta);
    expect(body).toContain("verdict: **APPROVE**");
    expect(body).not.toContain("State delta:");
    expect(body).not.toContain("New findings");
  });
});

describe("prompt substitution ($-pattern expansion)", () => {
  // Same defect as call-reviewer.ts, and arguably more exposed: the replacement
  // here is JSON.stringify'd review-comment prose — scanners quoting patterns,
  // humans quoting shell — where `$'` and `$&` appear routinely, and
  // JSON.stringify does not escape `$`.
  // `toContain` is what discriminates; a size bound alone passes under the buggy
  // form (measured: bound 88, buggy output 46).

  test("$' in comment JSON is inserted literally, not expanded", () => {
    const tpl = "PR {PR_NUMBER}\n{INJECTED_COMMENTS_JSON}\nEND";
    const json = JSON.stringify({ body: "use $'\\n' for a newline" });
    const out = cc.buildPrompt(tpl, "1", json);
    expect(out).toContain(json);
    expect(out.length).toBeLessThan(tpl.length + json.length + 10);
  });

  test("$`, $& and $$ stay literal", () => {
    const tpl = "{INJECTED_COMMENTS_JSON}";
    // $$ corrupts by SHRINKING ("$$" -> "$"), so no size bound can catch it.
    for (const p of ["a $` b", "a $& b", "PID=$$ and $$$$"]) {
      expect(cc.buildPrompt(tpl, "1", p)).toBe(p);
    }
  });

  test("a placeholder token inside the comments JSON is not re-substituted", () => {
    const tpl = "PR {PR_NUMBER}: {INJECTED_COMMENTS_JSON}";
    const json = JSON.stringify({ body: "see {PR_NUMBER} and {INJECTED_COMMENTS_JSON}" });
    expect(cc.buildPrompt(tpl, "7", json)).toBe(`PR 7: ${json}`);
  });
});
