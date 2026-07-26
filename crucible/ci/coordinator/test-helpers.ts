// Shared fixtures + utilities for the coordinator test harness. Not a *.test.ts
// file, so bun test does not execute it directly.
import {
  CURRENT_SCHEMA_VERSION,
  type CoordinatorState,
  type StateFinding,
} from "./state-schema.ts";
import type { ComputeDeltaOptions, SourceFinding } from "./compute-delta.ts";

export function makeFinding(overrides: Partial<StateFinding> = {}): StateFinding {
  return {
    id: "SUG-ABC123",
    source_surface: "crucible",
    severity: "SUGGESTION",
    file: "src/a.ts",
    line: 10,
    line_at_last_seen: 10,
    title_normalized: "some finding",
    title_original: "Some finding",
    status: "open",
    first_seen_commit: "a".repeat(40),
    first_seen_run_id: "100",
    last_seen_commit: "a".repeat(40),
    last_seen_run_id: "100",
    ...overrides,
  };
}

export function makeState(
  findings: StateFinding[],
  overrides: Partial<CoordinatorState> = {},
): CoordinatorState {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    last_run_id: "100",
    last_run_url: "https://example.test/run/100",
    last_run_ts: "2026-01-01T00:00:00.000Z",
    last_head_sha: "a".repeat(40),
    last_base_sha: "b".repeat(40),
    commits_reviewed: [{ sha: "a".repeat(40), ts: "2026-01-01T00:00:00.000Z", run_id: "100" }],
    findings,
    counters: { open: 0, resolved: 0, dismissed: 0, reemerged: 0, total_ever_seen: findings.length },
    ...overrides,
  };
}

export function makeSourceFinding(overrides: Partial<SourceFinding> = {}): SourceFinding {
  return {
    source_surface: "crucible",
    severity: "SUGGESTION",
    file: "src/a.ts",
    line: 10,
    title: "Some finding",
    ...overrides,
  };
}

export function makeOpts(overrides: Partial<ComputeDeltaOptions> = {}): ComputeDeltaOptions {
  return {
    currentHeadSha: "c".repeat(40),
    currentRunId: "200",
    currentRunUrl: "https://example.test/run/200",
    currentTs: "2026-01-10T00:00:00.000Z",
    baseSha: "b".repeat(40),
    forcePushed: false,
    dismissalRecords: [],
    renameMap: new Map(),
    ...overrides,
  };
}

// Run `fn` with console.error captured; returns the joined stderr lines so tests
// can assert on diagnostic output. Restores the original in a finally block.
export function captureStderr(fn: () => void): string {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

// Async twin of captureStderr, for the paths that await (postSticky, main).
// Returns both the captured stderr and the resolved value so a test can assert
// on the log AND the result without a second run.
export async function captureStderrAsync<T>(
  fn: () => Promise<T>,
): Promise<{ stderr: string; value: T }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), stderr: lines.join("\n") };
  } finally {
    console.error = original;
  }
}
