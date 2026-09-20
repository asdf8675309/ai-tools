---
name: askjev
description: "Puts a live open decision from this session to TypeSafe's Jev, a model that emits calibrated decisions instead of text, and reports back a choice with probabilities plus narrow yes/no readings. USE WHEN the session reaches a decision the human is unsure about, should we do A or B, not sure what to do next, need a second read on an open call, want calibrated odds instead of an opinion, is X actually ready, is this a real risk or not. NOT FOR decisions that are already settled, decisions with only one real option, generating the options themselves (do that first, then ask), or anything needing a written explanation rather than a probability."
---

# AskJev

Jev is a "System One" model: it never writes prose, it answers typed questions
with numbers. That's the whole value — no rationalization to read past, no
persuasive-sounding wrong answer, just a calibrated probability. This skill's
job is turning a real, live, open question from the conversation into a payload
Jev can actually answer well. **The API call is twenty lines. Getting the
framing right is the entire skill** — both failure modes below are measured,
not theoretical.

## When to use this

The human says something like "I'm not sure what to do next," "should we do A
or B," or a decision point comes up that has more than one defensible answer.
Don't reach for this on decisions that are already obvious, or where there's
really only one option once you name it honestly.

## Framing discipline — read this before writing a payload

### 1. One question per idea. Never a compound question.

A single calibrated yes/no that lists several disqualifiers in one
`instructions` string measured **-0.120 separation — the wrong direction, at
chance.** The model was reading how the text *sounded* rather than evaluating
a disjunction of conditions. Splitting the same check into seven narrow
`noul` questions — one disqualifier each — and taking the **max** across them
moved it to **+0.251**.

**Scope of that evidence, stated plainly:** one battery, one task, one corpus.
It is a large effect measured once, not a law. The direction of the failure is
what makes it worth acting on — a compound question did not merely score worse,
it scored backwards, which is a mode that returns a confident number pointing
the wrong way rather than an error you would notice. Treat the split-and-max
rule as a strong default whose downside is a few extra keys in one API call,
and re-measure on your own task before relying on a specific threshold.

So: every disqualifying condition, every "is this actually a problem" check,
gets its own `noul` question with a tight, single-condition `instructions`
string. Never write "is X true, or Y, or Z" as one question. Batch them in one
`questions` object (one API call, many keys) and aggregate with
`maxGate()` from `tools/decide.ts` — **never a mean.** A mean buries the one
confident flag under several calm ones, which is exactly the signal a
disqualifier battery exists to catch.

### 2. Whoever writes the options decides the answer — say so.

In the run that motivated this skill, the assistant wrote both the decision
state and the five options, and its own prior recommendation won at 87%. That
is a confound, not a confirmation — the model was scoring the assistant's own
framing, phrased in the assistant's own persuasive voice.

Two structural rules, not just a caution:

- **State the options neutrally.** Include the option of doing nothing, and
  include the option you (the assistant) like least. If you can't write a
  fair one-sentence case for the option you're rooting against, you're not
  ready to frame this question yet.
- **Disclose who framed it.** Every payload to `askjev.ts` requires a
  `framedBy` field — the tool refuses to run without one. Say plainly who
  wrote the `state` and the options: "the assistant, prior recommendation was
  X", "the user", "assistant and user jointly after discussion." The tool
  prints this line first, above the results, every time. A decision tool that
  hides its own framing bias is worse than no tool.

## Reporting honestly

Report the **full probability spread**, not just the top choice. A 40/35/25
split across three options is a genuinely open question, and the report must
say so — not render as "the answer is X." `askjev.ts` flags a top-two finish
within 15 points of each other automatically; treat that flag as real
information, not noise to explain away.

For `noul` batteries, report the single number that fired the gate and which
question drove it ("escalated on: does this touch the auth substrate?"), not
just a pass/fail.

## Running it

```bash
echo '{
  "state": "Ship the DFH ecommerce checkout now, or hold for one more review pass?",
  "framedBy": "assistant, leaning toward shipping now; user has not weighed in",
  "questions": {
    "ship_now": {
      "type": "choice",
      "instructions": "Given the state, which is the better call right now?",
      "criteria": {
        "ship": "Ship today, fix anything found in prod",
        "hold": "One more review pass before shipping",
        "do_nothing": "Neither — pause the whole checkout effort for now"
      }
    },
    "payment_untested": {
      "type": "noul",
      "instructions": "Has the payment path been tested against a real (non-sandboxed) processor response?"
    },
    "rollback_exists": {
      "type": "noul",
      "instructions": "Does a tested rollback path exist if this ships broken?"
    }
  }
}' | bun skill/tools/askjev.ts
```

Requires two env vars, nothing else:

- `CF_ACCOUNT_ID` — your Cloudflare account id
- `CF_API_TOKEN` — a Workers AI-scoped API token

Optional: `CF_AI_GATEWAY` (routes through an AI Gateway for logging/cost
tracking — engaged by a header, not a different URL) and `CF_AIG_TOKEN` (if
that gateway has authentication enabled).

## The API, if you need to go past the CLI

See `tools/decide.ts` — one function, `decide()`, three question types
(`noul`, `choice`, `score`), each with real gotchas documented inline
(`score` takes an array of levels lowest-first; passing it a record is a 400;
Workers AI nests the response at `result.result.answers`; a 429 body isn't
JSON). `maxGate()` and `confidenceBand()` are the two aggregation helpers this
skill relies on. Zero runtime dependencies — read it before extending it.

## Where this is still weak

This skill enforces the *first* failure mode (compound questions) only by
warning, not blocking — it can't tell a genuinely-separate multi-part
decision from a disqualifier list dressed up as one question, so read the
warning rather than dismissing it. It enforces the *second* failure mode
(framing bias) only by requiring the `framedBy` field to be non-empty; it
cannot verify the field is honest, or that the options were actually stated
neutrally. Both remain the model's discipline to hold, not something the tool
can check for you.
