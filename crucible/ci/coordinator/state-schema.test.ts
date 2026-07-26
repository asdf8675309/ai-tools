import { describe, expect, test } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  isCoordinatorState,
  type CoordinatorState,
  type StateFinding,
} from "./state-schema.ts";

// The state this validator guards is read back out of a PUBLIC PR comment, so
// every field is attacker-reachable on the way in. A validator that waves
// through a malformed finding hands compute-delta a half-typed object; the
// interesting assertions here are therefore the REJECTIONS, one per field.

const validFinding = (over: Partial<StateFinding> = {}): StateFinding => ({
  id: "SUG-1",
  source_surface: "reviewer",
  severity: "SUGGESTION",
  file: "src/example.ts",
  line: 12,
  line_at_last_seen: 12,
  title_normalized: "prefer const",
  title_original: "Prefer const",
  status: "open",
  first_seen_commit: "a".repeat(40),
  first_seen_run_id: "100",
  last_seen_commit: "a".repeat(40),
  last_seen_run_id: "100",
  ...over,
});

const validState = (over: Partial<CoordinatorState> = {}): CoordinatorState => ({
  schema_version: CURRENT_SCHEMA_VERSION,
  last_run_id: "100",
  last_run_url: "https://example.test/run/100",
  last_run_ts: "2020-01-01T00:00:00.000Z",
  last_head_sha: "c".repeat(40),
  last_base_sha: "b".repeat(40),
  commits_reviewed: [{ sha: "c".repeat(40), ts: "2020-01-01T00:00:00.000Z", run_id: "100" }],
  findings: [validFinding()],
  counters: { open: 1, resolved: 0, dismissed: 0, reemerged: 0, total_ever_seen: 1 },
  ...over,
});

/** Replace one field on the single finding of an otherwise-valid state. */
const withFindingField = (field: string, value: unknown): unknown => {
  const state = validState() as unknown as Record<string, unknown>;
  const finding = { ...validFinding() } as unknown as Record<string, unknown>;
  finding[field] = value;
  return { ...state, findings: [finding] };
};

describe("isCoordinatorState — accepts well-formed state", () => {
  test("a fully populated state validates", () => {
    expect(isCoordinatorState(validState())).toBe(true);
  });

  test("it survives a JSON round-trip (the way it is actually read back)", () => {
    const roundTripped: unknown = JSON.parse(JSON.stringify(validState()));
    expect(isCoordinatorState(roundTripped)).toBe(true);
  });

  test("an empty findings list and empty commit list are both valid", () => {
    expect(isCoordinatorState(validState({ commits_reviewed: [], findings: [] }))).toBe(true);
  });

  test("all optional finding fields present and correctly typed validates", () => {
    const full = validFinding({
      status: "reemerged",
      dismissed_at_commit: "d".repeat(40),
      dismissed_by: "reviewer-bot",
      dismissed_reason: "false positive",
      resolved_at_commit: "e".repeat(40),
      reemerged_at_commit: "f".repeat(40),
      reemergence_count: 2,
    });
    expect(isCoordinatorState(validState({ findings: [full] }))).toBe(true);
  });
});

describe("isCoordinatorState — rejects non-objects", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", '{"schema_version":1}'],
    ["a number", 1],
    ["a boolean", true],
    ["an array", [validState()]],
  ])("%s is rejected", (_label, value) => {
    expect(isCoordinatorState(value)).toBe(false);
  });
});

describe("isCoordinatorState — schema version is pinned, not merely present", () => {
  test.each([
    ["a future version", 2],
    ["a past version", 0],
    ["the version as a string", "1"],
    ["a missing version", undefined],
  ])("%s is rejected", (_label, version) => {
    expect(isCoordinatorState({ ...validState(), schema_version: version })).toBe(false);
  });

  test("the current version is accepted", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    expect(isCoordinatorState({ ...validState(), schema_version: 1 })).toBe(true);
  });
});

describe("isCoordinatorState — top-level field types", () => {
  test.each([
    "last_run_id",
    "last_run_url",
    "last_run_ts",
    "last_head_sha",
    "last_base_sha",
  ])("a non-string %s is rejected", (field) => {
    expect(isCoordinatorState({ ...validState(), [field]: 42 })).toBe(false);
    expect(isCoordinatorState({ ...validState(), [field]: undefined })).toBe(false);
  });

  test("commits_reviewed must be an array", () => {
    expect(isCoordinatorState({ ...validState(), commits_reviewed: "none" })).toBe(false);
    expect(isCoordinatorState({ ...validState(), commits_reviewed: undefined })).toBe(false);
  });

  test("findings must be an array", () => {
    expect(isCoordinatorState({ ...validState(), findings: {} })).toBe(false);
  });

  test.each(["sha", "ts", "run_id"])(
    "a commit record missing %s is rejected",
    (field) => {
      const commit: Record<string, unknown> = {
        sha: "c".repeat(40),
        ts: "2020-01-01T00:00:00.000Z",
        run_id: "100",
      };
      delete commit[field];
      expect(isCoordinatorState({ ...validState(), commits_reviewed: [commit] })).toBe(false);
    },
  );

  test("a non-object commit record is rejected", () => {
    expect(isCoordinatorState({ ...validState(), commits_reviewed: ["c".repeat(40)] })).toBe(false);
    expect(isCoordinatorState({ ...validState(), commits_reviewed: [null] })).toBe(false);
  });

  test("one bad commit among good ones still rejects the whole state", () => {
    const good = { sha: "c".repeat(40), ts: "t", run_id: "1" };
    expect(
      isCoordinatorState({ ...validState(), commits_reviewed: [good, { sha: 1, ts: "t", run_id: "1" }] }),
    ).toBe(false);
  });
});

describe("isCoordinatorState — per-finding required fields", () => {
  test.each([
    "id",
    "source_surface",
    "file",
    "title_normalized",
    "title_original",
    "first_seen_commit",
    "first_seen_run_id",
    "last_seen_commit",
    "last_seen_run_id",
  ])("a non-string %s is rejected", (field) => {
    expect(isCoordinatorState(withFindingField(field, 7))).toBe(false);
    expect(isCoordinatorState(withFindingField(field, undefined))).toBe(false);
  });

  test.each(["line", "line_at_last_seen"])("a non-number %s is rejected", (field) => {
    expect(isCoordinatorState(withFindingField(field, "12"))).toBe(false);
    expect(isCoordinatorState(withFindingField(field, undefined))).toBe(false);
  });

  // Number.isFinite, not typeof — NaN and Infinity are numbers that would break
  // every downstream line comparison in compute-delta.
  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("a %s line number is rejected", (_label, value) => {
    expect(isCoordinatorState(withFindingField("line", value))).toBe(false);
  });

  test("a non-object finding is rejected", () => {
    expect(isCoordinatorState({ ...validState(), findings: ["SUG-1"] })).toBe(false);
    expect(isCoordinatorState({ ...validState(), findings: [null] })).toBe(false);
    expect(isCoordinatorState({ ...validState(), findings: [[]] })).toBe(false);
  });

  test("one malformed finding among valid ones rejects the whole state", () => {
    const state = validState({ findings: [validFinding({ id: "SUG-1" }), validFinding({ id: "SUG-2" })] });
    expect(isCoordinatorState(state)).toBe(true);
    const poisoned = { ...state, findings: [state.findings[0], { ...state.findings[1], line: "12" }] };
    expect(isCoordinatorState(poisoned)).toBe(false);
  });
});

describe("isCoordinatorState — severity and status are closed sets", () => {
  test.each(["CRITICAL", "WARNING", "SUGGESTION"])("%s is an accepted severity", (severity) => {
    expect(isCoordinatorState(withFindingField("severity", severity))).toBe(true);
  });

  test.each([
    ["a plausible-but-unknown level", "INFO"],
    ["a lowercase variant", "critical"],
    ["an empty string", ""],
    ["a number", 1],
    ["undefined", undefined],
  ])("%s is rejected as a severity", (_label, severity) => {
    expect(isCoordinatorState(withFindingField("severity", severity))).toBe(false);
  });

  test.each(["open", "resolved", "dismissed", "reemerged", "permanently_dismissed"])(
    "%s is an accepted status",
    (status) => {
      expect(isCoordinatorState(withFindingField("status", status))).toBe(true);
    },
  );

  test.each([
    ["a plausible-but-unknown status", "closed"],
    ["a near-miss on an accepted value", "dismiss"],
    ["an empty string", ""],
    ["undefined", undefined],
  ])("%s is rejected as a status", (_label, status) => {
    expect(isCoordinatorState(withFindingField("status", status))).toBe(false);
  });
});

describe("isCoordinatorState — optional finding fields", () => {
  test.each([
    "dismissed_at_commit",
    "dismissed_by",
    "dismissed_reason",
    "resolved_at_commit",
    "reemerged_at_commit",
  ])("%s may be absent but must be a string when present", (field) => {
    expect(isCoordinatorState(withFindingField(field, undefined))).toBe(true);
    expect(isCoordinatorState(withFindingField(field, "ok"))).toBe(true);
    expect(isCoordinatorState(withFindingField(field, 5))).toBe(false);
    expect(isCoordinatorState(withFindingField(field, null))).toBe(false);
  });

  test("reemergence_count may be absent but must be a finite number when present", () => {
    expect(isCoordinatorState(withFindingField("reemergence_count", undefined))).toBe(true);
    expect(isCoordinatorState(withFindingField("reemergence_count", 3))).toBe(true);
    expect(isCoordinatorState(withFindingField("reemergence_count", "3"))).toBe(false);
    expect(isCoordinatorState(withFindingField("reemergence_count", Number.NaN))).toBe(false);
    expect(isCoordinatorState(withFindingField("reemergence_count", null))).toBe(false);
  });
});

describe("isCoordinatorState — counters", () => {
  test.each(["open", "resolved", "dismissed", "reemerged", "total_ever_seen"])(
    "a non-number counters.%s is rejected",
    (field) => {
      const counters: Record<string, unknown> = {
        open: 0,
        resolved: 0,
        dismissed: 0,
        reemerged: 0,
        total_ever_seen: 0,
      };
      counters[field] = "0";
      expect(isCoordinatorState({ ...validState(), counters })).toBe(false);
    },
  );

  test("a missing counters block is rejected", () => {
    const state = validState() as unknown as Record<string, unknown>;
    delete state.counters;
    expect(isCoordinatorState(state)).toBe(false);
  });

  test("a non-object counters block is rejected", () => {
    expect(isCoordinatorState({ ...validState(), counters: [0, 0, 0, 0, 0] })).toBe(false);
    expect(isCoordinatorState({ ...validState(), counters: null })).toBe(false);
  });

  // Counters are cross-checked for TYPE, not for arithmetic agreement with
  // findings — recorded here so a future reader does not mistake the validator
  // for a consistency check it never claimed to be.
  test("counters that disagree with the findings array are still structurally valid", () => {
    expect(
      isCoordinatorState(validState({ counters: { open: 99, resolved: 0, dismissed: 0, reemerged: 0, total_ever_seen: 99 } })),
    ).toBe(true);
  });
});

describe("isCoordinatorState — extra properties", () => {
  // Not a whitelist: unknown keys ride along rather than rejecting the state, so
  // a newer writer's field does not brick an older reader.
  test("an unknown top-level key does not reject an otherwise-valid state", () => {
    expect(isCoordinatorState({ ...validState(), future_field: "whatever" })).toBe(true);
  });
});
