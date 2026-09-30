# dep-archive

`dep-archive` restores every `node_modules` directory in a JavaScript repository from a
local archive, keyed on everything that decides what the install produces. On a hit it
unpacks the archive. On a miss it runs the normal install once, packs the result, and
the next checkout with the same key restores from it.

It is one bash script with no dependencies beyond git, tar, find, gzip (or zstd) and a
SHA-256 tool. It never contacts the network itself. Only the install command it runs on
a miss (`npm ci` by default) does.

## When it pays off

- Many checkouts or worktrees of the same repository on one host, for example several
  coding agents that each start from a fresh checkout.
- A host where concurrent cold installs overload the CPU or the disk.
- Large dependency trees that rarely change compared with how often they are installed.

Measured in the repository this tool was extracted from (a 1.6 GB `node_modules` tree
across many workspaces): a cold `npm ci` took 45 to 75 seconds, and a restore took 7 to 9
seconds. Those numbers come from that repository. The tests in this project do not
reproduce them, because they use a fake npm.

## When it does not pay off

- One checkout that installs rarely. The archive costs disk space and a first build.
- CI runners that start empty on every job. Use your CI's own cache for that; see
  `contrib/github-actions.yml` for a way to combine the two.
- A tree that changes on almost every commit. Every change is a new key and a new build.

## Install

```bash
git clone <this repository> ~/src/dep-archive
ln -s ~/src/dep-archive/bin/dep-archive ~/.local/bin/dep-archive
```

Any directory on `PATH` works. The script finds its repository from the working
directory, `-C <dir>`, or `DEP_ARCHIVE_ROOT`.

## Commands

| Command | What it does | Exit codes |
|---|---|---|
| `ensure` (default) | Restore on a hit. On a miss, install and pack. | 0, 1, 2, 3, 4 |
| `restore` | Restore only. | 0 hit, 1 miss or unusable archive |
| `build` | Install and pack, always. | 0, 4 |
| `has` | Does an archive exist for this key? | 0 yes, 1 no |
| `verify` | Does the archive read back whole? Discards it if not. | 0 yes, 1 no |
| `key` | Print the key. | 0 |

Exit codes: `0` success. `1` miss or an archive that could not be used. `2` usage or
setup error (no lockfile, no node, unsupported package manager). `3` a `node_modules` is
a symlink. `4` the install or the pack failed.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DEP_ARCHIVE_ROOT` | working directory | Repository to act on. `-C <dir>` does the same. |
| `DEP_ARCHIVE_DIR` | `${XDG_CACHE_HOME:-$HOME/.cache}/dep-archive` | Where archives live. |
| `DEP_ARCHIVE_DOT_ROOT` | unset | When set and `DEP_ARCHIVE_DIR` is not, archives go in `<root>/.dep-archive`, a dot directory that most garbage collectors skip. |
| `DEP_ARCHIVE_KEEP` | `5` | Archives to keep, newest first. Zero, negative or non-numeric values fall back to 5. |
| `DEP_ARCHIVE_NAME` | `nm` | File name prefix. Pruning only touches files with this prefix. Use one per repository when repositories share a directory. |
| `DEP_ARCHIVE_COMPRESSOR` | `auto` | `zstd`, `gzip`, or `auto` (zstd when installed). |
| `DEP_ARCHIVE_PM` | `auto` | Package manager. Only `npm` is implemented. |
| `DEP_ARCHIVE_INSTALL_CMD` | `npm ci --prefer-offline --no-audit --no-fund --progress=false` | Command run on a miss. |
| `DEP_ARCHIVE_LOCKFILE` | `package-lock.json` | Lockfile hashed into the key. |
| `DEP_ARCHIVE_CONFIG_NAMES` | `.npmrc` | Space-separated file names hashed wherever they appear in the repository. |
| `DEP_ARCHIVE_MANIFEST_NAME` | `package.json` | Manifest file name hashed wherever it appears. |
| `DEP_ARCHIVE_LIFECYCLE` | `preinstall install postinstall prepare` | Scripts that mark a package as running code at install time. |
| `DEP_ARCHIVE_SCRIPT_DIR` | `scripts` | Directory next to such a package's manifest that is hashed into the key. |
| `DEP_ARCHIVE_EXTRA_FILES` | unset | Space-separated paths (files or directories) relative to the repository to add to the key. |
| `DEP_ARCHIVE_EXTRA_KEY` | unset | A string mixed into the key, for anything else that changes the install. |
| `DEP_ARCHIVE_LOCK_WAIT` | `900` | Seconds a second build waits for the first one before building itself. |

## The key

The key is the first 16 hex characters of a SHA-256 over:

- the lockfile;
- every config file named in `DEP_ARCHIVE_CONFIG_NAMES`, outside `node_modules` and `.git`;
- every manifest, outside `node_modules` and `.git`;
- for a manifest that declares an install lifecycle script, every file in its
  `DEP_ARCHIVE_SCRIPT_DIR`, because the archive holds what those scripts wrote;
- `DEP_ARCHIVE_EXTRA_FILES` and `DEP_ARCHIVE_EXTRA_KEY`;
- `node -v`, the package manager version, `uname -sm`, and the compressor.

It does not cover a user-level `~/.npmrc`, environment variables that change the
install, or a lifecycle script that reads files outside its `scripts/` directory. Add
those with `DEP_ARCHIVE_EXTRA_FILES` or `DEP_ARCHIVE_EXTRA_KEY`.

## Safety properties

- **Symlinked `node_modules` is refused (exit 3).** Extracting through a symlink would
  write into another checkout.
- **One build per key.** Where `flock` exists, the build holds a lock the kernel drops
  when the process dies. A second process waits, then restores the first one's archive.
  Without `flock` (stock macOS) two processes can both build; the result is still correct.
- **Atomic write.** The archive is written to a temp file in the same directory and moved
  into place. A failed install or pack leaves no archive and no temp file.
- **A full disk does not delete a good archive.** When extraction fails, the archive is
  discarded only if it cannot be decompressed.
- **No SIGPIPE false negatives.** `verify` reads the whole listing rather than stopping at
  the first match, so a good archive is never reported as bad under `pipefail`.
- **Incomplete installs are not archived.** The build checks for
  `node_modules/.package-lock.json`, which npm writes last.
- **`npm ls` stays clean after a restore.** The restore touches
  `node_modules/.package-lock.json`, so npm keeps trusting its hidden lockfile.
- **The keep count cannot delete the archive just built.**
- **The working directory can be unreadable or deleted.** The script leaves it before
  doing anything. Pass `-C` or `DEP_ARCHIVE_ROOT` with an absolute path in that case.

## Tested on / Not tested on

The hermetic suite (`test/run.sh`, 43 cases, fake `node` and `npm`, no network) passed on:

- macOS 26 (Darwin 25.6, arm64) with bash 5.3 and with bash 3.2.57, BSD tar, BSD find,
  BSD xargs. There is no `flock` on stock macOS; the suite uses a Python `fcntl`
  stand-in for the lock case.
- Debian Linux in the `node:26` container (aarch64) with bash 5.2, GNU tar 1.35, GNU
  findutils 4.10, util-linux `flock`. The container ran as root, so the
  unreadable-working-directory case is weaker there.

Not tested:

- A real `npm ci`, a real dependency tree, or the restore timings above.
- Real `zstd`. The suite uses a stand-in that calls gzip, so the zstd code path is
  exercised for key and plumbing only.
- A real full disk. The suite simulates an extraction failure with a tar wrapper.
- pnpm and yarn (not implemented), x86_64, Alpine or BusyBox userlands, Windows.

## Adding a package manager

The seam is the `case "$pm"` block near the top of `bin/dep-archive`. A package manager
needs a lockfile name, its config file names, a completion marker that the install
writes last, an install command, and a version command. pnpm also keeps a content store
outside the repository and links into it, so an archive of `node_modules` alone may not
be enough; that needs its own tests before it is claimed to work.

## Tests

```bash
bash test/run.sh
shellcheck bin/dep-archive test/run.sh contrib/*.sh
```

The suite fails if the number of cases that ran differs from the number it expects, so
a harness that silently skips cases does not pass.
