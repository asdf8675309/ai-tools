# Plan

Dependency triage. Sorts a list of issues into PARALLEL / SEQUENCE / AMBIGUOUS, shows you the plan, then dispatches only the parallel batch.

**Fires automatically at 5+ issues.** Force it at any count with `--plan`.

## Inputs

- Issue numbers: `/sprint --plan 218 306 374`, or automatically at 5+
- Working directory = the target repo

## Preconditions

Identical to `Dispatch.md` — same four checks, same messages, same hard stop.

## Procedure

### 1. Repo context

```bash
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
REPO_ROOT=$(git rev-parse --show-toplevel)
```

### 2. Fetch issue metadata

```bash
gh issue view <N> --json number,title,state,body,labels \
  --jq '{number, title, state, body: .body, labels: [.labels[].name]}'
```

Any issue CLOSED or missing → report and exit, same as Dispatch.

### 3. Extract file signals

From each issue's title and body, in descending specificity:

- **Explicit paths** — `[\w/-]+\.\w{2,5}`
- **CamelCase tokens** — `[A-Z][a-z]+[A-Z]\w+`
- **kebab / snake identifiers** — `[a-z][a-z0-9]+-[a-z][\w-]+`, `[a-z]+_[a-z]\w+`
- **camelCase identifiers** — lower first char, contains an upper

Cap at 20 signals per issue, most specific first.

### 4. Search per signal

```bash
git grep -l "<signal>" -- "$REPO_ROOT"
```

Union the matches per issue into `FILES[N]`, deduplicated. A signal matching more than 50 files is too generic to be evidence of overlap — skip it.

### 5. Overlap matrix

For each pair (A, B): is `FILES[A] ∩ FILES[B]` non-empty? Record the shared files if so.

### 6. Classify

- **PARALLEL** — no file overlap with any other issue in the set.
- **SEQUENCE** — overlaps one or more others. Order the chain: if A's body names a file in B's signal set, A depends on B. Otherwise order by issue number ascending. Separate chains can run as separate batches.
- **AMBIGUOUS** — overlap exists but neither body clearly references the other's files. Direction unknown; the user decides.

### 7. Present the plan

```
Sprint plan — <N> issues analysed

PARALLEL (dispatch together):
  #218 — "Paginate the list view"   touches: list/pagination.ts, list/query.ts
  #306 — "Add CSV export"           touches: export/csv.ts, ui/ExportButton.tsx

SEQUENCE (each waits on the previous PR merging):
  1. #374 — "Extract the parser"    touches: lib/Parser.ts, lib/tokens.ts
  2. #429 — "Improve parse errors"  touches: lib/Parser.ts, cli/report.ts
     └─ depends on #374 (shared: lib/Parser.ts)

AMBIGUOUS (overlap found, order unclear — confirm before dispatch):
  #583 — "Support a second input format"
     └─ overlaps #374 (shared: lib/Parser.ts)

No code signals detected (overlap undetectable, dispatch freely):
  #641 — "Fix typos in CONTRIBUTING"

Proceed?
  [Y]  dispatch the PARALLEL batch, report the SEQUENCE order
  [N]  abort — adjust the list first
```

If PARALLEL is empty, say so explicitly and ask for a manual sequence rather than dispatching anything.

### 8. On confirmation

Call Dispatch for the PARALLEL batch only, entering at its Procedure step 1 — repo context is already read, preconditions already passed.

Report the SEQUENCE as a numbered list the user runs manually: dispatch the first, merge it, then dispatch the next.

Flag the AMBIGUOUS issues with their overlap so the user can add, drop, or sequence them.

## Gotchas

- **`git grep` is a signal, not ground truth.** A match means the file is *likely* touched. This prevents the obvious merge conflicts, not all of them — agents still scope themselves to their own issue.
- **No signals ≠ safe.** Docs-only and config-only issues can share files that no title or body mentions. Say so in the output when `FILES[N]` is empty rather than implying the issue is known-independent.
- **Direction inferred from body text is heuristic.** "update the parser added in #374" is strong. A shared filename alone is weak. Prefer AMBIGUOUS over a confident wrong ordering.
- **The caps are load limiters.** A long issue body with many file references produces a noisy signal set; the 20-signal cap and the 50-match skip exist for that. Don't remove them.
- **Don't dispatch the SEQUENCE.** Triage is the job here, not automating the chain. The user merges, then dispatches the next.
