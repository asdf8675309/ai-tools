import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAdvisoryQuestions,
  defaultQuestions,
  evaluateDecision,
  MulticaJevPolicyError,
  parseQuestionsJson,
  validateQuestions,
} from "../src/core.mjs";

// Provider selection reads the ambient environment: an OPENROUTER_API_KEY in
// the shell makes the default provider OpenRouter rather than TypeSafe. Most
// tests below mock the TypeSafe client, so without this the suite does not
// merely fail on a machine that has the key. It sends a real request to
// OpenRouter from a test run. Clear both up front; the one test that exercises
// the OpenRouter path sets them itself and restores them afterwards.
delete process.env.OPENROUTER_API_KEY;
delete process.env.MULTICA_JEV_PROVIDER;

function fakeClient() {
  const calls = [];
  return {
    calls,
    systemOne(request, options) {
      calls.push({ request, options });
      return Promise.resolve({
        model: request.model,
        answers: { human_review: { type: "noul", noul: 0.75 } },
        usage: { input_tokens: 12, output_tokens: 4 },
      });
    },
  };
}

function fakeOpenRouterFetch() {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "openai/test-model",
          answers: {
            route: {
              type: "choice",
              choice: "investigate",
              confidence: 0.8,
              probabilities: { investigate: 0.8, implement: 0.2 },
            },
            risk: {
              type: "score",
              score: 0.75,
              confidence: 0.7,
              probabilities: { "0": 0.6, "1": 0.4 },
            },
            human_review: { type: "noul", noul: 0.9 },
          },
          usage: { input_tokens: 30, output_tokens: 12 },
        };
      },
    };
  };
  return { calls, fetchImpl };
}

test("default triage questions are validated and evaluated together", async () => {
  const client = fakeClient();
  const result = await evaluateDecision({
    state: "A task asks for an evidence-backed implementation.",
    purpose: "triage",
    client,
    model: "jev-pinned",
  });

  assert.equal(result.multica.advisory_only, true);
  assert.equal(result.multica.provider, "typesafe");
  assert.equal(result.multica.protected_actions_require_human, true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].request.model, "jev-pinned");
  assert.deepEqual(Object.keys(client.calls[0].request.questions), [
    "actionability",
    "human_review",
    "risk",
  ]);
});

test("route purpose fans out handler, complexity, and review questions", async () => {
  const client = fakeClient();
  await evaluateDecision({
    state: "A task needs to be assigned to the right next handler.",
    purpose: "route",
    client,
  });

  assert.deepEqual(Object.keys(client.calls[0].request.questions), [
    "destination",
    "complexity",
    "route_review",
  ]);
  assert.equal(client.calls[0].request.questions.destination.type, "choice");
  assert.equal(client.calls[0].request.questions.complexity.type, "score");
  assert.equal(client.calls[0].request.questions.route_review.type, "noul");
});

test("prioritize purpose returns a transparent weighted composite", async () => {
  const calls = [];
  const client = {
    calls,
    systemOne(request) {
      calls.push({ request });
      return Promise.resolve({
        model: request.model,
        answers: {
          impact: { type: "score", score: 2.5, confidence: 0.8 },
          urgency: { type: "score", score: 3, confidence: 0.9 },
          effort: { type: "score", score: 1, confidence: 0.7 },
        },
        usage: { input_tokens: 20, output_tokens: 8 },
      });
    },
  };
  const result = await evaluateDecision({
    state: "Rank this task against the current backlog.",
    purpose: "prioritize",
    client,
  });

  assert.deepEqual(Object.keys(calls[0].request.questions), ["impact", "urgency", "effort"]);
  assert.equal(result.multica.composite.name, "priority");
  assert.equal(result.multica.composite.score, 0.858);
  assert.deepEqual(result.multica.composite.weights, {
    impact: 0.45,
    urgency: 0.35,
    effort_inverse: 0.2,
  });
});

test("openrouter provider preserves native Decisions answers", async () => {
  const { calls, fetchImpl } = fakeOpenRouterFetch();
  const result = await evaluateDecision({
    provider: "openrouter",
    model: "openai/test-model",
    openrouterApiKey: "test-openrouter-key",
    fetchImpl,
    state: "Inspect the task evidence before implementation.",
    purpose: "custom",
    questions: {
      route: {
        type: "choice",
        instructions: "Which work lane fits?",
        criteria: { investigate: null, implement: null },
      },
      risk: {
        type: "score",
        instructions: "How risky is this?",
        criteria: ["low", "high"],
      },
      human_review: {
        type: "noul",
        instructions: "Should a human review the next step?",
      },
    },
  });

  assert.equal(result.multica.provider, "openrouter");
  assert.equal(result.model, "openai/test-model");
  assert.equal(result.answers.route.choice, "investigate");
  assert.equal(result.answers.risk.legend[0], "low");
  assert.equal(result.answers.human_review.noul, 0.9);
  assert.deepEqual(result.usage, { input_tokens: 30, output_tokens: 12 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-openrouter-key");
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.model, "openai/test-model");
  assert.equal(request.state, "Inspect the task evidence before implementation.");
  assert.deepEqual(Object.keys(request.questions), [
    "route",
    "risk",
    "human_review",
  ]);
  assert.equal(request.questions.route.type, "choice");
});

test("openrouter provider requires its own API key", async () => {
  await assert.rejects(
    () => evaluateDecision({
      provider: "openrouter",
      model: "openai/test-model",
      fetchImpl: async () => { throw new Error("should not fetch"); },
      state: "test",
      purpose: "risk",
      openrouterApiKey: "",
    }),
    /OPENROUTER_API_KEY is required/,
  );
});

test("openrouter provider defaults to the TypeSafe Jev route", async () => {
  const { calls, fetchImpl } = fakeOpenRouterFetch();
  await evaluateDecision({
    provider: "openrouter",
    openrouterApiKey: "test-openrouter-key",
    fetchImpl,
    state: "test",
    purpose: "custom",
    questions: {
      route: {
        type: "choice",
        instructions: "Which work lane fits?",
        criteria: { investigate: null, implement: null },
      },
      risk: {
        type: "score",
        instructions: "How risky is this?",
        criteria: ["low", "high"],
      },
      human_review: {
        type: "noul",
        instructions: "Should a human review the next step?",
      },
    },
  });
  assert.equal(JSON.parse(calls[0].options.body).model, "~typesafe/jev-latest");
});

test("openrouter normalizes prompt-friendly custom questions before sending", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          model: "typesafe/jev-latest",
          answers: {
            primary_decision: {
              type: "choice",
              choice: "UI_first",
              confidence: 0.8,
              probabilities: { UI_first: 0.8, Backend_first: 0.2 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 4 },
        };
      },
    };
  };
  await evaluateDecision({
    provider: "openrouter",
    openrouterApiKey: "test-openrouter-key",
    fetchImpl,
    state: "Choose a software planning sequence.",
    purpose: "custom",
    questions: {
      primary_decision: {
        type: "choice",
        question: "What should be planned first?",
        options: ["UI first", "Backend first"],
      },
    },
  });

  const request = JSON.parse(calls[0].options.body);
  assert.deepEqual(request.questions.primary_decision, {
    type: "choice",
    instructions: "What should be planned first?",
    criteria: {
      UI_first: "UI first",
      Backend_first: "Backend first",
    },
  });
});

test("an OpenRouter key selects OpenRouter when no provider is specified", async () => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousProvider = process.env.MULTICA_JEV_PROVIDER;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  delete process.env.MULTICA_JEV_PROVIDER;
  try {
    const { calls, fetchImpl } = fakeOpenRouterFetch();
    const result = await evaluateDecision({
      fetchImpl,
      state: "test",
      purpose: "custom",
      questions: {
        route: {
          type: "choice",
          instructions: "Which work lane fits?",
          criteria: { investigate: null, implement: null },
        },
        risk: {
          type: "score",
          instructions: "How risky is this?",
          criteria: ["low", "high"],
        },
        human_review: {
          type: "noul",
          instructions: "Should a human review the next step?",
        },
      },
    });
    assert.equal(result.multica.provider, "openrouter");
    assert.equal(JSON.parse(calls[0].options.body).model, "~typesafe/jev-latest");
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousProvider === undefined) delete process.env.MULTICA_JEV_PROVIDER;
    else process.env.MULTICA_JEV_PROVIDER = previousProvider;
  }
});

test("custom questions are passed as typed primitives", async () => {
  const client = fakeClient();
  await evaluateDecision({
    state: { issue: "MUL-1", description: "Inspect the logs" },
    purpose: "custom",
    questions: {
      route: { type: "choice", instructions: "Which lane?", criteria: { codex: null, claude: null } },
      urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "high"] },
      escalate: { type: "noul", instructions: "Escalate to a human?" },
    },
    client,
  });

  assert.equal(client.calls[0].request.questions.route.type, "choice");
  assert.equal(client.calls[0].request.questions.urgency.type, "score");
  assert.equal(client.calls[0].request.questions.escalate.type, "noul");
});

test("custom choice questions accept prompt-friendly question and options aliases", async () => {
  const client = fakeClient();
  await evaluateDecision({
    state: "Choose a software planning sequence.",
    purpose: "custom",
    questions: {
      primary_decision: {
        type: "choice",
        question: "What should be planned first?",
        options: ["UI first", "Backend first", "Both in parallel"],
      },
    },
    client,
  });

  const question = client.calls[0].request.questions.primary_decision;
  assert.equal(question.type, "choice");
  assert.equal(question.instructions, "What should be planned first?");
  assert.deepEqual(Object.keys(question.criteria), [
    "UI_first",
    "Backend_first",
    "Both_in_parallel",
  ]);
});

test("protected custom judgments are rejected before the API call", () => {
  assert.throws(
    () => assertAdvisoryQuestions({ real: { instructions: "Is this finding real?" } }),
    MulticaJevPolicyError,
  );
  assert.throws(
    () => assertAdvisoryQuestions({ resolve: { instructions: "Should we resolve this review thread?" } }),
    MulticaJevPolicyError,
  );
  assert.throws(
    () => assertAdvisoryQuestions({ card: { instructions: "Should we create a card for this?" } }),
    MulticaJevPolicyError,
  );
});

test("validation rejects malformed and oversized question sets", () => {
  assert.throws(() => validateQuestions({ nope: { type: "score", criteria: ["only one"] } }), MulticaJevPolicyError);
  assert.throws(
    () => validateQuestions(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, { type: "noul" }]))),
    MulticaJevPolicyError,
  );
});

test("custom purpose requires explicit questions", () => {
  assert.throws(() => defaultQuestions("custom"), MulticaJevPolicyError);
  assert.deepEqual(parseQuestionsJson(undefined), undefined);
  assert.deepEqual(parseQuestionsJson('{"ok":{"type":"noul"}}'), { ok: { type: "noul" } });
});
