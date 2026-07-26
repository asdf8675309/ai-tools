import { describe, expect, test } from "bun:test";
import { parseStateComment } from "./parse-state.ts";
import type { CoordinatorState } from "./state-schema.ts";
import { captureStderr, makeState } from "./test-helpers.ts";

// Build a state comment in the shape renderStateComment emits.
function stateComment(
  stateJson: string,
  opts: { decoyBeforeSummary?: boolean; withSummary?: boolean } = {},
): string {
  const withSummary = opts.withSummary ?? true;
  const decoy = opts.decoyBeforeSummary ? '\n```json\n{"schema_version": 999}\n```\n' : "";
  const summary = withSummary ? "<summary>State JSON</summary>" : "";
  return `<!-- coordinator-state -->\n\n## 🧠 Coordinator State\n${decoy}\n<details>\n${summary}\n\n\`\`\`json\n${stateJson}\n\`\`\`\n\n</details>\n`;
}

function parseWithStderr(body: string | null): { result: CoordinatorState | null; stderr: string } {
  let result: CoordinatorState | null = null;
  const stderr = captureStderr(() => {
    result = parseStateComment(body);
  });
  return { result, stderr };
}

describe("parseStateComment — diagnostics", () => {
  test("null body logs the seed-run reason", () => {
    const { result, stderr } = parseWithStderr(null);
    expect(result).toBeNull();
    expect(stderr).toContain("empty comment body");
  });

  test("missing marker logs the seed-run reason", () => {
    const { result, stderr } = parseWithStderr("just a normal comment, no marker");
    expect(result).toBeNull();
    expect(stderr).toContain("STATE_MARKER not found");
  });

  test("marker but no json fence logs missing fence", () => {
    const { result, stderr } = parseWithStderr("<!-- coordinator-state -->\n\nno fence here");
    expect(result).toBeNull();
    expect(stderr).toContain("missing json fence");
  });

  test("invalid JSON in fence logs a parse error", () => {
    const { result, stderr } = parseWithStderr(stateComment("{ not valid json "));
    expect(result).toBeNull();
    expect(stderr).toContain("parse failed");
  });

  test("schema version too high is rejected distinctly", () => {
    const { result, stderr } = parseWithStderr(stateComment('{"schema_version": 999}'));
    expect(result).toBeNull();
    expect(stderr).toContain("unsupported schema version");
  });

  test("invalid schema (right version, wrong shape) is rejected distinctly", () => {
    const { result, stderr } = parseWithStderr(stateComment('{"schema_version": 1, "findings": "nope"}'));
    expect(result).toBeNull();
    expect(stderr).toContain("invalid schema");
  });
});

describe("parseStateComment — fence anchoring", () => {
  test("round-trips a valid state", () => {
    const state = makeState([], { last_run_id: "777" });
    const { result } = parseWithStderr(stateComment(JSON.stringify(state)));
    expect(result).not.toBeNull();
    expect(result?.last_run_id).toBe("777");
  });

  // The state comment is public and anyone can quote it back in a reply. If the
  // parser took the FIRST json fence after the marker, a quoted decoy would win.
  test("a decoy json fence before the State JSON wrapper is ignored", () => {
    const state = makeState([], { last_run_id: "real-777" });
    const { result } = parseWithStderr(
      stateComment(JSON.stringify(state), { decoyBeforeSummary: true }),
    );
    // If the decoy ({"schema_version":999}) had been picked, this would be null.
    expect(result).not.toBeNull();
    expect(result?.last_run_id).toBe("real-777");
  });

  test("falls back to the last fence when the State JSON anchor is absent", () => {
    const state = makeState([], { last_run_id: "888" });
    const { result } = parseWithStderr(
      stateComment(JSON.stringify(state), { withSummary: false }),
    );
    expect(result).not.toBeNull();
    expect(result?.last_run_id).toBe("888");
  });
});
