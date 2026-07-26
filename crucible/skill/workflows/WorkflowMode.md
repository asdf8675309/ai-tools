# WorkflowMode — Crucible as a Native Dynamic Workflow


> **No automated verification.** `crucible.workflow.js` targets the Claude Code
> workflow runtime's own wrapper, which parses it differently from standalone
> JS (top-level `return` is valid there). Nothing in this repo typechecks or
> tests it — it sits outside `tsconfig.json`'s include and no test references
> it. It is the largest unverified artifact here; treat changes to it as
> needing a real run to validate, not a green suite.

The native dynamic-workflow edition of Crucible. Ports the eleven-phase prose review
(`FullReview.md`) into a journaled JS orchestration script so the run is
**resumable** and **observable in the `/workflows` TUI**, with intermediate
candidate lists held in script variables instead of the parent context window.

This is **additive**. `FullReview.md`, `SecurityOnly.md`, and `DeltaReview.md`
remain the stable prose path. Reach for this edition when you want resume,
per-agent drill-down, or to run Crucible as a saved `/crucible-wf` command.

**Naming:** the Crucible *skill* (`/crucible`) and this dynamic *workflow*
(`/crucible-wf`) are deliberately distinct names so invoking one never gets
confused with the other. `/crucible` → prose `FullReview.md` by default.
`/crucible-wf` → this journaled JS edition.

## Requirements

- A Claude Code build with dynamic workflows enabled (a research-preview feature at time of writing). Verify with `claude --version` and check your build's release notes for workflow support.
- Workflows must not be disabled (`disableWorkflows` in settings.json / `CLAUDE_CODE_DISABLE_WORKFLOWS`).

## Install (one-time)

The canonical script lives with the skill at `workflows/crucible.workflow.js`
(so it's backed up and travels with Crucible). Native Claude Code discovers
workflows in `~/.claude/workflows/`, so symlink it there:

```bash
mkdir -p ~/.claude/workflows
ln -sf /absolute/path/to/crucible/skill/workflows/crucible.workflow.js ~/.claude/workflows/crucible-wf.js
```

It then runs as `/crucible-wf`. (If your CC build doesn't resolve symlinks in the
workflows dir, `cp` instead and re-copy after edits.)

## Run

- `/crucible-wf` — review the current local branch vs `origin/main`, autopilot on.
- Pass args for a PR / review-only / a non-default skill install location:
  - `pr: "<PR#>"` — review a GitHub PR.
  - `repo: "<absolute path>"` — target repo, when it differs from cwd.
  - `skillDir: "<absolute path to your installed Crucible skill>"` — needed if the runtime can't already resolve `tools/`, `agents/`, `references/` relative to where the skill loaded from. Every tool/agent-checklist path in this script is built from this (or a bare relative path when omitted).
  - `autopilot: false` — **review-only** fallback: runs Phases 0–5 + report, returns findings, applies no fixes and makes no commits. The parent session (you) then fixes with the human in the loop.
  - `securityOnly: true` — Security reviewer only (mirrors `SecurityOnly.md`).

## Architecture (how the phases map)

| Phase | What runs |
|-------|-----------|
| Preflight | one agent: resolve config via `tools/Config.ts` + eligibility (Phase 0) + `CodebasePatternsScanner.ts` (Phase 1) + `ReviewPacketGenerator.ts` (Phase 1.5). Early-returns BLOCK if ineligible. |
| Verify | one agent: build + typecheck + tests fast-fail (Phase 2). Early-returns BLOCK on failure — no reviewers spawned. |
| Review | `pipeline()` over reviewers; each reviewer enumerates (Pass 1) then its candidates flow straight into per-reviewer disprove (Pass 2) with no barrier. Split-severity = two passes/reviewer. |
| Consolidate | barrier. Mechanical filters in pure JS (disproven, confidence floor, per-reviewer cap by impact−0.5·effort); one agent for semantic deny-list match + cross-reviewer dedup. |
| Fix | autopilot agent (worktree-isolated): applies CRITICAL/HIGH, re-verifies, files MEDIUM/LOW issue, commits. Skipped when `autopilot:false`. |
| Report | deterministic JS template → APPROVE/WARNING/BLOCK + Verification Criteria. |

## Full parity via wrapper agents

`agent()` spawns **Claude-family subagents only**, so Crucible's non-Claude
routes are preserved by wrapping each in a `general-purpose` agent that shells
out or makes an HTTP call — `tools/Config.ts` stays the single source of truth
and decides per-reviewer which path runs:

- **Gateway reviewers** — any role whose `models.reviewer_<role>` resolves `kind: "gateway"`: wrapper POSTs to the OpenAI-compatible endpoint in `integrations.gateway.base_url`, with `reviewer_fallback_chain` (ending in a `claude-*` key) so the reviewer always runs even if the gateway is down.
- **Cross-vendor disprove** — when `integrations.gateway.enabled` and `models.disprove_cross_vendor` is set, CRITICAL/HIGH candidates get a second opinion from that model; both the primary and cross-vendor verdicts must fail to disprove for the finding to survive.
- **Local clone detector** — when `models.reviewer_clone_detector` resolves `kind: "local"`, wrapper shells `bun tools/SemanticCloneDetector.ts` against your configured local embedding endpoint (`local_model_map`), MRS threshold from `thresholds.clone_mrs_threshold`.
- **External-CLI reviewers** — when a role resolves `kind: "external_cli"` (e.g. an `external_cli_map` entry pointing at `codex exec`), wrapper shells that command as a subprocess and parses its structured output, falling back to a local Claude agent on any failure.

**Cost note:** each wrapper spends a full subagent context to shell one call —
higher token cost than the prose version's direct dispatch. Bounded and
acceptable; a future Claude Code release allowing non-Claude `agent()` models
would collapse the wrapper.

## Autopilot safety rail

Autopilot is default-on but railed: the fix agent refuses to commit
on `main`/`master`/protected branches, makes a **separate** commit (never
`--amend`, never force-push), and **reverts + reports** if re-verification fails
rather than committing broken code. To stay fully hands-off-free, run with
`autopilot: false` (review-only) and apply fixes yourself.

## Extending: adding your own scanner phase

The same seam described in `FullReview.md` (right after its Phase 2) applies here, expressed as script steps instead of prose:

1. Add a `phase('YourScanner')` block between the `Verify` and `Review` phases.
2. Spawn a wrapper `agent()` that shells your tool and returns findings matching the `CANDIDATES_SCHEMA` shape used everywhere else in this script (`{ reviewer, candidates: [...] }`).
3. Push its candidates into `allJudged` alongside the Pass 1/2 output before the `Consolidate` phase runs — the same mechanical filters (disproven, confidence floor, per-reviewer cap, deny-list) then apply to them for free.
4. Wrap the agent call so a missing tool or a non-zero exit degrades to an empty candidate list with a logged reason, never a thrown error that aborts the whole run — see the `passRefusedOrFailed` / reliability-gate pattern already in this script for the shape to match.

There's no first-party config knob for this in `config.yaml` — it's your own addition, so gate it however makes sense for your setup (an env var, a `.crucible.yaml` flag you invent, or just always-on if your team always wants it).

## Gotchas

- **Symlink drift.** If your CC build copies rather than symlinks, edits to `workflows/crucible.workflow.js` won't reach `~/.claude/workflows/crucible-wf.js` until you re-copy. Symlink avoids this.
- **No `Date.now()`/`Math.random()` in the script.** They throw (breaks journaling). Timestamp any external log from the launching wrapper with shell `date`, not inside the script.
- **Reviewer fan-out is naturally large.** 10 reviewers × 2 split-severity passes = 20 parallel agents, plus one disprove agent per reviewer with candidates. If your Claude Code plan or tier enforces a concurrent-subagent limit, batching (see `thresholds.reviewer_batch` below) becomes necessary — the cost is a few extra queued rounds of wall-clock, not a correctness problem.
- **Research-preview API drift.** The `agent`/`parallel`/`pipeline` primitives can change before GA. This file describes the architecture, not a pinned API version — check your Claude Code build's own workflow documentation if a primitive's signature has moved.
- **Resume.** Stop a run with `x` in `/workflows`; re-running returns cached results for completed `agent()` calls and only re-runs the remainder. Same script + same args = full cache hit.
- **Parity routes need their backends.** Gateway reviewers need a working, enabled gateway; the local clone detector needs a reachable local endpoint. If neither is available, the fallback chain keeps the review running on Claude-family models.
- **Rate-limiting can masquerade as a schema failure.** In early testing, reviewer passes sometimes reported "completed without calling StructuredOutput" — a misleading message. Inspecting the underlying transcripts showed the real cause was agents dying mid-turn on upstream API rate-limiting during high-concurrency fan-out, not a prompt or schema problem: a rate-limited agent never finishes its turn, so the runtime reports it as a structured-output failure. Splitting each reviewer into a separate "analyst" and "formatter" agent to work around this was a mis-fix — it doubled agent count and made the rate pressure worse, not better, and was reverted. **What actually works:** (1) a reliability gate — majority reviewer-pass failure forces verdict `ERROR`, never a false `APPROVE` (implemented as `reviewReliable` in this script); (2) throttle concurrency — `thresholds.reviewer_batch` (default `auto`) fans out fully and then retries only the failed passes at `thresholds.reviewer_batch_retry` (default 3), which recovers a throttled round without paying the batching cost on every clean one; pin it to an integer to batch from the start; (3) disable split-severity if you need to halve load further; (4) keep one schema'd agent per reviewer once concurrency is throttled — don't add agents to work around rate-limiting, that makes it worse.
- **Throttling the reviewer dispatch is necessary but not sufficient.** Disprove agents fan out per-reviewer *inside* a batch and can still be rate-limited even when reviewer dispatch itself is throttled. A rate-limited disprove call must **fail open**: the candidate is surfaced flagged `disprove-unverified` at the confidence floor, never silently buried at confidence 0 (see `DISPROVE_BATCH_SCHEMA`'s `failed` field and the fail-open merge logic in this script). If you still see 429s after the automatic retry, pin `thresholds.reviewer_batch` to a small integer before assuming something else is wrong.
- **Model inheritance — pin models explicitly, don't rely on the session default.** `agent()` calls with no `model:` override inherit whatever model the parent session is running. If your session default is an expensive model, every wrapper agent that just shells a command, transcribes output, or runs a tool inherits that cost even though it does no real reasoning. Apply a basic cost tier explicitly on every `agent()` call in this script: a fast/cheap model for pure run-shell-transcribe work (verify, gateway/local-endpoint wrappers, the collapsed disprove runner), a mid-tier model for light judgment (preflight, consolidate, the Claude-family reviewers), and your most capable model reserved for genuine planning — which this workflow mostly doesn't need, since orchestration lives in the script rather than in an agent's own reasoning.
- **Never equate empty findings with clean.** A failed reviewer pass returns null; the script must count completed-vs-failed passes and refuse APPROVE when reviewers crashed. This is the most dangerous possible failure mode of any review tool — worth restating even after it's handled, because a regression here silently converts "the review didn't run" into "the code is clean."
