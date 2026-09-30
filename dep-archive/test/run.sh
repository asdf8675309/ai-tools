#!/usr/bin/env bash
# Hermetic tests for bin/dep-archive: a fake repo, fake node and npm, no network,
# no real install. Exits non-zero on any failure or if the case count is wrong.
set -uo pipefail

EXPECTED=43
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tool="$here/bin/dep-archive"
refresh="$here/contrib/dep-archive-refresh.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/dep-archive-test.XXXXXX")"
T="$(cd "$T" && pwd -P)"
trap 'chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"' EXIT

pass=0 fail=0 ran=0
check() {
  local desc="$1"; shift
  ran=$((ran + 1))
  if "$@"; then pass=$((pass + 1)); echo "ok   $ran $desc"
  else fail=$((fail + 1)); echo "FAIL $ran $desc"
  fi
}

# --- shims --------------------------------------------------------------------
shims="$T/shims"; mkdir -p "$shims"
cat > "$shims/node" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = -v ] && { echo "${FAKE_NODE_VERSION:-v26.0.0}"; exit 0; }
exit 0
EOF
# Fake npm: `ci` writes a tree with a nested node_modules and many files so the
# tar listing is long enough to trip a grep -q SIGPIPE, then stamps old mtimes.
cat > "$shims/npm" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -v) echo "${FAKE_NPM_VERSION:-11.0.0}"; exit 0 ;;
  ci)
    echo x >> "${FAKE_NPM_LOG:?}"
    [ -n "${FAKE_NPM_FAIL:-}" ] && exit 1
    rm -rf node_modules apps/a/node_modules
    mkdir -p node_modules/dep apps/a/node_modules/inner
    echo dep > node_modules/dep/index.js
    echo inner > apps/a/node_modules/inner/index.js
    i=0
    while [ $i -lt 1500 ]; do
      : > "node_modules/dep/file-with-a-long-name-to-fill-the-pipe-buffer-quickly-$i.js"
      : > "apps/a/node_modules/inner/file-with-a-long-name-to-fill-the-pipe-buffer-$i.js"
      i=$((i + 1))
    done
    [ -n "${FAKE_NPM_NO_MARKER:-}" ] || echo '{}' > node_modules/.package-lock.json
    find node_modules apps/a/node_modules -exec touch -t 200001010000 {} +
    exit 0 ;;
esac
exit 0
EOF
# zstd stand-in so the compressor seam is exercised the same way on every host.
cat > "$shims/zstd" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = -dc ] && exec gzip -dc; done
exec gzip -3
EOF
# tar wrapper: can fail extraction (a full disk) or packing on request.
real_tar="$(command -v tar)"
cat > "$shims/tar" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in
    -xf) if [ -n "\${FAKE_TAR_FAIL_EXTRACT:-}" ]; then cat >/dev/null; echo "No space left on device" >&2; exit 1; fi ;;
    -cf) if [ -n "\${FAKE_TAR_FAIL_CREATE:-}" ]; then cat >/dev/null; exit 1; fi ;;
    # macOS bsdtar ignores a closed stdout; GNU tar dies of SIGPIPE. Behave like
    # GNU tar when listing, so the SIGPIPE case means the same on every host.
    -tf) set -o pipefail; "$real_tar" "\$@" | cat; exit ;;
  esac
done
exec "$real_tar" "\$@"
EOF
chmod +x "$shims"/*
export PATH="$shims:$PATH"
export FAKE_NPM_LOG="$T/npm.log"
export HOME="$T/home"; mkdir -p "$HOME"
unset DEP_ARCHIVE_DIR DEP_ARCHIVE_DOT_ROOT DEP_ARCHIVE_ROOT DEP_ARCHIVE_KEEP XDG_CACHE_HOME
export DEP_ARCHIVE_COMPRESSOR=gzip

mkrepo() {
  local r="$1"
  mkdir -p "$r/apps/a" "$r/apps/b/scripts" "$r/apps/c/scripts"
  echo '{"lockfileVersion":3}' > "$r/package-lock.json"
  echo '{"name":"root"}' > "$r/package.json"
  echo '{"name":"a"}' > "$r/apps/a/package.json"
  echo '{"name":"b","scripts":{"postinstall":"node scripts/x.js"}}' > "$r/apps/b/package.json"
  echo 'one' > "$r/apps/b/scripts/x.js"
  echo '{"name":"c","scripts":{"test":"true"}}' > "$r/apps/c/package.json"
  echo 'one' > "$r/apps/c/scripts/y.js"
}

R="$T/repo"; mkrepo "$R"
C="$T/cache"; export DEP_ARCHIVE_DIR="$C"
da() { (cd "$R" && "$tool" "$@"); }
npm_runs() { if [ -f "$FAKE_NPM_LOG" ]; then wc -l < "$FAKE_NPM_LOG" | tr -d ' '; else echo 0; fi; }
key_now() { da key 2>/dev/null; }
archives() { find "$C" -maxdepth 1 -name 'nm-*' | wc -l | tr -d ' '; }

# --- key ------------------------------------------------------------------------
k0="$(key_now)"
is_key() { [[ "$1" =~ ^[0-9a-f]{16}$ ]]; }
check "key is 16 hex characters" is_key "$k0"
check "key is stable" test "$(key_now)" = "$k0"

changed() { local before; before="$(key_now)"; eval "$1"; [ "$(key_now)" != "$before" ]; }
unchanged() { local before; before="$(key_now)"; eval "$1"; [ "$(key_now)" = "$before" ]; }
check "key covers the lockfile" changed "echo 1 >> '$R/package-lock.json'"
check "key covers a nested .npmrc" changed "echo 'x=1' > '$R/apps/a/.npmrc'"
check "key covers a nested package.json" changed "echo '{\"name\":\"a2\"}' > '$R/apps/a/package.json'"
check "key covers scripts/ of a package with postinstall" changed "echo two > '$R/apps/b/scripts/x.js'"
check "key ignores scripts/ of a package without install scripts" unchanged "echo two > '$R/apps/c/scripts/y.js'"
check "key ignores .npmrc inside node_modules" unchanged "mkdir -p '$R/node_modules/q' && echo z > '$R/node_modules/q/.npmrc'"
rm -rf "$R/node_modules"
kn="$(key_now)"
check "key covers node version" test "$(FAKE_NODE_VERSION=v99.0.0 da key)" != "$kn"
check "key covers npm version" test "$(FAKE_NPM_VERSION=99.0.0 da key)" != "$kn"
check "key covers the compressor" test "$(DEP_ARCHIVE_COMPRESSOR=zstd da key)" != "$kn"
check "DEP_ARCHIVE_EXTRA_KEY changes the key" test "$(DEP_ARCHIVE_EXTRA_KEY=arm da key)" != "$kn"
echo cfg > "$R/.yarnrc"
check "DEP_ARCHIVE_CONFIG_NAMES adds config files" test "$(DEP_ARCHIVE_CONFIG_NAMES='.npmrc .yarnrc' da key)" != "$kn"
check "DEP_ARCHIVE_EXTRA_FILES adds files" test "$(DEP_ARCHIVE_EXTRA_FILES=.yarnrc da key)" != "$kn"

# --- ensure / restore -------------------------------------------------------------
da restore > "$T/out" 2>&1; rc=$?
check "restore on a miss exits 1" test "$rc" = 1
da ensure > "$T/out" 2>&1; rc=$?
check "ensure on a miss installs once and exits 0" test "$rc/$(npm_runs)" = "0/1"
check "has finds the built archive" da has
check "the archive is in DEP_ARCHIVE_DIR" test -f "$C/nm-$kn.tar.gz"
check "no temp files left after build" test -z "$(find "$C" -name '.tmp.*')"
rm -rf "$R/node_modules" "$R/apps/a/node_modules"
da ensure > "$T/out" 2>&1; rc=$?
check "ensure on a hit restores without installing" test "$rc/$(npm_runs)" = "0/1"
check "restore brings back nested node_modules" test -f "$R/apps/a/node_modules/inner/index.js"
ref="$T/ref"; touch -t 200101010000 "$ref"
check "restore touches node_modules/.package-lock.json" test "$R/node_modules/.package-lock.json" -nt "$ref"
echo stale > "$R/node_modules/stale-file"
da restore > /dev/null 2>&1
check "restore replaces the existing tree" test ! -e "$R/node_modules/stale-file"

# --- verify ---------------------------------------------------------------------
rm -f "$C"/.ok-*
da verify > "$T/out" 2>&1; rc=$?
check "verify accepts a good archive with a long listing" test "$rc" = 0
# Sabotage arm: the same script with grep -q must fail, or the case above proves nothing.
# The archive is packed by hand with the marker first, so the listing after it is
# far longer than a pipe buffer whatever order find returns on this filesystem.
sab="$T/sabotaged"; sed 's/grep -x "/grep -qx "/' "$tool" > "$sab"; chmod +x "$sab"
cp "$C/nm-$kn.tar.gz" "$T/good.tar.gz"
(cd "$R" && tar -cf - ./node_modules/.package-lock.json ./node_modules/dep ./apps/a/node_modules | gzip -3 > "$C/nm-$kn.tar.gz")
rm -f "$C"/.ok-*
(cd "$R" && "$tool" verify) > /dev/null 2>&1; rc1=$?
rm -f "$C"/.ok-*
(cd "$R" && "$sab" verify) > /dev/null 2>&1; rc=$?
check "verify accepts a marker-first archive (no SIGPIPE false negative)" test "$rc1" = 0
check "sabotage: grep -q in the verify pipeline rejects that archive" test "$rc" = 1
cp "$T/good.tar.gz" "$C/nm-$kn.tar.gz"

printf 'not an archive' > "$C/nm-$kn.tar.gz"; rm -f "$C"/.ok-*
da verify > /dev/null 2>&1; rc=$?
check "verify rejects and discards a corrupt archive" test "$rc/$(test -e "$C/nm-$kn.tar.gz" && echo kept || echo gone)" = "1/gone"

printf 'not an archive' > "$C/nm-$kn.tar.gz"
da restore > /dev/null 2>&1; rc=$?
check "restore discards an unreadable archive" test "$rc/$(test -e "$C/nm-$kn.tar.gz" && echo kept || echo gone)" = "1/gone"

cp "$T/good.tar.gz" "$C/nm-$kn.tar.gz"
FAKE_TAR_FAIL_EXTRACT=1 da restore > "$T/out" 2>&1; rc=$?
check "extraction failure keeps a readable archive (full disk)" test "$rc/$(test -e "$C/nm-$kn.tar.gz" && echo kept || echo gone)" = "1/kept"
check "extraction failure leaves no partial tree" test ! -e "$R/node_modules"

# --- build failures and atomic write ---------------------------------------------
rm -f "$C"/nm-*
FAKE_NPM_FAIL=1 da build > /dev/null 2>&1; rc=$?
check "failed install exits 4 and writes no archive" test "$rc/$(archives)" = "4/0"
FAKE_TAR_FAIL_CREATE=1 da build > /dev/null 2>&1; rc=$?
check "failed pack exits 4, no archive, no temp file" test "$rc/$(archives)/$(find "$C" -name '.tmp.*' | wc -l | tr -d ' ')" = "4/0/0"
FAKE_NPM_NO_MARKER=1 da build > /dev/null 2>&1; rc=$?
check "install without the completion marker is not archived" test "$rc/$(archives)" = "4/0"

# --- symlink refusal ---------------------------------------------------------------
rm -rf "$R/node_modules"; mkdir -p "$T/other/node_modules"; echo keep > "$T/other/node_modules/keep"
ln -s "$T/other/node_modules" "$R/node_modules"
da ensure > /dev/null 2>&1; rc=$?
check "symlinked node_modules is refused with exit 3" test "$rc/$(cat "$T/other/node_modules/keep")" = "3/keep"
rm "$R/node_modules"; rm -rf "$R/apps/a/node_modules"; ln -s "$T/other/node_modules" "$R/apps/a/node_modules"
da restore > /dev/null 2>&1; rc=$?
check "nested symlinked node_modules is refused with exit 3" test "$rc" = 3
rm "$R/apps/a/node_modules"

# --- keep count -----------------------------------------------------------------------
rm -rf "$C"; mkdir -p "$C"; echo foreign > "$C/other-archive.tar.gz"
okeep=1
for v in 0 -1 abc; do
  echo "$v" >> "$R/package-lock.json"
  kv="$(key_now)"
  DEP_ARCHIVE_KEEP="$v" da build > /dev/null 2>&1 || okeep=0
  test -f "$C/nm-$kv.tar.gz" || okeep=0
done
check "keep of 0, -1 or text never deletes the new archive" test "$okeep" = 1
echo last >> "$R/package-lock.json"; kl="$(key_now)"
DEP_ARCHIVE_KEEP=1 da build > /dev/null 2>&1
check "keep=1 leaves only the newest archive" test "$(archives)/$(test -f "$C/nm-$kl.tar.gz" && echo y)" = "1/y"
check "pruning leaves files it did not write" test -f "$C/other-archive.tar.gz"

# --- locations and working directory ------------------------------------------------
(unset DEP_ARCHIVE_DIR; cd "$R" && DEP_ARCHIVE_DOT_ROOT="$T/ws" "$tool" build) > /dev/null 2>&1
check "DEP_ARCHIVE_DOT_ROOT puts archives in a dot directory" test -f "$T/ws/.dep-archive/nm-$kl.tar.gz"
mkdir -p "$T/locked"
out="$(cd "$T/locked" && chmod 000 "$T/locked" && DEP_ARCHIVE_ROOT="$R" "$tool" key 2>/dev/null)"; chmod 755 "$T/locked"
check "runs from an unreadable working directory" test "$out" = "$kl"
mkdir -p "$T/gone"
out="$(cd "$T/gone" && rmdir "$T/gone" && "$tool" -C "$R" key 2>/dev/null)"
check "runs from a deleted working directory with -C" test "$out" = "$kl"

# --- flock -------------------------------------------------------------------------
# A real flock when the host has one; otherwise a python fcntl stand-in with the
# same kernel semantics on an inherited file descriptor.
if ! command -v flock >/dev/null 2>&1; then
  cat > "$shims/flock" <<'EOF'
#!/usr/bin/env python3
import fcntl, sys, time
a = sys.argv[1:]
nb = a[0] == "-n"
wait = float(a[1]) if a[0] == "-w" else 0
fd = int(a[-1])
end = time.time() + wait
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); sys.exit(0)
    except BlockingIOError:
        if nb or time.time() >= end: sys.exit(1)
        time.sleep(0.1)
EOF
  chmod +x "$shims/flock"
fi
echo flock >> "$R/package-lock.json"; kf="$(key_now)"
rm -rf "$R/node_modules" "$R/apps/a/node_modules"; : > "$FAKE_NPM_LOG"
mkdir -p "$C"
# Build the archive for this key elsewhere, so the lock holder can publish it.
(cd "$R" && DEP_ARCHIVE_DIR="$T/side" "$tool" build) > /dev/null 2>&1
rm -rf "$R/node_modules" "$R/apps/a/node_modules"; : > "$FAKE_NPM_LOG"
# Hold the build lock like a running build, publish the archive, then release.
(
  exec 9> "$C/.lock-nm-$kf"; flock -n 9 || exit 1
  touch "$T/held"
  /bin/sleep 2
  cp "$T/side/nm-$kf.tar.gz" "$C/"
) &
holder=$!
n=0; while [ ! -e "$T/held" ] && [ $n -lt 100 ]; do /bin/sleep 0.1; n=$((n + 1)); done
DEP_ARCHIVE_LOCK_WAIT=30 "$tool" -C "$R" build > "$T/waiter.out" 2>&1 || true
wait "$holder"
check "a second build for the same key waits on flock, then restores" test "$(grep -c 'archive hit' "$T/waiter.out")/$(npm_runs)" = "1/0"

# --- contrib refresh ---------------------------------------------------------------------
if [ -f "$refresh" ]; then
  src="$T/src"; mkrepo "$src"
  git -C "$src" init -q -b main && git -C "$src" -c user.email=t@t -c user.name=t add -A && git -C "$src" -c user.email=t@t -c user.name=t commit -qm init
  bare="$T/src.git"; git clone -q --bare "$src" "$bare"
  : > "$FAKE_NPM_LOG"
  DEP_ARCHIVE_BIN="$tool" "$refresh" "$bare" main "$T/refresh-work" > "$T/refresh.out" 2>&1; rc=$?
  DEP_ARCHIVE_BIN="$tool" "$refresh" "$bare" main "$T/refresh-work" > "$T/refresh2.out" 2>&1; rc2=$?
  check "refresh builds once, then finds the archive" test "$rc/$rc2/$(npm_runs)/$(grep -c 'archive present' "$T/refresh2.out")" = "0/0/1/1"
else
  check "contrib refresh script exists" false
fi

echo "---"
echo "ran $ran, passed $pass, failed $fail, expected $EXPECTED"
[ "$ran" -eq "$EXPECTED" ] || { echo "case count mismatch: a case did not run or was added without updating EXPECTED" >&2; exit 1; }
[ "$fail" -eq 0 ]
