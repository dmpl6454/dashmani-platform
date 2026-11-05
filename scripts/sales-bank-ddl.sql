-- ============================================================================
-- scripts/sales-bank-ddl.sql — feature-only DDL for bank statement upload, matching and TDS
-- (smart invoicing PR 4, 2026-11).
-- Models:   SalesBankAccount, SalesBankStatement, SalesBankLine (new);
--           SalesPayment (+bankLineId, +tdsRateBp, +tdsSection, +@@index([companyKey, paidOn]))
-- Services: apps/api/src/services/sales/bank.service.ts, bank-parse.ts, bank-match.ts, payments.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-wrapped like scripts/sales-recurring-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE ... IF NOT EXISTS, foreign keys
-- guarded by pg_constraint lookups. Definitions are byte-identical to the generated output.
--
-- Purely additive: three nullable columns and two indexes on sales_payments, three new tables.
-- Safe to re-run. Apply on prod with scripts/apply-sales-bank-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "sales_payments" ADD COLUMN IF NOT EXISTS "bank_line_id" TEXT;
ALTER TABLE "sales_payments" ADD COLUMN IF NOT EXISTS "tds_rate_bp" INTEGER;
ALTER TABLE "sales_payments" ADD COLUMN IF NOT EXISTS "tds_section" VARCHAR(8);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_bank_accounts" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "bank" VARCHAR(16) NOT NULL,
    "account_number" VARCHAR(30) NOT NULL,
    "ifsc" VARCHAR(11),
    "match_from" DATE,
    "status" VARCHAR(8) NOT NULL DEFAULT 'active',
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_bank_statements" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "bank_account_id" TEXT NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "file_sha256" VARCHAR(64) NOT NULL,
    "file_bytes" INTEGER NOT NULL,
    "format" VARCHAR(8) NOT NULL,
    "preset" VARCHAR(16),
    "mapping" JSONB NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "opening_balance_paise" BIGINT,
    "closing_balance_paise" BIGINT,
    "row_count" INTEGER NOT NULL,
    "new_line_count" INTEGER NOT NULL,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "credit_total_paise" BIGINT NOT NULL DEFAULT 0,
    "debit_total_paise" BIGINT NOT NULL DEFAULT 0,
    "warnings" JSONB,
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_bank_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_bank_lines" (
    "id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "bank_account_id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "row_no" INTEGER NOT NULL,
    "txn_date" DATE NOT NULL,
    "value_date" DATE,
    "narration" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(120),
    "utr" VARCHAR(40),
    "credit_paise" BIGINT NOT NULL DEFAULT 0,
    "debit_paise" BIGINT NOT NULL DEFAULT 0,
    "balance_paise" BIGINT,
    "dedupe_hash" VARCHAR(64) NOT NULL,
    "possible_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(16) NOT NULL DEFAULT 'unmatched',
    "matched_paise" BIGINT NOT NULL DEFAULT 0,
    "suggestion" JSONB,
    "best_score" INTEGER,
    "confidence" VARCHAR(8),
    "suggested_at" TIMESTAMP(3),
    "ignore_reason" VARCHAR(24),
    "ignore_note" VARCHAR(300),
    "ignored_at" TIMESTAMP(3),
    "ignored_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_bank_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sales_bank_accounts_account_number_key" ON "sales_bank_accounts"("account_number");
CREATE INDEX IF NOT EXISTS "sales_bank_accounts_company_key_idx" ON "sales_bank_accounts"("company_key");
CREATE INDEX IF NOT EXISTS "sales_bank_statements_company_key_period_to_idx" ON "sales_bank_statements"("company_key", "period_to");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_bank_statements_bank_account_id_file_sha256_key" ON "sales_bank_statements"("bank_account_id", "file_sha256");
CREATE INDEX IF NOT EXISTS "sales_bank_lines_company_key_status_txn_date_idx" ON "sales_bank_lines"("company_key", "status", "txn_date");
CREATE INDEX IF NOT EXISTS "sales_bank_lines_bank_account_id_txn_date_idx" ON "sales_bank_lines"("bank_account_id", "txn_date");
CREATE INDEX IF NOT EXISTS "sales_bank_lines_statement_id_row_no_idx" ON "sales_bank_lines"("statement_id", "row_no");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_bank_lines_bank_account_id_dedupe_hash_key" ON "sales_bank_lines"("bank_account_id", "dedupe_hash");
CREATE INDEX IF NOT EXISTS "sales_payments_bank_line_id_idx" ON "sales_payments"("bank_line_id");
CREATE INDEX IF NOT EXISTS "sales_payments_company_key_paid_on_idx" ON "sales_payments"("company_key", "paid_on");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_payments_bank_line_id_fkey') THEN
    ALTER TABLE "sales_payments" ADD CONSTRAINT "sales_payments_bank_line_id_fkey" FOREIGN KEY ("bank_line_id") REFERENCES "sales_bank_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_bank_statements_bank_account_id_fkey') THEN
    ALTER TABLE "sales_bank_statements" ADD CONSTRAINT "sales_bank_statements_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "sales_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_bank_lines_statement_id_fkey') THEN
    ALTER TABLE "sales_bank_lines" ADD CONSTRAINT "sales_bank_lines_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "sales_bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_bank_lines_bank_account_id_fkey') THEN
    ALTER TABLE "sales_bank_lines" ADD CONSTRAINT "sales_bank_lines_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "sales_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
