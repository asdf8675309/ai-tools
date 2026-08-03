#!/usr/bin/env bun
/**
 * block-unverified-claim.ts — Stop hook
 *
 * WHAT IT BLOCKS
 *   Ending a turn that CLAIMS something is deployed / working / looks right,
 *   when the turn's own transcript shows the verification that claim requires
 *   never ran. Three claim types have teeth:
 *     T1 deploy      "it's live" with no probe of the origin after the deploy
 *     T2 flow        "login works" with no interaction and no successful round trip
 *     T3 appearance  "the logo renders" with no image captured AND viewed
 *   A fourth, T4 tests-pass, is log-only by default.
 *
 * WHAT IT ALLOWS
 *   Questions, instructions, plans, narration of past work, quoted text, any
 *   claim that was actually verified this turn, and any honest downgrade
 *   ("deployed, not verified"). Also: a turn that made no matching change at
 *   all — you cannot overclaim about work you did not do. And it blocks each
 *   distinct claim at most once, so it can never trap a session in a loop.
 *
 * THE FAILURE THAT MOTIVATED IT
 *   The expensive lie is not "this is broken". It is "this is done", because
 *   that ends the investigation. Everyone downstream now believes a thing that
 *   is not true, and the cost lands hours later, on someone else.
 *
 * WHY THIS DESIGN AND NOT THE OBVIOUS ONE — read this before changing it
 *   The first version of this guard scanned the RESPONSE for evidence: does the
 *   message that says "verified" also contain a file path, a code fence, an
 *   exit code? It failed in both directions at once, which is the interesting
 *   part.
 *     False positives: it graded prose. Sentences about the past ("shipped in
 *     2019"), quoted requirements, and advisory answers all tripped it, and each
 *     fix added another regex to a growing pile of exceptions — narration
 *     guards, dated-claim guards, prior-turn guards. The list never converged,
 *     because prose does not.
 *     False negatives, and worse: an agent that had learned the rule could pass
 *     by CITING better. One case claimed "live and verified" alongside a genuine
 *     screenshot of a button that rendered correctly — on a page whose login
 *     callback was returning 500. Every evidence check passed. The claim was
 *     false. Scanning the message rewards the wording of a claim, and wording is
 *     exactly what an agent controls for free.
 *   So this version inverts it: THE MESSAGE IS A CLAIM, THE TRANSCRIPT IS THE
 *   EVIDENCE. Claims still come from the message — that is where claims live —
 *   but evidence comes only from the turn's real tool calls. Rewording cannot
 *   pass it. Verifying, or downgrading honestly, can. The message-scanning
 *   version is not included in this package; it is a worse design, and shipping
 *   both would only invite someone to install the wrong one.
 *
 * ACT-THEN-CLAIM — the precondition that killed the false-positive family
 *   A claim only blocks if the transcript shows this turn actually did mutating
 *   work of the claimed kind. Summaries, status reports, code review, and
 *   analysis are full of sentences that read like claims and are not, and every
 *   one of them is a turn that changed nothing. One precondition retired the
 *   whole class, where a dozen prose exceptions had not.
 *
 * FAIL-OPEN ON OUR OWN BUGS, FAIL-CLOSED ON THE QUESTION ASKED
 *   Unreadable transcript, unfamiliar schema, internal crash: allow, always.
 *   A Stop hook that wedges a session is a worse outcome than a missed claim,
 *   and unlike a blocking PreToolUse there is no command to retry. Within the
 *   question it does answer, it is strict: an unverified claim of a blocking
 *   type blocks. Note the asymmetry is deliberate and NOT the same as the
 *   README's general rule — here "I could not read the transcript" genuinely
 *   means the guard is inoperable, not that the claim is suspect.
 *
 * BYPASS (announced on stderr, never silent)
 *   per type  : AGENT_GUARDS_CLAIM_T1=0 | _T2=0 | _T3=0
 *   whole hook: AGENT_GUARDS_UNVERIFIED_CLAIM=0    all: AGENT_GUARDS_OFF=1
 *   in-message: state the honest downgrade — "deployed, not verified" and
 *               similar phrasings pass. That is the intended escape: say the
 *               true thing instead of the confident thing.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  announceBypass,
  bypassReason,
  log,
  readState,
  readStdinJson,
  runHook,
  safeName,
  stateDir,
  writeState,
  type HookInput,
} from './lib/shared.ts';
import {
  parseTurnEvents,
  hadDeploy,
  hadCodeEdit,
  hadFrontendEdit,
  hadFlowEdit,
  spawnedAgent,
  probedAfterDeploy,
  flowExercised,
  pixelViewed,
  testPassedAfterEdit,
  type TxEvent,
} from './lib/transcript-evidence.ts';

const SLUG = 'unverified-claim';

// ── Claim detection ───────────────────────────────────────────────────────

export function splitIntoUnits(text: string): string[] {
  // Commas and semicolons too, so each claim in a run-on summary is judged
  // against its OWN evidence type rather than as one compound unit.
  return text
    .split(/[.!?;,\n]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

/** Strip fenced code, inline code, and blockquotes — a spec that CONTAINS
 *  "the login flow works" is quoting a requirement, not claiming it. */
export function stripNoise(msg: string): string {
  return msg
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ');
}

const HONEST_DOWNGRADE =
  /\b(not\s+(yet\s+)?(browser[\s-]?|pixel[\s-]?|end[\s-]?to[\s-]?end\s+)?verif\w*|not\s+verified\b|haven'?t\s+(yet\s+)?(actually\s+)?(verif\w*|exercised|tested|looked|driven)|deployed\s+but\s+not\s+\w*\s*verif\w*|flow\s+not\s+exercised|not\s+(yet\s+)?(browser[\s-]?)?tested|pending\s+(browser\s+|live\s+|your\s+)?(verif\w*|test)|verifying\s+(next|now)|verify\s+next|checking\s+now|probing\s+(it\s+)?now|about\s+to\s+(verify|test|check|probe)|next[\s:]+verif\w*|couldn'?t\s+(capture|verify|reach)|can'?t\s+verify)\b/i;

const NONCLAIM =
  /\b(not|isn'?t|aren'?t|wasn'?t|weren'?t|doesn'?t|don'?t|didn'?t|won'?t|can'?t|cannot|couldn'?t|no\s+longer|still\s+(not|broken|failing)|never|needs?\s+to|should\s+be|would\s+be|make\s+sure|please|let'?s|going\s+to|will\s+be|to\s+be|want|hope|expect|if\s|once\s|when\s|after\s|assuming|would|could\s+you|can\s+you)\b/i;
const LEADING_INTERROGATIVE =
  /^\s*(is|are|does|do|did|can|could|should|would|will|has|have|how|why|what|where|when|which|who|isn'?t|aren'?t)\b/i;
const LEADING_IMPERATIVE =
  /^\s*(run|do|execute|try|click|open|deploy|add|set|install|go|check|make|use|call|start|restart|edit|write|create|build|test|verify|ensure|remember\s+to)\b/i;
const RECIPE = /\b(then|and\s+then|after\s+that)\b[^.\n]{0,40}\b(works?|is\s+live|verified|passes?)\b/i;
const ATTRIBUTION =
  /\b(you\s+(said|asked|told|mentioned)|per\s+the|according\s+to|the\s+(ticket|PR|docs?|user|issue|spec)\s+(say|says|said|claims?))\b|"[^"]*"/i;
const NARRATION =
  /\b(earlier|already|previously|in\s+(the\s+)?prior\s+turns?|prior\s+turns?|last\s+turn)\b|\b(in|back\s+in|since|during)\s+(19|20)\d\d\b/i;

function unitIsClaimable(u: string): boolean {
  if (u.includes('?')) return false;
  return ![LEADING_INTERROGATIVE, LEADING_IMPERATIVE, RECIPE, NONCLAIM, ATTRIBUTION, NARRATION].some((re) => re.test(u));
}

const T1_LIVE =
  /\b((is|it'?s|site'?s|page'?s|now)\s+live|went\s+live|live\s+(at|on)|deployed\s+(to|at|and\s+(live|working))|deploy\s+(is\s+)?(complete|done|succeeded))\b/i;
const T1_WEBNOUN = /\b(site|page|web\s*site|url|domain|https?:\/\/|worker|deploy(ment|ed)?|production|prod\b|admin|dashboard)\b/i;
// No "callback" or "end-to-end" here — both are ordinary vocabulary in JS/TS
// and dragged unrelated "it works" claims into the flow type.
const T2_FLOW =
  /\b(log[\s-]?in|sign[\s-]?in|sign[\s-]?up|auth(entication|orization)?|oauth|sso|checkout|payment|purchase)\b/i;
const T2_WORKS =
  /\b(works?(\s+(now|end[\s-]?to[\s-]?end|fine|correctly|great))?|working|functional|verified(\s+working)?|confirmed\s+working|succeeds?|can\s+(now\s+)?(log|sign)\s+in|completes?|goes?\s+through)\b/i;
const T3_VISUAL =
  /\b(logo|image|icon|favicon|thumbnail|hero|banner|button|layout|header|footer|nav(bar)?|wordmark|graphic|background|colou?r)\b/i;
const T3_LOOK =
  /\b(renders?|rendered|displays?|displayed|looks?\s+(right|correct|good|great|fine)|is\s+(now\s+)?(centered|centred|aligned|transparent|visible|positioned))\b/i;
const T4_CODE = /\b(tests?\s+(pass|green|passing)|\d+\s*\/\s*\d+\s+(pass|green)|all\s+(green|passing))\b/i;

export type ClaimType = 'T1' | 'T2' | 'T3' | 'T4';

/** The strongest claim in the message, or null. Flow outranks deploy. */
export function classifyClaim(message: string): { type: ClaimType; unit: string } | null {
  const units = splitIntoUnits(stripNoise(message)).filter(unitIsClaimable);
  let t1: string | null = null;
  let t3: string | null = null;
  let t4: string | null = null;
  for (const u of units) {
    // A visual noun in the unit makes it a styling claim — "the sign-in button
    // renders" is about pixels, not about whether sign-in works.
    if (T2_FLOW.test(u) && T2_WORKS.test(u) && !T3_VISUAL.test(u)) return { type: 'T2', unit: u };
    if (!t1 && T1_LIVE.test(u) && T1_WEBNOUN.test(u)) t1 = u;
    if (!t3 && T3_VISUAL.test(u) && T3_LOOK.test(u)) t3 = u;
    if (!t4 && T4_CODE.test(u)) t4 = u;
  }
  if (t1) return { type: 'T1', unit: t1 };
  if (t3) return { type: 'T3', unit: t3 };
  if (t4) return { type: 'T4', unit: t4 };
  return null;
}

// A terse liveness assertion with no flow noun ("both apps live and verified").
// Narrow on purpose: it must not match an ordinary description of a plan.
const GENERIC_FLOW =
  /\b(live\s+and\s+verified|it\s+works\b|works\s+now|works\s+end[\s-]?to[\s-]?end|confirmed\s+working|fully\s+working|sign[\s-]?in\s+works|login\s+works)\b/i;

export function genericFlowClaimUnit(message: string): string | null {
  for (const u of splitIntoUnits(stripNoise(message)).filter(unitIsClaimable)) {
    if (GENERIC_FLOW.test(u)) return u;
  }
  return null;
}

// ── Dedupe ────────────────────────────────────────────────────────────────
// Blocking the same claim twice would be a loop. One block per distinct claim
// per session; after that it is on the human.

function fingerprint(session: string, type: string, unit: string): string {
  return createHash('sha256')
    .update(`${session}|${type}|${unit.toLowerCase().replace(/\s+/g, ' ').trim()}`)
    .digest('hex')
    .slice(0, 16);
}

function dedupeFile(session: string): string {
  return join(stateDir('unverified-claim'), `${safeName(session)}.json`);
}

const MESSAGES: Record<string, (unit: string, ev: string) => string> = {
  T1: (u, ev) =>
    `DEPLOY CLAIMED, NEVER PROBED. You claimed: "${u}". This turn's transcript shows ${ev}. Deployed is not live — the deploy command succeeding says the upload worked, not that the thing responds. Do one, then say it again: (a) probe the deployed origin after the deploy — a navigation, a screenshot, or a request returning 2xx/3xx; or (b) downgrade honestly: "deployed, not verified". This reads your tool calls, not your wording, so rewording will not pass it.`,
  T2: (u, ev) =>
    `FLOW CLAIMED, NEVER EXERCISED. You claimed: "${u}". This turn's transcript shows ${ev}. A render proves a page painted; it does not prove the flow works — that exact gap shipped a login whose callback returned 500 behind a screenshot of a correctly rendered button. Do one, then say it again: (a) drive the real flow — navigate, interact, read the result — or hit the endpoint and show the 2xx/3xx; or (b) downgrade honestly: "deployed, flow not exercised".`,
  T3: (u, ev) =>
    `APPEARANCE CLAIMED, NEVER VIEWED. You claimed: "${u}". This turn's transcript shows ${ev}. A DOM read proves an element exists; only a viewed pixel proves it looks right. Capture an image, read it, then say it again — or downgrade: "placed, not visually checked".`,
};

// ── Decision ──────────────────────────────────────────────────────────────

export interface Decision {
  action: 'pass' | 'block';
  reason?: string;
  note: string;
  type?: ClaimType;
}

export function decide(input: HookInput, events: TxEvent[]): Decision {
  // A recovery pass after a block: never block again, by construction.
  if (input.stop_hook_active === true) return { action: 'pass', note: 'stop-hook-recovery' };

  const message = input.last_assistant_message ?? '';
  if (!message.trim()) return { action: 'pass', note: 'empty-message' };

  if (HONEST_DOWNGRADE.test(stripNoise(message))) return { action: 'pass', note: 'honest-downgrade' };

  let claim = classifyClaim(message);
  // Type a terse "live and verified" from what the session TOUCHED. This is the
  // catch for the case that motivated the redesign.
  if (!claim || claim.type === 'T1') {
    const generic = genericFlowClaimUnit(message);
    if (generic && hadFlowEdit(events)) claim = { type: 'T2', unit: generic };
  }
  if (!claim) return { action: 'pass', note: 'no-claim' };

  // A sub-agent may hold the evidence in its own context, invisible here.
  if (spawnedAgent(events)) return { action: 'pass', note: 'subagent-confounder', type: claim.type };

  let acted = false;
  let verified = false;
  let summary = '';

  if (claim.type === 'T1') {
    acted = hadDeploy(events);
    verified = probedAfterDeploy(events);
    summary = `${events.filter((e) => e.kind === 'deploy').length} deploy(s) and no probe of the origin afterwards`;
  } else if (claim.type === 'T2') {
    acted = hadCodeEdit(events) || hadDeploy(events);
    verified = flowExercised(events);
    const caps = events.filter((e) => e.kind === 'browser-capture').length;
    const acts = events.filter((e) => e.kind === 'browser-interact').length;
    summary = `${caps} capture(s), ${acts} interaction(s), and no successful round trip after the last change`;
  } else if (claim.type === 'T3') {
    acted = hadFrontendEdit(events);
    verified = pixelViewed(events);
    summary = 'no image both captured and read after the last frontend change';
  } else {
    acted = hadCodeEdit(events);
    verified = testPassedAfterEdit(events);
    summary = 'no passing test run after the last code edit';
  }

  if (!acted) return { action: 'pass', note: 'act-then-claim-not-met', type: claim.type };
  if (verified) return { action: 'pass', note: 'verified', type: claim.type };

  // T4 is log-only: its claim surface ("all green") overlaps ordinary
  // conversation far more than the other three, so it reports without teeth.
  if (claim.type === 'T4' || process.env[`AGENT_GUARDS_CLAIM_${claim.type}`] === '0') {
    return { action: 'pass', note: claim.type === 'T4' ? 'log-only-type' : 'type-disabled', type: claim.type };
  }

  return { action: 'block', reason: MESSAGES[claim.type]!(claim.unit, summary), note: `block-${claim.type}`, type: claim.type };
}

/** `raw`, when passed, is forwarded to readStdinJson instead of real stdin —
 *  the same test-only seam readStdinJson itself exposes. Every production
 *  call site (below) omits it. Never calls process.exit itself — a Stop hook
 *  blocks via stdout JSON, not an exit code — so it is always safe to call
 *  directly. */
export function main(raw?: string): void {
  const input = readStdinJson(raw);
  if (!input) return;

  let events: TxEvent[] = [];
  try {
    events = parseTurnEvents(input.transcript_path);
  } catch {
    return; // Unreadable transcript: the guard is inoperable, so it allows.
  }

  const decision = decide(input, events);
  log({ guard: SLUG, ...decision });

  if (decision.action !== 'block') return;

  const session = String(input.session_id ?? 'unknown');
  const claimUnit = decision.reason ?? '';
  const fp = fingerprint(session, decision.type ?? '?', claimUnit);
  const file = dedupeFile(session);
  const seen = readState<string[]>(file, []);
  if (Array.isArray(seen) && seen.includes(fp)) return; // already blocked once

  const why = bypassReason(SLUG);
  if (why) return announceBypass(SLUG, why, decision.note);

  writeState(file, [...(Array.isArray(seen) ? seen.slice(-200) : []), fp]);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }) + '\n');
}

// Fail-open: a Stop hook must never be why a session cannot end.
if (import.meta.main) runHook(main);
