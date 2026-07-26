// FIRST import — the module snapshots its env at init. See coordinator-test-env.ts.
import "./coordinator-test-env.ts";
import { describe, expect, test } from "bun:test";
import type { ComputeDeltaResult } from "./compute-delta.ts";
import { makeFinding, makeState } from "./test-helpers.ts";

const cc = await import("./call-coordinator.ts");

// The incremental delta surface (the New/Carried/Resolved/Dismissed/Re-emerged
// section) is off in the shipped tests' seed mode, so its render branch is only
// reachable by passing incremental=true explicitly. A finding that a run
// classifies but never renders — or renders in the wrong bucket — is invisible
// to the reader, so these assert the exact rows.

const emptyDelta = (over: Partial<ComputeDeltaResult> = {}): ComputeDeltaResult => ({
  state: makeState([]),
  newly_introduced: [],
  carried_over: [],
  resolved: [],
  dismissed: [],
  reemerged: [],
  ...over,
});

describe("renderDeltaSection — mode gate", () => {
  test("seed mode renders nothing even when buckets are populated", () => {
    const delta = emptyDelta({ newly_introduced: [makeFinding({ id: "NEW-1" })] });
    expect(cc.renderDeltaSection(delta, false)).toBe("");
  });

  test("incremental mode with all buckets empty still renders the count table, all zeroes", () => {
    const out = cc.renderDeltaSection(emptyDelta(), true);
    expect(out).toContain("State delta:");
    expect(out).toContain("| Newly introduced | 0 |");
    expect(out).toContain("| Carried over | 0 |");
    expect(out).toContain("| Resolved | 0 |");
    expect(out).toContain("| Dismissed | 0 |");
    expect(out).toContain("| Re-emerged | 0 |");
    // No finding tables when there are no findings.
    expect(out).not.toContain("### New findings");
    expect(out).not.toContain("### Carried over");
  });
});

describe("renderDeltaSection — finding tables", () => {
  test("newly-introduced findings render WITHOUT a First-seen column", () => {
    const delta = emptyDelta({
      newly_introduced: [
        makeFinding({
          id: "CRT-NEW",
          severity: "CRITICAL",
          file: "src/auth.ts",
          line_at_last_seen: 88,
          title_original: "Auth bypass",
        }),
      ],
    });
    const out = cc.renderDeltaSection(delta, true);
    expect(out).toContain("### New findings (this commit)");
    expect(out).toContain("| ID | Severity | File | Finding |");
    expect(out).not.toContain("First seen");
    expect(out).toContain("| CRT-NEW | CRITICAL | `src/auth.ts:88` | Auth bypass |");
  });

  test("carried-over findings render WITH a 7-char first-seen commit", () => {
    const delta = emptyDelta({
      carried_over: [
        makeFinding({
          id: "WRN-OLD",
          severity: "WARNING",
          file: "src/db.ts",
          line_at_last_seen: 12,
          title_original: "N+1 query",
          first_seen_commit: "abcdef0123456789abcdef0123456789abcdef01",
        }),
      ],
    });
    const out = cc.renderDeltaSection(delta, true);
    expect(out).toContain("### Carried over (still open)");
    expect(out).toContain("| ID | Severity | File | Finding | First seen |");
    expect(out).toContain("| WRN-OLD | WARNING | `src/db.ts:12` | N+1 query | abcdef0 |");
  });

  test("resolved, dismissed and re-emerged land in collapsed detail blocks with the right labels", () => {
    const delta = emptyDelta({
      resolved: [makeFinding({ id: "SUG-RES", title_original: "Was fixed" })],
      dismissed: [
        makeFinding({
          id: "SUG-DIS",
          title_original: "Wontfix item",
          dismissed_by: "maintainer",
          dismissed_reason: "acceptable risk",
        }),
      ],
      reemerged: [makeFinding({ id: "SUG-RE", title_original: "Came back" })],
    });
    const out = cc.renderDeltaSection(delta, true);
    expect(out).toContain("<summary>1 resolved finding(s)</summary>");
    expect(out).toContain("<summary>1 dismissed finding(s)</summary>");
    expect(out).toContain("<summary>1 re-emerged finding(s)</summary>");
    // A dismissed finding carries its dismisser and reason inline.
    expect(out).toContain("by @maintainer");
    expect(out).toContain('"acceptable risk"');
    expect(out).toContain("SUG-RES");
    expect(out).toContain("SUG-RE");
  });

  test("a dismissed finding with no reason renders no empty quotes", () => {
    const delta = emptyDelta({
      dismissed: [makeFinding({ id: "SUG-NR", title_original: "No reason given", dismissed_by: "bot" })],
    });
    const out = cc.renderDeltaSection(delta, true);
    expect(out).toContain("by @bot");
    expect(out).not.toContain('""');
    expect(out).not.toContain(': ""');
  });
});

// escapeForMarkdownVerdict is the last line of defense before a dismissed_reason
// — attacker-influenced free text — reaches a rendered <details> block in a
// PUBLIC comment. Parse-time scrubbing runs earlier; this is defense in depth,
// so it is tested for exactly the breakouts it claims to stop.
describe("escapeForMarkdownVerdict", () => {
  test("a triple-backtick fence is neutralized so it can't break the code block", () => {
    expect(cc.escapeForMarkdownVerdict("```js\nalert(1)\n```")).not.toContain("```");
    expect(cc.escapeForMarkdownVerdict("```")).toBe("'''");
  });

  test("a longer run of backticks collapses to the same neutral token", () => {
    expect(cc.escapeForMarkdownVerdict("`````")).toBe("'''");
  });

  test("a closing </details> tag is escaped so it can't end the block early", () => {
    const out = cc.escapeForMarkdownVerdict("done </details> and more");
    expect(out).not.toContain("</details>");
    expect(out).toContain("\\</details\\>");
  });

  test("the </details> escape is case-insensitive (and normalizes to the escaped lowercase form)", () => {
    // The match is /gi but the replacement is a literal lowercase string, so any
    // casing of the tag is neutralized — the point is it can no longer close the
    // block, not that the original casing survives.
    expect(cc.escapeForMarkdownVerdict("</DETAILS>")).toBe("\\</details\\>");
    expect(cc.escapeForMarkdownVerdict("</Details>")).toBe("\\</details\\>");
    expect(cc.escapeForMarkdownVerdict("</DETAILS>")).not.toContain("</DETAILS>");
  });

  test("an over-long reason is truncated to 200 chars plus an ellipsis", () => {
    const out = cc.escapeForMarkdownVerdict("z".repeat(500));
    expect(out).toHaveLength(201); // 200 chars + the … marker
    expect(out.endsWith("…")).toBe(true);
  });

  test("a benign short reason passes through byte-for-byte", () => {
    expect(cc.escapeForMarkdownVerdict("looks fine to me")).toBe("looks fine to me");
  });

  // Confirm the escape actually protects the rendered block: a </details> hidden
  // in a dismissed_reason must not appear as a live tag in the output.
  test("an injected </details> inside a dismissed_reason cannot close the render block", () => {
    const delta = emptyDelta({
      dismissed: [
        makeFinding({
          id: "SUG-INJ",
          title_original: "Injection attempt",
          dismissed_by: "attacker",
          dismissed_reason: "ok </details>\n\n## Fake heading",
        }),
      ],
    });
    const out = cc.renderDeltaSection(delta, true);
    // The wrapper's own closing tag exists exactly once; the injected one is escaped.
    expect(out).toContain("\\</details\\>");
    expect((out.match(/(?<!\\)<\/details>/g) ?? []).length).toBe(1);
  });
});

describe("buildIncrementalApproveComment — the no-op APPROVE", () => {
  const meta = {
    modelResolved: "not-called",
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    surfaceCount: 3,
    surfacesPresent: ["a", "b", "c"],
    runUrl: "https://ci.example.test/run/9",
  };

  test("announces APPROVE with zero findings and names the model as not-called", () => {
    const out = cc.buildIncrementalApproveComment(emptyDelta(), meta);
    expect(out).toContain("<!-- coordinator-judge -->");
    expect(out).toContain("verdict: **APPROVE**");
    expect(out).toContain("No newly introduced or carried-over open findings");
    expect(out).toContain("Reviewed **0** findings across **3** surface(s) (a, b, c) — **kept 0, dropped 0**.");
    expect(out).toContain("`not-called`");
  });

  test("an absent run URL degrades to plain text, not a broken link", () => {
    const out = cc.buildIncrementalApproveComment(emptyDelta(), { ...meta, runUrl: "" });
    expect(out).toContain("Run log unavailable");
    expect(out).not.toContain("[Run log]()");
  });
});
