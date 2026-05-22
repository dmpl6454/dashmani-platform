#!/bin/bash
set -e

APP_DIR="/opt/dashmani-platform"
cd "$APP_DIR"

echo "==> Pulling latest code"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
git fetch origin main
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
pm2 restart all
pm2 save

echo "==> Deploy complete"
