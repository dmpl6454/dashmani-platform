#!/bin/bash
set -e

APP_DIR="/opt/dashmani-platform"
cd "$APP_DIR"

echo "==> Pulling latest code"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
git fetch origin main
git reset --hard origin/main

echo "==> Installing dependencies"
npm install --prefer-offline

echo "==> Building apps (sequential to manage memory)"
export NODE_OPTIONS="--max-old-space-size=900"
npx turbo build --concurrency=1
unset NODE_OPTIONS

echo "==> Restarting processes"
pm2 restart all
pm2 save

echo "==> Deploy complete"
