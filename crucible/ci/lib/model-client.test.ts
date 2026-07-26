import { test, expect, describe } from "bun:test";
import {
  chatCompletion,
  isTransientStatus,
  clampDelay,
  retryAfterMs,
  fetchTimeoutMs,
  FIRST_ATTEMPT_TIMEOUT_MS,
  RETRY_ATTEMPT_TIMEOUT_MS,
  MAX_RETRY_DELAY_MS,
  MAX_ATTEMPTS,
} from "./model-client.ts";

const noSleep = async () => {};
const silent = () => {};

// A fetch stub that returns a scripted sequence of responses/throws, one per
// attempt, and records what it was called with.
function scriptedFetch(steps: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = () => new Response("{}", { status: 200 });

describe("chatCompletion — request shape", () => {
  test("posts to /chat/completions with the model, prompt, and bearer token", async () => {
    const { impl, calls } = scriptedFetch([ok()]);
    const r = await chatCompletion({
      baseUrl: "https://gw.example/v1",
      token: "EXAMPLE_NOTREAL_TOKEN",
      model: "some-model",
      prompt: "review this diff",
      maxTokens: 4096,
      fetchImpl: impl,
      sleep: noSleep,
      log: silent,
    });
    expect(r.resp?.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    expect(call.url).toBe("https://gw.example/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer EXAMPLE_NOTREAL_TOKEN");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe("some-model");
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: "user", content: "review this diff" }]);
  });

  test("attaches the metadata header only when a header name is given", async () => {
    const withMeta = scriptedFetch([ok()]);
    await chatCompletion({
      baseUrl: "https://gw.example/v1",
      token: "t",
      model: "m",
      prompt: "p",
      maxTokens: 1,
      metadataHeader: "X-Attribution",
      metadata: { task: "coordinator" },
      fetchImpl: withMeta.impl,
      sleep: noSleep,
      log: silent,
    });
    const h1 = withMeta.calls[0]!.init.headers as Record<string, string>;
    expect(h1["X-Attribution"]).toBe(JSON.stringify({ task: "coordinator" }));

    const noMeta = scriptedFetch([ok()]);
    await chatCompletion({
      baseUrl: "https://gw.example/v1",
      token: "t",
      model: "m",
      prompt: "p",
      maxTokens: 1,
      fetchImpl: noMeta.impl,
      sleep: noSleep,
      log: silent,
    });
    const h2 = noMeta.calls[0]!.init.headers as Record<string, string>;
    expect("X-Attribution" in h2).toBe(false);
  });
});

describe("chatCompletion — retry behavior (the drift this exists to prevent)", () => {
  test("retries a 429 then succeeds, reporting the realized backoff", async () => {
    const { impl, calls } = scriptedFetch([
      new Response("rate limited", { status: 429 }),
      ok(),
    ]);
    const slept: number[] = [];
    const r = await chatCompletion({
      baseUrl: "https://gw.example/v1",
      token: "t",
      model: "m",
      prompt: "p",
      maxTokens: 1,
      fetchImpl: impl,
      sleep: async (ms) => void slept.push(ms),
      log: silent,
    });
    expect(r.resp?.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(r.delays).toEqual([2_000]); // first retry uses the default schedule
    expect(slept).toEqual([2_000]);
  });

  test("does NOT retry a 400 — a client error won't change on retry", async () => {
    const { impl, calls } = scriptedFetch([
      new Response("bad request", { status: 400 }),
      ok(),
    ]);
    const r = await chatCompletion({
      baseUrl: "https://gw.example/v1",
      token: "t",
      model: "m",
      prompt: "p",
      maxTokens: 1,
      fetchImpl: impl,
      sleep: noSleep,
      log: silent,
    });
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(r.resp?.status).toBe(400);
    expect(r.delays).toEqual([]);
  });

  test("a persistent 503 exhausts exactly MAX_ATTEMPTS and returns the last response", async () => {
    const { impl, calls } = scriptedFetch([new Response("down", { status: 503 })]);
    const r = await chatCompletion({
      baseUrl: "https://gw.example/v1",
      token: "t",
      model: "m",
      prompt: "p",
      maxTokens: 1,
      fetchImpl: impl,
      sleep: noSleep,
      log: silent,
    });
    expect(r.attempts).toBe(MAX_ATTEMPTS);
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(r.resp?.status).toBe(503);
  });

  test("a transport throw on every attempt returns no response, with the error message", async () => {
    const { impl } = scriptedFetch([new Error("ECONNRESET")]);
    const r = await chatCompletion({
      baseUrl: "https://gw.example/v1",
      token: "t",
      model: "m",
      prompt: "p",
      maxTokens: 1,
      fetchImpl: impl,
      sleep: noSleep,
      log: silent,
    });
    expect(r.resp).toBeUndefined();
    expect(r.attempts).toBe(MAX_ATTEMPTS);
    expect(r.networkErrorMsg).toBe("ECONNRESET");
  });

  test("honors a server Retry-After over the default schedule, clamped to the ceiling", async () => {
    const { impl } = scriptedFetch([
      new Response("slow down", { status: 429, headers: { "retry-after": "999" } }),
      ok(),
    ]);
    const slept: number[] = [];
    const r = await chatCompletion({
      baseUrl: "https://gw.example/v1",
      token: "t",
      model: "m",
      prompt: "p",
      maxTokens: 1,
      fetchImpl: impl,
      sleep: async (ms) => void slept.push(ms),
      log: silent,
    });
    expect(r.attempts).toBe(2);
    // 999s would be 999_000ms; the ceiling clamps it.
    expect(slept).toEqual([MAX_RETRY_DELAY_MS]);
  });
});

describe("envelope primitives", () => {
  test("isTransientStatus: 429 and 5xx retry, other 4xx do not", () => {
    expect(isTransientStatus(429)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(500)).toBe(true);
    expect(isTransientStatus(400)).toBe(false);
    expect(isTransientStatus(401)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
  });

  test("clampDelay bounds to [0, MAX_RETRY_DELAY_MS]", () => {
    expect(clampDelay(-5)).toBe(0);
    expect(clampDelay(5_000)).toBe(5_000);
    expect(clampDelay(999_999)).toBe(MAX_RETRY_DELAY_MS);
  });

  test("fetchTimeoutMs: long budget on the first attempt, short on retries", () => {
    expect(fetchTimeoutMs(1)).toBe(FIRST_ATTEMPT_TIMEOUT_MS);
    expect(fetchTimeoutMs(2)).toBe(RETRY_ATTEMPT_TIMEOUT_MS);
    expect(fetchTimeoutMs(3)).toBe(RETRY_ATTEMPT_TIMEOUT_MS);
  });

  test("retryAfterMs: seconds, HTTP-date, and unparseable", () => {
    const mk = (v: string | null) =>
      new Response("", { status: 429, headers: v === null ? {} : { "retry-after": v } });
    expect(retryAfterMs(mk("5"))).toBe(5_000);
    expect(retryAfterMs(mk("   "))).toBeNull();
    expect(retryAfterMs(mk("not-a-date"))).toBeNull();
    expect(retryAfterMs(mk(null))).toBeNull();
  });
});
