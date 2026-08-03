#!/usr/bin/env bun
/**
 * mark-review.ts — Stop hook (pairs with gate-pr.ts)
 *
 * After each turn, checks whether THIS session's own transcript shows a
 * real review: several distinct sub-agent dispatches, each tagged
 * `Crucible-Reviewer: <name>` in its prompt, timestamped at or after the
 * current commit. When it finds enough of them (MIN_ROSTER, see
 * lib/shared.ts), it writes a marker recording that a review happened for
 * this exact branch+commit. gate-pr.ts refuses `gh pr create` unless a
 * matching marker exists.
 *
 * This only ever reads transcript files Claude Code itself writes for this
 * session — the main transcript at `transcript_path`, and any
 * `subagents/*.jsonl` files next to it. It never reads a private log, and
 * the reviewing agent can't just write its own passing marker — that would
 * be self-attestation, which defeats the point of a gate.
 *
 * FAIL-OPEN AS A WRITER: any internal error here means no marker gets
 * written, which leaves the gate closed (see gate-pr.ts's "fail-closed on
 * the review question" note). That's the safe direction for a writer to
 * fail in — it can never cause a false "review happened."
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  getRepoContext,
  headCommitTime,
  isDefaultBranch,
  markerPath,
  readStdinJson,
  MIN_ROSTER,
  MIN_SUBAGENT_TOOL_CALLS,
  SENTINEL_FILE,
  TAG_RE,
  WRITTEN_BY,
} from './lib/shared.ts';

// Sub-agent dispatch tool name(s) to scan for. Claude Code's own tool for
// launching a sub-agent is "Task"; some harnesses/SDKs built on Claude Code
// name it "Agent" instead (the Crucible skill's own workflow docs refer to
// dispatches as "Agent() calls"). Add another name here if yours differs.
const DISPATCH_TOOL_NAMES = new Set(['Task', 'Agent']);

interface StopInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

try {
  main();
} catch {
  // Fail-open as a writer: swallow any error, write nothing, exit clean.
  process.exit(0);
}

function main(): void {
  const input = readStdinJson<StopInput>();
  const cwd = input.cwd?.trim() || process.cwd();

  const ctx = getRepoContext(cwd);
  if (!ctx) return; // not a GitHub-hosted git repo — nothing to mark
  if (isDefaultBranch(ctx.branch)) return; // no PR gets made off main/master itself
  if (existsSync(join(ctx.toplevel, SENTINEL_FILE))) return;

  const headTime = headCommitTime(cwd);
  if (headTime === null) return;

  const roster = new Set<string>();
  collectFromMainTranscript(input.transcript_path, headTime, roster);
  collectFromSubagentTranscripts(input.transcript_path, ctx.sha, headTime, roster);

  if (roster.size < MIN_ROSTER) return; // no genuine review found — leave the gate blocked

  mkdirSync(ctx.stateDir, { recursive: true });
  writeFileSync(
    markerPath(ctx.stateDir, ctx.branch, ctx.sha),
    JSON.stringify(
      {
        branch: ctx.branch,
        sha: ctx.sha,
        roster: [...roster].sort(),
        roster_count: roster.size,
        head_commit_time: new Date(headTime).toISOString(),
        written_by: WRITTEN_BY,
        written_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * One transcript's parseable JSONL lines, each paired with the message object it
 * carries — some harnesses nest it under `message`, others write the fields on
 * the line itself, and every scan below has to accept both. Unreadable file,
 * blank lines and unparseable lines all yield nothing rather than throwing: a
 * writer that cannot read its evidence must write no marker, never crash the
 * hook (see the FAIL-OPEN AS A WRITER note at the top).
 */
function transcriptEntries(path: string): Array<{ entry: Record<string, unknown>; message: Record<string, unknown> }> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries: Array<{ entry: Record<string, unknown>; message: Record<string, unknown> }> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    entries.push({ entry, message: (entry.message as Record<string, unknown> | undefined) ?? entry });
  }
  return entries;
}

/** A message's content blocks, or none when it carries text or nothing at all. */
function contentBlocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = message.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

/** Scan this session's main transcript for tagged dispatches at/after headTime. */
function collectFromMainTranscript(transcriptPath: string | undefined, headTime: number, roster: Set<string>): void {
  if (!transcriptPath || !existsSync(transcriptPath)) return;
  for (const { entry, message } of transcriptEntries(transcriptPath)) {
    // Every transcript line carries its own timestamp — require it to
    // postdate the reviewed commit, so a stale review from before the last
    // push can never satisfy the NEW commit's marker.
    const ts = Date.parse(String(entry.timestamp ?? ''));
    if (!Number.isFinite(ts) || ts < headTime) continue;

    for (const block of contentBlocks(message)) {
      if (block?.type !== 'tool_use') continue;
      if (!DISPATCH_TOOL_NAMES.has(String(block.name ?? ''))) continue;
      addTags(JSON.stringify(block.input ?? ''), roster);
    }
  }
}

/**
 * Fallback: a review that runs entirely inside one sub-agent (fanning out
 * to reviewers internally, rather than each reviewer being its own
 * top-level dispatch) leaves no per-lens Task calls in the main transcript
 * — but Claude Code still writes that sub-agent's own transcript under
 * `subagents/` next to the main one. Scan those too, gated on file mtime (a
 * coarser but still real freshness check) and a requirement that the
 * sub-agent's output actually names the commit it reviewed.
 */
function collectFromSubagentTranscripts(
  transcriptPath: string | undefined,
  headSha: string,
  headTime: number,
  roster: Set<string>,
): void {
  if (!transcriptPath) return;
  const subDir = join(dirname(transcriptPath), 'subagents');
  if (!existsSync(subDir)) return;
  let files: string[];
  try {
    files = readdirSync(subDir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const p = join(subDir, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.mtimeMs < headTime) continue; // predates the reviewed commit
    if (st.size > 16 * 1024 * 1024) continue; // skip pathological files
    let text: string;
    try {
      text = assistantText(p);
    } catch {
      continue;
    }
    if (!text.includes(headSha)) continue; // must actually reference this commit
    // Prose alone is not evidence. A transcript whose assistant text names the
    // lenses but which never called a tool did not review anything — it wrote
    // about reviewing. Require the file to show real work before believing its
    // claims. This does not make forgery impossible (a run that reads files and
    // then writes the tags still qualifies); it removes the cheap path, where
    // emitting N lines of text is sufficient. See hooks/README.md § Limits.
    if (toolUseCount(p) < MIN_SUBAGENT_TOOL_CALLS) continue;
    addTags(text, roster);
  }
}

/** Number of tool_use blocks in a transcript — evidence the agent did work. */
function toolUseCount(path: string): number {
  let n = 0;
  for (const { message } of transcriptEntries(path)) {
    for (const block of contentBlocks(message)) {
      if (block?.type === 'tool_use') n++;
    }
  }
  return n;
}

/** Concatenate the assistant-authored text out of a transcript JSONL file. */
function assistantText(path: string): string {
  const parts: string[] = [];
  for (const { entry, message } of transcriptEntries(path)) {
    const role = (message.role as string | undefined) ?? (entry.type as string | undefined);
    if (role !== 'assistant') continue;
    const content = message.content;
    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }
    for (const block of contentBlocks(message)) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function addTags(text: string, roster: Set<string>): void {
  for (const m of text.matchAll(TAG_RE)) {
    const lens = m[1];
    if (lens) roster.add(lens.toLowerCase());
  }
}
