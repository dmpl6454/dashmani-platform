#!/bin/bash
# One-time server setup for self-serve campaign booking (client portal "Campaigns").
# Run on the production box as root. Safe to re-run.
#   sudo bash /opt/dashmani-platform/scripts/setup-campaigns.sh
#
# What it does:
#   1. Installs ffmpeg (overlay render + ffprobe) and fonts-noto-core (the overlay font).
#   2. Creates the private media folder (NOT under uploads/, which is public).
#   3. Adds CAMPAIGN_MEDIA_DIR to apps/api/.env if missing.
#   4. Checks the API's nginx body limit fits an 8 MB upload chunk.
# It does NOT write Razorpay keys (add them by hand, see below) and does NOT restart anything.
#
# Before the code is merged, apply the schema by hand as the dashmani role:
#   PGAPPNAME=campaign-ddl psql "$DBURL" -v ON_ERROR_STOP=1 -f scripts/campaign-booking-ddl.sql
# After the deploy, load the rate card from the owner's sheet (dry run first, read the list of
# unmatched pages, then apply):
#   cd /opt/dashmani-platform/packages/db && npx tsx ../../scripts/import-campaign-rate-cards.ts
#   npx tsx ../../scripts/import-campaign-rate-cards.ts --apply --confirm-prod
set -euo pipefail

APP_DIR="/opt/dashmani-platform"
MEDIA_DIR="/var/lib/dashmani/campaign-media"
ENV_FILE="$APP_DIR/apps/api/.env"

echo "==> Installing ffmpeg + Noto fonts"
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg fonts-noto-core >/dev/null
ffmpeg -hide_banner -version | head -1
ls /usr/share/fonts/truetype/noto/NotoSans-Bold.ttf

echo "==> Media folder $MEDIA_DIR"
mkdir -p "$MEDIA_DIR"/{tmp,orig,render}
chmod 700 "$MEDIA_DIR" "$MEDIA_DIR"/{tmp,orig,render}

if ! grep -q '^CAMPAIGN_MEDIA_DIR=' "$ENV_FILE"; then
  printf '\n# Campaign booking media (private; never under uploads/)\nCAMPAIGN_MEDIA_DIR=%s\n' "$MEDIA_DIR" >> "$ENV_FILE"
  echo "    added CAMPAIGN_MEDIA_DIR to apps/api/.env"
fi

echo "==> nginx body limit for the API (needs >= 9m for 8 MB chunks)"
grep -Rhs "client_max_body_size" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ /etc/nginx/nginx.conf || echo "    (none set — nginx default is 1m: raise it to at least 9m on the api server block)"

for k in RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET; do
  if grep -q "^$k=" "$ENV_FILE"; then echo "    $k: set"; else echo "    $k: MISSING — add it to apps/api/.env, then pm2 restart api"; fi
done

df -h "$MEDIA_DIR" | tail -1
echo "Done. Razorpay webhook URL: https://api.digitalsukoon.com/v1/webhooks/razorpay"
echo "Events: payment.captured, payment.failed, order.paid, refund.processed, refund.failed"
