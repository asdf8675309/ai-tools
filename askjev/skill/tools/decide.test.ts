import { test, expect, beforeEach, afterEach } from 'bun:test';
import { decide, maxGate, confidenceBand } from './decide.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.CF_ACCOUNT_ID = 'acct-test';
  process.env.CF_API_TOKEN = 'token-test';
  delete process.env.CF_AI_GATEWAY;
  delete process.env.CF_AIG_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test('decide() posts to the ai/run endpoint with the double-nested payload', async () => {
  let capturedUrl = '';
  let capturedBody: unknown;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({ success: true, result: { result: { answers: { q1: { type: 'noul', noul: 0.83 } } } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await decide({
    state: 'test state',
    questions: { q1: { type: 'noul', instructions: 'is this true?' } },
  });

  expect(capturedUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acct-test/ai/run');
  expect((capturedBody as { model: string }).model).toBe('typesafe/jev');
  expect(result.ok).toBe(true);
  expect(result.answers?.q1?.noul).toBe(0.83);
});

test('decide() engages the gateway via the header, not a gateway.ai.cloudflare.com URL', async () => {
  process.env.CF_AI_GATEWAY = 'my-gateway';
  let capturedHeaders: Headers | undefined;
  let capturedUrl = '';
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedHeaders = new Headers(init.headers);
    return new Response(
      JSON.stringify({ success: true, result: { result: { answers: {} } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await decide({ state: 's', questions: {} });

  expect(capturedUrl).toContain('api.cloudflare.com');
  expect(capturedUrl).not.toContain('gateway.ai.cloudflare.com');
  expect(capturedHeaders?.get('cf-aig-gateway-id')).toBe('my-gateway');
});

test('decide() checks HTTP status before parsing the body (429 is not JSON)', async () => {
  globalThis.fetch = (async () =>
    new Response('rate limited, retry after 30s', { status: 429 })) as unknown as typeof fetch;

  const result = await decide({ state: 's', questions: {} });

  expect(result.ok).toBe(false);
  expect(result.status).toBe(429);
  expect(result.error).toContain('429');
});

test('decide() surfaces a workers-ai-level failure even on HTTP 200', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: false, errors: [{ message: 'model overloaded' }] }), { status: 200 })) as unknown as typeof fetch;

  const result = await decide({ state: 's', questions: {} });

  expect(result.ok).toBe(false);
  expect(result.error).toContain('model overloaded');
});

test('decide() fails closed when credentials are missing, never sends the request', async () => {
  delete process.env.CF_ACCOUNT_ID;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}');
  }) as unknown as typeof fetch;

  const result = await decide({ state: 's', questions: {} });

  expect(result.ok).toBe(false);
  expect(result.error).toContain('CF_ACCOUNT_ID');
  expect(called).toBe(false);
});

test('maxGate takes the maximum, never the mean, across noul answers', () => {
  const answers = {
    calm1: { type: 'noul' as const, noul: 0.1 },
    calm2: { type: 'noul' as const, noul: 0.2 },
    alarm: { type: 'noul' as const, noul: 0.95 },
  };

  const gate = maxGate(answers, 0.5);

  expect(gate.value).toBe(0.95);
  expect(gate.top).toBe('alarm');
  expect(gate.fired).toBe(true);
  // A mean of these three would sit around 0.42 and never fire at threshold 0.5 —
  // the whole reason this is max, not average.
  const mean = (0.1 + 0.2 + 0.95) / 3;
  expect(gate.value).toBeGreaterThan(mean);
});

test('maxGate respects a key allowlist', () => {
  const answers = {
    inScope: { type: 'noul' as const, noul: 0.3 },
    outOfScope: { type: 'noul' as const, noul: 0.99 },
  };

  const gate = maxGate(answers, 0.5, ['inScope']);

  expect(gate.value).toBe(0.3);
  expect(gate.fired).toBe(false);
});

test('confidenceBand routes act/review/hold by threshold, and missing confidence defaults to review', () => {
  expect(confidenceBand(0.9, 0.8, 0.5)).toBe('act');
  expect(confidenceBand(0.6, 0.8, 0.5)).toBe('review');
  expect(confidenceBand(0.3, 0.8, 0.5)).toBe('hold');
  expect(confidenceBand(undefined, 0.8, 0.5)).toBe('review');
});
