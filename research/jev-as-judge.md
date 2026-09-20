# Jev as a judge in a code-gen loop

Research notes on TypeSafe AI's **Jev** and whether it belongs in a
cheap-model-generates / fast-model-judges harness.

Snapshot: **2026-09-19**, updated the same evening. Vendor and community
claims are marked as such. Sections headed **Measured here** are our own
numbers from a run against real data, and they are the parts worth trusting;
everything else is someone else's claim. Prices, limits and aliases move.

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

### Question framing dominates the result

Measured here, on a 200-row labelled corpus, and since reproduced against real
production findings. Still one task family rather than a law:

- A **single compound** calibrated question scored **-0.120** separation.
  That is the wrong side of chance: the model graded how the text *sounded*
  rather than evaluating the disjunction.
- **Splitting it into narrow questions and aggregating with `max`** moved
  the same task to **+0.251**.

This is consistent with the published weakness ("literal reading" and "weak
at indirection") and it promotes a design rule: **never ask Jev a compound
question.** One proposition per `Noul`, composed in code. It also means the
substance of a Jev integration is the framing, not the API call — the API
call is four lines.

A second, sharper caution: **whoever writes the options shapes the answer.**
Putting our own open question to Jev, our own prior recommendation won at 87%
— a confound, not a confirmation. The `AskJev` skill therefore requires a
`framedBy` field, refuses to run without it, and prints it above every result. Any lane we build should record who wrote the options
alongside the verdict, and a Jev score should never be cited as independent
support for the framer's own position.

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
| Phase 4 disprove filter | `Noul` battery, then `max` | **Measured, and weaker than this table first assumed — see below.** Safe as a RANKING aid. Not safe as an auto-drop: the threshold does not hold out of sample. |
| Finding dedup / cap | `Score` on severity + `Noul` "duplicate of finding N" | Ranked cap currently needs judgment; this is a per-pair call at sub-cent cost. |
| Phase 0 eligibility | `Noul` "docs-only", "oversized", "generated file" | Deterministic checks stay; Jev catches the semantic misses. |

Both land on the branch this doc is on: `askjev/` is the skill, `jev-kit/` is
the primitive plus two reproducible examples. Anything built from the table
above should start there rather than reimplementing the same call.

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

- **No independent calibration numbers yet, and our own data says why that
  matters.** Thresholds tuned on one corpus did not transfer to another, and a
  threshold tuned on ~40 labelled positives did not even survive a holdout on
  the same corpus (see **Measured here** below). Tune on your own labelled
  data, on enough of it, and validate out of sample.
- **68% on a 4-workflow vendor benchmark is not a code-judgment result.**
  No public benchmark measures Jev on code correctness specifically.
- **Alias drift.** `jev-latest` moves. Pin `jev-1.13.0` anywhere a threshold
  depends on behavior, and log the version returned in each response.
- **Single vendor, early access, one month old.** Any lane that depends on it
  needs a deterministic fallback path.
- **No rationale** makes a regression hard to diagnose after the fact. Log
  the full probability distribution, not just the winning label.
- **No vendor account is required to try it.** Jev is a first-class Cloudflare
  Workers AI model (`typesafe/jev`), so a spike runs through
  `POST /accounts/{id}/ai/run` on an existing Cloudflare token. One detail
  costs an hour if missed: the AI Gateway is engaged by the
  `cf-aig-gateway-id` **header**, not by posting to a
  `gateway.ai.cloudflare.com` URL — that URL is an OpenAI-chat shim which
  cannot express a `questions` payload at all.

---

## Measured here (2026-09-19 evening)

Steps 1–4 of the proposed spike were run. Reporting what came back, including
the part that argues against the table above.

### The setup

Ground truth came from **180 real findings** sampled from production code
review, stratified by severity so the rare CRITICAL band was not reduced to a
handful of rows. Each was put to **two independent judges from different
vendors**. Where they agreed, that became the label; where they disagreed, the
row was discarded rather than broken by a tiebreak. That left **130 labels: 42
real defects, 88 false positives.**

### What the labels say about review output itself

Two independent judges agree that roughly **two thirds of findings should not
have been filed**. That is the number that makes a filter worth building at
all.

### What Jev scores against them

| | synthetic corpus | real findings |
|---|---|---|
| n | 200 | 130 |
| Balanced accuracy | 100.0% | **74.9%** |
| Separation (mean FP − mean real) | 0.251 | 0.153 |
| Zero-false-drop threshold | 0.82 | 0.89 |
| False positives dropped at it | **100%** | **20%** |

**The synthetic number is worthless on its own and the gap is the finding.**
That corpus was written from the same taxonomy as the questions, so it measures
whether the battery detects the failure families as described rather than as
they occur. Anyone publishing a single synthetic eval number for this model is
reporting that same artifact.

### The threshold does not survive a holdout

Fitting the "no real defect dropped" cut on the labelled rows and reporting
zero losses on those same rows measures nothing. Refitting on half and testing
on the other half, 200 times:

| | |
|---|---|
| Mean fitted threshold | 0.85 |
| Splits losing ≥1 real defect | **52.5%** |
| Mean real defects lost per split | 0.89 |
| Mean false positives caught | 35.0% |

So a threshold fitted on ~40 labelled defects loses a real defect about half
the time on data it has not seen. **Ranking is safe; auto-dropping is not.**
Ranking has no silent-loss failure mode, and the separation is real even where
the cut point is not stable.

### One bias, stated because it cuts against us

The 50 discarded rows are not a random sample. On them the first judge called
**80%** real, against **32%** on the rows that got labels. Consensus filtering
stripped out disproportionately many likely-real findings, so the 2:1
false-positive ratio understates how often findings are real, and the accuracy
above is flattered by an easier set. One plausible mechanism was checked and
cleared: the discarded findings are not systematically longer.

### A separate lane that did work

A detector for **completion claims unsupported by evidence** — an agent
reporting a result with no command, output or exit code behind it — measured
**97.5% balanced accuracy** on a 240-row corpus, holding at 96.5% on the third
of rows built to be hard. That is a different question shape: a property of the
text in front of the model, with no hidden state to reason about.

### Practical notes

- **Fan-out really is close to free.** Seven questions over one state is one
  call and one state charge. Ask everything at once.
- **The incumbent comparison is 2x on cost, not the 400x the headline price
  suggests** — the incumbent's output tokens dominate its bill, and Jev's state
  is charged per call regardless.
- **Every eval needs two sabotage arms.** Flipping the labels proves the metric
  reads the labels; replacing the scores with a constant proves it reads the
  model. One arm cannot tell a load-bearing control from a decorative one.

### What is already running

- The knowledge-ingest link-relevance step runs on Jev in production behind an
  env flag, judging candidate links at a measured threshold.
- An `AskJev` skill and a `jev-kit` primitive with two reproducible examples
  sit on the unpushed branch `feat/jev-decision-tools`.

### What would still settle the open question

1. **More labels.** 42 positives is too few to fit a safe threshold. The
   holdout result is a sample-size result as much as a model result.
2. **A tiebreak judge**, so disagreements stop being silently discarded.
3. **Shadow mode in CI** — log Jev's score beside every real verdict, change
   nothing, and revisit once the labelled set is several hundred rows.
4. The codegen-loop sniff tests remain untested and remain the most promising
   untried lane, because their failure mode is visible in the text.

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
