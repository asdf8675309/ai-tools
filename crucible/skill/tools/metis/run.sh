#!/usr/bin/env bash
# Run Metis in Docker against a target repository.
#
#   run.sh <repo-dir> [--schema NAME] [--diff FILE] [--command "review_patch /diff/patch.diff"]
#                     [--output FILE] [-- <extra metis args>]
#
# With --command it runs non-interactively and prints the JSON results on
# stdout; without one it drops into Metis's interactive CLI.
#
# This is the executor: it exits non-zero when it cannot run. The review-time
# entry point is scan-diff.sh, which turns any such failure into a skip.
set -uo pipefail

# shellcheck source=./lib.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TARGET_ARG="${1:-$PWD}"
[ $# -gt 0 ] && shift

SCHEMA_OVERRIDE=""
DIFF_FILE=""
METIS_COMMAND=""
OUTPUT_FILE=""
EXTRA_METIS_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --schema)  SCHEMA_OVERRIDE="${2:-}"; shift 2 ;;
    --diff)    DIFF_FILE="${2:-}"; shift 2 ;;
    --command) METIS_COMMAND="${2:-}"; shift 2 ;;
    --output)  OUTPUT_FILE="${2:-}"; shift 2 ;;
    --)        shift; while [ $# -gt 0 ]; do EXTRA_METIS_ARGS+=("$1"); shift; done ;;
    *)         metis_say "✗ metis/run: unknown flag: $1"; exit 2 ;;
  esac
done

REPO_ROOT="$(metis_repo_root "$TARGET_ARG")"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  metis_say "✗ metis/run: target directory not found: ${TARGET_ARG}"
  exit 2
fi

metis_load_config "$REPO_ROOT"
if [ "$CRUCIBLE_METIS_AVAILABLE" != "true" ]; then
  metis_say "→ metis/run: not available — ${CRUCIBLE_METIS_REASON}"
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  metis_say "→ metis/run: docker is not on PATH"
  exit 1
fi
if ! metis_container_running "$CRUCIBLE_METIS_POSTGRES_CONTAINER"; then
  metis_say "→ metis/run: ${CRUCIBLE_METIS_POSTGRES_CONTAINER} is not running (see ensure-up.sh)"
  exit 1
fi

SCHEMA="${SCHEMA_OVERRIDE:-$CRUCIBLE_METIS_SCHEMA}"
# Config.ts already folds this to a safe identifier; re-checking here keeps the
# SQL below safe no matter who called the script or with what.
if ! printf '%s' "$SCHEMA" | grep -qE '^[a-z_][a-z0-9_]*$'; then
  metis_say "✗ metis/run: schema must match ^[a-z_][a-z0-9_]*\$ — got '${SCHEMA}'"
  exit 2
fi

if [ -n "$DIFF_FILE" ]; then
  if [ ! -f "$DIFF_FILE" ]; then
    metis_say "✗ metis/run: diff file not found: ${DIFF_FILE}"
    exit 2
  fi
  DIFF_FILE="$(cd "$(dirname "$DIFF_FILE")" && pwd)/$(basename "$DIFF_FILE")"
fi

# Workspace mounted at /metis: the container's working directory, where Metis
# reads metis.yaml and writes results.
#
# It is a whole directory rather than a bind mount of the config file alone
# because Docker Desktop on macOS validates virtiofs mount destinations against
# the container rootfs boundary, and mounting a single host file INTO a path
# that is itself a bind mount is rejected. Mounting the containing directory is
# the workaround. Do not "simplify" this to -v <file>:/metis/metis.yaml.
WORKSPACE="$(mktemp -d 2>/dev/null || mktemp -d -t crucible-metis)"
if [ -z "$WORKSPACE" ] || [ ! -d "$WORKSPACE" ]; then
  metis_say "✗ metis/run: could not create a temp workspace"
  exit 1
fi
chmod 700 "$WORKSPACE" 2>/dev/null
metis_scan_begin
trap 'metis_scan_end; rm -rf "$WORKSPACE"' EXIT INT TERM

# The endpoint is read from the env var named by llm.base_url_env and written
# only into this ephemeral file — never echoed, never committed. The API key is
# not read at all: metis.yaml names the variable and Docker forwards the value.
BASE_URL=""
if [ -n "$CRUCIBLE_METIS_LLM_BASE_URL_ENV" ]; then
  BASE_URL="$(printenv "$CRUCIBLE_METIS_LLM_BASE_URL_ENV" 2>/dev/null)"
fi

y_db_user="$(metis_yaml_escape "$CRUCIBLE_METIS_DB_USER")"
y_db_password="$(metis_yaml_escape "$CRUCIBLE_METIS_DB_PASSWORD")"
y_db_host="$(metis_yaml_escape "$CRUCIBLE_METIS_DB_HOST")"
y_db_name="$(metis_yaml_escape "$CRUCIBLE_METIS_DB_NAME")"
y_model="$(metis_yaml_escape "$CRUCIBLE_METIS_LLM_MODEL")"
y_effort="$(metis_yaml_escape "$CRUCIBLE_METIS_LLM_REASONING_EFFORT")"
y_key_env="$(metis_yaml_escape "$CRUCIBLE_METIS_LLM_API_KEY_ENV")"
y_code_embed="$(metis_yaml_escape "$CRUCIBLE_METIS_LLM_CODE_EMBEDDING_MODEL")"
y_docs_embed="$(metis_yaml_escape "$CRUCIBLE_METIS_LLM_DOCS_EMBEDDING_MODEL")"
y_base_url="$(metis_yaml_escape "$BASE_URL")"

# These two go into the YAML unquoted, so they must be numbers or the file
# stops being valid YAML.
n_db_port="$CRUCIBLE_METIS_DB_PORT"
n_embed_dim="$CRUCIBLE_METIS_LLM_EMBED_DIM"
printf '%s' "$n_db_port" | grep -qE '^[0-9]+$' || n_db_port=5432
printf '%s' "$n_embed_dim" | grep -qE '^[0-9]+$' || n_embed_dim=3072

{
  cat <<YAML
psql_database:
  provider: "config"
  credentials:
    username: "${y_db_user}"
    password: "${y_db_password}"
    host: "${y_db_host}"
    port: ${n_db_port}
    database_name: "${y_db_name}"

metis_engine:
  embed_dim: ${n_embed_dim}
  pgvector_use_halfvec: auto
  reachability_confirmation_model: "${y_model}"

llm_provider:
  name: "openai"
  model: "${y_model}"
  reasoning_effort: "${y_effort}"
  api_key_env: "${y_key_env}"
YAML
  [ -n "$BASE_URL" ] && printf '  base_url: "%s"\n' "$y_base_url"
  cat <<YAML

embedding_provider:
  name: "openai"
  code_embedding_model: "${y_code_embed}"
  docs_embedding_model: "${y_docs_embed}"
  api_key_env: "${y_key_env}"
YAML
  [ -n "$BASE_URL" ] && printf '  base_url: "%s"\n' "$y_base_url"
} > "${WORKSPACE}/metis.yaml"
chmod 600 "${WORKSPACE}/metis.yaml" 2>/dev/null

DOCKER_FLAGS=()
METIS_FLAGS=()
TTY_FLAG="-it"

if [ -n "$METIS_COMMAND" ]; then
  TTY_FLAG="-i"
  [ -n "$DIFF_FILE" ] && DOCKER_FLAGS+=(-v "${DIFF_FILE}:/diff/patch.diff:ro")
  METIS_FLAGS+=(--non-interactive --command "$METIS_COMMAND" --output-file /metis/review-results.json)
fi

# An indexed project gets the vector-index tools; an unindexed one would only
# pay for retrieval that cannot answer. Upstream's tool selection is --tools,
# and the index tool is opt-in — off unless asked for.
SCHEMA_EXISTS="$(docker exec "$CRUCIBLE_METIS_POSTGRES_CONTAINER" \
  psql -U "$CRUCIBLE_METIS_DB_USER" -d "$CRUCIBLE_METIS_DB_NAME" -tAc \
  "SELECT 1 FROM information_schema.schemata WHERE schema_name = '${SCHEMA}'" 2>/dev/null)"

# index/update/ask REQUIRE the index tool, and the very first `index` run is
# exactly the case where no schema exists yet — detecting on the schema alone
# would make bootstrapping an index impossible.
case "${METIS_COMMAND%% *}" in
  index | update | ask) NEEDS_INDEX_TOOL=1 ;;
  *) NEEDS_INDEX_TOOL=0 ;;
esac

if [ "$SCHEMA_EXISTS" = "1" ] || [ "$NEEDS_INDEX_TOOL" = "1" ]; then
  # shellcheck disable=SC2054
  # The comma is Metis's own list separator for --tools, not an array separator.
  METIS_FLAGS+=(--tools index,navigation)
fi
if [ "$SCHEMA_EXISTS" = "1" ]; then INDEX_NOTE="indexed"; else INDEX_NOTE="not indexed"; fi

metis_say "→ metis/run: schema=${SCHEMA} (${INDEX_NOTE}) path=${REPO_ROOT}${METIS_COMMAND:+ cmd=${METIS_COMMAND}}"

# -e NAME (no value) forwards the variable from this environment, so the key
# never appears in the command line or in any process listing.
docker run --rm "$TTY_FLAG" \
  --network "$CRUCIBLE_METIS_NETWORK" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e "$CRUCIBLE_METIS_LLM_API_KEY_ENV" \
  -v "${REPO_ROOT}:/code:ro" \
  -v "${WORKSPACE}:/metis" \
  ${DOCKER_FLAGS[@]+"${DOCKER_FLAGS[@]}"} \
  "$CRUCIBLE_METIS_SCAN_IMAGE" \
  --config /metis/metis.yaml \
  --backend postgres \
  --project-schema "$SCHEMA" \
  --codebase-path /code \
  ${METIS_FLAGS[@]+"${METIS_FLAGS[@]}"} \
  ${EXTRA_METIS_ARGS[@]+"${EXTRA_METIS_ARGS[@]}"}
RUN_STATUS=$?

if [ -n "$METIS_COMMAND" ] && [ -f "${WORKSPACE}/review-results.json" ]; then
  [ -n "$OUTPUT_FILE" ] && cp "${WORKSPACE}/review-results.json" "$OUTPUT_FILE"
  cat "${WORKSPACE}/review-results.json"
fi

exit "$RUN_STATUS"
