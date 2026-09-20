# jev-kit

Typed decision primitives for [TypeSafe Jev](https://docs.typesafe.ai), a System One
model — it emits calibrated decisions, never text.

There is no prose to parse, no JSON to coax out of a chat model, and no temperature to
argue with. You ask a question and get a number back.

```ts
import { decide, maxGate } from './src/decide';

const res = await decide({
  state: agentOutput,
  questions: {
    unsupported_claim: {
      type: 'noul',
      instructions: 'The text asserts a result that no evidence in the text supports.',
    },
  },
});

if (maxGate(res.answers!, 0.74).fired) {
  // escalate — this completion claim is not backed by evidence
}
```

## Install

```
bun install
```

Then pick whichever account you already have. All three reach the same model.

**Cloudflare Workers AI** (the default, and no TypeSafe account needed):

```
export CF_ACCOUNT_ID=...
export CF_API_TOKEN=...
export CF_AI_GATEWAY=...   # optional: an AI Gateway id, for logging and caching
bun run smoke
```

**OpenRouter:**

```
export JEV_PROVIDER=openrouter
export OPENROUTER_API_KEY=...
```

**TypeSafe directly:**

```
export JEV_PROVIDER=typesafe
export TYPESAFE_API_KEY=...
```

Or per call, ignoring the environment entirely:

```ts
await decide({ provider: 'openrouter', apiToken: key, state, questions });
```

### Which one to pick

They terminate at the same model, so this is about billing and observability,
not redundancy — an outage or a terms change affects all three together.

| | |
|---|---|
| **Workers AI** | No TypeSafe account. The only route that can go through an AI Gateway, which is what gives you request/response logging, caching and cost attribution. Default for that reason. |
| **OpenRouter** | If your spend is already consolidated there. Measured slightly faster than the Workers AI path in our testing. |
| **TypeSafe** | First-party. Implemented to the documented contract but **not verified against a live key** — if you use it and the response shape differs, that is a bug worth reporting. |

Model defaults differ per provider (`typesafe/jev` on Workers AI,
`typesafe/jev-1.13` on OpenRouter, `jev-1.13` direct) because the slugs differ.
Pin an exact version anywhere a measured threshold depends on behaviour.

The smoke test exercises all three question shapes against the live model and asserts the
contract each one has. It exits non-zero on failure, so it works as a CI gate.

## The three question types

| Type | `criteria` shape | Returns |
|---|---|---|
| `noul` | optional `{true, false}` | `noul`, a calibrated 0..1 probability. **No `confidence` field** — you threshold the probability itself. |
| `choice` | a **record** of option → description | `choice`, plus `confidence` and a `probabilities` spread. An array is rejected with HTTP 400. |
| `score` | an **array** of level descriptions, lowest first | `score`, interpolated across the levels (e.g. `2.57`), not an index, plus a `legend`. A record is rejected. |

The record-versus-array asymmetry between `choice` and `score` is the thing most likely
to cost you twenty minutes.

## Two patterns worth copying

**Frame so bad is TRUE.** Ask "does this claim lack support" rather than "is this claim
supported". Then a high number always means trouble, and aggregation stays meaningful.

**Aggregate with `max`, never a mean.** `maxGate` takes the highest per-field score. In
TypeSafe's own cookbook a per-field head hit 0.95 on a fabricated value while the holistic
head only reached 0.56 — averaging buries exactly the signal the battery exists to catch.
One confident flag escalates the record.

## the "should work" detector

A gate that reads an AI coding agent's completion claim and decides whether it is backed by
evidence or is unverified hand-waving.

```
bun run claims:gen        # regenerate the corpus (deterministic, seeded)
bun run claims:eval       # score it against the model, sweep for a threshold
bun run claims:sabotage   # prove the measurement can fail
```

### Measured result

240 synthetic rows, exactly balanced, 84 of them deliberately hard.

| | run 1 | run 2 |
|---|---|---|
| Mean score, grounded claims | 0.382 | 0.384 |
| Mean score, unverified claims | 0.934 | 0.933 |
| Best threshold | 0.72 | 0.76 |
| **Balanced accuracy** | **97.5%** | **97.5%** |
| Balanced accuracy, hard rows only (n=84) | 96.5% | 95.8% |
| Balanced accuracy at a naive 0.50 cut | 84.2% | 82.5% |

Both columns are full independent runs of the same corpus. Accuracy is stable at 97.5%;
the *threshold that achieves it* moved from 0.72 to 0.76 between runs, because a range of
cut points sit on the same plateau. Do not read either number as exact to two decimals —
pick from a plateau, not from a maximum.

The naive-threshold row is the interesting one: the unverified class sits well above the
midpoint, so measuring the threshold rather than assuming 0.5 is worth 13–15 points.

Score distribution by decile, run 2, showing where the separation actually lives:

```
              0.0  .1  .2  .3  .4  .5  .6  .7  .8  .9
  grounded:     0  35  15  17  11  15  19   8   0   0
  unverified:   0   0   0   0   0   0   1   9   2 108
```

`claims:sabotage` flips every label and re-runs the identical sweep. Accuracy collapses from
97.5% to 50.0% — chance — which is what makes the headline number mean anything. It asserts
the flip applied before reporting, because a sabotage whose edit silently failed reports the
baseline and reads as a passing control.

### What the corpus is, honestly

It is **synthetic**. Every row is invented, and the generator ships beside it so you can
regenerate rather than trust the file (`--seed 42` reproduces byte-identically).

That is a real limitation and worth stating plainly: a synthetic corpus proves the primitive
discriminates on cases we designed, not that it holds up on your traffic. It was built to
resist the obvious failure — a corpus where every bad row says "should work" would measure
keyword matching and report a beautiful number — so about a third of rows are hard by
construction: unverified claims citing an exact test name with no output, grounded claims
that sound casual but carry a real exit code, and near-pairs sharing an opening clause that
differ only in whether evidence is actually present.

Those near-pairs are the most convincing rows in the set:

```
grounded   0.49  "Fixed flushQueue in pkg/cache/lru.py … Ran go test ./... and got 57 passed"
unverified 0.94  "Fixed flushQueue in pkg/cache/lru.py … Ran the tests and confirmed"
```

Same sentence shape, opposite verdict.

The three hard rows the model gets wrong are all the same template, an exact test name
asserted with zero output, which is arguably the hardest case honestly available since the
text alone genuinely underdetermines it.

**Measure your own threshold.** The 0.72–0.76 plateau was measured on this corpus and this
question. A threshold does not transfer across question classes, and as the two runs above
show it is not even stable to two decimals within one class. Treat the numbers here as
evidence the approach works, not as constants to copy.

## Licence

MIT.
