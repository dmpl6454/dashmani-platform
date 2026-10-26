-- ============================================================================
-- scripts/sales-einvoice-ddl.sql — feature-only DDL for e-invoicing (2026-10-27): one new table,
-- sales_einvoices, holding the IRP registration (IRN, acknowledgement, signed QR/invoice) of each
-- tax invoice and credit note that needs one. Model: SalesEInvoice. Service:
-- apps/api/src/services/sales/einvoice.service.ts.
-- Generated with `prisma migrate diff` (origin/main schema → branch schema) and hand-edited like
-- scripts/sales-ddl.sql: one transaction, lock_timeout 3s, IF NOT EXISTS, FKs guarded by
-- pg_constraint. Purely additive. Apply on prod with scripts/apply-sales-einvoice-ddl.sh BEFORE merging.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE IF NOT EXISTS "sales_einvoices" (
    "id" TEXT NOT NULL,
    "doc_type" VARCHAR(4) NOT NULL,
    "invoice_id" TEXT,
    "credit_note_id" TEXT,
    "gstin" VARCHAR(15) NOT NULL,
    "doc_number" VARCHAR(32) NOT NULL,
    "doc_date" VARCHAR(10) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "irn" VARCHAR(64),
    "ack_no" VARCHAR(24),
    "ack_date" TIMESTAMP(3),
    "signed_qr_code" TEXT,
    "signed_invoice" TEXT,
    "payload" JSONB,
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cancel_reason" VARCHAR(100),
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sales_einvoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sales_einvoices_invoice_id_key" ON "sales_einvoices"("invoice_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_einvoices_credit_note_id_key" ON "sales_einvoices"("credit_note_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_einvoices_irn_key" ON "sales_einvoices"("irn");
CREATE INDEX IF NOT EXISTS "sales_einvoices_status_idx" ON "sales_einvoices"("status");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_einvoices_invoice_id_fkey') THEN
    ALTER TABLE "sales_einvoices" ADD CONSTRAINT "sales_einvoices_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_einvoices_credit_note_id_fkey') THEN
    ALTER TABLE "sales_einvoices" ADD CONSTRAINT "sales_einvoices_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "sales_credit_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
