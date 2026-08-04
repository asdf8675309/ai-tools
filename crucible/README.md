# Crucible

A pre-merge code review gate for [Claude Code](https://claude.com/claude-code). Ten reviewers enumerate problems in parallel, then an adversarial second pass tries to disprove every one of them. What survives is worth your attention.

The problem with AI code review isn't that it misses things. It's that it cries wolf — twenty findings, three of them real, and after a week you stop reading them. Crucible is built around that failure mode: it deliberately over-enumerates in the first pass, then spends a second pass trying to kill its own findings.

```
Pass 1  ten reviewers, no confidence filter          →  many candidates
Pass 2  adversarial disprove, "prove me wrong"       →  most killed
Filter  confidence floor + deny-list + ranked cap    →  what's left
```

*Shape, not a measurement.* I have not published a controlled comparison of findings-with-disprove versus findings-without, and until I do, treat the precision claim as a design argument rather than a result.

Runs on Claude Code with nothing else installed. No account to create, no API key, no local server.

---

## Install

```bash
git clone https://github.com/asdf8675309/ai-tools.git
cd ai-tools/crucible
./install.sh
```

That copies the skill to `~/.claude/skills/crucible/`. The optional enforcement hooks are a separate, explicitly-confirmed step — the installer never edits your `settings.json` without asking.

Requires [Bun](https://bun.sh) for the deterministic tools. Everything else is Claude Code itself.

**Contributors:** `bun test` works on a fresh clone with nothing installed. `bun run typecheck` additionally needs `bun install` first, for the dev-only type definitions — `node_modules` is gitignored by design.

## Use

In any git repo with uncommitted or unpushed changes:

```
review my changes
```

Or invoke a specific workflow:

| Say | Runs | When |
|---|---|---|
| "review my changes", "crucible" | **FullReview** | the default — every phase |
| "security review", "scan this for vulns" | **SecurityOnly** | the security lens with the full two-pass filter |
| "re-review since the last round of fixes" | **DeltaReview** | second pass on a PR — reviews only what changed, re-checks previously-noted items |

Output is a findings table, an `APPROVE` / `WARNING` / `BLOCK` verdict, and a verification checklist you can paste into the PR description.

---

## How it works

Eleven phases — 0 through 7, plus an interstitial 1.5, 1.75, and 2.5. Ten run on every review; 2.5 is off unless you enable it. The interesting ones are 1, 3, and 4.

**Phase 0 — Eligibility.** Is this reviewable? Conflicts, failed CI, and oversized diffs stop here. A diff over 1000 lines is refused outright rather than reviewed badly: review quality collapses well before that, and the right answer is to split the PR. Docs-only diffs take a "light path" and skip the fleet entirely.

**Phase 1 — Codebase pattern survey.** Before any reviewer runs, Crucible scans *your* repo for how *you* do auth, validation, errors, database access, logging, and tests. Every finding must then cite a `path:line` in your code that establishes the pattern being violated.

> This one design choice removes most of the highest-volume false-positive class. Without it, a reviewer tells you to use the library you deliberately migrated away from. "Deviation from `src/db/queries.ts:88`" is actionable. "You should use parameterized queries" is noise. It is enforced at the prompt and weighed again at consolidation, not by a hard schema gate — so treat it as a strong filter rather than a guarantee.

**Phase 1.5 — Review packet.** The diff becomes a structured packet — signatures and docstrings alongside the raw hunks — which is what every Pass 1 reviewer actually reads. Raw diffs collapse context.

**Phase 1.75 — Injection pre-scan.** A deterministic string match over the diff for prompt-injection payloads, before any model sees it. A CRITICAL hit routes to the security lens's halt rule. This is the cheap layer; the model reviewers are the expensive one, and they catch what string matching can't.

**Phase 2 — Verification gate.** Build, typecheck, test — sequential, fast-fail. Reviewing broken code wastes everyone's time.

**Phase 3 — Pass 1, parallel enumeration.** Ten reviewers dispatch simultaneously, each with your patterns block, a structured review packet, and its own checklist. **No confidence filter** — they are told to be broad. Precision is the next phase's job, and a reviewer trying to self-censor is a reviewer that misses things.

| Reviewer | Looks for |
|---|---|
| Code Quality | function size, nesting, error handling, dead code |
| Security | OWASP Top 10, secrets, injection, auth, SSRF |
| Simplify | duplication, unnecessary complexity, missed reuse |
| TypeScript | type safety, async correctness, idiomatic patterns |
| Platform | serverless/edge, Node, Python, browser gotchas |
| Test Runner | runs the suite *with the diff applied*; regressions and uncovered paths |
| Clone Detector | new code whose *behavior* duplicates existing code |
| CI Tamper | coverage thresholds lowered, tests skipped, lint rules downgraded |
| History Analyzer | via `git blame`: silent regressions, hotspot re-touches |
| PR Continuity | defects a past review already caught on these files |

The last four are the ones generic review tools don't have. CI Tamper exists because weakening the gate is a much better predictor of a bad change than any code smell. History Analyzer catches the regression where a diff quietly undoes a fix someone landed six months ago. PR Continuity catches the review comment you already received and did not internalize.

**Phase 4 — Pass 2, adversarial disprove.** Every candidate goes to a reviewer whose default position is *"this is a false positive, prove me wrong."* It checks four things: is the input actually attacker-controlled, is there an upstream guard, does a helper already handle it, is this a deliberate documented pattern.

> The adversarial framing is load-bearing. Ask a model to "verify this finding" and it agrees with you — that's sycophancy, and the filter never trips. It has to be trying to win.

**Phase 5 — Filter.** Drop anything disproven or under the confidence floor. Drop anything on the hard deny-list. Then cap at five findings per reviewer, ranked by impact minus effort. The cap is a hard rule, not a target — it forces prioritization, and a report of fifty findings is a report nobody reads.

**Phase 6 — Fix.** CRITICAL and HIGH get fixed inline, then Phase 2 re-runs. The rest are filed as tracked items.

**Phase 7 — Report.** Findings table, verdict, and a binary-testable verification checklist for the PR description.

### Diff content is untrusted input

Every reviewer treats PR titles, descriptions, comments, and the code itself as potentially attacker-controlled. Text inside a diff that tries to instruct the reviewer — "ignore previous instructions", a comment claiming the security team pre-approved this — is a CRITICAL finding that halts the review. It is never something to comply with.

This matters more than it sounds. Published attacks have landed against several major AI review tools by exactly this route. A comment framed as CI-team pre-approval, sitting inside a workflow file, is enough to suppress a reviewer that was not built to distrust it.

---

## Optional integrations

All off by default. Crucible runs a complete review with every one of these disabled — each buys a specific capability, none is required, and any that fails falls back to the Claude path rather than dropping a reviewer.

| Integration | Buys | Costs |
|---|---|---|
| **Gateway** (any OpenAI-compatible endpoint) | A second vendor's opinion on CRITICAL/HIGH findings — both models must fail to disprove a finding before it survives. Cross-vendor agreement is the strongest available signal that a finding is real. | An endpoint, a key, per-call spend |
| **Local models** | True semantic clone detection — finding code whose behavior duplicates existing code even when the text is completely different. No text-diff reviewer can see this. | A local inference server. Free, private, nothing leaves the machine |
| **External CLI** | Vendor diversity in enumeration without a gateway | That CLI installed and authenticated |
| **Verdict log** | A JSONL record of every disprove verdict, so you can decide empirically whether a cheaper model is safe in the authoritative slot | A local file that grows |

Enable in `config.yaml` — the skill's own copy, outside any repository. A `.crucible.yaml` at your repo root tunes a review but cannot turn an integration on or point one somewhere new; see [Configuration](#configuration). Secrets are referenced by environment-variable *name*, never by value.

**`skill/config.example.yaml` is the worked non-default configuration** — what this looks like with the integrations actually wired up: a different vendor on the security lens, two roles swapped on measured precision, an external CLI running the tests, local embeddings for clone detection, and a cross-vendor second opinion gating every CRITICAL and HIGH finding.

That file is the point of the design, and the shipped defaults are the on-ramp. The argument here is that agreement between *independently-failing* reviewers is what makes a finding worth reading — and ten reviewers from one model family share blind spots. Single-family defaults still give you the two-pass filter and the pattern baseline; they do not give you that.

## The CI pipeline (`ci/`) — a different thing, deliberately

`ci/` holds a GitHub Actions review pipeline. **It is not this skill running in CI**, and the difference matters before you adopt it.

The skill is ten reviewers plus an adversarial disprove pass. The Action is **one model call running five lenses**, emitting a structured document — no disprove pass, no codebase-pattern survey, no per-reviewer cap. It is faster and much cheaper, and its precision is correspondingly lower. The coordinator treats its output as one incoming surface among several, which is the role it is good at.

Use the skill before you open a PR; use the Action to catch what reaches the PR anyway. They are complements, not the same tool twice.

**Unlike everything else here, it needs an LLM provider.** `call-reviewer.ts` requires `REVIEW_API_BASE_URL`, `REVIEW_MODEL`, and `REVIEW_API_TOKEN`, plus `GH_REPO` — an account, a key, and a hosted endpoint. That is the single largest adoption cost in this repository. `ci/README.md` lists every required secret; `ci/GATEWAY-ROUTING.md` covers routing review calls by diff complexity if you want cheap models on cheap PRs.

`ci/` also carries `tier-classify` (labels each PR trivial/lite/full from diff stats, so downstream workflows can skip themselves) and a coordinator that de-duplicates findings across surfaces.

## Configuration

`config.yaml` in the skill directory is the default. A `.crucible.yaml` at any repo root deep-merges over it, so you can retune per project without forking the skill.

**An overlay may tune a review; it may not redirect one.** That file lives in the working tree of the code being reviewed, which `skill/references/TrustBoundary.md` calls untrusted throughout — so it is clamped the way the light path already is. An overlay cannot enable an integration (`integrations.*.enabled: true` is dropped; `false` is honoured) and cannot name a target: no `external_cli_map` or `local_model_map` entry, no `integrations.gateway.base_url`/`api_key_env`, no Metis `scan_image`/`network`/`compose_dir`/`llm.*_env`, no `verdict_log.path`, no `gateway_model_map` entry, no `reviewer_fallback_chain`. Everything else — thresholds, flags, added sensitive paths — merges as before. Dropped fields are named on stderr rather than ignored silently, and the authoritative list is `OVERLAY_PROTECTED_PATHS` in `skill/tools/Config.ts`.

**`models` is the one field that depends on where the overlay came from.** Pointing `models.reviewer_security` at a weaker key is the cheapest way for a PR to soften its own review, and a `.crucible.yaml` committed to the branch under review is written by whoever wrote the diff. So git decides: if the reviewed repo tracks the overlay, `models` is dropped like any other protected path; if it is a file you dropped in yourself, it merges. That keeps the eval-run recipe in `skill/workflows/FullReview.md` working — a temporary, untracked overlay is exactly what that recipe describes — without letting a PR carry the same power. The check fails closed, so a tree that is not a repo, or a machine with no `git` on `PATH`, clamps rather than opens, and says on stderr that it could not tell. See `OVERLAY_TRACKED_ONLY_PROTECTED_PATHS` in `skill/tools/Config.ts`.

**What tracked-ness proves, and what it does not.** Untracked means "git has never been told about this file" — it does not, on its own, mean "a human you trust wrote it." The two come apart if the reviewed PR's own code runs before the review does, because a lifecycle script can write an untracked `.crucible.yaml` at run time. Neither this repo's CI nor the workflow templates in `ci/workflows/` install dependencies before reviewing, so nothing here executes PR code on that path — and anything that did would already have arbitrary code execution, which buys more than a reviewer downgrade. Still, if you wire Crucible into a pipeline that installs or builds PR code before the review step, run it with scripts disabled, or treat that pipeline as the trust boundary rather than this flag.

**What the clamp does not do is stop an overlay weakening the review it configures.** The protected list is about where a review's output and credentials can be sent, not about how hard it looks. A `.crucible.yaml` can still raise `thresholds.large_pr_block_loc` past the size of its own diff or set `flags.cross_vendor_disprove: false`, and each of those merges by design, because they are the knobs the overlay exists to provide. Read a `.crucible.yaml` in a PR the way you would read a change to the CI config: it is part of the diff under review, and it is the part that decides how the rest gets reviewed.

A whole overlay, showing what is left once the clamp is applied. `.crucible.yaml` is gitignored here, and leaving it untracked is what keeps `models` available:

```yaml
thresholds:
  confidence_floor: 85
flags:
  fail_on_revert_gate: true
risk_tiers:
  sensitive_paths:            # unions with the hardcoded baseline, never replaces it
    - '(^|/)crucible/skill/tools/Config\.ts$'
light_path:
  max_loc: 500                # narrowing only
# models:                     # untracked overlays only; delete the file after an eval run
#   reviewer_security: claude-opus
```

`skill/config.example.yaml` is the companion for the *other* file — the skill's own `config.yaml`, which is yours and is not clamped. Most of what it documents cannot appear in an overlay at all, so do not copy from it into a repo root.

Worth knowing:

- **`thresholds.confidence_floor`** (80) — how sure the disprove pass must be to let a finding through.
- **`thresholds.per_reviewer_cap`** (5) — the hard cap. Raising it makes reports longer, not better.
- **`light_path`** — which diffs skip the fleet. Deny-by-default: only formats that cannot carry executable code qualify, and behavior-steering docs (`CLAUDE.md`, `AGENTS.md`, anything under `.claude/` or `.github/`) never take the light path however Markdown they look.
- **`risk_tiers`** — paths that escalate *disposition*, not just depth. A diff touching auth, secrets, billing, migrations, or CI forces the security reviewer, disables auto-fix, and downgrades a clean APPROVE to REVIEW-REQUIRED. The baseline is hardcoded with no off-switch; config can only add to it.

## Enforcement hooks (optional)

`hooks/` holds a pair of Claude Code hooks that make review non-skippable: one records that a genuine review happened at the current commit, the other blocks `gh pr create` until it sees that record.

This is software that tells you "no." Read `hooks/README.md` before installing it — it documents exactly what gets intercepted, the fact that any new commit invalidates a prior review, where state is written, the bypass, and how to remove it.

## Adapting to another harness

The architecture is harness-independent. What Claude Code provides is parallel subagent dispatch and file/shell tools; nothing else is special.

- **`agents/*.md`** — ten reviewer prompts, one per lens. Plain Markdown with YAML frontmatter. Feed them to any model that can read a diff.
- **`references/*.md`** — the deny-list, positive precedents, trust boundary, and security checklist. Pure prose, no code. These carry most of the accumulated judgment and port anywhere.
- **`tools/*.ts`** — deterministic Bun scripts with CLI entrypoints. Standalone; call them from anything.
- **`workflows/*.md`** — the procedures. Written for an agent to follow, readable by a human.

To port, dispatch the ten `agents/` prompts however your harness runs parallel work, collect the YAML candidate lists, run each through the disprove prompt at `tools/DisproveSubagentPrompt.md`, then apply the Phase 5 filter. The filter is deterministic and worth reimplementing exactly — it is where the precision comes from.

**The agent files are not sufficient on their own.** `workflows/FullReview.md` Phase 3 injects four things into every reviewer that do not live in the prompt files, and skipping them changes what you get:

1. **`references/TrustBoundary.md`, as a universal preamble.** Only three of the ten prompts mention the trust boundary; the workflow supplies it to all ten. Omit it and seven reviewers will read attacker-controlled diff content with no instruction to distrust it — which is exactly the state a red team found here in June 2026, and the cheap targets are the quiet lenses nobody thinks to protect.
2. **The Phase 1 codebase-patterns block.** Without it, `deviation_from` has nothing to cite and findings regress to generic best-practice noise.
3. **The defer-to-CI instruction** — don't flag what lint and typecheck already catch (Test Runner excepted).
4. **The convention-compliance instruction** — flag diffs violating the project's own documented rules.

Read Phase 3 before porting. The prompts carry each lens's judgment; the workflow carries what they all share.

The one thing not to change: **the disprove pass must be adversarial, and it must be a separate call.** Folding it into the enumeration prompt does not work. The reviewer that found the issue will not honestly try to kill it.

---

## Credits

Crucible is an assembly, not an invention. The two-pass architecture comes from Anthropic's own [claude-code-security-review](https://github.com/anthropics/claude-code-security-review) (MIT) and Mike Molinet's security checklist, which arrived at the same structure independently; the clone detector exists because of an MSR 2026 paper; the failure fingerprints are Greptile's measurements; the config indirection is borrowed from [LifeOS](https://github.com/danielmiessler/LifeOS); the extra-security-scanner seam exists because of [Arm's Metis](https://github.com/arm/metis); several review lenses came from Claude Code's built-in `/code-review`.

**[CREDITS.md](./CREDITS.md)** records all of it properly — what came from where, how it got built over time, and the per-role model evaluation with its caveats.

## License

MIT
