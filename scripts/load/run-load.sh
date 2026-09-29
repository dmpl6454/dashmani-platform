#!/usr/bin/env bash
# One-shot driver for the pipeline load harness (spec §11). Local only.
#   bash scripts/load/run-load.sh [minutes]      # default 10 → baseline (pipeline off) then enabled
set -euo pipefail
cd "$(dirname "$0")/../.."
MIN="${1:-10}"
HERE=scripts/load
RUN=$HERE/.run
COMPOSE="docker compose -f $HERE/docker-compose.load.yml"
export DATABASE_URL="postgresql://load:load@localhost:55432/dashmani_load"
mkdir -p "$RUN/certs"
if [ ! -f "$RUN/certs/cert.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$RUN/certs/key.pem" -out "$RUN/certs/cert.pem" 2>/dev/null
fi
export NODE_EXTRA_CA_CERTS="$PWD/$RUN/certs/cert.pem"
$COMPOSE build api
$COMPOSE up -d postgres
until docker exec dashmani-load-postgres-1 pg_isready -U load -d dashmani_load >/dev/null 2>&1; do sleep 1; done
( cd packages/db && npx prisma db push --skip-generate >/dev/null )
npx tsx $HERE/pipeline-load.ts seed
$COMPOSE up -d api nginx cotenant
npx tsx $HERE/pipeline-load.ts run --label=baseline --pipeline=off --minutes="$MIN"
npx tsx $HERE/pipeline-load.ts seed
npx tsx $HERE/pipeline-load.ts run --label=enabled --pipeline=on --minutes="$MIN"
$COMPOSE down -v
