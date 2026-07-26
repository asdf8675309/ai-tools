/**
 * transcript-evidence.test.ts — in-process unit tests for
 * hooks/lib/transcript-evidence.ts, the "the transcript is the evidence"
 * parser block-unverified-claim.ts is built on.
 *
 * Every test builds a synthetic transcript JSONL (the same shape a real
 * Claude Code transcript has: assistant tool_use entries paired with user
 * tool_result entries) and asserts on the parsed event list or a query
 * function's verdict — never on "it didn't throw".
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  flowExercised,
  hadCodeEdit,
  hadDeploy,
  hadFlowEdit,
  hadFrontendEdit,
  lastMutationSeq,
  parseTurnEvents,
  pixelViewed,
  probedAfterDeploy,
  spawnedAgent,
  testPassedAfterEdit,
  testResultPassed,
  type TxEvent,
} from '../hooks/lib/transcript-evidence.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function write(name: string, lines: unknown[]): string {
  dir = dir || mkdtempSync(join(tmpdir(), 'agent-guards-tx-test-'));
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

const userTurn = (text = 'ship it') => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
const use = (id: string, name: string, input: unknown) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, text: string, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
});

// ── parseTurnEvents — the fail-open parser ─────────────────────────────────

describe('parseTurnEvents fail-open', () => {
  test('returns [] for an undefined path', () => {
    expect(parseTurnEvents(undefined)).toEqual([]);
  });

  test('returns [] for a path that does not exist', () => {
    expect(parseTurnEvents('/nonexistent/agent-guards-test/transcript.jsonl')).toEqual([]);
  });

  test('returns [] when the path exists but cannot be read as a file (a directory) — existsSync passes, readFileSync throws', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-guards-tx-test-'));
    expect(parseTurnEvents(dir)).toEqual([]);
  });

  test('skips unparseable lines but keeps parsing the good ones around them', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-guards-tx-test-'));
    const path = join(dir, 't.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify(userTurn()),
        '{this is not json, tool_use garbage',
        JSON.stringify(use('t1', 'Bash', { command: 'npx wrangler deploy' })),
        JSON.stringify(result('t1', 'Published demo')),
      ].join('\n'),
    );
    const ev = parseTurnEvents(path);
    expect(ev.some((e) => e.kind === 'deploy')).toBe(true);
  });
});

// ── Turn-boundary + tool classification ────────────────────────────────────

describe('parseTurnEvents classification', () => {
  test('classifies a wrangler deploy as a deploy event, target read from the command line', () => {
    const path = write('deploy', [
      userTurn(),
      use('t1', 'Bash', { command: 'npx wrangler deploy --routes https://demo.example.com/*' }),
      result('t1', 'Published demo (4.2 sec)'),
    ]);
    const ev = parseTurnEvents(path);
    expect(ev.map((e) => e.kind)).toEqual(['deploy']);
    expect(ev[0]!.target).toBe('example.com'); // eTLD+1 — the subdomain is dropped
  });

  test('classifies bun test as a test-run event, and --dry-run as NOT one', () => {
    const path = write('tests', [
      userTurn(),
      use('t1', 'Bash', { command: 'bun test' }),
      result('t1', '12 pass, 0 fail'),
      use('t2', 'Bash', { command: 'npm run test --dry-run' }),
      result('t2', 'dry run only'),
    ]);
    const ev = parseTurnEvents(path);
    expect(ev.filter((e) => e.kind === 'test-run').length).toBe(1);
  });

  test('classifies a curl probe', () => {
    const path = write('probe', [userTurn(), use('t1', 'Bash', { command: 'curl -sSI https://demo.example.com' }), result('t1', 'HTTP/2 200')]);
    expect(parseTurnEvents(path).map((e) => e.kind)).toEqual(['probe']);
  });

  test('classifies WebFetch as a probe keyed on the eTLD+1', () => {
    const path = write('webfetch', [userTurn(), use('t1', 'WebFetch', { url: 'https://sub.demo.example.com/page' }), result('t1', 'ok')]);
    const ev = parseTurnEvents(path);
    expect(ev[0]!.kind).toBe('probe');
    expect(ev[0]!.target).toBe('example.com');
  });

  test('classifies an Edit to a code file as isCode=true, and a markdown file as isCode=false', () => {
    const path = write('edits', [
      userTurn(),
      use('t1', 'Edit', { file_path: '/repo/src/index.ts', old_string: 'a', new_string: 'b' }),
      result('t1', 'ok'),
      use('t2', 'Write', { file_path: '/repo/README.md', content: 'hi' }),
      result('t2', 'ok'),
    ]);
    const ev = parseTurnEvents(path);
    expect(ev.find((e) => e.target.endsWith('.ts'))!.isCode).toBe(true);
    expect(ev.find((e) => e.target.endsWith('.md'))!.isCode).toBe(false);
  });

  test('classifies a browser MCP tool by name, not by parsing a command', () => {
    const path = write('browser', [
      userTurn(),
      use('t1', 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page', { url: 'https://demo.example.com' }),
      result('t1', 'ok'),
      use('t2', 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__click', { selector: '#submit' }),
      result('t2', 'ok'),
      use('t3', 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot', {}),
      result('t3', 'ok'),
    ]);
    expect(parseTurnEvents(path).map((e) => e.kind)).toEqual(['browser-nav', 'browser-interact', 'browser-capture']);
  });

  test('classifies a browser CLI command by verb: capture beats interact beats nav', () => {
    const path = write('browsercli', [
      userTurn(),
      use('t1', 'Bash', { command: 'playwright screenshot --out navigate.png' }),
      result('t1', 'ok'),
    ]);
    // Capture-first: a filename containing "navigate" must not win over the
    // screenshot verb — this is the exact case the source comments call out.
    expect(parseTurnEvents(path)[0]!.kind).toBe('browser-capture');
  });

  test('classifies Read of an image path as read-image, and a non-image Read as nothing', () => {
    const path = write('readimg', [
      userTurn(),
      use('t1', 'Read', { file_path: '/tmp/shot.png' }),
      result('t1', 'ok'),
      use('t2', 'Read', { file_path: '/repo/src/index.ts' }),
      result('t2', 'ok'),
    ]);
    expect(parseTurnEvents(path).map((e) => e.kind)).toEqual(['read-image']);
  });

  test('classifies Agent/Task as agent-result', () => {
    const path = write('agent', [userTurn(), use('t1', 'Agent', { description: 'investigate the bug' }), result('t1', 'done')]);
    expect(parseTurnEvents(path).map((e) => e.kind)).toEqual(['agent-result']);
  });

  test('joins an array-shaped tool_result content (blocks of {type,text}) into one string', () => {
    const path = write('arraycontent', [
      userTurn(),
      use('t1', 'Bash', { command: 'npm test' }),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: '10 pass' }, { type: 'text', text: '0 fail' }],
            },
          ],
        },
      },
    ]);
    const ev = parseTurnEvents(path);
    expect(ev[0]!.resultText).toBe('10 pass 0 fail');
  });

  test('marks a tool_result carrying is_error:true as an error event', () => {
    const path = write('error', [userTurn(), use('t1', 'Bash', { command: 'curl https://x' }), result('t1', 'boom', true)]);
    expect(parseTurnEvents(path)[0]!.isError).toBe(true);
  });

  test('marks a 5xx status line as an error even without is_error set', () => {
    const path = write('5xx', [userTurn(), use('t1', 'Bash', { command: 'curl -sSI https://x' }), result('t1', 'HTTP/1.1 500 Internal Server Error')]);
    expect(parseTurnEvents(path)[0]!.isError).toBe(true);
  });

  test('does NOT flag an ordinary build-size number like "500.42 KiB" as an error', () => {
    const path = write('notanerror', [userTurn(), use('t1', 'Bash', { command: 'npm run build' }), result('t1', 'bundle: 500.42 KiB written')]);
    // Not a verify command per VERIFY_RE inside this file (build IS matched
    // for cross-tree, but not relevant here) — the point under test is purely
    // the error marker not false-firing on a bare number.
    expect(parseTurnEvents(path).every((e) => !e.isError)).toBe(true);
  });

  test('only events at/after the last real user text message are in scope — a tool_result-only "user" entry is not a new turn', () => {
    const path = write('turnboundary', [
      userTurn('first request'),
      use('t1', 'Bash', { command: 'npx wrangler deploy' }),
      result('t1', 'Published demo'),
      // A user entry carrying ONLY a tool_result (e.g. a background task
      // ferrying its own tool call back) must not reset the turn boundary.
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }] } },
      use('t2', 'Bash', { command: 'curl -sSI https://demo.example.com' }),
      result('t2', 'HTTP/2 200'),
    ]);
    const ev = parseTurnEvents(path);
    expect(ev.map((e) => e.kind)).toEqual(['deploy', 'probe']);
  });
});

// ── testResultPassed ──────────────────────────────────────────────────────

describe('testResultPassed', () => {
  test('true on an explicit pass count', () => {
    expect(testResultPassed('12 pass, 0 fail')).toBe(true);
  });
  test('false when any test failed, even alongside passes', () => {
    expect(testResultPassed('11 pass, 1 fail')).toBe(false);
  });
  test('false on "0 pass"', () => {
    expect(testResultPassed('0 pass, 0 fail')).toBe(false);
  });
  test('true on exit code 0', () => {
    expect(testResultPassed('done. exit code 0')).toBe(true);
  });
  test('false on unrelated text', () => {
    expect(testResultPassed('Compiling...')).toBe(false);
  });
});

// ── Query API ─────────────────────────────────────────────────────────────

function ev(kind: TxEvent['kind'], seq: number, extra: Partial<TxEvent> = {}): TxEvent {
  return { seq, kind, tool: 'x', target: '', resultText: '', isError: false, isCode: false, ...extra };
}

describe('lastMutationSeq / hadDeploy / hadCodeEdit / spawnedAgent / hadFrontendEdit / hadFlowEdit', () => {
  test('lastMutationSeq is the max of code edits and deploys, ignoring doc edits', () => {
    const events = [ev('edit', 0, { isCode: false }), ev('edit', 1, { isCode: true }), ev('probe', 2), ev('deploy', 3)];
    expect(lastMutationSeq(events)).toBe(3);
  });

  test('lastMutationSeq is -1 with no mutation', () => {
    expect(lastMutationSeq([ev('probe', 0)])).toBe(-1);
  });

  test('hadDeploy / hadCodeEdit / spawnedAgent are true only when their kind is present', () => {
    expect(hadDeploy([ev('deploy', 0)])).toBe(true);
    expect(hadDeploy([ev('probe', 0)])).toBe(false);
    expect(hadCodeEdit([ev('edit', 0, { isCode: true })])).toBe(true);
    expect(hadCodeEdit([ev('edit', 0, { isCode: false })])).toBe(false);
    expect(spawnedAgent([ev('agent-result', 0)])).toBe(true);
    expect(spawnedAgent([ev('probe', 0)])).toBe(false);
  });

  test('hadFrontendEdit matches frontend extensions only', () => {
    expect(hadFrontendEdit([ev('edit', 0, { target: '/src/App.tsx' })])).toBe(true);
    expect(hadFrontendEdit([ev('edit', 0, { target: '/src/server.ts' })])).toBe(false);
  });

  test('hadFlowEdit matches auth/checkout-adjacent code edits only', () => {
    expect(hadFlowEdit([ev('edit', 0, { isCode: true, target: '/src/auth/callback.ts' })])).toBe(true);
    expect(hadFlowEdit([ev('edit', 0, { isCode: true, target: '/src/marketing/hero.ts' })])).toBe(false);
    // Not code — a doc edit mentioning "checkout" in its path is not a flow edit.
    expect(hadFlowEdit([ev('edit', 0, { isCode: false, target: '/docs/checkout.md' })])).toBe(false);
  });
});

describe('probedAfterDeploy', () => {
  test('false with no deploy at all', () => {
    expect(probedAfterDeploy([ev('probe', 0)])).toBe(false);
  });

  test('false when the deploy is never followed by a probe', () => {
    expect(probedAfterDeploy([ev('deploy', 0)])).toBe(false);
  });

  test('true when a successful probe follows the deploy', () => {
    expect(probedAfterDeploy([ev('deploy', 0), ev('probe', 1, { isError: false })])).toBe(true);
  });

  test('false when the only probe after the deploy errored', () => {
    expect(probedAfterDeploy([ev('deploy', 0), ev('probe', 1, { isError: true })])).toBe(false);
  });

  test('anchors on the LAST deploy — an earlier probe does not credit a re-deploy', () => {
    const events = [ev('deploy', 0), ev('probe', 1, { isError: false }), ev('deploy', 2)];
    expect(probedAfterDeploy(events)).toBe(false);
  });
});

describe('flowExercised', () => {
  test('false with only a screenshot — a render is not an exercise', () => {
    expect(flowExercised([ev('edit', 0, { isCode: true }), ev('browser-capture', 1)])).toBe(false);
  });

  test('true with an interaction AND a nav/capture after the last mutation', () => {
    const events = [ev('edit', 0, { isCode: true }), ev('browser-nav', 1), ev('browser-interact', 2)];
    expect(flowExercised(events)).toBe(true);
  });

  test('true on a successful HTTP round trip probe after the mutation', () => {
    const events = [ev('edit', 0, { isCode: true }), ev('probe', 1, { resultText: 'HTTP/1.1 200 OK' })];
    expect(flowExercised(events)).toBe(true);
  });

  test('false when the interaction itself errored', () => {
    const events = [ev('edit', 0, { isCode: true }), ev('browser-nav', 1), ev('browser-interact', 2, { isError: true })];
    expect(flowExercised(events)).toBe(false);
  });
});

describe('pixelViewed', () => {
  test('false with a capture but no read', () => {
    expect(pixelViewed([ev('edit', 0, { isCode: true }), ev('browser-capture', 1)])).toBe(false);
  });
  test('false with a read but no capture', () => {
    expect(pixelViewed([ev('edit', 0, { isCode: true }), ev('read-image', 1)])).toBe(false);
  });
  test('true with both a capture AND a read after the last frontend edit', () => {
    const events = [ev('edit', 0, { isCode: true }), ev('browser-capture', 1), ev('read-image', 2)];
    expect(pixelViewed(events)).toBe(true);
  });
});

describe('testPassedAfterEdit', () => {
  test('false with no test run', () => {
    expect(testPassedAfterEdit([ev('edit', 0, { isCode: true })])).toBe(false);
  });
  test('true when a passing test-run follows the edit', () => {
    const events = [ev('edit', 0, { isCode: true }), ev('test-run', 1, { resultText: '10 pass, 0 fail' })];
    expect(testPassedAfterEdit(events)).toBe(true);
  });
  test('false when the test-run after the edit failed', () => {
    const events = [ev('edit', 0, { isCode: true }), ev('test-run', 1, { resultText: '9 pass, 1 fail' })];
    expect(testPassedAfterEdit(events)).toBe(false);
  });
  test('false when the only passing test-run was BEFORE the edit', () => {
    const events = [ev('test-run', 0, { resultText: '10 pass, 0 fail' }), ev('edit', 1, { isCode: true })];
    expect(testPassedAfterEdit(events)).toBe(false);
  });
});
