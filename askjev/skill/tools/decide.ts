// Typed decision primitives for TypeSafe Jev (a "System One" model).
//
// A System One model emits typed decisions, never text. That is the point:
// no prose to parse, no JSON to coax out of a chat model, no temperature to
// argue with. You ask calibrated questions and get numbers back.
//
// Transport is Cloudflare Workers AI's REST `ai/run` endpoint. Set CF_AI_GATEWAY
// to additionally route calls through an AI Gateway for logging, caching and cost
// attribution. The gateway is engaged by the `cf-aig-gateway-id` HEADER — not by
// posting to a gateway.ai.cloudflare.com URL, which is a different, OpenAI-chat-
// shaped path that cannot express a questions payload at all.

export type JevQuestion =
  /** Calibrated yes/no. The answer carries `noul` (0..1) and NO confidence field
   * — you threshold the probability itself. Frame the question so the case you
   * want to catch is TRUE; that is what keeps `max` aggregation meaningful. */
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  /** Pick one of a closed set. `criteria` is a RECORD of option -> description.
   * Passing an array is rejected with HTTP 400. */
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  /** Ordered rubric. Unlike choice, `criteria` is an ARRAY of level descriptions,
   * lowest first — a record is rejected with "expected array, received object".
   * The returned `score` is interpolated across those levels (e.g. 1.3), not an
   * index, and `legend` maps each index back to its description. */
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevAnswer {
  type: 'noul' | 'choice' | 'score';
  noul?: number;
  choice?: string;
  score?: number;
  /** Present on choice/score only, derived from the probability spread. */
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

/** Called once per request with the outcome. Wire your own metering here; the
 * library records nothing itself and has no logging dependency. */
export type CallObserver = (event: {
  ok: boolean;
  role: string;
  model: string;
  durationMs: number;
  usage?: DecideResult['usage'];
  error?: string;
}) => void;

export interface DecideConfig {
  accountId?: string;
  apiToken?: string;
  /** AI Gateway id. Omit to call Workers AI directly with no gateway. */
  gateway?: string;
  /** Gateway auth, when the gateway has authentication enabled. */
  gatewayToken?: string;
  observer?: CallObserver;
}

export interface DecideOptions extends DecideConfig {
  /** The material under judgement. Counts against the model's 32,000-token ceiling. */
  state: string;
  /** Ask several questions at once — one request, one state, many answers. */
  questions: Record<string, JevQuestion>;
  /** Tag for cost attribution in the gateway log. */
  role?: string;
  model?: string;
  timeoutMs?: number;
  skipCache?: boolean;
  /** Keep metadata in the gateway log but drop request/response bodies.
   * Suppresses RETENTION, not transit. */
  noLogPayload?: boolean;
}

export interface DecideResult {
  ok: boolean;
  answers?: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  durationMs: number;
  error?: string;
  /** HTTP status when the failure was an HTTP one. 429 means throttled, and
   * carries a retry-after header worth honouring. */
  status?: number;
}

export const DEFAULT_MODEL = 'typesafe/jev';

export async function decide(options: DecideOptions): Promise<DecideResult> {
  const {
    state, questions, role = 'decide', model = DEFAULT_MODEL,
    accountId = process.env.CF_ACCOUNT_ID,
    apiToken = process.env.CF_API_TOKEN,
    gateway = process.env.CF_AI_GATEWAY,
    gatewayToken = process.env.CF_AIG_TOKEN,
    observer,
  } = options;

  if (!accountId) return { ok: false, durationMs: 0, error: 'missing CF_ACCOUNT_ID' };
  if (!apiToken) return { ok: false, durationMs: 0, error: 'missing CF_API_TOKEN' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const started = Date.now();
  const report = (r: DecideResult) => {
    observer?.({ ok: r.ok, role, model, durationMs: r.durationMs, usage: r.usage, error: r.error });
    return r;
  };

  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
        ...(gateway ? { 'cf-aig-gateway-id': gateway } : {}),
        ...(gateway && gatewayToken ? { 'cf-aig-authorization': `Bearer ${gatewayToken}` } : {}),
        ...(gateway ? { 'cf-aig-metadata': JSON.stringify({ role, model }) } : {}),
        ...(options.skipCache ? { 'cf-aig-skip-cache': 'true' } : {}),
        ...(options.noLogPayload ? { 'cf-aig-collect-log-payload': 'false' } : {}),
      },
      body: JSON.stringify({ model, input: { state, questions } }),
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;

    if (!res.ok) {
      // A 429 body is not JSON and would otherwise look like a parse failure —
      // check status before touching the body.
      const body = (await res.text()).slice(0, 300);
      return report({ ok: false, durationMs, status: res.status, error: `HTTP ${res.status}: ${body}` });
    }

    // Workers AI nests twice: result.result.answers, not answers.
    const json = (await res.json()) as {
      success?: boolean;
      errors?: { message?: string }[];
      result?: { result?: { answers?: Record<string, JevAnswer>; usage?: DecideResult['usage'] } };
    };
    if (json.success === false) {
      const error = json.errors?.map((e) => e.message).join('; ') || 'workers-ai reported failure';
      return report({ ok: false, durationMs, error });
    }
    const inner = json.result?.result;
    if (!inner?.answers) return report({ ok: false, durationMs, error: 'no result.result.answers in response' });

    return report({ ok: true, answers: inner.answers, usage: inner.usage, durationMs });
  } catch (error) {
    const durationMs = Date.now() - started;
    return report({ ok: false, durationMs, error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timer);
  }
}

/** Per-field `max` aggregation, from TypeSafe's SDE-cascade cookbook.
 *
 * Deliberately not a mean. Averaging a battery of narrow yes/no questions
 * buries exactly the signal a battery exists to catch — one confident flag
 * should escalate the whole record, not get diluted by six calm ones.
 * Measured on a real disqualifier battery: a single compound question scored
 * -0.120 separation (wrong direction, at chance); splitting it into seven
 * narrow questions and taking the max moved it to +0.251. */
export function maxGate(
  answers: Record<string, JevAnswer>,
  threshold: number,
  keys?: string[],
): { fired: boolean; top?: string; value: number } {
  let top: string | undefined;
  let value = 0;
  for (const [key, a] of Object.entries(answers)) {
    if (keys && !keys.includes(key)) continue;
    const p = a.noul;
    if (typeof p === 'number' && p > value) { value = p; top = key; }
  }
  return { fired: value >= threshold, top, value };
}

/** Three-band routing for choice/score confidence: act automatically, flag for a
 * human, or refuse to act. Boundaries are per use case and must be measured on
 * YOUR question class — a threshold from one class does not transfer to another.
 * They are arguments, not defaults, for exactly that reason. */
export function confidenceBand(
  confidence: number | undefined,
  high: number,
  low: number,
): 'act' | 'review' | 'hold' {
  if (typeof confidence !== 'number') return 'review';
  if (confidence >= high) return 'act';
  return confidence >= low ? 'review' : 'hold';
}
