# Choosing a model for each reviewer lens

Crucible assigns a model per reviewer slot rather than one global default. `skill/config.yaml`
has ten lines under `models:` and each one is a decision. This document is how those decisions
were made: what was measured, what the numbers were, which of them reversed under more data,
and the method — so you can run it against your own review history instead of inheriting mine.

The evaluation behind it: **818 trials across 14 models, about $30, run over two days at the
end of July 2026.** Task sets were mined from real Crucible review history — 147 recall tasks
covering all ten lenses, plus 38 clean-code controls.

The rankings are the least useful part. The method is the transferable part, and the single
most useful idea in it is the one in the next section.

---

## 1. One metric is a trap, in both directions

**A recall-only evaluation actively misleads.** It asks "did the model find the known defects?"
and the model that flags everything wins. That model is the worst possible reviewer for a merge
gate — it is the cry-wolf failure Crucible's whole two-pass architecture exists to fight. An
eval that rewards it is telling you to install the disease.

**A precision-only evaluation misleads just as badly.** It asks "did the model stay quiet on
clean code?" and the model that never says anything wins.

That is not hypothetical. In this run, `google/gemini-3.5-flash-lite` scored **0.72 precision** —
mid-pack, better than the Claude Sonnet incumbent's 0.71 — with a **median latency of one
second** and a cost near the bottom of the board. On a precision-only eval it looks like a
find: fast, cheap, disciplined.

Its recall was **0.00**. Not low. Zero. Across 18 recall trials it never once identified a
defect the historical reviewer had actually flagged.

The earlier per-role testing recorded in [CREDITS.md](./CREDITS.md#model-selection) measured
spurious rate only. It was useful — it is the reason `config.yaml` maps models per role at all —
but it could not have caught this, and neither can yours if you only run half the design.

### So: two task sets, two scores

| Task set | Question | What a good answer looks like |
|---|---|---|
| **Recall tasks** | Given a diff a reviewer actually reviewed, does the model find what that reviewer found? | Names the same defects, cites the same files |
| **Clean controls** | Given a diff a reviewer examined and cleared, does the model stay quiet? | Confirms the change is sound; makes no confident defect claim |

Score each 0–1, then **combined = recall + precision**, range 0–2.

The unweighted sum is a choice, not a derivation. It says a false positive costs about what a
missed defect costs. For a merge gate that runs on every PR, that is roughly right — noise is
what kills adoption. If your tolerance differs, weight it; just weight it deliberately and say
so, because the weighting is where the answer actually lives.

---

## 2. The headline: recall barely separated, precision separated a lot

Final ranking on the broad task set. Fifteen models were run; these are the ten that cleared
n ≥ 27, scored on a task-matched common set of 9 tasks (5 recall, 4 clean), with
infrastructure-errored trials excluded:

| # | Model | Recall | Precision | Combined | $/trial |
|---|---|---|---|---|---|
| 1 | `openai/gpt-5.6-luna` | 0.30 | **0.85** | **1.15** | **$0.0018** |
| 2 | `openai/gpt-5.6-luna-pro` | 0.26 | 0.84 | 1.10 | $0.0072 |
| 3 | `anthropic/claude-sonnet-5` *(incumbent)* | 0.32 | 0.71 | 1.03 | $0.2147 |
| 4 | `poolside/laguna-xs-2.1` | **0.33** | 0.70 | 1.03 | **$0.0012** |
| 5 | `openrouter/auto-beta` | 0.29 | 0.71 | 1.00 | $0.0516 |
| 6 | `inclusionai/ring-2.6-1t` | 0.32 | 0.65 | 0.97 | $0.0049 |
| 7 | `z-ai/glm-5.2` | 0.20 | 0.70 | 0.90 | $0.0251 |
| 8 | `moonshotai/kimi-k2.7-code` | 0.23 | 0.67 | 0.90 | $0.0435 |
| 9 | `thinkingmachines/inkling-small` | 0.25 | 0.61 | 0.86 | $0.0112 |
| 10 | `google/gemini-3.5-flash-lite` | 0.00 | 0.72 | 0.72 | $0.0029 |

Read the two score columns as ranges rather than rankings:

- **Recall: 0.20 → 0.33.** A 13-point spread, and the ordering inside it was not stable across
  n-thresholds.
- **Precision: 0.61 → 0.85** in this cut — and **0.45 → 0.85** on the focused four-lens set,
  where the worst model was 40 points below the best.

Three times the spread, on the axis nobody measures.

**On a fixed diff, most competent models find broadly similar defects. They differ enormously
in how much they invent.** That one fact reframes the whole selection problem — and it is
completely invisible to any evaluation that only measures whether the known bugs were found.

The practical consequence here: the top model beat the incumbent at **119× lower cost**, and its
entire margin was precision. The cost argument and the quality argument pointed the same way,
which is not what I expected going in.

---

## 3. Reversals — every early standout regressed

This is the section a findings doc usually leaves out, and it is the most useful one.

Four models led the board at some point during the run. All four moved, some by a lot:

| Model | Reading 1 | Reading 2 | Reading 3 | Direction |
|---|---|---|---|---|
| `z-ai/glm-5.2` | **0.82** (n=2) | 0.49 (n=4) | **0.20** (n=29) | collapsed |
| `openai/gpt-5.6-luna-pro` | **0.52** (n=4) | 0.23 (n=16) | — | collapsed |
| `poolside/laguna-xs-2.1` | 0.36 precision | 0.43 (n=69) | 0.47 (n=95) | recovered slightly, verdict held |
| `deepseek/deepseek-v4-pro` | excluded | 0.65 (n=13) | **0.98** (n=55) | rose from excluded to primary on two lenses |

GLM went from best-on-the-board to worst-on-the-board on the same task set. `luna-pro` looked
for about an hour like a free 2× recall upgrade over plain Luna at identical pricing; it isn't —
at n=16 it was slightly *worse* than plain Luna. DeepSeek-v4-pro was written off entirely on a
latency reading that turned out to be about a different model with a confusingly similar name,
then under-rated at n=13, and finished as the top scorer on the focused set.

### The generalizable lesson

**Precision estimates need clean-task volume specifically, not total trials.**

Every one of those reversals traces to the same mechanism, and it is a mechanism you will hit
too. Recall tasks outnumber clean controls in any mined corpus — real reviews that found
something are simply more common than real reviews that found nothing. If your runner works
through the task list in order, each model's *total* n climbs quickly while its *clean* n sits
at one or two. The combined score then looks well-sampled and its precision half is measuring
noise.

The worst call in the run was DeepSeek-v4-pro at n=13. That reading reported precision 0.45 and
placed it mid-pack. It had almost no clean-task samples behind it. At n=55 the same model's
precision was **0.78** and it took the primary slot on two lenses. A precision number computed
over two clean tasks is not a weak estimate — it is not an estimate.

### What to do about it

- **Report n per metric, never one n.** `n=55` is meaningless; `recall n=38, clean n=17` is
  actionable. Any table with a single n column is hiding this failure.
- **Interleave clean controls into the task order** instead of appending them, so precision
  accumulates alongside recall.
- **Set a floor before you rank.** Nothing here was trustworthy under roughly 10 clean trials
  per model. Below that, report the recall half and say the precision half is absent.
- **Expect early leaders to fall.** Two data points in a 0–1 score range prove nothing. Both
  models that led early were flagged as low-n at the time and both collapsed anyway, which is
  the point: knowing the caveat does not protect you unless you act on it.

---

## 4. Build the task set from your own review history

You do not need a benchmark. You need your own repo's review history, which is already labeled
by a process that ran months ago and had no idea it was producing training data.

**Recall tasks.** Each historical reviewer dispatch has a brief (which lens, what to look at)
and a result (what that reviewer found). Take the brief, materialize the diff into the prompt,
and use the historical findings as the reference answer.

Two details decide whether this works:

- **The diff must be embedded in the prompt, not referenced.** Historical briefs almost always
  say "review `<some git range>`" because the original agent had shell access. A one-shot
  evaluation runner does not. Resolve the commit at mining time and paste the patch in. In this
  corpus only 19 of 478 briefs were self-contained; replaying the diff at mine time is what
  took the usable count to 147.
- **Cut the parent-supplied context blocks.** Briefs routinely contain lines like "the parent
  already reproduced this live" — which leaks the answer into the task. Strip anything that
  states a conclusion.

**Clean controls.** Take briefs from rounds where the reviewer examined the diff and cleared
it — confirmation rounds after fixes are ideal, because they are real diffs a real reviewer
signed off on. The correct answer is "no defects." Any confident defect claim is spurious.

38 controls across 9 lenses was enough to separate the field. It was not enough to say anything
about any individual lens; see §8.

**Graders.** Two per task, so a single grader failure cannot decide a model's fate:

| Task type | Grader | Weight | What it checks |
|---|---|---|---|
| Recall | model rubric vs. reference findings | 0.6–0.7 | Did it identify the same problems? |
| Recall | regex on **any** file the historical reviewer flagged | 0.3–0.4 | Did it land in the right place? |
| Clean | model rubric | 0.6 | Did it confirm soundness without inventing? |
| Clean | regex | 0.4 | Absence of confident defect language |

**Sabotage-test your graders before you trust a single score.** Feed each one a known-correct
answer and a known-junk answer; it must accept the first and reject the second. The first
version of the recall regex here pinned the alphabetically-first flagged file, and **21 of 39
graders rejected correct answers** — models that named a different, equally correct file from
the same finding set were scored wrong. A passing grade is only evidence if a failing grade was
reachable.

**Exclude infrastructure errors; don't score them as zeros.** A provider returning an empty
completion is not a bad answer. One model in this run looked unreliable and mediocre until its
errored trials were re-run — the errors were endpoint flakiness on a model launched that
morning, and after the sweep it had 0 errors in 7 trials and led on recall. Delete errored
results and redo them.

---

## 5. Latency is a gate requirement, not a nicety

Ten lenses run in parallel per review, so a review is as slow as its slowest lens. A model with
a five-minute tail lands that tail on most reviews.

Median, p90 and max seconds per call, all 818 trials, segmented by the model that actually
answered:

| Model | n | Median | p90 | Max |
|---|---|---|---|---|
| `deepseek/deepseek-v4-flash-0731` | 35 | 127 | **604** | 3054 |
| `moonshotai/kimi-k3` | 21 | 111 | 393 | 452 |
| `deepseek/deepseek-v4-pro` | 104 | 54 | 130 | 444 |
| `anthropic/claude-sonnet-5` | 76 | 54 | 200 | 511 |
| `thinkingmachines/inkling-small` | 27 | 27 | 100 | 178 |
| `moonshotai/kimi-k2.7-code` | 27 | 26 | 221 | 1227 |
| `inclusionai/ring-2.6-1t` | 65 | 25 | 57 | 347 |
| `openai/gpt-5.6-luna-pro` | 68 | 24 | 39 | 53 |
| `z-ai/glm-5.2` | 76 | 22 | 76 | 267 |
| `openai/gpt-5.6-luna` | 98 | 17 | 98 | 473 |
| `poolside/laguna-xs-2.1` | 125 | 13 | 35 | 107 |
| `minimax/minimax-m3` | 20 | 13 | 57 | 302 |
| `thinkingmachines/inkling` | 27 | 10 | 40 | 133 |
| `google/gemini-3.5-flash-lite` | 30 | **1** | 3 | 4 |

Three things fall out of this.

**Rank on p90, not median.** The two DeepSeek rows have similar-ish medians and completely
different usability. Medians hide exactly the behavior that ruins a parallel fleet.

**Two variants of the same vendor's model differed by 5×.** On its launch day
`deepseek-v4-flash-0731` ran at a **281s median** against `deepseek-v4-pro`'s **52s** — and the
"flash" name points the wrong way. Retested the next day it was materially better (median 65s,
errors 2/9 → 0/9), so part of that was a bad launch day. The tail was not: individual samples
ran 31, 32, 39, 44, 65, 147, 215, 277, 283s. One call in ten still stalls for minutes, and
across all 35 trials the p90 is 604s. **A transient problem shows up as a shifted median; a
structural one shows up as a persistent tail.** Retest before excluding, then look at the tail.

**The incumbent was one of the slower options.** Claude Sonnet's 54s median and 200s p90 put it
mid-table. That was not on anyone's list of reasons to move a slot, and it should have been.

---

## 6. Vendor diversity is measurable, not a vibe

Crucible's premise is that cross-source convergence is the strongest signal a finding is real.
That premise dies quietly if the sources aren't independent — ten reviewers on one model give
you ten correlated opinions, not ten opinions.

You can measure this. Score every model on every shared task, then correlate the per-task score
vectors:

- Best single model across 10 shared tasks: **0.488**
- Per-task best across all 10 models: **0.614**
- **Ensemble headroom: +26%**
- A **3-model mix captured the entire gain** — the top model plus two low-correlation ones
  matched all ten combined.

**Most complementary pairs** (low r — they catch different things):
`inkling-small + poolside` r=0.69 · `kimi-k2.7-code + poolside` r=0.70 · `sonnet-5 + poolside` r=0.76

**Most redundant pairs** (high r — same behavior):
**`luna-pro + luna` r=0.97** · `kimi-k2.7-code + glm-5.2` r=0.96 · `luna-pro + glm-5.2` r=0.96

Two decisions came directly out of this:

**Never put two r=0.97 models in different slots.** `luna` and `luna-pro` were the top two
scorers overall, and the obvious move was to put one in each of the two best-matching lenses.
At r=0.97 you would be paying for two lenses and getting one opinion — precisely the failure
the architecture exists to prevent. The recommendation that follows keeps `luna` out of any
primary slot for exactly this reason — it belongs in a fallback position behind a
low-correlation model, not beside its own twin.

To be precise about what this repository does and does not do: that demotion is advice for the
route you build, not a wiring this config performs. `skill/config.example.yaml` defines a key for
`luna-pro` and none for plain `luna`, and per-lens fallback orders are not something a gateway
slot can express there — they live in your gateway route. The config can tell you which model
leads a lens. It cannot tell you what stands behind it.

**Low precision is not automatically disqualifying — it depends on your architecture.**
`poolside/laguna-xs-2.1` had the worst precision on the focused set and appears in 5 of the 6
most-complementary pairs. It finds things nobody else finds, plus noise. In most review
architectures that is a liability. In one with a working adversarial disprove pass it is
arguably coverage, since Pass 2 exists to kill exactly that noise. It is held out here anyway,
because that claim should be tested before it is trusted, not assumed.

The caveat on the headroom number: 10 tasks is thin, and "per-task best" is normally an oracle
upper bound. It is less of an overreach in this specific case, because Crucible genuinely runs
every reviewer and unions the findings — the union is how the system actually works, not a
hypothetical.

---

## 7. The model slug does not name the infrastructure

When you request a model through an aggregating gateway, the slug names **the model**. It says
nothing about **who serves it**.

Across this run, the model actually answering was recorded alongside the serving provider. The
spread was not marginal:

| Requested slug | Distinct serving providers | Examples |
|---|---|---|
| `deepseek/deepseek-v4-pro` | **12** | GMICloud, StreamLake, AtlasCloud, Novita, Ionstream, SiliconFlow, CoreWeave, Parasail, Together, Cloudflare, DigitalOcean, Venice |
| `moonshotai/kimi-k2.7-code` | **12** | Ambient, Fireworks, Parasail, Moonshot AI, DeepInfra, Novita, … |
| `minimax/minimax-m3` | 7 | GMICloud, Novita, Venice, Parasail, AtlasCloud, Morph, Together |
| `z-ai/glm-5.2` | 5 | CoreWeave, StreamLake, Ambient, Together, Inceptron |
| `anthropic/claude-sonnet-5` | 1 | **Amazon Bedrock — 65 of 65 calls** |
| `openai/gpt-5.6-luna` | 1 | OpenAI |
| `poolside/laguna-xs-2.1` | 1 | Poolside |

Read that Bedrock row again. Every single call requesting an Anthropic model was served by
Amazon, and nothing in the slug hinted at it. Separately, requesting a DeepSeek model got a
different third party on essentially every call.

**If you have any data-handling policy at all, this is a policy question, not a trivia field.**
Anthropic's data policy does not govern Bedrock. DeepSeek's does not govern AtlasCloud. Blocking
a model family because its serving providers train on submitted data — which is a real setting
on at least one aggregator, and which excluded a whole vendor from this evaluation — does
nothing about a model family whose serving providers you never looked at.

Two practical rules:

1. **Log the response's `provider` field, not the slug you requested.** Deriving it from the
   slug is worse than not having it: it produces a confident, wrong answer. That bug shipped in
   the first version of this run's logging and was only caught by reading a raw response
   envelope.
2. **Log the served model separately from the route name.** If you front models with named
   routes, the route name is a stable interface and that is a feature — but it means the name in
   your config is not evidence of what answered. Recording both distinguishes "the
   infrastructure moved" (same served model, different provider) from "the route silently fell
   through to a different model" (different served model). Without both fields those look
   identical. A route in this setup silently served a different model for three calls before
   anyone noticed, and the served-model field is the only reason anyone did.

### Router models are not a shortcut

`openrouter/auto-beta` — a router that picks a model per call — looked like a way to get
diversity for free. It isn't. Across **89 routed calls spanning all ten lenses it surfaced only
four distinct models**: GLM-5.2 (53%), DeepSeek-v4-pro (34%), Sonnet-5 (12%), DeepSeek-flash
(1%). The pool is narrow, it cost 29× more than the model it mostly routed to, and it was
slower.

The deeper problem is attribution. **A regression you cannot pin to a model is a regression you
cannot fix**, and the model here is different on every call. Defensible as the last entry in a
fallback chain, where the alternative is no reviewer at all. Not defensible as a primary.

---

## 8. Per-lens recommendations, with their evidence

Numbers below are from the focused set — 19 tasks over four lenses, 302 trials, 0 errors — except
where noted. **Read the evidence column before the model column.** Three slots have no
lens-isolated data at all and are listed only so you know they were not tested.

**The n column counts trials per model, not distinct tasks.** Each task ran two to three times
per model, so `platform`'s "11 / 9" is 11 recall trials over 4 distinct recall tasks and 9 clean
trials over 3 distinct clean tasks. The Appendix's corpus-depth table counts the distinct tasks,
which is why its numbers are smaller. Both matter, and they answer different questions: trials
tell you how stable a score is, distinct tasks tell you how much of the lens you actually
covered. Four tasks is thin however many times you run them.

| Lens | Recommended | Combined | n (recall / clean) | $/trial | Evidence quality |
|---|---|---|---|---|---|
| `code_quality` | `openai/gpt-5.6-luna-pro` | **1.10** | 8 / 2 | $0.0072 | **Strong on precision, thin on clean n.** 1.00 precision — but on 2 clean tasks. Recall 0.10 vs Sonnet's 0.23. |
| `platform` | `deepseek/deepseek-v4-pro` | **0.95** | 11 / 9 | $0.0154 | **Strong.** Beats the Sonnet incumbent (0.67) on all three axes — quality, cost (an order of magnitude, per the $/trial column), and median latency. Best-sampled lens in the set. |
| `history_analyzer` | `deepseek/deepseek-v4-pro` | **1.01** | 9 / 5 | $0.0154 | **Good.** vs `luna` 0.89, Sonnet 0.66. |
| `simplify` | `google-ai-studio/gemini-3-flash-preview` | — | — | — | **Prior round only.** 0% spurious vs Sonnet 8% in the earlier precision-only testing. Not re-tested here. |
| `typescript` | `google-ai-studio/gemini-3-flash-preview` | — | — | — | **Prior round only.** 10% spurious vs Sonnet 31%, and it found three times as many legitimate issues. Not re-tested here. A *different* gemini variant scored 0% on this lens — see the correction note below. |
| `test_runner` | external CLI, flat-rate | — | — | — | **Prior round only.** 0% spurious vs Sonnet 12%. Runs on a flat-rate coding CLI; routing it to a metered gateway costs money for no measured gain. |
| `security` | *unchanged incumbent* | — | — | — | ⚠️ **Never lens-isolated. Not a recommendation.** Highest-stakes lens; do not move it on general-purpose data. |
| `ci_tamper` | *unchanged incumbent* (smallest model) | — | — | — | ⚠️ **Untested on this lens.** Pure YAML pattern-matching; the smallest model holds. |
| `pr_continuity` | *unchanged incumbent* | — | — | — | ⚠️ **2 tasks, ZERO clean controls. Not a verdict.** See below. |
| `clone_detector` | *n/a* | — | — | — | Local embedding model, not an LLM. No selection to make. |

### Correction — the typescript row named the wrong gemini variant

The first version of this document credited `gemini-3-flash-preview` with **0% spurious** on the
typescript lens. That figure belongs to `gemini-3.5-flash`, a different model. The variant
actually wired into the config scored **10%**. Both beat the Sonnet incumbent's 31%, so the
recommendation does not change — but the number was wrong, and it was wrong in the direction
that flatters the recommendation, which is the direction to be most suspicious of.

The source table is right there in [CREDITS.md](./CREDITS.md#model-selection) with both variants
on adjacent rows. Two models one dot apart in a version string, tested on the same lens in the
same round, and the write-up merged them. The neighbouring `simplify` row is where the confusion
probably started: there `gemini-3-flash-preview` genuinely did score 0%.

Worth stating what this cost and what it didn't. It changes no assignment. It does mean that
anyone who read the earlier version and reasoned "the typescript reviewer is a 0%-spurious
model" was reasoning from a number that never existed. **Cite the model string exactly, including
the parts that look like noise** — a variant suffix is not a formatting detail.

### `pr_continuity` is what an untested slot looks like

It is the newest reviewer, so there is barely any history to mine. Two recall tasks, no clean
controls. Here is the entire result:

| Model | Recall | n | Precision |
|---|---|---|---|
| `poolside/laguna-xs-2.1` | 0.32 | 10 | — |
| `inclusionai/ring-2.6-1t` | 0.30 | 4 | — |
| `anthropic/claude-sonnet-5` | 0.30 | 4 | — |
| `openai/gpt-5.6-luna` | 0.24 | 4 | — |
| `deepseek/deepseek-v4-pro` | 0.18 | 6 | — |
| `openai/gpt-5.6-luna-pro` | 0.09 | 4 | — |

A model tops that table. It would be easy to write "recommended: poolside" and move on. But the
precision column is empty by construction, the spread across the middle four is 6 points on
n=4, and this is the same shape as every reading that reversed in §3. **The slot stays on its
incumbent and this is reported as an absence of evidence, not a weak result.** An untested slot
presented as a recommendation is worse than no document.

### Lens results contradicted the general ranking

Worth knowing before you generalize a single overall ranking to ten slots: `poolside` ranked
4th overall on the broad set with 0.70 precision, and was the **worst of six** on the focused
four lenses at 0.48. Same model, same grader, different lenses. Per-lens testing is not
ceremony — it changed the answer.

---

## 9. What this does not measure

- **One-shot review of an embedded diff — not tool use.** The historical reviewers had file and
  shell access: they found the right files, read surrounding code, and decided when to stop. The
  evaluation runner hands the model a patch and asks for a verdict. That is a genuinely easier
  and different task. It is a proxy. It is a proxy with a track record — the earlier round's
  swaps, chosen the same way, held for two months — but say "proxy" out loud.
- **The reference answers are one reviewer's output, not ground truth.** A model that finds a
  real defect the historical reviewer missed scores as wrong. Recall here means "agrees with the
  prior reviewer," which is a lower bar and a different one.
- **The recall grader is a model.** The clean-control regex half is deterministic; the rubric
  half is not. Judge bias is in the numbers.
- **One codebase, one team's conventions.** Findings framed as deviations from *this* repo's
  patterns will not transfer to yours. Mine your own history — that is most of the point.
- **Prices and model versions move in hours.** Two models in this table had their list price cut
  the day after these numbers were taken. Treat every $/trial figure as a measurement with a
  date on it, not a constant.
- **Sample sizes are small.** The strongest lens in the set had 20 trials per model. Every
  number here is a shape, not a benchmark.

---

## 10. Running it yourself

1. **Mine recall tasks** from your own review history. Brief + embedded diff + the historical
   findings as reference. Strip any context block that states a conclusion.
2. **Mine clean controls** from reviews that cleared a diff. Target at least 10 per model per
   lens you actually care about — this is the constraint that decides whether your numbers mean
   anything.
3. **Write two graders per task** and sabotage-test both: known-good must pass, known-junk must
   fail.
4. **Interleave clean and recall tasks** in the run order.
5. **Run one model at a time**, log the served model and the serving provider from the response
   envelope, and delete-and-retry infrastructure errors instead of scoring them.
6. **Report recall n and clean n separately.** Refuse to rank any model whose clean n is under
   your floor.
7. **Correlate per-task score vectors** across models before assigning slots. Two models above
   r≈0.95 are one opinion; do not buy it twice.
8. **Check p90 latency**, not median, against the number of lenses you run in parallel.
9. **Wire one slot, verify what actually answered, then wire the next.** Enabling
   `integrations.verdict_log` gives you the data to keep score after the fact — which is how you
   find out that an evaluation-time winner behaves differently in production.

Then change one line in `config.yaml` per slot, and keep the revert path to a single line, which
is the reason the config indirection exists.

---

## Appendix — run parameters

| | |
|---|---|
| Trials | 818 |
| Models | 14 named models plus one router |
| Cost | $30.10 |
| Recall tasks mined | 147, spanning all 10 lenses |
| Clean controls mined | 38, spanning 9 lenses |
| Broad set | 10 tasks (6 recall / 4 clean), 15 models |
| Focused set | 19 tasks over 4 lenses, 302 trials, 0 errors |
| Scoring | combined = recall + precision, unweighted, 0–2 |
| Errored trials | deleted and re-run, never scored as 0 |

Corpus depth by lens, which is the number that decided which recommendations are real:

| Lens | Recall tasks | Clean tasks | What it can support |
|---|---|---|---|
| `platform` | 4 | 3 | Both metrics — act on it |
| `code_quality` | 4 | 1 | Recall solid, precision on one task |
| `history_analyzer` | 3 | 2 | Weak but real |
| `pr_continuity` | 2 | **0** | Recall signal only — not a verdict |

The other six lenses were mined but not run in lens isolation.
