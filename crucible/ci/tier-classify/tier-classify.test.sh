#!/usr/bin/env bash
# Regression tests for workflows/tier-classify.yml
#
# Run:  bash tier-classify/tier-classify.test.sh
# Exit: 0 all pass, 1 any failure.
#
# Extracts the real `run:` block from the workflow YAML and executes it, so the
# tests bind to the shipped text rather than a copy that can drift.
#
# Two harnesses — real git fixtures for anything ref-spec or path-shape driven,
# a discriminating stub for changed_files mismatch cases. Why each is necessary:
# tier-classify/README.md.
#
# Each test names the defect it guards.

set -uo pipefail

# The classifier reads three optional overrides from the environment. Unset them
# so the suite always exercises the SHIPPED DEFAULTS — a dev with one exported
# in their shell would otherwise test their own regex and report green.
unset TIER_SENSITIVE_REGEX TIER_WORKSPACE_ROOTS TIER_DEPLOY_CONFIG_REGEX

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Workflow location, in order: explicit override, the installed location once
# this directory has been copied into `.github/`, then the sibling `workflows/`
# directory as it ships in this repo.
if [ -n "${TIER_WORKFLOW:-}" ]; then
  WORKFLOW="$TIER_WORKFLOW"
elif REPO_ROOT="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" \
     && [ -f "$REPO_ROOT/.github/workflows/tier-classify.yml" ]; then
  WORKFLOW="$REPO_ROOT/.github/workflows/tier-classify.yml"
else
  WORKFLOW="$HERE/../workflows/tier-classify.yml"
fi
[ -f "$WORKFLOW" ] || { echo "FATAL: workflow not found at $WORKFLOW (set TIER_WORKFLOW)"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Keep later mktemp calls inside $WORK so the trap reclaims them. Note BSD mktemp
# (macOS) ignores TMPDIR when given no template and resolves via
# _CS_DARWIN_USER_TEMP_DIR, so this only takes effect on GNU coreutils — i.e. on
# CI, where the files are ephemeral anyway. Harmless either way; not a full fix.
export TMPDIR="$WORK"

PASS=0; FAIL=0
ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n       expected %s, got %s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); }

# ── Extract the shipped run block ────────────────────────────────────────────
# Deliberately dependency-free: no YAML package, so this runs on a clean CI
# runner with no install step. Finds the step whose `id:` is tier, then its
# `run: |` block, then dedents by that block's own indentation. The sanity check
# below fails loudly if the shape ever changes.
python3 - "$WORKFLOW" "$WORK/step.sh" <<'PY' || { echo "FATAL: could not extract run block"; exit 1; }
import sys
src, dst = sys.argv[1], sys.argv[2]
lines = open(src, encoding="utf-8").read().split("\n")
i = next((n for n, l in enumerate(lines) if l.strip() == "id: tier"), None)
if i is None:
    sys.exit("no step with `id: tier`")
j = next((n for n in range(i, len(lines)) if lines[n].strip() == "run: |"), None)
if j is None:
    sys.exit("no `run: |` after `id: tier`")
body, indent = [], None
for l in lines[j + 1:]:
    if l.strip() == "":
        body.append("")
        continue
    cur = len(l) - len(l.lstrip())
    if indent is None:
        indent = cur
    elif cur < indent:
        break
    body.append(l[indent:])
open(dst, "w", encoding="utf-8").write("\n".join(body).rstrip() + "\n")
PY

# The extractor is hand-rolled, so prove it grabbed the real thing rather than
# silently producing an empty or truncated script every test would then "pass".
for marker in 'set -euo pipefail' 'DIFF_OK=1' 'CHANGED_NO_RENAMES=' 'GITHUB_OUTPUT'; do
  grep -qF "$marker" "$WORK/step.sh" || { echo "FATAL: extracted block missing '$marker'"; exit 1; }
done
bash -n "$WORK/step.sh" || { echo "FATAL: extracted block is not valid bash"; exit 1; }

# Mutant: revert the ref-spec to the two-dot form.
sed 's/"\$BASE_SHA\.\.\.\$HEAD_SHA"/"$BASE_SHA" "$HEAD_SHA"/g' "$WORK/step.sh" > "$WORK/step-twodot.sh"
# Mutant: point the sensitive-path classifier back at the rename-detected list.
sed 's/echo "\$CHANGED_NO_RENAMES"/echo "$CHANGED"/g' "$WORK/step.sh" > "$WORK/step-renameblind.sh"

# A sed whose anchor stops matching produces a mutant identical to the original,
# and then the "mutant is killed" assertions pass while testing nothing. Same
# vacuous-pass class the extractor guard above exists for.
# Mutants for the other two behaviour-affecting classifiers. Reverting either to
# $CHANGED downgrades a real PR to trivial, and until these existed the suite
# went green on both: repointing the classifiers came before binding them.
sed 's/WORKSPACES=$(echo "\$CHANGED_NO_RENAMES"/WORKSPACES=$(echo "$CHANGED"/' "$WORK/step.sh" > "$WORK/step-ws.sh"
sed 's/HAS_PKG_BUMP=$(echo "\$CHANGED_NO_RENAMES"/HAS_PKG_BUMP=$(echo "$CHANGED"/' "$WORK/step.sh" > "$WORK/step-pkg.sh"

for m in step-twodot step-renameblind step-ws step-pkg; do
  cmp -s "$WORK/step.sh" "$WORK/$m.sh" && { echo "FATAL: $m mutant is identical to the original — its sed anchor no longer matches"; exit 1; }
done

# run <script> <base> <head> <changed_files> -> "tier sensitive_hits"
run() {
  local out; out="$(mktemp)"
  BASE_SHA="$2" HEAD_SHA="$3" CHANGED_FILES="$4" GITHUB_OUTPUT="$out" bash "$1" >/dev/null 2>&1
  printf '%s %s' "$(sed -n 's/^tier=//p' "$out")" "$(sed -n 's/^sensitive_hits=//p' "$out")"
}

# diff.renames is pinned, not inherited: with diff.renames=false in a dev's
# ambient config the rename fixture stops discriminating (real and mutant both
# return `full 1`, via the fail-safe rather than the sensitive rule) and the
# suite still reports green. CI is unaffected — default config — which is what
# makes it insidious: it dies silently only where someone is iterating.
git_init() {
  git init -q -b main "$1"
  git -C "$1" config user.email t@t
  git -C "$1" config user.name t
  git -C "$1" config diff.renames true
}

# ── Defect 1: three-dot ref-spec (Fixture D) ─────────────────────────────────
# The base branch independently lands the SAME edit to the sensitive file that
# the PR makes. Under two-dot that file is identical at both endpoints, so it
# vanishes from the diff and its sensitive hit disappears; the base's own
# unrelated file takes its place and the count still comes to 4. changed_files is
# also 4, so the fail-safe is BLIND — three-dot is the only thing that can see
# the PR's real content.
#
# This is deliberately NOT the easier fixture where the base touches some
# unrelated sensitive path: there the mutant dies to the fail-safe or to a
# spurious hit, and nothing proves the ref-spec itself is load-bearing.
FD="$WORK/fixture-d"; mkdir -p "$FD"; git_init "$FD"
(
  cd "$FD"
  mkdir -p packages/auth
  echo base > a.ts; echo base > b.ts; echo base > c.ts
  echo base > packages/auth/token.ts
  echo base > main-only.ts
  git add -A; git commit -qm base
  git checkout -qb pr
  echo pr > a.ts; echo pr > b.ts; echo pr > c.ts
  echo converged > packages/auth/token.ts
  git add -A; git commit -qm "PR: 3 plain files + the sensitive one"
  git checkout -q main
  echo converged > packages/auth/token.ts   # identical to the PR's edit
  echo moved-on > main-only.ts
  git add -A; git commit -qm "base lands the same sensitive edit, plus its own file"
)
D_MAIN=$(git -C "$FD" rev-parse main); D_PR=$(git -C "$FD" rev-parse pr)
cd "$FD"
got=$(run "$WORK/step.sh" "$D_MAIN" "$D_PR" 4)
[ "$got" = "full 1" ] && ok "defect1: three-dot sees the PR's own sensitive file" \
                      || bad "defect1: three-dot sees the PR's own sensitive file" "full 1" "$got"
got=$(run "$WORK/step-twodot.sh" "$D_MAIN" "$D_PR" 4)
[ "$got" = "trivial 0" ] && ok "defect1: two-dot mutant is KILLED (fail-safe blind at 4v4)" \
                         || bad "defect1: two-dot mutant is KILLED" "trivial 0" "$got"

# ── Defect 2: fail-safe compares counts ──────────────────────────────────────
# Discriminating stub: STUB_FILES and STUB_FILES_NR are held separately so the
# rename-blind mutant is detectable.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/git" <<'STUB'
#!/usr/bin/env bash
[ "${STUB_RC:-0}" != "0" ] && exit "$STUB_RC"
# Fail ONLY the piped --name-only diffs, leaving the unpiped --shortstat healthy.
# That is the one shape where the changed_files cross-check cannot compensate, so
# it is the only way to bind `pipefail` (see the pipefail case below).
case "$*" in
  *--name-only*) [ "${STUB_RC_NAMEONLY:-0}" != "0" ] && exit "$STUB_RC_NAMEONLY" ;;
esac
case "$*" in
  *--shortstat*)            printf '%s\n' "$STUB_STAT" ;;
  # Order-independent on purpose: routing on `*--name-only*--no-renames*` would
  # misroute if the workflow ever wrote the flags the other way round, silently
  # feeding the rename-blind call the rename-detected list — which is exactly the
  # condition that makes the rename mutant undetectable.
  *--no-renames*) printf '%s' "${STUB_FILES_NR-$STUB_FILES}" ;;
  *--name-only*)  printf '%s' "$STUB_FILES" ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/git"

# stub_case <label> <expect_tier> <changed_files> <stat> <files> [files_nr] [rc]
#
# Asserts the tier AND that $GITHUB_OUTPUT is still well-formed. The shape check
# is not incidental: rejecting a bad value is not the same as containing it — an
# unvalidated newline reaching an output line injects an arbitrary key. Two
# inputs can carry one: `changed_files` (this side) and file paths (the path
# side, which already asserts it). Both are checked so neither regresses alone.
stub_case() {
  local out; out="$(mktemp)"
  PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES="$3" \
    STUB_STAT="$4" STUB_FILES="$5" STUB_FILES_NR="${6-$5}" STUB_RC="${7:-0}" \
    GITHUB_OUTPUT="$out" bash "$WORK/step.sh" >/dev/null 2>&1
  local t keys total; t="$(sed -n 's/^tier=//p' "$out")"
  keys=$(grep -cE '^[a-z_]+=' "$out" || true)
  total=$(wc -l < "$out" | tr -d ' ')
  # Exact count, not keys == total. A LOWERCASE injected key matches `^[a-z_]+=`
  # and is counted as well-formed, so keys == total still holds and the check
  # passes — it only ever caught uppercase payloads, i.e. it worked by accident
  # of the payload chosen. The step emits exactly EXPECTED_KEYS lines.
  if [ "$t" != "$2" ]; then bad "$1" "$2" "$t"
  elif [ "$keys" != "$total" ]; then bad "$1 [output shape]" "$keys well-formed lines" "$total total lines"
  elif [ "$total" != "$EXPECTED_KEYS" ]; then bad "$1 [output key count]" "$EXPECTED_KEYS lines" "$total lines"
  else ok "$1"; fi
}
# How many `key=value` lines the step writes. Derived from the shipped block, not
# hardcoded, so adding an output updates it here automatically.
EXPECTED_KEYS=$(grep -cE '^[[:space:]]*echo "[a-z_]+=' "$WORK/step.sh")
[ "$EXPECTED_KEYS" -gt 0 ] || { echo "FATAL: could not count GITHUB_OUTPUT keys in the extracted block"; exit 1; }

FOUR=$'a.ts\nb.ts\nc.ts\nd.ts'
stub_case "defect2: counts agree -> lite"          lite    4 " 4 files changed, 79 insertions(+)" "$FOUR"
stub_case "defect2: api=4 local=32 -> full"        full    4 " 32 files changed, 671 insertions(+)" "$(seq -f 'f%g.ts' 32)"
stub_case "defect2: api=4 local=3 -> full"         full    4 " 3 files changed, 5 insertions(+)" $'a.ts\nb.ts\nc.ts'
stub_case "defect2: local=0 api=4 -> full"         full    4 " 0 files changed" ""
stub_case "defect2: git diff fails -> full"        full    4 "" "" "" 1
stub_case "defect2: empty PR 0=0 -> trivial"       trivial 0 "" ""
stub_case "defect2: changed_files 'abc' -> full"   full    abc " 4 files changed, 9 insertions(+)" "$FOUR"
stub_case "defect2: 'abc' + empty diff -> full"    full    abc "" ""
stub_case "defect2: mixed '4abc' -> full"          full    4abc " 4 files changed, 9 insertions(+)" "$FOUR"
stub_case "defect2: spaced ' 4 ' -> full"          full    " 4 " " 4 files changed, 9 insertions(+)" "$FOUR"
stub_case "defect2: negative '-1' -> full"         full    -1 " 1 file changed, 2 insertions(+)" $'a.ts'
stub_case "defect2: empty changed_files -> full"   full    "" " 4 files changed, 9 insertions(+)" "$FOUR"
stub_case "defect2: newline in changed_files cannot inject an output key" \
          full "$(printf '1\nMALICIOUS=pwned')" " 1 file changed, 2 insertions(+)" $'a.ts'
stub_case "defect2: LOWERCASE injected key is caught too" \
          full "$(printf '1\nmalicious=pwned')" " 1 file changed, 2 insertions(+)" $'a.ts'

# Binds `pipefail`, which is load-bearing for the two piped diffs: without it the
# pipeline reports `tr`'s exit 0 and a failed `git diff` sails past `|| DIFF_OK=0`.
#
# This needs the one shape where the changed_files cross-check is blind. With
# changed_files=4 both variants fail-safe to Full via the count mismatch, so the
# mutant survives; with changed_files=0 the local count is 0 too, the cross-check
# agrees, and only pipefail stands between a failed diff and Trivial.
#
# The stat must also be SMALL. An earlier version used 900 insertions and the
# mutant still reached Full via the size gate, so the fixture proved nothing.
#
# Note a naive `set -euo pipefail` -> `set -eu` mutant dies for the WRONG reason —
# the extractor's marker guard greps that literal string. That is a text
# coincidence, not coverage, which is why this asserts behaviour instead.
out="$(mktemp)"
PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES=0 \
  STUB_STAT=" 1 file changed, 2 insertions(+)" STUB_FILES="" STUB_RC_NAMEONLY=128 \
  GITHUB_OUTPUT="$out" bash "$WORK/step.sh" >/dev/null 2>&1
t="$(sed -n 's/^tier=//p' "$out")"
[ "$t" = "full" ] && ok "defect4: piped diff failure fails CLOSED (pipefail)" \
                  || bad "defect4: piped diff failure fails CLOSED (pipefail)" "full" "$t"

# Binds `paste -s`. Both fragments must be valid workspace paths — against a
# fixture that matches no workspace, WORKSPACE_LIST is "(none)" with or without
# paste and the guard goes untested.
stub_case "defect4: paste -s collapse is load-bearing" \
          trivial 2 " 2 files changed, 4 insertions(+)" $'apps/alpha/x.ts\napps/beta/y.ts'

# CR is stripped from WORKSPACE_LIST as hygiene, NOT as a bypass fix.
#
# An earlier version of this test claimed a CR could forge a second `tier=` line
# that the runner would resolve last. That is FALSE: the Actions runner parses
# GITHUB_OUTPUT with a reader that splits on \n (and \r\n on Windows only) —
# never on a lone \r. Reviewers asserted otherwise by reasoning from other .NET
# line-reading APIs that the runner does not use; reading the runner source
# settled it.
#
# The test was also circular: it ran `tr '\r' '\n'` on the output — performing
# the very conversion the runner does not do — and then counted the line it had
# just manufactured. It could only ever confirm its own premise.
#
# What is asserted now is the only thing that is true and checkable: the emitted
# value carries no CR. That is worth keeping because `-z` is what first allowed
# CR-bearing paths to reach WORKSPACE_LIST at all, so the strip is that change's
# own hygiene obligation, and it defends any consumer that does split on CR.
CR_PATH=$(printf 'apps/z\rtier=trivial/x.ts')
out="$(mktemp)"
PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES=1 \
  STUB_STAT=" 1 file changed, 900 insertions(+)" STUB_FILES="$CR_PATH" \
  GITHUB_OUTPUT="$out" bash "$WORK/step.sh" >/dev/null 2>&1
if grep -q $'\r' "$out"; then
  bad "defect4: no CR reaches GITHUB_OUTPUT" "no CR in output" "CR present"
else ok "defect4: no CR reaches GITHUB_OUTPUT"; fi

# Rename-blind mutant is only detectable because the two lists differ.
out="$(mktemp)"
PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES=1 \
  STUB_STAT=" 1 file changed, 0 insertions(+), 0 deletions(-)" \
  STUB_FILES='apps/x/token.ts' \
  STUB_FILES_NR=$'apps/x/token.ts\npackages/auth/token.ts' \
  GITHUB_OUTPUT="$out" bash "$WORK/step-renameblind.sh" >/dev/null 2>&1
t="$(sed -n 's/^tier=//p' "$out")"
[ "$t" = "trivial" ] && ok "defect3: rename-blind mutant is KILLED (stub discriminates)" \
                     || bad "defect3: rename-blind mutant is KILLED" "trivial" "$t"

# ── Sensitive-path coverage ──────────────────────────────────────────────────
# Both of these were live gaps in the original: the crypto/webhook/auth clause
# required a trailing slash so it matched only DIRECTORIES, missing auth
# middleware that lives in files; and the `.github/` list named specific
# subdirectories, so editing the reviewer's own prompt — which sits in one that
# was not listed — skipped the reviewer. Small diffs so only the path can force
# Full; a size-driven Full would prove nothing.
stub_case "sensitive: auth middleware FILE -> full" \
          full 1 " 1 file changed, 3 insertions(+)" $'apps/service/worker/auth.ts'
stub_case "sensitive: auth-helpers.ts FILE -> full" \
          full 1 " 1 file changed, 3 insertions(+)" $'apps/web/worker/auth-helpers.ts'
stub_case "sensitive: auth/ DIRECTORY -> full" \
          full 1 " 1 file changed, 3 insertions(+)" $'packages/auth/token.ts'
stub_case "sensitive: .github/pre-pr-review/ -> full" \
          full 1 " 1 file changed, 1 insertion(+)" $'.github/pre-pr-review/reviewer-prompt.md'
# A nested `.github/` holds per-app prompts and workflows too; `^`-anchoring
# would miss every one of them.
stub_case "sensitive: nested apps/*/.github/ -> full" \
          full 1 " 1 file changed, 1 insertion(+)" $'apps/web/.github/copilot-instructions.md'
# The stem may sit anywhere in the basename provided it is separator-delimited.
# `<qualifier>-auth.ts` is a dominant real-world convention and a
# stem-must-start-the-basename form misses all of it.
stub_case "sensitive: service-auth.ts -> full" \
          full 1 " 1 file changed, 5 insertions(+)" $'apps/service/worker/service-auth.ts'
stub_case "sensitive: stripe-webhooks.ts -> full" \
          full 1 " 1 file changed, 5 insertions(+)" $'apps/shop/worker/routes/stripe-webhooks.ts'
# Guard the tightening: `auth` must need a separator, or every author.ts is Full.
stub_case "sensitive: author.ts is NOT sensitive -> trivial" \
          trivial 1 " 1 file changed, 2 insertions(+)" $'apps/x/src/author.ts'
stub_case "sensitive: authorize-page.tsx is NOT sensitive -> trivial" \
          trivial 1 " 1 file changed, 2 insertions(+)" $'apps/x/src/authorize-page.tsx'
stub_case "sensitive: oauthLib.ts is NOT sensitive -> trivial" \
          trivial 1 " 1 file changed, 2 insertions(+)" $'apps/x/src/oauthLib.ts'

# Trivial blockers that are not about paths being sensitive.
stub_case "blockers: a lockfile bump blocks Trivial" \
          lite 1 " 1 file changed, 2 insertions(+)" $'pnpm-lock.yaml'
stub_case "blockers: a deploy descriptor blocks Trivial" \
          lite 1 " 1 file changed, 1 insertion(+)" $'apps/web/wrangler.jsonc'
stub_case "blockers: a Dockerfile blocks Trivial" \
          lite 1 " 1 file changed, 1 insertion(+)" $'services/api/Dockerfile'

# ── Configuration overrides ──────────────────────────────────────────────────
# The three repo variables are the adoption seam. Untested, a typo in the
# plumbing would silently fall back to the defaults and the override would look
# like it worked.
out="$(mktemp)"
PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES=1 \
  STUB_STAT=" 1 file changed, 2 insertions(+)" STUB_FILES=$'billing/ledger.rb' \
  TIER_SENSITIVE_REGEX='^billing/' \
  GITHUB_OUTPUT="$out" bash "$WORK/step.sh" >/dev/null 2>&1
t="$(sed -n 's/^tier=//p' "$out")"
[ "$t" = "full" ] && ok "config: TIER_SENSITIVE_REGEX override is honoured" \
                  || bad "config: TIER_SENSITIVE_REGEX override is honoured" "full" "$t"

out="$(mktemp)"
PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES=3 \
  STUB_STAT=" 3 files changed, 30 insertions(+)" \
  STUB_FILES=$'svc/a/x.ts\nsvc/b/x.ts\nsvc/c/x.ts' \
  TIER_WORKSPACE_ROOTS='svc' \
  GITHUB_OUTPUT="$out" bash "$WORK/step.sh" >/dev/null 2>&1
w="$(sed -n 's/^workspaces=//p' "$out")"
[ "$w" = "3" ] && ok "config: TIER_WORKSPACE_ROOTS override is honoured" \
               || bad "config: TIER_WORKSPACE_ROOTS override is honoured" "3" "$w"

# A single-package repo needs no configuration: nothing matches the default
# workspace roots, so the workspace gates are inert rather than wrong.
stub_case "config: non-monorepo layout still classifies (0 workspaces)" \
          trivial 2 " 2 files changed, 4 insertions(+)" $'src/index.ts\nsrc/util.ts'

# WORKSPACES and HAS_PKG_BUMP must read the rename-blind list too. A pure rename
# is 0 ins / 0 del and the file counts agree, so the fail-safe is silent — only
# the classifier itself can force a non-trivial tier.
#
# Cross-workspace move: rename-blind sees both source and destination workspaces
# (3 > 2 -> Full); rename-detected sees only the destination (1 -> Trivial).
WS_MOVE=$'apps/dest/a.ts\napps/dest/b.ts\napps/dest/c.ts'
WS_MOVE_NR=$WS_MOVE$'\napps/alpha/a.ts\napps/beta/b.ts\napps/gamma/c.ts'
out="$(mktemp)"
PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES=3 \
  STUB_STAT=" 3 files changed, 0 insertions(+), 0 deletions(-)" \
  STUB_FILES="$WS_MOVE" STUB_FILES_NR="$WS_MOVE_NR" \
  GITHUB_OUTPUT="$out" bash "$WORK/step.sh" >/dev/null 2>&1
t="$(sed -n 's/^tier=//p' "$out")"
[ "$t" = "full" ] && ok "classifiers: cross-workspace rename -> full" \
                  || bad "classifiers: cross-workspace rename -> full" "full" "$t"
out="$(mktemp)"
PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES=3 \
  STUB_STAT=" 3 files changed, 0 insertions(+), 0 deletions(-)" \
  STUB_FILES="$WS_MOVE" STUB_FILES_NR="$WS_MOVE_NR" \
  GITHUB_OUTPUT="$out" bash "$WORK/step-ws.sh" >/dev/null 2>&1
t="$(sed -n 's/^tier=//p' "$out")"
[ "$t" = "trivial" ] && ok "classifiers: WORKSPACES mutant is KILLED" \
                     || bad "classifiers: WORKSPACES mutant is KILLED" "trivial" "$t"

# package.json renamed to a non-manifest name: the source only appears rename-blind.
PKG=$'apps/y/package.json.bak'
PKG_NR=$PKG$'\napps/y/package.json'
out="$(mktemp)"
PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES=1 \
  STUB_STAT=" 1 file changed, 0 insertions(+), 0 deletions(-)" \
  STUB_FILES="$PKG" STUB_FILES_NR="$PKG_NR" \
  GITHUB_OUTPUT="$out" bash "$WORK/step.sh" >/dev/null 2>&1
p="$(sed -n 's/^has_pkg_bump=//p' "$out")"
[ "$p" = "1" ] && ok "classifiers: renamed-away package.json still blocks Trivial" \
               || bad "classifiers: renamed-away package.json still blocks Trivial" "1" "$p"
out="$(mktemp)"
PATH="$WORK/bin:$PATH" BASE_SHA=a HEAD_SHA=b CHANGED_FILES=1 \
  STUB_STAT=" 1 file changed, 0 insertions(+), 0 deletions(-)" \
  STUB_FILES="$PKG" STUB_FILES_NR="$PKG_NR" \
  GITHUB_OUTPUT="$out" bash "$WORK/step-pkg.sh" >/dev/null 2>&1
p="$(sed -n 's/^has_pkg_bump=//p' "$out")"
[ "$p" = "0" ] && ok "classifiers: HAS_PKG_BUMP mutant is KILLED" \
               || bad "classifiers: HAS_PKG_BUMP mutant is KILLED" "0" "$p"

# ── Defect 3: rename hides the sensitive source path ─────────────────────────
FR="$WORK/fixture-rename"; mkdir -p "$FR"; git_init "$FR"
(
  cd "$FR"
  mkdir -p packages/auth apps/x
  printf 'secret\n' > packages/auth/token.ts
  echo base > base.txt; git add -A; git commit -qm base
  git checkout -qb pr
  git mv packages/auth/token.ts apps/x/token.ts
  git commit -qm "pure rename out of a sensitive directory"
)
cd "$FR"
got=$(run "$WORK/step.sh" "$(git rev-parse main)" "$(git rev-parse pr)" 1)
[ "$got" = "full 1" ] && ok "defect3: pure git mv out of packages/auth -> full" \
                      || bad "defect3: pure git mv out of packages/auth -> full" "full 1" "$got"

# ── Defect 4: git C-quotes awkward paths, defeating ^-anchored regexes ───────
FQ="$WORK/fixture-quote"; mkdir -p "$FQ"; git_init "$FQ"
(
  cd "$FQ"
  mkdir -p packages/auth migrations
  echo base > base.txt; git add -A; git commit -qm base
  git checkout -qb pr
  printf 'x\n' > "packages/auth/café.ts"
  printf 'x\n' > "packages/auth/tok\\en.ts"
  printf 'x\n' > 'packages/auth/tok"en.ts'
  printf 'x\n' > "migrations/002_eq\\uip.sql"
  git add -A; git commit -qm "paths git would C-quote"
)
cd "$FQ"
got=$(run "$WORK/step.sh" "$(git rev-parse main)" "$(git rev-parse pr)" 4)
[ "$got" = "full 4" ] && ok "defect4: non-ASCII/backslash/quote paths still classify" \
                      || bad "defect4: non-ASCII/backslash/quote paths still classify" "full 4" "$got"

# A path containing a literal newline splits under -z, inflating the local count.
# That disagrees with changed_files and must fail CLOSED, never inject into
# GITHUB_OUTPUT.
FN="$WORK/fixture-newline"; mkdir -p "$FN"; git_init "$FN"
(
  cd "$FN"
  echo base > base.txt; git add -A; git commit -qm base
  git checkout -qb pr
  mkdir -p "$(printf 'apps/ev\nil/src')"
  printf 'x\n' > "$(printf 'apps/ev\nil/src/a.ts')"
  git add -A; git commit -qm "newline in path"
)
cd "$FN"
out="$(mktemp)"
BASE_SHA="$(git rev-parse main)" HEAD_SHA="$(git rev-parse pr)" CHANGED_FILES=1 \
  GITHUB_OUTPUT="$out" bash "$WORK/step.sh" >/dev/null 2>&1
t="$(sed -n 's/^tier=//p' "$out")"
keys=$(grep -cE '^[a-z_]+=' "$out" || true)
total=$(wc -l < "$out" | tr -d ' ')
[ "$t" = "full" ] && ok "defect4: newline-bearing path fails CLOSED to full" \
                  || bad "defect4: newline-bearing path fails CLOSED to full" "full" "$t"
# Exact count, not keys == total: a LOWERCASE forged key matches `^[a-z_]+=` and
# is counted as well-formed, so the equality alone is blind to it.
if [ "$keys" != "$total" ] || [ "$total" != "$EXPECTED_KEYS" ]; then
  bad "defect4: no extra lines injected into GITHUB_OUTPUT" "$EXPECTED_KEYS well-formed lines" "$keys keys / $total lines"
else ok "defect4: no extra lines injected into GITHUB_OUTPUT"; fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
