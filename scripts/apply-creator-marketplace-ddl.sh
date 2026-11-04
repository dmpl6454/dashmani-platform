#!/bin/bash
# One-shot pre-merge step for the creator-marketplace PR (creator portal Phase B/C). Run it ON the
# production box as root, BEFORE merging the PR:
#
#   cd /opt/dashmani-platform && git fetch origin feat/creator-marketplace
#   git show origin/feat/creator-marketplace:scripts/apply-creator-marketplace-ddl.sh > /root/apply-creator-marketplace-ddl.sh
#   bash /root/apply-creator-marketplace-ddl.sh
#
# Same steps as scripts/apply-campaign-overrides-ddl.sh (the runbook in
# docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md), nothing more:
#   1. extracts scripts/creator-marketplace-ddl.sql and schema.prisma from the PR branch with
#      `git show` (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env and refuses any other role;
#   3. read-only pre-flight: both tables exist and are owned by that role, nothing holds a long
#      lock on them;
#   4. schema-only backup;
#   5. applies the DDL — one transaction, lock_timeout 3s, ADD COLUMN / CREATE INDEX IF NOT EXISTS;
#   6. verifies the 7 columns, the index, the creator_page_prices table, its 2 indexes and its FK;
#   7. drift check (inspect only, never applied): no campaign_* statement may remain between the
#      database and the PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run. Exit code 0 =
# every step passed; 1 = a step failed (the output says whether the DDL was applied); 2 = applied
# and verified but the drift check could not run.
#
# APP_DIR / BRANCH / EXPECT_ROLE / HEALTH_URL may be overridden for a local rehearsal only.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-feat/creator-marketplace}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
WORK="/root/creator-marketplace-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/creator-marketplace-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10

APPLIED=0
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied (it committed in step 5) and is safe to leave in place — it is additive and the running API ignores it."
    echo "Do NOT merge the PR yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box (ssh dashmani-prod)"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/creator-marketplace-ddl.sql" > "$WORK/creator-marketplace-ddl.sql" \
  || fail "scripts/creator-marketplace-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" \
  || fail "packages/db/prisma/schema.prisma is not on origin/$BRANCH"
HEAD_SHA=$(git rev-parse "origin/$BRANCH")
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $HEAD_SHA"
echo "    DDL: $(wc -l < "$WORK/creator-marketplace-ddl.sql") lines, sha256 $(sha256sum "$WORK/creator-marketplace-ddl.sql" | cut -c1-12)"

echo "==> 2. DATABASE_URL (the app role) from apps/api/.env"
DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%\'}"; DBURL="${DBURL#\'}"; DBURL="${DBURL%%\?*}"
[ -n "$DBURL" ] || fail "no DATABASE_URL in $APP_DIR/apps/api/.env"
q() { psql "$DBURL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
ROLE=$(q "SELECT current_user" 2> "$WORK/connect.err") || fail "cannot connect: $(head -c 300 "$WORK/connect.err")"
echo "    connected as: $ROLE  (database $(q "SELECT current_database()"), $(q "SHOW server_version"))"
[ "$ROLE" = "$EXPECT_ROLE" ] || fail "connected as '$ROLE', expected '$EXPECT_ROLE'. Never apply as postgres."

echo "==> 3. Pre-flight (read-only)"
HEALTH_BEFORE=$(health)
echo "    API health before: $HEALTH_BEFORE"
for t in campaign_rate_cards campaign_booking_items creator_assets; do
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ -n "$OWNER" ] || fail "table $t does not exist — scripts/campaign-booking-ddl.sql has to be applied first"
  [ "$OWNER" = "$ROLE" ] || fail "table $t is owned by '$OWNER', not '$ROLE' — fix ownership first"
done
echo "    campaign_rate_cards, campaign_booking_items, creator_assets: present, owned by $ROLE"
EXPECTED_PRICE_COLS="active,asset_id,audio_addon_paise,created_at,creator_price_paise,creator_updated_at,entertainment_margin_bps,format,id,margin_bps,staff_updated_at,staff_updated_by_id,updated_at"
TABLE_BEFORE=$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='creator_page_prices'")
if [ "$TABLE_BEFORE" = "1" ]; then
  # IF NOT EXISTS silently keeps a table of a different shape, so an existing one is checked, not trusted.
  HAVE=$(q "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='creator_page_prices'")
  [ "$HAVE" = "$EXPECTED_PRICE_COLS" ] || fail "creator_page_prices exists with different columns ($HAVE) — investigate before applying"
fi

NEW_COLS_SQL="SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND (
  (table_name='campaign_rate_cards' AND column_name='creator_payout_paise' AND data_type='integer') OR
  (table_name='campaign_booking_items' AND column_name='creator_id' AND data_type='text') OR
  (table_name='campaign_booking_items' AND column_name='creator_payout_paise' AND data_type='integer') OR
  (table_name='campaign_booking_items' AND column_name IN ('creator_offered_at','creator_respond_by','creator_decided_at') AND data_type LIKE 'timestamp%') OR
  (table_name='campaign_booking_items' AND column_name='creator_decline_reason' AND character_maximum_length=500))"
COLS_BEFORE=$(q "$NEW_COLS_SQL")
echo "    state: $COLS_BEFORE of 7 new columns present (re-running is a no-op for what exists)"

LONG=$(q "SELECT a.pid || ' ' || coalesce(a.application_name,'') || ' ' || date_trunc('second', now() - a.xact_start) || ' ' || left(regexp_replace(coalesce(a.query,''), '\s+', ' ', 'g'), 80)
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.relation IN ('public.campaign_rate_cards'::regclass, 'public.campaign_booking_items'::regclass, 'public.creator_assets'::regclass)
    AND a.pid <> pg_backend_pid() AND a.xact_start < now() - interval '5 seconds'")
if [ -n "$LONG" ]; then
  echo "$LONG" | sed 's/^/      /'
  fail "a transaction older than 5 s holds a lock on a campaign table; wait a minute and re-run"
fi
echo "    no long transaction on campaign_rate_cards / campaign_booking_items / creator_assets"

echo "==> 4. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
DUMP_EXIT=$?
[ "$DUMP_EXIT" -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed (exit $DUMP_EXIT)"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=creator-marketplace-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/creator-marketplace-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  grep -q "lock timeout" "$WORK/apply.log" && echo "    A writer held a campaign table for more than 3 s; it rolled back. Wait ~10 minutes and re-run once."
  fail "DDL did not apply — see $WORK/apply.log (one transaction, so it rolled back)"
fi
APPLIED=1

echo "==> 6. Verify"
COLS=$(q "$NEW_COLS_SQL")
echo "    new columns with the expected type: $COLS (expected 7)"
[ "$COLS" = "7" ] || fail "expected 7 new columns"
IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='campaign_booking_items' AND indexname='campaign_booking_items_creator_id_status_idx'")
echo "    index campaign_booking_items_creator_id_status_idx: $IDX (expected 1)"
[ "$IDX" = "1" ] || fail "index missing"
TOWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='creator_page_prices'")
echo "    creator_page_prices owner: ${TOWNER:-missing} (expected $ROLE)"
[ "$TOWNER" = "$ROLE" ] || fail "creator_page_prices missing or owned by the wrong role"
HAVE=$(q "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='creator_page_prices'")
[ "$HAVE" = "$EXPECTED_PRICE_COLS" ] || fail "creator_page_prices columns are $HAVE"
PIDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='creator_page_prices' AND indexname IN ('creator_page_prices_pkey','creator_page_prices_asset_id_format_key')")
echo "    creator_page_prices indexes: $PIDX (expected 2 incl. the primary key)"
[ "$PIDX" = "2" ] || fail "expected 2 indexes on creator_page_prices"
FK=$(q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.creator_page_prices'::regclass AND contype='f' AND conname='creator_page_prices_asset_id_fkey' AND confdeltype='c'")
echo "    foreign key to creator_assets (ON DELETE CASCADE): $FK (expected 1)"
[ "$FK" = "1" ] || fail "expected the cascading foreign key on creator_page_prices"
echo "    creator rate cards: $(q "SELECT count(*) FROM campaign_rate_cards WHERE target_type='creator_asset'") (0 until staff price a creator page)"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff \
      --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  STMTS=$(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true)
  echo "    $STMTS drift line(s) in $WORK/drift.sql (known hand-built indexes are expected here):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'campaign_|creator_page_prices' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on a campaign / creator price object — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no campaign_* / creator_page_prices drift"
  DRIFT_RAN=1
else
  echo "    WARNING: could not run prisma migrate diff: $(head -c 300 "$WORK/drift.err" 2>/dev/null)"
fi

HEALTH_AFTER=$(health)
echo "    API health after: $HEALTH_AFTER (before: $HEALTH_BEFORE)"

echo
if [ "$DRIFT_RAN" != "1" ]; then
  echo "APPLIED AND VERIFIED (steps 5-6), but the drift check in step 7 did not run. Logs in $WORK."
  exit 2
fi
echo "ALL DONE — DDL applied as $ROLE and verified. Logs in $WORK."
echo "Safe to merge the PR while its head is still $HEADSHORT. Re-run this script if commits land after this run."
echo "Until the PR is deployed, do NOT run 'prisma db push' on prod from main's schema: it would drop the new columns."
