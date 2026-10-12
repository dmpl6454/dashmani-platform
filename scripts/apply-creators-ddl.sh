#!/bin/bash
# One-shot pre-merge step for the creator-portal Phase A PR (creators.digitalsukoon.com: creator
# accounts, their Facebook Login grant, the Pages / Instagram accounts it reaches, and Meta's
# deauthorize / data-deletion log). Run it ON the production box as root, BEFORE merging the PR:
#
#   cd /opt/dashmani-platform && git fetch origin claude/creators-phase-a
#   git show origin/claude/creators-phase-a:scripts/apply-creators-ddl.sh > /root/apply-creators-ddl.sh
#   bash /root/apply-creators-ddl.sh
#
# It exists because the box's terminal mangles multi-line pastes. Every step is the documented
# runbook step (docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md), nothing more:
#   1. extracts scripts/creators-ddl.sql and schema.prisma from the PR branch with `git show`
#      (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env — the runbook's recipe —
#      and refuses to run as any other role (objects made by postgres break every later DDL);
#   3. read-only pre-flight: the role may CREATE in schema public, and any of the seven tables
#      that already exists has exactly the expected columns and is owned by that role (IF NOT
#      EXISTS would otherwise silently keep a table of a different shape). No existing table is
#      touched by this DDL, so the long-lock check only looks at the creator tables themselves;
#   4. schema-only backup (seconds; this DDL rewrites no data);
#   5. applies the DDL — one transaction, lock_timeout 3s, CREATE ... IF NOT EXISTS only;
#   6. verifies the seven tables (owner + columns), their 23 indexes (6 unique, besides the
#      primary keys) and the 6 foreign keys (all ON DELETE CASCADE);
#   7. drift check (inspect only, never applied): no creator_* / meta_deletion_requests statement
#      may remain between the database and the PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run: a second
# run changes nothing. Exit code 0 means every step passed; 1 means a step failed (the output says
# whether the DDL was applied); 2 means the DDL is applied and verified but the drift check could
# not run.
#
# APP_DIR / BRANCH / EXPECT_ROLE / HEALTH_URL / WORK_ROOT may be overridden for a local rehearsal only.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-claude/creators-phase-a}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
PR="the creator-portal Phase A PR"
WORK_ROOT="${WORK_ROOT:-/root}"
[ -w "$WORK_ROOT" ] || WORK_ROOT="${TMPDIR:-/tmp}"
WORK="$WORK_ROOT/creators-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10

# The seven tables, children first (the order a drop would need), and their columns sorted
# byte-wise — exactly the CREATE TABLE lists in scripts/creators-ddl.sql.
TABLES="creator_assets creator_connections creator_oauth_states creator_tokens creator_refresh_tokens creators meta_deletion_requests"
declare -A EXPECTED_COLS=(
  [creators]="adult_confirmed_at,closed_at,country,created_at,email,email_verified_at,id,name,password_hash,payout_currency,payout_details_enc,payout_details_hint,payout_method,phone,review_note,reviewed_at,reviewed_by_id,status,submitted_at,terms_accepted_at,terms_version,updated_at"
  [creator_refresh_tokens]="created_at,creator_id,expires_at,id,token_hash"
  [creator_tokens]="created_at,creator_id,expires_at,id,purpose,token_hash,used_at"
  [creator_oauth_states]="created_at,creator_id,expires_at,mode,state,used_at"
  [creator_connections]="created_at,creator_id,data_access_expires_at,discovery_state,expiry_warned_days,granted_scopes,granular_scopes,graph_version,id,last_error,last_verified_at,meta_user_id,meta_user_name,revoked_at,status,token_expires_at,updated_at,user_token_enc"
  [creator_assets]="can_publish,connection_id,created_at,creator_id,disconnected_at,enabled,enabled_at,enabled_by_id,engagements_28d,follower_count,id,kind,media_count,meta_id,metrics_error,metrics_fetched_at,name,network_duplicate_of,page_token_enc,parent_page_id,picture_url,publish_probe_error,reach_28d,tasks,updated_at,username,views_28d"
  [meta_deletion_requests]="completed_at,confirmation_code,id,kind,matched,note,received_at,status,user_hash"
)
# Every index the DDL creates (primary keys included); the unique ones are checked separately.
EXPECTED_INDEXES="creators_pkey creators_email_key creators_status_idx creators_created_at_idx
creator_refresh_tokens_pkey creator_refresh_tokens_token_hash_key creator_refresh_tokens_creator_id_idx
creator_tokens_pkey creator_tokens_token_hash_key creator_tokens_creator_id_purpose_idx
creator_oauth_states_pkey creator_oauth_states_expires_at_idx
creator_connections_pkey creator_connections_meta_user_id_key creator_connections_creator_id_idx creator_connections_status_idx
creator_assets_pkey creator_assets_creator_id_idx creator_assets_connection_id_idx creator_assets_kind_meta_id_key
meta_deletion_requests_pkey meta_deletion_requests_confirmation_code_key meta_deletion_requests_user_hash_idx"
EXPECTED_UNIQUE="creators_email_key creator_refresh_tokens_token_hash_key creator_tokens_token_hash_key creator_connections_meta_user_id_key creator_assets_kind_meta_id_key meta_deletion_requests_confirmation_code_key"
EXPECTED_FKS="creator_refresh_tokens_creator_id_fkey creator_tokens_creator_id_fkey creator_oauth_states_creator_id_fkey creator_connections_creator_id_fkey creator_assets_creator_id_fkey creator_assets_connection_id_fkey"
sqllist() { echo "$1" | tr -s ' \n' '\n' | sed '/^$/d' | sed "s/.*/'&'/" | paste -sd, -; }

APPLIED=0   # flips to 1 once the DDL transaction has committed
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied (it committed in step 5) and is safe to leave in place — it only adds new, empty tables and the running API ignores them."
    echo "Do NOT merge $PR yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box (ssh dashmani-prod)"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/creators-ddl.sql" > "$WORK/creators-ddl.sql" \
  || fail "scripts/creators-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" \
  || fail "packages/db/prisma/schema.prisma is not on origin/$BRANCH"
HEAD_SHA=$(git rev-parse "origin/$BRANCH")
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $HEAD_SHA"
echo "    DDL: $(wc -l < "$WORK/creators-ddl.sql") lines, sha256 $(sha256sum "$WORK/creators-ddl.sql" | cut -c1-12)"

echo "==> 2. DATABASE_URL (the app role) from apps/api/.env"
DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%\'}"; DBURL="${DBURL#\'}"; DBURL="${DBURL%%\?*}"
[ -n "$DBURL" ] || fail "no DATABASE_URL in $APP_DIR/apps/api/.env"
q() { psql "$DBURL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
ROLE=$(q "SELECT current_user" 2> "$WORK/connect.err") || fail "cannot connect: $(head -c 300 "$WORK/connect.err")"
echo "    connected as: $ROLE  (database $(q "SELECT current_database()"), $(q "SHOW server_version"))"
[ "$ROLE" = "$EXPECT_ROLE" ] || fail "connected as '$ROLE', expected '$EXPECT_ROLE'. Never apply as postgres: tables it creates are owned by postgres and every later Prisma DDL fails."

echo "==> 3. Pre-flight (read-only)"
HEALTH_BEFORE=$(health)
echo "    API health before: $HEALTH_BEFORE"
[ "$(q "SELECT has_schema_privilege('public','CREATE')")" = "t" ] || fail "$ROLE cannot CREATE in schema public"
cols_of() { q "SELECT string_agg(column_name, ',' ORDER BY column_name COLLATE \"C\") FROM information_schema.columns WHERE table_schema='public' AND table_name='$1'"; }
PRESENT=0
for t in $TABLES; do
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ -n "$OWNER" ] || continue
  PRESENT=$((PRESENT + 1))
  [ "$OWNER" = "$ROLE" ] || fail "table $t exists but is owned by '$OWNER', not '$ROLE' — fix ownership first (ALTER TABLE $t OWNER TO $ROLE as postgres)"
  HAVE=$(cols_of "$t")
  # IF NOT EXISTS silently keeps a table of a different shape, so an existing one is checked, not trusted.
  [ "$HAVE" = "${EXPECTED_COLS[$t]}" ] || fail "table $t already exists with different columns ($HAVE) — investigate before applying"
done
if [ "$PRESENT" = "0" ]; then
  echo "    state: not applied yet (none of the 7 tables exists)"
else
  echo "    state: partly or fully applied already ($PRESENT of 7 tables, each with the expected columns) — re-running is a no-op for what exists"
fi
# No existing table is altered, so nothing the live API uses can be blocked. Only a re-run can
# meet a lock (on a creator table that already exists); keep the check cheap and scoped to those.
LONG=$(q "SELECT a.pid || ' ' || coalesce(a.application_name,'') || ' ' || date_trunc('second', now() - a.xact_start) || ' ' || left(regexp_replace(coalesce(a.query,''), '\s+', ' ', 'g'), 80)
  FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE n.nspname = 'public' AND c.relname IN ($(sqllist "$TABLES"))
    AND a.pid <> pg_backend_pid() AND a.xact_start < now() - interval '5 seconds'")
if [ -n "$LONG" ]; then
  echo "$LONG" | sed 's/^/      /'
  fail "a transaction older than 5 s holds a lock on a creator table; wait a minute and re-run"
fi
echo "    no long transaction on any creator table"

echo "==> 4. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
DUMP_EXIT=$?
[ "$DUMP_EXIT" -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed (exit $DUMP_EXIT) — wait a minute and re-run"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=creators-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/creators-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  if grep -q "lock timeout" "$WORK/apply.log"; then
    echo "    Something held a creator table for more than 3 s. The transaction rolled back; nothing changed."
    echo "    Wait ~10 minutes and run this script again (once)."
  fi
  fail "DDL did not apply — see $WORK/apply.log (the script runs in one transaction, so it rolled back)"
fi
APPLIED=1

echo "==> 6. Verify"
for t in $TABLES; do
  TOWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ "$TOWNER" = "$ROLE" ] || fail "table $t missing or owned by '${TOWNER:-nobody}' (expected $ROLE)"
  HAVE=$(cols_of "$t")
  [ "$HAVE" = "${EXPECTED_COLS[$t]}" ] || fail "table $t has columns $HAVE"
  echo "    $t: owner $TOWNER, $(echo "$HAVE" | tr ',' '\n' | wc -l | tr -d ' ') columns as expected, $(q "SELECT count(*) FROM public.\"$t\"") rows"
done
IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN ($(sqllist "$EXPECTED_INDEXES"))")
echo "    indexes: $IDX (expected 23 incl. the 7 primary keys)"
[ "$IDX" = "23" ] || fail "expected 23 indexes on the creator tables; missing: $(q "SELECT string_agg(x, ' ') FROM unnest(ARRAY[$(sqllist "$EXPECTED_INDEXES")]) x WHERE x NOT IN (SELECT indexname FROM pg_indexes WHERE schemaname='public')")"
UNIQ=$(q "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND i.indisunique AND i.indisvalid AND c.relname IN ($(sqllist "$EXPECTED_UNIQUE"))")
echo "    unique indexes (besides primary keys): $UNIQ (expected 6)"
[ "$UNIQ" = "6" ] || fail "expected 6 valid UNIQUE indexes ($EXPECTED_UNIQUE)"
FK=$(q "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public' AND c.contype = 'f' AND c.confdeltype = 'c' AND c.conname IN ($(sqllist "$EXPECTED_FKS"))")
echo "    foreign keys (ON DELETE CASCADE): $FK (expected 6)"
[ "$FK" = "6" ] || fail "expected 6 cascading foreign keys ($EXPECTED_FKS)"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff \
      --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  STMTS=$(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true)
  echo "    $STMTS drift line(s) in $WORK/drift.sql (known hand-built indexes are expected here):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'creator_|"creators"|meta_deletion_requests' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on a creator object — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no creator_* / meta_deletion_requests drift"
  DRIFT_RAN=1
else
  echo "    WARNING: could not run prisma migrate diff: $(head -c 300 "$WORK/drift.err" 2>/dev/null)"
fi

HEALTH_AFTER=$(health)
echo "    API health after: $HEALTH_AFTER (before: $HEALTH_BEFORE)"
if [ "$HEALTH_AFTER" != "200" ]; then
  echo "    WARNING: the API health check is not 200. This DDL cannot cause that (it only adds new tables"
  echo "    the running API never reads) — check 'pm2 status' / 'pm2 logs api --lines 50' before merging."
fi

echo
if [ "$DRIFT_RAN" != "1" ]; then
  echo "APPLIED AND VERIFIED (steps 5-6), but the drift check in step 7 did not run. Logs in $WORK."
  echo "Send this output to Claude before merging $PR."
  exit 2
fi
echo "ALL DONE — DDL applied as $ROLE and verified. Logs in $WORK."
echo "Safe to merge $PR while its head is still $HEADSHORT."
echo "If commits land on the PR after this run, re-run this script (it is safe to re-run) before merging."
echo "Until the PR is merged and deployed, do NOT run 'prisma db push' on prod: a push from main's schema"
echo "would drop the seven new (still empty) creator tables without a prompt."
