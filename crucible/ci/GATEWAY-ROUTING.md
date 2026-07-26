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

## Notes and limits

- **Route creation is a dashboard action** in the version of the docs this was written against. A JSON-based configuration path is referenced but I have not verified it, so treat any automation of route creation as unconfirmed and check the current docs.
- **Keep a route definition in version control** if you use one — a dashboard-only config has no history and no review. A JSON file describing the intended rule chain, kept next to the workflow and updated when the route changes, is enough. Treat it as documentation rather than something that deploys.
- **Model names and provider prefixes change.** Pin what you verify, and re-check when a review starts failing for no apparent reason.
- **A gateway is a dependency.** It is now in the path of every review. Decide deliberately whether that is a trade you want; Option A has no such dependency.
