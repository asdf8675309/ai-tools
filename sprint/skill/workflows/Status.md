# Status

Query the registry, render one table per sprint.

## Inputs

- Optional date: `/sprint status` (today) or `/sprint status 2026-07-27`

## Procedure

### 1. Read the registry

```bash
# -u because state files are named in UTC. Local time runs a day ahead of it
# every evening west of Greenwich, so a local date asks for a file that does
# not exist yet and the day's sprints read as empty.
DATE=${1:-$(date -u +%Y-%m-%d)}
bun "$SKILL_DIR/tools/Registry.ts" list --date "$DATE" --output json
```

`Registry.ts list` with no `--output` renders the table itself; use `--output json` when you want to post-process before rendering.

### 2. Render

```markdown
## Sprint <SPRINT_ID> — started <time>

Repo: <repo>  ·  Parent: <session>

| # | Issue | Status | Worktree | PR | Review | Files | Duration |
|---|-------|--------|----------|----|--------|-------|----------|
| 1 | #218  | pr-opened | ../repo-sprint-218-paginate-list-view | <url> | APPROVE | 7 | 1m 43s |
| 2 | #306  | running   | ../repo-sprint-306-add-csv-export | — | — | — | — |
| 3 | #374  | failed    | ../repo-sprint-374-extract-parser | — | — | — | reason: test framework missing |
```

Statuses: `running` (still working) · `pr-opened` (PR up, verdict captured) · `failed` (reported a reason) · `stale` (see below).

### 3. Summary footer

```
Total: <n> sprints · <n> issues · <n> PRs · <n> failures · <n> still running
```

### 4. No sprints that day

```
No sprints registered for <DATE>.

Dispatch one with: /sprint <issue numbers>
```

## What to actually read in the table

- **`(unverified)` next to a verdict** is the column that matters. It means the agent reported a verdict with no proof-of-run marker behind it for that branch and SHA — the review may never have run. Re-review before merging that PR. A verdict with no suffix has an artifact behind it.
- **`running` for hours** is a stall, not progress. See below.
- **`failed` with a reason** is the agent reporting honestly; the work may still be on the remote. Check `git ls-remote --heads origin <branch>` before re-dispatching — if the branch is there, finish it by hand instead of paying for a fresh run.

## Edge cases

- **Registry file missing** — treat as "no sprints". It's created lazily on first dispatch.
- **Malformed JSON** — report the parse error and name the file. Don't silently return an empty list; that reads identically to "no sprints ran" and hides a corrupted registry.
- **Stale `running` entries** (no update in over 4 hours) — render as `stale`. The agent is almost certainly gone. `git worktree list` finds the directory; check the remote for the branch before removing anything.
