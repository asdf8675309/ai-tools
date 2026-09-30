---
name: dep-archive
description: Restores node_modules from a lockfile-keyed local archive in seconds instead of a cold install. USE WHEN you are about to run npm ci or npm install to get dependencies for a fresh checkout or worktree, node_modules is missing or stale after a checkout, tests or typecheck fail because dependencies are not installed, or several agents share one build host. NOT FOR adding, removing or upgrading a dependency (that changes the lockfile and needs the real package manager), or repositories without a package-lock.json.
---

# dep-archive

## Outcome

The checkout has a complete, correct `node_modules` for its current lockfile, obtained
as fast as possible, without touching any other checkout's install.

`dep-archive ensure` gets there: it restores a matching archive when one exists and
otherwise runs the repository's normal install once and archives the result for the
next checkout.

## Constraints

- Use `dep-archive ensure` in place of a plain `npm ci` when you only need the
  dependencies the lockfile already pins. It runs the same install on a miss.
- Changing dependencies is not this tool's job. When the task edits `package.json`
  dependencies or the lockfile, use the package manager and the repository's own rules.
- Never work around exit 3 by writing through a symlinked `node_modules`. That
  directory belongs to another checkout.
- Do not delete archives or the archive directory to "fix" something. `verify`
  discards a bad archive on its own.
- Report the exit code and the last lines of output when it is not 0.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Dependencies are in place. | Continue. |
| 1 | Miss or unusable archive (`restore`, `has`, `verify` only; `ensure` builds instead). | Run `dep-archive ensure`. If `ensure` itself returns 1, extraction failed; check free disk space, then report. |
| 2 | Setup error: no lockfile, no node, unsupported package manager. | Use the repository's documented install and report which input was missing. |
| 3 | A `node_modules` is a symlink into another checkout. | Stop. Report the path. Removing the symlink is the user's call. |
| 4 | The install or the pack failed. | Read the install error. It is a real install failure, the same one `npm ci` would give. Fix or report it; do not retry in a loop. |

## Where it fits

Run it once per fresh checkout or worktree, before tests, typecheck or build. It is
safe to run again; a second run on a restored tree restores again.
