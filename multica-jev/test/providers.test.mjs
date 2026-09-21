import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDecision, MulticaJevPolicyError } from "../src/core.mjs";

// See test/core.test.mjs for why this is here: provider selection reads the
// ambient environment, so a key in the shell would send a mocked test to a
// live endpoint. Each test below sets the variables it needs and restores them.
delete process.env.OPENROUTER_API_KEY;
delete process.env.MULTICA_JEV_PROVIDER;
delete process.env.MULTICA_JEV_MODEL;
delete process.env.OPENROUTER_MODEL;
delete process.env.TYPESAFE_MODEL;

const PROVIDER_ENV = [
  "OPENROUTER_API_KEY",
  "MULTICA_JEV_PROVIDER",
  "MULTICA_JEV_MODEL",
  "OPENROUTER_MODEL",
  "TYPESAFE_MODEL",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_APP_TITLE",
  "MULTICA_JEV_MAX_STATE_CHARS",
];

// This must await run(). Returning the promise from a synchronous try/finally
// restores the environment at the callback's first await rather than at its
// end, which leaves the tests passing only because evaluateDecision happens to
// read the environment before it awaits anything.
async function withEnv(values, run) {
  const saved = Object.fromEntries(PROVIDER_ENV.map((key) => [key, process.env[key]]));
  for (const key of PROVIDER_ENV) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const key of PROVIDER_ENV) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

// Records what reached the TypeSafe transport without performing any request.
function recordingClient(answers = {}) {
  const calls = [];
  return {
    calls,
    systemOne(request, options) {
      calls.push({ request, options });
      return { model: request.model, answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

function noulQuestion() {
  return { only: { type: "noul", instructions: "Is anything blocked?" } };
}

function recordingFetch(payload, { status = 200, json = true } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "Test Status",
      json: async () => {
        if (!json) throw new SyntaxError("not json");
        return payload;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

function openRouterNoulPayload(value = 0.5) {
  return { model: "served-model", answers: { only: { type: "noul", noul: value } }, usage: {} };
}

test("an explicit provider argument overrides MULTICA_JEV_PROVIDER", async () => {
  await withEnv({ MULTICA_JEV_PROVIDER: "openrouter", OPENROUTER_API_KEY: "key" }, async () => {
    const client = recordingClient({ only: { type: "noul", noul: 0.2 } });
    const fetchImpl = recordingFetch(openRouterNoulPayload());
    const result = await evaluateDecision({
      state: "s",
      purpose: "custom",
      questions: noulQuestion(),
      provider: "typesafe",
      client,
      fetchImpl,
    });
    assert.equal(result.multica.provider, "typesafe");
    assert.equal(client.calls.length, 1);
    assert.equal(fetchImpl.calls.length, 0, "no HTTP call may happen on the typesafe path");
  });
});

test("MULTICA_JEV_PROVIDER=typesafe forces TypeSafe even when an OpenRouter key is present", async () => {
  await withEnv({ MULTICA_JEV_PROVIDER: "typesafe", OPENROUTER_API_KEY: "key" }, async () => {
    const client = recordingClient({ only: { type: "noul", noul: 0.2 } });
    const fetchImpl = recordingFetch(openRouterNoulPayload());
    const result = await evaluateDecision({
      state: "s",
      purpose: "custom",
      questions: noulQuestion(),
      client,
      fetchImpl,
    });
    assert.equal(result.multica.provider, "typesafe");
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test("an unknown provider is refused before any transport is touched", async () => {
  const client = recordingClient();
  const fetchImpl = recordingFetch(openRouterNoulPayload());
  await assert.rejects(
    () => evaluateDecision({
      state: "s",
      purpose: "custom",
      questions: noulQuestion(),
      provider: "anthropic",
      client,
      fetchImpl,
    }),
    (error) => error instanceof MulticaJevPolicyError && /provider must be one of/.test(error.message),
  );
  assert.equal(client.calls.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test("TypeSafe model precedence is argument, then MULTICA_JEV_MODEL, then TYPESAFE_MODEL, then the default", async () => {
  const resolve = async (env, model) => {
    let seen;
    await withEnv(env, async () => {
      const client = recordingClient({ only: { type: "noul", noul: 0.1 } });
      await evaluateDecision({
        state: "s",
        purpose: "custom",
        questions: noulQuestion(),
        provider: "typesafe",
        model,
        client,
      });
      seen = client.calls[0].request.model;
    });
    return seen;
  };

  assert.equal(
    await resolve({ MULTICA_JEV_MODEL: "env-a", TYPESAFE_MODEL: "env-b" }, "explicit"),
    "explicit",
  );
  assert.equal(await resolve({ MULTICA_JEV_MODEL: "env-a", TYPESAFE_MODEL: "env-b" }), "env-a");
  assert.equal(await resolve({ TYPESAFE_MODEL: "env-b" }), "env-b");
  assert.equal(await resolve({}), "jev-latest");
});

test("OpenRouter model precedence is argument, then MULTICA_JEV_MODEL, then OPENROUTER_MODEL, then the default", async () => {
  const resolve = async (env, model) => {
    let seen;
    await withEnv({ ...env, OPENROUTER_API_KEY: "key" }, async () => {
      const fetchImpl = recordingFetch(openRouterNoulPayload());
      await evaluateDecision({
        state: "s",
        purpose: "custom",
        questions: noulQuestion(),
        provider: "openrouter",
        model,
        fetchImpl,
      });
      seen = JSON.parse(fetchImpl.calls[0].init.body).model;
    });
    return seen;
  };

  assert.equal(
    await resolve({ MULTICA_JEV_MODEL: "env-a", OPENROUTER_MODEL: "env-b" }, "explicit"),
    "explicit",
  );
  assert.equal(await resolve({ MULTICA_JEV_MODEL: "env-a", OPENROUTER_MODEL: "env-b" }), "env-a");
  assert.equal(await resolve({ OPENROUTER_MODEL: "env-b" }), "env-b");
  assert.equal(await resolve({}), "~typesafe/jev-latest");
});

test("the OpenRouter request is a flat body posted to the Decisions endpoint with bearer auth", async () => {
  await withEnv({ OPENROUTER_API_KEY: "secret-key" }, async () => {
    const fetchImpl = recordingFetch(openRouterNoulPayload());
    await evaluateDecision({
      state: "the state",
      purpose: "custom",
      questions: noulQuestion(),
      provider: "openrouter",
      model: "pinned",
      fetchImpl,
    });

    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer secret-key");
    assert.equal(init.headers["Content-Type"], "application/json");

    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
    assert.equal(body.state, "the state", "state is flat, not wrapped in an input object");
    assert.equal(body.model, "pinned");
    assert.equal(body.input, undefined, "the Workers AI input wrapper must not appear here");
  });
});

test("optional OpenRouter attribution headers are sent only when their variables are set", async () => {
  await withEnv({ OPENROUTER_API_KEY: "key" }, async () => {
    const bare = recordingFetch(openRouterNoulPayload());
    await evaluateDecision({
      state: "s", purpose: "custom", questions: noulQuestion(), provider: "openrouter", fetchImpl: bare,
    });
    assert.equal(bare.calls[0].init.headers["HTTP-Referer"], undefined);
    assert.equal(bare.calls[0].init.headers["X-OpenRouter-Title"], undefined);
  });

  await withEnv(
    { OPENROUTER_API_KEY: "key", OPENROUTER_HTTP_REFERER: "https://example.test", OPENROUTER_APP_TITLE: "Title" },
    async () => {
      const tagged = recordingFetch(openRouterNoulPayload());
      await evaluateDecision({
        state: "s", purpose: "custom", questions: noulQuestion(), provider: "openrouter", fetchImpl: tagged,
      });
      assert.equal(tagged.calls[0].init.headers["HTTP-Referer"], "https://example.test");
      assert.equal(tagged.calls[0].init.headers["X-OpenRouter-Title"], "Title");
    },
  );
});

test("the abort signal reaches the OpenRouter transport", async () => {
  await withEnv({ OPENROUTER_API_KEY: "key" }, async () => {
    const controller = new AbortController();
    const fetchImpl = recordingFetch(openRouterNoulPayload());
    await evaluateDecision({
      state: "s",
      purpose: "custom",
      questions: noulQuestion(),
      provider: "openrouter",
      signal: controller.signal,
      fetchImpl,
    });
    assert.equal(fetchImpl.calls[0].init.signal, controller.signal);
  });
});

test("a failed OpenRouter response surfaces its status even when the body is not JSON", async () => {
  await withEnv({ OPENROUTER_API_KEY: "key" }, async () => {
    const fetchImpl = recordingFetch(null, { status: 429, json: false });
    await assert.rejects(
      () => evaluateDecision({
        state: "s", purpose: "custom", questions: noulQuestion(), provider: "openrouter", fetchImpl,
      }),
      /OpenRouter request failed \(429\)/,
    );
  });
});

// A remote answer set is untrusted input. Each case below is a distinct way a
// well-formed HTTP 200 can still carry an answer this package must not pass on.
const MALFORMED_ANSWERS = [
  {
    label: "an answer for a question that was never asked",
    questions: noulQuestion(),
    answers: { only: { type: "noul", noul: 0.5 }, extra: { type: "noul", noul: 0.5 } },
    expected: /unexpected set of answers/,
  },
  {
    label: "an answer whose type does not match the question",
    questions: noulQuestion(),
    answers: { only: { type: "choice", choice: "a", confidence: 0.5, probabilities: { a: 1 } } },
    expected: /invalid answer for only/,
  },
  {
    label: "a noul probability above one",
    questions: noulQuestion(),
    answers: { only: { type: "noul", noul: 1.4 } },
    expected: /only\.noul must be a number between 0 and 1/,
  },
  {
    label: "a choice label that was never offered",
    questions: { pick: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } } },
    answers: { pick: { type: "choice", choice: "c", confidence: 0.9, probabilities: { a: 0.5, b: 0.5 } } },
    expected: /invalid choice for pick/,
  },
  {
    label: "a probability map missing one of the offered labels",
    questions: { pick: { type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } } },
    answers: { pick: { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 1 } } },
    expected: /pick\.probabilities must contain probabilities for exactly a, b/,
  },
  {
    label: "a score outside the range its levels define",
    questions: { level: { type: "score", instructions: "How much?", criteria: ["low", "high"] } },
    answers: { level: { type: "score", score: 7, confidence: 0.9, probabilities: { 0: 0.5, 1: 0.5 } } },
    expected: /invalid score for level/,
  },
];

for (const { label, questions, answers, expected } of MALFORMED_ANSWERS) {
  test(`an OpenRouter response is rejected when it contains ${label}`, async () => {
    await withEnv({ OPENROUTER_API_KEY: "key" }, async () => {
      const fetchImpl = recordingFetch({ model: "m", answers, usage: {} });
      await assert.rejects(
        () => evaluateDecision({
          state: "s", purpose: "custom", questions, provider: "openrouter", fetchImpl,
        }),
        expected,
      );
    });
  });
}

test("a well-formed OpenRouter score answer keeps its legend and probabilities", async () => {
  await withEnv({ OPENROUTER_API_KEY: "key" }, async () => {
    const fetchImpl = recordingFetch({
      model: "served",
      answers: {
        level: { type: "score", score: 1.5, confidence: 0.8, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 } },
      },
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    const result = await evaluateDecision({
      state: "s",
      purpose: "custom",
      questions: { level: { type: "score", instructions: "How much?", criteria: ["low", "mid", "high"] } },
      provider: "openrouter",
      fetchImpl,
    });
    assert.equal(result.model, "served");
    assert.equal(result.answers.level.score, 1.5, "an interpolated score between levels is preserved");
    assert.deepEqual(result.answers.level.legend, { 0: "low", 1: "mid", 2: "high" });
    assert.deepEqual(result.answers.level.probabilities, { 0: 0.1, 1: 0.4, 2: 0.5 });
    assert.equal(result.usage.input_tokens, 4);
  });
});

test("oversized state is refused rather than truncated, before any transport is touched", async () => {
  await withEnv({ MULTICA_JEV_MAX_STATE_CHARS: "1000" }, async () => {
    const client = recordingClient();
    await assert.rejects(
      () => evaluateDecision({
        state: "x".repeat(1001),
        purpose: "custom",
        questions: noulQuestion(),
        provider: "typesafe",
        client,
      }),
      (error) => error instanceof MulticaJevPolicyError && /refusing to truncate/.test(error.message),
    );
    assert.equal(client.calls.length, 0);
  });
});
