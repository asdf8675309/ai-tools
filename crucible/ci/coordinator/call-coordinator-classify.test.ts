// FIRST import — the module snapshots its env at init. See coordinator-test-env.ts.
import "./coordinator-test-env.ts";
import { describe, expect, test } from "bun:test";
import type { SurfaceCommentFinding, SurfacesInput } from "./call-coordinator.ts";
import { makeFinding } from "./test-helpers.ts";

const cc = await import("./call-coordinator.ts");

const surfaceFinding = (over: Partial<SurfaceCommentFinding> = {}): SurfaceCommentFinding => ({
  surface: "reviewer",
  body: "some finding body",
  author: "bot",
  posted_at: "2026-02-01T00:00:00.000Z",
  comment_url: "https://github.example.test/c/1",
  ...over,
});

const surfacesInput = (findings: SurfaceCommentFinding[]): SurfacesInput => ({
  pr: 1,
  surface_count: new Set(findings.map((f) => f.surface)).size,
  finding_count: findings.length,
  surfaces_present: [...new Set(findings.map((f) => f.surface))],
  findings,
});

// severityFromSurfaceFinding and titleFromSurfaceFinding are the coordinator's
// only classification step before the model sees a finding — a mis-mapping here
// changes what state the finding is stored under and how it's deduplicated. They
// are exercised through the exported sourceFindingsFromSurfaces.
describe("severity derivation from a surface finding", () => {
  const severityOf = (over: Partial<SurfaceCommentFinding>) =>
    cc.sourceFindingsFromSurfaces(surfacesInput([surfaceFinding(over)]))[0]?.severity;

  test.each(["CRITICAL", "a hard ERROR here", "marked HIGH severity", "this should BLOCK merge"])(
    "body %p maps to CRITICAL",
    (body) => {
      expect(severityOf({ body })).toBe("CRITICAL");
    },
  );

  test.each(["a WARNING worth noting", "WARN: flaky", "MEDIUM risk", "verdict APPROVE_WITH_COMMENTS"])(
    "body %p maps to WARNING",
    (body) => {
      expect(severityOf({ body })).toBe("WARNING");
    },
  );

  test("an unrecognized body falls back to SUGGESTION", () => {
    expect(severityOf({ body: "just a friendly nudge about naming" })).toBe("SUGGESTION");
  });

  test("the severity hint is weighed alongside the body, and CRITICAL wins over WARNING", () => {
    // hint says CRITICAL, body says WARNING — CRITICAL is checked first and wins.
    expect(severityOf({ severity_hint: "CRITICAL", body: "this is only a WARNING" })).toBe("CRITICAL");
  });

  test("matching is case-insensitive", () => {
    expect(severityOf({ body: "critical failure" })).toBe("CRITICAL");
  });

  test("a severity word embedded in a larger word does NOT trigger (word-boundary)", () => {
    // "criticality" must not match \bCRITICAL\b as a standalone severity.
    expect(severityOf({ body: "discussing the criticality of naming here" })).toBe("SUGGESTION");
  });
});

describe("title derivation from a surface finding", () => {
  const titleOf = (over: Partial<SurfaceCommentFinding>) =>
    cc.sourceFindingsFromSurfaces(surfacesInput([surfaceFinding(over)]))[0]?.title;

  test("an explicit title wins over the body", () => {
    expect(titleOf({ title: "  Explicit title  ", body: "ignored body" })).toBe("Explicit title");
  });

  test("with no title, the first non-empty body line becomes the title, stripped of markdown", () => {
    expect(titleOf({ title: undefined, body: "### **Heading** finding\n\ndetails" })).toBe("Heading finding");
  });

  test("a leading HTML comment line is skipped when picking the title line", () => {
    expect(titleOf({ title: undefined, body: "<!-- marker -->\nActual finding title" })).toBe(
      "Actual finding title",
    );
  });

  test("a list-marker prefix is stripped", () => {
    expect(titleOf({ title: undefined, body: "- item level finding" })).toBe("item level finding");
  });

  test("a body with nothing usable falls back to '<surface> finding'", () => {
    expect(titleOf({ surface: "scanner", title: undefined, body: "<!-- only a comment -->\n\n   " })).toBe(
      "scanner finding",
    );
  });

  test("a very long title line is capped at 180 chars", () => {
    const title = cc.sourceFindingsFromSurfaces(
      surfacesInput([surfaceFinding({ title: undefined, body: "y".repeat(400) })]),
    )[0]?.title;
    expect(title).toHaveLength(180);
  });
});

describe("sourceFindingsFromSurfaces — field defaults", () => {
  test("a blank file falls back to 'PR comment' and a non-finite line to 1", () => {
    const out = cc.sourceFindingsFromSurfaces(
      surfacesInput([surfaceFinding({ file: "   ", line: Number.NaN, body: "x" })]),
    );
    expect(out[0]?.file).toBe("PR comment");
    expect(out[0]?.line).toBe(1);
  });

  test("a real file and line are preserved and the surface becomes source_surface", () => {
    const out = cc.sourceFindingsFromSurfaces(
      surfacesInput([surfaceFinding({ surface: "static-analysis", file: " src/x.ts ", line: 33, body: "x" })]),
    );
    expect(out[0]).toMatchObject({ source_surface: "static-analysis", file: "src/x.ts", line: 33 });
  });

  test("an empty findings list maps to an empty array", () => {
    expect(cc.sourceFindingsFromSurfaces(surfacesInput([]))).toEqual([]);
  });
});

// surfacesForDelta narrows the full surface input down to just the findings the
// delta says are open (new + carried), so the model is billed only for what
// changed. If it leaked closed findings or dropped open ones, incremental mode
// would either re-bill resolved noise or silently stop reviewing live findings.
describe("surfacesForDelta — narrowing the prompt to open findings", () => {
  const ts = "2026-02-05T00:00:00.000Z";

  test("only the passed findings survive, re-keyed onto surface-comment shape", () => {
    const base = surfacesInput([surfaceFinding({ surface: "reviewer", body: "original noise" })]);
    const open = [
      makeFinding({ id: "CRT-1", source_surface: "scanner", title_original: "Real bug", file: "src/a.ts", line_at_last_seen: 5 }),
    ];
    const out = cc.surfacesForDelta(base, open, ts);

    expect(out.findings).toHaveLength(1);
    expect(out.finding_count).toBe(1);
    expect(out.findings[0]).toMatchObject({
      surface: "scanner",
      source_surface: "scanner",
      title: "Real bug",
      file: "src/a.ts",
      line: 5,
      body: "[CRT-1] Real bug",
      author: "coordinator-state",
    });
    // The original reviewer surface is gone — it wasn't in the open set.
    expect(out.findings[0]?.body).not.toContain("original noise");
  });

  test("surfaces_present is recomputed from the surviving findings, deduplicated", () => {
    const base = surfacesInput([surfaceFinding()]);
    const open = [
      makeFinding({ id: "A", source_surface: "scanner" }),
      makeFinding({ id: "B", source_surface: "reviewer" }),
      makeFinding({ id: "C", source_surface: "scanner" }),
    ];
    const out = cc.surfacesForDelta(base, open, ts);
    expect(out.surface_count).toBe(2);
    expect([...out.surfaces_present].sort()).toEqual(["reviewer", "scanner"]);
  });

  test("an empty open set yields zero surfaces and zero findings", () => {
    const out = cc.surfacesForDelta(surfacesInput([surfaceFinding()]), [], ts);
    expect(out.surface_count).toBe(0);
    expect(out.finding_count).toBe(0);
    expect(out.surfaces_present).toEqual([]);
    expect(out.findings).toEqual([]);
  });
});
