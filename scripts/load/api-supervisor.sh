#!/usr/bin/env bash
# Restarts the API after it exits — stands in for pm2 in the harness (the mid-run
# `kill -INT` + restart). Uses the PROD command line: node with the tsx preflight +
# loader (CLAUDE.md 2026-09-08), entry = the harness wrapper that starts the
# event-loop / synthetic-cron probe and then imports apps/api/src/index.ts.
cd /app
while true; do
  node --max-old-space-size=${API_HEAP_MB:-900} \
    --require /app/node_modules/tsx/dist/preflight.cjs \
    --import file:///app/node_modules/tsx/dist/loader.mjs \
    scripts/load/api-entry.ts
  echo "[supervisor] api exited with $? — restarting in 1s"
  sleep 1
done
