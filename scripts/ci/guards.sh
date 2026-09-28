#!/usr/bin/env bash
# CI guards (P8, docs/superpowers/specs/2026-09-26-pipeline-design.md §10).
#
#   bash scripts/ci/guards.sh source   # before the build: source-tree rules
#   bash scripts/ci/guards.sh bundle   # after `npm run build`: the shipped HR bundle
#
# Run from the repo root. Exit 0 = every guard passed, 1 = at least one violation (or a
# guard that could not run). CI calls this exact file, so a planted violation can be
# proven to fail locally with the same code: copy the scanned directories plus this
# script into a scratch tree, plant the violation there, and run the copy.
#
# ⚠️ Each guard distinguishes three grep outcomes and never lets "grep errored" pass:
#   exit 0 → a match → violation;  exit 1 → no match → ok;  exit ≥2 → the guard FAILS.
# A REQUIRED path that is missing also fails (a renamed directory must not silently turn
# a guard into a scan of nothing). OPTIONAL paths are directories a later PR creates
# (services/pipeline, shared/src/pipeline); until they exist the guard notes the skip.
#
# Portable to GNU grep (CI) and BSD grep (macOS). No `set -e`: grep's exit 1 is the
# success case here.
set -uo pipefail

# Always scan from the repo root: the db.ts exclusion below matches repo-relative paths.
cd "$(dirname "$0")/../.." || exit 2

mode="${1:-}"
failures=0

# check <name> <hint> <ERE pattern> <required|optional> <exclude-path-ERE or ""> <paths...>
check() {
  local name="$1" hint="$2" pattern="$3" need="$4" exclude="$5"
  shift 5
  local paths=() p
  for p in "$@"; do
    if [ -e "$p" ]; then
      paths+=("$p")
    elif [ "$need" = "required" ]; then
      echo "::error::[$name] expected path '$p' does not exist — the guard would scan nothing. Update scripts/ci/guards.sh."
      failures=$((failures + 1))
    else
      echo "[$name] '$p' does not exist yet — skipped"
    fi
  done
  if [ "${#paths[@]}" -eq 0 ]; then
    return
  fi

  local out rc
  # -o with up to 80 chars of context keeps minified bundle lines readable; `.{0,80}`
  # is always satisfiable, so it never changes WHETHER the pattern matches.
  # -I skips binary files (a "match" inside image bytes is noise, not code).
  out=$(grep -rEnoI -- ".{0,80}(${pattern}).{0,80}" "${paths[@]}")
  rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "::error::[$name] grep failed (exit $rc) — treating as a failure, not a pass."
    failures=$((failures + 1))
    return
  fi
  if [ "$rc" -eq 0 ] && [ -n "$exclude" ]; then
    out=$(printf '%s\n' "$out" | grep -Ev -- "$exclude")
  fi
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
    echo "::error::[$name] $hint"
    printf '%s\n' "$out"
    failures=$((failures + 1))
  else
    echo "ok: [$name] ${paths[*]}"
  fi
}

# Regex lookbehind `(?<=` / `(?<!` throws a SyntaxError at PARSE time on older iOS Safari
# (< 16.4), which takes the whole page down, not just the regex. `(?<name>` named groups
# are not matched.
LOOKBEHIND='\(\?<[=!]'

case "$mode" in
  source)
    check "no-lookbehind-src" \
      "Regex lookbehind is banned in code that ships to browsers/phones (older iOS Safari throws at parse time). Rewrite without (?<= / (?<!." \
      "$LOOKBEHIND" required "" \
      apps/hr/src packages/shared/src mobile/src

    # Pipeline code must use ONLY pipelineDb (its own 3-connection pool). A global
    # `prisma` call inside a pipeline transaction breaks the pool arithmetic and deadlocks
    # at connection_limit=1 (spec §3.2 rule 1, review item 38). Any module reference —
    # import, export-from, require or dynamic import, either quote style — to
    # @dashmani/db or @prisma/client counts, except in services/pipeline/db.ts itself.
    check "pipeline-db-import" \
      "services/pipeline/** may import pipelineDb (and any Prisma types) only from ./db — never @dashmani/db or @prisma/client directly." \
      "[\"'](@dashmani/db|@prisma/client)[\"'/]" optional \
      '^apps/api/src/services/pipeline/db\.ts:' \
      apps/api/src/services/pipeline

    # Ranks are ordered byte-wise (COLLATE "C" in SQL, compareRank's plain < and > in
    # JS). localeCompare orders them differently and silently scrambles the board.
    check "no-localecompare-rank" \
      "localeCompare is banned in pipeline code — compare ranks with compareRank from packages/shared/src/pipeline/rank.ts." \
      "localeCompare" optional "" \
      apps/api/src/services/pipeline packages/shared/src/pipeline
    ;;
  bundle)
    # The source scan cannot see third-party code (dnd-kit, markdown renderers, vendored
    # libraries), so scan what actually ships. Requires `npm run build` first.
    check "no-lookbehind-hr-bundle" \
      "The built HR bundle contains regex lookbehind (older iOS Safari throws at parse time). Find the dependency or source file that introduced it." \
      "$LOOKBEHIND" required "" \
      apps/hr/.next/static/chunks
    ;;
  *)
    echo "usage: bash scripts/ci/guards.sh <source|bundle>" >&2
    exit 2
    ;;
esac

if [ "$failures" -gt 0 ]; then
  echo "guards ($mode): $failures failure(s)"
  exit 1
fi
echo "guards ($mode): all passed"
