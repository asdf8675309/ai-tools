/**
 * Crucible — Review Packet Generator (R5)
 *
 * Replaces raw-diff input to Pass 1 reviewers with a structured "review packet".
 * A raw diff collapses context: the reviewer sees what changed but not what
 * surrounds the change. The packet adds:
 *
 *   1. File-level signatures + docstrings (no implementation bodies) for every
 *      function / class / interface / type in changed files — the mental model
 *      a senior reviewer would load before reading the diff
 *
 *   2. Secret redaction — strings matching common API-key, token, OAuth-client-
 *      secret, or credential-assignment patterns become `<REDACTED:type>`
 *
 *   3. Chunked diff — split into ≤8K-token segments on file boundaries so each
 *      chunk is internally coherent
 *
 * The reviewer receives `{ patterns_block, packet, raw_diff_chunked }` instead
 * of `{ patterns_block, raw_diff }`. The packet is the grounding document; the
 * chunked diff is the change document.
 *
 * Signature extraction is regex-based (matching SemanticCloneDetector's
 * approach). A real TypeScript AST would be more robust.
 *
 * Usage:
 *   import { generatePacket } from "./ReviewPacketGenerator.ts";
 *   const packet = await generatePacket({ sinceRef: "origin/main" });
 *
 * CLI:
 *   bun tools/ReviewPacketGenerator.ts --since origin/main
 *   bun tools/ReviewPacketGenerator.ts --since origin/main --json > packet.json
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

// ── Public types ────────────────────────────────────────────────────────────

export interface PacketFile {
  path: string;
  language: "typescript" | "javascript" | "python" | "go" | "rust" | "other";
  signatures: ExtractedSignature[];
  leading_imports: string[];
  redactions: number;
}

export interface ExtractedSignature {
  kind: "function" | "class" | "interface" | "type" | "method" | "const";
  name: string;
  signature: string;
  docstring?: string;
  line: number;
}

export interface ReviewPacket {
  files: PacketFile[];
  diff_chunks: string[];
  total_redactions: number;
  markdown: string;
}

// ── Language detection ──────────────────────────────────────────────────────

function detectLanguage(path: string): PacketFile["language"] {
  if (/\.tsx?$/.test(path)) return "typescript";
  if (/\.jsx?$/.test(path)) return "javascript";
  if (/\.py$/.test(path)) return "python";
  if (/\.go$/.test(path)) return "go";
  if (/\.rs$/.test(path)) return "rust";
  return "other";
}

// ── Secret redaction ────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: "openai-api-key", regex: /sk-[a-zA-Z0-9]{20,}/g, replacement: "<REDACTED:openai-api-key>" },
  { name: "anthropic-api-key", regex: /sk-ant-[a-zA-Z0-9_-]{30,}/g, replacement: "<REDACTED:anthropic-api-key>" },
  { name: "github-token", regex: /gh[ps]_[a-zA-Z0-9]{30,}/g, replacement: "<REDACTED:github-token>" },
  { name: "stripe-secret", regex: /sk_(live|test)_[a-zA-Z0-9]{20,}/g, replacement: "<REDACTED:stripe-secret>" },
  { name: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g, replacement: "<REDACTED:aws-access-key>" },
  { name: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/g, replacement: "<REDACTED:google-api-key>" },
  { name: "jwt-token", regex: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, replacement: "<REDACTED:jwt-token>" },
  { name: "literal-secret", regex: /(secret|password|token|api[_-]?key)['"]?\s*[:=]\s*['"][a-zA-Z0-9_-]{16,}['"]/gi, replacement: "$1=<REDACTED:literal-secret>" },
  { name: "bearer-token", regex: /Bearer\s+[a-zA-Z0-9_.-]{20,}/g, replacement: "Bearer <REDACTED:bearer-token>" },
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const { regex, replacement } of SECRET_PATTERNS) {
    out = out.replace(regex, () => { count++; return replacement; });
  }
  return { text: out, count };
}

// ── Signature extraction ────────────────────────────────────────────────────

const TS_PATTERNS = {
  function: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([a-zA-Z_$][\w$]*)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(:\s*[^{]+)?/,
  arrow: /^\s*(?:export\s+)?(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(:\s*[^=]+)?=>/,
  class: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z_$][\w$]*)\s*(?:<[^>]+>)?\s*(?:extends\s+[^{]+)?\s*(?:implements\s+[^{]+)?\s*\{/,
  interface: /^\s*(?:export\s+)?interface\s+([a-zA-Z_$][\w$]*)\s*(?:<[^>]+>)?\s*(?:extends\s+[^{]+)?\s*\{/,
  type: /^\s*(?:export\s+)?type\s+([a-zA-Z_$][\w$]*)\s*(?:<[^>]+>)?\s*=\s*(.+?)(;|$)/,
};

const PY_PATTERNS = {
  function: /^\s*(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(([^)]*)\)\s*(->\s*[^:]+)?:/,
  class: /^\s*class\s+([A-Z][\w]*)\s*(\([^)]*\))?\s*:/,
};

/**
 * Extract top-level signatures plus leading JSDoc/TSDoc/Python docstrings.
 * Returns signatures in source order without function bodies.
 */
export function extractSignatures(source: string, language: PacketFile["language"]): ExtractedSignature[] {
  const lines = source.split("\n");
  const out: ExtractedSignature[] = [];
  let pendingDocstring: string | null = null;
  let inJsDoc = false;
  let jsDocBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (language === "typescript" || language === "javascript") {
      if (line.trim().startsWith("/**")) {
        inJsDoc = true;
        jsDocBuffer = [line];
        continue;
      }
      if (inJsDoc) {
        jsDocBuffer.push(line);
        if (line.trim().endsWith("*/")) {
          inJsDoc = false;
          pendingDocstring = jsDocBuffer.join("\n");
        }
        continue;
      }
    }

    let matched: ExtractedSignature | null = null;

    if (language === "typescript" || language === "javascript") {
      const fn = line.match(TS_PATTERNS.function);
      if (fn) matched = { kind: "function", name: fn[1] ?? "", signature: trimRight(line, "{"), line: i + 1 };
      else {
        const arrow = line.match(TS_PATTERNS.arrow);
        if (arrow) matched = { kind: "function", name: arrow[1] ?? "", signature: trimRight(line, "=>"), line: i + 1 };
        else {
          const cls = line.match(TS_PATTERNS.class);
          if (cls) matched = { kind: "class", name: cls[1] ?? "", signature: trimRight(line, "{"), line: i + 1 };
          else {
            const iface = line.match(TS_PATTERNS.interface);
            if (iface) matched = { kind: "interface", name: iface[1] ?? "", signature: trimRight(line, "{"), line: i + 1 };
            else {
              const ty = line.match(TS_PATTERNS.type);
              if (ty) matched = { kind: "type", name: ty[1] ?? "", signature: line.trim(), line: i + 1 };
            }
          }
        }
      }
    } else if (language === "python") {
      const fn = line.match(PY_PATTERNS.function);
      if (fn) matched = { kind: "function", name: fn[1] ?? "", signature: trimRight(line, ":") + ":", line: i + 1 };
      else {
        const cls = line.match(PY_PATTERNS.class);
        if (cls) matched = { kind: "class", name: cls[1] ?? "", signature: trimRight(line, ":") + ":", line: i + 1 };
      }

      // Python docstring — triple-quoted string immediately inside the def/class
      if (matched && i + 1 < lines.length) {
        const next = (lines[i + 1] ?? "").trim();
        if (next.startsWith('"""') || next.startsWith("'''")) {
          const opener = next.slice(0, 3);
          if (next.length > 3 && next.endsWith(opener)) {
            matched.docstring = next;
          } else {
            const doc: string[] = [next];
            for (let j = i + 2; j < Math.min(lines.length, i + 30); j++) {
              const docLine = lines[j] ?? "";
              doc.push(docLine);
              if (docLine.includes(opener)) break;
            }
            matched.docstring = doc.join("\n");
          }
        }
      }
    }

    if (matched) {
      if (pendingDocstring) {
        matched.docstring = pendingDocstring;
        pendingDocstring = null;
      }
      out.push(matched);
    } else {
      // A docstring not attached to anything signature-shaped is dropped
      pendingDocstring = null;
    }
  }
  return out;
}

function trimRight(line: string, stopAt: string): string {
  const i = line.indexOf(stopAt);
  return (i >= 0 ? line.slice(0, i) : line).trim();
}

// ── Imports extraction ──────────────────────────────────────────────────────

export function extractImports(source: string, language: PacketFile["language"]): string[] {
  const lines = source.split("\n");
  const imports: string[] = [];
  for (const line of lines) {
    if (language === "typescript" || language === "javascript") {
      if (/^\s*import\s+/.test(line)) imports.push(line.trim());
    } else if (language === "python") {
      if (/^\s*(import|from)\s+/.test(line)) imports.push(line.trim());
    }
    // Stop at the first non-import, non-blank, non-comment line
    if (
      line.trim() &&
      !/^\s*(import|from|\/\/|\*|#|\/\*)/.test(line) &&
      imports.length > 0
    ) {
      break;
    }
  }
  return imports;
}

// ── Diff chunking ───────────────────────────────────────────────────────────

const TARGET_CHUNK_TOKENS = 8000;
const APPROX_CHARS_PER_TOKEN = 4;

export function chunkDiff(diff: string): string[] {
  const targetChars = TARGET_CHUNK_TOKENS * APPROX_CHARS_PER_TOKEN;
  if (diff.length <= targetChars) return [diff];

  const fileSections = diff.split(/(?=^diff --git )/m).filter((s) => s.trim());
  const chunks: string[] = [];
  let current = "";
  for (const section of fileSections) {
    if (current.length + section.length > targetChars && current) {
      chunks.push(current);
      current = section;
    } else {
      current += section;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── Main packet generator ───────────────────────────────────────────────────

export async function generatePacket(opts: {
  sinceRef?: string;
  cwd?: string;
}): Promise<ReviewPacket> {
  const sinceRef = opts.sinceRef ?? "origin/main";
  const cwd = opts.cwd ?? process.cwd();

  const changedFiles = execSync(`git diff --name-only ${sinceRef}...HEAD`, {
    cwd, encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && /\.(ts|tsx|js|jsx|py|go|rs)$/.test(f));

  const packetFiles: PacketFile[] = [];
  let totalRedactions = 0;

  for (const file of changedFiles) {
    let source: string;
    try {
      source = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue; // deleted file
    }
    const language = detectLanguage(file);
    const { text: redactedSource, count: rcount } = redactSecrets(source);
    totalRedactions += rcount;

    packetFiles.push({
      path: file,
      language,
      signatures: extractSignatures(redactedSource, language),
      leading_imports: extractImports(redactedSource, language),
      redactions: rcount,
    });
  }

  const fullDiff = execSync(`git diff ${sinceRef}...HEAD`, { cwd, encoding: "utf8" });
  const { text: redactedDiff } = redactSecrets(fullDiff);
  const diff_chunks = chunkDiff(redactedDiff);

  return {
    files: packetFiles,
    diff_chunks,
    total_redactions: totalRedactions,
    markdown: renderPacketMarkdown(packetFiles, diff_chunks.length, totalRedactions),
  };
}

// ── Render to markdown (the doc the reviewer agent receives) ────────────────

function renderPacketMarkdown(files: PacketFile[], chunkCount: number, redactions: number): string {
  const lines: string[] = [];
  lines.push("# Review Packet");
  lines.push("");
  lines.push(`**Files changed:** ${files.length}`);
  lines.push(`**Diff chunks:** ${chunkCount} (≤8K tokens each)`);
  lines.push(`**Secrets redacted:** ${redactions}`);
  lines.push("");
  lines.push("This packet provides the mental-model context for the changed files. Each section lists the file's leading imports + every top-level function/class/interface/type signature (no implementation bodies) + leading docstrings. Read this BEFORE the diff chunks — it tells you what the surrounding code does, which is invisible from the diff alone.");
  lines.push("");

  for (const f of files) {
    lines.push(`## ${f.path}`);
    lines.push(`*Language: ${f.language}* — *Redactions in this file: ${f.redactions}*`);
    lines.push("");

    if (f.leading_imports.length > 0) {
      lines.push("### Imports");
      lines.push("```");
      lines.push(...f.leading_imports);
      lines.push("```");
      lines.push("");
    }

    if (f.signatures.length === 0) {
      lines.push("*(No extractable top-level signatures — likely a config, fixture, or non-code file.)*");
      lines.push("");
      continue;
    }

    lines.push("### Signatures");
    lines.push("");
    for (const sig of f.signatures) {
      if (sig.docstring) {
        lines.push("```");
        lines.push(sig.docstring);
        lines.push("```");
      }
      lines.push(`- **${sig.kind} \`${sig.name}\`** — line ${sig.line}`);
      lines.push(`  \`\`\`${f.language === "python" ? "python" : "typescript"}`);
      lines.push(`  ${sig.signature}`);
      lines.push(`  \`\`\``);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("The actual diff chunks follow this packet. Use the signatures above to ground your understanding of what each function does in context — DO NOT enumerate findings against the diff alone.");
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun ReviewPacketGenerator.ts [--since <ref>] [--json]");
    process.exit(0);
  }
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : "origin/main";
  const asJson = args.includes("--json");

  const packet = await generatePacket({ sinceRef: since });
  if (asJson) {
    console.log(JSON.stringify(packet, null, 2));
  } else {
    console.log(packet.markdown);
    console.log("\n\n=== DIFF CHUNKS ===");
    for (let i = 0; i < packet.diff_chunks.length; i++) {
      const chunk = packet.diff_chunks[i] ?? "";
      console.log(`\n--- Chunk ${i + 1} / ${packet.diff_chunks.length} ---\n`);
      console.log(chunk.slice(0, 500) + (chunk.length > 500 ? "\n... [truncated for CLI preview]" : ""));
    }
  }
}
