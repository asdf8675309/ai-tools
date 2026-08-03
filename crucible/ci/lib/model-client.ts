// model-client.ts — the one place a CI script talks to a model.
//
// Both `pre-pr-review/call-reviewer.ts` and `coordinator/call-coordinator.ts`
// make an OpenAI-compatible chat-completion call. They used to each own a
// fetch, and the retry logic drifted: the reviewer grew a full backoff envelope
// while the coordinator had none, so the same 429 that the reviewer rode out
// killed the coordinator. This module is the fix — the retry envelope and the
// request shape live here, and both callers go through `chatCompletion`.
//
// SCOPE: this serves the two `ci/` chat callers only. The embedding client in
// `skill/` speaks a different endpoint and ships to a different place
// (`~/.claude/skills/`, not a repo's `.github/`), so it is deliberately not
// pulled in here — sharing across that boundary would couple two things that
// deploy separately. One client per (deployment boundary × API), not one global
// client.
//
// The retry envelope is pure control flow over an INJECTED fetcher and sleeper,
// so the budget math that keeps a call inside the CI job timeout is testable
// with no network.

// ── Timeouts and attempt budget ──────────────────────────────────────────────
// The first attempt gets a long budget; retries get a short one. Worst case
// with the default schedule: 180 + (≤30) + 60 + (≤30) + 60 = 360s, under a
// typical 8-minute (480s) job timeout. Reusing the full 180s per retry could
// blow the timeout mid-request and kill the run before it posts a degraded
// comment — worse than not retrying.
export const FIRST_ATTEMPT_TIMEOUT_MS = 180_000;
export const RETRY_ATTEMPT_TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 8_000]; // before attempt 2, before attempt 3

// Ceiling on any single retry delay, INCLUDING a server-supplied Retry-After.
// Without it, a large or malformed Retry-After could sleep past the job timeout,
// getting the run hard-killed before it reaches the degraded-comment path — the
// exact failure this envelope exists to prevent.
export const MAX_RETRY_DELAY_MS = 30_000;

// One delay entry per possible retry. A silent mismatch would make the delay
// resolve to undefined mid-loop, so assert it at module load.
if (RETRY_DELAYS_MS.length !== MAX_ATTEMPTS - 1) {
  throw new Error(
    `RETRY_DELAYS_MS invariant broken: expected ${MAX_ATTEMPTS - 1} entries, got ${RETRY_DELAYS_MS.length}`,
  );
}

/** First attempt gets the long budget; every retry gets the short one. */
export function fetchTimeoutMs(attempt: number): number {
  return attempt === 1 ? FIRST_ATTEMPT_TIMEOUT_MS : RETRY_ATTEMPT_TIMEOUT_MS;
}

// Transient: network-level throws (DNS stall, ECONNRESET, our own timeout) and
// HTTP 429 / 5xx — worth retrying. Non-transient: 4xx other than 429 (bad auth,
// malformed request) — retrying won't change the outcome.
export function isTransientStatus(status: number): boolean {
  if (status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

/** Clamp a raw millisecond delay into [0, MAX_RETRY_DELAY_MS]. */
export function clampDelay(ms: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, ms));
}

// Retry-After (RFC 9110 §10.2.3) is either delay-seconds or an HTTP-date.
// Returns null when absent/unparseable so the caller falls back to the default
// schedule. Trims first — Number(" ") is 0, not NaN, so an untrimmed
// whitespace-only value would slip through as a spurious immediate retry.
export function retryAfterMs(resp: Response): number | null {
  const header = resp.headers.get("retry-after")?.trim();
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return clampDelay(seconds * 1000);
  const dateMs = Date.parse(header);
  if (Number.isNaN(dateMs)) return null;
  return clampDelay(dateMs - Date.now());
}

// ── Input budget and model selection ────────────────────────────────────────
// Both chat callers size their prompt the same way: over LARGE_INPUT_CHARS swap
// in the stronger model, over MAX_INPUT_CHARS (~80K tokens at 4 chars/token)
// refuse the input entirely. The coordinator used to carry these as bare
// literals in its own flow, which is how two callers end up disagreeing about
// what "too large" means after one of them is tuned.
export const LARGE_INPUT_CHARS = 30_000;
export const MAX_INPUT_CHARS = 320_000;
export const MAX_OUTPUT_TOKENS = 8192;

// `modelLarge || model` is re-applied here, not just where the env is read: an
// empty REVIEW_MODEL_LARGE must never resolve to an empty model name on a large
// input.
export function selectModel(
  totalChars: number,
  model: string,
  modelLarge: string,
): { sizeTag: "large" | "standard"; model: string } {
  const sizeTag: "large" | "standard" = totalChars > LARGE_INPUT_CHARS ? "large" : "standard";
  return { sizeTag, model: sizeTag === "large" ? modelLarge || model : model };
}

export interface ModelCallResult {
  resp?: Response;
  networkErrorMsg?: string;
  /** Attempts actually made (1..MAX_ATTEMPTS). */
  attempts: number;
  /** Delay in ms slept before each retry, in order — the realized backoff. */
  delays: number[];
}

/**
 * Retry envelope around one model call. Stops on: success, a non-transient
 * status, or the attempt ceiling. A network throw is transient by definition
 * (no status to judge). `attemptFetch` receives the 1-based attempt number so
 * the caller can shorten the per-call timeout on retries.
 */
export async function callModelWithRetry(
  attemptFetch: (attempt: number) => Promise<Response>,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  log: (msg: string) => void = (msg) => console.error(msg),
): Promise<ModelCallResult> {
  let resp: Response | undefined;
  let networkErrorMsg: string | undefined;
  const delays: number[] = [];
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    try {
      resp = await attemptFetch(attempt);
    } catch (e) {
      networkErrorMsg = e instanceof Error ? e.message : String(e);
      resp = undefined;
    }

    if (resp?.ok) break;

    const transient = resp ? isTransientStatus(resp.status) : true;
    const label = resp ? `HTTP ${resp.status}` : `fetch failed: ${networkErrorMsg}`;

    if (!transient) {
      log(`[model-client] non-transient failure (${label}) — not retrying`);
      break;
    }
    if (attempt === MAX_ATTEMPTS) {
      log(`[model-client] model call failed after ${MAX_ATTEMPTS} attempts (${label})`);
      break;
    }

    const serverDelay = resp ? retryAfterMs(resp) : null;
    // The RETRY_DELAYS_MS invariant guarantees an entry for every retry, so the
    // `??` fallback is unreachable; it keeps the delay a number without a
    // non-null assertion.
    const delayMs = serverDelay ?? RETRY_DELAYS_MS[attempt - 1] ?? 2_000;
    log(`[model-client] transient failure (${label}) on attempt ${attempt}/${MAX_ATTEMPTS} — retrying in ${delayMs}ms`);
    delays.push(delayMs);
    await sleep(delayMs);
  }

  return { resp, networkErrorMsg, attempts, delays };
}

// ── The one request shape ────────────────────────────────────────────────────

// A configured base URL with a trailing slash would otherwise produce a double
// slash, which some gateways route differently (or 404).
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

// The attribution metadata rides in a custom HEADER, never the request body:
// strict OpenAI-compatible servers reject unknown body fields. An empty header
// name means no extra header at all.
export function buildModelHeaders(
  token: string,
  metadataHeader: string,
  metadata: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (metadataHeader) headers[metadataHeader] = JSON.stringify(metadata);
  return headers;
}

export function buildModelBody(
  model: string,
  prompt: string,
  maxTokens: number = MAX_OUTPUT_TOKENS,
): string {
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
}

/** The subset of an OpenAI-compatible response both callers read. */
export interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

export interface ChatCompletionParams {
  /** OpenAI-compatible endpoint prefix, e.g. https://host/v1. `/chat/completions` is appended. */
  baseUrl: string;
  /** Bearer token value. Sent as `Authorization: Bearer <token>`, never logged. */
  token: string;
  model: string;
  /** Single user message. */
  prompt: string;
  maxTokens: number;
  /** Optional per-request attribution header some gateways read (name + JSON value). */
  metadataHeader?: string;
  metadata?: Record<string, string>;
  /** Test seams — default to the real implementations. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (msg: string) => void;
}

/**
 * One OpenAI-compatible chat completion, wrapped in the retry envelope above.
 * This is what both CI chat callers use; the request body and header shape live
 * here so they cannot drift apart again.
 */
export function chatCompletion(p: ChatCompletionParams): Promise<ModelCallResult> {
  const doFetch = p.fetchImpl ?? fetch;
  const headers = buildModelHeaders(p.token, p.metadataHeader ?? "", p.metadata ?? {});
  const body = buildModelBody(p.model, p.prompt, p.maxTokens);

  return callModelWithRetry(
    (attempt) =>
      doFetch(chatCompletionsUrl(p.baseUrl), {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(fetchTimeoutMs(attempt)),
      }),
    p.sleep,
    p.log,
  );
}
