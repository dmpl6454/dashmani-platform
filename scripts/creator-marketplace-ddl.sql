-- ============================================================================
-- scripts/creator-marketplace-ddl.sql — feature-only DDL for the creator marketplace
-- (creator portal Phase B/C): the creator's own price per page and format, our margin on top,
-- and the creator's own accept / decline on each booked post.
-- Models:   CreatorPagePrice (new: creator_page_prices), CampaignRateCard (+creator_payout_paise),
--           CampaignBookingItem (+6 creator_* columns, +1 index)
-- Services: apps/api/src/services/campaign/{rate-card,review,publish,payment}.service.ts,
--           apps/api/src/services/creator/creator-{offers,pricing}.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/campaign-overrides-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE ... IF NOT EXISTS, the foreign
-- key guarded by a pg_constraint lookup.
-- Definitions are byte-identical to the generated output, so `prisma migrate diff --from-url
-- <db> ... --exit-code` shows no drift.
--
-- Purely additive: every new column is nullable, so the running API (whose Prisma client does
-- not select them) keeps working before and after the deploy. The two ALTER TABLEs take a brief
-- ACCESS EXCLUSIVE lock on campaign_rate_cards / campaign_booking_items only (small tables, no
-- hot path). The index is built inside the transaction (campaign_booking_items holds hundreds
-- of rows, not millions). The new table's foreign key to creator_assets (ON DELETE CASCADE)
-- takes a brief SHARE ROW EXCLUSIVE lock on creator_assets (a few hundred rows). Nothing touches
-- clients / users / meta_assets.
--
-- Safe to run twice: the second run changes nothing and raises no error.
-- Apply ONLY through psql, as the app role (never sudo -u postgres):
--   psql "$DBURL" -v ON_ERROR_STOP=1 -f scripts/creator-marketplace-ddl.sql
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "campaign_rate_cards" ADD COLUMN IF NOT EXISTS "creator_payout_paise" INTEGER;

-- AlterTable
ALTER TABLE "campaign_booking_items" ADD COLUMN IF NOT EXISTS "creator_decided_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "creator_decline_reason" VARCHAR(500),
ADD COLUMN IF NOT EXISTS "creator_id" TEXT,
ADD COLUMN IF NOT EXISTS "creator_offered_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "creator_payout_paise" INTEGER,
ADD COLUMN IF NOT EXISTS "creator_respond_by" TIMESTAMP(3);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_page_prices" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "format" VARCHAR(16) NOT NULL,
    "creator_price_paise" INTEGER,
    "creator_updated_at" TIMESTAMP(3),
    "margin_bps" INTEGER,
    "entertainment_margin_bps" INTEGER,
    "audio_addon_paise" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "staff_updated_by_id" TEXT,
    "staff_updated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_page_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_page_prices_asset_id_format_key" ON "creator_page_prices"("asset_id", "format");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_booking_items_creator_id_status_idx" ON "campaign_booking_items"("creator_id", "status");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_page_prices_asset_id_fkey' AND conrelid = '"public"."creator_page_prices"'::regclass) THEN
    ALTER TABLE "creator_page_prices" ADD CONSTRAINT "creator_page_prices_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "creator_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
