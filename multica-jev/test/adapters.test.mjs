import assert from "node:assert/strict";
import test from "node:test";

import MulticaJevOpenCodePlugin from "../adapters/opencode.mjs";
import MulticaJevPiExtension from "../adapters/pi.mjs";

// See test/core.test.mjs. The adapters call evaluateDecision without a client
// or a fetch override, so these tests drive the real core and control the
// transport by replacing globalThis.fetch instead of mocking the module.
delete process.env.OPENROUTER_API_KEY;
delete process.env.MULTICA_JEV_PROVIDER;

const ADAPTER_ENV = ["OPENROUTER_API_KEY", "MULTICA_JEV_PROVIDER", "MULTICA_JEV_MODEL", "OPENROUTER_MODEL"];

// Every adapter test runs against the OpenRouter path because it is the one
// reachable without a vendor SDK client. The stub records what was sent.
async function withStubbedTransport(run, { status = 200, payload } = {}) {
  const saved = Object.fromEntries(ADAPTER_ENV.map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  for (const key of ADAPTER_ENV) delete process.env[key];
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.MULTICA_JEV_PROVIDER = "openrouter";

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "Test Status",
      json: async () => payload ?? defaultPayload(JSON.parse(init.body).questions),
    };
  };

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of ADAPTER_ENV) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

// Builds an answer set that matches whatever questions the adapter sent, so a
// test asserts on adapter behaviour rather than on a hand-copied question list.
function defaultPayload(questions) {
  const answers = Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    if (question.type === "noul") return [name, { type: "noul", noul: 0.25 }];
    if (question.type === "choice") {
      const labels = Object.keys(question.criteria);
      const share = 1 / labels.length;
      return [name, {
        type: "choice",
        choice: labels[0],
        confidence: 0.7,
        probabilities: Object.fromEntries(labels.map((label) => [label, share])),
      }];
    }
    const levels = question.criteria.map((_, index) => String(index));
    return [name, {
      type: "score",
      score: 1,
      confidence: 0.6,
      probabilities: Object.fromEntries(levels.map((level) => [level, 1 / levels.length])),
    }];
  }));
  return { model: "served-model", answers, usage: { input_tokens: 3, output_tokens: 1 } };
}

async function openCodeTool() {
  const plugin = await MulticaJevOpenCodePlugin();
  return plugin.tool.multica_jev_decide;
}

function piTool() {
  const registered = [];
  MulticaJevPiExtension({ registerTool: (definition) => registered.push(definition) });
  return { registered, tool: registered[0] };
}

test("the OpenCode plugin registers one tool with the documented argument names", async () => {
  const plugin = await MulticaJevOpenCodePlugin();
  assert.deepEqual(Object.keys(plugin.tool), ["multica_jev_decide"]);
  const entry = plugin.tool.multica_jev_decide;
  assert.equal(typeof entry.execute, "function");
  assert.deepEqual(
    Object.keys(entry.args).sort(),
    ["model", "provider", "purpose", "questions_json", "state"],
  );
  assert.match(entry.description, /never changes Multica/);
});

test("the Pi extension registers one tool with the documented argument names", () => {
  const { registered, tool } = piTool();
  assert.equal(registered.length, 1);
  assert.equal(tool.name, "multica_jev_decide");
  assert.deepEqual(
    Object.keys(tool.parameters.properties).sort(),
    ["model", "provider", "purpose", "questions_json", "state"],
  );
  assert.deepEqual(tool.parameters.required, ["state"]);
});

test("the OpenCode adapter returns the decision as parseable JSON carrying the advisory marker", async () => {
  await withStubbedTransport(async (calls) => {
    const entry = await openCodeTool();
    const output = await entry.execute({ state: "a task needing triage" });

    assert.equal(typeof output, "string");
    const parsed = JSON.parse(output);
    assert.equal(parsed.multica.advisory_only, true);
    assert.equal(parsed.multica.provider, "openrouter");
    assert.equal(parsed.multica.purpose, "triage");
    assert.equal(parsed.model, "served-model");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.state, "a task needing triage");
  });
});

test("the Pi adapter returns text content and a structured details payload", async () => {
  await withStubbedTransport(async () => {
    const { tool } = piTool();
    const output = await tool.execute("call-1", { state: "a task needing triage" });

    assert.equal(output.content[0].type, "text");
    assert.deepEqual(JSON.parse(output.content[0].text), output.details);
    assert.equal(output.details.multica.advisory_only, true);
    assert.equal(output.details.multica.purpose, "triage");
  });
});

test("both adapters default an absent purpose to triage", async () => {
  await withStubbedTransport(async (calls) => {
    const entry = await openCodeTool();
    await entry.execute({ state: "s" });
    await entry.execute({ state: "s", purpose: "" });
    const { tool } = piTool();
    await tool.execute("call-1", { state: "s" });

    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.deepEqual(
        Object.keys(call.body.questions).sort(),
        ["actionability", "human_review", "risk"],
        "the triage question set must be the one sent",
      );
    }
  });
});

test("both adapters forward purpose, provider, model and parsed questions to the transport", async () => {
  await withStubbedTransport(async (calls) => {
    const questionsJson = JSON.stringify({
      lane: { type: "choice", question: "Which lane?", options: ["investigate", "implement"] },
    });

    const entry = await openCodeTool();
    const openCodeOutput = await entry.execute({
      state: "s", purpose: "custom", provider: "openrouter", model: "pinned-a", questions_json: questionsJson,
    });
    const { tool } = piTool();
    const piOutput = await tool.execute("call-1", {
      state: "s", purpose: "custom", provider: "openrouter", model: "pinned-b", questions_json: questionsJson,
    });

    assert.equal(calls[0].body.model, "pinned-a");
    assert.equal(calls[1].body.model, "pinned-b");

    // purpose and provider are not visible in the request body, so they are
    // asserted where they do surface: the marker the adapter returns.
    for (const marker of [JSON.parse(openCodeOutput).multica, piOutput.details.multica]) {
      assert.equal(marker.purpose, "custom");
      assert.equal(marker.provider, "openrouter");
    }
    for (const call of calls) {
      assert.deepEqual(Object.keys(call.body.questions), ["lane"]);
      assert.equal(call.body.questions.lane.type, "choice");
      assert.deepEqual(
        Object.keys(call.body.questions.lane.criteria),
        ["investigate", "implement"],
        "the options array must be normalized to keys before it is sent",
      );
    }
  });
});

test("the OpenCode adapter reports a transport failure as a message instead of throwing", async () => {
  await withStubbedTransport(async () => {
    const entry = await openCodeTool();
    const output = await entry.execute({ state: "s" });
    assert.match(output, /^multica_jev error: /);
    assert.match(output, /OpenRouter request failed \(500\)/);
    assert.doesNotMatch(output, /\bat .*core\.mjs/, "a stack trace must not reach the agent");
  }, { status: 500, payload: { error: { message: "upstream exploded" } } });
});

test("the Pi adapter reports a transport failure in both content and details instead of throwing", async () => {
  await withStubbedTransport(async () => {
    const { tool } = piTool();
    const output = await tool.execute("call-1", { state: "s" });
    assert.match(output.content[0].text, /^multica_jev error: /);
    assert.match(output.details.error, /OpenRouter request failed \(500\)/);
    assert.equal(output.details.answers, undefined);
    assert.doesNotMatch(output.details.error, /\bat .*core\.mjs/);
  }, { status: 500, payload: { error: { message: "upstream exploded" } } });
});

test("both adapters report a refused protected judgment without calling the transport", async () => {
  await withStubbedTransport(async (calls) => {
    const questionsJson = JSON.stringify({
      verdict: { type: "noul", question: "Is this finding real?" },
    });

    const entry = await openCodeTool();
    const openCodeOutput = await entry.execute({ state: "s", purpose: "custom", questions_json: questionsJson });
    const { tool } = piTool();
    const piOutput = await tool.execute("call-1", { state: "s", purpose: "custom", questions_json: questionsJson });

    assert.match(openCodeOutput, /will not automate a protected Multica judgment/);
    assert.match(piOutput.details.error, /will not automate a protected Multica judgment/);
    assert.equal(calls.length, 0, "a refused question must never reach the network");
  });
});

test("both adapters report malformed questions_json without calling the transport", async () => {
  await withStubbedTransport(async (calls) => {
    const entry = await openCodeTool();
    const openCodeOutput = await entry.execute({ state: "s", purpose: "custom", questions_json: "{not json" });
    const { tool } = piTool();
    const piOutput = await tool.execute("call-1", { state: "s", purpose: "custom", questions_json: "{not json" });

    assert.match(openCodeOutput, /questions_json is not valid JSON/);
    assert.match(piOutput.details.error, /questions_json is not valid JSON/);
    assert.equal(calls.length, 0);
  });
});

test("the Pi adapter forwards its abort signal to the transport", async () => {
  await withStubbedTransport(async (calls) => {
    const controller = new AbortController();
    const { tool } = piTool();
    await tool.execute("call-1", { state: "s" }, undefined, undefined, controller.signal);
    assert.equal(calls[0].init.signal, controller.signal);
  });
});
