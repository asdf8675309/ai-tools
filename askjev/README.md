# AskJev

A [Claude Code](https://claude.com/claude-code) skill that puts a live, open
decision to [TypeSafe's Jev](https://www.typesafe.dev/) — a "System One" model
that answers typed questions with calibrated numbers instead of prose — and
reports back a choice with a full probability spread, plus narrow yes/no
disqualifier checks.

The API call is twenty lines (`skill/tools/decide.ts`). Everything that makes
this useful instead of noise is in how the open question gets turned into a
decision payload, and that discipline lives in `skill/SKILL.md`. Two things
are load-bearing there, both from measured failures, not theory:

1. **Never ask one compound question.** A single calibrated yes/no covering
   several disqualifiers scored **-0.120 separation — the wrong direction, at
   chance.** Splitting it into seven narrow questions and aggregating with
   **max** (never a mean) moved it to **+0.251**.
2. **Whoever writes the options tends to win them.** The skill requires every
   payload to disclose who framed the decision (`framedBy`), and requires
   options — including "do nothing" and the option the assistant likes least
   — to be stated neutrally.

## Install

```bash
git clone https://github.com/asdf8675309/ai-tools.git
cd ai-tools/askjev
cp -r skill ~/.claude/skills/askjev
```

Requires [Bun](https://bun.sh) — nothing else. No npm, no build step, no
runtime dependencies.

**Contributors:** `bun test` works with nothing installed. `bun run
typecheck` needs `bun install` first, for dev-only type definitions —
`node_modules` is gitignored by design.

## Configure

Two environment variables, both required:

| Variable | What |
|---|---|
| `CF_ACCOUNT_ID` | Your Cloudflare account id |
| `CF_API_TOKEN` | A Workers AI-scoped API token |

Optional:

| Variable | What |
|---|---|
| `CF_AI_GATEWAY` | Route calls through a Cloudflare AI Gateway for logging/cost tracking. Engaged by the `cf-aig-gateway-id` **header** — never a `gateway.ai.cloudflare.com` URL, which is a different, OpenAI-chat-shaped path that can't express this payload shape at all. |
| `CF_AIG_TOKEN` | Gateway auth, if that gateway requires it |

No config file. No account beyond a Cloudflare account you already have to
call Workers AI at all.

## Use

Say something like "I'm not sure what to do next" or "should we do A or B"
mid-session. Claude reads `skill/SKILL.md`, frames the decision as one or more
typed questions (splitting any compound disqualifier into separate `noul`
questions), states who wrote the options, and runs:

```bash
bun skill/tools/askjev.ts payload.json
# or
echo '{ "state": "...", "framedBy": "...", "questions": {...} }' | bun skill/tools/askjev.ts
```

Output is the full probability spread for every question, a flag when a
choice/score result's top two options are within 15 points of each other
(read: this is genuinely open, not settled), and a max-aggregated escalation
line for any batch of `noul` disqualifier checks.

## The three question types

| Type | Shape | Returns |
|---|---|---|
| `noul` | Calibrated yes/no. `criteria` optional. | `noul` (0..1). **No** confidence field — the probability itself is the calibration signal. |
| `choice` | Pick one of a closed set. `criteria` is a **record** of option → description. An array is a 400. | `choice`, `confidence`, `probabilities` (full spread) |
| `score` | Ordered rubric. `criteria` is an **array** of level descriptions, lowest first. A record is rejected ("expected array, received object"). | `score` (interpolated, e.g. 1.3 — not an index), `confidence`, `legend` |

Other real gotchas, documented inline in `skill/tools/decide.ts`:

- 32,000-token ceiling on `state`.
- Workers AI nests the response twice: `result.result.answers`, not `answers`.
- HTTP 429 means throttled and carries `retry-after`; its body is plain text,
  not JSON — check status before parsing.

## Design

- **Self-contained.** This directory ships its own copy of the `decide`
  primitive rather than importing a sibling tool — this repo's convention is
  that every directory stands alone, no shared framework to adopt.
- **Zero runtime dependencies.** Bun ≥ 1.3, TypeScript, no build step.
- **No secrets, no absolute paths, nothing identifying.** Config is env vars
  only; see the repo's [CLAUDE.md](../CLAUDE.md) for the house rules this
  repo holds itself to.

## Where this is weak

The compound-question check is a warning, not a block — the tool can't tell a
genuinely multi-part decision from a disqualifier list dressed up as one
question. The framing-disclosure check only verifies `framedBy` is
non-empty; it can't verify the framing was actually neutral. Both remain
discipline the model has to hold, documented in `skill/SKILL.md`, not
something this tool can enforce for you.

