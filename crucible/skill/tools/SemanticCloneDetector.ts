/**
 * Crucible — Semantic Clone Detector (R1)
 *
 * Detects Type-4 code clones (same behaviour, different syntax) by embedding
 * functions and comparing cosine similarity. Agent-authored PRs carry measurably
 * more behavioural duplication than human ones, and that redundancy is invisible
 * to text-diff review and to complexity metrics alike.
 *
 * OPTIONAL. It needs an embedding endpoint (see EmbeddingClient); with none
 * configured — the default — every mode exits 0 with `skipped: true` and a
 * reason, so the wrapping reviewer falls back to heuristic duplication detection
 * rather than failing the review.
 *
 * Three modes:
 *
 *   --calibrate <fixture>  Sweep cosine thresholds against a hand-labeled
 *                          fixture and print precision / recall / F1 per
 *                          threshold. Used to lock the per-model threshold in
 *                          config.yaml (thresholds.clone_mrs_threshold).
 *
 *   --scan-corpus <dir>    Extract functions from every .ts/.tsx/.js/.jsx file
 *                          in <dir>. No embedding endpoint needed.
 *
 *   --diff <since-ref>     For each new function in the diff against <since-ref>,
 *                          compute MRS (max cosine similarity to any existing
 *                          function in the corpus) and emit candidates above the
 *                          configured threshold as JSON.
 *
 * Function extraction is regex-based: function declarations, arrow functions
 * assigned to a binding, and single-line class methods. Multi-line class methods
 * and complex destructured forms would need a real AST.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, extname, resolve, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { embed, cosineSimilarity, resolveEmbeddingEndpoint, type EmbeddingEndpoint } from "./EmbeddingClient.ts";
import { loadConfig } from "./Config.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface FunctionRecord {
  name: string;
  path: string;
  line: number;
  body: string;
}

interface CloneCandidate {
  new_function: FunctionRecord;
  matched_against: FunctionRecord;
  mrs: number;
  threshold: number;
  severity: "MEDIUM" | "LOW";
}

interface CalibrationPair {
  id: string;
  label: "clone" | "non_clone";
  category: string;
  a: string;
  b: string;
}

interface CalibrationFixture {
  pairs: CalibrationPair[];
}

interface ThresholdResult {
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

// ── Function extraction (regex-based) ───────────────────────────────────────

/**
 * Extract function bodies from a TypeScript / JavaScript source string.
 * Recognizes function declarations, arrow functions assigned to const/let/var,
 * and simple single-line class methods.
 */
export function extractFunctions(source: string, path: string): FunctionRecord[] {
  const records: FunctionRecord[] = [];
  const lines = source.split("\n");

  // function name(args) { ... }  — including async, export, generators
  const FUNCTION_DECL = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\s*\{/;
  // const name = (...) => ...  — including async arrow
  const ARROW_ASSIGN = /^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let name: string | null = null;
    if (FUNCTION_DECL.test(line)) {
      name = line.match(FUNCTION_DECL)?.[1] ?? null;
    } else if (ARROW_ASSIGN.test(line)) {
      name = line.match(ARROW_ASSIGN)?.[1] ?? null;
    }
    if (!name) continue;

    // Read forward tracking brace depth; single-line arrow expressions have no
    // opening brace, so capture just the line.
    const isBlockBody = line.includes("{");
    if (isBlockBody) {
      let depth = 0;
      const bodyLines: string[] = [];
      let started = false;
      for (let j = i; j < lines.length && j < i + 200; j++) {
        const l = lines[j] ?? "";
        bodyLines.push(l);
        for (const ch of l) {
          if (ch === "{") { depth++; started = true; }
          else if (ch === "}") { depth--; }
        }
        if (started && depth === 0) break;
      }
      records.push({ name, path, line: i + 1, body: bodyLines.join("\n") });
    } else {
      records.push({ name, path, line: i + 1, body: line });
    }
  }
  return records;
}

/** Recursively walk a directory, extracting functions from .ts/.tsx/.js/.jsx files. */
export function scanCorpus(dir: string, exclude: RegExp[] = []): FunctionRecord[] {
  const records: FunctionRecord[] = [];
  const exts = new Set([".ts", ".tsx", ".js", ".jsx"]);
  const DEFAULT_EXCLUDE = [/node_modules/, /\.git\//, /dist\//, /build\//, /\.next\//, /coverage\//];
  const skipList = [...DEFAULT_EXCLUDE, ...exclude];
  const root = resolve(dir);

  function walk(d: string): void {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      if (skipList.some((re) => re.test(full))) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else if (exts.has(extname(full))) {
        try {
          // Paths are corpus-root-relative so the self-match check in computeMRS
          // lines up with what extractNewFunctionsFromDiff returns.
          records.push(...extractFunctions(readFileSync(full, "utf8"), relative(root, full)));
        } catch {
          // unreadable file — skip silently
        }
      }
    }
  }
  walk(root);
  return records;
}

// ── MRS computation against an indexed corpus ───────────────────────────────

interface EmbeddedFunction extends FunctionRecord {
  embedding: number[];
}

/**
 * Embed a list of function records in batches. A failed batch is logged and
 * skipped rather than aborting the run — clone detection produces fewer
 * candidates instead of taking the whole review down with it.
 */
export async function embedFunctions(
  records: FunctionRecord[],
  endpoint?: EmbeddingEndpoint,
  label = "",
): Promise<EmbeddedFunction[]> {
  const BATCH = 32;
  const out: EmbeddedFunction[] = [];
  let failedBatches = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const slice = records.slice(i, i + BATCH);
    const result = await embed(slice.map((r) => r.body), { endpoint });
    if (!result.success) {
      failedBatches++;
      console.error(`embed batch ${i / BATCH + 1}${label ? ` (${label})` : ""} failed, ${slice.length} records skipped: ${result.error}`);
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      const record = slice[j];
      const embedding = result.embeddings[j];
      if (record && embedding) out.push({ ...record, embedding });
    }
  }
  if (failedBatches > 0) {
    console.error(`[SemanticCloneDetector] ${failedBatches} batch(es) failed; ${out.length}/${records.length} records embedded.`);
  }
  return out;
}

/**
 * For each new function, find its Maximum Redundancy Score against the corpus of
 * existing functions. Emit candidates with MRS at or above threshold.
 */
export function computeMRS(
  newFunctions: EmbeddedFunction[],
  corpus: EmbeddedFunction[],
  threshold: number,
): CloneCandidate[] {
  const candidates: CloneCandidate[] = [];
  for (const nf of newFunctions) {
    let bestSim = -Infinity;
    let bestMatch: EmbeddedFunction | null = null;
    for (const cf of corpus) {
      // Don't compare a new function against itself in the corpus
      if (cf.path === nf.path && cf.line === nf.line) continue;
      const sim = cosineSimilarity(nf.embedding, cf.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = cf;
      }
    }
    if (bestMatch && bestSim >= threshold) {
      candidates.push({
        new_function: { name: nf.name, path: nf.path, line: nf.line, body: nf.body },
        matched_against: { name: bestMatch.name, path: bestMatch.path, line: bestMatch.line, body: bestMatch.body },
        mrs: +bestSim.toFixed(4),
        threshold,
        // Severity scales with MRS — near-duplicates are MEDIUM, weaker matches LOW
        severity: bestSim >= threshold + 0.10 ? "MEDIUM" : "LOW",
      });
    }
  }
  return candidates;
}

// ── Calibration sweep ───────────────────────────────────────────────────────

/**
 * Sweep cosine thresholds against a hand-labeled fixture. Returns a table of
 * (threshold, precision, recall, F1) and identifies the F1 optimum.
 */
export async function calibrate(fixturePath: string, endpoint?: EmbeddingEndpoint): Promise<{
  results: ThresholdResult[];
  f1_optimal: ThresholdResult;
  pair_similarities: Array<{ id: string; label: string; category: string; cosine: number }>;
}> {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as CalibrationFixture;
  const records: FunctionRecord[] = fixture.pairs
    .flatMap((pair) => [pair.a, pair.b])
    .map((text, i) => ({
      name: `pair-${Math.floor(i / 2)}-${i % 2 === 0 ? "a" : "b"}`,
      path: "fixture",
      line: i + 1,
      body: text,
    }));
  const embedded = await embedFunctions(records, endpoint, "calibrate");
  if (embedded.length !== records.length) {
    throw new Error(`calibration needs every pair embedded: got ${embedded.length}/${records.length}`);
  }

  const pair_similarities = fixture.pairs.map((pair, i) => {
    const a = embedded[i * 2];
    const b = embedded[i * 2 + 1];
    if (!a || !b) throw new Error(`missing embedding for pair ${pair.id}`);
    return {
      id: pair.id,
      label: pair.label,
      category: pair.category,
      cosine: +cosineSimilarity(a.embedding, b.embedding).toFixed(4),
    };
  });

  const THRESHOLDS: number[] = [];
  for (let t = 0.40; t <= 0.95; t += 0.025) {
    THRESHOLDS.push(+t.toFixed(4));
  }

  const results: ThresholdResult[] = THRESHOLDS.map((threshold) => {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const sim of pair_similarities) {
      const predicted_clone = sim.cosine >= threshold;
      const actual_clone = sim.label === "clone";
      if (predicted_clone && actual_clone) tp++;
      else if (predicted_clone && !actual_clone) fp++;
      else if (!predicted_clone && actual_clone) fn++;
      else tn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { threshold, tp, fp, tn, fn, precision: +precision.toFixed(4), recall: +recall.toFixed(4), f1: +f1.toFixed(4) };
  });

  const first = results[0];
  if (!first) throw new Error("threshold sweep produced no rows");
  const f1_optimal = results.reduce((best, cur) => (cur.f1 > best.f1 ? cur : best), first);
  return { results, f1_optimal, pair_similarities };
}

// ── Diff parsing ────────────────────────────────────────────────────────────

/**
 * Read git diff against <sinceRef> and return the functions present in HEAD's
 * version of each changed file that are absent from the base version.
 */
export function extractNewFunctionsFromDiff(sinceRef: string, cwd = process.cwd()): FunctionRecord[] {
  // `--end-of-options` so a `sinceRef` beginning with a dash is a bad revision
  // rather than a git option: `--output=<path>` in that position makes `git diff`
  // write a file of the caller's choosing.
  //
  // Argument arrays, not a shell string. `file` below comes from this diff, which
  // means it is chosen by whoever authored the branch under review — and `$`,
  // backtick, `;` and `&` are all legal bytes in a POSIX filename that survive
  // git's core.quotePath. A file named `a$(...).ts` satisfies the extension
  // filter and would execute through /bin/sh. LightPathClassifier and
  // RiskTierClassifier already use this form for the same reason.
  const changedFiles = execFileSync(
    "git", ["diff", "--name-only", "--end-of-options", `${sinceRef}...HEAD`],
    { cwd, encoding: "utf8" },
  ).split("\n").filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));

  const newFunctions: FunctionRecord[] = [];
  for (const file of changedFiles) {
    let currentSrc: string;
    let baseSrc: string;
    try {
      currentSrc = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue; // file deleted
    }
    try {
      // stderr ignored: a file that is new in HEAD makes `git show` print a
      // fatal, which is the expected path here, not an error worth surfacing.
      baseSrc = execFileSync("git", ["show", "--end-of-options", `${sinceRef}:${file}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      baseSrc = ""; // file new in HEAD
    }
    const currentFns = extractFunctions(currentSrc, file);
    const baseFnsNames = new Set(extractFunctions(baseSrc, file).map((f) => f.name));
    for (const fn of currentFns) {
      if (!baseFnsNames.has(fn.name)) {
        newFunctions.push(fn);
      }
    }
  }
  return newFunctions;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  --calibrate [fixture-path]      Threshold sweep against a labeled fixture
                                  (default: references/CloneCalibrationPairs.json)
  --scan-corpus <dir>             Extract functions from a directory tree (no embeddings needed)
  --diff <since-ref> [dir]        Find behavioural clones in the diff against since-ref

--calibrate and --diff need an embedding endpoint; run
  bun tools/EmbeddingClient.ts --check
to see whether one is configured.`;

/** Resolve the endpoint or exit 0 with a skip payload — never fail a review over
 *  an optional integration that isn't set up. */
function requireEndpointOrSkip(mode: string): EmbeddingEndpoint {
  const resolved = resolveEmbeddingEndpoint();
  if (resolved.ok) return resolved.endpoint;
  console.error(`[SemanticCloneDetector] ${mode} skipped — ${resolved.reason}`);
  console.log(JSON.stringify({ skipped: true, reason: resolved.reason, candidates: [] }, null, 2));
  process.exit(0);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "--calibrate") {
    const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const fixturePath = args[1] ?? join(skillDir, "references", "CloneCalibrationPairs.json");
    if (!existsSync(fixturePath)) {
      console.error(`fixture not found: ${fixturePath}\nPass a path: bun SemanticCloneDetector.ts --calibrate <fixture.json>`);
      process.exit(1);
    }
    const endpoint = requireEndpointOrSkip("--calibrate");
    console.error(`Loading fixture: ${fixturePath}`);
    const { results, f1_optimal, pair_similarities } = await calibrate(fixturePath, endpoint);

    console.log("\n=== Pair-level cosine similarities ===\n");
    console.log("id              label       category               cosine");
    console.log("───────────────────────────────────────────────────────────");
    for (const ps of pair_similarities) {
      console.log(`${ps.id.padEnd(15)} ${ps.label.padEnd(11)} ${ps.category.padEnd(22)} ${ps.cosine.toFixed(4)}`);
    }

    console.log("\n=== Threshold sweep (precision / recall / F1) ===\n");
    console.log("threshold  TP  FP  TN  FN  precision  recall  F1");
    console.log("─────────────────────────────────────────────────────");
    for (const r of results) {
      console.log(
        `${r.threshold.toFixed(3).padEnd(9)}  ${String(r.tp).padStart(2)}  ${String(r.fp).padStart(2)}  ${String(r.tn).padStart(2)}  ${String(r.fn).padStart(2)}  ${r.precision.toFixed(4).padEnd(9)} ${r.recall.toFixed(4).padEnd(7)} ${r.f1.toFixed(4)}`,
      );
    }

    console.log(`\n=== F1-OPTIMAL THRESHOLD ===`);
    console.log(JSON.stringify(f1_optimal, null, 2));
  } else if (cmd === "--scan-corpus") {
    const dir = args[1] ?? process.cwd();
    const records = scanCorpus(dir);
    console.log(`Found ${records.length} functions in ${dir}`);
    console.log(JSON.stringify(records.slice(0, 5), null, 2));
  } else if (cmd === "--diff") {
    const sinceRef = args[1] ?? "origin/main";
    const corpusDir = args[2] ?? process.cwd();
    const endpoint = requireEndpointOrSkip("--diff");
    const threshold = loadConfig().thresholds.clone_mrs_threshold;

    console.error(`Scanning corpus: ${corpusDir}`);
    const corpus = scanCorpus(corpusDir);
    console.error(`Corpus: ${corpus.length} functions`);

    console.error(`Extracting new functions vs ${sinceRef}`);
    const newFns = extractNewFunctionsFromDiff(sinceRef);
    console.error(`Diff: ${newFns.length} new functions`);

    if (newFns.length === 0) {
      console.log(JSON.stringify({ threshold, candidates: [] }, null, 2));
    } else {
      console.error("Embedding corpus + new functions...");
      const [corpusEmbedded, newEmbedded] = await Promise.all([
        embedFunctions(corpus, endpoint, "corpus"),
        embedFunctions(newFns, endpoint, "diff"),
      ]);
      const candidates = computeMRS(newEmbedded, corpusEmbedded, threshold);
      console.log(JSON.stringify({ threshold, candidates }, null, 2));
    }
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}
