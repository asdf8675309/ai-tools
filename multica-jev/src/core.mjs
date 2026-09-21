import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_PROVIDER = "typesafe";
const DEFAULT_OPENROUTER_MODEL = "~typesafe/jev-latest";
const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_MAX_STATE_CHARS = 200_000;
const MAX_QUESTIONS = 16;
const MAX_CHOICE_CRITERIA = 255;
const MAX_SCORE_CRITERIA = 10;

const PURPOSES = new Set(["triage", "risk", "review", "route", "prioritize", "custom"]);
const PROVIDERS = new Set(["typesafe", "openrouter"]);

// These are policy boundaries, not model prompts. A custom question that asks
// Jev to make one of these judgments must be handled by a human or supervisor.
const PROTECTED_DECISION_PATTERNS = [
  /resolv(?:e|ing).*review\s+thread/i,
  /(?:is|whether).*finding.*real/i,
  /(?:scope|scoping).*card/i,
  /(?:create|creating).*card/i,
  /decision[- ]gated/i,
];

export class MulticaJevPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MulticaJevPolicyError";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEntryType(value, field) {
  if (value === null || typeof value === "string") return;
  if (Array.isArray(value)) return;
  if (isRecord(value)) return;
  throw new MulticaJevPolicyError(`${field} must be a string, object, array, or null`);
}

function optionKey(value, index, used) {
  const text = typeof value === "string" ? value : `option ${index + 1}`;
  let key = text
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-zA-Z]/.test(key)) key = `option_${key}`;
  if (!key) key = `option_${index + 1}`;
  key = key.slice(0, 64);
  const base = key;
  let suffix = 2;
  while (used.has(key)) {
    const suffixText = `_${suffix}`;
    key = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

function normalizeChoiceCriteria(criteria, name) {
  if (Array.isArray(criteria)) {
    const normalized = {};
    const used = new Set();
    criteria.forEach((option, index) => {
      const optionRecord = isRecord(option) ? option : null;
      const label = optionRecord?.key ?? optionRecord?.label ?? optionRecord?.name ?? option;
      const description = optionRecord?.description ?? optionRecord?.instructions ?? label;
      if (typeof label !== "string") {
        throw new MulticaJevPolicyError(
          `Question "${name}" choice options must be strings or objects with a label`,
        );
      }
      normalized[optionKey(label, index, used)] = description;
    });
    return normalized;
  }

  if (!isRecord(criteria)) return criteria;
  const normalized = {};
  const used = new Set();
  for (const [key, description] of Object.entries(criteria)) {
    const normalizedKey = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)
      ? key
      : optionKey(key, Object.keys(normalized).length, used);
    if (used.has(normalizedKey)) {
      throw new MulticaJevPolicyError(`Question "${name}" contains duplicate choice keys`);
    }
    used.add(normalizedKey);
    normalized[normalizedKey] = description;
  }
  return normalized;
}

function normalizeQuestion(name, question) {
  if (!isRecord(question)) {
    throw new MulticaJevPolicyError(`Question "${name}" must be an object`);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) {
    throw new MulticaJevPolicyError(`Question name "${name}" is not a safe identifier`);
  }
  if (!["choice", "score", "noul"].includes(question.type)) {
    throw new MulticaJevPolicyError(
      `Question "${name}" must have type choice, score, or noul; `
      + "choice questions use criteria or an options array",
    );
  }
  const instructions = question.instructions ?? question.question;
  const criteria = question.criteria ?? question.options ?? question.levels;
  assertEntryType(instructions, `Question "${name}" instructions`);

  if (question.type === "noul") {
    if (criteria !== undefined) assertEntryType(criteria, `Question "${name}" criteria`);
    return noul(instructions ?? null, criteria);
  }

  if (question.type === "choice") {
    const normalizedCriteria = normalizeChoiceCriteria(criteria, name);
    if (!isRecord(normalizedCriteria) || Array.isArray(normalizedCriteria)) {
      throw new MulticaJevPolicyError(`Question "${name}" choice criteria must be an object`);
    }
    const entries = Object.entries(normalizedCriteria);
    if (entries.length < 2 || entries.length > MAX_CHOICE_CRITERIA) {
      throw new MulticaJevPolicyError(
        `Question "${name}" must have 2-${MAX_CHOICE_CRITERIA} choice criteria`,
      );
    }
    for (const [key, description] of entries) {
      assertEntryType(description, `Choice "${name}" option "${key}"`);
    }
    return choice(instructions ?? null, normalizedCriteria);
  }

  if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > MAX_SCORE_CRITERIA) {
    throw new MulticaJevPolicyError(
      `Question "${name}" score criteria must contain 2-${MAX_SCORE_CRITERIA} levels`,
    );
  }
  criteria.forEach((description, index) => {
    assertEntryType(description, `Question "${name}" score level ${index}`);
  });
  return score(instructions ?? null, criteria);
}

export function validateQuestions(questions) {
  if (!isRecord(questions)) {
    throw new MulticaJevPolicyError("questions must be an object");
  }
  const entries = Object.entries(questions);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) {
    throw new MulticaJevPolicyError(`questions must contain 1-${MAX_QUESTIONS} entries`);
  }
  return Object.fromEntries(entries.map(([name, question]) => [name, normalizeQuestion(name, question)]));
}

export function assertAdvisoryQuestions(questions) {
  const serialized = JSON.stringify(questions);
  const match = PROTECTED_DECISION_PATTERNS.find((pattern) => pattern.test(serialized));
  if (match) {
    throw new MulticaJevPolicyError(
      "This plugin will not automate a protected Multica judgment. Ask the human or supervising session instead.",
    );
  }
}

export function defaultQuestions(purpose) {
  switch (purpose) {
    case "triage":
      return {
        actionability: {
          type: "choice",
          instructions: "What is the most useful immediate work mode for this task?",
          criteria: {
            investigate: "Gather evidence or inspect the current state before changing anything.",
            implement: "The task has a clear implementation path and can be worked directly.",
            report: "Produce a report or receipt; do not infer that code changes are required.",
            wait: "Progress depends on an explicit human decision or missing input.",
            other: "None of the listed work modes clearly fits.",
          },
        },
        human_review: {
          type: "noul",
          instructions: "Should a human or supervising session review the next consequential step?",
        },
        risk: {
          type: "score",
          instructions: "How much operational risk is present in the described task?",
          criteria: [
            "Low: read-only or easily reversible work.",
            "Moderate: a scoped change with a normal verification path.",
            "High: external side effects, sensitive data, or difficult rollback.",
            "Critical: broad, irreversible, or production-impacting consequences.",
          ],
        },
      };
    case "risk":
      return {
        external_side_effect: {
          type: "noul",
          instructions: "Would acting on this state cause an external side effect outside the local worktree?",
        },
        sensitive_data: {
          type: "noul",
          instructions: "Does this state contain or request handling of sensitive credentials or personal data?",
        },
        risk: {
          type: "score",
          instructions: "How much operational risk is present in the described task?",
          criteria: [
            "Low: read-only or easily reversible work.",
            "Moderate: a scoped change with a normal verification path.",
            "High: external side effects, sensitive data, or difficult rollback.",
            "Critical: broad, irreversible, or production-impacting consequences.",
          ],
        },
      };
    case "review":
      return {
        human_review: {
          type: "noul",
          instructions: "Should a human or supervising session review the next consequential step?",
        },
        evidence_gap: {
          type: "noul",
          instructions: "Is important evidence still missing before the agent should make a consequential change?",
        },
      };
    case "route":
      return {
        destination: {
          type: "choice",
          instructions: "Which handler should receive this task next?",
          criteria: {
            deterministic: "A known lookup or deterministic operation is sufficient.",
            coding_agent: "A coding or implementation agent should handle the task.",
            research_agent: "Evidence gathering or analysis is needed before implementation.",
            human: "A human or supervising session should handle the next step.",
            other: "None of the listed handlers clearly fits this task.",
          },
        },
        complexity: {
          type: "score",
          instructions: "How complex is this task for its receiving handler?",
          criteria: [
            "Low: bounded, familiar, and easy to verify.",
            "Moderate: a scoped task with several interacting details.",
            "High: substantial uncertainty, dependencies, or verification effort.",
            "Critical: broad, ambiguous, or difficult to reverse safely.",
          ],
        },
        route_review: {
          type: "noul",
          instructions: "Should a human or supervising session verify this route before the next consequential step?",
        },
      };
    case "prioritize":
      return {
        impact: {
          type: "score",
          instructions: "How much useful impact would completing this task provide?",
          criteria: [
            "Low: little user or system benefit.",
            "Moderate: a meaningful improvement for a limited scope.",
            "High: a substantial improvement for important users or workflows.",
            "Critical: major user, business, or reliability impact.",
          ],
        },
        urgency: {
          type: "score",
          instructions: "How urgent is this task relative to other work?",
          criteria: [
            "Low: no meaningful time pressure.",
            "Moderate: should be addressed in the normal planning cycle.",
            "High: delay would create material cost or risk.",
            "Immediate: delay would cause imminent harm or a deadline miss.",
          ],
        },
        effort: {
          type: "score",
          instructions: "How much effort will this task require to complete and verify?",
          criteria: [
            "Small: bounded change with straightforward verification.",
            "Moderate: a scoped task with several interacting details.",
            "Large: substantial implementation or verification work.",
            "Very large: broad, uncertain, or dependency-heavy work.",
          ],
        },
      };
    case "custom":
      throw new MulticaJevPolicyError("purpose=custom requires a questions object");
    default:
    throw new MulticaJevPolicyError(`Unknown purpose "${purpose}"`);
  }
}

function assertState(state, maximumChars) {
  if (typeof state !== "string" && !isRecord(state) && !Array.isArray(state)) {
    throw new MulticaJevPolicyError("state must be a string, object, or array");
  }
  const serialized = typeof state === "string" ? state : JSON.stringify(state);
  if (serialized.length > maximumChars) {
    throw new MulticaJevPolicyError(
      `state is ${serialized.length} characters; refusing to truncate beyond ${maximumChars}`,
    );
  }
  return state;
}

function priorityComposite(answers) {
  const names = ["impact", "urgency", "effort"];
  const scores = Object.fromEntries(names.map((name) => {
    const answer = answers[name];
    if (!isRecord(answer) || answer.type !== "score" || typeof answer.score !== "number") {
      throw new Error(`Jev returned an invalid score for ${name}`);
    }
    return [name, Math.min(1, Math.max(0, answer.score / 3))];
  }));
  const effortInverse = 1 - scores.effort;
  const score = (0.45 * scores.impact) + (0.35 * scores.urgency) + (0.20 * effortInverse);
  return {
    name: "priority",
    score: Number(score.toFixed(3)),
    scale: "0..1; higher means earlier attention",
    weights: { impact: 0.45, urgency: 0.35, effort_inverse: 0.20 },
    components: {
      impact: Number(scores.impact.toFixed(3)),
      urgency: Number(scores.urgency.toFixed(3)),
      effort_inverse: Number(effortInverse.toFixed(3)),
    },
  };
}

function integerFromEnv(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function selectedProvider(provider) {
  const value = provider
    ?? process.env.MULTICA_JEV_PROVIDER
    ?? (process.env.OPENROUTER_API_KEY ? "openrouter" : DEFAULT_PROVIDER);
  if (!PROVIDERS.has(value)) {
    throw new MulticaJevPolicyError(
      `provider must be one of ${[...PROVIDERS].join(", ")}`,
    );
  }
  return value;
}

function selectedModel(provider, model) {
  if (model) return model;
  if (provider === "openrouter") {
    const configured = process.env.MULTICA_JEV_MODEL
      ?? process.env.OPENROUTER_MODEL
    return configured ?? DEFAULT_OPENROUTER_MODEL;
  }
  return process.env.MULTICA_JEV_MODEL ?? process.env.TYPESAFE_MODEL ?? DEFAULT_MODEL;
}

function assertProbability(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
}

function assertProbabilityMap(value, keys, label) {
  if (!isRecord(value) || Object.keys(value).length !== keys.length) {
    throw new Error(`${label} must contain probabilities for exactly ${keys.join(", ")}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} is missing probability for ${key}`);
    }
    assertProbability(value[key], `${label}.${key}`);
  }
}

function normalizeOpenRouterAnswers(value, questions) {
  if (!isRecord(value)) throw new Error("OpenRouter response did not contain an answers object");
  const answerNames = Object.keys(questions);
  if (Object.keys(value).length !== answerNames.length) {
    throw new Error("OpenRouter response contained an unexpected set of answers");
  }

  return Object.fromEntries(answerNames.map((name) => {
    const question = questions[name];
    const answer = value[name];
    if (!isRecord(answer) || answer.type !== question.type) {
      throw new Error(`OpenRouter returned an invalid answer for ${name}`);
    }

    if (question.type === "noul") {
      assertProbability(answer.noul, `${name}.noul`);
      return [name, { type: "noul", noul: answer.noul }];
    }

    assertProbability(answer.confidence, `${name}.confidence`);
    if (question.type === "choice") {
      const labels = Object.keys(question.criteria);
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) {
        throw new Error(`OpenRouter returned an invalid choice for ${name}`);
      }
      assertProbabilityMap(answer.probabilities, labels, `${name}.probabilities`);
      return [name, {
        type: "choice",
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
      }];
    }

    const scoreKeys = question.criteria.map((_, index) => String(index));
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score)
      || answer.score < 0 || answer.score > question.criteria.length - 1) {
      throw new Error(`OpenRouter returned an invalid score for ${name}`);
    }
    assertProbabilityMap(answer.probabilities, scoreKeys, `${name}.probabilities`);
    return [name, {
      type: "score",
      score: answer.score,
      confidence: answer.confidence,
      legend: Object.fromEntries(question.criteria.map((description, index) => [index, description])),
      probabilities: answer.probabilities,
    }];
  }));
}

async function evaluateWithOpenRouter({
  state,
  questions,
  model,
  signal,
  fetchImpl,
  apiKey,
}) {
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required when provider=openrouter");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is unavailable; provider=openrouter requires Node 20 or newer");
  }

  const response = await fetchImpl(OPENROUTER_DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(process.env.OPENROUTER_HTTP_REFERER
        ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER }
        : {}),
      ...(process.env.OPENROUTER_APP_TITLE
        ? { "X-OpenRouter-Title": process.env.OPENROUTER_APP_TITLE }
        : {}),
    },
    body: JSON.stringify({
      model,
      state,
      questions,
    }),
    signal,
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error?.message ?? response.statusText ?? "request failed";
    throw new Error(`OpenRouter request failed (${response.status}): ${message}`);
  }
  // A success status with an unreadable body reaches here with payload null.
  // Without this the next line throws a TypeError naming a property, which
  // tells the caller nothing about what went wrong.
  if (!isRecord(payload)) {
    throw new Error(
      `OpenRouter returned ${response.status} with a body that is not a JSON object`,
    );
  }

  return {
    model: payload.model ?? model,
    answers: normalizeOpenRouterAnswers(payload.answers, questions),
    usage: {
      input_tokens: payload.usage?.input_tokens ?? payload.usage?.prompt_tokens ?? 0,
      output_tokens: payload.usage?.output_tokens ?? payload.usage?.completion_tokens ?? 0,
    },
  };
}

export async function evaluateDecision({
  state,
  purpose = "triage",
  questions,
  provider,
  model,
  client,
  signal,
  fetchImpl = globalThis.fetch,
  openrouterApiKey = process.env.OPENROUTER_API_KEY,
  maxStateChars = integerFromEnv(
    "MULTICA_JEV_MAX_STATE_CHARS",
    DEFAULT_MAX_STATE_CHARS,
    1_000,
    1_000_000,
  ),
}) {
  if (!PURPOSES.has(purpose)) {
    throw new MulticaJevPolicyError(`purpose must be one of ${[...PURPOSES].join(", ")}`);
  }
  const safeState = assertState(state, maxStateChars);
  const requestedQuestions = questions ?? defaultQuestions(purpose);
  if (purpose === "custom") assertAdvisoryQuestions(requestedQuestions);
  const normalizedQuestions = validateQuestions(requestedQuestions);
  if (purpose !== "custom") assertAdvisoryQuestions(normalizedQuestions);

  const selected = selectedProvider(provider);
  const resolvedModel = selectedModel(selected, model);
  const response = selected === "openrouter"
    ? await evaluateWithOpenRouter({
      state: safeState,
      questions: normalizedQuestions,
      model: resolvedModel,
      signal,
      fetchImpl,
      apiKey: openrouterApiKey,
    })
    : await (client ?? new TypeSafeClient({ defaultModel: resolvedModel })).systemOne(
      {
        model: resolvedModel,
        state: safeState,
        questions: normalizedQuestions,
      },
      signal ? { signal } : undefined,
    );

  const multica = {
    provider: selected,
    purpose,
    advisory_only: true,
    protected_actions_require_human: true,
  };
  if (purpose === "prioritize") multica.composite = priorityComposite(response.answers);

  return {
    model: response.model,
    answers: response.answers,
    usage: response.usage,
    multica,
  };
}

export function parseQuestionsJson(value) {
  if (value === undefined || value === null || value.trim() === "") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new MulticaJevPolicyError(`questions_json is not valid JSON: ${error.message}`);
  }
  return parsed;
}

export function publicErrorMessage(error) {
  if (error instanceof MulticaJevPolicyError) return error.message;
  if (error && typeof error.message === "string") return error.message;
  return String(error);
}

export const protectedDecisionPolicy = Object.freeze([
  "resolving a review thread",
  "judging whether a finding is real",
  "scoping or creating a card",
  "deciding an issue is decision-gated",
]);
