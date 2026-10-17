#!/bin/bash
# One-shot pre-merge step for the creator direct-payouts PR (Razorpay Route; plan
# docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md, Appendix B): the seven
# payout / refund / dispute tables, created EMPTY. Run it ON the production box as root, BEFORE
# merging the PR — the two commands (after the fetch) are:
#
#   cd /opt/dashmani-platform && git fetch origin claude/awesome-bohr-qu8x1k
#   git show origin/claude/awesome-bohr-qu8x1k:scripts/apply-creator-payouts-ddl.sh > /root/apply-creator-payouts-ddl.sh
#   bash /root/apply-creator-payouts-ddl.sh
#
# It exists because the box's terminal mangles multi-line pastes. Every step is the documented
# runbook step (docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md), nothing more:
#   1. extracts scripts/creator-payouts-ddl.sql and schema.prisma from the PR branch with
#      `git show` (the checkout the apps run from is never touched);
#   2. takes DATABASE_URL (the dashmani app role) from apps/api/.env — the runbook's recipe —
#      and refuses to run as any other role (objects made by postgres break every later DDL). The
#      role's password is split off the URL and handed to psql / pg_dump through PGPASSWORD, set
#      on that one command only, so it never appears on a command line (`ps` and /proc/*/cmdline
#      show every process's arguments to every local user, and this box has other tenants);
#   3. read-only pre-flight: the role may CREATE in schema public; campaign_rate_cards (the one
#      table the DDL references) exists with a TEXT id and the role may reference it; any of the
#      seven tables that already exists has exactly the expected columns, is owned by that role and
#      still carries its CHECK constraint (IF NOT EXISTS would otherwise silently keep a table of a
#      different shape, or one a `db push` built without the CHECKs Prisma cannot express). The
#      only existing table the DDL touches is campaign_rate_cards (a brief lock for the foreign key),
#      so the long-transaction check looks at it and at the seven new tables;
#   4. schema-only backup (seconds; this DDL rewrites no data);
#   5. applies the DDL — one transaction, lock_timeout 3s, CREATE ... IF NOT EXISTS only;
#   6. verifies the seven tables (owner + columns), their 34 indexes (10 unique, besides the primary
#      keys; one of them is the PARTIAL unique index that makes a verified creator post unique per
#      post key, which Prisma cannot express), the ONE foreign key (creator_rate_terms -> campaign_rate_cards, ON DELETE CASCADE;
#      any other foreign key on these tables fails the run) and the 3 CHECK constraints;
#   7. drift check (inspect only, never applied): no payout / refund / dispute statement may remain
#      between the database and the PR's schema.prisma.
# It restarts nothing and changes no file in /opt/dashmani-platform. Safe to re-run: a second
# run changes nothing. Exit code 0 means every step passed; 1 means a step failed (the output says
# whether the DDL was applied); 2 means the DDL is applied and verified but the drift check could
# not run.
#
# ⚠️ Run it as the LAST step before the merge. Until the code that uses these tables is deployed
# they are EMPTY, and `prisma db push` drops an empty table without a prompt.
#
# APP_DIR / BRANCH / EXPECT_ROLE / HEALTH_URL / WORK_ROOT may be overridden for a local rehearsal only.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/dashmani-platform}"
BRANCH="${BRANCH:-claude/awesome-bohr-qu8x1k}"
EXPECT_ROLE="${EXPECT_ROLE:-dashmani}"
HEALTH_URL="${HEALTH_URL:-https://api.digitalsukoon.com/v1/health}"
PR="the creator direct-payouts PR"
WORK_ROOT="${WORK_ROOT:-/root}"
[ -w "$WORK_ROOT" ] || WORK_ROOT="${TMPDIR:-/tmp}"
WORK="$WORK_ROOT/creator-payouts-ddl-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
export PGCONNECT_TIMEOUT=10

# The seven tables, children first (the order a drop would need), and their columns sorted
# byte-wise — exactly the CREATE TABLE lists in scripts/creator-payouts-ddl.sql.
TABLES="creator_payout_events creator_payouts creator_offers creator_rate_terms creator_payout_accounts campaign_refunds campaign_disputes"
declare -A EXPECTED_COLS=(
  [creator_payout_accounts]="account_created_at,activated_at,activation_status,bank_change_cleared_at,bank_change_requested_at,bookable_after,created_at,creator_id,destination_hint,id,last_checked_at,last_error,razorpay_account_id,razorpay_product_id,razorpay_stakeholder_id,razorpay_tnc_accepted_at,requirements,setup_locked_until,setup_step,tds_bps,terms_accepted_at,terms_version,updated_at"
  [creator_rate_terms]="created_at,id,rate_card_id,share_bps,updated_at,updated_by_id"
  [creator_offers]="accepted_at,booking_id,booking_item_id,closed_reason,created_at,creator_asset_id,creator_id,creator_note,declined_at,expired_at,expires_at,format,id,link_canonical_key,link_posted_at,link_submitted_at,link_url,link_verified_at,link_verified_by_id,notified_at,offered_at,ownership_check,ownership_checked_at,ownership_checked_by_id,ownership_detail,page_handle,page_name,payout_paise,platform,post_missing_at,status,updated_at,window_from,window_to,withdrawn_at,withdrawn_by_id"
  [creator_payouts]="absent_checks,alerted_at,alerted_status,amount_paise,amount_reversed_paise,attempts,booking_id,booking_item_id,created_at,creator_id,destination_hint,error_code,gross_paise,held_at,id,item_price_paise,last_checked_at,last_error,locked_until,manual_note,manual_paid_at,manual_paid_by_id,manual_reference,next_attempt_at,on_hold_verified_at,paused_at,paused_reason,payout_account_id,razorpay_account_id,razorpay_payment_id,razorpay_reversal_id,razorpay_transfer_id,recipient_settlement_id,recipient_settlement_status,release_after,release_requested_at,released_at,reversal_requested_at,reversed_at,settled_at,settlement_amount_paise,settlement_fee_paise,settlement_status,settlement_utr,share_bps,status,tds_bps,tds_paise,transfer_fees_paise,transfer_requested_at,transfer_status,transfer_tax_paise,updated_at,void_reason"
  [creator_payout_events]="actor_id,actor_type,amount_paise,booking_id,created_at,from_status,id,kind,note,payout_id,razorpay_event_id,to_status"
  [campaign_refunds]="amount_paise,booking_id,booking_item_id,created_at,id,idempotency_key,last_checked_at,last_error,origin,payment_id,processed_at,razorpay_payment_id,razorpay_refund_id,reason,receipt,status,updated_at"
  [campaign_disputes]="amount_paise,booking_id,closed_at,created_at,currency,id,last_event,opened_at,phase,razorpay_dispute_id,razorpay_payment_id,reason_code,respond_by,status,updated_at"
)
# Every index the DDL creates (primary keys included); the unique ones are checked separately.
EXPECTED_INDEXES="creator_payout_accounts_pkey creator_payout_accounts_creator_id_key creator_payout_accounts_razorpay_account_id_key creator_payout_accounts_activation_status_idx
creator_rate_terms_pkey creator_rate_terms_rate_card_id_key
creator_offers_pkey creator_offers_booking_item_id_key creator_offers_creator_id_status_idx creator_offers_booking_id_idx creator_offers_status_expires_at_idx creator_offers_link_canonical_key_idx creator_offers_verified_link_key_idx
creator_payouts_pkey creator_payouts_booking_item_id_key creator_payouts_razorpay_transfer_id_key creator_payouts_status_next_attempt_at_idx creator_payouts_creator_id_idx creator_payouts_booking_id_idx creator_payouts_razorpay_payment_id_idx
creator_payout_events_pkey creator_payout_events_payout_id_created_at_idx creator_payout_events_booking_id_created_at_idx
campaign_refunds_pkey campaign_refunds_razorpay_refund_id_key campaign_refunds_idempotency_key_key campaign_refunds_razorpay_payment_id_idx campaign_refunds_booking_id_idx campaign_refunds_booking_item_id_idx campaign_refunds_status_last_checked_at_idx
campaign_disputes_pkey campaign_disputes_razorpay_dispute_id_key campaign_disputes_razorpay_payment_id_idx campaign_disputes_status_idx"
EXPECTED_UNIQUE="creator_payout_accounts_creator_id_key creator_payout_accounts_razorpay_account_id_key creator_rate_terms_rate_card_id_key creator_offers_booking_item_id_key creator_offers_verified_link_key_idx creator_payouts_booking_item_id_key creator_payouts_razorpay_transfer_id_key campaign_refunds_razorpay_refund_id_key campaign_refunds_idempotency_key_key campaign_disputes_razorpay_dispute_id_key"
# The ONLY foreign key: a share goes with its rate card. Everything else carries plain ids on purpose.
EXPECTED_FKS="creator_rate_terms_rate_card_id_fkey"
# table:constraint — Prisma cannot express CHECKs, so only this script creates them.
EXPECTED_CHECKS="creator_payout_accounts:creator_payout_accounts_tds_bps_check creator_rate_terms:creator_rate_terms_share_bps_check creator_payouts:creator_payouts_amounts_check"
sqllist() { echo "$1" | tr -s ' \n' '\n' | sed '/^$/d' | sed "s/.*/'&'/" | paste -sd, -; }

APPLIED=0   # flips to 1 once the DDL transaction has committed
fail() {
  echo "FAIL: $*"
  if [ "$APPLIED" = "1" ]; then
    echo "The DDL itself IS applied (it committed in step 5) and is safe to leave in place — it only adds new, empty tables and the running API ignores them."
    echo "Do NOT merge $PR yet: send this output and $WORK to Claude first."
  else
    echo "Nothing was changed in the database. Logs in $WORK"
  fi
  exit 1
}
health() { local c; c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null); [ -n "$c" ] && [ "$c" != "000" ] && echo "$c" || echo "unreachable"; }

cd "$APP_DIR" 2>/dev/null || fail "$APP_DIR missing — this must run on the prod box (ssh dashmani-prod)"

echo "==> 1. Fetch the PR branch and extract the DDL + schema (no checkout)"
git fetch -q origin "$BRANCH" || fail "git fetch origin $BRANCH"
git show "origin/$BRANCH:scripts/creator-payouts-ddl.sql" > "$WORK/creator-payouts-ddl.sql" \
  || fail "scripts/creator-payouts-ddl.sql is not on origin/$BRANCH"
git show "origin/$BRANCH:packages/db/prisma/schema.prisma" > "$WORK/schema.prisma" \
  || fail "packages/db/prisma/schema.prisma is not on origin/$BRANCH"
HEAD_SHA=$(git rev-parse "origin/$BRANCH")
HEADSHORT=$(git rev-parse --short "origin/$BRANCH")
echo "    branch head: $HEAD_SHA"
echo "    DDL: $(wc -l < "$WORK/creator-payouts-ddl.sql") lines, sha256 $(sha256sum "$WORK/creator-payouts-ddl.sql" | cut -c1-12)"

echo "==> 2. DATABASE_URL (the app role) from apps/api/.env"
FULLURL=$(grep -hE '^DATABASE_URL=' "$APP_DIR/apps/api/.env" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)
FULLURL="${FULLURL%\"}"; FULLURL="${FULLURL#\"}"; FULLURL="${FULLURL%\'}"; FULLURL="${FULLURL#\'}"; FULLURL="${FULLURL%%\?*}"
[ -n "$FULLURL" ] || fail "no DATABASE_URL in $APP_DIR/apps/api/.env"
# ⚠️ Keep the password OFF every command line. DBURL is the same URL without it (what psql and
# pg_dump are given); PGPW holds it percent-decoded, and is handed over as PGPASSWORD for ONE command
# at a time by pgenv — never exported to the whole script, so git, curl and npx do not inherit it.
# FULLURL (with the password) goes only into the environment of the one prisma process below.
# A literal backslash is doubled first, or printf %b would read it as an escape.
DBURL="$FULLURL"; PGPW=""
if [[ "$FULLURL" =~ ^(postgres(ql)?://)([^:@/]+):([^@]*)@(.*)$ ]]; then
  _enc="${BASH_REMATCH[4]}"
  _enc="${_enc//\\/\\\\}"
  PGPW="$(printf '%b' "${_enc//%/\\x}")"
  DBURL="${BASH_REMATCH[1]}${BASH_REMATCH[3]}@${BASH_REMATCH[5]}"
  unset _enc
fi
pgenv() { if [ -n "$PGPW" ]; then PGPASSWORD="$PGPW" "$@"; else "$@"; fi; }
q() { pgenv psql "$DBURL" -X -At -v ON_ERROR_STOP=1 -c "$1"; }
ROLE=$(q "SELECT current_user" 2> "$WORK/connect.err") || fail "cannot connect: $(head -c 300 "$WORK/connect.err")"
echo "    connected as: $ROLE  (database $(q "SELECT current_database()"), $(q "SHOW server_version"))"
[ "$ROLE" = "$EXPECT_ROLE" ] || fail "connected as '$ROLE', expected '$EXPECT_ROLE'. Never apply as postgres: tables it creates are owned by postgres and every later Prisma DDL fails."

echo "==> 3. Pre-flight (read-only)"
HEALTH_BEFORE=$(health)
echo "    API health before: $HEALTH_BEFORE"
[ "$(q "SELECT has_schema_privilege('public','CREATE')")" = "t" ] || fail "$ROLE cannot CREATE in schema public"
# The one table the DDL references. Its id must be TEXT (creator_rate_terms.rate_card_id is TEXT) and
# the role must be allowed to reference it, or ADD FOREIGN KEY would roll the whole script back.
[ "$(q "SELECT to_regclass('public.campaign_rate_cards') IS NOT NULL")" = "t" ] \
  || fail "campaign_rate_cards does not exist — the campaign booking DDL (scripts/campaign-booking-ddl.sql) must be applied first"
RC_ID_TYPE=$(q "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='campaign_rate_cards' AND column_name='id'")
[ "$RC_ID_TYPE" = "text" ] || fail "campaign_rate_cards.id is '$RC_ID_TYPE', expected text — the foreign key would fail"
[ "$(q "SELECT has_table_privilege(current_user, 'public.campaign_rate_cards', 'REFERENCES')")" = "t" ] \
  || fail "$ROLE has no REFERENCES privilege on campaign_rate_cards (is it owned by another role?)"
echo "    campaign_rate_cards: id is text, $ROLE may reference it ($(q "SELECT count(*) FROM public.campaign_rate_cards") rows)"
cols_of() { q "SELECT string_agg(column_name, ',' ORDER BY column_name COLLATE \"C\") FROM information_schema.columns WHERE table_schema='public' AND table_name='$1'"; }
coltype_of() { q "SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name='$2'"; }
check_of() { q "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname='public' AND t.relname='$1' AND c.conname='$2' AND c.contype='c'"; }
PRESENT=0
for t in $TABLES; do
  OWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ -n "$OWNER" ] || continue
  PRESENT=$((PRESENT + 1))
  [ "$OWNER" = "$ROLE" ] || fail "table $t exists but is owned by '$OWNER', not '$ROLE' — fix ownership first (ALTER TABLE $t OWNER TO $ROLE as postgres)"
  HAVE=$(cols_of "$t")
  # IF NOT EXISTS silently keeps a table of a different shape, so an existing one is checked, not trusted.
  [ "$HAVE" = "${EXPECTED_COLS[$t]}" ] || fail "table $t already exists with different columns ($HAVE) — investigate before applying"
done
# The one column whose WIDTH matters: canonicalKey() returns the whole lowercased URL for shapes it does not
# recognise, so the key is TEXT. Column names alone would not show an older VARCHAR(255) build that IF NOT EXISTS keeps.
if [ -n "$(q "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='creator_offers'")" ]; then
  KEYTYPE=$(coltype_of creator_offers link_canonical_key)
  [ "$KEYTYPE" = "text" ] || fail "creator_offers.link_canonical_key is '$KEYTYPE', expected text (a long Facebook permalink would not fit a VARCHAR(255)) — drop the table if it is empty and re-run"
fi
for pair in $EXPECTED_CHECKS; do
  t=${pair%%:*}; c=${pair#*:}
  [ -n "$(q "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='$t'")" ] || continue
  # A table built by `prisma db push` has the columns but none of the CHECKs, and IF NOT EXISTS would keep it so.
  [ -n "$(check_of "$t" "$c")" ] || fail "table $t exists WITHOUT its CHECK constraint $c (built by db push?) — it holds $(q "SELECT count(*) FROM public.\"$t\"") rows; drop it if it is empty and re-run"
done
if [ "$PRESENT" = "0" ]; then
  echo "    state: not applied yet (none of the 7 tables exists)"
else
  echo "    state: partly or fully applied already ($PRESENT of 7 tables, each with the expected columns) — re-running is a no-op for what exists"
fi
# Only campaign_rate_cards (the foreign key) is an existing table the DDL touches, and only with a brief
# SHARE ROW EXCLUSIVE lock; keep the check cheap and scoped to it and to the new tables.
LONG=$(q "SELECT a.pid || ' ' || coalesce(a.application_name,'') || ' ' || date_trunc('second', now() - a.xact_start) || ' ' || left(regexp_replace(coalesce(a.query,''), '\s+', ' ', 'g'), 80)
  FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE n.nspname = 'public' AND c.relname IN ($(sqllist "$TABLES campaign_rate_cards"))
    AND a.pid <> pg_backend_pid() AND a.xact_start < now() - interval '5 seconds'")
if [ -n "$LONG" ]; then
  echo "$LONG" | sed 's/^/      /'
  fail "a transaction older than 5 s holds a lock on campaign_rate_cards or a payout table; wait a minute and re-run"
fi
echo "    no long transaction on campaign_rate_cards or any payout table"

echo "==> 4. Schema-only backup"
pgenv pg_dump "$DBURL" --schema-only --no-owner --no-privileges --lock-wait-timeout=5s > "$WORK/pre-ddl-schema.sql" 2> "$WORK/pg_dump.err"
DUMP_EXIT=$?
[ "$DUMP_EXIT" -eq 0 ] && [ -s "$WORK/pre-ddl-schema.sql" ] || { head -c 500 "$WORK/pg_dump.err"; fail "schema dump failed (exit $DUMP_EXIT) — wait a minute and re-run"; }
echo "    $WORK/pre-ddl-schema.sql ($(wc -c < "$WORK/pre-ddl-schema.sql") bytes)"

echo "==> 5. Apply the DDL (one transaction)"
PGAPPNAME=creator-payouts-ddl pgenv psql "$DBURL" -X -v ON_ERROR_STOP=1 -f "$WORK/creator-payouts-ddl.sql" 2>&1 | tee "$WORK/apply.log"
DDL_EXIT=${PIPESTATUS[0]}
echo "    ddl exit=$DDL_EXIT"
if [ "$DDL_EXIT" -ne 0 ]; then
  if grep -q "lock timeout" "$WORK/apply.log"; then
    echo "    Something held campaign_rate_cards (or a payout table) for more than 3 s. The transaction rolled back; nothing changed."
    echo "    Wait ~10 minutes and run this script again (once)."
  fi
  fail "DDL did not apply — see $WORK/apply.log (the script runs in one transaction, so it rolled back)"
fi
APPLIED=1

echo "==> 6. Verify"
for t in $TABLES; do
  TOWNER=$(q "SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='$t'")
  [ "$TOWNER" = "$ROLE" ] || fail "table $t missing or owned by '${TOWNER:-nobody}' (expected $ROLE)"
  HAVE=$(cols_of "$t")
  [ "$HAVE" = "${EXPECTED_COLS[$t]}" ] || fail "table $t has columns $HAVE"
  echo "    $t: owner $TOWNER, $(echo "$HAVE" | tr ',' '\n' | wc -l | tr -d ' ') columns as expected, $(q "SELECT count(*) FROM public.\"$t\"") rows"
done
KEYTYPE=$(coltype_of creator_offers link_canonical_key)
[ "$KEYTYPE" = "text" ] || fail "creator_offers.link_canonical_key is '$KEYTYPE', expected text"
echo "    creator_offers.link_canonical_key: $KEYTYPE (a whole lowercased URL fits)"
IDX=$(q "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN ($(sqllist "$EXPECTED_INDEXES"))")
echo "    indexes: $IDX (expected 34 incl. the 7 primary keys)"
[ "$IDX" = "34" ] || fail "expected 34 indexes on the payout tables; missing: $(q "SELECT string_agg(x, ' ') FROM unnest(ARRAY[$(sqllist "$EXPECTED_INDEXES")]) x WHERE x NOT IN (SELECT indexname FROM pg_indexes WHERE schemaname='public')")"
UNIQ=$(q "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND i.indisunique AND i.indisvalid AND c.relname IN ($(sqllist "$EXPECTED_UNIQUE"))")
echo "    unique indexes (besides primary keys): $UNIQ (expected 10)"
[ "$UNIQ" = "10" ] || fail "expected 10 valid UNIQUE indexes ($EXPECTED_UNIQUE)"
# The one index Prisma cannot express: it must be PARTIAL (verified rows with a key only). A plain unique index on the key
# would refuse two creators pasting the same post before staff decide, which the service allows on purpose.
VLK_DEF=$(q "SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relname='creator_offers_verified_link_key_idx'")
case "$VLK_DEF" in
  *"(link_canonical_key)"*"link_verified_at IS NOT NULL"*"link_canonical_key IS NOT NULL"*) ;;
  *) fail "creator_offers_verified_link_key_idx is not the partial unique index on link_canonical_key (verified rows with a key): $VLK_DEF" ;;
esac
echo "    one verified creator post per post key: $VLK_DEF"
# The ONLY foreign key is the cascade to campaign_rate_cards; any other one on these tables is a mistake
# (financial rows must outlive bookings, items, creators and pages).
FK=$(q "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'public' AND c.contype = 'f' AND c.confdeltype = 'c' AND c.confrelid = 'public.campaign_rate_cards'::regclass AND c.conname IN ($(sqllist "$EXPECTED_FKS"))")
echo "    foreign keys (ON DELETE CASCADE to campaign_rate_cards): $FK (expected 1)"
[ "$FK" = "1" ] || fail "expected the cascading foreign key ($EXPECTED_FKS)"
ALLFK=$(q "SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND c.contype = 'f' AND t.relname IN ($(sqllist "$TABLES"))")
echo "    foreign keys on the seven tables in all: $ALLFK (expected 1)"
[ "$ALLFK" = "1" ] || fail "the payout tables must carry exactly one foreign key, found $ALLFK"
NCHECK=0
for pair in $EXPECTED_CHECKS; do
  t=${pair%%:*}; c=${pair#*:}
  DEF=$(check_of "$t" "$c")
  [ -n "$DEF" ] || fail "CHECK constraint $c is missing on $t"
  NCHECK=$((NCHECK + 1))
done
echo "    CHECK constraints: $NCHECK (expected 3)"
SHARE_DEF=$(check_of creator_rate_terms creator_rate_terms_share_bps_check)
case "$SHARE_DEF" in *9000*) ;; *) fail "the share_bps CHECK does not cap at 9000: $SHARE_DEF" ;; esac
echo "    share cap: $SHARE_DEF"

echo "==> 7. Drift check against the PR's schema.prisma (inspect only, never applied)"
DRIFT_RAN=0
# The database side is read through the schema's own datasource (url = env("DATABASE_URL")), so the full URL
# travels in that one process's environment (readable by root only), not in its arguments.
if [ -d "$APP_DIR/packages/db" ] && (cd "$APP_DIR/packages/db" && DATABASE_URL="$FULLURL" timeout 300 npx --no-install prisma migrate diff \
      --from-schema-datasource "$WORK/schema.prisma" --to-schema-datamodel "$WORK/schema.prisma" --script > "$WORK/drift.sql" 2> "$WORK/drift.err"); then
  STMTS=$(grep -cvE '^\s*(--.*)?$' "$WORK/drift.sql" || true)
  echo "    $STMTS drift line(s) in $WORK/drift.sql (known hand-built indexes are expected here):"
  grep -vE '^\s*(--.*)?$' "$WORK/drift.sql" | head -20 | sed 's/^/      /'
  if grep -qiE 'creator_payout|creator_rate_terms|creator_offers|campaign_refunds|campaign_disputes' "$WORK/drift.sql"; then
    fail "the database still differs from the PR schema on a payout object — do NOT merge; see $WORK/drift.sql"
  fi
  echo "    no payout / refund / dispute drift"
  DRIFT_RAN=1
else
  echo "    WARNING: could not run prisma migrate diff: $(head -c 300 "$WORK/drift.err" 2>/dev/null)"
fi

HEALTH_AFTER=$(health)
echo "    API health after: $HEALTH_AFTER (before: $HEALTH_BEFORE)"
if [ "$HEALTH_AFTER" != "200" ]; then
  echo "    WARNING: the API health check is not 200. This DDL cannot cause that (it only adds new tables"
  echo "    the running API never reads) — check 'pm2 status' / 'pm2 logs api --lines 50' before merging."
fi

echo
if [ "$DRIFT_RAN" != "1" ]; then
  echo "APPLIED AND VERIFIED (steps 5-6), but the drift check in step 7 did not run. Logs in $WORK."
  echo "Send this output to Claude before merging $PR."
  exit 2
fi
echo "ALL DONE — DDL applied as $ROLE and verified. Logs in $WORK."
echo "Safe to merge $PR while its head is still $HEADSHORT."
echo "If commits land on the PR after this run, re-run this script (it is safe to re-run) before merging."
echo "Until the PR is merged and deployed, do NOT run 'prisma db push' on prod: a push from main's schema"
echo "would drop the seven new (still empty) payout tables without a prompt."
