#!/usr/bin/env bun
/**
 * block-leaks.ts — PreToolUse hook on Write / Edit / MultiEdit / NotebookEdit
 *
 * WHAT IT BLOCKS
 *   A write whose incoming content contains a string you have declared must
 *   never leave your private tree — into a file that is not in a declared safe
 *   zone. You supply the strings; this ships with none.
 *
 * WHAT IT ALLOWS
 *   Everything, until you create a `.agent-guards-forbidden` file. With no
 *   config the guard is inert by design: a leak guard with a default list is a
 *   leak guard configured for somebody else's secrets. Writes INTO a declared
 *   safe zone always pass — that is where the real strings are supposed to live.
 *
 * THE FAILURE THAT MOTIVATED IT
 *   Public repositories extracted from private work leak by paraphrase, not by
 *   theft. Nobody pastes a credential. What happens is that an example gets its
 *   realism from a real hostname, an error message keeps the internal service
 *   name that produced it, a path in a comment still has a username in it — each
 *   one individually defensible, and collectively a map of your infrastructure.
 *   Review catches it in the file you are looking at, which is never the file it
 *   is in. A deterministic check on every write is the only version that scales.
 *
 * CONFIG — `.agent-guards-forbidden`, found by walking up from the target file
 *   (override the filename with AGENT_GUARDS_FORBIDDEN_FILE=/abs/path):
 *
 *     # literal substring, case-sensitive
 *     internal-service-name
 *     # /regex/flags for anything shaped
 *     /acct_[0-9a-f]{32}/i
 *     # allow: <glob> — paths where these strings are legitimate
 *     allow: private/**
 *     allow: notes/*.local.md
 *
 *   Note when editing this header: a glob containing a star immediately before
 *   a slash ends the block comment. That mistake shipped once here and took the
 *   whole guard offline — the file could not parse, so every write "passed".
 *
 * FAIL-OPEN ON OUR OWN BUGS, FAIL-CLOSED ON THE QUESTION ASKED
 *   No config file, an unreadable payload, an internal crash: allow. That is
 *   "the guard is not configured" or "the guard is broken" — neither is evidence
 *   of a leak. But a config file that EXISTS and cannot be fully parsed BLOCKS:
 *   a pattern that will not compile is a pattern that was not scanned for, and
 *   "I could not check" must never read the same as "I checked and it is clean".
 *   That distinction is the entire difference between a guard and a decoration.
 *
 * KNOWN SCOPE LIMITS (deliberate, documented rather than silently absent)
 *   - Only the INCOMING content is scanned, not the resulting whole file. An
 *     Edit that leaves a forbidden string already present in the file untouched
 *     is not a new leak, so it is not this hook's event.
 *   - Content written by a shell heredoc, `cp`, or a script is invisible here —
 *     this is a tool-call hook, not a filesystem watcher.
 *
 * BYPASS (announced on stderr, never silent)
 *   AGENT_GUARDS_LEAKS=0. There is no inline token: the content being written
 *   is the thing under inspection, so a token inside it would be a bypass an
 *   agent could talk itself into using.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { announceBypass, block, bypassReason, readStdinJson, runHook, type HookInput } from './lib/shared.ts';

const SLUG = 'leaks';
const CONFIG_NAME = '.agent-guards-forbidden';
const MAX_WALK = 40;

export interface Config {
  path: string;
  patterns: { source: string; re: RegExp }[];
  allowGlobs: string[];
  /** A pattern we could not compile. Its presence forces a block. */
  broken: string | null;
}

export function findConfig(startDir: string): string | null {
  const override = process.env.AGENT_GUARDS_FORBIDDEN_FILE;
  if (override) return existsSync(override) ? override : null;

  let dir = startDir;
  for (let i = 0; i < MAX_WALK; i++) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function literalToRegExp(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

export function parseConfig(path: string): Config {
  const cfg: Config = { path, patterns: [], allowGlobs: [], broken: null };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    // The file exists but will not open. We cannot check, so we must not pass.
    cfg.broken = '<unreadable config file>';
    return cfg;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('allow:')) {
      const glob = trimmed.slice('allow:'.length).trim();
      if (glob) cfg.allowGlobs.push(glob);
      continue;
    }

    const asRegex = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
    try {
      cfg.patterns.push({
        source: trimmed,
        re: asRegex ? new RegExp(asRegex[1]!, asRegex[2]) : literalToRegExp(trimmed),
      });
    } catch {
      cfg.broken = trimmed;
      return cfg;
    }
  }
  return cfg;
}

/**
 * Minimal glob: `**` spans separators, `*` and `?` do not. A trailing slash
 * means "this directory and everything under it", which is what people write.
 *
 * ONE pass with a callback, deliberately. The obvious implementation chains
 * .replace() calls and needs a placeholder to hold `**` while `*` is being
 * rewritten — and every placeholder is either a character that could appear in
 * the input, or a control byte that makes this file read as BINARY to grep and
 * every other text tool. That second failure is not theoretical: it happened
 * here, and it silently excluded this file from text sweeps. A single pass has
 * nothing to hide behind, so it needs no placeholder at all.
 */
export function globToRegExp(glob: string): RegExp {
  const body = (glob.endsWith('/') ? `${glob}**` : glob).replace(
    /\*\*|[*?.+^${}()|[\]\\]/g,
    (match) => {
      if (match === '**') return '.*';
      if (match === '*') return '[^/]*';
      if (match === '?') return '[^/]';
      return `\\${match}`;
    },
  );
  return new RegExp(`^${body}$`);
}

export function inSafeZone(filePath: string, cfg: Config): boolean {
  const rel = relative(dirname(cfg.path), resolve(filePath)).split(sep).join('/');
  // Outside the config's own directory tree — not a zone this config governs.
  if (rel.startsWith('../')) return true;
  for (const glob of cfg.allowGlobs) {
    try {
      if (globToRegExp(glob).test(rel)) return true;
    } catch {
      // A malformed allow glob must not silently WIDEN the safe zone.
      continue;
    }
  }
  return false;
}

export interface Target {
  filePath: string;
  content: string;
  label: string;
}

export function extractTargets(tool: string, input: Record<string, unknown>): Target[] {
  const filePath =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.notebook_path === 'string' && input.notebook_path) ||
    '';
  if (!filePath) return [];

  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  if (tool === 'Write') return [{ filePath, content: str(input.content), label: 'content' }];
  if (tool === 'Edit') return [{ filePath, content: str(input.new_string), label: 'new_string' }];
  if (tool === 'NotebookEdit') return [{ filePath, content: str(input.new_source), label: 'new_source' }];
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return edits.flatMap((edit, i) =>
      edit && typeof edit === 'object'
        ? [{ filePath, content: str((edit as Record<string, unknown>).new_string), label: `edits[${i}].new_string` }]
        : [],
    );
  }
  return [];
}

/** `raw`, when passed, is forwarded to readStdinJson instead of real stdin —
 *  the same test-only seam readStdinJson itself exposes. Every production
 *  call site (below) omits it. */
export function main(raw?: string): void {
  const input: HookInput | null = readStdinJson(raw);
  if (!input) return;

  const tool = input.tool_name ?? '';
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return;
  if (!input.tool_input || typeof input.tool_input !== 'object') return;

  const targets = extractTargets(tool, input.tool_input);
  if (targets.length === 0) return;

  // An explicitly-named config that does not exist is NOT "unconfigured". Before
  // this check, AGENT_GUARDS_FORBIDDEN_FILE=/typo silently turned the guard off
  // entirely — exit 0, nothing on stderr, indistinguishable from a clean scan.
  // That is both halves of this package's own contract broken at once: "I could
  // not check" must never read as "I checked and it is clean", and every escape
  // hatch must announce itself. A path you named and I cannot open is an error.
  const override = process.env.AGENT_GUARDS_FORBIDDEN_FILE;
  if (override && !existsSync(override)) {
    const why = bypassReason(SLUG);
    if (why) return announceBypass(SLUG, why, `missing config ${override}`);
    block(SLUG, [
      `AGENT_GUARDS_FORBIDDEN_FILE: ${override}`,
      'no such file',
      '',
      'This variable names the config that declares what must not leak. It points',
      'at a path that does not exist, so the scan did not run. Refusing the write',
      'rather than passing it, for the same reason an unparseable config refuses:',
      '"I could not check" is not "it is clean".',
      '',
      'Fix the path, or unset the variable to fall back to the normal walk-up.',
      '',
      'Bypass: AGENT_GUARDS_LEAKS=0',
    ]);
  }

  const configPath = findConfig(dirname(resolve(targets[0]!.filePath)));
  if (!configPath) return; // Not configured — nothing declared secret, nothing to protect.

  const cfg = parseConfig(configPath);

  if (cfg.broken !== null) {
    const why = bypassReason(SLUG);
    if (why) return announceBypass(SLUG, why, `unparseable config ${configPath}`);
    block(SLUG, [
      `config: ${configPath}`,
      `unparseable entry: ${cfg.broken}`,
      '',
      'This config declares strings that must not leak, and one of its entries',
      'could not be compiled — so the scan did not actually run. "I could not',
      'check" is not "it is clean", so this write is refused rather than passed.',
      '',
      'Fix the entry (or delete it) and retry.',
      '',
      'Bypass: AGENT_GUARDS_LEAKS=0',
    ]);
  }

  if (cfg.patterns.length === 0) return;

  for (const target of targets) {
    if (inSafeZone(target.filePath, cfg)) continue;
    for (const pattern of cfg.patterns) {
      const hit = target.content.match(pattern.re);
      if (!hit) continue;

      const why = bypassReason(SLUG);
      if (why) return announceBypass(SLUG, why, `${pattern.source} → ${target.filePath}`);

      block(SLUG, [
        `file    : ${target.filePath} (${target.label})`,
        `pattern : ${pattern.source}`,
        `config  : ${configPath}`,
        '',
        'This write puts a string you declared private into a file outside every',
        'declared safe zone. Rewrite the content, read the value from an',
        'environment variable, or move the file into a safe zone.',
        '',
        'Bypass: AGENT_GUARDS_LEAKS=0',
      ]);
    }
  }
}

// Fail-open on our OWN bugs; block() exits before reaching here.
if (import.meta.main) runHook(SLUG, main);
