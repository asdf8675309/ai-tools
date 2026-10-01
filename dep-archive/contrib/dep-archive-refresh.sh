#!/usr/bin/env bash
# Keep a dep-archive built for the tip of one branch, so the next checkout of that
# branch restores in seconds. Meant for a timer or cron on a shared build host.
#
#   dep-archive-refresh.sh <repo> <branch> [workdir]
#
# <repo> is any git repository path or URL git can fetch from; a local bare mirror
# needs no credential and no network. [workdir] holds a private working copy
# [${XDG_CACHE_HOME:-$HOME/.cache}/dep-archive-work/<branch>].
#
# Environment:
#   DEP_ARCHIVE_BIN         the dep-archive command [dep-archive]
#   DEP_ARCHIVE_SOURCE_REF  the ref to read in <repo> [refs/heads/<branch>]; a mirror
#                           kept by another tool may track refs/remotes/origin/<branch>
# Every DEP_ARCHIVE_* setting the tool reads passes through unchanged.
set -euo pipefail
cd /

[ $# -ge 2 ] || { echo "usage: $0 <repo> <branch> [workdir]" >&2; exit 2; }
repo="$1"; branch="$2"
work="${3:-${XDG_CACHE_HOME:-$HOME/.cache}/dep-archive-work/$branch}"
bin="${DEP_ARCHIVE_BIN:-dep-archive}"
ref="${DEP_ARCHIVE_SOURCE_REF:-refs/heads/$branch}"

co="$work/checkout"
mkdir -p "$work"
[ -d "$co/.git" ] || git clone --quiet --no-checkout "$repo" "$co"

git -C "$co" fetch --quiet "$repo" "+$ref:refs/remotes/dep-archive/$branch"
tip="$(git -C "$co" rev-parse "refs/remotes/dep-archive/$branch")"

# Move the working copy only when the tip moved. The archive check runs on every
# poll anyway: the key also covers node and npm, and an archive can be pruned.
# A --no-checkout clone has no index yet, even though HEAD already names the tip.
if [ ! -f "$co/.git/index" ] || [ "$(git -C "$co" rev-parse HEAD)" != "$tip" ]; then
  git -C "$co" checkout --quiet --force --detach "$tip"
  echo "$branch moved to $(printf %.8s "$tip")"
fi
key="$("$bin" -C "$co" key)"
echo "$branch at $(printf %.8s "$tip"), key $key"

if "$bin" -C "$co" verify; then
  echo "archive present"
else
  "$bin" -C "$co" build
fi
