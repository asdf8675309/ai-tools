/**
 * Marker-path parity.
 *
 * MarkerPath.ts deliberately duplicates the review tool's derivation instead of
 * importing it — every tool directory in this repo stands alone. Duplication
 * without a drift check is just a slow bug: if the sibling changes its scheme,
 * our copy silently reports "no marker" forever, which reads as "the review
 * never ran" for every PR.
 *
 * So this asserts two things. Golden vectors pin our own output. A source-text
 * check reads the sibling's implementation — as text, not as an import — and
 * fails if the two derivation lines we mirrored have changed. When the sibling
 * isn't present (this tool installed on its own), that half skips rather than
 * failing: parity with something absent is not a defect.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { markerPath } from "./MarkerPath.ts";

const SIBLING = join(import.meta.dir, "..", "..", "..", "crucible", "hooks", "lib", "shared.ts");

describe("markerPath — golden vectors", () => {
  test("plain branch", () => {
    expect(markerPath("/repo/.git/crucible/pre-pr-review", "main", "a1b2c3d")).toBe(
      "/repo/.git/crucible/pre-pr-review/main-a1b2c3d.json",
    );
  });

  test("slashes in the branch are flattened", () => {
    expect(markerPath("/s", "feat/add-thing", "0000000")).toBe("/s/feat_add-thing-0000000.json");
  });

  test("every character outside [A-Za-z0-9._-] becomes an underscore", () => {
    expect(markerPath("/s", "a b:c@d/e", "1234567")).toBe("/s/a_b_c_d_e-1234567.json");
  });

  test("dots and dashes survive — they are legal in branch names and in the filename", () => {
    expect(markerPath("/s", "release-1.2.x", "deadbee")).toBe("/s/release-1.2.x-deadbee.json");
  });
});

describe("markerPath — drift against the sibling implementation", () => {
  const present = existsSync(SIBLING);

  test.skipIf(!present)("the sibling still derives the filename the same way", () => {
    const src = readFileSync(SIBLING, "utf8");
    expect(src).toContain("branch.replace(/[^a-zA-Z0-9._-]/g, '_')");
    expect(src).toContain("`${safe}-${sha}.json`");
  });

  test.skipIf(!present)("the sibling still roots state inside the repo's git dir", () => {
    const src = readFileSync(SIBLING, "utf8");
    expect(src).toContain("join(commonDir, 'crucible', 'pre-pr-review')");
  });

  test("the drift check knows where to look", () => {
    expect(SIBLING.endsWith(join("crucible", "hooks", "lib", "shared.ts"))).toBe(true);
  });
});
