# ai-tools

Agent tooling built for daily use, extracted and made standalone.

Everything here started as something I actually needed and kept using. These are working tools pulled out of a private setup and rewritten to stand on their own — no shared framework, no config tree to adopt, nothing that assumes you run things the way I do. Each directory is independent: take one, ignore the rest.

## Tools

| Tool | What it is |
|---|---|
| **[crucible](./crucible)** | A pre-merge code review gate. Ten reviewers enumerate problems in parallel, then an adversarial second pass tries to disprove every one of them. Built around the observation that AI review fails from false positives, not missed bugs. Ships with a GitHub Actions pipeline, an optional deep-security scanner integration, and a written record of what three months of real use taught. |
| **[pr-babysit](./pr-babysit)** | The part after review: carrying a pull request from "review finished" to "merged" without the review going stale. An explicit state machine for waiting on CI, reading every review channel before enqueuing, and knowing which statuses mean *wait* rather than *fail* — plus a poller that watches a PR and prints only the transitions that need you. |
| **[agent-guards](./agent-guards)** | Hooks that stop an agent from reporting success it never verified, running a check that silently tests the wrong thing, looping on a failing action, leaking identifying strings into a public file, or making a repository public. Install one, all, or none. |

They compose — review, then merge, with guards underneath — but nothing depends on anything else. Take one and ignore the rest.

## What this assumes

Stated up front so you can tell in thirty seconds whether it fits your setup. Where a tool departs from these, it says so at the point of departure.

| Assumption | Detail |
|---|---|
| **Claude Code** | Skills, hooks, and parallel subagent dispatch are the harness features everything is built on. The reviewer prompts and reference docs are plain Markdown and port to any harness; the hooks and skill wiring do not. |
| **Bun, not npm or node** | Every local tool is a Bun script or plain POSIX shell — nothing needs node. **Bun ≥ 1.3** specifically — config parsing uses the built-in `Bun.YAML`, which is what lets the skills ship with zero runtime dependencies and run the moment you copy them. There is no `npm install` step anywhere. |
| **macOS, mostly by default rather than by requirement** | This was built and used on macOS. Almost everything is POSIX shell and TypeScript that runs anywhere. The genuine exceptions are two spots in the optional Metis integration: starting Docker Desktop (`open -a`) and quitting it (`osascript`). Both are macOS-only, both degrade to a clear "Docker is down, skipping" elsewhere, and both are documented where they live. |
| **git, and GitHub for anything PR-facing** | The review gate, the babysit workflow, and the CI pipeline assume GitHub and the `gh` CLI. The review *engine* itself only needs git — it reviews a diff and does not care where the repo is hosted. |
| **Linux in CI, deliberately** | The GitHub Actions workflows run on `ubuntu-latest`. That is the one place the macOS assumption is explicitly not made, because runners aren't Macs. |
| **Docker, only if you want Metis** | The optional deep-security scanner needs Docker and a Postgres container. Nothing else in the repo does, and the review runs complete without it. |
| **An LLM provider, for the CI pipeline only** | `crucible/ci/` is the one exception to everything above. Its GitHub Action calls a model directly, so it needs a base URL, a model name, and an API token as repository secrets — an account, a key, and a hosted endpoint. Nothing else in the repo does, and the review skill itself does not. |

Everything else is opt-in. No tool you run **locally** requires an account, an API key, or a hosted service to produce its first useful output.

## Design principles

These hold across everything in the repo.

**It runs with nothing installed.** Sophisticated capabilities are opt-in integrations that degrade gracefully, never prerequisites. A tool that needs three services configured before it does anything useful is a tool nobody tries.

**Self-contained.** No tool imports from another, and none reaches outside its own directory. Copy the folder, get the whole thing.

**Configuration references secrets, never contains them.** Config holds the *name* of an environment variable. There are no keys, tokens, or credentials anywhere in this repo, including in examples and test fixtures.

**Nothing edits your setup behind your back.** Installers print what they would change and wait. Anything that modifies a config file you own asks first, every time.

**Honest about failure.** A tool that blocks a command tells you exactly when it will, why, and how to bypass it. A gate you can't predict is a gate you'll uninstall.

## How this was written

Nearly all of the code and prose in all three tools was drafted with Claude Code, directed and reviewed by me. Saying so up front rather than leaving you to infer it: tools that ask you to trust their judgment about your code should be forthright about their own provenance.

What is mine is the part that decides what these are — which failures were worth encoding, which sources got mined, what got kept and what got cut, and every incident behind the lessons. The drafting largely was not. After this many rounds the two are hard to separate cleanly, which is itself worth knowing before you weigh anything here.

[`crucible/CREDITS.md`](./crucible/CREDITS.md) has the fuller version, along with what each part was borrowed from.

## License

MIT
