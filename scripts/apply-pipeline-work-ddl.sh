#!/bin/bash
# One-shot pre-merge step for the Pipeline work-tracking PR (versions, version-bound reviews,
# one publishing record per page). Run it ON the production box as root, BEFORE merging the PR:
#
#   cd /opt/dashmani-platform && git fetch origin claude/sharp-hamilton-yb5lkc
#   git show origin/claude/sharp-hamilton-yb5lkc:scripts/apply-pipeline-work-ddl.sh > /root/apply-pipeline-work-ddl.sh
#   bash /root/apply-pipeline-work-ddl.sh
#
# Same shape as scripts/apply-sales-recurring-ddl.sh:
#   1. extracts scripts/pipeline-work-ddl.sql and schema.prisma from the PR branch with `git show`
#      (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env and refuses any other role;
#   3. read-only pre-flight: pipeline_projects exists and is owned by that role, and nothing holds
#      a long lock on it;
#   4. schema-only backup;
#   5. applies the DDL — one transaction, lock_timeout 3s, CREATE TABLE / CREATE INDEX IF NOT EXISTS;
#   6. verifies the three tables, their five indexes and three foreign keys (ON DELETE CASCADE);
#   7. drift check (inspect only): no pipeline_versions / pipeline_reviews / pipeline_deliverables
#      statement may remain between the database and the PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run. Exit 0 = every
# step passed; 1 = a step failed (the output says whether the DDL was applied); 2 = applied and
# verified but the drift check could not run.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-claude/sharp-hamilton-yb5lkc}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
WORK="/root/pipeline-work-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/pipeline-work-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10

APPLIED=0
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied (it committed in step 5) and is safe to leave in place — it is additive and the running API ignores it."
    echo "Do NOT merge the pipeline work PR yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/pipeline-work-ddl.sql" > "$WORK/pipeline-work-ddl.sql" || fail "scripts/pipeline-work-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" || fail "schema.prisma is not on origin/$BRANCH"
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $(git rev-parse "origin/$BRANCH")"
echo "    DDL: $(wc -l < "$WORK/pipeline-work-ddl.sql") lines, sha256 $(sha256sum "$WORK/pipeline-work-ddl.sql" | cut -c1-12)"

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
OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='pipeline_projects'")
[ -n "$OWNER" ] || fail "table pipeline_projects does not exist"
[ "$OWNER" = "$ROLE" ] || fail "table pipeline_projects is owned by '$OWNER', not '$ROLE'"
echo "    pipeline_projects: present, owned by $ROLE"
TABLES_BEFORE=$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('pipeline_versions','pipeline_reviews','pipeline_deliverables')")
echo "    state: $TABLES_BEFORE of 3 new tables present"
LONG=$(q "SELECT a.pid || ' ' || coalesce(a.application_name,'') || ' ' || date_trunc('second', now() - a.xact_start)
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.relation = 'public.pipeline_projects'::regclass
    AND a.pid <> pg_backend_pid() AND a.xact_start < now() - interval '5 seconds'")
[ -z "$LONG" ] || { echo "$LONG" | sed 's/^/      /'; fail "a transaction older than 5 s holds a lock on pipeline_projects; wait a minute and re-run"; }
echo "    no long transaction on pipeline_projects"

echo "==> 4. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
[ $? -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed — wait a minute and re-run"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=pipeline-work-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/pipeline-work-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  grep -q "lock timeout" "$WORK/apply.log" && echo "    A writer held a table for more than 3 s; the transaction rolled back. Wait ~10 minutes and run this again (once)."
  fail "DDL did not apply — see $WORK/apply.log (one transaction, so it rolled back)"
fi
APPLIED=1

echo "==> 6. Verify"
for t in pipeline_versions pipeline_reviews pipeline_deliverables; do
  OWN=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ "$OWN" = "$ROLE" ] || fail "table $t missing or not owned by $ROLE (owner: '$OWN')"
  FK=$(q "SELECT confdeltype FROM pg_constraint WHERE conname='${t}_project_id_fkey'")
  [ "$FK" = "c" ] || fail "${t}_project_id_fkey missing or not ON DELETE CASCADE"
done
echo "    3 tables owned by $ROLE, each with its project foreign key (ON DELETE CASCADE)"
IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN (
  'pipeline_versions_project_id_kind_number_key','pipeline_reviews_project_id_created_at_idx',
  'pipeline_reviews_reviewer_id_status_idx','pipeline_deliverables_project_id_idx',
  'pipeline_deliverables_assignee_id_status_idx')")
echo "    indexes: $IDX of 5"; [ "$IDX" = "5" ] || fail "an index is missing"
USERS_FK=$(q "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='public.users'::regclass
  AND conrelid::regclass::text IN ('pipeline_versions','pipeline_reviews','pipeline_deliverables')")
[ "$USERS_FK" = "0" ] || fail "an unexpected foreign key into users exists"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff \
      --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  echo "    $(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true) drift line(s) in $WORK/drift.sql (known hand-built indexes are expected):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'pipeline_(versions|reviews|deliverables)' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on the work tables — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no work-table drift"; DRIFT_RAN=1
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
echo "Safe to merge the pipeline work PR while its head is still $HEADSHORT; re-run this (no-op) if commits land after."
echo "Until the PR is merged and deployed, do NOT run 'prisma db push' on prod: main's schema would drop the three new (empty) tables."
