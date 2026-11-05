-- ============================================================================
-- scripts/sales-import-ddl.sql — feature-only DDL for the old-invoice import from Swipe
-- (smart invoicing PR 3, branch feat/sales-import, 2026-11-05).
-- Models:   SalesImport (new), SalesImportInvoice (new),
--           SalesInvoice (+source NOT NULL DEFAULT 'portal', +importId), SalesPayment (+importId)
-- Services: apps/api/src/services/sales/imports.service.ts, services/sales/import/*
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-recurring-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE ... IF NOT EXISTS, foreign keys
-- guarded by pg_constraint lookups. Definitions are byte-identical to the generated output; only
-- the line order differs.
--
-- Additive: two new tables, three new columns. The NOT NULL DEFAULT 'portal' column is
-- metadata-only on PG 11+ (no table rewrite); every new import_id is NULL, so the foreign keys
-- validate instantly. Safe to re-run.
-- Apply on prod with scripts/apply-sales-import-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "import_id" TEXT;
ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "source" VARCHAR(16) NOT NULL DEFAULT 'portal';
ALTER TABLE "sales_payments" ADD COLUMN IF NOT EXISTS "import_id" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_imports" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'swipe',
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "file_name" VARCHAR(255) NOT NULL,
    "file_sha256" VARCHAR(64) NOT NULL,
    "file_bytes" INTEGER NOT NULL,
    "file_kind" VARCHAR(8) NOT NULL,
    "sheet_name" VARCHAR(100),
    "sheet_names" JSONB NOT NULL,
    "header_row" INTEGER NOT NULL,
    "header_signature" VARCHAR(64) NOT NULL,
    "grid" JSONB NOT NULL,
    "mapping" JSONB NOT NULL,
    "mapping_how" JSONB NOT NULL,
    "options" JSONB NOT NULL,
    "client_choices" JSONB NOT NULL,
    "created_clients" JSONB NOT NULL,
    "summary" JSONB,
    "plan_hash" VARCHAR(64) NOT NULL,
    "rows_total" INTEGER NOT NULL DEFAULT 0,
    "invoices_found" INTEGER NOT NULL DEFAULT 0,
    "invoices_ready" INTEGER NOT NULL DEFAULT 0,
    "invoices_imported" INTEGER NOT NULL DEFAULT 0,
    "invoices_skipped" INTEGER NOT NULL DEFAULT 0,
    "invoices_failed" INTEGER NOT NULL DEFAULT 0,
    "clients_matched" INTEGER NOT NULL DEFAULT 0,
    "clients_created" INTEGER NOT NULL DEFAULT 0,
    "payments_created" INTEGER NOT NULL DEFAULT 0,
    "taxable_paise" BIGINT NOT NULL DEFAULT 0,
    "tax_paise" BIGINT NOT NULL DEFAULT 0,
    "total_paise" BIGINT NOT NULL DEFAULT 0,
    "paid_paise" BIGINT NOT NULL DEFAULT 0,
    "tds_paise" BIGINT NOT NULL DEFAULT 0,
    "checked_at" TIMESTAMP(3),
    "apply_started_at" TIMESTAMP(3),
    "applied_at" TIMESTAMP(3),
    "applied_by_id" TEXT,
    "last_error" VARCHAR(500),
    "undone_at" TIMESTAMP(3),
    "undone_by_id" TEXT,
    "undo_reason" VARCHAR(300),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_import_invoices" (
    "id" TEXT NOT NULL,
    "import_id" TEXT NOT NULL,
    "invoice_key" VARCHAR(32) NOT NULL,
    "number" VARCHAR(32) NOT NULL,
    "row_nos" JSONB NOT NULL,
    "issue_date" DATE,
    "financial_year" VARCHAR(7),
    "client_group" VARCHAR(80) NOT NULL,
    "seller_gstin" VARCHAR(15),
    "outcome" VARCHAR(16) NOT NULL,
    "total_paise" INTEGER,
    "paid_paise" INTEGER NOT NULL DEFAULT 0,
    "tds_paise" INTEGER NOT NULL DEFAULT 0,
    "issues" JSONB NOT NULL,
    "plan" JSONB,
    "invoice_id" TEXT,
    "payment_id" TEXT,
    "error" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_import_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_imports_company_key_created_at_idx" ON "sales_imports"("company_key", "created_at");
CREATE INDEX IF NOT EXISTS "sales_imports_file_sha256_idx" ON "sales_imports"("file_sha256");
CREATE INDEX IF NOT EXISTS "sales_imports_header_signature_idx" ON "sales_imports"("header_signature");
CREATE INDEX IF NOT EXISTS "sales_import_invoices_import_id_outcome_idx" ON "sales_import_invoices"("import_id", "outcome");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_import_invoices_import_id_invoice_key_key" ON "sales_import_invoices"("import_id", "invoice_key");
CREATE INDEX IF NOT EXISTS "sales_invoices_import_id_idx" ON "sales_invoices"("import_id");
CREATE INDEX IF NOT EXISTS "sales_payments_import_id_idx" ON "sales_payments"("import_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_invoices_import_id_fkey') THEN
    ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "sales_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_payments_import_id_fkey') THEN
    ALTER TABLE "sales_payments" ADD CONSTRAINT "sales_payments_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "sales_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_import_invoices_import_id_fkey') THEN
    ALTER TABLE "sales_import_invoices" ADD CONSTRAINT "sales_import_invoices_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "sales_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
