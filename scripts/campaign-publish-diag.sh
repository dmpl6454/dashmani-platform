#!/bin/bash
# Read-only diagnostic: why are approved campaign posts not live on the Pages?
#
# Run it ON the production box as root (ssh dashmani-prod), one command:
#
#   cd /opt/dashmani-platform && bash scripts/campaign-publish-diag.sh
#
# (or BOOKING=<id prefix> bash scripts/campaign-publish-diag.sh to look at one campaign)
#
# STRICTLY READ-ONLY. It changes nothing: every database session runs with
# default_transaction_read_only=on and a 15 s statement_timeout; it restarts nothing, writes no
# file, and makes one HTTP GET to the API's own /v1/health. It NEVER prints a secret:
#   - the config section reads ONLY the seven non-secret keys listed in KEYS, one exact key at a
#     time, from apps/api/.env and from /proc/<api pid>/environ (never `pm2 env` / `pm2 show`,
#     which print every secret);
#   - no token column is ever selected: the *_enc columns are only tested with IS NULL to show
#     whether a token exists (yes/no);
#   - DATABASE_URL is used to connect and is never printed;
#   - every line it prints from the database or the pm2 log goes through redact() as a backstop.
#
# How the code decides (origin/main 87ad86b):
#   - apps/api/src/env.ts:4-15 loads apps/api/.env ONCE at start; dotenv never overrides a
#     variable already in the process environment. So the RUNNING process is what matters: an
#     edit to .env does nothing until `pm2 restart api`.
#   - config.ts:59 auto-publishing is on only when CAMPAIGN_PUBLISH_ENABLED is exactly "1".
#   - review.service.ts approve(): each pending account becomes `queued` (auto) or
#     `manual_pending` ("To post", staff post by hand) with the reason in last_error (since the
#     2026-10-12 change; older rows carry it only as a "Post by hand on …" event, and only if
#     auto-publishing was on). publish.service.ts:63 makes EVERY account manual_pending while
#     auto-publishing is off. A manual_pending account stays that way even
#     if auto-publishing is switched on later, until staff press "Try auto-publish"
#     (apps/internal/src/app/campaigns/[id]/page.tsx:346 -> review.service.ts:262-283).
#   - cron/campaign.cron.ts:16 CAMPAIGN_CRONS_ENABLED=0 never starts the worker; :26-32 the publish
#     tick runs every 60 s from 3 min after boot; publish.service.ts:526 it returns at once
#     while CAMPAIGN_PUBLISH_ENABLED is not 1.
#   - publish.service.ts:112-117 a queued account is due on launch day at CAMPAIGN_PUBLISH_HOUR_IST
#     (default 10:00 IST), or at once after "Publish now".
#
# Overrides (local rehearsal only): APP_DIR, PM2_APP (default api), SKIP_PM2=1 (skip the
# running-process and pm2-log checks), BOOKING=<id or id prefix> (look at one booking only).
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
PM2_APP="${PM2_APP:-api}"
SKIP_PM2="${SKIP_PM2:-0}"
BOOKING="${BOOKING:-}"
PORTAL="https://portal.digitalsukoon.com"
ENV_FILE="$APP_DIR/apps/api/.env"
KEYS=(CAMPAIGN_PUBLISH_ENABLED CAMPAIGN_CRONS_ENABLED CAMPAIGN_RENDER_ENABLED CAMPAIGN_PUBLISH_HOUR_IST CAMPAIGN_PUBLISH_BATCH API_PUBLIC_URL CAMPAIGN_PAYMENT_MODE)

export PGCONNECT_TIMEOUT=10
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000'
export PGAPPNAME=campaign-publish-diag

hr() { echo; echo "==> $*"; }
ind() { sed 's/^/    /'; }
# Backstop only: nothing selected here should contain a secret, but never let one through.
redact() {
  sed -E \
    -e 's/(access_token=)[^&" ]+/\1[redacted]/g' \
    -e 's/EAA[A-Za-z0-9]{20,}/[redacted-meta-token]/g' \
    -e 's#(Bearer |OAuth )[A-Za-z0-9._~+/=-]{12,}#\1[redacted]#g' \
    -e 's#(postgres(ql)?://[^:/@ ]+:)[^@ ]+@#\1[redacted]@#g' \
    -e 's/([?&]sig=)[A-Za-z0-9_-]{16,}/\1[redacted]/g' \
    -e 's/enc:v1:[A-Za-z0-9+/=:._-]+/enc:v1:[redacted]/g' \
    -e 's/(sk-[A-Za-z]*-?)[A-Za-z0-9_-]{16,}/\1[redacted]/g'
}

echo "Campaign publishing diagnostic — read-only — $(date -u '+%Y-%m-%d %H:%M UTC') / $(TZ=Asia/Kolkata date '+%d %b %H:%M IST')"
echo "APP_DIR=$APP_DIR  PM2_APP=$PM2_APP  SKIP_PM2=$SKIP_PM2${BOOKING:+  BOOKING=$BOOKING}"
[ -d "$APP_DIR" ] || echo "WARNING: $APP_DIR does not exist — is this the prod box? (ssh dashmani-prod)"
if [ -d "$APP_DIR/.git" ]; then
  echo "checkout: $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?') ($(git -C "$APP_DIR" log -1 --format=%cd --date=short 2>/dev/null || echo '?'))"
fi

# ─── 1. Config ──────────────────────────────────────────────────────────────────────────────
hr "1. Config (only these non-secret keys are read)"

# Value of KEY in apps/api/.env as dotenv parses it (last assignment wins; quotes stripped).
# Prints nothing and returns 1 when the key is absent.
envfile_val() {
  local key="$1" line v
  [ -r "$ENV_FILE" ] || return 1
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | tail -1)
  [ -n "$line" ] || return 1
  v="${line#*=}"; v="${v%$'\r'}"
  v="${v#"${v%%[![:space:]]*}"}"
  case "$v" in
    \"*) v="${v#\"}"; v="${v%%\"*}" ;;
    \'*) v="${v#\'}"; v="${v%%\'*}" ;;
    *) v="${v%%[[:space:]]#*}"; v="${v%"${v##*[![:space:]]}"}" ;;
  esac
  printf '%s' "$v"
}

API_PID=""
PROC_OK=0
PROC_NOTE=""
if [ "$SKIP_PM2" = "1" ]; then
  PROC_NOTE="skipped (SKIP_PM2=1)"
elif [ "$(id -u)" != "0" ]; then
  PROC_NOTE="not run as root — the API runs under root's pm2 (run: sudo -i, then this script)"
elif ! command -v pm2 >/dev/null 2>&1; then
  PROC_NOTE="pm2 not found on PATH"
else
  API_PID=$(pm2 pid "$PM2_APP" 2>/dev/null | grep -E '^[0-9]+$' | grep -v '^0$' | head -1)
  if [ -z "$API_PID" ]; then
    PROC_NOTE="pm2 reports no running process named '$PM2_APP' (is it stopped? check 'pm2 status')"
  elif [ ! -r "/proc/$API_PID/environ" ]; then
    PROC_NOTE="/proc/$API_PID/environ is not readable (run as root)"
  else
    PROC_OK=1
  fi
fi

# Value of KEY in the running process's environment. Reads ONLY that exact key.
proc_val() {
  local key="$1" line
  [ "$PROC_OK" = "1" ] || return 1
  line=$(tr '\0' '\n' < "/proc/$API_PID/environ" 2>/dev/null | grep -m1 -E "^${key}=")
  [ -n "$line" ] || return 1
  printf '%s' "${line#*=}"
}

PROC_START=""
ENV_MTIME=""
ENV_NEWER=0
if [ "$PROC_OK" = "1" ]; then
  PROC_START_TXT=$(ps -o lstart= -p "$API_PID" 2>/dev/null | sed 's/^ *//')
  PROC_START=$(date -d "$PROC_START_TXT" +%s 2>/dev/null || true)
  echo "running API: pid $API_PID, started ${PROC_START_TXT:-?}"
else
  echo "running API: not checked — $PROC_NOTE"
fi
if [ -r "$ENV_FILE" ]; then
  ENV_MTIME=$(stat -c %Y "$ENV_FILE" 2>/dev/null || true)
  echo "apps/api/.env: last modified $(date -d "@${ENV_MTIME:-0}" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null)"
  if [ -n "$PROC_START" ] && [ -n "$ENV_MTIME" ] && [ "$ENV_MTIME" -gt "$PROC_START" ]; then
    ENV_NEWER=1
    echo "    NOTE: .env was edited AFTER the API started — the running process still has the OLD values"
    echo "    for anything below that is not in its environment. 'pm2 restart api' would pick the file up."
  fi
else
  echo "apps/api/.env: NOT READABLE at $ENV_FILE"
fi

declare -A EFF=()     # effective value in the running process ("" = not set)
declare -A EFFSRC=()  # where it came from
printf '    %-27s %-32s %-32s %s\n' "KEY" "running process" "apps/api/.env (now)" "effective for the running API"
for k in "${KEYS[@]}"; do
  pv=""; fv=""; pset=0; fset=0
  if pv=$(proc_val "$k"); then pset=1; fi
  if fv=$(envfile_val "$k"); then fset=1; fi
  pshow="(not set)"; [ "$pset" = "1" ] && pshow="\"$pv\""
  [ "$PROC_OK" = "1" ] || pshow="(not checked)"
  fshow="(not set)"; [ "$fset" = "1" ] && fshow="\"$fv\""
  if [ "$pset" = "1" ]; then
    EFF[$k]="$pv"; EFFSRC[$k]="process env (wins over .env)"
  elif [ "$fset" = "1" ]; then
    EFF[$k]="$fv"
    if [ "$PROC_OK" != "1" ]; then EFFSRC[$k]=".env only — running process NOT checked"
    elif [ "$ENV_NEWER" = "1" ]; then EFFSRC[$k]=".env — UNCERTAIN, file edited after start"
    else EFFSRC[$k]=".env, loaded at start"; fi
  else
    EFF[$k]=""; EFFSRC[$k]="not set anywhere -> code default"
  fi
  printf '    %-27s %-32s %-32s %s\n' "$k" "$pshow" "$fshow" "${EFFSRC[$k]}" | redact
done

PUB="${EFF[CAMPAIGN_PUBLISH_ENABLED]}"
CRONS="${EFF[CAMPAIGN_CRONS_ENABLED]}"
PUB_ON=0; [ "$PUB" = "1" ] && PUB_ON=1
CRONS_ON=1; [ "$CRONS" = "0" ] && CRONS_ON=0
CONFIDENT=0
[ "$PROC_OK" = "1" ] && [ "$ENV_NEWER" = "0" ] && CONFIDENT=1
[ "$PROC_OK" = "1" ] && [ "${EFFSRC[CAMPAIGN_PUBLISH_ENABLED]}" = "process env (wins over .env)" ] && CONFIDENT=1
echo "    meaning (code defaults when unset):"
echo "      auto-publish: $([ "$PUB_ON" = 1 ] && echo ON || echo "OFF (needs exactly \"1\", config.ts:59)")"
echo "      campaign workers (render/publish/retention): $([ "$CRONS_ON" = 1 ] && echo started || echo "NOT started (CAMPAIGN_CRONS_ENABLED=0, campaign.cron.ts:16)")"
echo "      render worker: $([ "${EFF[CAMPAIGN_RENDER_ENABLED]}" = "0" ] && echo "OFF (config.ts:44)" || echo on)"
echo "      publish hour: ${EFF[CAMPAIGN_PUBLISH_HOUR_IST]:-10}:00 IST on launch day; batch ${EFF[CAMPAIGN_PUBLISH_BATCH]:-3} per minute"
API_PUBLIC="${EFF[API_PUBLIC_URL]:-https://api.digitalsukoon.com}"; API_PUBLIC="${API_PUBLIC%/}"
echo "      media URL base Meta downloads from: $API_PUBLIC (config.ts:61)"
HC=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -A 'Mozilla/5.0 (campaign-publish-diag)' "$API_PUBLIC/v1/health" 2>/dev/null)
case "${HC:-000}" in
  200) HC_NOTE="" ;;
  000) HC_NOTE="  <- no answer: the API is not reachable at the address Meta downloads media from" ;;
  *) HC_NOTE="  <- unexpected; check the address (a 403/503 can also be Cloudflare challenging this box)" ;;
esac
echo "      GET $API_PUBLIC/v1/health from this box: HTTP ${HC:-000}$HC_NOTE"
echo "      (a check that the address answers — not proof Meta's own servers can fetch a signed media link)"

# ─── Database connection ────────────────────────────────────────────────────────────────────
DB_OK=0
# The LAST assignment wins (dotenv), from apps/api/.env — the file env.ts loads; root .env only as a fallback.
DBURL=$(grep -hE '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)
[ -n "$DBURL" ] || DBURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2-)
DBURL="${DBURL%$'\r'}"
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"; DBURL="${DBURL%\'}"; DBURL="${DBURL#\'}"; DBURL="${DBURL%%\?*}"
# Keep the password OFF psql's command line (visible to every local user in ps / /proc/*/cmdline,
# and this box has other tenants): move it to PGPASSWORD (root-only environ), percent-decoded.
if [[ "$DBURL" =~ ^(postgres(ql)?://)([^:@/]+):([^@]*)@(.*)$ ]]; then
  _enc="${BASH_REMATCH[4]}"
  PGPASSWORD="$(printf '%b' "${_enc//%/\\x}")"; export PGPASSWORD
  DBURL="${BASH_REMATCH[1]}${BASH_REMATCH[3]}@${BASH_REMATCH[5]}"
  unset _enc
fi
q() { psql "$DBURL" -X -At -F $'\t' -v ON_ERROR_STOP=1 -P pager=off -c "$1"; }
# Same, but fields separated by the ASCII unit separator (0x1f). Tab is IFS whitespace, so
# `IFS=$'\t' read` would merge two tabs and shift every field after an empty one.
US=$'\x1f'
qus() { psql "$DBURL" -X -At -F "$US" -v ON_ERROR_STOP=1 -P pager=off -c "$1"; }
show() { psql "$DBURL" -X -v ON_ERROR_STOP=1 -P pager=off -P footer=off -c "$1"; }
# Run one aligned query, print it indented; on failure say so and carry on.
section_sql() {
  local out
  if [ "$DB_OK" != "1" ]; then echo "    skipped: no database connection"; return; fi
  if out=$(show "$1" 2>&1); then
    if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then echo "    (none)"; else printf '%s\n' "$out" | redact | ind; fi
  else
    echo "    FAILED: $(printf '%s' "$out" | head -c 400 | redact)"
  fi
}
section_rows() {  # same, but unaligned (one preformatted line per row)
  local out
  if [ "$DB_OK" != "1" ]; then echo "    skipped: no database connection"; return; fi
  if out=$(psql "$DBURL" -X -At -v ON_ERROR_STOP=1 -P pager=off -c "$1" 2>&1); then
    if [ -z "$out" ]; then echo "    (none)"; else printf '%s\n' "$out" | redact | ind; fi
  else
    echo "    FAILED: $(printf '%s' "$out" | head -c 400 | redact)"
  fi
}

if [ -z "$DBURL" ]; then
  echo; echo "DATABASE: no DATABASE_URL in $ENV_FILE — database sections skipped"
else
  if CONNINFO=$(q "SELECT current_user || '@' || current_database() || ' (read-only: ' || current_setting('default_transaction_read_only') || ')'" 2>&1); then
    DB_OK=1; echo; echo "DATABASE: connected as $CONNINFO"
    case "$CONNINFO" in
      *"read-only: on)"*) ;;
      *) DB_OK=0; echo "DATABASE: the session is NOT read-only (PGOPTIONS was ignored) — refusing to run any query." ;;
    esac
  else
    echo; echo "DATABASE: cannot connect — $(printf '%s' "$CONNINFO" | head -c 300 | redact)"
  fi
fi

ist() { echo "coalesce(to_char((($1) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI'), '—')"; }
NOWU="(now() AT TIME ZONE 'UTC')"
BFILTER=""
if [ -n "$BOOKING" ]; then
  BK=$(printf '%s' "$BOOKING" | tr -cd '0-9a-fA-F-' | tr 'A-F' 'a-f')
  BFILTER="AND id LIKE '${BK}%'"
fi
RECENT="recent AS (SELECT id FROM campaign_bookings
  WHERE status IN ('approved','publishing','completed','partially_published','paid_pending_review') $BFILTER
  ORDER BY updated_at DESC LIMIT 10)"

# ─── 2. Bookings ────────────────────────────────────────────────────────────────────────────
hr "2. The 10 most recent bookings (approved / publishing / completed / partially_published / paid_pending_review)"
section_sql "WITH $RECENT
SELECT left(b.id,8) AS booking, left(b.name,40) AS campaign, left(c.company_name,30) AS client, b.status,
       coalesce(to_char(b.launch_from,'DD Mon'),'?') || ' .. ' || coalesce(to_char(b.launch_to,'DD Mon YYYY'),'?') AS launch_window_ist,
       $(ist b.approved_at) AS approved_ist,
       (SELECT count(*) FROM campaign_booking_items i WHERE i.booking_id=b.id) AS accounts,
       (SELECT count(*) FROM campaign_booking_items i WHERE i.booking_id=b.id AND i.status IN ('published','posted_manual')) AS live,
       CASE WHEN b.paid_at IS NULL THEN 'offline/unpaid' ELSE 'paid online' END AS payment
FROM campaign_bookings b JOIN recent r ON r.id=b.id JOIN clients c ON c.id=b.client_id
ORDER BY b.updated_at DESC"
if [ "$DB_OK" = "1" ]; then
  echo "    all bookings by status: $(q "SELECT coalesce(string_agg(status || '=' || n, ', ' ORDER BY status), 'none') FROM (SELECT status, count(*) n FROM campaign_bookings GROUP BY status) s" 2>&1 | head -c 400 | redact)"
fi

# ─── 3. Items ───────────────────────────────────────────────────────────────────────────────
hr "3. Accounts (items) of those bookings"
echo "    item statuses: manual_pending = 'To post' (staff post by hand) · queued = 'Auto-publish' (worker) ·"
echo "    published / posted_manual = live · failed / refunded = settled without a post (_ds.tsx:44-52)"
section_rows "WITH $RECENT
SELECT '[' || left(i.booking_id,8) || '] ' || i.account_name || coalesce(' @' || i.account_handle, '') || ' · ' || i.platform || '/' || i.format
       || ' · ' || i.status || ' · attempts ' || i.attempts
       || ' · next ' || $(ist i.next_attempt_at)
       || CASE WHEN i.locked_until > $NOWU THEN ' · LOCKED (being published) until ' || $(ist i.locked_until) ELSE '' END
       || CASE WHEN i.target_type <> 'meta_asset' THEN ' · target ' || i.target_type ELSE '' END
       || CASE WHEN i.last_error IS NOT NULL THEN E'\n      last_error: ' || left(regexp_replace(i.last_error, '\s+', ' ', 'g'), 160) ELSE '' END
       || CASE WHEN i.permalink IS NOT NULL THEN E'\n      link: ' || i.permalink ELSE '' END
FROM campaign_booking_items i JOIN recent r ON r.id=i.booking_id JOIN campaign_bookings b ON b.id=i.booking_id
ORDER BY b.updated_at DESC, i.created_at, i.account_name, i.id"

hr "3b. Media files of those bookings (an account waits while any of its files is still rendering — publish.service.ts:445-448)"
section_sql "WITH $RECENT
SELECT left(m.booking_id,8) AS booking, m.role, m.kind, m.upload_status, m.render_status, count(*) AS files,
       max(left(m.render_error,80)) AS render_error
FROM campaign_media m JOIN recent r ON r.id=m.booking_id
WHERE m.purged_at IS NULL
GROUP BY 1,2,3,4,5 ORDER BY 1,2,3"
if [ "$DB_OK" = "1" ]; then
  VAR=$(q "WITH $RECENT SELECT coalesce(string_agg(left(booking_id,8) || ' ' || status || '=' || n, ', '), 'none') FROM (SELECT v.booking_id, v.status, count(*) n FROM campaign_media_renders v JOIN recent r ON r.id=v.booking_id GROUP BY 1,2) s" 2>&1)
  echo "    per-account text renders: $(printf '%s' "$VAR" | head -c 400 | redact)"
fi

# ─── 4. Events ──────────────────────────────────────────────────────────────────────────────
hr "4. Last 15 booking events for those bookings (newest first)"
section_rows "WITH $RECENT
SELECT $(ist e.created_at) || '  [' || left(e.booking_id,8) || '] ' || e.actor_type
       || CASE WHEN e.to_status IS NOT NULL THEN ' ' || coalesce(e.from_status,'?') || ' -> ' || e.to_status ELSE '' END
       || coalesce('  ' || left(regexp_replace(e.note, '\s+', ' ', 'g'), 200), '')
FROM campaign_booking_events e JOIN recent r ON r.id=e.booking_id
ORDER BY e.created_at DESC LIMIT 15"

# ─── 5. Meta connections ────────────────────────────────────────────────────────────────────
hr "5. Meta connections (no token is selected; scopes shown as yes/no only)"
section_sql "SELECT left(c.id,8) AS connection, left(coalesce(c.meta_user_name,'?'),30) AS fb_user, c.status,
       $(ist c.revoked_at) AS revoked_ist,
       CASE WHEN 'instagram_content_publish' = ANY (SELECT btrim(s) FROM unnest(string_to_array(c.granted_scopes, ',')) s) THEN 'yes' ELSE 'NO' END AS ig_publish_scope,
       CASE WHEN 'pages_manage_posts' = ANY (SELECT btrim(s) FROM unnest(string_to_array(c.granted_scopes, ',')) s) THEN 'yes' ELSE 'NO' END AS fb_publish_scope,
       CASE WHEN c.user_token_enc IS NULL THEN 'NO' ELSE 'yes' END AS has_user_token,
       $(ist c.token_expires_at) AS login_token_expires_ist,
       $(ist c.data_access_expires_at) AS data_access_expires_ist,
       (SELECT count(*) FROM meta_assets a WHERE a.connection_id=c.id AND a.disconnected_at IS NULL) AS live_assets,
       left(regexp_replace(coalesce(c.last_error,''), '\s+', ' ', 'g'), 100) AS last_error
FROM meta_connections c ORDER BY c.created_at"
if [ "$DB_OK" = "1" ]; then
  echo "    Instagram accounts with no linked Page recorded (the publisher's fallback once the login token lapses;"
  echo "    the daily token check fills these): $(q "SELECT count(*) FILTER (WHERE parent_page_id IS NULL) || ' of ' || count(*) FROM meta_assets WHERE kind::text='INSTAGRAM_ACCOUNT' AND disconnected_at IS NULL" 2>&1 | head -c 200)"
fi

# ─── 6. Target assets ───────────────────────────────────────────────────────────────────────
hr "6. Each account's Meta asset, and what publish.service.ts checkEligibility (:62-109) would say"
echo "    (mirrors the code's checks in order, apart from the on/off switch and decrypting the token;"
echo "     it answers 'could the API publish this account if auto-publishing were on')"
section_rows "WITH $RECENT,
items AS (
  SELECT i.*, b.audio_integration,
    EXISTS (SELECT 1 FROM campaign_media m WHERE m.booking_id=i.booking_id AND m.purged_at IS NULL AND m.role <> 'thumbnail') AS has_creative,
    EXISTS (SELECT 1 FROM campaign_media m WHERE m.booking_id=i.booking_id AND m.purged_at IS NULL AND m.role <> 'thumbnail' AND m.kind='video') AS has_video,
    EXISTS (SELECT 1 FROM campaign_media m WHERE m.booking_id=i.booking_id AND m.purged_at IS NULL AND m.role = 'thumbnail') AS has_thumb
  FROM campaign_booking_items i JOIN recent r ON r.id=i.booking_id JOIN campaign_bookings b ON b.id=i.booking_id
)
SELECT '[' || left(i.booking_id,8) || '] ' || i.account_name || ' (' || i.platform || '/' || i.format || ') -> '
  || CASE WHEN i.target_type <> 'meta_asset' THEN 'target is a ' || i.target_type || ' (not a connected Meta asset)'
          WHEN a.id IS NULL THEN 'meta_assets row MISSING'
          ELSE a.kind::text || ' \"' || a.name || '\" selected=' || a.selected::text
               || ' disconnected=' || $(ist a.disconnected_at)
               || ' · connection ' || coalesce(left(c.id,8),'MISSING') || ' ' || coalesce(c.status::text,'?')
               || CASE WHEN c.revoked_at IS NOT NULL THEN ' REVOKED ' || $(ist c.revoked_at) ELSE '' END
               || CASE WHEN a.kind::text='FACEBOOK_PAGE' THEN ' · page token ' || CASE WHEN a.page_token_enc IS NULL THEN 'NO' ELSE 'yes' END ELSE '' END
     END
  || E'\n      API could publish? ' ||
  CASE
    WHEN i.target_type <> 'meta_asset' OR i.platform NOT IN ('instagram','facebook') THEN 'no — This platform is posted by hand.'
    WHEN i.audio_integration AND i.format='reel' THEN 'no — Song audio integration has to be added in the app.'
    WHEN i.format='story' THEN 'no — Stories are posted by hand.'
    WHEN NOT i.has_creative THEN 'no — No prepared media.'
    WHEN i.platform='facebook' AND i.format='carousel' AND i.has_video THEN 'no — Facebook carousels can only hold images through the API.'
    WHEN i.platform='facebook' AND i.has_thumb AND i.has_video THEN 'no — client chose a thumbnail; Facebook video goes to staff.'
    WHEN a.id IS NULL OR a.disconnected_at IS NOT NULL OR NOT a.selected THEN 'no — The account is no longer connected.'
    WHEN c.id IS NULL OR c.revoked_at IS NOT NULL OR c.status::text IN ('REVOKED','NEEDS_REAUTH') THEN 'no — The Meta connection needs reconnecting.'
    WHEN NOT ((CASE WHEN i.platform='instagram' THEN 'instagram_content_publish' ELSE 'pages_manage_posts' END)
              = ANY (SELECT btrim(s) FROM unnest(string_to_array(c.granted_scopes, ',')) s))
      THEN 'no — the connection did not grant ' || CASE WHEN i.platform='instagram' THEN 'instagram_content_publish' ELSE 'pages_manage_posts' END
    WHEN i.platform='instagram' AND a.kind::text <> 'INSTAGRAM_ACCOUNT' THEN 'no — No Instagram token for this account.'
    WHEN i.platform='instagram' AND (c.user_token_enc IS NULL OR c.token_expires_at <= $NOWU)
         AND NOT EXISTS (SELECT 1 FROM meta_assets p WHERE p.connection_id=a.connection_id AND p.kind::text='FACEBOOK_PAGE'
                         AND p.meta_id=a.parent_page_id AND p.disconnected_at IS NULL AND p.page_token_enc IS NOT NULL)
      THEN 'no — the Meta login token has expired and no linked Page token is stored (reconnect Meta).'
    WHEN i.platform='facebook' AND (a.kind::text <> 'FACEBOOK_PAGE' OR a.page_token_enc IS NULL) THEN 'no — No Page token for this Page.'
    ELSE 'yes (if CAMPAIGN_PUBLISH_ENABLED=1 and the stored token decrypts)'
  END
FROM items i
LEFT JOIN meta_assets a ON i.target_type='meta_asset' AND a.id=i.target_id
LEFT JOIN meta_connections c ON c.id=a.connection_id
ORDER BY i.booking_id, i.created_at, i.account_name"

# ─── 7. Worker log ──────────────────────────────────────────────────────────────────────────
hr "7. Worker log: last 40 '[campaign…' lines of 'pm2 logs $PM2_APP' (last 3000 lines searched)"
echo "    (the publish worker logs only failures — publish.service.ts:554,560; a silent log is normal)"
if [ "$SKIP_PM2" = "1" ]; then
  echo "    skipped (SKIP_PM2=1)"
elif ! command -v pm2 >/dev/null 2>&1; then
  echo "    pm2 not found on PATH"
else
  LOGS=$(timeout 60 pm2 logs "$PM2_APP" --nostream --lines 3000 2>&1 | grep -E '\[campaign' | tail -40)
  if [ -n "$LOGS" ]; then printf '%s\n' "$LOGS" | cut -c1-400 | redact | ind; else echo "    (no [campaign… lines)"; fi
fi

# ─── 8. Verdict ─────────────────────────────────────────────────────────────────────────────
hr "8. VERDICT"
if [ "$CONFIDENT" != "1" ]; then
  echo "    CAUTION: the auto-publish switch below is read from ${EFFSRC[CAMPAIGN_PUBLISH_ENABLED]}."
  echo "    The running process could differ; on the prod box run this without SKIP_PM2 to be sure."
fi
if [ "$DB_OK" != "1" ]; then
  echo "    No database connection, so only the config part can be judged:"
  if [ "$PUB_ON" = "1" ]; then echo "    Auto-publishing is ON ($PUB)."; else echo "    Auto-publishing is OFF (CAMPAIGN_PUBLISH_ENABLED=${PUB:-not set}); every approved account is posted by hand."; fi
  exit 1
fi

# One TSV row per item of the recent bookings.
if ! ITEMS=$(qus "WITH $RECENT
SELECT i.booking_id, b.status, replace(i.account_name, E'\t', ' '), i.platform || '/' || i.format, i.status,
       CASE WHEN i.status <> 'queued' THEN '-'
            WHEN i.next_attempt_at IS NULL OR i.next_attempt_at <= $NOWU - interval '10 minutes' THEN 'overdue'
            WHEN i.next_attempt_at <= $NOWU THEN 'due'
            ELSE 'later' END,
       $(ist i.next_attempt_at),
       CASE WHEN i.locked_until > $NOWU THEN 'locked' ELSE '-' END,
       i.attempts,
       CASE WHEN i.container_id IS NOT NULL OR i.attempts > 0 THEN 'inflight' ELSE '-' END,
       coalesce(left(regexp_replace(i.last_error, '\s+', ' ', 'g'), 200), ''),
       coalesce((SELECT left(regexp_replace(substr(e.note, length('Post by hand on ' || i.account_name || ': ') + 1), '\s+', ' ', 'g'), 200)
                 FROM campaign_booking_events e
                 WHERE e.booking_id=i.booking_id AND starts_with(e.note, 'Post by hand on ' || i.account_name || ': ')
                   -- the note names the account but not the platform: only trust it when the name is unique in the booking
                   AND (SELECT count(*) FROM campaign_booking_items j WHERE j.booking_id=i.booking_id AND j.account_name=i.account_name) = 1
                 ORDER BY e.created_at DESC LIMIT 1), '')
FROM campaign_booking_items i JOIN recent r ON r.id=i.booking_id JOIN campaign_bookings b ON b.id=i.booking_id
ORDER BY b.updated_at DESC, i.created_at, i.account_name" 2>&1); then
  echo "    FAILED to read the items: $(printf '%s' "$ITEMS" | head -c 300 | redact)"
  exit 1
fi
REVIEW=$(qus "WITH $RECENT SELECT b.id, replace(b.name, E'\x1f', ' ') FROM campaign_bookings b JOIN recent r ON r.id=b.id WHERE b.status='paid_pending_review' ORDER BY b.updated_at DESC" 2>/dev/null)

n_manual=0; n_manual_err=0; n_manual_bare=0; n_q_later=0; n_q_due=0; n_q_over=0; n_q_err=0; n_q_locked=0; n_live=0; n_failed=0; n_refunded=0; n_pending=0; n_total=0
L_MANUAL_ERR=""; L_MANUAL_BARE=""; L_Q_LATER=""; L_Q_OVER=""; L_Q_ERR=""; L_Q_WAIT=""; n_q_wait=0
declare -A MANUAL_BY_BOOKING=()
declare -A NAME_OF=()
while IFS="$US" read -r bid _bstatus acct pf istatus due nextist lock attempts inflight lasterr handreason; do
  [ -n "${bid:-}" ] || continue
  n_total=$((n_total + 1))
  short="${bid:0:8}"
  case "$istatus" in
    manual_pending)
      n_manual=$((n_manual + 1))
      MANUAL_BY_BOOKING[$bid]="${MANUAL_BY_BOOKING[$bid]:-}${MANUAL_BY_BOOKING[$bid]:+, }$acct ($pf)"
      if [ -n "$lasterr" ]; then
        n_manual_err=$((n_manual_err + 1)); L_MANUAL_ERR+="      [$short] $acct ($pf): $lasterr"$'\n'
      elif [ -n "$handreason" ]; then
        n_manual_err=$((n_manual_err + 1)); L_MANUAL_ERR+="      [$short] $acct ($pf): $handreason   (from the approval event)"$'\n'
      else
        n_manual_bare=$((n_manual_bare + 1)); L_MANUAL_BARE+="      [$short] $acct ($pf)"$'\n'
      fi ;;
    queued)
      [ "$lock" = "locked" ] && n_q_locked=$((n_q_locked + 1))
      case "$due" in
        later)
          if [ "$inflight" = "inflight" ]; then
            n_q_wait=$((n_q_wait + 1)); L_Q_WAIT+="      [$short] $acct ($pf): next check $nextist IST, attempt $attempts of 5"$'\n'
          else
            n_q_later=$((n_q_later + 1)); L_Q_LATER+="      [$short] $acct ($pf): due $nextist IST"$'\n'
          fi ;;
        due) n_q_due=$((n_q_due + 1)) ;;
        overdue) n_q_over=$((n_q_over + 1)); L_Q_OVER+="      [$short] $acct ($pf): due $nextist IST, attempts $attempts$([ "$lock" = locked ] && echo " (locked: being published now)")"$'\n' ;;
      esac
      if [ -n "$lasterr" ]; then n_q_err=$((n_q_err + 1)); L_Q_ERR+="      [$short] $acct ($pf): attempt $attempts of 5 — $lasterr"$'\n'; fi ;;
    published|posted_manual) n_live=$((n_live + 1)) ;;
    failed) n_failed=$((n_failed + 1)) ;;
    refunded) n_refunded=$((n_refunded + 1)) ;;
    pending)
      # Items of a booking still in review are legitimately pending; only an APPROVED booking
      # with a pending item is wrong.
      case "$_bstatus" in approved|publishing|completed|partially_published) n_pending=$((n_pending + 1)) ;; esac ;;
  esac
done <<< "$ITEMS"
while IFS="$US" read -r bid bname; do [ -n "${bid:-}" ] && NAME_OF[$bid]="$bname"; done <<< "$(qus "WITH $RECENT SELECT b.id, replace(b.name, E'\x1f', ' ') FROM campaign_bookings b JOIN recent r ON r.id=b.id" 2>/dev/null)"

echo "    $n_total account(s) across the bookings above: $n_live live, $n_manual 'To post' (by hand), $((n_q_later + n_q_due + n_q_over + n_q_wait)) queued for auto-publish, $n_failed failed, $n_refunded refunded/dropped, $n_pending wrongly still pending."
if [ -n "$REVIEW" ]; then
  echo
  echo "    NOT APPROVED YET — these are still 'Needs review' (paid_pending_review); nothing is posted before Approve:"
  printf '%s\n' "$REVIEW" | while IFS="$US" read -r bid bname; do echo "      $bname — $PORTAL/campaigns/$bid"; done | redact
fi
if [ "$n_pending" -gt 0 ]; then
  echo
  echo "    $n_pending account(s) are still 'pending' on an approved booking — approve() should never leave that"
  echo "    (review.service.ts:127). Send this output to Claude."
fi

if [ "$PUB_ON" != "1" ]; then
  echo
  WHERE_TXT="on the running API"; [ "$CONFIDENT" = "1" ] || WHERE_TXT="according to apps/api/.env (running process not checked)"
  echo "    >>> Auto-publishing is OFF $WHERE_TXT (CAMPAIGN_PUBLISH_ENABLED=${PUB:-not set}; it must be exactly \"1\", config.ts:59)."
  echo "    On approval every account goes to 'To post' and nothing posts it automatically"
  echo "    (approve(): review.service.ts:118-127 + publish.service.ts:63; the worker returns at publish.service.ts:526)."
  if [ "$n_manual" -gt 0 ]; then
    echo "    $n_manual account(s) are waiting in 'To post': someone must post each on the Page by hand, then paste the"
    echo "    link and press Mark posted on $PORTAL/campaigns/<id>."
  else
    echo "    No account of these bookings is waiting in 'To post' right now."
  fi
  if [ "${#MANUAL_BY_BOOKING[@]}" -gt 0 ]; then
    echo "    Waiting to be posted by hand:"
    for bid in "${!MANUAL_BY_BOOKING[@]}"; do
      echo "      ${NAME_OF[$bid]:-?} — $PORTAL/campaigns/$bid"
      echo "        ${MANUAL_BY_BOOKING[$bid]}"
    done | redact
  fi
  if [ $((n_q_later + n_q_due + n_q_over + n_q_wait)) -gt 0 ]; then
    echo "    ALSO: $((n_q_later + n_q_due + n_q_over + n_q_wait)) account(s) are 'Auto-publish' (queued) — approved while it was ON — and will never run"
    echo "    while it is off. Press 'Post by hand instead' on each, then post and Mark posted:"
    printf '%s%s%s' "$L_Q_LATER" "$L_Q_WAIT" "$L_Q_OVER"
  fi
  echo "    Switching auto-publishing on later does NOT move 'To post' accounts: staff press 'Try auto-publish' per account"
  echo "    (page.tsx:346 -> review.service.ts:262-283). CLAUDE.md asks for one test post to our own Page first."
else
  echo
  echo "    >>> Auto-publishing is ON (CAMPAIGN_PUBLISH_ENABLED=1)."
  if [ "$CRONS_ON" != "1" ]; then
    echo "    BUT CAMPAIGN_CRONS_ENABLED=0: the publish worker is never started (campaign.cron.ts:16), so queued accounts never run."
  fi
  if [ "$n_q_later" -gt 0 ]; then
    echo "    $n_q_later queued account(s) are NOT DUE YET (launch day at ${EFF[CAMPAIGN_PUBLISH_HOUR_IST]:-10}:00 IST, publish.service.ts:112-117)."
    echo "    That is expected; press 'Publish now' on an account to post it immediately:"
    printf '%s' "$L_Q_LATER"
  fi
  if [ "$n_q_over" -gt 0 ]; then
    echo "    $n_q_over queued account(s) were due more than 10 minutes ago and have not been picked up/finished."
    echo "    The worker runs every minute (campaign.cron.ts:26-32). Unless one is locked (mid-publish, up to 10 min) or"
    echo "    waiting on Meta (container processing / backoff), the worker is not running: check 'pm2 logs api' and section 7."
    printf '%s' "$L_Q_OVER"
  fi
  if [ "$n_q_wait" -gt 0 ]; then
    echo "    $n_q_wait queued account(s) are mid-publish and waiting on Meta (video processing, a retry or the daily limit);"
    echo "    the worker checks again at the time shown. 'Last try' on the campaign page says why:"
    printf '%s' "$L_Q_WAIT"
  fi
  [ "$n_q_due" -gt 0 ] && echo "    $n_q_due queued account(s) became due in the last 10 minutes — the worker should take them within a minute or two."
  [ "$n_q_locked" -gt 0 ] && echo "    $n_q_locked queued account(s) are locked right now = being published at this moment."
  if [ "$n_q_err" -gt 0 ]; then
    echo "    $n_q_err queued account(s) failed at least once and are retrying (backoff 2/10/30/120/360 min; staff after 5, publish.service.ts:29-30,501-513):"
    printf '%s' "$L_Q_ERR"
  fi
  if [ "$n_manual_err" -gt 0 ]; then
    echo "    $n_manual_err account(s) were HANDED TO STAFF ('To post') — post by hand and Mark posted, or fix the cause and press 'Try auto-publish':"
    printf '%s' "$L_MANUAL_ERR"
  fi
  if [ "$n_manual_bare" -gt 0 ]; then
    echo "    $n_manual_bare account(s) are 'To post' with no reason recorded — approved before 12 Oct 2026 while auto-publishing"
    echo "    was OFF, or switched to 'post by hand' by staff. Press 'Try auto-publish' or post by hand:"
    printf '%s' "$L_MANUAL_BARE"
  fi
fi
if [ "$n_failed" -gt 0 ]; then
  echo "    $n_failed account(s) were marked FAILED by staff (they will not be posted; see section 3 for the note)."
fi
[ "$n_total" -eq 0 ] && echo "    No accounts found on approved bookings${BOOKING:+ matching BOOKING=$BOOKING} — see 'all bookings by status' in section 2."
echo
echo "Read-only run complete. Nothing was changed."
exit 0
