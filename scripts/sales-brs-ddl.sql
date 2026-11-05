-- ============================================================================
-- scripts/sales-brs-ddl.sql — feature-only DDL for the Bank tab of the sales portal's /reconcile
-- page (bank reconciliation statement, receipts side; spec-reconcile.md PR 6, 2026-11-05).
-- Models:   SalesBrsSignoff (new); SalesBankAccount (+brsSignoffs — a Prisma-only back-relation)
-- Services: apps/api/src/services/sales/recon/brs*.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <base schema.prisma (bank + reconcile merged)>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-recurring-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE ... IF NOT EXISTS, the foreign key guarded by
-- a pg_constraint lookup. Definitions are byte-identical to the generated output.
--
-- Purely additive: 1 new table (FK → sales_bank_accounts RESTRICT, a brief SHARE ROW EXCLUSIVE
-- lock on that table). Requires the bank DDL (scripts/sales-bank-ddl.sql). Safe to re-run.
-- Apply on prod with scripts/apply-sales-brs-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_brs_signoffs" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "bank_account_id" TEXT NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "version" INTEGER NOT NULL,
    "active_key" VARCHAR(64),
    "fingerprint" VARCHAR(32) NOT NULL,
    "balance_source" VARCHAR(9) NOT NULL,
    "opening_paise" BIGINT NOT NULL,
    "credits_paise" BIGINT NOT NULL,
    "debits_paise" BIGINT NOT NULL,
    "closing_paise" BIGINT NOT NULL,
    "books_paise" BIGINT NOT NULL,
    "open_items_paise" BIGINT NOT NULL,
    "open_item_count" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "accepted" JSONB NOT NULL,
    "note" VARCHAR(1000),
    "reconciled_by_id" TEXT NOT NULL,
    "reconciled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMP(3),
    "superseded_by_id" TEXT,
    "supersede_kind" VARCHAR(16),
    "supersede_reason" VARCHAR(500),

    CONSTRAINT "sales_brs_signoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_brs_signoffs_active_key_key" ON "sales_brs_signoffs"("active_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_brs_signoffs_company_key_month_idx" ON "sales_brs_signoffs"("company_key", "month");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_brs_signoffs_bank_account_id_month_version_key" ON "sales_brs_signoffs"("bank_account_id", "month", "version");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_brs_signoffs_bank_account_id_fkey') THEN
    ALTER TABLE "sales_brs_signoffs" ADD CONSTRAINT "sales_brs_signoffs_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "sales_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
