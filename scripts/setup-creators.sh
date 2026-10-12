#!/bin/bash
# One-time server setup for the creator portal (creators.digitalsukoon.com → apps/creators).
# Run on the production box as root AFTER the creator-portal code has been deployed to main:
#   sudo bash /opt/dashmani-platform/scripts/setup-creators.sh
#
# What it does:
#   1. Builds apps/creators if apps/creators/out is missing (normally scripts/deploy.sh has built it).
#   2. Installs nginx/creators.digitalsukoon.com as an nginx site, runs `nginx -t`, reloads gracefully.
#   3. Adds the creator keys that are MISSING to apps/api/.env (backup first; append-only, never
#      rewrites a line): CREATORS_APP_URL, CREATOR_JWT_SECRET, CREATOR_JWT_REFRESH_SECRET
#      (both generated with `openssl rand -hex 32`), META_CREATOR_REDIRECT_URI.
# It does NOT set CREATORS_ENABLED (switching the portal on is a separate, deliberate step) and
# does NOT restart any pm2 process. Re-running it is safe: present keys are left untouched.
#
# Before the code is merged, the schema is applied by hand with scripts/apply-creators-ddl.sh.
set -euo pipefail

APP_DIR="/opt/dashmani-platform"
SITE="creators.digitalsukoon.com"
ENV_FILE="$APP_DIR/apps/api/.env"

if [ ! -f "$APP_DIR/apps/creators/out/index.html" ]; then
  echo "==> apps/creators/out missing — building the site"
  cd "$APP_DIR"
  echo "NEXT_PUBLIC_API_URL=https://api.digitalsukoon.com/v1" > "$APP_DIR/apps/creators/.env.local"
  NODE_OPTIONS="--max-old-space-size=900" npx turbo build --filter=@dashmani/creators
fi

for f in /etc/ssl/cloudflare-cert.pem /etc/ssl/cloudflare-key.pem; do
  [ -f "$f" ] || { echo "Missing $f (Cloudflare origin certificate)"; exit 1; }
done

echo "==> nginx site $SITE"
# ⚠️ Test BEFORE leaving the site enabled: a broken file left in sites-enabled does not stop the
# running nginx, but the NEXT reload by anyone (certbot, another site's setup) would fail for
# every site on this box — api, portal, hr, client. On a failed test the new file is removed.
if [ -d /etc/nginx/sites-available ]; then
  ENABLED="/etc/nginx/sites-enabled/$SITE"
  cp "$APP_DIR/nginx/$SITE" "/etc/nginx/sites-available/$SITE"
  ln -sf "/etc/nginx/sites-available/$SITE" "$ENABLED"
else
  ENABLED="/etc/nginx/conf.d/$SITE.conf"
  cp "$APP_DIR/nginx/$SITE" "$ENABLED"
fi

# nginx (often www-data) must be able to read the export.
chmod o+x /opt "$APP_DIR" "$APP_DIR/apps" "$APP_DIR/apps/creators" || true
chmod -R o+rX "$APP_DIR/apps/creators/out"

if ! nginx -t; then
  rm -f "$ENABLED"
  echo "nginx -t failed with the new site — it was removed again, nothing reloaded. Fix nginx/$SITE and re-run."
  exit 1
fi
systemctl reload nginx || nginx -s reload
echo "    nginx now serves $SITE from $APP_DIR/apps/creators/out"

echo "==> apps/api/.env creator keys"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
BACKUP="$ENV_FILE.bak-creators-$(date +%Y%m%d-%H%M%S)"
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
add_key CREATORS_APP_URL "https://$SITE"
# Generated only when absent: rotating them signs every creator out, so a re-run must not.
# The values are written to the file and never printed.
# Two DIFFERENT values, and never JWT_SECRET's: see the creator-jwt.ts header.
add_key CREATOR_JWT_SECRET "$(openssl rand -hex 32)"
add_key CREATOR_JWT_REFRESH_SECRET "$(openssl rand -hex 32)"
add_key META_CREATOR_REDIRECT_URI "https://api.digitalsukoon.com/v1/creator/meta/oauth/callback"
if [ "$ADDED" = "0" ]; then
  rm -f "$BACKUP"
  echo "    nothing added (no backup kept)"
else
  echo "    backup of the previous file: $BACKUP"
fi
# Read, never written here: the Meta app (shared with the admin connect) and Google sign-in.
for k in META_OAUTH_APP_ID META_OAUTH_APP_SECRET META_TOKEN_ENC_KEY GOOGLE_CLIENT_ID; do
  if grep -q "^$k=." "$ENV_FILE"; then
    echo "    $k: set"
  elif [ "$k" = GOOGLE_CLIENT_ID ]; then
    echo "    $k: missing — the creator portal shows no Google button (password sign-up still works)"
  else
    echo "    $k: MISSING — 'Connect Facebook' answers 503 META_NOT_CONFIGURED without it"
  fi
done
if grep -q '^CREATORS_ENABLED=1' "$ENV_FILE"; then
  echo "    CREATORS_ENABLED=1 — the portal is ON"
else
  echo "    CREATORS_ENABLED is not 1 — the portal stays dark (every /v1/creator/* answers 503)"
fi

cat <<EOF

==> Manual steps (once)
 1. Cloudflare → digitalsukoon.com zone → DNS: add an A record 'creators' → this server's IP,
    proxied (orange cloud). SSL mode stays Full (strict) with the same origin certificate the other
    subdomains use — its names: $(openssl x509 -in /etc/ssl/cloudflare-cert.pem -noout -ext subjectAltName 2>/dev/null | tail -n +2 | tr -d ' ' || echo '(could not read)')
    Check: curl -sk --resolve $SITE:443:127.0.0.1 https://$SITE/ | head -c 300
 2. Google Cloud → the OAuth client behind GOOGLE_CLIENT_ID → Authorized JavaScript origins:
    add https://$SITE (no trailing slash).
 3. Meta App Dashboard (app "Post Automation 2", unless CREATOR_META_APP_ID splits it out):
    - Facebook Login → Settings → Valid OAuth Redirect URIs: add
        https://api.digitalsukoon.com/v1/creator/meta/oauth/callback
    - App settings → Basic → Deauthorize callback URL:
        https://api.digitalsukoon.com/v1/meta/deauthorize
      Data deletion request URL:
        https://api.digitalsukoon.com/v1/meta/data-deletion
      ⚠️ These two fields are ONE value each for the whole app, which postautomation.co.in also
      uses: setting them REPLACES whatever is there. Read the current values first; on
      2026-10-12 the data-deletion URL was a placeholder. If postautomation has a real handler,
      agree with its owner which endpoint forwards to the other before changing either.
    - ⚠️ Never test the creator connect with a Facebook account that holds one of our staff Meta
      connections (Account Growth). It is refused, but Facebook's Page picker on the way can
      already have narrowed that account's grant to this app — the Account Growth channels then
      silently lose Pages. Use a separate test Facebook account.
    - Contact email, Privacy Policy URL and Terms of Service URL are APP-WIDE and shared with
      postautomation.co.in: make sure the published policy covers creators.digitalsukoon.com
      before switching the portal on.
 4. Restart the API so it reads the new keys:  pm2 restart api
 5. Switching the portal ON is a separate step, after the checks above:
      grep -q '^CREATORS_ENABLED=' $ENV_FILE && sed -i 's/^CREATORS_ENABLED=.*/CREATORS_ENABLED=1/' $ENV_FILE \
        || printf '\nCREATORS_ENABLED=1\n' >> $ENV_FILE
      pm2 restart api
    Off again (the kill switch): set that line to CREATORS_ENABLED=0 and pm2 restart api.
EOF
