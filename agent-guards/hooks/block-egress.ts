#!/usr/bin/env bun
/**
 * block-egress.ts — PreToolUse hook on Bash
 *
 * WHAT IT BLOCKS — two things, both unambiguous:
 *   1. A credential-shaped literal in the same command as an outbound tool
 *      (curl, wget, nc, ncat, socat, httpie). Sending a key somewhere is the
 *      one shape of exfiltration that a shell command makes fully visible.
 *   2. A download piped straight into a shell interpreter: `curl … | bash`.
 *
 * WHAT IT ALLOWS
 *   Every other command, untouched. A curl with no credential in it, a
 *   credential in a command that sends nothing anywhere, `curl … -o file`,
 *   piping into jq or grep — none of these match. The two rules are
 *   conjunctions on purpose: each half alone is ordinary work.
 *
 * WHAT IT DELIBERATELY LEFT OUT
 *   The version this came from also had a warning tier — python -c, node -e,
 *   netcat, `env`, POST-shaped curls — that fired on ordinary development
 *   dozens of times a day. A warning you see that often is one you stop
 *   reading, and it takes the real ones down with it. Two rules that almost
 *   never fire falsely beat twelve that constantly do.
 *
 * THE FAILURE THAT MOTIVATED IT
 *   `curl … | bash` executes whatever the server decides to return, at that
 *   moment, with your privileges — you cannot review it, and the thing you
 *   inspected in a browser is not necessarily the thing it serves your shell.
 *   The credential rule covers the other direction: a key pasted into an
 *   outbound request leaves your machine before anyone reads the diff.
 *
 * FAIL-OPEN ON OUR OWN BUGS, FAIL-CLOSED ON THE QUESTION ASKED
 *   Internal crash: allow. A matched pattern: block, with no probably-fine path.
 *
 * BYPASS (announced on stderr, never silent)
 *   AGENT_GUARDS_EGRESS=0, or the inline token [skip-egress].
 *   For an installer specifically, the better move is to download it, read it,
 *   then run it — which needs no bypass at all.
 */

import { announceBypass, block, bypassReason, commandOf, readStdinJson } from './lib/shared.ts';

const SLUG = 'egress';

const OUTBOUND = /\b(curl|wget|nc|ncat|socat|http|https|httpie)\b/i;

// Prefixes that identify a live credential by shape. Kept to formats whose
// prefix is unambiguous — a generic /[a-z0-9]{32}/ would match a git SHA, a
// content hash, and half the identifiers in a normal codebase.
const CREDENTIALS: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/, 'Anthropic API key'],
  [/\bsk-proj-[A-Za-z0-9_-]{8,}/, 'OpenAI project key'],
  [/\bsk_live_[A-Za-z0-9]{8,}/, 'Stripe live key'],
  [/\bsk_test_[A-Za-z0-9]{8,}/, 'Stripe test key'],
  [/\bwhsec_[A-Za-z0-9]{8,}/, 'webhook signing secret'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key material'],
];

const PIPE_TO_SHELL = /\|\s*(sudo\s+)?(sh|bash|zsh|fish|python3?|node|ruby|perl)\b/i;
const DOWNLOADER = /\b(curl|wget|fetch)\b/i;

export type EgressVerdict =
  | { action: 'allow' }
  | { action: 'block'; rule: 'credential'; label: string }
  | { action: 'block'; rule: 'pipe-to-shell' };

/**
 * Pure: does this command match either blocking shape? No bypass check, no
 * exit — just the regex judgement, so it can be unit-tested directly without
 * risking a call to block()'s process.exit. Mirrors main()'s original order:
 * credential-in-outbound-command is checked first, first match wins.
 */
export function evaluateEgress(cmd: string): EgressVerdict {
  if (OUTBOUND.test(cmd)) {
    for (const [re, label] of CREDENTIALS) {
      if (re.test(cmd)) return { action: 'block', rule: 'credential', label };
    }
  }
  if (DOWNLOADER.test(cmd) && PIPE_TO_SHELL.test(cmd)) return { action: 'block', rule: 'pipe-to-shell' };
  return { action: 'allow' };
}

/** `raw`, when passed, is forwarded to readStdinJson instead of real stdin —
 *  the same test-only seam readStdinJson itself exposes. Every production
 *  call site (below) omits it. */
export function main(raw?: string): void {
  const input = readStdinJson(raw);
  if (!input || input.tool_name !== 'Bash') return;
  const cmd = commandOf(input);
  if (!cmd) return;

  const verdict = evaluateEgress(cmd);
  if (verdict.action === 'allow') return;

  if (verdict.rule === 'credential') {
    const why = bypassReason(SLUG, cmd);
    if (why) return announceBypass(SLUG, why, `${verdict.label} in an outbound command`);

    block(SLUG, [
      `matched: a ${verdict.label} in a command that sends data somewhere`,
      '',
      'A credential in an outbound request has left the machine before anyone',
      'reviews it, and rotating it afterwards does not un-send it.',
      '',
      'Pass it by environment variable instead, so the value never appears in a',
      'command line, a shell history, or a transcript.',
      '',
      'Bypass: AGENT_GUARDS_EGRESS=0, or put [skip-egress] in the command.',
    ]);
  } else {
    const why = bypassReason(SLUG, cmd);
    if (why) return announceBypass(SLUG, why, 'download piped to an interpreter');

    block(SLUG, [
      'matched: downloaded content piped straight into an interpreter',
      '',
      'This runs whatever the server returns at that moment, with your',
      'privileges, unreviewed — and what it serves a shell need not be what it',
      'served your browser.',
      '',
      'Download it, read it, then run it:',
      '  curl -fsSL <url> -o /tmp/install.sh',
      '  less /tmp/install.sh',
      '  bash /tmp/install.sh',
      '',
      'Bypass: AGENT_GUARDS_EGRESS=0, or put [skip-egress] in the command.',
    ]);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch {
    // Fail-open on our OWN bugs; block() exits before reaching here.
  }
  process.exit(0);
}
