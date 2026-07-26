/**
 * transcript-evidence.ts — turn the current turn's transcript into evidence.
 *
 * THE MESSAGE IS A CLAIM; THE TRANSCRIPT IS THE EVIDENCE. This module parses
 * the tool_use / tool_result entries of the current turn out of a Claude Code
 * transcript JSONL into an ordered event list, then answers one question per
 * claim type: did the verification that claim requires ACTUALLY RUN, after the
 * last change, and succeed?
 *
 * That framing is the whole design. Grading the message's own prose — looking
 * for the word "verified" — rewards wording and punishes terseness, which is
 * backwards on both counts: it blocks an honest short answer and passes a
 * confident wrong one.
 *
 * Every function here fails OPEN: an unreadable transcript, an unparseable
 * line, an unfamiliar schema all yield "no events", and no-events can only ever
 * contribute to allowing (see the act-then-claim precondition in the caller).
 */

import { readFileSync, existsSync } from 'node:fs';

export type EventKind =
  | 'edit'
  | 'deploy'
  | 'probe' // curl/httpie/WebFetch, or a browser read (console, network, eval)
  | 'browser-nav'
  | 'browser-interact'
  | 'browser-capture'
  | 'test-run'
  | 'read-image' // the model actually looked at a pixel image
  | 'agent-result';

export interface TxEvent {
  seq: number;
  kind: EventKind;
  tool: string;
  target: string;
  resultText: string;
  isError: boolean;
  isCode: boolean;
}

const CAP_BYTES = 8 * 1024 * 1024;

function safeRead(path: string | undefined): string | null {
  try {
    if (!path || !existsSync(path)) return null;
    const buf = readFileSync(path);
    // Only the tail matters; recent events are the turn.
    return (buf.length > CAP_BYTES ? buf.subarray(buf.length - CAP_BYTES) : buf).toString('utf-8');
  } catch {
    return null;
  }
}

function eTLD1(host: string): string {
  const parts = host.replace(/^https?:\/\//, '').split('/')[0]!.split(':')[0]!.split('.');
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

function extractHost(text: string): string {
  const m = text.match(/https?:\/\/([^\s"'/]+)/i);
  return m ? eTLD1(m[1]!) : '';
}

const DEPLOY_RE =
  /\b(wrangler(@\S+)?\s+(pages\s+)?deploy|(npm|bun|pnpm|yarn)\s+run\s+deploy|vercel\s+(deploy|--prod)|netlify\s+deploy|fly\s+deploy|gcloud\s+app\s+deploy|kubectl\s+apply)\b/i;
const TEST_RE =
  /\b(bun\s+test|pytest|go\s+test|cargo\s+test|vitest|(npm|pnpm|yarn)\s+(run\s+)?test|jest|deno\s+test|rspec|phpunit)\b/i;
const PROBE_RE = /\bcurl\b|\bhttpie\b|\bhttp\s+(GET|POST|PUT|HEAD)\b/i;
const IMG_RE = /\.(png|jpe?g|webp|gif)\b/i;

// Browser drivers reachable from a shell. Deliberately tool-agnostic: what
// matters is that a real browser was driven, not which harness drove it.
const BROWSER_CLI_RE = /\b(playwright|puppeteer|cypress|chromedriver|selenium|chrome-devtools)\b/i;
const NAV_RE = /\b(open|navigate|goto|visit)\b/i;
const INTERACT_RE = /\b(click|type|fill|submit|press|select|tap)\b/i;
const CAPTURE_RE = /\b(screenshot|capture|snapshot)\b/i;

/**
 * Browser MCP tool names map to event kinds directly — the tool name IS the
 * action, so no command parsing is needed or wanted.
 */
function browserToolKind(name: string): EventKind | null {
  const bare = name.replace(/^mcp__[^_]*(?:_[^_]+)*?__/, '').toLowerCase();
  if (/^(navigate_page|new_page|select_page)$/.test(bare)) return 'browser-nav';
  if (/^(click|fill|fill_form|hover|drag|press_key|type_text|upload_file|handle_dialog)$/.test(bare))
    return 'browser-interact';
  if (/^(take_screenshot|take_snapshot)$/.test(bare)) return 'browser-capture';
  if (/^(evaluate_script|list_console_messages|list_network_requests|get_network_request|get_console_message)$/.test(bare))
    return 'probe';
  return null;
}

// A 4xx/5xx STATUS LINE or an explicit failure phrase — NOT a bare "500",
// which matches "500.42 KiB" in ordinary build output and produced a stream of
// false errors, and not a bare "error", which appears in deprecation notices.
const ERROR_MARKERS =
  /\bHTTP[/ ]?\d(\.\d)?\s+[45]\d\d\b|\b(internal server error|traceback|connection refused|timed out|command not found|permission denied)\b|"?is_error"?\s*[:=]\s*true|\bexit\s+(code\s+)?[1-9]\d*\b/i;
// A real 2xx/3xx status line or session marker — not a bare number like
// "250 records", which is not a round trip.
const HTTP_SUCCESS = /\bHTTP[/ ]?\d(\.\d)?\s+[23]\d\d\b|set-cookie|location:\s*\//i;

/** True when result text shows a suite that actually passed. */
export function testResultPassed(text: string): boolean {
  const failed = text.match(/\b(\d+)\s+fail/i);
  if (failed && Number(failed[1]) > 0) return false;
  if (/\b0\s+pass\b/i.test(text)) return false;
  return (
    /\b([1-9]\d*)\s+pass\b/i.test(text) ||
    /\bexit(\s+code)?\s+0\b/i.test(text) ||
    /\ball\s+(tests?\s+)?(pass|green)/i.test(text)
  );
}

interface RawEntry {
  type?: string;
  role?: string;
  message?: { role?: string; content?: unknown };
  content?: unknown;
}

interface Block {
  type?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  text?: string;
}

/**
 * Parse the CURRENT TURN — everything after the last real user message — into
 * an ordered event list. Returns [] on any failure; the caller fails open.
 */
export function parseTurnEvents(transcriptPath: string | undefined): TxEvent[] {
  const raw = safeRead(transcriptPath);
  if (!raw) return [];

  const results = new Map<string, { text: string; isError: boolean }>();
  const parsed: RawEntry[] = [];

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || (!t.includes('tool_use') && !t.includes('tool_result') && !t.includes('"user"') && !t.includes('"human"')))
      continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(t) as RawEntry;
    } catch {
      continue;
    }
    parsed.push(entry);

    const content = entry.message?.content ?? entry.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
      const text =
        typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? (b.content as Block[]).map((c) => c?.text ?? '').join(' ')
            : '';
      results.set(b.tool_use_id, { text: String(text).slice(0, 4000), isError: b.is_error === true });
    }
  }

  // Turn boundary: the last user message carrying real text. A user entry that
  // only ferries tool_results is not a new turn.
  let turnStart = 0;
  for (let k = parsed.length - 1; k >= 0; k--) {
    const e = parsed[k]!;
    const role = e.role ?? e.message?.role ?? e.type;
    if (role !== 'user' && role !== 'human') continue;
    const content = e.message?.content ?? e.content;
    const onlyToolResults = Array.isArray(content) && (content as Block[]).every((b) => b?.type === 'tool_result');
    const hasText =
      typeof content === 'string'
        ? content.trim().length > 0
        : Array.isArray(content) && (content as Block[]).some((b) => b?.type === 'text' && b.text?.trim());
    if (!onlyToolResults && hasText) {
      turnStart = k;
      break;
    }
  }

  const events: TxEvent[] = [];
  let seq = 0;
  for (let k = turnStart; k < parsed.length; k++) {
    const content = parsed[k]!.message?.content ?? parsed[k]!.content;
    if (!Array.isArray(content)) continue;

    for (const b of content as Block[]) {
      if (b?.type !== 'tool_use') continue;
      const name = String(b.name ?? '');
      const input = b.input ?? {};
      const res = b.id ? results.get(b.id) : undefined;
      const resultText = res?.text ?? '';
      const isError = res?.isError === true || (resultText ? ERROR_MARKERS.test(resultText) : false);
      const push = (kind: EventKind, target: string, isCode = false) =>
        events.push({ seq: seq++, kind, tool: name, target, resultText, isError, isCode });

      const mcpKind = browserToolKind(name);
      if (mcpKind) {
        push(mcpKind, extractHost(JSON.stringify(input)));
        continue;
      }

      if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
        const p = String(input.file_path ?? input.notebook_path ?? '');
        // Docs are not code. Editing a README then claiming a deploy works is
        // still an unverified claim, but it is not a code mutation.
        push('edit', p, !!p && !/\.(md|markdown|txt|rst)$/i.test(p));
      } else if (name === 'Bash') {
        const cmd = String(input.command ?? '');
        if (DEPLOY_RE.test(cmd)) push('deploy', extractHost(cmd));
        else if (BROWSER_CLI_RE.test(cmd)) {
          // Capture-first: `screenshot --out navigate.png` is a capture, not a
          // navigation, however the filename reads.
          if (CAPTURE_RE.test(cmd)) push('browser-capture', extractHost(cmd));
          else if (INTERACT_RE.test(cmd)) push('browser-interact', extractHost(cmd));
          else push('browser-nav', extractHost(cmd));
        } else if (TEST_RE.test(cmd) && !/--dry-run/.test(cmd)) push('test-run', cmd.slice(0, 120));
        else if (PROBE_RE.test(cmd)) push('probe', extractHost(cmd));
      } else if (name === 'WebFetch') {
        push('probe', eTLD1(String(input.url ?? '')));
      } else if (name === 'Read') {
        const p = String(input.file_path ?? '');
        if (IMG_RE.test(p)) push('read-image', p);
      } else if (name === 'Agent' || name === 'Task') {
        push('agent-result', String(input.description ?? name));
      }
    }
  }
  return events;
}

// ── Query API ─────────────────────────────────────────────────────────────

export function lastMutationSeq(ev: TxEvent[]): number {
  let s = -1;
  for (const e of ev) if ((e.kind === 'edit' && e.isCode) || e.kind === 'deploy') s = Math.max(s, e.seq);
  return s;
}

export const hadDeploy = (ev: TxEvent[]): boolean => ev.some((e) => e.kind === 'deploy');
export const hadCodeEdit = (ev: TxEvent[]): boolean => ev.some((e) => e.kind === 'edit' && e.isCode);
export const spawnedAgent = (ev: TxEvent[]): boolean => ev.some((e) => e.kind === 'agent-result');

export const hadFrontendEdit = (ev: TxEvent[]): boolean =>
  ev.some((e) => e.kind === 'edit' && /\.(tsx|jsx|vue|svelte|css|scss|html|astro|png|svg|webp)$/i.test(e.target));

/** Edits to auth/checkout-adjacent files — lets a terse "verified" be typed as
 *  a FLOW claim from what the session actually touched, not from its wording. */
export const hadFlowEdit = (ev: TxEvent[]): boolean =>
  ev.some(
    (e) =>
      e.kind === 'edit' &&
      e.isCode &&
      /(auth|login|oauth|sign[\s-]?in|signup|callback|session|checkout|payment|billing)/i.test(e.target),
  );

/** A probe or navigation of the deployed thing AFTER the last deploy. */
export function probedAfterDeploy(ev: TxEvent[]): boolean {
  const deploys = ev.filter((e) => e.kind === 'deploy').map((e) => e.seq);
  if (deploys.length === 0) return false;
  // Anchor on the LAST deploy, so a re-deploy is not credited by an earlier probe.
  const after = Math.max(...deploys);
  return ev.some(
    (e) =>
      e.seq > after &&
      !e.isError &&
      (e.kind === 'probe' || e.kind === 'browser-nav' || e.kind === 'browser-capture'),
  );
}

/**
 * The flow was EXERCISED, not merely rendered. A lone screenshot proves a page
 * painted; it says nothing about whether submitting the form works. That exact
 * gap shipped a login page whose callback returned 500 — the screenshot of the
 * button was real, and the flow was broken.
 */
export function flowExercised(ev: TxEvent[]): boolean {
  const post = ev.filter((e) => e.seq > lastMutationSeq(ev));
  const interacted = post.some((e) => e.kind === 'browser-interact' && !e.isError);
  const navved = post.some((e) => (e.kind === 'browser-nav' || e.kind === 'browser-capture') && !e.isError);
  if (interacted && navved) return true;
  return post.some(
    (e) => (e.kind === 'probe' || e.kind === 'browser-nav') && !e.isError && HTTP_SUCCESS.test(e.resultText),
  );
}

/** An image was captured AND read after the last frontend change. A DOM read
 *  proves an element exists; only a viewed pixel proves it LOOKS right. */
export function pixelViewed(ev: TxEvent[]): boolean {
  const after = lastMutationSeq(ev);
  return (
    ev.some((e) => e.seq > after && e.kind === 'browser-capture' && !e.isError) &&
    ev.some((e) => e.seq > after && e.kind === 'read-image')
  );
}

/** A test ran after the last code edit and its output shows a pass. */
export function testPassedAfterEdit(ev: TxEvent[]): boolean {
  const after = lastMutationSeq(ev);
  return ev.some((e) => e.seq > after && e.kind === 'test-run' && !e.isError && testResultPassed(e.resultText));
}
