-- ============================================================================
-- scripts/sales-reconcile-ddl.sql — feature-only DDL for the sales portal's /reconcile page
-- (Form 26AS, GSTR-1 and client balance confirmations; spec-reconcile.md PR 5, 2026-11-05).
-- Models:   SalesTdsDeductor, SalesTdsUpload, SalesTdsEntry, SalesGstr1Upload, SalesGstr1Doc,
--           SalesBalanceConfirmation, SalesConfirmationFile (new); ClientBillingProfile (+tan)
-- Services: apps/api/src/services/sales/recon/*
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-recurring-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE ... IF NOT EXISTS, foreign keys
-- guarded by pg_constraint lookups. Definitions are byte-identical to the generated output.
--
-- Purely additive: 7 new tables, one nullable column (+ its unique index) on
-- client_billing_profiles (metadata-only ADD COLUMN; the index builds over a few hundred NULLs).
-- Safe to re-run. Apply on prod with scripts/apply-sales-reconcile-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "client_billing_profiles" ADD COLUMN IF NOT EXISTS "tan" VARCHAR(10);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_tds_deductors" (
    "id" TEXT NOT NULL,
    "tan" VARCHAR(10) NOT NULL,
    "kind" VARCHAR(10) NOT NULL DEFAULT 'client',
    "client_id" TEXT,
    "label" VARCHAR(120),
    "name_seen" VARCHAR(200),
    "source" VARCHAR(8) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_tds_deductors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_tds_uploads" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "financial_year" VARCHAR(7) NOT NULL,
    "format" VARCHAR(12) NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "file_sha256" VARCHAR(64) NOT NULL,
    "file_bytes" INTEGER NOT NULL,
    "pan" VARCHAR(10),
    "as_on" DATE,
    "entry_count" INTEGER NOT NULL,
    "deductor_count" INTEGER NOT NULL,
    "amount_paid_paise" BIGINT NOT NULL DEFAULT 0,
    "tds_paise" BIGINT NOT NULL DEFAULT 0,
    "deposited_paise" BIGINT NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "error_rows" JSONB,
    "current_since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_tds_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_tds_entries" (
    "id" TEXT NOT NULL,
    "upload_id" TEXT NOT NULL,
    "row_no" INTEGER NOT NULL,
    "tan" VARCHAR(10) NOT NULL,
    "deductor_name" VARCHAR(200) NOT NULL,
    "section" VARCHAR(12),
    "txn_date" DATE NOT NULL,
    "quarter" INTEGER NOT NULL,
    "booking_status" VARCHAR(2),
    "booking_date" DATE,
    "remarks" VARCHAR(100),
    "amount_paid_paise" BIGINT NOT NULL,
    "tds_paise" BIGINT NOT NULL,
    "deposited_paise" BIGINT,

    CONSTRAINT "sales_tds_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_gstr1_uploads" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "gstin" VARCHAR(15) NOT NULL,
    "period" VARCHAR(10) NOT NULL,
    "format" VARCHAR(8) NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "file_sha256" VARCHAR(64) NOT NULL,
    "file_bytes" INTEGER NOT NULL,
    "return_period" VARCHAR(6),
    "sections" JSONB NOT NULL,
    "counts" JSONB NOT NULL,
    "other_sections" JSONB NOT NULL,
    "tax_columns" BOOLEAN NOT NULL DEFAULT true,
    "warnings" JSONB,
    "error_rows" JSONB,
    "current_since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_gstr1_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_gstr1_docs" (
    "id" TEXT NOT NULL,
    "upload_id" TEXT NOT NULL,
    "section" VARCHAR(8) NOT NULL,
    "row_ref" VARCHAR(40) NOT NULL,
    "ctin" VARCHAR(15),
    "receiver_name" VARCHAR(200),
    "number" VARCHAR(40) NOT NULL,
    "number_key" VARCHAR(40) NOT NULL,
    "doc_date" DATE,
    "note_type" VARCHAR(1),
    "orig_number" VARCHAR(40),
    "inv_type" VARCHAR(8),
    "pos" VARCHAR(2),
    "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
    "value_paise" BIGINT NOT NULL,
    "taxable_paise" BIGINT NOT NULL,
    "igst_paise" BIGINT,
    "cgst_paise" BIGINT,
    "sgst_paise" BIGINT,
    "cess_paise" BIGINT,
    "rates_bp" JSONB NOT NULL,

    CONSTRAINT "sales_gstr1_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_balance_confirmations" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "client_id" TEXT NOT NULL,
    "as_of" DATE NOT NULL,
    "from_day" DATE NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "our_balance_paise" BIGINT NOT NULL,
    "ledger" JSONB NOT NULL,
    "ledger_sha256" VARCHAR(64) NOT NULL,
    "their_balance_paise" BIGINT,
    "response_note" VARCHAR(1000),
    "responded_on" DATE,
    "responded_by_id" TEXT,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "queued_at" TIMESTAMP(3),
    "last_sent_at" TIMESTAMP(3),
    "last_sent_to" VARCHAR(1000),
    "last_send_error" VARCHAR(300),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_balance_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_confirmation_files" (
    "id" TEXT NOT NULL,
    "confirmation_id" TEXT NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "content_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_confirmation_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tds_deductors_tan_key" ON "sales_tds_deductors"("tan");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_tds_deductors_client_id_idx" ON "sales_tds_deductors"("client_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_tds_uploads_company_key_financial_year_current_since_idx" ON "sales_tds_uploads"("company_key", "financial_year", "current_since");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tds_uploads_company_key_financial_year_file_sha256_key" ON "sales_tds_uploads"("company_key", "financial_year", "file_sha256");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_tds_entries_upload_id_tan_idx" ON "sales_tds_entries"("upload_id", "tan");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_gstr1_uploads_company_key_gstin_period_current_since_idx" ON "sales_gstr1_uploads"("company_key", "gstin", "period", "current_since");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_gstr1_uploads_company_key_gstin_period_file_sha256_key" ON "sales_gstr1_uploads"("company_key", "gstin", "period", "file_sha256");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_gstr1_docs_upload_id_section_number_key_idx" ON "sales_gstr1_docs"("upload_id", "section", "number_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_gstr1_docs_upload_id_row_ref_key" ON "sales_gstr1_docs"("upload_id", "row_ref");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_balance_confirmations_company_key_as_of_idx" ON "sales_balance_confirmations"("company_key", "as_of");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_balance_confirmations_client_id_idx" ON "sales_balance_confirmations"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_balance_confirmations_company_key_client_id_as_of_key" ON "sales_balance_confirmations"("company_key", "client_id", "as_of");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_confirmation_files_confirmation_id_key" ON "sales_confirmation_files"("confirmation_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "client_billing_profiles_tan_key" ON "client_billing_profiles"("tan");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_tds_deductors_client_id_fkey') THEN
    ALTER TABLE "sales_tds_deductors" ADD CONSTRAINT "sales_tds_deductors_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_tds_entries_upload_id_fkey') THEN
    ALTER TABLE "sales_tds_entries" ADD CONSTRAINT "sales_tds_entries_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "sales_tds_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_gstr1_docs_upload_id_fkey') THEN
    ALTER TABLE "sales_gstr1_docs" ADD CONSTRAINT "sales_gstr1_docs_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "sales_gstr1_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_balance_confirmations_client_id_fkey') THEN
    ALTER TABLE "sales_balance_confirmations" ADD CONSTRAINT "sales_balance_confirmations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_confirmation_files_confirmation_id_fkey') THEN
    ALTER TABLE "sales_confirmation_files" ADD CONSTRAINT "sales_confirmation_files_confirmation_id_fkey" FOREIGN KEY ("confirmation_id") REFERENCES "sales_balance_confirmations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
