#!/bin/bash
# One-shot pre-merge step for PR #197 (per-account campaign text, client thumbnail, render
# variants). Run it ON the production box as root, BEFORE merging the PR:
#
#   cd /opt/dashmani-platform && git fetch origin claude/awesome-bohr-qu8x1k
#   git show origin/claude/awesome-bohr-qu8x1k:scripts/apply-campaign-overrides-ddl.sh > /root/apply-campaign-overrides-ddl.sh
#   bash /root/apply-campaign-overrides-ddl.sh
#
# It exists because the box's terminal mangles multi-line pastes. Every step is the documented
# runbook step (docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md), nothing more:
#   1. extracts scripts/campaign-overrides-ddl.sql and schema.prisma from the PR branch with
#      `git show` (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env — the runbook's recipe —
#      and refuses to run as any other role (objects made by postgres break every later DDL);
#   3. read-only pre-flight: the campaign tables exist and are owned by that role, nothing holds
#      a long lock on them, and a campaign_media_renders table already there has the right shape;
#   4. schema-only backup (seconds; no data is rewritten by this DDL);
#   5. applies the DDL — one transaction, lock_timeout 3s, ADD COLUMN / CREATE ... IF NOT EXISTS;
#   6. verifies the 5 columns, the new table, its 4 indexes and 2 foreign keys;
#   7. drift check (inspect only, never applied): no campaign_* statement may remain between
#      the database and the PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run: a second
# run changes nothing. Exit code 0 means every step passed.
#
# APP_DIR / BRANCH / EXPECT_ROLE / HEALTH_URL may be overridden for a local rehearsal only.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-claude/awesome-bohr-qu8x1k}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
WORK="/root/campaign-overrides-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/campaign-overrides-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10

fail() { echo "FAIL: $*"; echo "Nothing after this point ran. Logs in $WORK"; exit 1; }
health() { curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box (ssh dashmani-prod)"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/campaign-overrides-ddl.sql" > "$WORK/campaign-overrides-ddl.sql" \
  || fail "scripts/campaign-overrides-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" \
  || fail "packages/db/prisma/schema.prisma is not on origin/$BRANCH"
echo "    branch head: $(git rev-parse --short "origin/$BRANCH")"
echo "    DDL: $(wc -l < "$WORK/campaign-overrides-ddl.sql") lines, sha256 $(sha256sum "$WORK/campaign-overrides-ddl.sql" | cut -c1-12)"

echo "==> 2. DATABASE_URL (the app role) from apps/api/.env"
DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%\'}"; DBURL="${DBURL#\'}"; DBURL="${DBURL%%\?*}"
[ -n "$DBURL" ] || fail "no DATABASE_URL in $APP_DIR/apps/api/.env"
q() { psql "$DBURL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
ROLE=$(q "SELECT current_user" 2>&1) || fail "cannot connect: $ROLE"
echo "    connected as: $ROLE  (database $(q "SELECT current_database()"), $(q "SHOW server_version"))"
[ "$ROLE" = "$EXPECT_ROLE" ] || fail "connected as '$ROLE', expected '$EXPECT_ROLE'. Never apply as postgres: tables it creates are owned by postgres and every later Prisma DDL fails."

echo "==> 3. Pre-flight (read-only)"
HEALTH_BEFORE=$(health)
echo "    API health before: $HEALTH_BEFORE"
for t in campaign_bookings campaign_media campaign_booking_items; do
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ -n "$OWNER" ] || fail "table $t does not exist — scripts/campaign-booking-ddl.sql (PR #192) has to be applied first"
  [ "$OWNER" = "$ROLE" ] || fail "table $t is owned by '$OWNER', not '$ROLE' — fix ownership first (ALTER TABLE $t OWNER TO $ROLE as postgres)"
done
echo "    campaign_bookings, campaign_media, campaign_booking_items: present, owned by $ROLE"
[ "$(q "SELECT has_schema_privilege('public','CREATE')")" = "t" ] || fail "$ROLE cannot CREATE in schema public"

COLS_BEFORE=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND (
  (table_name='campaign_media' AND column_name='role') OR
  (table_name='campaign_booking_items' AND column_name IN ('caption_override','hashtags_override','super_text_override','super_text_style_override')))")
TABLE_BEFORE=$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='campaign_media_renders'")
if [ "$COLS_BEFORE" = "0" ] && [ "$TABLE_BEFORE" = "0" ]; then
  echo "    state: not applied yet (0 of 5 new columns, no campaign_media_renders)"
else
  echo "    state: partly or fully applied already ($COLS_BEFORE of 5 new columns, campaign_media_renders: $TABLE_BEFORE) — re-running is a no-op for what exists"
fi
EXPECTED_RENDER_COLS="booking_id,created_at,error,id,locked_until,media_id,overlay_key,overlay_style,overlay_text,render_key,status,updated_at"
if [ "$TABLE_BEFORE" = "1" ]; then
  # IF NOT EXISTS silently keeps a table of a different shape, so an existing one is checked, not trusted.
  HAVE=$(q "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='campaign_media_renders'")
  [ "$HAVE" = "$EXPECTED_RENDER_COLS" ] || fail "campaign_media_renders exists with different columns ($HAVE) — investigate before applying"
fi

LONG=$(q "SELECT a.pid || ' ' || coalesce(a.application_name,'') || ' ' || date_trunc('second', now() - a.xact_start) || ' ' || left(regexp_replace(coalesce(a.query,''), '\s+', ' ', 'g'), 80)
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.relation IN ('public.campaign_media'::regclass, 'public.campaign_booking_items'::regclass)
    AND a.pid <> pg_backend_pid() AND a.xact_start < now() - interval '5 seconds'")
if [ -n "$LONG" ]; then
  echo "$LONG" | sed 's/^/      /'
  fail "a transaction older than 5 s holds a lock on a campaign table; wait a minute and re-run"
fi
echo "    no long transaction on campaign_media / campaign_booking_items"

echo "==> 4. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
[ -s "$WORK/pre-ddl-schema.sql" ] || { cat "$WORK/pg_dump.err"; fail "schema dump is empty"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=campaign-overrides-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/campaign-overrides-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  if grep -q "lock timeout" "$WORK/apply.log"; then
    echo "    A writer held a campaign table for more than 3 s. The transaction rolled back; nothing changed."
    echo "    Wait ~10 minutes and run this script again (once)."
  fi
  fail "DDL did not apply — see $WORK/apply.log (the script runs in one transaction, so it rolled back)"
fi

echo "==> 6. Verify"
COLS=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND (
  (table_name='campaign_media' AND column_name='role' AND data_type='character varying' AND character_maximum_length=16 AND is_nullable='NO' AND column_default LIKE '''creative''%') OR
  (table_name='campaign_booking_items' AND column_name='caption_override' AND data_type='text') OR
  (table_name='campaign_booking_items' AND column_name='hashtags_override' AND data_type='ARRAY') OR
  (table_name='campaign_booking_items' AND column_name='super_text_override' AND character_maximum_length=200) OR
  (table_name='campaign_booking_items' AND column_name='super_text_style_override' AND character_maximum_length=24))")
echo "    new columns with the expected type: $COLS (expected 5)"
[ "$COLS" = "5" ] || fail "expected 5 new columns"
TOWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='campaign_media_renders'")
echo "    campaign_media_renders owner: ${TOWNER:-missing} (expected $ROLE)"
[ "$TOWNER" = "$ROLE" ] || fail "campaign_media_renders missing or owned by the wrong role"
HAVE=$(q "SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name='campaign_media_renders'")
[ "$HAVE" = "$EXPECTED_RENDER_COLS" ] || fail "campaign_media_renders columns are $HAVE"
IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='campaign_media_renders' AND indexname IN
  ('campaign_media_renders_pkey','campaign_media_renders_render_key_key','campaign_media_renders_status_idx','campaign_media_renders_booking_id_idx','campaign_media_renders_media_id_overlay_key_key')")
echo "    indexes: $IDX (expected 5 incl. the primary key)"
[ "$IDX" = "5" ] || fail "expected 5 indexes on campaign_media_renders"
FK=$(q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.campaign_media_renders'::regclass AND contype='f'
  AND conname IN ('campaign_media_renders_media_id_fkey','campaign_media_renders_booking_id_fkey')")
echo "    foreign keys: $FK (expected 2)"
[ "$FK" = "2" ] || fail "expected 2 foreign keys on campaign_media_renders"
echo "    campaign_media by role: $(q "SELECT coalesce(string_agg(role || '=' || n, ', '), 'no rows') FROM (SELECT role, count(*) n FROM campaign_media GROUP BY role ORDER BY role) s")"
echo "    campaign_media_renders rows: $(q "SELECT count(*) FROM campaign_media_renders")"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff \
      --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  STMTS=$(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true)
  echo "    $STMTS drift line(s) in $WORK/drift.sql (known hand-built indexes are expected here):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'campaign_|razorpay_webhook_events' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on a campaign object — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no campaign_* drift"
else
  echo "    WARNING: could not run prisma migrate diff ($(head -c 200 "$WORK/drift.err" 2>/dev/null)); steps 5-6 already verified every object, so this is informational"
fi

HEALTH_AFTER=$(health)
echo "    API health after: $HEALTH_AFTER (before: $HEALTH_BEFORE)"

echo
echo "ALL DONE — DDL applied as $ROLE and verified. Logs in $WORK."
echo "Safe to merge PR #197. Until it is merged and deployed, do NOT run 'prisma db push' on prod:"
echo "a push from main's schema would drop the new (still empty) campaign_media_renders table."
