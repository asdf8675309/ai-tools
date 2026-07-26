# Credits and provenance

Crucible is an assembly, not an invention. Almost every part of it came from somewhere — a published prompt, a research paper, another tool's design, or an argument someone made on their blog. This file records where, as precisely as I can reconstruct it.

## How it actually got built

It didn't start as a code review system. It started as three separate things that kept getting run together.

A repo I work in had three GitHub Action review agents — a general code reviewer, a security reviewer, and a TypeScript checker. They ran independently and produced three separate opinions, which had to be reconciled by hand every time. Consolidating them into a single `pre-pr-review` Action was the obvious cleanup, and that Action is Crucible's direct ancestor. The parallel-reviewer shape was there from the beginning; what was missing was any way to deal with the noise.

**2026-05-17 — v1.** Generalized out of that Action after a research pass over eight code-review prompt artifacts (below). The finding that justified rebuilding rather than tidying: two of those eight, with no shared lineage, had independently arrived at the same two-pass identify-then-filter architecture. That's the load-bearing idea, and it isn't mine.

**2026-05-20 — the fourteen-recommendation upgrade.** A self-audit found three gaps: the reviewer panel was a monoculture (every reviewer and every disprove agent ran inside one model family, which violates the skill's own founding premise about convergence); there were no reviewers for the failure modes AI-authored PRs actually exhibit; and raw-diff input was collapsing context. This round added the semantic clone detector, the CI-tamper reviewer, the author-fingerprint profile, the review packet, split-severity passes, cross-vendor disprove, and the config system.

**2026-05-22 — model evaluation.** Per-role precision testing across model families. Results and caveats below.

**2026-06-14 — prompt-injection hardening.** A red-team pass found five reviewers with no trust-boundary protection. Only the security reviewer had been loading it. A comment framed as CI-team pre-approval, placed inside a workflow file, could suppress the CI-tamper reviewer's confidence without ever tripping the security reviewer's halt. The trust boundary became a universal preamble for all reviewers, and a second hardening pass followed on 2026-06-30.

**2026-07-15 — continuity and convention.** A lens-by-lens audit against Claude Code's own built-in `/code-review` found two things it had that Crucible didn't: continuity with what reviewers said on *prior* PRs, and offensively checking the diff against the project's documented rules rather than only using those rules defensively to kill false positives. Both were adopted, along with a sharper confidence rubric.

The recurring lesson across all of it: a competing tool's lens set is itself a source worth mining.

**On how the text got written.** Nearly all of Crucible's code and prose was drafted with Claude Code, directed and reviewed by me across the rounds above. That is worth saying plainly rather than leaving a reader to infer it: a review tool that asks you to trust its judgment about your code should be forthright about its own provenance. The design decisions, the sources mined, what got kept and what got cut are mine; the drafting was largely not, and the two are hard to separate cleanly after this many rounds.

The same is true of `pr-babysit` and `agent-guards`, with one difference worth naming: both of those started as records of specific incidents I hit, so their *content* — which failure, what it cost, what the fix was — is first-hand in a way an architecture document is not. The prose that carries it was still largely drafted rather than typed.

## The architecture

The two-pass identify-then-filter design comes from a convergence of two independent artifacts analyzed in May 2026:

- **Mike Molinet, "AI Security Scanning Checklist: 53 Things to Test & 15 Prompts."** Published on LinkedIn. His prompt #3, "False Positive Verification," is the directly-converged technique — a dedicated second pass whose only job is disproving findings. His prompt #14, "Delta Scan (Changes Since Last Review)," is the basis for the `DeltaReview` workflow.

- **Anthropic's [claude-code-security-review](https://github.com/anthropics/claude-code-security-review)** (MIT, © Anthropic) — the security-review GitHub Action they publish, whose prompt lives at [`.claude/commands/security-review.md`](https://github.com/anthropics/claude-code-security-review/blob/main/.claude/commands/security-review.md). Four elements of Crucible come straight from its structure:

  > "1. Use a sub-task to identify vulnerabilities… 2. Then for each vulnerability identified by the above sub-task, create a new sub-task to filter out false-positives. Launch these sub-tasks as parallel sub-tasks. 3. Filter out any vulnerabilities where the sub-task reported a confidence less than 8."

  That is the two-pass architecture and the confidence floor. Its `HARD EXCLUSIONS` section is the deny-list concept, and its Phase 2 is the codebase-pattern baseline verbatim in intent — *"Compare new code changes against existing security patterns / Identify deviations from established secure practices."*

Two artifacts with no plausible shared lineage — a vendor's published security tooling and an independent practitioner's checklist — landing on the same structure against the same problem is the strongest signal available that the structure fits the problem rather than the author's taste. That argument, not either artifact individually, is why Crucible is shaped this way.

**On borrowing:** Crucible takes the *architecture* from these sources, not their text. Its deny-list (`references/DoNotReport.md`) was written independently for a different stack and overlaps Anthropic's only where two people solving the same problem inevitably agree — DOS, log spoofing, regex injection, memory safety in managed runtimes. If you want their list, use theirs; it's MIT and it's good.

Five further sources each contributed a smaller piece without independently arriving at the two-pass design: `awesome-skills/code-review-skill` (time-budgeted phases, severity tied to a merge gate), `awesomeskill.ai/skill/rc-code-review` (eligibility as a distinct phase 0, gathering project conventions as a pre-step), GitLab's "10 AI Prompts to Speed Your Team's Software Delivery" (breaking-change prompt structure), Sherlock Forensics' security prompts (a required output schema per prompt), and Repomix's whole-codebase prompt examples.

**hamy.xyz, "9 Parallel AI Agents That Review My Code"** is the source for treating the test runner as a peer reviewer rather than a preflight step, and for capping output at five findings ranked by impact over effort. It converged on parallel fan-out but not on the disprove pass.

## Tools and systems this borrows from

- **[Arm Metis](https://github.com/arm/metis)** — open-source agentic security code review from Arm's product security team. Metis is the reason Crucible has a phase-2.5 shaped hole: an optional second security opinion with full-repository RAG context, run as a separate scanner rather than another prompt. Its architecture — semantic reasoning over pattern matching, deterministic tree-sitter reachability for C/C++ with semantic audit passes layered on — is a better answer for deep security analysis than any single reviewer prompt, and the extra-scanner seam documented in `workflows/` exists so you can wire it or something like it in. (Arm publishes true-positive and false-positive comparisons against traditional SAST; those are their figures, not measurements I've reproduced.)

- **[LifeOS](https://github.com/danielmiessler/LifeOS)** (Daniel Miessler) — the source of the pattern where *every* model call, regardless of vendor, routes through one handler rather than being scattered across call sites. In that system it's a single `Inference.ts`.

  **I took half of it, and the missing half shows.** What I kept is the two-level indirection: a role names a stable provider-key, a separate map resolves the concrete model string, and `tools/Config.ts` turns that into a typed runtime descriptor. Changing models really is a one-line edit in one map instead of a grep across every workflow, and that part earns its keep.

  `Config.ts` resolves a model; it never dispatches one. The dispatch is separate, and it had drifted: of the two CI chat callers, `call-reviewer.ts` had a full retry envelope (exponential backoff, `Retry-After`, all inside the job timeout) while `call-coordinator.ts` had none, so a rate limit the reviewer rode out would fail the coordinator. That is exactly what a single handler prevents.

  Both CI callers now go through **`ci/lib/model-client.ts`** — one retry envelope, one request shape, shared. The coordinator gained the retry it was missing, and the two cannot diverge again because there is only one implementation.

  The embedding client in `skill/` is deliberately *not* folded in, and that is the interesting part of the answer to "why not one client for everything." It speaks a different endpoint (`/embeddings`, not `/chat/completions`) and, more decisively, it ships to a different place — `~/.claude/skills/`, installed, versus a repo's `.github/`, copied. A shared file cannot live in both without coupling two things that deploy separately, which is the standalone-tool property this repo is built to keep. So the rule is one client per *(deployment boundary × API)*, not one client globally: two chat callers in `ci/` share one; the embedding client stands alone. Its lack of a retry envelope is tolerable where the coordinator's was not, because a transient embedding failure only skips clone detection for that run — non-blocking — whereas the coordinator's failure killed a CI job.

- **Claude Code's built-in `/code-review`** — audited lens-by-lens in July 2026. The PR-continuity reviewer, the offensive convention-compliance check, the 0/25/50/75/100 confidence anchors, and two false-positive classes (findings on lines the diff never touched; issues CI already catches) all came from it.

- **LM Studio** with `nomic-embed-text-v1.5` — the local embedding path for semantic clone detection. Local-first here isn't ideology: sending a private codebase to a hosted embedding API to ask "does this duplicate something?" is a bad trade when a 84MB model on the same machine answers it for free.

## Research the design rests on

- **Huang, Jaisri, Shimizu, Chen, Nakashima, Rodríguez-Pérez — "More Code, Less Reuse: Investigating Code Quality and Reviewer Sentiment towards AI-generated Pull Requests"** (MSR 2026, [arXiv:2601.21276](https://arxiv.org/abs/2601.21276)). The clone detector exists because of this paper. AI-authored PRs showed 1.87× the average redundancy of human ones (AMR 0.2867 vs 0.1532, Mann-Whitney p<0.001), the redundancy is invisible to cyclomatic complexity (85.02% of changed pairs score zero), and reviewers expressed *less* negative sentiment toward the more redundant AI PRs. `MRS` and `AMR` are this paper's metric names. Scope caveat: Python repositories only.

- **[Greptile, "Rise of the Overnight Agents"](https://www.greptile.com/blog/rise-of-the-overnight-agents)** (published May 2026; April 2026 data). Two things. The per-agent failure fingerprints in `docs/AgentFailureFingerprints.md` are their measurements — Cursor background agents at 3.45× human baseline for n+1 queries, Claude at 1.75× for IDOR and tenant-check misses, Codex at 1.35× for env-var and config bugs, Devin below baseline across most categories. And their review-cycle data (1.27 rounds for sub-10-line changes rising to 3.54 for thousand-line ones) is why phase 0 hard-blocks at 1000 lines instead of just warning: past that size the iteration cost climbs steeply.

- **GitHub's guidance on agentic-PR red flags** — CI tampering as the highest-signal warning sign, unscoped multi-purpose diffs, and "hallucinated correctness" (tests that pass without exercising the change). The CI-tamper reviewer and the fail-on-revert gate both come from here. *Recalled, not re-verified:* I read this while building and did not keep the URL, and I could not relocate the exact article when checking these credits. The two design decisions stand on their own merits; treat the attribution as unconfirmed rather than as something you can go read.

- **[Qodo, "Effective AI code suggestions: less is more"](https://www.qodo.ai/blog/effective-code-suggestions-llms-less-is-more/)** — that single-focus prompts substantially outperform mixed-severity ones, because cheap-to-detect style issues crowd out expensive-to-detect logic bugs when both compete for one output budget. This is why each reviewer splits into a CRITICAL/HIGH pass and a MEDIUM pass instead of ranking everything in one call. The split is behind a flag if you disagree.

- **Ridnik et al., AlphaCodium** ([arXiv:2401.08500](https://arxiv.org/abs/2401.08500)) — YAML block scalars beat JSON for code-heavy model output: no quote-escaping overhead on multi-line snippets, and more reliably valid output. The `evidence` and `deviation_from` fields are exactly that shape.

- **[Sean Goedecke, "If you are good at code review, you will be good at using AI agents"](https://www.seangoedecke.com/ai-agents-and-code-review/)** (2025) — structural review framing in the code-quality reviewer.

- **[Microsoft Research, "Code Reviews Do Not Find Bugs"](https://www.microsoft.com/en-us/research/publication/code-reviews-do-not-find-bugs-how-the-current-code-review-best-practice-slows-us-down/)** (2015) — worth reading before building any review tool, including this one. Most review comments are maintainability, not defects. It's a useful corrective to the assumption that more review output means more bugs caught.

- **The "Comment-and-Control" prompt-injection class** — disclosed April 2026 by Aonan Guan (independent), with Zhengyu Liu and Gavin Zhong (Johns Hopkins University). The basis for `references/TrustBoundary.md`. The disclosed attacks landed against Anthropic's Claude Code Security Review, Google's Gemini CLI Action, and GitHub's Copilot Coding Agent — which is why every reviewer here treats diff content as untrusted rather than only the security one.

## Model selection

Per-role precision testing, May 2026. The metric is **spurious-finding rate on clean code** — how often a model invents a problem that isn't there. Lower is better.

| Role | Model | Findings/sample | Legit | Spurious % |
|---|---|---|---|---|
| code quality | Sonnet | 0.00 | 0 | **0%** |
| | gemini-3.5-flash | 2.40 | 5 | **0%** |
| | gemini-3-flash-preview | 4.40 | 3 | 32% |
| | kimi-k2.6 | 7.20 | 5 | 31% |
| simplify | gemini-3-flash-preview | 3.40 | 7 | **0%** |
| | Sonnet | 2.40 | 4 | 8% |
| | kimi-k2.6 | 4.60 | 4 | 26% |
| typescript | gemini-3.5-flash | 2.80 | 6 | **0%** |
| | gemini-3-flash-preview | 4.00 | 9 | 10% |
| | Sonnet | 2.60 | 3 | 31% |
| platform | Sonnet | 2.00 | 5 | **0%** |
| | gpt-5.4 | 1.10 | 10 | **0%** |
| | kimi-k2.6 | 3.80 | 4 | 32% |
| test runner | gpt-5.4 | 4.60 | 40 | **0%** |
| | Sonnet | 9.40 | 31 | 4% |
| | kimi-k2.6 | 12.40 | 38 | 11% |

**Read this with the caveats, or don't read it at all.**

The sample is small — five diffs per model/role, ten for gpt-5.4. That is a pilot, not a benchmark, and the differences between 0% and 10% at this sample size are not statistically meaningful. It measures precision only; nothing here says anything about what each model *missed*. The model versions are from May 2026 and several have since been superseded. And the judge that classified findings as legit/borderline/spurious was itself a model.

What the numbers are good for is the shape, which was consistent and did surprise me: **no single model was best at every role.** The assumption going in was that the strongest general model would win across the board. It didn't. TypeScript review was the clearest case — the incumbent produced the *most* spurious findings of any model tested on that role, flagging type problems on clean code, while a much cheaper model produced none and found more real issues.

That result is the entire reason `config.yaml` maps models per-role rather than setting one global default. If you enable the gateway integration, run your own evaluation before trusting any assignment — including the ones above.

### On the monoculture, since it's a fair criticism

The shipped defaults put every reviewer on one model family, which sits awkwardly against this project's founding argument — that agreement between *independently-failing* reviewers is what makes a finding trustworthy. Ten reviewers from one family share blind spots. That is a real tension and worth naming rather than glossing.

The defaults are that way for adoption, not because they are best: a tool that needs an account and a key before it does anything gets tried by nobody. Everything cross-family is one config edit away, and `skill/config.example.yaml` is the worked version — a genuinely mixed panel with a different vendor on the security lens, two roles swapped on measured precision, an external CLI running the tests, local embeddings for clone detection, and a cross-vendor second opinion gating every CRITICAL and HIGH.

Read that file as the intended end state and the shipped `config.yaml` as the zero-friction on-ramp. If you only ever run the defaults, you are getting the two-pass filter and the codebase-pattern baseline — both of which work fine single-family — without the vendor diversity that motivated the design.

## License

MIT. Where this document describes someone else's work, their terms apply to their work, not mine.
