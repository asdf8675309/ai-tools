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

/** The three ways to reach Jev. They all terminate at the same TypeSafe model,
 * so this is about which account you already have and which bill you want it
 * on — not about redundancy. An outage or a terms change affects all three.
 *
 * `workers-ai` is the default because it needs no TypeSafe account, and it is
 * the only one that can route through an AI Gateway for request/response
 * logging and cost attribution. */
export type JevProvider = 'workers-ai' | 'openrouter' | 'typesafe';

interface ProviderSpec {
  defaultModel: string;
  /** Env var holding this provider's credential, for the error message. */
  tokenEnv: string;
  url(cfg: { accountId?: string }): string;
  /** Request bodies differ: Workers AI wraps in `input`, the others are flat. */
  body(model: string, state: string, questions: Record<string, JevQuestion>): unknown;
  /** Response shapes differ: Workers AI nests at result.result, others are flat. */
  extract(json: unknown): { answers?: Record<string, JevAnswer>; usage?: DecideResult['usage']; error?: string };
}

const PROVIDERS: Record<JevProvider, ProviderSpec> = {
  'workers-ai': {
    defaultModel: 'typesafe/jev',
    tokenEnv: 'CF_API_TOKEN',
    url: ({ accountId }) => `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`,
    body: (model, state, questions) => ({ model, input: { state, questions } }),
    extract: (json) => {
      const j = json as {
        success?: boolean;
        errors?: { message?: string }[];
        result?: { result?: { answers?: Record<string, JevAnswer>; usage?: DecideResult['usage'] } };
      };
      if (j.success === false) {
        return { error: j.errors?.map((e) => e.message).join('; ') || 'workers-ai reported failure' };
      }
      // Workers AI nests twice: result.result.answers, not answers.
      const inner = j.result?.result;
      if (!inner?.answers) return { error: 'no result.result.answers in response' };
      return { answers: inner.answers, usage: inner.usage };
    },
  },

  openrouter: {
    // Pinned rather than floating: a threshold measured against one version is
    // not valid for another, so an alias that moves under you is a hazard.
    defaultModel: 'typesafe/jev-1.13',
    tokenEnv: 'OPENROUTER_API_KEY',
    url: () => 'https://openrouter.ai/api/alpha/decisions',
    body: (model, state, questions) => ({ model, state, questions }),
    extract: (json) => {
      const j = json as {
        answers?: Record<string, JevAnswer>;
        usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      if (j.error) return { error: j.error.message ?? 'openrouter reported failure' };
      if (!j.answers) return { error: 'no answers in response' };
      return {
        answers: j.answers,
        usage: {
          input_tokens: j.usage?.input_tokens ?? j.usage?.prompt_tokens,
          output_tokens: j.usage?.output_tokens ?? j.usage?.completion_tokens,
        },
      };
    },
  },

  typesafe: {
    defaultModel: 'jev-1.13',
    tokenEnv: 'TYPESAFE_API_KEY',
    url: () => 'https://api.typesafe.ai/v1/systemone',
    body: (model, state, questions) => ({ model, state, questions }),
    extract: (json) => {
      const j = json as {
        answers?: Record<string, JevAnswer>;
        usage?: DecideResult['usage'];
        error?: { message?: string };
      };
      if (j.error) return { error: j.error.message ?? 'typesafe reported failure' };
      if (!j.answers) return { error: 'no answers in response' };
      return { answers: j.answers, usage: j.usage };
    },
  },
};

export interface DecideConfig {
  /** Defaults to JEV_PROVIDER, then 'workers-ai'. */
  provider?: JevProvider;
  /** Credential for the chosen provider. Defaults to that provider's env var. */
  apiToken?: string;
  /** workers-ai only. */
  accountId?: string;
  /** workers-ai only. AI Gateway id; omit to call Workers AI directly. */
  gateway?: string;
  /** workers-ai only. Gateway auth, when the gateway has authentication on. */
  gatewayToken?: string;
  observer?: CallObserver;
}

export interface DecideOptions extends DecideConfig {
  /** The material under judgement. Counts against the model's 32,000-token ceiling. */
  state: string;
  /** Ask several questions at once — one request, one state, many answers. */
  questions: Record<string, JevQuestion>;
  /** Tag for cost attribution. Only reaches the log on the gateway path. */
  role?: string;
  model?: string;
  timeoutMs?: number;
  /** workers-ai + gateway only. */
  skipCache?: boolean;
  /** workers-ai + gateway only. Keeps metadata in the gateway log but drops
   * request/response bodies. Suppresses RETENTION, not transit. */
  noLogPayload?: boolean;
}

export interface DecideResult {
  ok: boolean;
  answers?: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  durationMs: number;
  error?: string;
  /** Requested question keys that came back unanswered. Empty on a full response. */
  missing?: string[];
  /** HTTP status when the failure was an HTTP one. 429 means throttled, and
   * carries a retry-after header worth honouring. */
  status?: number;
  /** Which provider actually served this call. */
  provider?: JevProvider;
}

/** Default for the default provider. Per-provider defaults live in PROVIDERS. */
export const DEFAULT_MODEL = PROVIDERS['workers-ai'].defaultModel;

export async function decide(options: DecideOptions): Promise<DecideResult> {
  const provider = options.provider
    ?? (process.env.JEV_PROVIDER as JevProvider | undefined)
    ?? 'workers-ai';
  const spec = PROVIDERS[provider];
  if (!spec) {
    return { ok: false, durationMs: 0, error: `unknown provider '${provider}' (expected ${Object.keys(PROVIDERS).join(', ')})` };
  }

  const {
    state, questions, role = 'decide', model = spec.defaultModel,
    accountId = process.env.CF_ACCOUNT_ID,
    gateway = process.env.CF_AI_GATEWAY,
    gatewayToken = process.env.CF_AIG_TOKEN,
    observer,
  } = options;
  const apiToken = options.apiToken ?? process.env[spec.tokenEnv];

  if (!apiToken) return { ok: false, durationMs: 0, provider, error: `missing ${spec.tokenEnv}` };
  if (provider === 'workers-ai' && !accountId) {
    return { ok: false, durationMs: 0, provider, error: 'missing CF_ACCOUNT_ID' };
  }

  // Gateway headers are a Cloudflare feature and meaningless elsewhere.
  const onGateway = provider === 'workers-ai' && !!gateway;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  const started = Date.now();
  const report = (r: DecideResult) => {
    observer?.({ ok: r.ok, role, model, durationMs: r.durationMs, usage: r.usage, error: r.error });
    return { ...r, provider };
  };

  try {
    const res = await fetch(spec.url({ accountId }), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
        ...(onGateway ? { 'cf-aig-gateway-id': gateway! } : {}),
        ...(onGateway && gatewayToken ? { 'cf-aig-authorization': `Bearer ${gatewayToken}` } : {}),
        ...(onGateway ? { 'cf-aig-metadata': JSON.stringify({ role, model }) } : {}),
        ...(onGateway && options.skipCache ? { 'cf-aig-skip-cache': 'true' } : {}),
        ...(onGateway && options.noLogPayload ? { 'cf-aig-collect-log-payload': 'false' } : {}),
      },
      body: JSON.stringify(spec.body(model, state, questions)),
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;

    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return report({ ok: false, durationMs, status: res.status, error: `HTTP ${res.status}: ${body}` });
    }

    const { answers, usage, error } = spec.extract(await res.json());
    if (error || !answers) return report({ ok: false, durationMs, error: error ?? 'no answers in response' });

    // A response carrying SOME of the requested answers still returns ok:true,
    // because partial answers are usable. But the caller has to be able to tell:
    // asking seven questions and receiving two should not look identical to
    // receiving seven. `missing` names the keys that came back absent.
    const missing = Object.keys(questions).filter((k) => !(k in answers));
    return report({ ok: true, answers, usage, durationMs, missing });
  } catch (error) {
    const durationMs = Date.now() - started;
    return report({ ok: false, durationMs, error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timer);
  }
}

/** Per-field `max` aggregation, from TypeSafe's SDE-cascade cookbook.
 *
 * Deliberately not a mean. In their worked example a per-field head reached 0.95
 * on a fabricated value while the holistic head only reached 0.56 — averaging
 * buries exactly the signal the battery exists to catch. One confident flag
 * escalates the whole record. */
export function maxGate(
  answers: Record<string, JevAnswer>,
  threshold: number,
  keys?: string[],
): { fired: boolean; top?: string; value: number; scored: number } {
  let top: string | undefined;
  let value = 0;
  let scored = 0;
  for (const [key, a] of Object.entries(answers)) {
    if (keys && !keys.includes(key)) continue;
    const p = a.noul;
    if (typeof p !== 'number' || Number.isNaN(p)) continue;
    scored++;
    if (p > value) { value = p; top = key; }
  }
  // `scored` exists because `fired: false` with zero usable answers is
  // indistinguishable from `fired: false` with every answer genuinely low, and
  // the first case means the model did not answer at all. Gating on `fired`
  // alone turns a total failure into a silent pass.
  return { fired: scored > 0 && value >= threshold, top, value, scored };
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
