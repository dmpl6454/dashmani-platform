#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
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
for app in client internal hr jobs web creators sales billing; do
  echo "NEXT_PUBLIC_API_URL=https://api.digitalsukoon.com/v1" > "$APP_DIR/apps/$app/.env.local"
done

echo "==> Installing dependencies"
npm install --prefer-offline

echo "==> Regenerating Prisma client (needed when schema.prisma changes)"
npm run db:generate

# ── Build without touching what pm2 is serving (2026-11-02) ──────────────────
# The pm2-served Next apps (SERVED_APPS) build into .next-build (NEXT_DIST_DIR, read by their
# next.config.js) while pm2 keeps serving .next. The live .next is replaced only after EVERY
# build succeeded, one app at a time right before its own restart. Before this, the script
# deleted every .next up front: on 2026-11-02 the jobs build failed on a next/font download,
# the script stopped before any restart, and portal, hr and jobs answered HTTP 500 for ~15
# minutes because their .next was already gone. It also meant the portals served errors for
# the whole length of every build, even a successful one.
# The static exports (STATIC_APPS) are served by nginx from out/, which the build replaces
# only at its final export step; their .next is a build cache that nothing serves.
SERVED_APPS="internal client hr jobs"
STATIC_APPS="web creators sales billing"

# Every build starts from an empty build dir. Next.js 14's collectBuildTraces step fails with
# `ENOENT: ... page.js.nft.json` when a partial dir from an interrupted/OOM-killed build is on
# disk (the reason for the old wipe, 2026-05-22). The served apps' build dir is .next-build,
# so the live .next is never part of this. .next.old is a leftover of an interrupted swap.
clear_build_dirs() {
  for app in $SERVED_APPS; do rm -rf "apps/$app/.next-build" "apps/$app/.next.old"; done
  for app in $STATIC_APPS; do rm -rf "apps/$app/.next"; done
}

echo "==> Clearing stale Next.js build dirs (the served .next folders stay in place)"
clear_build_dirs

echo "==> Building apps (sequential to manage memory)"
export NODE_OPTIONS="--max-old-space-size=900"
export NEXT_DIST_DIR=".next-build"
# One retry: a transient failure (a network fetch during the build, an OOM kill on the 2 GB
# box) should not fail the deploy. The retry starts from empty build dirs again; apps that
# already built come straight back from Turbo's cache. A second failure stops the deploy with
# nothing swapped and nothing restarted, so every portal keeps serving its previous build.
if ! npx turbo build --concurrency=1; then
  echo "==> Build failed — retrying once"
  clear_build_dirs
  if ! npx turbo build --concurrency=1; then
    echo "==> Build failed twice — nothing was swapped or restarted; every portal is still serving its previous build"
    exit 1
  fi
fi
unset NODE_OPTIONS NEXT_DIST_DIR

# Refuse to swap anything unless every served app has a complete build: half the portals on
# the new code and half on the old is worse than all of them staying on the old one.
for app in $SERVED_APPS; do
  if [ ! -f "apps/$app/.next-build/BUILD_ID" ]; then
    echo "==> apps/$app/.next-build has no BUILD_ID — nothing was swapped or restarted"
    exit 1
  fi
done

# Put the new build in place. The old .next is renamed, not deleted, until its process has
# restarted: the running server reads files from .next on demand, so the window where it sees
# the new files is only the second between this rename and its own `pm2 restart`.
swap_build() {
  if [ -e "apps/$1/.next" ]; then mv "apps/$1/.next" "apps/$1/.next.old"; fi
  mv "apps/$1/.next-build" "apps/$1/.next"
}

# apps/web (digitalsukoon.com), apps/creators (creators.digitalsukoon.com), apps/sales (sales.digitalsukoon.com)
# and apps/billing (billing.digitalsukoon.com, 2026-11-07) are static
# exports: the build above rewrote each one's out/, which nginx serves
# directly — they have no pm2 process and need no restart (so neither is in the loop below).
# The exports are world-readable so nginx (www-data) can serve them.
chmod -R o+rX apps/web/out 2>/dev/null || true
chmod -R o+rX apps/creators/out 2>/dev/null || true
chmod -R o+rX apps/sales/out 2>/dev/null || true
chmod -R o+rX apps/billing/out 2>/dev/null || true

echo "==> Restarting processes"
# Restart the platform's own processes ONE NAME PER INVOCATION — never `pm2 restart all`,
# and never one multi-name call. The box hosts other tenants' pm2 apps (2026-09-08:
# ds-sales-agent/worker, deliberately stopped after they starved the API into an OOM kill)
# and `restart all` REVIVES stopped apps. ⚠️ So does a multi-name call: on this box
# `pm2 restart api internal client hr jobs` cycled EVERY process in id order, stopped ones
# included (pm2.log 2026-09-08 15:43) — it behaved exactly like `all`. A single-name
# `pm2 restart <name>` touches only that process (verified).
# Each served app's new build is swapped in right before its own restart (see swap_build).
pm2 restart api
for app in $SERVED_APPS; do
  swap_build "$app"
  pm2 restart "$app"
done
pm2 save
for app in $SERVED_APPS; do rm -rf "apps/$app/.next.old"; done

echo "==> Deploy complete"
