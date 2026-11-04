-- ============================================================================
-- scripts/creator-marketplace-ddl.sql — feature-only DDL for the creator marketplace
-- (creator portal Phase B/C): staff-set prices on creator pages, and the creator's own
-- accept / decline on each booked post.
-- Models:   CampaignRateCard (+creator_payout_paise),
--           CampaignBookingItem (+6 creator_* columns, +1 index)
-- Services: apps/api/src/services/campaign/{rate-card,review,publish}.service.ts,
--           apps/api/src/services/creator/creator-{offers,pricing}.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/campaign-overrides-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE INDEX ... IF NOT EXISTS.
-- Definitions are byte-identical to the generated output, so `prisma migrate diff --from-url
-- <db> ... --exit-code` shows no drift.
--
-- Purely additive: every new column is nullable, so the running API (whose Prisma client does
-- not select them) keeps working before and after the deploy. The two ALTER TABLEs take a brief
-- ACCESS EXCLUSIVE lock on campaign_rate_cards / campaign_booking_items only (small tables, no
-- hot path). The index is built inside the transaction (campaign_booking_items holds hundreds
-- of rows, not millions). Nothing touches clients / users / meta_assets / creator_*.
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

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_booking_items_creator_id_status_idx" ON "campaign_booking_items"("creator_id", "status");

COMMIT;
