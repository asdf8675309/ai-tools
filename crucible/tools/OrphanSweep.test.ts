import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { classify, loadTree, type FileNode } from "./OrphanSweep.ts";

const REPO = join(import.meta.dir, "..");

function node(path: string, role: FileNode["role"], content = ""): FileNode {
  return { path, role, content };
}

describe("classify — allow cases", () => {
  test("an artifact named by a root is wired", () => {
    const result = classify([
      node("skill/workflows/FullReview.md", "root", "run bun tools/Live.ts --json"),
      node("skill/tools/Live.ts", "artifact"),
    ]);
    expect(result).toEqual([
      { path: "skill/tools/Live.ts", reachability: "wired", referencedBy: ["skill/workflows/FullReview.md"] },
    ]);
  });

  test("liveness propagates through a wired artifact", () => {
    const result = classify([
      node("skill/SKILL.md", "root", "see tools/Front.ts"),
      node("skill/tools/Front.ts", "artifact", 'import { helper } from "./Deep.ts";'),
      node("skill/tools/Deep.ts", "artifact"),
    ]);
    expect(result.find((e) => e.path === "skill/tools/Deep.ts")?.reachability).toBe("wired");
  });
});

describe("classify — block cases", () => {
  // ISC-22: prose is not an execution path.
  test("a doc mention does not wire an artifact", () => {
    const result = classify([
      node("skill/workflows/FullReview.md", "root", "nothing relevant here"),
      node("README.md", "doc", "Crucible ships tools/Documented.ts for author classification."),
      node("skill/tools/Documented.ts", "artifact"),
    ]);
    const entry = result[0]!;
    expect(entry.reachability).toBe("doc-only");
    expect(entry.reachability).not.toBe("wired");
    expect(entry.referencedBy).toEqual(["README.md"]);
  });

  test("a test-only artifact is not wired", () => {
    const result = classify([
      node("skill/workflows/FullReview.md", "root", "nothing relevant here"),
      node("skill/tools/Covered.test.ts", "test", 'import "./Covered.ts";'),
      node("skill/tools/Covered.ts", "artifact"),
    ]);
    expect(result[0]!.reachability).toBe("test-only");
  });

  // ISC-23: the failure mode that inbound-reference counting cannot see.
  test("an artifact reachable only through an orphan is itself an orphan", () => {
    const result = classify([
      node("skill/workflows/FullReview.md", "root", "nothing relevant here"),
      node("skill/tools/DeadCaller.ts", "artifact", 'import { x } from "./Buried.ts";'),
      node("skill/tools/Buried.ts", "artifact"),
    ]);
    const buried = result.find((e) => e.path === "skill/tools/Buried.ts")!;

    expect(buried.reachability).toBe("orphan");
    // The trap: it HAS an inbound reference. Counting referrers would call it live.
    expect(buried.referencedBy).toEqual(["skill/tools/DeadCaller.ts"]);
    expect(result.find((e) => e.path === "skill/tools/DeadCaller.ts")?.reachability).toBe("orphan");
  });

  test("a three-level chain below an orphan is fully reported", () => {
    const result = classify([
      node("skill/SKILL.md", "root", "nothing relevant here"),
      node("skill/tools/A.ts", "artifact", "./B.ts"),
      node("skill/tools/B.ts", "artifact", "./C.ts"),
      node("skill/tools/C.ts", "artifact"),
    ]);
    expect(result.every((e) => e.reachability === "orphan")).toBe(true);
  });

  test("a substring of a longer filename does not count as a reference", () => {
    const result = classify([
      node("skill/workflows/FullReview.md", "root", "run bun tools/MyConfig.ts"),
      node("skill/tools/Config.ts", "artifact"),
      node("skill/tools/MyConfig.ts", "artifact"),
    ]);
    expect(result.find((e) => e.path === "skill/tools/Config.ts")?.reachability).toBe("orphan");
    expect(result.find((e) => e.path === "skill/tools/MyConfig.ts")?.reachability).toBe("wired");
  });
});

describe("real tree", () => {
  const entries = classify(loadTree(REPO));

  // ISC-21: empty. Every shipped artifact is reachable from an execution path.
  // Anything that regresses fails here by name.
  const KNOWN_NOT_WIRED: string[] = [];

  test("the not-wired set matches the tracked baseline exactly", () => {
    const notWired = entries.filter((e) => e.reachability !== "wired").map((e) => e.path);
    expect(notWired.sort()).toEqual([...KNOWN_NOT_WIRED].sort());
  });

  test("no artifact is wired only by a test or a doc", () => {
    expect(entries.filter((e) => e.reachability === "test-only")).toEqual([]);
    expect(entries.filter((e) => e.reachability === "doc-only")).toEqual([]);
  });

  // Guards against a tool that reports everything as dead.
  test("the live tools are reported wired", () => {
    for (const path of [
      "skill/tools/Config.ts",
      "skill/tools/CodebasePatternsScanner.ts",
      "skill/tools/ReviewPacketGenerator.ts",
      "skill/tools/SemanticCloneDetector.ts",
      "skill/tools/InjectionPreScan.ts",
    ]) {
      expect(entries.find((e) => e.path === path)?.reachability).toBe("wired");
    }
  });

  test("every reviewer agent prompt is reachable", () => {
    const agents = entries.filter((e) => e.path.startsWith("skill/agents/"));
    expect(agents).toHaveLength(10);
    expect(agents.every((a) => a.reachability === "wired")).toBe(true);
  });

  test("the sweep sees a non-trivial number of artifacts", () => {
    expect(entries.length).toBeGreaterThan(20);
  });
});
