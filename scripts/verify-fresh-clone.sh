#!/usr/bin/env bash
#
# Verify that a fresh clone of this repository is safe to publish and usable.
#
# It clones from the remote, not from the working tree, so anything uncommitted, ignored
# or living only on the author's machine shows up as a failure instead of passing silently.
#
# Usage: ./scripts/verify-fresh-clone.sh [remote-url]
#
# Private terms: words that must never be published are read from an untracked list, so
# that publishing this check does not publish the list. Put one extended regular
# expression per line in scripts/private-terms.local (ignored by *.local), or point
# PROTOCOL_CHAOS_PRIVATE_TERMS at another file. Matching is case-insensitive; blank lines
# and # comments are ignored. Without a list the check fails: this script guards releases.
#
# Tests: the reference server's storage tests, then the conformance tests against it. Set
# PROTOCOL_CHAOS_TEST_SERVER to a stdio command containing {tmp} to test another server.

set -euo pipefail

REMOTE="${1:-https://github.com/chaos-xxl/protocol-chaos.git}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERMS_FILE="${PROTOCOL_CHAOS_PRIVATE_TERMS:-$SCRIPT_DIR/private-terms.local}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() { printf '\n[FAIL] %s\n' "$1" >&2; exit 1; }
step() { printf '\n=== %s ===\n' "$1"; }

step "Node version"
node -v
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || fail "Node 20 or later is required"

step "Clone from remote"
git clone -q "$REMOTE" "$WORKDIR/repo" || fail "clone failed"
cd "$WORKDIR/repo"
printf 'tracked files: %s, commits: %s\n' "$(git ls-files | wc -l | tr -d ' ')" "$(git rev-list --all | wc -l | tr -d ' ')"

step "Files a newcomer needs are present"
for f in LICENSE NOTICE README.md docs/README.zh-CN.md PROTOCOL.md CHANGELOG.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md docs/agent-guide.md conformance/README.md conformance/run.mjs server/README.md server/index.mjs package.json package-lock.json; do
  test -f "$f" || fail "missing $f"
  printf '  ok  %s\n' "$f"
done

step "Nothing private leaked into the clone"
if git ls-files | grep -qE '\.(db|db-wal|db-shm|local)$'; then
  fail "a database or *.local file is tracked"
fi
printf '  ok  no database or *.local files\n'

# This script spells out the path pattern, so it is excluded from its own scan.
if git grep -qE "/Users/|/home/[a-z]" $(git rev-list --all) -- . ':!scripts/verify-fresh-clone.sh' 2>/dev/null; then
  fail "absolute local paths found in history"
fi
printf '  ok  no absolute local paths\n'

[ -f "$TERMS_FILE" ] || fail "no private term list at $TERMS_FILE"
{ grep -vE '^[[:space:]]*(#|$)' "$TERMS_FILE" || true; } > "$WORKDIR/private-terms"
[ -s "$WORKDIR/private-terms" ] || fail "the private term list is empty"
patterns="$(wc -l < "$WORKDIR/private-terms" | tr -d ' ')"
# Paths only, never the matching text: this output may be pasted elsewhere.
hits="$( { git grep -liE -f "$WORKDIR/private-terms" $(git rev-list --all) -- . 2>/dev/null || true; } \
  | sed 's/^[0-9a-f]*://' | sort -u | tr '\n' ' ')"
[ -z "$hits" ] || fail "private terms found in: $hits"
if git log --all --format='%an %ae%n%s%n%b' | grep -qiE -f "$WORKDIR/private-terms"; then
  fail "a private term is in a commit message or author"
fi
printf '  ok  no private terms in files, history, commit messages or authors (%s patterns)\n' "$patterns"
printf '  ok  authors: %s\n' "$(git log --all --format='%ae' | sort -u | tr '\n' ' ')"

step "Links between documents resolve"
broken=0
while IFS= read -r file; do
  dir="$(dirname "$file")"
  while IFS= read -r link; do
    target="${link%%#*}"
    [ -n "$target" ] || continue
    case "$target" in http://*|https://*|mailto:*) continue ;; esac
    if [ ! -e "$dir/$target" ]; then
      printf '  broken  %s -> %s\n' "$file" "$link"
      broken=1
    fi
  done < <(grep -oE '\]\([^)]+\)' "$file" | sed -E 's/^\]\((.*)\)$/\1/')
done < <(git ls-files '*.md')
[ "$broken" = "0" ] || fail "broken links"
printf '  ok  every relative link resolves\n'

step "Install"
npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 || fail "npm ci failed"
printf '  ok  dependencies installed\n'

step "The code parses and the suite starts"
for f in conformance/*.mjs conformance/tests/*.mjs server/*.mjs server/test/*.mjs; do
  node --check "$f" || fail "$f does not parse"
done
set +e
usage="$(node conformance/run.mjs 2>&1)"
code=$?
set -e
[ "$code" = "2" ] && printf '%s' "$usage" | grep -q -- '--stdio' || fail "run.mjs did not start: $usage"
printf '  ok  run.mjs starts and asks for a server\n'

step "Reference server: storage and HTTP tests"
node --test server/test/store.test.mjs server/test/remote.test.mjs >"$WORKDIR/store.log" 2>&1 || { tail -30 "$WORKDIR/store.log"; fail "storage or HTTP tests failed"; }
grep -E '^ℹ (pass|fail)' "$WORKDIR/store.log" | sed 's/^/  /'

# The reference server by default; PROTOCOL_CHAOS_TEST_SERVER names another one.
server="${PROTOCOL_CHAOS_TEST_SERVER:-node server/index.mjs --owner-tools --data {tmp}}"
step "Conformance against: $server"
node conformance/run.mjs --stdio "$server" | tail -6 || fail "conformance tests failed"

printf '\nAll checks passed for %s.\n' "$REMOTE"
