#!/usr/bin/env bun
/**
 * Crucible — Orphan Sweep
 *
 * Reports shipped artifacts that nothing reaches. A contributor tool: it lives
 * outside skill/ and hooks/, so install.sh never copies it to a user's machine.
 *
 * Reachability from execution roots, NOT inbound-reference counts. Counting
 * inbound references reports a file as live when its only referrer is itself
 * dead — the two-level orphan. Reachability catches that by construction.
 *
 * Four classes:
 *   wired      reachable from a workflow, SKILL.md, hook, config, or CI job
 *   test-only  reachable only from a test file — covered, never called
 *   doc-only   named only in prose — documented, never called
 *   orphan     nothing references it at all
 *
 * Only `wired` counts as live. A mention in a README does not wire anything.
 *
 * Usage:
 *   bun tools/OrphanSweep.ts            # table, exits 1 if any non-wired artifact
 *   bun tools/OrphanSweep.ts --json
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

export type Reachability = "wired" | "test-only" | "doc-only" | "orphan";

export type Role = "root" | "artifact" | "test" | "doc";

export interface FileNode {
  path: string;
  content: string;
  role: Role;
}

export interface SweepEntry {
  path: string;
  reachability: Reachability;
  referencedBy: string[];
}

function mentions(haystack: string, target: string): boolean {
  const escaped = basename(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}`).test(haystack);
}

/**
 * Propagate liveness only through nodes that can actually execute. A doc that
 * names a tool does not make it live, and neither does a test.
 */
function reachableFrom(seeds: FileNode[], artifacts: FileNode[], carriers: Set<Role>): Set<string> {
  const live = new Set<string>();
  const frontier = [...seeds];

  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const candidate of artifacts) {
      if (live.has(candidate.path) || candidate.path === current.path) continue;
      if (!mentions(current.content, candidate.path)) continue;
      live.add(candidate.path);
      if (carriers.has(candidate.role)) frontier.push(candidate);
    }
  }
  return live;
}

export function classify(nodes: FileNode[]): SweepEntry[] {
  const artifacts = nodes.filter((n) => n.role === "artifact");
  const roots = nodes.filter((n) => n.role === "root");
  const tests = nodes.filter((n) => n.role === "test");
  const docs = nodes.filter((n) => n.role === "doc");

  const wired = reachableFrom(roots, artifacts, new Set<Role>(["artifact"]));
  const testReachable = reachableFrom(tests, artifacts, new Set<Role>(["artifact"]));
  const docReachable = reachableFrom(docs, artifacts, new Set<Role>());

  return artifacts
    .map((a) => {
      const referencedBy = nodes
        .filter((n) => n.path !== a.path && mentions(n.content, a.path))
        .map((n) => n.path)
        .sort();

      let reachability: Reachability = "orphan";
      if (wired.has(a.path)) reachability = "wired";
      else if (testReachable.has(a.path)) reachability = "test-only";
      else if (docReachable.has(a.path)) reachability = "doc-only";

      return { path: a.path, reachability, referencedBy };
    })
    .sort((x, y) => x.path.localeCompare(y.path));
}

function listFiles(dir: string, root: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__fixtures__" || name === "metis") continue;
      out = out.concat(listFiles(full, root));
    } else {
      out.push(relative(root, full));
    }
  }
  return out;
}

function roleFor(path: string): Role | null {
  // The auditor is not part of the graph. This file's own baseline list names
  // every artifact it reports, which would otherwise mark each one referenced.
  if (path.startsWith("tools/")) return null;

  if (path.endsWith(".test.ts") || path.endsWith(".test.sh")) return "test";

  const isRoot =
    path === "skill/SKILL.md" ||
    path === "skill/config.yaml" ||
    path === "skill/config.example.yaml" ||
    path === "install.sh" ||
    path === "package.json" ||
    path.startsWith("skill/workflows/") ||
    path.startsWith("hooks/") ||
    path.startsWith("ci/workflows/");
  if (isRoot) return "root";

  const isArtifact =
    (path.startsWith("skill/tools/") && (path.endsWith(".ts") || path.endsWith(".md"))) ||
    path.startsWith("skill/references/") ||
    path.startsWith("skill/agents/");
  if (isArtifact) return "artifact";

  if (path.endsWith(".md")) return "doc";
  return null;
}

export function loadTree(root: string): FileNode[] {
  const nodes: FileNode[] = [];
  for (const path of listFiles(root, root)) {
    const role = roleFor(path);
    if (!role) continue;
    nodes.push({ path, content: readFileSync(join(root, path), "utf8"), role });
  }
  return nodes;
}

async function main(): Promise<void> {
  const root = join(import.meta.dir, "..");
  const entries = classify(loadTree(root));
  const dead = entries.filter((e) => e.reachability !== "wired");

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ entries, deadCount: dead.length }, null, 2));
  } else {
    for (const e of entries) {
      const mark = e.reachability === "wired" ? "  " : "!!";
      console.log(`${mark} ${e.reachability.padEnd(10)} ${e.path}`);
    }
    console.log(`\n${entries.length} artifacts, ${dead.length} not wired`);
  }
  process.exit(dead.length === 0 ? 0 : 1);
}

if (import.meta.main) await main();
