-- ============================================================================
-- scripts/campaign-event-price-ddl.sql — feature-only DDL for the Event campaign type
-- (owner sheet "Digital Sukoon Private Limited Management", 2026-11-18).
-- Model:    CampaignRateCard (+eventPricePaise)
-- Service:  apps/api/src/services/campaign/rate-card.service.ts (priceFor → basePriceForType)
--
-- Same shape as scripts/sales-invoice-po-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN IF NOT EXISTS. The definition is
-- byte-identical to `prisma migrate diff` output for the schema change.
--
-- Purely additive: one nullable column on campaign_rate_cards (null = the account is not offered
-- for event campaigns). campaign_bookings.campaign_type and sales_*.campaign_type are already
-- VARCHAR(16), so "event" needs no DDL there. Safe to re-run.
-- Apply on prod with scripts/apply-campaign-event-price-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "campaign_rate_cards" ADD COLUMN IF NOT EXISTS "event_price_paise" INTEGER;

COMMIT;
