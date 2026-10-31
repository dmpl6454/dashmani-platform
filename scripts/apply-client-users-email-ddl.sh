#!/bin/bash
# One-shot pre-merge step for the team-login email choices PR. Run it ON the production box as
# root, BEFORE merging the PR:
#
#   cd /opt/dashmani-platform && git fetch origin feat/client-team-emails
#   git show origin/feat/client-team-emails:scripts/apply-client-users-email-ddl.sh > /root/apply-client-users-email-ddl.sh
#   bash /root/apply-client-users-email-ddl.sh
#
# Same shape as scripts/apply-client-users-ddl.sh: extracts the DDL from the PR branch with
# `git show`, refuses any role but the app role, schema-only backup, applies (one transaction),
# verifies the two columns, drift check on client_users (inspect only). Restarts nothing.
# Exit 0 = applied and verified; 1 = a step failed; 2 = applied but the drift check could not run.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-feat/client-team-emails}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
WORK="/root/client-users-email-ddl-$(date +%Y%m%d-%H%M%S)"
[ -w /root ] || WORK="${TMPDIR:-/tmp}/client-users-email-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10
fail() { echo "FAIL: $*"; echo "Logs in $WORK"; exit 1; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box"
echo "==> 1. Extract the DDL + schema from origin/$BRANCH"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/client-users-email-ddl.sql" > "$WORK/ddl.sql" || fail "DDL not on the branch"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" || fail "schema not on the branch"
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")

echo "==> 2. Connect as the app role"
DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%%\?*}"
q() { psql "$DBURL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
ROLE=$(q "SELECT current_user") || fail "cannot connect"
[ "$ROLE" = "$EXPECT_ROLE" ] || fail "connected as '$ROLE', expected '$EXPECT_ROLE'"
[ "$(q "SELECT tableowner FROM pg_tables WHERE tablename='client_users'")" = "$ROLE" ] || fail "client_users missing or not owned by $ROLE"

echo "==> 3. Schema-only backup"
pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" || fail "schema dump failed"

echo "==> 4. Apply"
PGAPPNAME=client-users-email-ddl psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/ddl.sql" > "$WORK/apply.log" 2>&1 || { cat "$WORK/apply.log"; fail "DDL did not apply (rolled back)"; }

echo "==> 5. Verify"
N=$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='client_users' AND column_name IN ('email_campaigns','email_invoices')")
echo "    columns: $N (expected 2)"; [ "$N" = "2" ] || fail "columns missing"

echo "==> 6. Drift check (inspect only)"
if (cd "$APP_DIR/packages/db" && DATABASE_URL="$DBURL" timeout 300 npx --no-install prisma migrate diff --from-url "$DBURL" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  grep -qi 'client_users' "$WORK/drift.sql" && fail "client_users still differs from the PR schema — see $WORK/drift.sql"
  echo "    no client_users drift"
else
  echo "APPLIED AND VERIFIED, but the drift check could not run: $(head -c 200 "$WORK/drift.err")"; exit 2
fi
echo "ALL DONE — safe to merge while the PR head is $HEADSHORT."
