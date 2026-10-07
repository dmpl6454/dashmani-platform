#!/bin/bash
# One-time setup for the public marketing site (digitalsukoon.com → apps/web).
# Run on the production box as root AFTER the apps/web code has been deployed to main:
#   sudo bash /opt/dashmani-platform/scripts/setup-website.sh
#
# What it does:
#   1. Builds apps/web if apps/web/out is missing (normally scripts/deploy.sh has built it).
#   2. Installs nginx/digitalsukoon.com as an nginx site, runs `nginx -t`, reloads gracefully.
# It does NOT restart any pm2 process. Re-running it is safe.
#
# After this, point DNS at the box (Cloudflare → digitalsukoon.com zone): set the `@` and
# `www` A records to this server's IP, proxied (orange cloud), SSL mode Full (strict).
set -euo pipefail

APP_DIR="/opt/dashmani-platform"
SITE="digitalsukoon.com"

if [ ! -f "$APP_DIR/apps/web/out/index.html" ]; then
  echo "==> apps/web/out missing — building the site"
  cd "$APP_DIR"
  NODE_OPTIONS="--max-old-space-size=900" npx turbo build --filter=@dashmani/web
fi

for f in /etc/ssl/cloudflare-cert.pem /etc/ssl/cloudflare-key.pem; do
  [ -f "$f" ] || { echo "Missing $f (Cloudflare origin certificate)"; exit 1; }
done

if [ -d /etc/nginx/sites-available ]; then
  cp "$APP_DIR/nginx/$SITE" "/etc/nginx/sites-available/$SITE"
  ln -sf "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"
else
  cp "$APP_DIR/nginx/$SITE" "/etc/nginx/conf.d/$SITE.conf"
fi

# nginx (often www-data) must be able to read the export.
chmod o+x /opt "$APP_DIR" "$APP_DIR/apps" "$APP_DIR/apps/web" || true
chmod -R o+rX "$APP_DIR/apps/web/out"

nginx -t
systemctl reload nginx || nginx -s reload

echo "==> nginx now serves $SITE from $APP_DIR/apps/web/out"
echo "    Check on the box: curl -sk --resolve $SITE:443:127.0.0.1 https://$SITE/ | head -c 300"
