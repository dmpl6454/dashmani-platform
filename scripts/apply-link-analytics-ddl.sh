#!/bin/bash
# One-shot pre-merge step for the Link Analytics PR (sales portal /links). Run it ON the production
# box as root, BEFORE merging the PR:
#
#   cd /opt/dashmani-platform && git fetch origin feat/link-analytics
#   git show origin/feat/link-analytics:scripts/apply-link-analytics-ddl.sh > /root/apply-link-analytics-ddl.sh
#   bash /root/apply-link-analytics-ddl.sh
#
# Same shape as scripts/apply-sales-import-ddl.sh:
#   1. extracts scripts/link-analytics-ddl.sql and schema.prisma from the PR branch with `git show`
#      (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env and refuses any other role;
#   3. read-only pre-flight: free disk, and any link_* table already there has exactly the DDL's columns;
#   4. schema-only backup;
#   5. applies the DDL — one transaction, lock_timeout 3s, CREATE … IF NOT EXISTS. It touches NO
#      existing table;
#   6. verifies the 4 tables (owner, index counts) and the 3 foreign keys;
#   7. drift check (inspect only): no link_batches / link_batch_items / link_posts /
#      link_post_snapshots statement may remain between the database and the PR's schema.prisma.
# Restarts nothing. Safe to re-run. Exit 0 = every step passed; 1 = a step failed (the output says
# whether the DDL was applied); 2 = applied and verified but the drift check could not run.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-feat/link-analytics}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
WORK="/root/link-analytics-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/link-analytics-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10
TABLES="link_batches link_batch_items link_posts link_post_snapshots"

APPLIED=0
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied and is safe to leave in place — four new, empty tables the running API ignores."
    echo "Do NOT merge the Link Analytics PR yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/link-analytics-ddl.sql" > "$WORK/link-analytics-ddl.sql" || fail "scripts/link-analytics-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" || fail "schema.prisma is not on origin/$BRANCH"
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $(git rev-parse "origin/$BRANCH")"
echo "    DDL: $(wc -l < "$WORK/link-analytics-ddl.sql") lines, sha256 $(sha256sum "$WORK/link-analytics-ddl.sql" | cut -c1-12)"

echo "==> 2. DATABASE_URL (the app role) from apps/api/.env"
DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%\'}"; DBURL="${DBURL#\'}"; DBURL="${DBURL%%\?*}"
[ -n "$DBURL" ] || fail "no DATABASE_URL in $APP_DIR/apps/api/.env"
q() { psql "$DBURL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
ROLE=$(q "SELECT current_user" 2> "$WORK/connect.err") || fail "cannot connect: $(head -c 300 "$WORK/connect.err")"
echo "    connected as: $ROLE  (database $(q "SELECT current_database()"))"
[ "$ROLE" = "$EXPECT_ROLE" ] || fail "connected as '$ROLE', expected '$EXPECT_ROLE'. Never apply as postgres."

echo "==> 3. Pre-flight (read-only)"
HEALTH_BEFORE=$(health); echo "    API health before: $HEALTH_BEFORE"
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "    free disk: ${FREE_GB} GB"; [ "${FREE_GB:-0}" -ge 3 ] || fail "less than 3 GB free on / — free space first (see the 2026-10-25 disk-full incident)"
for t in $TABLES; do
  PRESENT=$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  echo "    $t: $([ "$PRESENT" = "1" ] && echo present || echo absent)"
  if [ "$PRESENT" = "1" ]; then
    EXP=$(grep -A60 "CREATE TABLE IF NOT EXISTS \"$t\"" "$WORK/link-analytics-ddl.sql" | sed -n '2,/^);/p' | grep -oE '^\s*"[a-z_0-9]+"' | tr -d ' "' | sort | tr '\n' ',' | sed 's/,$//')
    HAVE=$(q "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='$t'")
    [ "$HAVE" = "$EXP" ] || fail "$t exists with different columns ($HAVE) vs the DDL ($EXP)"
  fi
done

echo "==> 4. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
[ $? -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed — wait a minute and re-run"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=link-analytics-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/link-analytics-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
[ "$DDL_EXIT" -eq 0 ] || fail "DDL did not apply — see $WORK/apply.log (one transaction, so it rolled back)"
APPLIED=1

echo "==> 6. Verify"
check_idx() { # table expected-count
  local OWNER IDX
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$1'")
  [ "$OWNER" = "$ROLE" ] || fail "$1 is not owned by $ROLE (owner: '$OWNER')"
  IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='$1'")
  echo "    $1: owner $OWNER, indexes (incl. pkey) $IDX (expected $2)"; [ "$IDX" = "$2" ] || fail "expected $2 indexes on $1"
}
check_idx link_batches 3
check_idx link_batch_items 3
check_idx link_posts 3
check_idx link_post_snapshots 3
FK=$(q "SELECT count(*) FROM pg_constraint WHERE conname IN ('link_batch_items_batch_id_fkey','link_batch_items_post_id_fkey','link_post_snapshots_post_id_fkey')")
echo "    foreign keys: $FK (expected 3)"; [ "$FK" = "3" ] || fail "expected 3 foreign keys"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff \
      --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  echo "    $(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true) drift line(s) in $WORK/drift.sql (known hand-built indexes are expected):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE '"link_(batches|batch_items|posts|post_snapshots)"' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on the link_* tables — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no link_* drift"; DRIFT_RAN=1
else
  echo "    WARNING: could not run prisma migrate diff: $(head -c 300 "$WORK/drift.err" 2>/dev/null)"
fi

HEALTH_AFTER=$(health); echo "    API health after: $HEALTH_AFTER (before: $HEALTH_BEFORE)"
echo
if [ "$DRIFT_RAN" != "1" ]; then
  echo "APPLIED AND VERIFIED (steps 5-6), but the drift check did not run. Logs in $WORK."
  exit 2
fi
echo "ALL DONE — DDL applied as $ROLE and verified. Logs in $WORK."
echo "Safe to merge the Link Analytics PR while its head is still $HEADSHORT; re-run this (no-op) if commits land after."
echo "Until the PR is merged and deployed, do NOT run 'prisma db push' on prod: main's schema would drop the four empty link_* tables."
