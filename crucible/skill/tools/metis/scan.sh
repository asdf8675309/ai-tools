#!/usr/bin/env bash
# Convenience wrapper: bring Metis up for the current repository and run a
# command against it, resolving the repo root and schema from config.
#
#   scan.sh                                  # interactive Metis CLI on this repo
#   scan.sh --command "review_code"          # one-shot, JSON on stdout
#   scan.sh --repo ../other --command index  # build the index for another repo
#
# Everything after `--` is passed through to Metis untouched.
set -uo pipefail

# shellcheck source=./lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TARGET="$PWD"
FORWARD=()

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) TARGET="${2:-}"; shift 2 ;;
    --)     FORWARD+=("$1"); shift; while [ $# -gt 0 ]; do FORWARD+=("$1"); shift; done ;;
    *)      FORWARD+=("$1"); shift ;;
  esac
done

REPO_ROOT="$(metis_repo_root "$TARGET")"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  metis_say "✗ metis/scan: target directory not found: ${TARGET}"
  exit 2
fi

bash "${CRUCIBLE_METIS_DIR}/ensure-up.sh" "$REPO_ROOT" || exit 1
exec bash "${CRUCIBLE_METIS_DIR}/run.sh" "$REPO_ROOT" ${FORWARD[@]+"${FORWARD[@]}"}
