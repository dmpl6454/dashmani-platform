#!/bin/bash
# One-time server setup for the billing portal (billing.digitalsukoon.com → apps/billing, 2026-11-07).
# Run on the production box as root AFTER the billing-portal code has been deployed to main:
#   sudo bash /opt/dashmani-platform/scripts/setup-billing.sh
#
# What it does:
#   1. Builds apps/billing if apps/billing/out is missing. (The deploy that introduces an app to
#      scripts/deploy.sh runs the OLD deploy.sh — bash had already read it — so the first build of
#      a new static export is always this manual one.)
#   2. Installs nginx/billing.digitalsukoon.com as an nginx site, runs `nginx -t`, reloads gracefully.
#   3. Appends BILLING_APP_URL=https://billing.digitalsukoon.com to apps/api/.env if it is missing
#      (backup first; append-only). The API reads it for CORS and for the portal directory
#      (GET /auth/portals, the handoff Sales ↔ Billing), so `pm2 restart api` must follow.
# It does NOT restart any pm2 process. Re-running it is safe: present keys are left untouched.
# A copy of scripts/setup-creators.sh without the creator-specific keys.
set -euo pipefail

APP_DIR="/opt/dashmani-platform"
SITE="billing.digitalsukoon.com"
ENV_FILE="$APP_DIR/apps/api/.env"

if [ ! -f "$APP_DIR/apps/billing/out/index.html" ]; then
  echo "==> apps/billing/out missing — building the site"
  cd "$APP_DIR"
  echo "NEXT_PUBLIC_API_URL=https://api.digitalsukoon.com/v1" > "$APP_DIR/apps/billing/.env.local"
  NODE_OPTIONS="--max-old-space-size=900" npx turbo build --filter=@dashmani/billing
fi

for f in /etc/ssl/cloudflare-cert.pem /etc/ssl/cloudflare-key.pem; do
  [ -f "$f" ] || { echo "Missing $f (Cloudflare origin certificate)"; exit 1; }
done

echo "==> nginx site $SITE"
# ⚠️ Test BEFORE leaving the site enabled: a broken file left in sites-enabled does not stop the
# running nginx, but the NEXT reload by anyone (certbot, another site's setup) would fail for
# every site on this box — api, portal, hr, client. On a failed test everything this script
# changed is put back exactly as it was (a re-run never removes a site that was already working).
if [ -d /etc/nginx/sites-available ]; then
  TARGET="/etc/nginx/sites-available/$SITE"
  ENABLED="/etc/nginx/sites-enabled/$SITE"
else
  TARGET="/etc/nginx/conf.d/$SITE.conf"
  ENABLED="$TARGET"
fi
NGX_BACKUP=""
if [ -e "$TARGET" ]; then
  NGX_BACKUP="$(mktemp)"
  cp -p "$TARGET" "$NGX_BACKUP"
fi
LINK_EXISTED=0
if [ "$ENABLED" != "$TARGET" ] && [ -L "$ENABLED" ]; then LINK_EXISTED=1; fi
cp "$APP_DIR/nginx/$SITE" "$TARGET"
[ "$ENABLED" = "$TARGET" ] || ln -sf "$TARGET" "$ENABLED"

# nginx (often www-data) must be able to read the export.
chmod o+x /opt "$APP_DIR" "$APP_DIR/apps" "$APP_DIR/apps/billing" || true
chmod -R o+rX "$APP_DIR/apps/billing/out"

if ! nginx -t; then
  if [ -n "$NGX_BACKUP" ]; then
    cp -p "$NGX_BACKUP" "$TARGET"          # the previous version of this site, back as it was
  else
    rm -f "$TARGET"
  fi
  [ "$LINK_EXISTED" = 1 ] || [ "$ENABLED" = "$TARGET" ] || rm -f "$ENABLED"
  echo "nginx -t failed — the billing site was put back exactly as it was before this run; nothing was reloaded."
  echo "If the failure names a DIFFERENT site, that one is broken on its own. Fix it (or nginx/$SITE) and re-run."
  exit 1
fi
[ -n "$NGX_BACKUP" ] && rm -f "$NGX_BACKUP"
systemctl reload nginx || nginx -s reload
echo "    nginx now serves $SITE from $APP_DIR/apps/billing/out"

echo "==> apps/api/.env BILLING_APP_URL"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
BACKUP="$ENV_FILE.bak-billing-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"
ADDED=0
# ⚠️ Append only (`>>`), each value on a fresh line: a single `>` would truncate the file and
# wipe every secret in it, and the leading \n keeps a key from joining a last line that has no
# trailing newline. A key that is already present is never rewritten.
add_key() {
  local key="$1" value="$2"
  if grep -q "^$key=." "$ENV_FILE"; then
    echo "    $key: already set (left as is)"
  elif grep -q "^$key=" "$ENV_FILE"; then
    echo "    $key: present but EMPTY — left as is; fill it in by hand (a second line would be ambiguous)"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "    $key: added"
    ADDED=1
  fi
}
add_key BILLING_APP_URL "https://$SITE"
if [ "$ADDED" = "0" ]; then
  rm -f "$BACKUP"
  echo "    nothing added (no backup kept)"
else
  echo "    backup of the previous file: $BACKUP"
fi

cat <<EOF

==> Manual steps (once)
 1. Cloudflare → digitalsukoon.com zone → DNS: add an A record 'billing' → this server's IP
    (172.105.53.101), proxied (orange cloud). SSL mode stays Full (strict) with the same origin
    certificate the other subdomains use — its names: $(openssl x509 -in /etc/ssl/cloudflare-cert.pem -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ' || echo '(could not read)')
    Check: curl -sk --resolve $SITE:443:127.0.0.1 https://$SITE/ | head -c 300
 2. Restart the API so it reads BILLING_APP_URL (CORS + the portal switchers):  pm2 restart api
    Until then the billing pages answer "Couldn't reach the server" (CORS) and the Portals menu
    on the other portals does not list Billing.
 3. Open https://$SITE/login, sign in with a Sales-role account, and from the sales portal's
    dashboard click an invoice tile: it must land on the billing portal already signed in.
EOF
