import { describe, expect, test } from "bun:test";
import { buildIssueBody, extractFindings, issueTitle, sanitizeForIssueBody } from "./parse-noted-items.ts";

// A realistic reviewer comment, in the exact shape buildReviewComment emits.
const COMMENT = `<!-- pre-pr-review -->

## Pre-PR Review: ⚠️ APPROVE_WITH_COMMENTS

A small refactor.

Found **3** findings across 5 reviewer passes — **0 CRITICAL / 1 WARNING / 2 SUGGESTION**.

### Code Quality

| Severity | File | Finding |
|----------|------|---------|
| WARNING | \`src/a.ts:10\` | Missing error handling — the catch is empty |
| SUGGESTION | \`src/a.ts:22\` | Extract the helper — it is duplicated below |

### Security

_No findings._

### Simplify

| Severity | File | Finding |
|----------|------|---------|
| SUGGESTION | \`src/b.ts:5\` | Collapse the branches — both arms are identical |

### TypeScript

_No findings._

### Platform Best Practices

_No findings._

---

_Pre-PR Review: \`some-model\`. Tokens: 1 in / 2 out. Duration: 1.0s._
`;

describe("extractFindings", () => {
  test("collects only SUGGESTION rows, with their section", () => {
    const found = extractFindings(COMMENT);
    expect(found).toHaveLength(2);
    expect(found[0]?.section).toBe("Code Quality");
    expect(found[0]?.file).toBe("src/a.ts:22");
    expect(found[1]?.section).toBe("Simplify");
  });

  // The severity split is the whole point: a blocking finding filed as a
  // follow-up issue is a blocking finding that stopped blocking.
  test("never collects WARNING or CRITICAL rows", () => {
    const texts = extractFindings(COMMENT).map((f) => f.text);
    expect(texts.join(" ")).not.toContain("Missing error handling");
  });

  test("the severity filter is a parameter, not a hardcoded assumption", () => {
    expect(extractFindings(COMMENT, "WARNING")).toHaveLength(1);
  });

  test("a degraded/parse-error comment yields nothing", () => {
    const degraded = "<!-- pre-pr-review -->\n\n## Pre-PR Review: ❌ DEGRADED\n\nboom\n";
    expect(extractFindings(degraded)).toHaveLength(0);
  });

  test("an empty body yields nothing", () => {
    expect(extractFindings("")).toHaveLength(0);
  });
});

describe("sanitizeForIssueBody", () => {
  // The load-bearing one. GitHub acts on the `closes #N` token wherever it
  // appears in an issue body, including inside a quoted finding title — so an
  // unsanitized finding can close an unrelated issue as a side effect of being
  // filed.
  test("defangs an issue reference so a closing keyword cannot act on it", () => {
    const out = sanitizeForIssueBody("this closes #400 by accident");
    expect(out).not.toContain("closes #400");
    expect(out).toContain("#<!-- -->400");
  });

  test("defangs an @mention so filing the issue does not notify a person", () => {
    const out = sanitizeForIssueBody("ask @someone about it");
    expect(out).not.toContain("@someone");
    expect(out).toContain("@<!-- -->someone");
  });

  test("escapes pipes so a finding cannot forge table columns", () => {
    expect(sanitizeForIssueBody("a | b")).toBe("a \\| b");
  });

  test("strips control characters", () => {
    expect(sanitizeForIssueBody("a\x00b\x1bc")).toBe("abc");
  });

  test("caps the length of a single cell", () => {
    expect(sanitizeForIssueBody("x".repeat(900)).length).toBe(500);
  });
});

describe("buildIssueBody / issueTitle", () => {
  test("the title is stable, so the duplicate check can match on it", () => {
    expect(issueTitle(42)).toBe(issueTitle(42));
    expect(issueTitle(42)).toContain("42");
  });

  test("the body references the PR without creating a closing-keyword hazard", () => {
    const body = buildIssueBody(42, extractFindings(COMMENT), "https://example.test/run");
    expect(body).toContain("PR 42");
    expect(body).not.toMatch(/(clos|fix|resolv)\w*\s+#\d/i);
  });

  test("every collected finding reaches the table", () => {
    const findings = extractFindings(COMMENT);
    const body = buildIssueBody(42, findings, "");
    for (const f of findings) expect(body).toContain(f.file);
  });
});
