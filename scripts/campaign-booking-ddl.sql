-- ============================================================================
-- scripts/campaign-booking-ddl.sql — feature-only DDL for self-serve campaign booking
-- (client portal "Start a campaign": rate card, bookings, uploads, Razorpay payments).
-- Models:   CampaignRateCard, CampaignBooking, CampaignMedia, CampaignBookingItem,
--           CampaignPayment, RazorpayWebhookEvent, CampaignBookingEvent (schema.prisma)
-- Services: apps/api/src/services/campaign/*
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/posting-watch-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE ... IF NOT EXISTS, foreign keys guarded
-- by pg_constraint lookups. Column / index definitions are byte-identical to the generated
-- output, so `prisma migrate diff --from-url <db> ... --exit-code` shows no drift.
--
-- Touches ONLY new tables. The one existing table referenced is "clients" (two FKs, added
-- LAST): each takes a brief SHARE ROW EXCLUSIVE lock on "clients" until COMMIT — client
-- logins only read that table, so nothing waits. No enum is created or altered (statuses are
-- VARCHAR), and nothing references meta_assets / social_accounts / users.
--
-- The running API ignores tables its Prisma client does not know, so applying this before
-- the deploy changes nothing visible.
-- ⚠️ Apply it as the LAST step before the merge: until the code is deployed the tables are
-- EMPTY, and `prisma db push` drops empty tables without a prompt.
--
-- Safe to run twice: the second run changes nothing and raises no error.
-- Apply ONLY through psql, as the app role (never sudo -u postgres):
--   psql "$DBURL" -v ON_ERROR_STOP=1 -f scripts/campaign-booking-ddl.sql
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "campaign_rate_cards" (
    "id" TEXT NOT NULL,
    "target_type" VARCHAR(16) NOT NULL,
    "target_id" TEXT NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "format" VARCHAR(16) NOT NULL,
    "price_paise" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "category" VARCHAR(60),
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "campaign_bookings" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "brand" VARCHAR(200) NOT NULL,
    "objective" TEXT,
    "launch_from" DATE,
    "launch_to" DATE,
    "format" VARCHAR(16),
    "caption" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "user_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collaborators" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "super_text" VARCHAR(200),
    "super_text_style" VARCHAR(24),
    "status" VARCHAR(24) NOT NULL DEFAULT 'draft',
    "total_paise" INTEGER,
    "pricing_snapshot" JSONB,
    "review_note" TEXT,
    "reviewed_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "campaign_media" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "booking_id" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "kind" VARCHAR(8) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime" VARCHAR(64),
    "bytes" BIGINT NOT NULL,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "storage_key" VARCHAR(64) NOT NULL,
    "ext" VARCHAR(8) NOT NULL,
    "upload_status" VARCHAR(16) NOT NULL DEFAULT 'uploading',
    "chunk_size" INTEGER NOT NULL,
    "total_chunks" INTEGER NOT NULL,
    "reject_reason" VARCHAR(300),
    "render_key" VARCHAR(64),
    "render_status" VARCHAR(16) NOT NULL DEFAULT 'none',
    "render_error" VARCHAR(500),
    "render_locked_until" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "campaign_booking_items" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "rate_card_id" TEXT NOT NULL,
    "target_type" VARCHAR(16) NOT NULL,
    "target_id" TEXT NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "format" VARCHAR(16) NOT NULL,
    "account_name" VARCHAR(200) NOT NULL,
    "account_handle" VARCHAR(100),
    "price_paise" INTEGER NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "container_id" TEXT,
    "remote_post_id" TEXT,
    "permalink" VARCHAR(500),
    "posted_at" TIMESTAMP(3),
    "posted_by_id" TEXT,
    "last_error" VARCHAR(500),
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_booking_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "campaign_payments" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "razorpay_order_id" VARCHAR(64) NOT NULL,
    "razorpay_payment_id" VARCHAR(64),
    "amount_paise" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "status" VARCHAR(24) NOT NULL DEFAULT 'created',
    "refund_id" VARCHAR(64),
    "refunded_paise" INTEGER NOT NULL DEFAULT 0,
    "last_event" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "razorpay_webhook_events" (
    "id" TEXT NOT NULL,
    "event_id" VARCHAR(100) NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "razorpay_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "campaign_booking_events" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "actor_type" VARCHAR(8) NOT NULL,
    "actor_id" TEXT,
    "from_status" VARCHAR(24),
    "to_status" VARCHAR(24),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_rate_cards_active_platform_idx" ON "campaign_rate_cards"("active", "platform");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_rate_cards_target_type_target_id_format_key" ON "campaign_rate_cards"("target_type", "target_id", "format");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_bookings_client_id_created_at_idx" ON "campaign_bookings"("client_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_bookings_status_updated_at_idx" ON "campaign_bookings"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_media_storage_key_key" ON "campaign_media"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_media_render_key_key" ON "campaign_media"("render_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_media_client_id_upload_status_idx" ON "campaign_media"("client_id", "upload_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_media_booking_id_position_idx" ON "campaign_media"("booking_id", "position");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_media_render_status_idx" ON "campaign_media"("render_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_booking_items_status_next_attempt_at_idx" ON "campaign_booking_items"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_booking_items_booking_id_target_type_target_id_for_key" ON "campaign_booking_items"("booking_id", "target_type", "target_id", "format");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_payments_razorpay_order_id_key" ON "campaign_payments"("razorpay_order_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_payments_razorpay_payment_id_key" ON "campaign_payments"("razorpay_payment_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_payments_booking_id_idx" ON "campaign_payments"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "razorpay_webhook_events_event_id_key" ON "razorpay_webhook_events"("event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_booking_events_booking_id_created_at_idx" ON "campaign_booking_events"("booking_id", "created_at");

-- AddForeignKey (campaign -> campaign; no lock on any existing table)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_media_booking_id_fkey' AND conrelid = '"public"."campaign_media"'::regclass) THEN
    ALTER TABLE "campaign_media" ADD CONSTRAINT "campaign_media_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "campaign_bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_booking_items_booking_id_fkey' AND conrelid = '"public"."campaign_booking_items"'::regclass) THEN
    ALTER TABLE "campaign_booking_items" ADD CONSTRAINT "campaign_booking_items_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "campaign_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_payments_booking_id_fkey' AND conrelid = '"public"."campaign_payments"'::regclass) THEN
    ALTER TABLE "campaign_payments" ADD CONSTRAINT "campaign_payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "campaign_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_booking_events_booking_id_fkey' AND conrelid = '"public"."campaign_booking_events"'::regclass) THEN
    ALTER TABLE "campaign_booking_events" ADD CONSTRAINT "campaign_booking_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "campaign_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (campaign -> "clients"). LAST on purpose: each takes the SHARE ROW EXCLUSIVE
-- lock on "clients" described in the header, held from here until COMMIT.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_bookings_client_id_fkey' AND conrelid = '"public"."campaign_bookings"'::regclass) THEN
    ALTER TABLE "campaign_bookings" ADD CONSTRAINT "campaign_bookings_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_media_client_id_fkey' AND conrelid = '"public"."campaign_media"'::regclass) THEN
    ALTER TABLE "campaign_media" ADD CONSTRAINT "campaign_media_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
