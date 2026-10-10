#!/bin/bash
# One-shot pre-merge step for the campaign booking PR, run ON the production box as root:
#
#   cd /opt/dashmani-platform && git fetch origin claude/awesome-bohr-qu8x1k
#   git show origin/claude/awesome-bohr-qu8x1k:scripts/apply-campaign-ddl.sh > /root/apply-campaign-ddl.sh
#   bash /root/apply-campaign-ddl.sh
#
# It exists because the box's terminal mangles multi-line pastes; every step here is the
# documented runbook step (docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md), nothing more:
#   1. extracts DATABASE_URL (the dashmani app role) from apps/api/.env — the runbook's recipe;
#   2. applies scripts/campaign-booking-ddl.sql from the PR branch (one transaction, IF NOT EXISTS,
#      7 new campaign_* tables + razorpay_webhook_events, no DDL on any existing table);
#   3. verifies the 7 tables exist;
#   4. runs scripts/setup-campaigns.sh (ffmpeg, fonts, media folder, CAMPAIGN_MEDIA_DIR).
# It restarts nothing. Safe to re-run. Exit code 0 means every step passed.
set -uo pipefail

APP_DIR="/opt/dashmani-platform"
BRANCH="claude/awesome-bohr-qu8x1k"
WORK="/root/campaign-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
cd "$APP_DIR" || { echo "FAIL: $APP_DIR missing — this must run on the prod box"; exit 1; }

echo "==> 1. Fetch the PR branch and extract the scripts"
git fetch origin "$BRANCH" || { echo "FAIL: git fetch"; exit 1; }
git show "origin/$BRANCH:scripts/campaign-booking-ddl.sql" > "$WORK/campaign-booking-ddl.sql" || { echo "FAIL: DDL not on branch"; exit 1; }
git show "origin/$BRANCH:scripts/setup-campaigns.sh" > "$WORK/setup-campaigns.sh" || { echo "FAIL: setup script not on branch"; exit 1; }
echo "    DDL: $(wc -l < "$WORK/campaign-booking-ddl.sql") lines, sha256 $(sha256sum "$WORK/campaign-booking-ddl.sql" | cut -c1-12)"

echo "==> 2. DATABASE_URL (dashmani role) from apps/api/.env"
DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%%\?*}"
[ -n "$DBURL" ] || { echo "FAIL: no DATABASE_URL in apps/api/.env"; exit 1; }
ROLE=$(psql "$DBURL" -Atc "SELECT current_user" 2>&1) || { echo "FAIL: cannot connect: $ROLE"; exit 1; }
echo "    connected as: $ROLE"
[ "$ROLE" = "dashmani" ] || echo "    WARNING: expected the dashmani role (tables will be owned by $ROLE)"

echo "==> 3. Apply the DDL"
PGAPPNAME=campaign-ddl psql "$DBURL" -v ON_ERROR_STOP=1 -f "$WORK/campaign-booking-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
[ "$DDL_EXIT" -eq 0 ] || { echo "FAIL: DDL did not apply cleanly — see $WORK/apply.log"; exit 1; }

echo "==> 4. Verify"
COUNT=$(psql "$DBURL" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'campaign\_%' OR tablename='razorpay_webhook_events')")
echo "    campaign tables present: $COUNT (expected 7)"
psql "$DBURL" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'campaign\_%' OR tablename='razorpay_webhook_events') ORDER BY 1" | sed 's/^/      /'
[ "$COUNT" -eq 7 ] || { echo "FAIL: expected 7 tables"; exit 1; }

echo "==> 5. Server setup (ffmpeg, fonts, media folder, CAMPAIGN_MEDIA_DIR)"
bash "$WORK/setup-campaigns.sh" || { echo "FAIL: setup-campaigns.sh"; exit 1; }

echo
echo "ALL DONE — DDL applied as $ROLE, $COUNT tables, setup complete. Logs in $WORK. Safe to merge PR #192."
