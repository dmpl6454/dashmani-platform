-- ============================================================================
-- scripts/sales-billing-ddl.sql — feature-only DDL for the sales billing follow-ups (2026-10-27):
-- voiding a recorded payment, refunds out of a receipt's unallocated amount, and the link from a
-- tax invoice back to the proforma it was converted from.
-- Models:   SalesPayment (+status, void fields), SalesRefund (new), SalesInvoice (+convertedFromId)
-- Services: apps/api/src/services/sales/payments.service.ts, invoices.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-ddl.sql: one transaction, lock_timeout 3s, statement_timeout
-- 60s, search_path pinned, ADD COLUMN / CREATE ... IF NOT EXISTS, foreign keys guarded by
-- pg_constraint lookups. Definitions are byte-identical to the generated output, so
-- `prisma migrate diff --from-url <db> ... --exit-code` shows no drift.
--
-- Purely additive: three nullable columns, one NOT NULL column with a constant default (metadata
-- only on Postgres 11+, no table rewrite), one new table. Safe to re-run: a second run changes
-- nothing. Apply on prod with scripts/apply-sales-billing-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "converted_from_id" TEXT;

-- AlterTable
ALTER TABLE "sales_payments" ADD COLUMN IF NOT EXISTS "status" VARCHAR(16) NOT NULL DEFAULT 'recorded';
ALTER TABLE "sales_payments" ADD COLUMN IF NOT EXISTS "void_reason" VARCHAR(300);
ALTER TABLE "sales_payments" ADD COLUMN IF NOT EXISTS "voided_at" TIMESTAMP(3);
ALTER TABLE "sales_payments" ADD COLUMN IF NOT EXISTS "voided_by_id" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_refunds" (
    "id" TEXT NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "payment_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "reference" VARCHAR(120),
    "refunded_on" DATE NOT NULL,
    "notes" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'issued',
    "cancelled_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_refunds_number_key" ON "sales_refunds"("number");
CREATE INDEX IF NOT EXISTS "sales_refunds_payment_id_idx" ON "sales_refunds"("payment_id");
CREATE INDEX IF NOT EXISTS "sales_refunds_client_id_refunded_on_idx" ON "sales_refunds"("client_id", "refunded_on");
CREATE INDEX IF NOT EXISTS "sales_invoices_converted_from_id_idx" ON "sales_invoices"("converted_from_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_invoices_converted_from_id_fkey') THEN
    ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_converted_from_id_fkey" FOREIGN KEY ("converted_from_id") REFERENCES "sales_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_refunds_payment_id_fkey') THEN
    ALTER TABLE "sales_refunds" ADD CONSTRAINT "sales_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "sales_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_refunds_client_id_fkey') THEN
    ALTER TABLE "sales_refunds" ADD CONSTRAINT "sales_refunds_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
