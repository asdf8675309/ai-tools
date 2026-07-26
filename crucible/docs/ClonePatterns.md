# Clone Patterns — R1 Type-4 Semantic Clone Reference

Reference for the Crucible R1 Reuse / Type-4 Clone Detector reviewer. Defines what counts as a Type-4 semantic clone, documents the calibration procedure that locks in `clone_mrs_threshold` per-embedding-model, and records known model limitations the disprove sub-agent should compensate for.

## Why Type-4 specifically

Code clones are categorized in the clone-detection literature as:

| Type | Description | Caught by traditional tools? |
|------|-------------|------------------------------|
| Type-1 | Identical text (whitespace/comments ignored) | Yes — `simian`, `jscpd`, file hashing |
| Type-2 | Identical text with renamed identifiers | Yes — token-based detectors |
| Type-3 | Modified/reordered statements, same algorithm | Partially — AST diff tools |
| **Type-4** | **Different syntax, same behavior** (semantic clone) | **No — requires semantic understanding** |

The MSR 2026 paper "More Code, Less Reuse: Investigating Code Quality and Reviewer Sentiment towards AI-generated Pull Requests" (Huang et al., arXiv:2601.21276) measured **1.87× higher average redundancy** in AI-authored PRs than human-authored ones — Average Max Redundancy (AMR) 0.2867 vs 0.1532, Mann-Whitney p<0.001 — and found the redundancy is *invisible to cyclomatic complexity*, since 85.02% of changed pairs score CC=0. Reviewers also expressed *less* negative sentiment toward AI PRs despite the added redundancy, which the authors frame as surface plausibility masking technical debt.

That combination — more duplication, and reviewers who feel better about it — is precisely the failure class no other reviewer here can see. Note the study's scope when weighing the numbers: Python repositories only, with one repository carrying its redundancy analysis.

The paper's own metric names are used throughout this skill: **MRS** (Max Redundancy Score) for a single function's maximum cosine similarity against the corpus, and **AMR** for the average across a change set.

## How the detector works

1. **Corpus scan** — `SemanticCloneDetector.ts --scan-corpus <app>` extracts every function from the affected app's `.ts/.tsx/.js/.jsx` files (regex-based for v1; AST in v2 if calibration shows v1 misses real clones).
2. **Diff extraction** — `--diff <since-ref>` pulls functions present in HEAD that are NOT present in `<since-ref>`'s version. Pure new code.
3. **Embed both sets** via `EmbeddingClient.ts` → batch-of-32 calls to a local embedding server (current model: `text-embedding-nomic-embed-text-v1.5`, 768-dim).
4. **Compute MRS per new function** — Maximum Redundancy Score = max cosine similarity against any existing corpus function. Above the configured threshold = candidate.
5. **Emit JSON** for the clone-detector reviewer agent to reason over and decide whether each candidate is a real duplicate worth flagging.

## Calibration procedure (run on every model swap)

Whenever the embedding model changes (e.g. swapping to a different local or hosted embedding model), re-run calibration before promoting the new model to default:

```bash
bun tools/SemanticCloneDetector.ts --calibrate
```

(run from the skill root)

This sweeps the cosine threshold from 0.40 to 0.95 in 0.025 increments against the fixture at `references/CloneCalibrationPairs.json` (40 hand-labeled pairs — 20 Type-4 clones across 7 categories, 20 non-clones across 3 categories). For each threshold it computes precision / recall / F1 and identifies the F1-optimum.

**Update the threshold in `config.yaml`** (`thresholds.clone_mrs_threshold`) to the F1-optimal value before merging the model swap. Record the per-model entry in the table below so we have an audit trail.

## Per-model F1-optimal threshold table

| Model | Variant | Dim | F1-optimal | Precision | Recall | F1 | Calibrated |
|-------|---------|-----|-----------|-----------|--------|-----|------------|
| `nomic-embed-text-v1.5` | (default) | 768 | **0.800** | 0.8095 | 0.8500 | 0.8293 | 2026-05-20 |
| `nomic-embed-code` | Q4_K_M | TBD | — | — | — | — | not yet tested |
| `text-embedding-3-small` (gateway) | (OpenAI) | 1536 | — | — | — | — | not yet tested |

## Known model limitations (`nomic-embed-text-v1.5`)

These showed up as **false positives** in the calibration sweep — the model gives them high cosine despite being clear non-clones. The disprove sub-agent must explicitly check for these patterns when filtering R1 candidates at Pass 2:

| Failure pattern | Example | Cosine | Mitigation |
|-----------------|---------|--------|------------|
| **Directional opposite** | `sortAsc` (a-b) vs `sortDesc` (b-a) | 0.929 | Disprove checks: do the operations produce opposite outputs given identical inputs? |
| **Sign-inversion** | `increment(c) → c+1` vs `decrement(c) → c-1` | 0.921 | Same — output should NOT match across the two functions |
| **Same-domain near-miss** | `readFile` vs `writeFile` | 0.814 | Disprove checks: does one function CONSUME input that the other PRODUCES? If so, they're a pair, not a clone. |
| **Adjacent operation** | `pushItem` vs `popItem` | 0.772 | Same — read/write or push/pop pairs are by-design adjacent, not redundant |

These showed up as **false negatives** (Type-4 clones the model failed to recognize at the F1-optimal threshold):

| Failure pattern | Example | Cosine | Why it's hard |
|-----------------|---------|--------|---------------|
| **Function vs short-arrow** | `function add(a,b)` vs `const sum = (x,y) => x+y` | 0.618 | Short body + different parameter names looks more like two different functions to the embedder than a clone |
| **Loop vs reduce** | `for (n of nums) s += n` vs `nums.reduce((a,n) => a+n, 0)` | 0.771 | Reduce's accumulator pattern doesn't share enough surface tokens with the imperative loop variable |

These are tunable by either lowering the threshold (catches more clones, costs more disprove cycles) or running `nomic-embed-code` once it's calibrated (model is code-purpose-trained; likely higher cosine on these cases).

## Clone categories the fixture covers

The fixture isn't exhaustive but it spans the patterns most likely in real reviews:

**Positive (Type-4 clone) categories:**
- `function-vs-arrow` — imperative vs arrow form of the same operation
- `loop-vs-functional` — for/while vs map/reduce/filter
- `control-flow` — early return vs nested-if; switch vs object lookup
- `iteration` — recursive vs iterative
- `data-shape` — array iteration vs object iteration patterns
- `async-pattern` — async/await vs Promise.then; Promise.all vs sequential
- `guard-vs-validate` — early throw vs nullable return; same intent

**Negative (non-clone) categories:**
- `domain-different` — clearly unrelated functions, strong negative example
- `primitive-difference` — adjacent operations (push/pop, read/write, sort asc/desc, get/set)
- `near-miss` — same domain, similar surface, different behavior — hardest cases

To extend the fixture: edit `references/CloneCalibrationPairs.json`. Re-run `--calibrate`. If F1-optimum shifts more than 0.025, update `config.yaml`. Document the change here.

## When to re-calibrate

- New embedding model added to `config.yaml` (`local_model_map` or `gateway_model_map`)
- Existing model version upgrades (e.g., `text-embedding-3-small` → `-3-large`)
- New languages added to the corpus (current fixture is TS-only; Python/Go corpora may need their own fixtures)
- Real-PR false-positive or false-negative rate diverges materially from the calibration prediction (track this in the project's decision log)

## Output contract for the reviewer agent

`SemanticCloneDetector.ts --diff <ref>` emits JSON of this shape:

```json
{
  "threshold": 0.80,
  "candidates": [
    {
      "new_function": { "name": "fetchUserById", "path": "src/user.ts", "line": 42, "body": "..." },
      "matched_against": { "name": "getUser", "path": "src/lib/users.ts", "line": 88, "body": "..." },
      "mrs": 0.91,
      "threshold": 0.80,
      "severity": "MEDIUM"
    }
  ]
}
```

`severity` is auto-assigned: `MEDIUM` if `mrs ≥ threshold + 0.10` (strong match), else `LOW`. The reviewer agent re-evaluates and may promote to HIGH for direct duplicates the human reviewer should fix-before-merge, or drop to noted-item for codebases where the clone is intentional (different cadence apps, generated code).
