#!/bin/bash
# One-off: catch up the link_metrics retention + api_usage rollup, then VACUUM FULL both tables so
# the freed space goes back to the disk. Run ON the prod box as root, in the quiet hours:
#
#   bash /opt/dashmani-platform/scripts/compact-usage-tables.sh
#
# Deleted rows are otherwise only reusable by the same table; the 49 GB disk needs the space back
# once. VACUUM FULL rewrites the live rows into new files under an ACCESS EXCLUSIVE lock: while it
# runs (seconds to a few minutes) the insights cron's link_metrics writes, HR resubmits (FK
# SetNull on link_metrics) and api_usage logging wait. Hence: quiet hours only, lock_timeout 5s
# to get in, and a disk check first (VACUUM FULL needs room for the copy of the live rows).
# Restarts nothing. Exit 0 = done; 1 = a step failed (the output says which).
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
fail() { echo "FAIL: $*"; exit 1; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box"

IST_HOUR=$(TZ=Asia/Kolkata date +%H)
if [ "${FORCE:-0}" != "1" ] && { [ "$IST_HOUR" -lt 1 ] || [ "$IST_HOUR" -ge 7 ]; }; then
  fail "it is ${IST_HOUR}:xx IST — run between 01:00 and 07:00 IST (or FORCE=1)"
fi

DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%\'}"; DBURL="${DBURL#\'}"
[ -n "$DBURL" ] || fail "no DATABASE_URL in $APP_DIR/apps/api/.env"
PSQLURL="${DBURL%%\?*}"
q() { psql "$PSQLURL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
ROLE=$(q "SELECT current_user") || fail "cannot connect"
[ "$ROLE" = "$EXPECT_ROLE" ] || fail "connected as '$ROLE', expected '$EXPECT_ROLE'"

echo "==> 1a. Catch up: link_metrics retention (scripts/link-metrics-catchup.sql)"
psql "$PSQLURL" -X -f scripts/link-metrics-catchup.sql | grep -vE '^DELETE 0$' | awk '/^DELETE/{n+=$2; c++; if (c % 50 == 0) print "    deleted so far: " n; next} {print "    " $0} END{print "    deleted: " n+0}'
[ "${PIPESTATUS[0]}" = "0" ] || fail "link_metrics catch-up stopped (what it deleted stays deleted; re-run to finish)"

echo "==> 1b. Catch up: api_usage rollup"
( cd packages/db && DATABASE_URL="$DBURL" npx tsx ../../scripts/run-api-usage-rollup.ts --apply ) || fail "api_usage rollup failed (nothing compacted)"

echo "==> 2. Table settings (scripts/db-maintenance.sql)"
psql "$PSQLURL" -X -q -v ON_ERROR_STOP=1 -f scripts/db-maintenance.sql || fail "db-maintenance.sql"

echo "==> 3. VACUUM FULL"
df -h / | tail -1
for t in api_usage link_metrics; do
  LIVE_KB=$(q "SELECT (pg_total_relation_size('$t') * GREATEST(n_live_tup, 1) / GREATEST(n_live_tup + n_dead_tup, 1)) / 1024 FROM pg_stat_user_tables WHERE relname = '$t'")
  FREE_KB=$(df -k --output=avail / | tail -1 | tr -d ' ')
  BEFORE=$(q "SELECT pg_size_pretty(pg_total_relation_size('$t'))")
  echo "    $t: $BEFORE now, ~$((LIVE_KB / 1024)) MB live, $((FREE_KB / 1024)) MB free on /"
  [ "$FREE_KB" -gt $((LIVE_KB * 2 + 2 * 1024 * 1024)) ] || fail "not enough free disk to rewrite $t safely"
  START=$(date +%s)
  psql "$PSQLURL" -X -q -v ON_ERROR_STOP=1 \
    -c "SET lock_timeout = '5s'" -c "SET statement_timeout = '20min'" -c "VACUUM (FULL, ANALYZE) $t" \
    || fail "VACUUM FULL $t (lock not granted within 5s, or timed out) — the table is unchanged; re-run later"
  echo "    $t: $BEFORE -> $(q "SELECT pg_size_pretty(pg_total_relation_size('$t'))") in $(( $(date +%s) - START ))s"
done
df -h / | tail -1
echo "ALL DONE"
