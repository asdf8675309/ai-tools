# Third-party notices

Crucible ships no third-party code. Its architecture draws on the work below, and this file records those origins and their licenses.

Included for completeness rather than obligation: the MIT notice requirement attaches to "copies or substantial portions of the Software," and Crucible distributes neither — no source file, prompt, or list here is copied from the projects named below. Reproducing the notice anyway costs nothing and leaves no ambiguity for anyone auditing this repository.

---

## anthropics/claude-code-security-review

<https://github.com/anthropics/claude-code-security-review>

Crucible's two-pass identify-then-filter architecture, its confidence-floor filter, the hard-exclusions deny-list concept, and the codebase-pattern comparison all derive from the prompt published in this repository at `.claude/commands/security-review.md`. CREDITS.md quotes roughly sixty words of it for commentary; nothing else from the project appears here.

```
MIT License

Copyright (c) 2025 Anthropic

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Verified byte-for-byte against the project's `LICENSE` and against the canonical MIT text published by SPDX: after normalizing line wrapping and setting aside the copyright line, all three are identical. The upstream repository remains the authoritative copy.

---

## Other sources

These shaped Crucible's design but contributed no text or code, so no license notice attaches. Full discussion in `CREDITS.md`.

| Source | What it contributed | Terms |
|---|---|---|
| [Arm Metis](https://github.com/arm/metis) | The case for an optional deep-security scanner as a separate phase, rather than another reviewer prompt | Apache-2.0 |
| [LifeOS](https://github.com/danielmiessler/LifeOS) | Routing every model call through one resolver, with two-level provider-key indirection | MIT |
| Claude Code's built-in `/code-review` | The PR-continuity lens, offensive convention-compliance checking, and the 0–100 confidence anchors | Proprietary; observed behavior only |
| Mike Molinet, "AI Security Scanning Checklist" | Independent convergence on a dedicated false-positive verification pass; the delta-scan workflow | Published article |
| hamy.xyz, "9 Parallel AI Agents That Review My Code" | Test runner as a peer reviewer; the ranked five-finding cap | Published article |
| Huang et al., MSR 2026 ([arXiv:2601.21276](https://arxiv.org/abs/2601.21276)) | The semantic clone detector, and the MRS/AMR metric names | Academic paper |
| [Greptile](https://www.greptile.com/blog/rise-of-the-overnight-agents) | Per-agent failure-rate fingerprints; the review-cycle data behind the 1000-line hard block | Published research |
| Ridnik et al., AlphaCodium ([arXiv:2401.08500](https://arxiv.org/abs/2401.08500)) | YAML block scalars over JSON for code-heavy model output | Academic paper |
| Qodo | Split-severity reviewer passes | Published research |
| [Sean Goedecke, "If you are good at code review, you will be good at using AI agents"](https://www.seangoedecke.com/ai-agents-and-code-review/) | Structural review framing | Published article |

No source file, prompt, or reference document in this repository is copied from any project named above. The only third-party text here is the roughly sixty words of Anthropic's security-review prompt quoted for commentary in `CREDITS.md`, under the MIT license reproduced above.
