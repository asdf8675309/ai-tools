# multica-jev

An open-source, advisory Jev decision tool for Multica agents. It exposes one
small typed tool to both OpenCode and Pi while keeping the decision policy and
TypeSafe client in a host-neutral module.

## Why this shape

Jev is a decision primitive, not a chat model: it receives state plus focused
Choice, Score, and Noul questions and returns typed answers with probabilities.
That makes it useful for routing, risk checks, and escalation signals, but not
for writing the agent's answer or replacing a human decision.

OpenCode is the recommended first deployment for this workspace because its
plugin API can register a custom tool directly. Pi can load the same npm package
as an extension. An MCP-only implementation would work in OpenCode but would
need an additional adapter for Pi, which deliberately keeps MCP out of its
core. The package therefore has a shared core plus native thin adapters.

## Install

Set the TypeSafe API key in the agent environment when using the direct
provider. Do not commit it or put it in a repository config file:

```bash
export TYPESAFE_API_KEY=...
```

The decision call can also use the same OpenRouter account already used by
OpenCode. Select that backend; it defaults to OpenRouter's TypeSafe Jev route,
and can be overridden when needed:

```bash
export MULTICA_JEV_PROVIDER=openrouter
export OPENROUTER_API_KEY=...
# Optional override; the default is ~typesafe/jev-latest.
export MULTICA_JEV_MODEL=your-openrouter/model
```

`OPENROUTER_MODEL` is also accepted as an override. When an OpenRouter key is
present and no provider is specified, the tool selects OpenRouter; set
`MULTICA_JEV_PROVIDER=typesafe` to force the direct provider. OpenRouter mode uses the
native OpenRouter Decisions endpoint (`/api/alpha/decisions`) and returns the
same typed answer shape as the direct TypeSafe path; it is not a chat-
completion emulation or a second write path.

OpenCode:

```bash
npm install multica-jev @opencode-ai/plugin
```

Add the plugin to `opencode.json`:

```json
{
  "plugin": ["multica-jev/opencode"]
}
```

Pi:

```bash
pi install npm:multica-jev
```

The package manifest loads `adapters/pi.mjs` as a Pi extension. The extension
registers the same `multica_jev_decide` tool.

### In a container image

If your OpenCode runs from an image with a read-only plugin directory, install
the package there at build time and drop in a loader that points at it:

```dockerfile
COPY multica-jev-<version>.tgz /tmp/multica-jev.tgz
RUN mkdir -p /usr/local/share/opencode/plugins/multica-jev \
    && tar -xzf /tmp/multica-jev.tgz --strip-components=1 \
        -C /usr/local/share/opencode/plugins/multica-jev \
    && npm install --prefix /usr/local/share/opencode/plugins/multica-jev \
        --omit=peer --ignore-scripts --no-audit --no-fund \
    && rm /tmp/multica-jev.tgz
```

Then have the entrypoint copy `deploy/opencode-entrypoint.mjs` into the
directory OpenCode scans, named with a `.js` extension so it is discovered:

```bash
cp "${plugin_source}/multica-jev/deploy/opencode-entrypoint.mjs" \
   "${plugin_target}/multica-jev.js"
```

That loader is a three-line re-export. Keeping the package itself outside the
scanned directory preserves a normal npm layout, which is what lets the same
source load as a Pi package. Adjust the absolute path in it if your image uses
a different plugin root.

Pass credentials through the environment rather than as command-line
arguments, so they do not appear in the process table.

## Use from an agent

Ask the agent to call `multica_jev_decide` with the task state. The default
`triage` asks for actionability, human-review signal, and risk in one
decision request. `risk` and `review` provide narrower built-in question
sets. `route` classifies the next handler, scores complexity, and asks whether
the route deserves supervisory review. It does not invoke that handler. The
`prioritize` purpose scores impact, urgency, and effort together and returns a
transparent weighted 0–1 priority signal; it does not change an issue or board
field. The optional `provider` argument can override `MULTICA_JEV_PROVIDER` on
one call.

For a custom decision, provide a JSON object in `questions_json`:

```json
{
  "route": {
    "type": "choice",
    "instructions": "Which work lane best fits this state?",
    "criteria": {
      "investigate": "Evidence gathering",
      "implement": "Clear implementation",
      "report": "Report or receipt only"
    }
  },
  "needs_review": {
    "type": "noul",
    "instructions": "Should a human review the next consequential step?"
  }
}
```

For agent-generated questions, the tool also accepts a prompt-friendly shape
and normalizes it before sending it to either provider:

```json
{
  "route": {
    "type": "choice",
    "question": "Which work lane fits this state?",
    "options": ["investigate", "implement", "report", "wait"]
  }
}
```

Keep the original request in `state`. Make each question one atomic judgment;
send independent questions together, and add an `other` or `none_of_the_above`
option when the listed choices may not cover the state. Use returned confidence
to route or request review in code; it is not permission to take a protected
action.

The tool returns JSON containing Jev's resolved model, typed answers,
probabilities/confidence supplied by Jev, token usage, and a `multica` marker
that says the result is advisory only, including the selected provider.

Three real results, from an agent dispatched through Multica:

```
# choice — "which caching strategy first?", four options
chosen: http_cache_control_headers_at_the_edge (0.55), confidence 0.41
model: typesafe/jev-1.13-20260917, provider: openrouter
```

The low confidence there is the useful part. The question was genuinely
underdetermined without knowing the workload, and a calibrated answer says so
with a number instead of picking firmly.

```
# noul + score in ONE call, over one state
hidden_risk   (noul):  0.92
test_adequacy (score): 2 of 4 — "tested locally under light load", confidence 1
```

Several questions over one state is one request and one state charge, which is
the main reason to batch them.

```
# a protected decision — asking whether a review finding is real
MulticaJevPolicyError: This plugin will not automate a protected Multica
judgment. Ask the human or supervising session instead.
```

No answer payload comes back for that one. See **Safety boundary** below.

Pin `model` when thresholds matter, for example `jev-1.13.0`. The default is
`jev-latest`. `MULTICA_JEV_MAX_STATE_CHARS` can lower the maximum accepted state
size; oversized state is rejected instead of silently truncated.

## Safety boundary

This package has no Multica, repository, issue, or comment write path. It also
refuses custom questions that try to automate these protected judgments:

- resolving a review thread;
- judging whether a finding is real;
- scoping or creating a card; and
- deciding that an issue is decision-gated.

Those decisions belong to a human or the supervising session. Jev's confidence
is evidence for routing and escalation, not authorization to take a protected
action.

The package intentionally sends only the supplied state and questions to
TypeSafe. It does not include `MULTICA_TOKEN` or other credentials in the
request. Multica's task environment variables remain available to the host
agent, but are not read by this tool.

## Local checks

```bash
npm test
```

The tests mock the TypeSafe client and cover the request fan-out, question
validation, and protected-decision policy. A live API call requires a
`TYPESAFE_API_KEY` and is deliberately not part of the default test suite.

## License

MIT. See [LICENSE](./LICENSE).
