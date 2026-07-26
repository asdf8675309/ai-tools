/**
 * Crucible — Embedding Client
 *
 * Minimal client for any OpenAI-compatible `/v1/embeddings` endpoint: a local
 * runtime (LM Studio, Ollama, llama.cpp, vLLM) or a hosted gateway. Used only by
 * SemanticCloneDetector.
 *
 * Nothing here is required for a review. With no endpoint configured — the
 * default — `resolveEmbeddingEndpoint()` returns a reason string naming exactly
 * what is missing, and callers degrade to heuristic duplication detection
 * instead of failing the review.
 *
 * Which endpoint to use comes from `models.embedding_primary` in config.yaml,
 * resolved through Config's provider-key machinery. A `local-*` key needs
 * `integrations.local_models.enabled` plus a `local_model_map` entry; a
 * `gateway-*` key needs `integrations.gateway` plus a `gateway_model_map` entry.
 *
 * CLI:
 *   bun tools/EmbeddingClient.ts --check          # print resolution status
 *   bun tools/EmbeddingClient.ts --embed "text"   # embed one string, print dims
 */

import { loadConfig, resolveProviderKey, type CrucibleConfig } from "./Config.ts";

export interface EmbeddingEndpoint {
  provider_key: string;
  kind: "local" | "gateway";
  base_url: string;
  model: string;
  api_key?: string;
  timeout_ms: number;
}

export type EndpointResolution =
  | { ok: true; endpoint: EmbeddingEndpoint }
  | { ok: false; reason: string };

export type EmbedResult =
  | { success: true; embeddings: number[][]; model: string }
  | { success: false; error: string };

const DEFAULT_TIMEOUT_MS = 60_000;
/** Clip oversized inputs client-side; endpoints reject long inputs with an
 *  opaque 400 that is hard to attribute to a specific batch member. */
const MAX_INPUT_CHARS = 8_000;

const NOT_CONFIGURED =
  "models.embedding_primary is not set in config.yaml — point it at a `local-*` key " +
  "(with integrations.local_models.enabled: true and a local_model_map entry) or a " +
  "`gateway-*` key (with integrations.gateway.enabled: true, base_url, and a gateway_model_map entry)";

/**
 * Resolve the configured embedding endpoint. Never throws — an unconfigured or
 * half-configured setup returns `{ ok: false, reason }` naming the missing piece.
 */
export function resolveEmbeddingEndpoint(cfg?: CrucibleConfig): EndpointResolution {
  let config: CrucibleConfig;
  try {
    config = cfg ?? loadConfig();
  } catch (e) {
    return { ok: false, reason: `config could not be loaded: ${(e as Error).message}` };
  }

  const key = config.models?.embedding_primary;
  if (!key) return { ok: false, reason: NOT_CONFIGURED };

  // resolveProviderKey always returns something dispatchable, so a non-empty
  // fallback chain is the signal that the configured key itself was unusable.
  const resolved = resolveProviderKey(key, config);
  const hop = resolved.fallbacks[0];
  if (hop) {
    return { ok: false, reason: `embedding provider-key "${hop.from}" is unavailable: ${hop.reason}` };
  }

  if (resolved.kind === "local") {
    return {
      ok: true,
      endpoint: {
        provider_key: resolved.provider_key,
        kind: "local",
        base_url: resolved.endpoint.replace(/\/+$/, ""),
        model: resolved.model,
        timeout_ms: DEFAULT_TIMEOUT_MS,
      },
    };
  }

  if (resolved.kind === "gateway") {
    const apiKey = resolved.api_key_env ? process.env[resolved.api_key_env] : undefined;
    if (resolved.api_key_env && !apiKey) {
      return { ok: false, reason: `env var ${resolved.api_key_env} (integrations.gateway.api_key_env) is not set` };
    }
    return {
      ok: true,
      endpoint: {
        provider_key: resolved.provider_key,
        kind: "gateway",
        base_url: resolved.base_url.replace(/\/+$/, ""),
        model: resolved.model,
        api_key: apiKey,
        timeout_ms: resolved.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      },
    };
  }

  return {
    ok: false,
    reason: `embedding provider-key "${key}" resolves to a ${resolved.kind} runtime, which cannot serve embeddings`,
  };
}

/**
 * Embed a batch of strings. Returns a result object rather than throwing so a
 * single failed batch degrades clone detection instead of aborting a review.
 */
export async function embed(inputs: string[], opts: { endpoint?: EmbeddingEndpoint } = {}): Promise<EmbedResult> {
  if (inputs.length === 0) return { success: true, embeddings: [], model: opts.endpoint?.model ?? "none" };

  let endpoint = opts.endpoint;
  if (!endpoint) {
    const resolved = resolveEmbeddingEndpoint();
    if (!resolved.ok) return { success: false, error: resolved.reason };
    endpoint = resolved.endpoint;
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (endpoint.api_key) headers.authorization = `Bearer ${endpoint.api_key}`;

  try {
    const res = await fetch(`${endpoint.base_url}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        input: inputs.map((s) => s.slice(0, MAX_INPUT_CHARS)),
      }),
      signal: AbortSignal.timeout(endpoint.timeout_ms),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      return { success: false, error: `${endpoint.kind} endpoint returned ${res.status}: ${text}` };
    }
    const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const rows = json.data;
    if (!Array.isArray(rows) || rows.length !== inputs.length) {
      return { success: false, error: `malformed response: expected ${inputs.length} embeddings, got ${rows?.length ?? 0}` };
    }
    // The API may return rows out of order; `index` is authoritative when present.
    const ordered = rows.every((r) => typeof r.index === "number")
      ? [...rows].sort((a, b) => (a.index as number) - (b.index as number))
      : rows;
    const embeddings: number[][] = [];
    for (const row of ordered) {
      if (!Array.isArray(row.embedding)) return { success: false, error: "malformed response: missing embedding vector" };
      embeddings.push(row.embedding);
    }
    return { success: true, embeddings, model: endpoint.model };
  } catch (e) {
    return { success: false, error: `${endpoint.kind} endpoint unreachable: ${(e as Error).message}` };
  }
}

/** Cosine similarity of two equal-length vectors. Returns 0 for a zero vector. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--embed") {
    const text = args.slice(1).join(" ");
    if (!text) {
      console.error("usage: bun EmbeddingClient.ts --embed <text>");
      process.exit(1);
    }
    const result = await embed([text]);
    if (!result.success) {
      console.error(`embed failed: ${result.error}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ model: result.model, dims: result.embeddings[0]?.length ?? 0 }, null, 2));
    process.exit(0);
  }

  if (args.length === 0 || args[0] === "--check") {
    const resolved = resolveEmbeddingEndpoint();
    if (resolved.ok) {
      const { api_key: _omit, ...safe } = resolved.endpoint;
      console.log(JSON.stringify({ configured: true, endpoint: safe }, null, 2));
    } else {
      console.log(JSON.stringify({ configured: false, reason: resolved.reason }, null, 2));
    }
    process.exit(0);
  }

  console.error("usage: bun EmbeddingClient.ts [--check | --embed <text>]");
  process.exit(1);
}
