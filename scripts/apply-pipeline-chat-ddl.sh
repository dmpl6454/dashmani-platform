#!/bin/bash
# One-shot pre-merge step for the "Pipeline channels and DMs" change. Run it ON the
# production box as root, BEFORE merging the PR:
#
#   cd /opt/dashmani-platform && git fetch origin feat/pipeline-chat
#   git show origin/feat/pipeline-chat:scripts/apply-pipeline-chat-ddl.sh > /root/apply-pipeline-chat-ddl.sh
#   bash /root/apply-pipeline-chat-ddl.sh
#
# Same shape as scripts/apply-sales-recurring-ddl.sh:
#   1. extracts scripts/pipeline-chat-ddl.sql and schema.prisma from the PR branch with `git show`
#      (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env and refuses any other role;
#   3. read-only pre-flight: pipeline_projects / pipeline_participants exist and are owned by that role, and
#      nothing holds a long lock on them;
#   4. schema-only backup;
#   5. applies the DDL — one transaction, lock_timeout 3s, ADD COLUMN / CREATE INDEX IF NOT EXISTS;
#   6. verifies the five columns, both indexes and the parent_project_id foreign key (CASCADE);
#   7. drift check (inspect only): no pipeline_projects statement may remain between the database
#      and the PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run. Exit 0 = every
# step passed; 1 = a step failed (the output says whether the DDL was applied); 2 = applied and
# verified but the drift check could not run.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-feat/pipeline-chat}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
WORK="/root/pipeline-chat-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/pipeline-chat-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10

APPLIED=0
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied (it committed in step 5) and is safe to leave in place — it is additive and the running API ignores it."
    echo "Do NOT merge the pipeline-chat change yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/pipeline-chat-ddl.sql" > "$WORK/pipeline-chat-ddl.sql" || fail "scripts/pipeline-chat-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" || fail "schema.prisma is not on origin/$BRANCH"
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $(git rev-parse "origin/$BRANCH")"
echo "    DDL: $(wc -l < "$WORK/pipeline-chat-ddl.sql") lines, sha256 $(sha256sum "$WORK/pipeline-chat-ddl.sql" | cut -c1-12)"

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
for t in pipeline_projects pipeline_participants; do
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ -n "$OWNER" ] || fail "table $t does not exist"
  [ "$OWNER" = "$ROLE" ] || fail "table $t is owned by '$OWNER', not '$ROLE'"
done
echo "    pipeline_projects, pipeline_participants: present, owned by $ROLE"
COL_BEFORE=$(q "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_projects' AND column_name='kind'")
echo "    state: kind $([ "$COL_BEFORE" = "1" ] && echo present || echo absent)"
LONG=$(q "SELECT a.pid || ' ' || coalesce(a.application_name,'') || ' ' || date_trunc('second', now() - a.xact_start)
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.relation IN ('public.pipeline_projects'::regclass, 'public.pipeline_participants'::regclass)
    AND a.pid <> pg_backend_pid() AND a.xact_start < now() - interval '5 seconds'")
[ -z "$LONG" ] || { echo "$LONG" | sed 's/^/      /'; fail "a transaction older than 5 s holds a lock on pipeline_projects; wait a minute and re-run"; }
echo "    no long transaction on pipeline_projects"

echo "==> 4. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
[ $? -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed — wait a minute and re-run"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=pipeline-chat-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/pipeline-chat-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  grep -q "lock timeout" "$WORK/apply.log" && echo "    A writer held a table for more than 3 s; the transaction rolled back. Wait ~10 minutes and run this again (once)."
  fail "DDL did not apply — see $WORK/apply.log (one transaction, so it rolled back)"
fi
APPLIED=1

echo "==> 6. Verify"
for spec in "kind:character varying:NO" "is_private:boolean:NO" "dm_key:text:YES" "parent_project_id:text:YES"; do
  c=${spec%%:*}
  GOT=$(q "SELECT column_name || ':' || data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_projects' AND column_name='$c'")
  echo "    $GOT (expected $spec)"; [ "$GOT" = "$spec" ] || fail "column $c missing or wrong type"
done
IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='pipeline_projects_dm_key_key' AND indexdef LIKE 'CREATE UNIQUE INDEX%'")
[ "$IDX" = "1" ] || fail "unique index pipeline_projects_dm_key_key missing"
echo "    pipeline_projects_dm_key_key: present (unique)"
HS=$(q "SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='pipeline_participants' AND column_name='hidden_seq'")
echo "    pipeline_participants.hidden_seq: $HS (expected integer:YES)"; [ "$HS" = "integer:YES" ] || fail "pipeline_participants.hidden_seq missing or wrong type"
PIDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='pipeline_projects_parent_project_id_idx'")
[ "$PIDX" = "1" ] || fail "index pipeline_projects_parent_project_id_idx missing"
PFK=$(q "SELECT confdeltype FROM pg_constraint WHERE conname='pipeline_projects_parent_project_id_fkey'")
echo "    parent_project_id foreign key on delete: $PFK (expected c = CASCADE)"; [ "$PFK" = "c" ] || fail "parent_project_id foreign key missing or not ON DELETE CASCADE"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff \
      --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  echo "    $(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true) drift line(s) in $WORK/drift.sql (known hand-built indexes are expected):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'pipeline_projects' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on pipeline_projects — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no pipeline_projects drift"; DRIFT_RAN=1
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
echo "Safe to merge the pipeline-chat change while its head is still $HEADSHORT; re-run this (no-op) if commits land after."
echo "Until the PR is merged and deployed, do NOT run 'prisma db push' on prod: main's schema would drop kind, is_private, dm_key, parent_project_id and hidden_seq."
