# Routing review calls by complexity

The review pipeline can send every pull request to one model, or it can send cheap PRs to a cheap model and expensive PRs to a strong one. This describes the second option, which is entirely optional — the pipeline works without any of it.

## The idea

Two pieces already in this repo compose into it:

**`tier-classify`** runs on every PR and labels it `tier:trivial`, `tier:lite`, or `tier:full` from diff stats and sensitive-path matching. It is deterministic — no model involved — and it runs in seconds.

**`pre-pr-review`** calls a model to review the diff.

Wire the first into the second and review cost tracks review difficulty instead of being flat. A ten-line docs fix does not need your most expensive model; a nine-hundred-line change to authentication does.

There are two ways to do that, and the simpler one is genuinely fine.

## Option A — two models, no gateway

`call-reviewer.ts` already reads `REVIEW_MODEL` and `REVIEW_MODEL_LARGE` and picks between them on input size. Set both, set `REVIEW_API_BASE_URL` to your provider, done. No extra infrastructure, no vendor dependency, and it captures most of the benefit.

**Start here.** Only move to Option B if you actually want per-tier routing, budget caps, or automatic failover across providers.

## Option B — a gateway dynamic route

A gateway sits between the pipeline and the model providers, and decides which model to use from metadata your caller attaches to the request. The routing rules live in the gateway rather than in your code, so changing the model mix is a dashboard edit rather than a commit.

This section documents it for [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/), which is what this pipeline was built against. Any gateway offering conditional routing works the same way in principle; the specifics below are Cloudflare's.

### What you get

- **Route by tier.** `tier:trivial` → a small fast model. `tier:full` → your strongest.
- **Failover across providers.** One provider having a bad afternoon does not stop reviews.
- **Budget and rate caps** enforced at the gateway, with a fallback model when exceeded, rather than a failed run.
- **One set of credentials** at the gateway instead of a provider key per workflow.

### Setup

**1. Create a gateway.** Follow [Get started with AI Gateway](https://developers.cloudflare.com/ai-gateway/get-started/). Note its ID — you will need it in the URL.

**2. Create a dynamic route.** In the dashboard: **your gateway → Dynamic Routes → Add Route**. Routes are built visually as a node graph from Start to End. The node types relevant here:

| Node | What it does |
|---|---|
| **Model** | Calls a specific provider and model |
| **Conditional** | If/else branch on an expression over the request body, headers, or metadata |
| **Percentage** | Splits traffic probabilistically — useful for A/B testing a model swap |
| **Rate limit** / **Budget limit** | Enforces a quota and switches to a fallback when exceeded |

Give the route a name you will recognize. `pr-reviewer` is a reasonable one.

**3. Branch on metadata.** A Conditional node evaluates expressions referencing request metadata, which your caller supplies — the documented example form is `user_plan == "paid"`. For this pipeline the useful key is the tier the classifier already computed:

```
metadata.tier == "full"     → strongest model
metadata.tier == "lite"     → mid model
otherwise                   → small fast model
```

Size works equally well as the branch key if you would rather not depend on the label, since `call-reviewer.ts` already knows the combined input size.

**4. Point the pipeline at it.** A named route is invoked by putting it in the **model** field of an OpenAI-compatible request, prefixed with `dynamic/`:

```
REVIEW_API_BASE_URL = https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/compat
REVIEW_MODEL        = dynamic/pr-reviewer
```

Set both as repository secrets or variables. **Never commit an account ID or gateway ID** — they identify your account and belong in secrets, exactly like a key.

**5. Attach the metadata.** The gateway can only branch on metadata the caller sends, so the workflow must pass the tier through on the request. If you skip this step the route still works — every request simply takes the else branch — which is a safe failure but not a useful one.

### Verifying it actually routes

The failure mode here is silent: a route that always takes the else branch looks identical to one that is routing correctly, because both return a review. Do not assume it works because a review came back.

Open two PRs — one trivial, one large — and check the gateway's request log to confirm they resolved to **different models**. That is the only evidence that the conditional fired. If both show the same model, your metadata is not reaching the gateway.

This is the same class of problem the rest of this repository is about: a check that appears to pass while testing nothing.

Two failure modes are specific to named routes, and both were found the expensive way.

**Read the model the response says answered, not the one you asked for.** Once you put a route name in the model field, that string stops describing anything real. It names the route. The model that served the call is a separate field in the response envelope, and only that field is evidence. In this pipeline a route silently served its third-choice model for three consecutive calls — the requests looked correct, the reviews came back, and the only thing that showed the difference was the served-model field. Log both. The pair also tells you *which* thing changed later: same served model with a different provider means the infrastructure moved, a different served model means the route fell through.

**A nonexistent route fails quietly.** A typo in a route name does not produce a loud error. You get an unsuccessful call, the reviewer falls back, and the review still completes — so a single mistyped character disables one lens for as long as nobody looks. Verify each route the moment you create it, before wiring anything to it. One request with a fixed expected answer is enough:

```bash
curl -sS "$REVIEW_API_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $REVIEW_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"dynamic/<route-name>",
       "messages":[{"role":"user","content":"Reply with exactly: ROUTE_OK"}]}'
```

Check two things in the response: that the text is `ROUTE_OK`, and that the served model is the one the route was supposed to reach. Wire one slot, verify it, then wire the next.

### The slug does not name the infrastructure

When you request a model through an aggregating gateway, the slug names the model and says nothing about who serves it. Measured across one 818-trial run: a single requested slug was served by **twelve different companies**, and every one of 65 calls for a different vendor's model was served by a large cloud provider that was not that vendor.

If you have any data-handling policy, this is a policy question rather than a trivia field. One vendor's data policy does not govern another company's serving infrastructure. Log the provider the response reports — deriving it from the slug you sent produces a confident wrong answer, which is worse than having no field at all.

[MODEL-SELECTION.md §7](../MODEL-SELECTION.md) has the full provider spread.

### Reasoning tokens are billed and do not appear in the answer

A model can spend tokens you never see. A one-word route-verification probe in this pipeline — the `ROUTE_OK` call above — billed 17 output tokens, **10 of them reasoning tokens** absent from the completion text. On a short probe that is loose change. Across a fleet of ten reviewers on every pull request it is not, and budgeting from the visible output undercounts by whatever the model chose to think.

Record the reasoning-token count alongside the visible usage if your provider reports it. If it does not, treat any cost projection built from response lengths as a floor.

### Latency is a gate requirement, not a nicety

Reviewers run in parallel, so a review takes as long as its slowest lens. That makes tail latency a hard constraint on which models are usable at all, independent of quality.

**Rank candidate models on p90, not median.** A "flash" and a "pro" variant of one vendor's model had medians of 127s and 54s — a bad gap but a survivable one. Their p90s were **604s and 130s**. One of them stalls for minutes on roughly one call in ten, which across ten parallel lenses lands on most reviews, and the median understates that by more than half. The variant with the faster-sounding name was the slow one. Across the whole run, p90 ranged from 3 seconds to 604 seconds.

A useful diagnostic while you are at it: a transient problem shows up as a shifted median, and a structural one shows up as a persistent tail. Retest before excluding a model, then look at the tail rather than the middle.

## Notes and limits

- **Route creation is a dashboard action** in the version of the docs this was written against. A JSON-based configuration path is referenced but I have not verified it, so treat any automation of route creation as unconfirmed and check the current docs.
- **Keep a route definition in version control** if you use one — a dashboard-only config has no history and no review. A JSON file describing the intended rule chain, kept next to the workflow and updated when the route changes, is enough. Treat it as documentation rather than something that deploys.
- **Model names and provider prefixes change.** Pin what you verify, and re-check when a review starts failing for no apparent reason.
- **A budget or degraded-mode override that re-points a slot outside the routing layer throws away the model choices you measured.** This is worth stating because it is a natural thing to build and it quietly undoes the work. If a cost-pressure rule swaps a reviewer onto some cheaper path that bypasses the gateway, that lens is no longer running the model your evaluation chose, and the band you happened to be in becomes an input to which model judged your code. Two ways out. Either express the cheap option as another route and keep every path inside the same layer, or leave the override off. This repository ships no such mechanism, deliberately — there is nothing here to configure, and adding one is a decision rather than a default.
- **Which model belongs behind each route is a separate question, and it has an answer you have to measure yourself.** [MODEL-SELECTION.md](../MODEL-SELECTION.md) covers how to run that measurement against your own review history, and why a recall-only evaluation picks the wrong model.
- **A gateway is a dependency.** It is now in the path of every review. Decide deliberately whether that is a trade you want; Option A has no such dependency.
