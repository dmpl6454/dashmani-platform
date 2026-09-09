#!/bin/bash
set -e

APP_DIR="/opt/dashmani-platform"
cd "$APP_DIR"

echo "==> Pulling latest code"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
git fetch origin main

# ── Docs-only guard (2026-09-09) ─────────────────────────────────────────────
# A push that touches nothing the server runs — Markdown, .planning/, docs/, mobile/
# (not an npm workspace) or .github/ — must NOT rebuild and must NOT restart anything:
# every `pm2 restart` is a few seconds of 502 for whoever is mid-request, and the
# 2026-09-01…04 mobile commits alone caused 12 needless production restarts.
# Conservative: ANY changed path outside the allowlist → the full deploy below.
PREV_HEAD=$(git rev-parse HEAD)
CHANGED=$(git diff --name-only "$PREV_HEAD" origin/main)
# NOT_ALLOWED = every changed path outside the allowlist; docs-only ⇔ that set is empty.
# (Deliberately not `grep -q -v`: BSD grep misreports its exit status for -q -v.)
NOT_ALLOWED=$(echo "$CHANGED" | grep -vE '^(\.planning/|docs/|mobile/|\.github/)|\.md$' || true)
if [ -n "$CHANGED" ] && [ -z "$NOT_ALLOWED" ]; then
  echo "==> Docs/mobile-only change ($(echo "$CHANGED" | wc -l | tr -d ' ') file(s)) — syncing files, skipping build and restarts"
  git reset --hard origin/main
  echo "==> Deploy complete (no restart needed)"
  exit 0
fi

git reset --hard origin/main

echo "==> Writing production .env.local files for frontends"
# NEXT_PUBLIC_* vars are baked into the JS bundle at build time.
# If these point at localhost, the browser will fail with "Load failed" because
# it tries to connect to the user's own machine, not the server. Always
# overwrite on every deploy so the prod build is self-healing even after a
# fresh server provision or accidental local override.
for app in client internal hr jobs; do
  echo "NEXT_PUBLIC_API_URL=https://api.digitalsukoon.com/v1" > "$APP_DIR/apps/$app/.env.local"
done

echo "==> Installing dependencies"
npm install --prefer-offline

echo "==> Regenerating Prisma client (needed when schema.prisma changes)"
npm run db:generate

# Wipe Next.js build caches before each build. Next.js 14's collectBuildTraces
# step can fail with `ENOENT: ... page.js.nft.json` when a partial .next/ from
# an interrupted/OOM-killed build is on disk. Nuking it up front is the only
# reliable cure. The cost is one full (~uncached) build, ~60s extra.
echo "==> Clearing stale Next.js build caches"
rm -rf apps/client/.next apps/internal/.next apps/hr/.next apps/jobs/.next

echo "==> Building apps (sequential to manage memory)"
export NODE_OPTIONS="--max-old-space-size=900"
npx turbo build --concurrency=1
unset NODE_OPTIONS

echo "==> Restarting processes"
# Restart the platform's own processes ONE NAME PER INVOCATION — never `pm2 restart all`,
# and never one multi-name call. The box hosts other tenants' pm2 apps (2026-09-08:
# ds-sales-agent/worker, deliberately stopped after they starved the API into an OOM kill)
# and `restart all` REVIVES stopped apps. ⚠️ So does a multi-name call: on this box
# `pm2 restart api internal client hr jobs` cycled EVERY process in id order, stopped ones
# included (pm2.log 2026-09-08 15:43) — it behaved exactly like `all`. A single-name
# `pm2 restart <name>` touches only that process (verified).
for app in api internal client hr jobs; do
  pm2 restart "$app"
done
pm2 save

echo "==> Deploy complete"
