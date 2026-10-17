-- ============================================================================
-- scripts/creator-payouts-ddl.sql — feature-only DDL for creator direct payouts through
-- Razorpay Route (docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md,
-- Appendix B): the creator's linked account, the staff-set share per rate card, the offer a
-- creator accepts, the payout and its audit trail, and the refund and dispute ledgers.
-- Models:   CreatorPayoutAccount, CreatorRateTerm, CreatorOffer, CreatorPayout,
--           CreatorPayoutEvent, CampaignRefund, CampaignDispute (all new)
-- Services: apps/api/src/services/creator/payout-*, services/campaign/{payment,refund,payout}*
--           (Phases 1-5 of the plan; every table is created EMPTY and filled only by that code,
--           each part behind its own switch)
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/creators-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE ... IF NOT EXISTS, the foreign key guarded
-- by a pg_constraint lookup, and the CHECK constraints below added inside CREATE TABLE.
-- Prisma does not model CHECK constraints, so everything else is byte-identical to the
-- generated output and `prisma migrate diff --from-url <db> ... --exit-code` shows no drift.
--
-- Purely additive: seven NEW tables, no ALTER of any existing table (creators,
-- campaign_bookings and campaign_booking_items are untouched: the new item statuses fit the
-- existing VARCHAR), no enum change, no data. The running API never reads these tables before
-- the deploy that ships the code, so applying this first is invisible to it.
--
-- Foreign keys: exactly ONE — creator_rate_terms.rate_card_id -> campaign_rate_cards ON DELETE
-- CASCADE (a share means nothing without its card). Offers, payouts, the event log and the
-- refund / dispute ledgers deliberately have NO foreign key to bookings, items, creators or
-- creator_assets: they are financial records and must outlive whatever they describe (a purged
-- page, a closed creator, a removed booking row must never cascade away a payout trail), and a
-- foreign key into a hot table would take a lock on it at DDL time. They carry plain ids and
-- snapshot the page name and handle instead.
--
-- CHECK constraints (the only data rules enforced here; statuses are VARCHAR validated in code):
--   creator_rate_terms.share_bps        0..9000   (the creator's share never exceeds 90%)
--   creator_payout_accounts.tds_bps     0..10000
--   creator_payouts amounts             all >= 0, amount <= gross <= item price (a payout can
--                                       never exceed what the brand paid for that item)
-- They exist only on a database built from this script, NOT on a `prisma db push` test
-- database, so the code validates the same limits itself.
--
-- ⚠️ Apply it as the LAST step before the merge, not while the PR waits. Until the code that
-- uses these tables is deployed they are EMPTY, and `prisma db push` drops an empty table
-- WITHOUT a data-loss prompt — any `db push` from a schema without these models in the
-- meantime would silently remove them. If a model changes after an early apply, ship an
-- ALTER: re-running this IF NOT EXISTS script would leave the old shape in place.
--
-- Safe to run twice: the second run changes nothing and raises no error (CREATE INDEX IF NOT
-- EXISTS still takes a brief SHARE lock on these new, empty tables).
--
-- Apply ONLY through psql, as the app role (never sudo -u postgres — a postgres-owned table
-- breaks later Prisma DDL) — or with the helper:
--   bash scripts/apply-creator-payouts-ddl.sh
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
-- Every name below is unqualified and psql's default search_path is "$user", public: a
-- schema named after the app role would otherwise receive the tables. Prisma uses public.
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_payout_accounts" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "razorpay_account_id" VARCHAR(64),
    "razorpay_stakeholder_id" VARCHAR(64),
    "razorpay_product_id" VARCHAR(64),
    "setup_step" VARCHAR(24) NOT NULL DEFAULT 'none',
    "activation_status" VARCHAR(24) NOT NULL DEFAULT 'not_started',
    "requirements" JSONB,
    "destination_hint" VARCHAR(80),
    "terms_version" VARCHAR(16),
    "terms_accepted_at" TIMESTAMP(3),
    "razorpay_tnc_accepted_at" TIMESTAMP(3),
    "tds_bps" INTEGER NOT NULL DEFAULT 0,
    "account_created_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "bookable_after" TIMESTAMP(3),
    "bank_change_requested_at" TIMESTAMP(3),
    "bank_change_cleared_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "last_error" VARCHAR(500),
    "setup_locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_payout_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "creator_payout_accounts_tds_bps_check" CHECK ("tds_bps" >= 0 AND "tds_bps" <= 10000)
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_rate_terms" (
    "id" TEXT NOT NULL,
    "rate_card_id" TEXT NOT NULL,
    "share_bps" INTEGER NOT NULL,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_rate_terms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "creator_rate_terms_share_bps_check" CHECK ("share_bps" >= 0 AND "share_bps" <= 9000)
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_offers" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "booking_item_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "creator_asset_id" TEXT NOT NULL,
    "page_name" VARCHAR(200) NOT NULL,
    "page_handle" VARCHAR(100),
    "platform" VARCHAR(16) NOT NULL,
    "format" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'offered',
    "payout_paise" INTEGER NOT NULL,
    "window_from" DATE,
    "window_to" DATE,
    "offered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "notified_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "withdrawn_at" TIMESTAMP(3),
    "withdrawn_by_id" TEXT,
    "closed_reason" VARCHAR(40),
    "creator_note" TEXT,
    "link_url" VARCHAR(500),
    "link_submitted_at" TIMESTAMP(3),
    -- TEXT, not a width: canonicalKey() returns the WHOLE lowercased URL for every shape it does not
    -- recognise (Facebook /posts/ and pfbid permalinks with tracking parameters run 300-450
    -- characters), so no fixed width below link_url's is safe. link_url's own 500 is what bounds the
    -- key (and so the btree entry of the index below); the application must still reject a longer
    -- link with a 400 rather than truncate the key, which would corrupt the one-post-one-offer match.
    "link_canonical_key" TEXT,
    "link_posted_at" TIMESTAMP(3),
    "ownership_check" VARCHAR(16),
    "ownership_detail" VARCHAR(300),
    "ownership_checked_at" TIMESTAMP(3),
    "ownership_checked_by_id" TEXT,
    "link_verified_at" TIMESTAMP(3),
    "link_verified_by_id" TEXT,
    "post_missing_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_payouts" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "booking_item_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "payout_account_id" TEXT NOT NULL,
    "razorpay_account_id" VARCHAR(64) NOT NULL,
    "razorpay_payment_id" VARCHAR(64) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'planned',
    "paused_at" TIMESTAMP(3),
    "paused_reason" VARCHAR(120),
    "item_price_paise" INTEGER NOT NULL,
    "share_bps" INTEGER NOT NULL,
    "gross_paise" INTEGER NOT NULL,
    "tds_bps" INTEGER NOT NULL DEFAULT 0,
    "tds_paise" INTEGER NOT NULL DEFAULT 0,
    "amount_paise" INTEGER NOT NULL,
    "razorpay_transfer_id" VARCHAR(64),
    "transfer_status" VARCHAR(24),
    "settlement_status" VARCHAR(24),
    "recipient_settlement_status" VARCHAR(16),
    "on_hold_verified_at" TIMESTAMP(3),
    "amount_reversed_paise" INTEGER NOT NULL DEFAULT 0,
    "razorpay_reversal_id" VARCHAR(64),
    "recipient_settlement_id" VARCHAR(64),
    "settlement_utr" VARCHAR(64),
    "settlement_amount_paise" INTEGER,
    "settlement_fee_paise" INTEGER,
    "transfer_fees_paise" INTEGER,
    "transfer_tax_paise" INTEGER,
    "destination_hint" VARCHAR(80),
    "release_after" TIMESTAMP(3),
    "transfer_requested_at" TIMESTAMP(3),
    "held_at" TIMESTAMP(3),
    "release_requested_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "reversal_requested_at" TIMESTAMP(3),
    "reversed_at" TIMESTAMP(3),
    "void_reason" VARCHAR(40),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "absent_checks" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "error_code" VARCHAR(80),
    "last_error" VARCHAR(500),
    "alerted_status" VARCHAR(24),
    "alerted_at" TIMESTAMP(3),
    "manual_reference" VARCHAR(100),
    "manual_paid_at" TIMESTAMP(3),
    "manual_paid_by_id" TEXT,
    "manual_note" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_payouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "creator_payouts_amounts_check" CHECK ("gross_paise" >= 0 AND "tds_paise" >= 0 AND "amount_paise" >= 0 AND "amount_paise" <= "gross_paise" AND "gross_paise" <= "item_price_paise")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_payout_events" (
    "id" TEXT NOT NULL,
    "payout_id" TEXT NOT NULL,
    "booking_id" TEXT,
    "kind" VARCHAR(40) NOT NULL,
    "from_status" VARCHAR(24),
    "to_status" VARCHAR(24),
    "amount_paise" INTEGER,
    "actor_type" VARCHAR(12) NOT NULL DEFAULT 'system',
    "actor_id" TEXT,
    "razorpay_event_id" VARCHAR(100),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_payout_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "campaign_refunds" (
    "id" TEXT NOT NULL,
    "razorpay_refund_id" VARCHAR(64),
    "idempotency_key" VARCHAR(100),
    "payment_id" TEXT,
    "razorpay_payment_id" VARCHAR(64) NOT NULL,
    "booking_id" TEXT,
    "booking_item_id" TEXT,
    "amount_paise" INTEGER NOT NULL,
    "receipt" VARCHAR(100),
    "status" VARCHAR(16) NOT NULL DEFAULT 'requested',
    "origin" VARCHAR(8) NOT NULL DEFAULT 'ours',
    "reason" VARCHAR(60),
    "last_error" VARCHAR(500),
    "last_checked_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "campaign_disputes" (
    "id" TEXT NOT NULL,
    "razorpay_dispute_id" VARCHAR(64) NOT NULL,
    "razorpay_payment_id" VARCHAR(64) NOT NULL,
    "booking_id" TEXT,
    "amount_paise" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "status" VARCHAR(24) NOT NULL,
    "phase" VARCHAR(24),
    "reason_code" VARCHAR(60),
    "respond_by" TIMESTAMP(3),
    "opened_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "last_event" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_payout_accounts_creator_id_key" ON "creator_payout_accounts"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_payout_accounts_razorpay_account_id_key" ON "creator_payout_accounts"("razorpay_account_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_payout_accounts_activation_status_idx" ON "creator_payout_accounts"("activation_status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_rate_terms_rate_card_id_key" ON "creator_rate_terms"("rate_card_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_offers_booking_item_id_key" ON "creator_offers"("booking_item_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_offers_creator_id_status_idx" ON "creator_offers"("creator_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_offers_booking_id_idx" ON "creator_offers"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_offers_status_expires_at_idx" ON "creator_offers"("status", "expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_offers_link_canonical_key_idx" ON "creator_offers"("link_canonical_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_payouts_booking_item_id_key" ON "creator_payouts"("booking_item_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_payouts_razorpay_transfer_id_key" ON "creator_payouts"("razorpay_transfer_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_payouts_status_next_attempt_at_idx" ON "creator_payouts"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_payouts_creator_id_idx" ON "creator_payouts"("creator_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_payouts_booking_id_idx" ON "creator_payouts"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_payouts_razorpay_payment_id_idx" ON "creator_payouts"("razorpay_payment_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_payout_events_payout_id_created_at_idx" ON "creator_payout_events"("payout_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_payout_events_booking_id_created_at_idx" ON "creator_payout_events"("booking_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_refunds_razorpay_refund_id_key" ON "campaign_refunds"("razorpay_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_refunds_idempotency_key_key" ON "campaign_refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_refunds_razorpay_payment_id_idx" ON "campaign_refunds"("razorpay_payment_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_refunds_booking_id_idx" ON "campaign_refunds"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_refunds_booking_item_id_idx" ON "campaign_refunds"("booking_item_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_refunds_status_last_checked_at_idx" ON "campaign_refunds"("status", "last_checked_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_disputes_razorpay_dispute_id_key" ON "campaign_disputes"("razorpay_dispute_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_disputes_razorpay_payment_id_idx" ON "campaign_disputes"("razorpay_payment_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_disputes_status_idx" ON "campaign_disputes"("status");

-- AddForeignKey (the ONLY one: creator_rate_terms -> campaign_rate_cards. ADD FOREIGN KEY takes a
-- brief SHARE ROW EXCLUSIVE lock on campaign_rate_cards — writes wait, reads do not; it is a small
-- staff-edited table and lock_timeout makes the transaction give up instead of queueing behind one)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_rate_terms_rate_card_id_fkey' AND conrelid = '"public"."creator_rate_terms"'::regclass) THEN
    ALTER TABLE "creator_rate_terms" ADD CONSTRAINT "creator_rate_terms_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "campaign_rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
