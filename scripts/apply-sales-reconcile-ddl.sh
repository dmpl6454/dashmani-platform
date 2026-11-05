#!/bin/bash
# One-shot pre-merge step for the reconcile-page PR (Form 26AS, GSTR-1, client balance
# confirmations — spec-reconcile.md PR 5). Run it ON the production box as root, BEFORE merging
# the PR, after rebasing it on main:
#
#   cd /opt/dashmani-platform && git fetch origin feat/sales-reconcile
#   git show origin/feat/sales-reconcile:scripts/apply-sales-reconcile-ddl.sh > /root/apply-sales-reconcile-ddl.sh
#   bash /root/apply-sales-reconcile-ddl.sh
#
# Same shape as scripts/apply-sales-recurring-ddl.sh (the new-table + ALTER variant):
#   1. extracts scripts/sales-reconcile-ddl.sql and schema.prisma from the PR branch with `git show`
#      (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env and refuses any other role;
#   3. read-only pre-flight: clients / client_billing_profiles exist and are owned by that role,
#      nothing holds a lock older than 5 s on them; reports whether client_billing_profiles.tan
#      already exists; any of the 7 new tables already present has exactly the DDL's columns;
#   4. schema-only backup;
#   5. applies the DDL — one transaction, lock_timeout 3s, ADD COLUMN / CREATE … IF NOT EXISTS;
#   6. verifies the tan column + client_billing_profiles_tan_key, the owner of the 7 tables, their
#      index counts (incl. pkey) and the 5 foreign keys;
#   7. drift check (inspect only): no statement on the reconcile tables or client_billing_profiles
#      may remain between the database and the PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run. Exit 0 = every
# step passed; 1 = a step failed (the output says whether the DDL was applied); 2 = applied and
# verified but the drift check could not run.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-feat/sales-reconcile}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
WORK="/root/sales-reconcile-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/sales-reconcile-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10
TABLES="sales_tds_deductors sales_tds_uploads sales_tds_entries sales_gstr1_uploads sales_gstr1_docs sales_balance_confirmations sales_confirmation_files"
# expected pg_indexes count per table, pkey included (spec-reconcile §3.5)
expected_indexes() {
  case "$1" in
    sales_tds_deductors) echo 3 ;; sales_tds_uploads) echo 3 ;; sales_tds_entries) echo 2 ;;
    sales_gstr1_uploads) echo 3 ;; sales_gstr1_docs) echo 3 ;; sales_balance_confirmations) echo 4 ;;
    sales_confirmation_files) echo 2 ;; *) echo 0 ;;
  esac
}
FKS="'sales_tds_deductors_client_id_fkey','sales_tds_entries_upload_id_fkey','sales_gstr1_docs_upload_id_fkey','sales_balance_confirmations_client_id_fkey','sales_confirmation_files_confirmation_id_fkey'"

APPLIED=0
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied (it committed in step 5) and is safe to leave in place — it is additive and the running API ignores it."
    echo "Do NOT merge the reconcile PR yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/sales-reconcile-ddl.sql" > "$WORK/sales-reconcile-ddl.sql" || fail "scripts/sales-reconcile-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" || fail "schema.prisma is not on origin/$BRANCH"
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $(git rev-parse "origin/$BRANCH")"
echo "    DDL: $(wc -l < "$WORK/sales-reconcile-ddl.sql") lines, sha256 $(sha256sum "$WORK/sales-reconcile-ddl.sql" | cut -c1-12)"

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
for t in clients client_billing_profiles; do
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ -n "$OWNER" ] || fail "table $t does not exist"
  [ "$OWNER" = "$ROLE" ] || fail "table $t is owned by '$OWNER', not '$ROLE'"
done
echo "    clients, client_billing_profiles: present, owned by $ROLE"
TAN_BEFORE=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='client_billing_profiles' AND column_name='tan'")
echo "    client_billing_profiles.tan: $([ "$TAN_BEFORE" = "1" ] && echo present || echo "absent (will be added)")"
for t in $TABLES; do
  PRESENT=$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  if [ "$PRESENT" = "1" ]; then
    EXP=$(grep -A40 "CREATE TABLE IF NOT EXISTS \"$t\"" "$WORK/sales-reconcile-ddl.sql" | sed -n '2,/^);/p' | grep -oE '^\s*"[a-z_0-9]+"' | tr -d ' "' | LC_ALL=C sort | tr '\n' ',' | sed 's/,$//')
    HAVE=$(q "SELECT string_agg(column_name::text, ',' ORDER BY column_name::text COLLATE \"C\") FROM information_schema.columns WHERE table_schema='public' AND table_name='$t'")
    [ "$HAVE" = "$EXP" ] || fail "$t exists with different columns ($HAVE) vs the DDL ($EXP)"
    echo "    $t: present, columns match the DDL"
  else
    echo "    $t: absent (will be created)"
  fi
done
LONG=$(q "SELECT a.pid || ' ' || coalesce(a.application_name,'') || ' ' || date_trunc('second', now() - a.xact_start)
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.relation IN ('public.clients'::regclass, 'public.client_billing_profiles'::regclass)
    AND a.pid <> pg_backend_pid() AND a.xact_start < now() - interval '5 seconds'")
[ -z "$LONG" ] || { echo "$LONG" | sed 's/^/      /'; fail "a transaction older than 5 s holds a lock on clients / client_billing_profiles; wait a minute and re-run"; }
echo "    no long transaction on clients / client_billing_profiles"

echo "==> 4. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
[ $? -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed — wait a minute and re-run"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=sales-reconcile-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/sales-reconcile-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  grep -q "lock timeout" "$WORK/apply.log" && echo "    A writer held clients / client_billing_profiles for more than 3 s; the transaction rolled back. Wait a few minutes and run this again (once)."
  fail "DDL did not apply — see $WORK/apply.log (one transaction, so it rolled back)"
fi
APPLIED=1

echo "==> 6. Verify"
TAN=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='client_billing_profiles' AND column_name='tan'")
echo "    client_billing_profiles.tan: $TAN (expected 1)"; [ "$TAN" = "1" ] || fail "client_billing_profiles.tan missing"
TAN_IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='client_billing_profiles_tan_key'")
echo "    client_billing_profiles_tan_key: $TAN_IDX (expected 1)"; [ "$TAN_IDX" = "1" ] || fail "client_billing_profiles_tan_key missing"
for t in $TABLES; do
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ "$OWNER" = "$ROLE" ] || fail "$t is not owned by $ROLE (owner: '$OWNER')"
  IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='$t'")
  WANT=$(expected_indexes "$t")
  echo "    $t: owner $OWNER, indexes $IDX (expected $WANT)"
  [ "$IDX" = "$WANT" ] || fail "expected $WANT indexes on $t"
done
FK=$(q "SELECT count(*) FROM pg_constraint WHERE conname IN ($FKS)")
echo "    foreign keys: $FK (expected 5)"; [ "$FK" = "5" ] || fail "expected 5 reconcile foreign keys"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff \
      --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  echo "    $(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true) drift line(s) in $WORK/drift.sql (known hand-built indexes are expected):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'sales_tds_|sales_gstr1_|sales_balance_confirmations|sales_confirmation_files|client_billing_profiles' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on the reconcile tables / client_billing_profiles — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no reconcile / client_billing_profiles drift"; DRIFT_RAN=1
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
echo "Safe to merge the reconcile PR while its head is still $HEADSHORT; re-run this (no-op) if commits land after."
echo "Until the PR is merged and deployed, do NOT run 'prisma db push' on prod: main's schema would drop the 7 reconcile tables and client_billing_profiles.tan."
