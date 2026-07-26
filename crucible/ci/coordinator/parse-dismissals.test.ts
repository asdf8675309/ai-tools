import { describe, expect, test } from "bun:test";
import { parseDismissalCommands, type DismissalComment } from "./parse-dismissals.ts";
import { captureStderr } from "./test-helpers.ts";

function comment(overrides: Partial<DismissalComment> = {}): DismissalComment {
  return {
    body: "/dismiss SUG-1 wontfix",
    user: { login: "bob" },
    author_association: "MEMBER",
    created_at: "2026-01-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseDismissalCommands — fork-PR authority gate", () => {
  test("PR author with NONE association is rejected", () => {
    const stderr = captureStderr(() => {
      const records = parseDismissalCommands(
        [comment({ user: { login: "alice" }, author_association: "NONE" })],
        "alice",
      );
      expect(records).toHaveLength(0);
    });
    expect(stderr).toContain("unauthorized");
  });

  test("PR author with FIRST_TIME_CONTRIBUTOR is rejected", () => {
    const records = parseDismissalCommands(
      [comment({ user: { login: "alice" }, author_association: "FIRST_TIME_CONTRIBUTOR" })],
      "alice",
    );
    expect(records).toHaveLength(0);
  });

  test("PR author with CONTRIBUTOR is allowed", () => {
    const records = parseDismissalCommands(
      [comment({ user: { login: "alice" }, author_association: "CONTRIBUTOR" })],
      "alice",
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.finding_id).toBe("SUG-1");
  });

  test("a MEMBER who is not the PR author is allowed (write access)", () => {
    const records = parseDismissalCommands(
      [comment({ user: { login: "carol" }, author_association: "MEMBER" })],
      "alice",
    );
    expect(records).toHaveLength(1);
  });

  test("a non-author with NONE is rejected", () => {
    const records = parseDismissalCommands(
      [comment({ user: { login: "mallory" }, author_association: "NONE" })],
      "alice",
    );
    expect(records).toHaveLength(0);
  });
});

describe("parseDismissalCommands — command shape", () => {
  // Anchoring is what stops "we should /dismiss SUG-1 eventually" mid-sentence
  // from silently dismissing a finding.
  test("a /dismiss mentioned mid-line is not a command", () => {
    const records = parseDismissalCommands(
      [comment({ body: "I think we should /dismiss SUG-1 but let us discuss" })],
      "alice",
    );
    expect(records).toHaveLength(0);
  });

  test("several commands in one comment all parse", () => {
    const records = parseDismissalCommands(
      [comment({ body: "/dismiss SUG-1 a\n/dismiss SUG-2 b" })],
      "alice",
    );
    expect(records.map((r) => r.finding_id)).toEqual(["SUG-1", "SUG-2"]);
  });
});

describe("parseDismissalCommands — per-comment cap", () => {
  test("caps actionable commands at 10 per comment and logs", () => {
    const body = Array.from({ length: 12 }, (_, i) => `/dismiss SUG-${i} reason${i}`).join("\n\n");
    let records: ReturnType<typeof parseDismissalCommands> = [];
    const stderr = captureStderr(() => {
      records = parseDismissalCommands([comment({ body })], "alice");
    });
    expect(records).toHaveLength(10);
    expect(stderr).toContain("per-comment cap");
  });
});

describe("parseDismissalCommands — secret + marker scrubbing in the reason", () => {
  test("redacts a GitHub PAT prefix in the reason", () => {
    const records = parseDismissalCommands(
      [comment({ body: `/dismiss SUG-1 ghp_${"a".repeat(20)}` })],
      "alice",
    );
    expect(records[0]?.reason).toContain("[REDACTED-PREFIXED-TOKEN]");
    expect(records[0]?.reason).not.toContain("ghp_");
  });

  test("redacts a vendor key prefix in the reason", () => {
    const records = parseDismissalCommands(
      [comment({ body: `/dismiss SUG-1 sk-ant-${"b".repeat(20)}` })],
      "alice",
    );
    expect(records[0]?.reason).toContain("[REDACTED-PREFIXED-TOKEN]");
    expect(records[0]?.reason).not.toContain("sk-ant-");
  });

  // The reason is rendered back into the state comment, which the parser then
  // reads on the next run — an unscrubbed marker or fence there is a way to
  // poison state detection.
  test("strips a coordinator marker from the reason", () => {
    const records = parseDismissalCommands(
      [comment({ body: "/dismiss SUG-1 see <!-- coordinator-state --> below" })],
      "alice",
    );
    expect(records[0]?.reason).not.toContain("coordinator-state");
    expect(records[0]?.reason).toContain("[redacted-marker]");
  });
});
