# Jev as a judge in a code-gen loop

Research notes on TypeSafe AI's **Jev** and whether it belongs in a
cheap-model-generates / fast-model-judges harness.

Snapshot: **2026-09-19**. Everything below is vendor-reported or
community-reported unless marked otherwise. Prices, limits and aliases move.

---

## What Jev actually is

Not an LLM. TypeSafe calls it a **System One model**: it takes program state
plus typed questions and returns typed answers with probabilities, in one
parallel pass. It emits no text at all.

```text
text or JSON state + typed questions  →  constrained answers + probabilities  →  your code
```

Three primitives, and that is the whole answer space:

| Primitive | Shape | Returns |
|---|---|---|
| `Choice` | one of N declared options (up to 255) | selected option, probability per option, confidence |
| `Score`  | position on an ordered rubric of 2–10 named levels | continuous probability-weighted score, distribution, confidence |
| `Noul`   | a binary proposition | probability 0–1 that it is true |

Because the answer space is declared in the request, an invalid or invented
value is not possible — the reported structured-output error rate is 0%.

### Operating envelope

| Item | Value |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` |
| Alias / version | `jev-latest` → `jev-1.13.0` |
| Price | `$0.042` per 1M input tokens; output free |
| Latency | 70–500 ms end-to-end (vendor-reported) |
| Context | 64k per request; ~32k for state plus the longest question |
| Rate limits | ~250k tokens/sec, ~1,200 req/min (documented as dynamic) |
| SDKs | Python (`typesafe-sdk`), JS (`@typesafe-ai/sdk`), raw HTTP |
| Also on | Vercel AI Gateway (`typesafe-ai/jev`), Cloudflare Workers AI (`typesafe/jev`) |
| Modalities | text only — no images, audio, video |
| Coding agents | TypeSafe ships an official agent skill for Claude Code / Codex |

Accuracy on TypeSafe's own 4-workflow benchmark is **~68%**, roughly 5 points
behind Opus 5 on the same set, at ~440x lower cost and ~0.4s per case.

### Published weaknesses (jev-1.13 "jaggedness")

These are the ones that decide whether the code-judge idea works:

1. **Literal reading** — it answers the question as written, not as intended.
2. **Weak at math, counting, dates and indirection.** Dates are read as text.
3. **Degrades on large states full of irrelevant detail.** Trim the state.
4. **`Score` levels are weakly calibrated numerically** — don't interpolate
   between rungs and expect a meaningful number.
5. **No rationale, ever.** You get a number, not a reason. That hurts
   debugging and anything that needs an audit trail.

---

## The core question: can Jev judge generated code?

**Partly — and not the part most people reach for first.**

Judging "does this function return the expected output for these inputs" is
not a judgment call. It is an execution. A test runner answers it at 100%
with a stack trace attached; Jev would answer it at ~68% with no explanation,
and its weakness at counting and indirection is exactly the weakness that
matters when tracing a function by eye. **Do not replace assertions with a
probabilistic classifier.** Run the code.

Where Jev is genuinely well-shaped is the fuzzy ring *around* the
deterministic checks — the decisions a codegen loop currently either skips or
pays a frontier model to make:

1. **Post-test-pass sniff tests.** Tests are green — but did the generator
   hardcode the fixtures, stub the failing branch, weaken an assertion, or
   edit the test instead of the code? Each is a narrow `Noul`.
2. **Retry / escalate / stop routing.** After a failed attempt: is this
   recoverable by the cheap model, does it need the expensive model, or is
   the spec itself ambiguous? A `Choice` with a confidence gate, ~100ms,
   replacing either a hand-tuned retry counter or a frontier-model call.
3. **Finding triage.** Given a reviewer's finding plus the cited code, is it
   real, is it in scope, is it a nit? This is the classic LLM-as-judge lane,
   and the one with the best public evidence for substitution.
4. **Scope and diff gating.** Did the diff touch files the task never named?
   Does it match the requested change? Cheap pre-flight before anything
   expensive runs.
5. **Rubric scoring at full coverage.** Score every iteration against a
   rubric instead of sampling, because at $0.042/M you can afford to.

The published pattern for (3) and (5), from Arize: **run the decision model
on every trace for coverage, then sample the failures and low-confidence
cases through an LLM judge when you need a written explanation.** They
report Jev holding **>92% agreement with a committee of LLM judges at ~1% of
the cost**. Langfuse published a matching eval integration on 2026-09-18.

So the honest framing of the end goal: Jev is not the judge. **The test
runner is the judge; Jev is the bailiff** — it decides what gets in front of
the judge, what happens to the verdict, and when to call a human.

---

## Fit against this repo

`crucible` is already the shape Jev slots into: over-enumerate findings in
pass 1, adversarially disprove in pass 2, then filter. Candidate lanes:

| Crucible surface | Jev question | Why it fits |
|---|---|---|
| `ci/tier-classify` | `Choice{trivial,lite,full}` + `Noul` "touches security-sensitive code" | Today it is diff stats plus path globs. Jev adds a semantic second opinion; keep the deterministic rule as the floor, take the stricter of the two. |
| Phase 4 disprove filter | `Noul` "this finding survives the cited counter-argument" | Cheap pre-pass to rank; the LLM still writes the disproof for anything uncertain. |
| Finding dedup / cap | `Score` on severity + `Noul` "duplicate of finding N" | Ranked cap currently needs judgment; this is a per-pair call at sub-cent cost. |
| Phase 0 eligibility | `Noul` "docs-only", "oversized", "generated file" | Deterministic checks stay; Jev catches the semantic misses. |

**The 32k state limit is the binding constraint.** A 1000-line diff plus
surrounding context will not fit in one call. Crucible already refuses diffs
over 1000 lines, which happens to keep it inside the envelope — but any
per-file or per-finding design is safer than a whole-diff one.

---

## Cost sketch

At `$0.042` per 1M input tokens, output free:

- One judgment over an 8k-token state ≈ **$0.00034**.
- 10 questions fanned out in a single call over that same state: still one
  state, so still ≈ **$0.00034** — fan-out is close to free. This is the
  single biggest design lever: ask everything you might need at once.
- 5,000 codegen iterations/day, judged at 8k state each ≈ **$1.70/day**.

The equivalent frontier-model judge lane is two to three orders of magnitude
more, which is why full-coverage scoring becomes affordable rather than
sampled.

---

## Risks and open questions

- **No independent calibration numbers yet.** TypeSafe trains with "RLCD"
  (Reinforcement Learning for Calibrated Decisions) but has not published
  standard calibration metrics on independent ground-truth tasks. Confidence
  thresholds must be tuned on your own labeled data, not assumed.
- **68% on a 4-workflow vendor benchmark is not a code-judgment result.**
  No public benchmark measures Jev on code correctness specifically.
- **Alias drift.** `jev-latest` moves. Pin `jev-1.13.0` anywhere a threshold
  depends on behavior, and log the version returned in each response.
- **Single vendor, early access, one month old.** Any lane that depends on it
  needs a deterministic fallback path.
- **No rationale** makes a regression hard to diagnose after the fact. Log
  the full probability distribution, not just the winning label.
- **Network policy.** `typesafe.ai`, `docs.typesafe.ai` and
  `api.typesafe.ai` are not reachable from a default-deny egress policy.
  Allowlisting `api.typesafe.ai` is a prerequisite for any spike.

---

## Proposed spike

Smallest experiment that would settle the question, in order:

1. **Allowlist `api.typesafe.ai`, get a key, run the quickstart.** Confirms
   latency and the response contract from inside the network.
2. **Build a 50-case labeled set from crucible history** — findings already
   judged real or killed by the disprove pass. This is the ground truth, and
   it already exists in past runs.
3. **Shadow-mode the disprove filter.** Run Jev alongside pass 2, log both
   verdicts, change nothing. Measure agreement and the confidence band where
   disagreement clusters.
4. **Decide the threshold from the data**, not from the vendor's numbers:
   below it, escalate to the LLM pass; above it, take Jev's verdict.
5. **Only then** consider the codegen loop itself, starting with the
   post-test-pass sniff tests, which have the clearest failure mode.

Steps 1–3 are a day of work and produce a real number. Step 5 is a separate
project.

---

## Sources

Primary (vendor):
- TypeSafe launch post — `typesafe.ai/blog/introducing-system-one-models-and-jev`
- Docs — `docs.typesafe.ai` (introduction, primitives, confidence, patterns, models, jaggedness/jev-1.13)
- Workflow evals — `evals.typesafe.ai`

Independent / community:
- Arize, "TypeSafe Jev: Can Decision Models Replace LLM Judges?" — `arize.com/blog/typesafe-jev-llm-judge/`
- Langfuse, "Using TypeSafe's Jev for evals" (2026-09-18) — `langfuse.com/blog/2026-09-18-using-typesafes-jev-for-evals`
- LangChain, harness + `TypeSafeClassifier` — `langchain.com/blog/building-a-harness-with-jev`
- TechCrunch (2026-09-18), The Register (2026-09-16), DataCamp
- `github.com/Anil-matcha/awesome-jev-by-typesafe`, `github.com/AntonioCoppe/jev-harness`,
  `github.com/Kevthetech143/super-jev`, `github.com/yibie/awesome-jev`
