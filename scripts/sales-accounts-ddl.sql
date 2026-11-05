-- ============================================================================
-- scripts/sales-accounts-ddl.sql — feature-only DDL for filed accounts on the
-- sales portal's /accounts page (2026-11-05).
-- Models:   FinanceFiledYear (new), FinanceFiledFile (new)
-- Services: apps/api/src/services/sales/filed.service.ts, accounts.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-recurring-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE ... IF NOT EXISTS, the foreign key guarded
-- by a pg_constraint lookup. Definitions are byte-identical to the generated output.
--
-- Purely additive: 2 new tables, no change to any existing table. Safe to re-run.
-- Apply on prod with scripts/apply-sales-accounts-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "finance_filed_years" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "financial_year" VARCHAR(7) NOT NULL,
    "revenue_paise" BIGINT,
    "other_income_paise" BIGINT,
    "total_expenses_paise" BIGINT,
    "profit_before_tax_paise" BIGINT,
    "tax_expense_paise" BIGINT,
    "profit_after_tax_paise" BIGINT,
    "total_assets_paise" BIGINT,
    "total_liabilities_paise" BIGINT,
    "equity_paise" BIGINT,
    "cash_and_bank_paise" BIGINT,
    "trade_receivables_paise" BIGINT,
    "trade_payables_paise" BIGINT,
    "entered_in" VARCHAR(10) NOT NULL DEFAULT 'rupees',
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_filed_years_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "finance_filed_files" (
    "id" TEXT NOT NULL,
    "filed_year_id" TEXT NOT NULL,
    "kind" VARCHAR(16) NOT NULL DEFAULT 'accounts',
    "file_name" VARCHAR(200) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_filed_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "finance_filed_years_company_key_financial_year_key" ON "finance_filed_years"("company_key", "financial_year");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "finance_filed_files_filed_year_id_sha256_key" ON "finance_filed_files"("filed_year_id", "sha256");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_filed_files_filed_year_id_fkey') THEN
    ALTER TABLE "finance_filed_files" ADD CONSTRAINT "finance_filed_files_filed_year_id_fkey" FOREIGN KEY ("filed_year_id") REFERENCES "finance_filed_years"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
