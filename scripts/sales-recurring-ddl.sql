-- ============================================================================
-- scripts/sales-recurring-ddl.sql — feature-only DDL for recurring / retainer invoices and the
-- hand-picked GST registration on an invoice (2026-10-31).
-- Models:   SalesRecurringInvoice (new), SalesInvoice (+sellerGstin, +recurringId)
-- Services: apps/api/src/services/sales/recurring.service.ts, invoices.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-billing-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE ... IF NOT EXISTS, foreign keys
-- guarded by pg_constraint lookups. Definitions are byte-identical to the generated output.
--
-- Purely additive: two nullable columns on sales_invoices, one new table. Safe to re-run.
-- Apply on prod with scripts/apply-sales-recurring-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "recurring_id" TEXT;
ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "seller_gstin" VARCHAR(15);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_recurring_invoices" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL DEFAULT 'dspl',
    "client_id" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'tax_invoice',
    "frequency" VARCHAR(16) NOT NULL,
    "day_of_month" INTEGER NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "next_run_date" DATE NOT NULL,
    "mode" VARCHAR(8) NOT NULL DEFAULT 'draft',
    "place_of_supply_code" VARCHAR(2),
    "tax_mode" VARCHAR(8),
    "gst_rate_bp" INTEGER,
    "seller_gstin" VARCHAR(15),
    "discount_paise" INTEGER NOT NULL DEFAULT 0,
    "due_days" INTEGER,
    "notes" TEXT,
    "lines" JSONB NOT NULL,
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "last_invoice_id" TEXT,
    "last_run_at" TIMESTAMP(3),
    "last_error" VARCHAR(500),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_recurring_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_recurring_invoices_status_next_run_date_idx" ON "sales_recurring_invoices"("status", "next_run_date");
CREATE INDEX IF NOT EXISTS "sales_recurring_invoices_client_id_idx" ON "sales_recurring_invoices"("client_id");
CREATE INDEX IF NOT EXISTS "sales_recurring_invoices_company_key_idx" ON "sales_recurring_invoices"("company_key");
CREATE INDEX IF NOT EXISTS "sales_invoices_recurring_id_idx" ON "sales_invoices"("recurring_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_invoices_recurring_id_fkey') THEN
    ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_recurring_id_fkey" FOREIGN KEY ("recurring_id") REFERENCES "sales_recurring_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_recurring_invoices_client_id_fkey') THEN
    ALTER TABLE "sales_recurring_invoices" ADD CONSTRAINT "sales_recurring_invoices_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
