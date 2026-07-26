import { describe, expect, test } from "bun:test";
import { emitRemovalCandidate, type DiffStats } from "./RemovalTrackingGate.ts";

// Threshold is 3.0 in config.yaml; MEDIUM escalates at 2x.
function stats(over: Partial<DiffStats> = {}): DiffStats {
  return {
    added_loc: 600,
    removed_loc: 100,
    added_multiline_strings: 4,
    removed_multiline_strings: 0,
    add_remove_ratio: 6,
    files_changed: 12,
    ...over,
  };
}

const AGENT = { agentAuthor: "claude", authorConfidence: 90 } as const;

describe("emitRemovalCandidate — fires", () => {
  test("an over-ratio agent-authored diff yields exactly one candidate", () => {
    const candidate = emitRemovalCandidate(stats(), AGENT);
    expect(candidate).not.toBeNull();
    expect(candidate!.category).toBe("High Add/Remove Ratio (R12)");
    expect(candidate!.file).toBe("(PR-wide)");
  });

  test("the evidence states the measurement that justifies it", () => {
    const candidate = emitRemovalCandidate(stats(), AGENT)!;
    expect(candidate.evidence).toContain("600");
    expect(candidate.evidence).toContain("100");
    expect(candidate.evidence).toContain("claude");
  });

  test("severity escalates to MEDIUM at twice the threshold", () => {
    expect(emitRemovalCandidate(stats({ add_remove_ratio: 6 }), AGENT)!.severity).toBe("MEDIUM");
    expect(emitRemovalCandidate(stats({ add_remove_ratio: 3.5 }), AGENT)!.severity).toBe("LOW");
  });
});

describe("emitRemovalCandidate — stays silent", () => {
  test("under the ratio threshold", () => {
    expect(emitRemovalCandidate(stats({ add_remove_ratio: 2.9 }), AGENT)).toBeNull();
  });

  test("when the author is not classified as an agent", () => {
    expect(emitRemovalCandidate(stats(), { agentAuthor: "unknown", authorConfidence: 99 })).toBeNull();
  });

  test("when author confidence is below 70", () => {
    expect(emitRemovalCandidate(stats(), { agentAuthor: "claude", authorConfidence: 69 })).toBeNull();
  });

  test("on a diff too small for the ratio to mean anything", () => {
    expect(emitRemovalCandidate(stats({ added_loc: 49, removed_loc: 1 }), AGENT)).toBeNull();
  });
});

describe("candidate shape — the disprove pass must be able to route it", () => {
  test("it declares itself structural rather than a path deviation", () => {
    const candidate = emitRemovalCandidate(stats(), AGENT)!;
    // DisproveSubagentPrompt.md routes on these two markers.
    expect(candidate.file).toBe("(PR-wide)");
    expect(candidate.deviation_from).toContain("structural signal");
  });

  test("it never claims a real line number", () => {
    expect(emitRemovalCandidate(stats(), AGENT)!.line).toBe(0);
  });
});
