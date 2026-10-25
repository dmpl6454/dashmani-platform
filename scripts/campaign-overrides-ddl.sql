-- ============================================================================
-- scripts/campaign-overrides-ddl.sql — feature-only DDL for per-account campaign text
-- (a different caption / overlay per booked account, a client-supplied thumbnail) and the
-- per-variant renders that go with it.
-- Models:   CampaignBookingItem (+4 columns), CampaignMedia (+role), CampaignMediaRender (new)
-- Services: apps/api/src/services/campaign/{booking,render,publish}.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/campaign-booking-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE ... IF NOT EXISTS, foreign
-- keys guarded by pg_constraint lookups. Definitions are byte-identical to the generated
-- output, so `prisma migrate diff --from-url <db> ... --exit-code` shows no drift.
--
-- Purely additive: every new column is nullable or has a default, so the running API (whose
-- Prisma client does not select them) keeps working before and after the deploy. The two
-- ALTER TABLEs take a brief ACCESS EXCLUSIVE lock on campaign_media / campaign_booking_items
-- only (small tables, no hot path). Nothing touches clients / users / meta_assets.
--
-- Safe to run twice: the second run changes nothing and raises no error.
-- Apply ONLY through psql, as the app role (never sudo -u postgres):
--   psql "$DBURL" -v ON_ERROR_STOP=1 -f scripts/campaign-overrides-ddl.sql
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "campaign_media" ADD COLUMN IF NOT EXISTS "role" VARCHAR(16) NOT NULL DEFAULT 'creative';

-- AlterTable
ALTER TABLE "campaign_booking_items" ADD COLUMN IF NOT EXISTS "caption_override" TEXT,
ADD COLUMN IF NOT EXISTS "hashtags_override" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "super_text_override" VARCHAR(200),
ADD COLUMN IF NOT EXISTS "super_text_style_override" VARCHAR(24);

-- CreateTable
CREATE TABLE IF NOT EXISTS "campaign_media_renders" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "overlay_key" VARCHAR(64) NOT NULL,
    "overlay_text" VARCHAR(200),
    "overlay_style" VARCHAR(24),
    "render_key" VARCHAR(64),
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "error" VARCHAR(500),
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_media_renders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_media_renders_render_key_key" ON "campaign_media_renders"("render_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_media_renders_status_idx" ON "campaign_media_renders"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "campaign_media_renders_booking_id_idx" ON "campaign_media_renders"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_media_renders_media_id_overlay_key_key" ON "campaign_media_renders"("media_id", "overlay_key");

-- AddForeignKey (campaign -> campaign; no lock on any pre-existing table outside the feature)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_media_renders_media_id_fkey' AND conrelid = '"public"."campaign_media_renders"'::regclass) THEN
    ALTER TABLE "campaign_media_renders" ADD CONSTRAINT "campaign_media_renders_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "campaign_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_media_renders_booking_id_fkey' AND conrelid = '"public"."campaign_media_renders"'::regclass) THEN
    ALTER TABLE "campaign_media_renders" ADD CONSTRAINT "campaign_media_renders_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "campaign_bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
