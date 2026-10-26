#!/bin/bash
# One-shot pre-merge step for the sales billing follow-ups PR (void a payment, refunds, proforma →
# tax invoice). Run it ON the production box as root, BEFORE merging the PR:
#
#   cd /opt/dashmani-platform && git fetch origin feat/billing-remaining
#   git show origin/feat/billing-remaining:scripts/apply-sales-billing-ddl.sh > /root/apply-sales-billing-ddl.sh
#   bash /root/apply-sales-billing-ddl.sh
#
# Same shape as scripts/apply-sales-ddl.sh (the runbook's steps, nothing more):
#   1. extracts scripts/sales-billing-ddl.sql and schema.prisma from the PR branch with `git show`
#      (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env and refuses any other role;
#   3. read-only pre-flight: sales_invoices / sales_payments / clients exist and are owned by that
#      role, nothing holds a long lock on them, and a sales_refunds table already there has
#      exactly the DDL's columns;
#   4. schema-only backup;
#   5. applies the DDL — one transaction, lock_timeout 3s, ADD COLUMN / CREATE … IF NOT EXISTS;
#   6. verifies the 5 new columns, the sales_refunds table, its 4 indexes, the new invoice index
#      and the 3 new foreign keys;
#   7. drift check (inspect only): no sales_* statement may remain between the database and the
#      PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run. Exit 0 = every
# step passed; 1 = a step failed (the output says whether the DDL was applied); 2 = applied and
# verified but the drift check could not run.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-feat/billing-remaining}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
WORK="/root/sales-billing-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/sales-billing-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10

APPLIED=0
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied (it committed in step 5) and is safe to leave in place — it is additive and the running API ignores it."
    echo "Do NOT merge the billing PR yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/sales-billing-ddl.sql" > "$WORK/sales-billing-ddl.sql" || fail "scripts/sales-billing-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" || fail "schema.prisma is not on origin/$BRANCH"
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $(git rev-parse "origin/$BRANCH")"
echo "    DDL: $(wc -l < "$WORK/sales-billing-ddl.sql") lines, sha256 $(sha256sum "$WORK/sales-billing-ddl.sql" | cut -c1-12)"

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
for t in sales_invoices sales_payments clients; do
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ -n "$OWNER" ] || fail "table $t does not exist (apply scripts/apply-sales-ddl.sh first)"
  [ "$OWNER" = "$ROLE" ] || fail "table $t is owned by '$OWNER', not '$ROLE'"
done
echo "    sales_invoices, sales_payments, clients: present, owned by $ROLE"
COLS_BEFORE=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='sales_payments' AND column_name IN ('status','void_reason','voided_at','voided_by_id')) OR (table_name='sales_invoices' AND column_name='converted_from_id'))")
REFUNDS_BEFORE=$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='sales_refunds'")
echo "    state: $COLS_BEFORE of 5 new columns, sales_refunds table $([ "$REFUNDS_BEFORE" = "1" ] && echo present || echo absent)"
if [ "$REFUNDS_BEFORE" = "1" ]; then
  EXP=$(grep -A40 'CREATE TABLE IF NOT EXISTS "sales_refunds"' "$WORK/sales-billing-ddl.sql" | sed -n '2,/^);/p' | grep -oE '^\s*"[a-z_0-9]+"' | tr -d ' "' | sort | tr '\n' ',' | sed 's/,$//')
  HAVE=$(q "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_refunds'")
  [ "$HAVE" = "$EXP" ] || fail "sales_refunds exists with different columns ($HAVE) vs the DDL ($EXP)"
fi
LONG=$(q "SELECT a.pid || ' ' || coalesce(a.application_name,'') || ' ' || date_trunc('second', now() - a.xact_start)
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.relation IN ('public.sales_invoices'::regclass, 'public.sales_payments'::regclass)
    AND a.pid <> pg_backend_pid() AND a.xact_start < now() - interval '5 seconds'")
[ -z "$LONG" ] || { echo "$LONG" | sed 's/^/      /'; fail "a transaction older than 5 s holds a lock on sales_invoices / sales_payments; wait a minute and re-run"; }
echo "    no long transaction on sales_invoices / sales_payments"

echo "==> 4. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
[ $? -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed — wait a minute and re-run"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=sales-billing-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/sales-billing-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  grep -q "lock timeout" "$WORK/apply.log" && echo "    A writer held a table for more than 3 s; the transaction rolled back. Wait ~10 minutes and run this again (once)."
  fail "DDL did not apply — see $WORK/apply.log (one transaction, so it rolled back)"
fi
APPLIED=1

echo "==> 6. Verify"
COLS=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='sales_payments' AND column_name IN ('status','void_reason','voided_at','voided_by_id')) OR (table_name='sales_invoices' AND column_name='converted_from_id'))")
echo "    new columns: $COLS (expected 5)"; [ "$COLS" = "5" ] || fail "expected 5 new columns"
DEFAULTED=$(q "SELECT count(*) FROM sales_payments WHERE status IS DISTINCT FROM 'recorded'")
echo "    existing payments not 'recorded': $DEFAULTED (expected 0)"; [ "$DEFAULTED" = "0" ] || fail "existing payments did not take the 'recorded' default"
OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='sales_refunds'")
echo "    sales_refunds owner: $OWNER"; [ "$OWNER" = "$ROLE" ] || fail "sales_refunds is not owned by $ROLE"
IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='sales_refunds'")
echo "    sales_refunds indexes (incl. pkey): $IDX (expected 4)"; [ "$IDX" = "4" ] || fail "expected 4 indexes on sales_refunds"
INV_IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='sales_invoices_converted_from_id_idx'")
[ "$INV_IDX" = "1" ] || fail "sales_invoices_converted_from_id_idx missing"
FK=$(q "SELECT count(*) FROM pg_constraint WHERE conname IN ('sales_invoices_converted_from_id_fkey','sales_refunds_payment_id_fkey','sales_refunds_client_id_fkey')")
echo "    new foreign keys: $FK (expected 3)"; [ "$FK" = "3" ] || fail "expected 3 new foreign keys"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff \
      --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  echo "    $(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true) drift line(s) in $WORK/drift.sql (known hand-built indexes are expected):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'sales_|client_billing_profiles' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on a sales object — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no sales_* drift"; DRIFT_RAN=1
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
echo "Safe to merge the billing PR while its head is still $HEADSHORT; re-run this (no-op) if commits land after."
echo "Until the PR is merged and deployed, do NOT run 'prisma db push' on prod: main's schema would drop sales_refunds and the new columns."
