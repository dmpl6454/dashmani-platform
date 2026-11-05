#!/bin/bash
# One-shot pre-merge step for the accounts-page PR (filed balance sheet + P&L). Run it ON the
# production box as root, BEFORE merging the PR, after rebasing it on main:
#
#   cd /opt/dashmani-platform && git fetch origin feat/sales-accounts
#   git show origin/feat/sales-accounts:scripts/apply-sales-accounts-ddl.sh > /root/apply-sales-accounts-ddl.sh
#   bash /root/apply-sales-accounts-ddl.sh
#
# Same shape as scripts/apply-sales-recurring-ddl.sh (the new-table variant):
#   1. extracts scripts/sales-accounts-ddl.sql and schema.prisma from the PR branch with `git show`
#      (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env and refuses any other role;
#   3. read-only pre-flight on the two NEW tables only (no existing table is altered or
#      referenced): if finance_filed_years / finance_filed_files already exist, their column sets
#      must equal the DDL's;
#   4. schema-only backup;
#   5. applies the DDL — one transaction, lock_timeout 3s, CREATE … IF NOT EXISTS;
#   6. verifies owner on both tables, 21 + 9 columns, 2 indexes each (pkey + unique), and the
#      foreign key finance_filed_files_filed_year_id_fkey;
#   7. drift check (inspect only): no finance_filed_years / finance_filed_files statement may
#      remain between the database and the PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run. Exit 0 = every
# step passed; 1 = a step failed (the output says whether the DDL was applied); 2 = applied and
# verified but the drift check could not run.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-feat/sales-accounts}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
WORK="/root/sales-accounts-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/sales-accounts-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10
TABLES="finance_filed_years finance_filed_files"

APPLIED=0
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied (it committed in step 5) and is safe to leave in place — it is additive and the running API ignores it."
    echo "Do NOT merge the accounts PR yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/sales-accounts-ddl.sql" > "$WORK/sales-accounts-ddl.sql" || fail "scripts/sales-accounts-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" || fail "schema.prisma is not on origin/$BRANCH"
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $(git rev-parse "origin/$BRANCH")"
echo "    DDL: $(wc -l < "$WORK/sales-accounts-ddl.sql") lines, sha256 $(sha256sum "$WORK/sales-accounts-ddl.sql" | cut -c1-12)"

echo "==> 2. DATABASE_URL (the app role) from apps/api/.env"
DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%\'}"; DBURL="${DBURL#\'}"; DBURL="${DBURL%%\?*}"
[ -n "$DBURL" ] || fail "no DATABASE_URL in $APP_DIR/apps/api/.env"
q() { psql "$DBURL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
ROLE=$(q "SELECT current_user" 2> "$WORK/connect.err") || fail "cannot connect: $(head -c 300 "$WORK/connect.err")"
echo "    connected as: $ROLE  (database $(q "SELECT current_database()"))"
[ "$ROLE" = "$EXPECT_ROLE" ] || fail "connected as '$ROLE', expected '$EXPECT_ROLE'. Never apply as postgres."

echo "==> 3. Pre-flight (read-only; the two new tables only)"
HEALTH_BEFORE=$(health); echo "    API health before: $HEALTH_BEFORE"
for t in $TABLES; do
  PRESENT=$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  if [ "$PRESENT" = "1" ]; then
    EXP=$(grep -A40 "CREATE TABLE IF NOT EXISTS \"$t\"" "$WORK/sales-accounts-ddl.sql" | sed -n '2,/^);/p' | grep -oE '^\s*"[a-z_0-9]+"' | tr -d ' "' | LC_ALL=C sort | tr '\n' ',' | sed 's/,$//')
    HAVE=$(q "SELECT string_agg(column_name::text, ',' ORDER BY column_name::text COLLATE \"C\") FROM information_schema.columns WHERE table_schema='public' AND table_name='$t'")
    [ "$HAVE" = "$EXP" ] || fail "$t exists with different columns ($HAVE) vs the DDL ($EXP)"
    echo "    $t: present, columns match the DDL"
  else
    echo "    $t: absent (will be created)"
  fi
done

echo "==> 4. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
[ $? -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed — wait a minute and re-run"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=sales-accounts-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/sales-accounts-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  grep -q "lock timeout" "$WORK/apply.log" && echo "    Something held a lock for more than 3 s; the transaction rolled back. Wait a few minutes and run this again (once)."
  fail "DDL did not apply — see $WORK/apply.log (one transaction, so it rolled back)"
fi
APPLIED=1

echo "==> 6. Verify"
for t in $TABLES; do
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  echo "    $t owner: $OWNER"; [ "$OWNER" = "$ROLE" ] || fail "$t is not owned by $ROLE"
  IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='$t'")
  echo "    $t indexes (pkey + unique): $IDX (expected 2)"; [ "$IDX" = "2" ] || fail "expected 2 indexes on $t"
done
C1=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='finance_filed_years'")
C2=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='finance_filed_files'")
echo "    columns: finance_filed_years $C1 (expected 21), finance_filed_files $C2 (expected 9)"
[ "$C1" = "21" ] || fail "expected 21 columns on finance_filed_years"
[ "$C2" = "9" ] || fail "expected 9 columns on finance_filed_files"
FK=$(q "SELECT count(*) FROM pg_constraint WHERE conname = 'finance_filed_files_filed_year_id_fkey'")
echo "    foreign key: $FK (expected 1)"; [ "$FK" = "1" ] || fail "finance_filed_files_filed_year_id_fkey missing"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff \
      --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  echo "    $(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true) drift line(s) in $WORK/drift.sql (known hand-built indexes are expected):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'finance_filed_years|finance_filed_files' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on finance_filed_years / finance_filed_files — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no finance_filed_years / finance_filed_files drift"; DRIFT_RAN=1
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
echo "Safe to merge the accounts PR while its head is still $HEADSHORT; re-run this (no-op) if commits land after."
echo "Until the PR is merged and deployed, do NOT run 'prisma db push' on prod: main's schema would drop the two empty finance_filed_* tables."
