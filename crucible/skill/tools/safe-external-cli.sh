#!/bin/sh
# Run an external reviewer with a deliberately tiny, non-secret environment.
# Do not replace this with `env "$@"`: reviewer CLIs must never inherit ambient
# credentials or SSH agent forwarding from the Crucible host.
set -eu

if [ "$#" -eq 0 ]; then
  printf '%s\\n' 'safe-external-cli: command required' >&2
  exit 64
fi

# Fail closed if the primitive used to construct the scrubbed environment is unavailable.
if ! command -v env >/dev/null 2>&1; then
  printf '%s\\n' 'safe-external-cli: env command unavailable; refusing dispatch' >&2
  exit 125
fi

# Keep only runtime metadata needed by ordinary CLIs; no credential-shaped variables.
exec env -i PATH="${PATH:-/usr/bin:/bin}" HOME="${HOME:-}" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-C}" LC_ALL="${LC_ALL:-}" TERM="${TERM:-}" PWD="${PWD:-}" USER="${USER:-}" LOGNAME="${LOGNAME:-}" SHELL="${SHELL:-/bin/sh}" CRUCIBLE_ENV_ISOLATED=1 "$@"
