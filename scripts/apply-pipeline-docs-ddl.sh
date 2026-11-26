#!/bin/bash
# One-shot pre-merge step for Pipeline project documents (pitch deck / brief / quote / report).
# Run it ON the production box as root, BEFORE merging the PR:
#
#   cd /opt/dashmani-platform && git fetch origin feat/sales-pipeline-documents
#   git show origin/feat/sales-pipeline-documents:scripts/apply-pipeline-docs-ddl.sh > /root/apply-pipeline-docs-ddl.sh
#   bash /root/apply-pipeline-docs-ddl.sh
#
# Same shape as scripts/apply-pipeline-work-ddl.sh:
#   1. extracts scripts/pipeline-docs-ddl.sql and schema.prisma from the PR branch with `git show`
#      (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env and refuses any other role;
#   3. read-only pre-flight: pipeline_projects exists and is owned by that role, and nothing holds
#      a long lock on it;
#   4. schema-only backup;
#   5. applies the DDL — one transaction, lock_timeout 3s, CREATE TABLE / CREATE INDEX IF NOT EXISTS;
#   6. verifies the new table, its three indexes and its cascading foreign key;
#   7. drift check (inspect only): no pipeline_documents statement may remain between the
#      database and the PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run. Exit 0 = every
# step passed; 1 = a step failed (the output says whether the DDL was applied); 2 = applied and
# verified but the drift check could not run.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-feat/sales-pipeline-documents}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
WORK="/root/pipeline-docs-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/pipeline-docs-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10

APPLIED=0
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied (it committed in step 5) and is safe to leave in place — it is additive and the running API ignores it."
    echo "Do NOT merge the pipeline documents PR yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/pipeline-docs-ddl.sql" > "$WORK/pipeline-docs-ddl.sql" || fail "scripts/pipeline-docs-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" || fail "schema.prisma is not on origin/$BRANCH"
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $(git rev-parse "origin/$BRANCH")"
echo "    DDL: $(wc -l < "$WORK/pipeline-docs-ddl.sql") lines, sha256 $(sha256sum "$WORK/pipeline-docs-ddl.sql" | cut -c1-12)"

echo "==> 2. DATABASE_URL (the app role) from apps/api/.env"
DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%\'}"; DBURL="${DBURL#\'}"
[ -n "$DBURL" ] || fail "no DATABASE_URL in $APP_DIR/apps/api/.env"
# The URL holds the password: never put it on a command line (other users on the box can read
# argv with ps). Split it into libpq's PG* variables (read through the environment, never argv)
# and keep sslmode if the URL sets one.
PGVARS=$(DBURL="$DBURL" node -e '
  const u = new URL(process.env.DBURL);
  const q = (s) => "\x27" + s.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  const v = { PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)) };
  const ssl = u.searchParams.get("sslmode"); if (ssl) v.PGSSLMODE = ssl;
  for (const [k, x] of Object.entries(v)) console.log("export " + k + "=" + q(x));
') || fail "could not parse DATABASE_URL"
eval "$PGVARS"; unset PGVARS
export DATABASE_URL="$DBURL"
q() { psql -X -At -v ON_ERROR_STOP=1 -c "$1"; }
ROLE=$(q "SELECT current_user" 2> "$WORK/connect.err") || fail "cannot connect: $(head -c 300 "$WORK/connect.err")"
echo "    connected as: $ROLE  (database $(q "SELECT current_database()"))"
[ "$ROLE" = "$EXPECT_ROLE" ] || fail "connected as '$ROLE', expected '$EXPECT_ROLE'. Never apply as postgres."

echo "==> 3. Pre-flight (read-only)"
HEALTH_BEFORE=$(health); echo "    API health before: $HEALTH_BEFORE"
OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='pipeline_projects'")
[ -n "$OWNER" ] || fail "table pipeline_projects does not exist"
[ "$OWNER" = "$ROLE" ] || fail "table pipeline_projects is owned by '$OWNER', not '$ROLE'"
echo "    pipeline_projects: present, owned by $ROLE"
TABLES_BEFORE=$(q "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='pipeline_documents'")
echo "    state: pipeline_documents present: $TABLES_BEFORE (1 = already applied; re-running is a no-op)"
LONG=$(q "SELECT a.pid || ' ' || coalesce(a.application_name,'') || ' ' || date_trunc('second', now() - a.xact_start)
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.relation = 'public.pipeline_projects'::regclass
    AND a.pid <> pg_backend_pid() AND a.xact_start < now() - interval '5 seconds'")
[ -z "$LONG" ] || { echo "$LONG" | sed 's/^/      /'; fail "a transaction older than 5 s holds a lock on pipeline_projects; wait a minute and re-run"; }
echo "    no long transaction on pipeline_projects"

echo "==> 4. Schema-only backup"
pg_dump --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
[ $? -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed — wait a minute and re-run"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=pipeline-docs-ddl psql -X -v ON_ERROR_STOP=1 -f "$WORK/pipeline-docs-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  grep -q "lock timeout" "$WORK/apply.log" && echo "    A writer held a table for more than 3 s; the transaction rolled back. Wait ~10 minutes and run this again (once)."
  fail "DDL did not apply — see $WORK/apply.log (one transaction, so it rolled back)"
fi
APPLIED=1

echo "==> 6. Verify"
OWN=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='pipeline_documents'")
[ "$OWN" = "$ROLE" ] || fail "table pipeline_documents missing or not owned by $ROLE (owner: '$OWN')"
FK=$(q "SELECT confdeltype FROM pg_constraint WHERE conname='pipeline_documents_project_id_fkey'")
[ "$FK" = "c" ] || fail "pipeline_documents_project_id_fkey missing or wrong ON DELETE (got '$FK', want 'c')"
echo "    pipeline_documents owned by $ROLE; foreign key cascades"
COLS=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_documents'
  AND column_name IN ('source','conversation_id','file_key','status_changed_at')")
echo "    key columns: $COLS of 4"
NCOLS=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_projects'
  AND column_name IN ('status_note','status_note_at','status_note_by_id')")
echo "    pipeline_projects note columns: $NCOLS of 3"; [ "$NCOLS" = "3" ] || fail "a pipeline_projects status-note column is missing"
OWN2=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='pipeline_activity'")
[ "$OWN2" = "$ROLE" ] || fail "table pipeline_activity missing or not owned by $ROLE (owner: '$OWN2')"
FK2=$(q "SELECT confdeltype FROM pg_constraint WHERE conname='pipeline_activity_project_id_fkey'")
[ "$FK2" = "c" ] || fail "pipeline_activity_project_id_fkey missing or wrong ON DELETE (got '$FK2', want 'c')"
AIDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='pipeline_activity_project_id_created_at_idx'")
[ "$AIDX" = "1" ] || fail "pipeline_activity_project_id_created_at_idx is missing"
echo "    pipeline_activity owned by $ROLE; foreign key cascades; index present"; [ "$COLS" = "4" ] || fail "a pipeline_documents column is missing (an older copy of the table?) — send this output to Claude"
IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN (
  'pipeline_documents_pkey','pipeline_documents_file_key_key','pipeline_documents_project_id_created_at_idx',
  'pipeline_documents_status_status_changed_at_idx','pipeline_deliverables_scheduled_at_idx')")
echo "    indexes: $IDX of 5"; [ "$IDX" = "5" ] || fail "an index is missing"
USERS_FK=$(q "SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='public.users'::regclass
  AND conrelid::regclass::text = 'pipeline_documents'")
[ "$USERS_FK" = "0" ] || fail "an unexpected foreign key into users exists"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && timeout 300 npx --no-install prisma migrate diff \
      --from-schema-datasource "$WORK/schema.prisma" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  echo "    $(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true) drift line(s) in $WORK/drift.sql (known hand-built indexes are expected):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'pipeline_documents|pipeline_activity|status_note|pipeline_deliverables_scheduled_at_idx' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on pipeline_documents — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no pipeline_documents drift"; DRIFT_RAN=1
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
echo "Safe to merge the pipeline documents PR while its head is still $HEADSHORT; re-run this (no-op) if commits land after."
echo "Until the PR is merged and deployed, do NOT run 'prisma db push' on prod: main's schema would drop the new (empty) pipeline_documents table."
