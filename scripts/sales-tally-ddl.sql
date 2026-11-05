-- ============================================================================
-- scripts/sales-tally-ddl.sql — feature-only DDL for the Tally export / push (2026-11-05).
-- Models:   SalesTallyRun, SalesTallyItem, SalesTallyParty (new); Client (+relation only, no SQL)
-- Services: apps/api/src/services/sales/tally/*.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-recurring-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE ... IF NOT EXISTS, foreign keys guarded by
-- pg_constraint lookups. Definitions are byte-identical to the generated output.
--
-- Purely additive: 3 new tables, no existing table altered. Safe to re-run.
-- Apply on prod with scripts/apply-sales-tally-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_tally_runs" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "run_no" INTEGER NOT NULL,
    "tally_company" VARCHAR(120) NOT NULL,
    "scope_gstin" VARCHAR(15),
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "mode" VARCHAR(12) NOT NULL,
    "channel" VARCHAR(8) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "tally_release" VARCHAR(8) NOT NULL,
    "preview_hash" VARCHAR(64) NOT NULL,
    "voucher_count" INTEGER NOT NULL,
    "master_count" INTEGER NOT NULL,
    "blocked_count" INTEGER NOT NULL DEFAULT 0,
    "control_total_paise" BIGINT NOT NULL,
    "summary" JSONB NOT NULL,
    "ledger_map" JSONB NOT NULL,
    "acknowledged" JSONB NOT NULL DEFAULT '[]',
    "masters_xml_gz" BYTEA,
    "vouchers_xml_gz" BYTEA,
    "masters_sha256" VARCHAR(64),
    "vouchers_sha256" VARCHAR(64),
    "push_target" VARCHAR(200),
    "push_result" JSONB,
    "tally_reported" JSONB,
    "status_note" VARCHAR(500),
    "created_by_id" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3),
    "closed_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_tally_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_tally_items" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "doc_type" VARCHAR(16) NOT NULL,
    "doc_id" TEXT NOT NULL,
    "doc_number" VARCHAR(32) NOT NULL,
    "doc_date" DATE NOT NULL,
    "voucher_type" VARCHAR(100) NOT NULL,
    "remote_id" VARCHAR(64) NOT NULL,
    "action" VARCHAR(8) NOT NULL,
    "content_hash" VARCHAR(64),
    "party_amount_paise" BIGINT NOT NULL DEFAULT 0,
    "outcome" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "issue_code" VARCHAR(40),
    "error" TEXT,
    "tally_vch_id" VARCHAR(32),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_tally_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "sales_tally_parties" (
    "id" TEXT NOT NULL,
    "company_key" VARCHAR(8) NOT NULL,
    "client_id" TEXT NOT NULL,
    "ledger_name" VARCHAR(100) NOT NULL,
    "ledger_key" VARCHAR(100) NOT NULL,
    "gstin" VARCHAR(15),
    "exists_in_tally" BOOLEAN NOT NULL DEFAULT false,
    "locked_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_tally_parties_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "sales_tally_runs_company_key_status_idx" ON "sales_tally_runs"("company_key", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tally_runs_company_key_run_no_key" ON "sales_tally_runs"("company_key", "run_no");
CREATE INDEX IF NOT EXISTS "sales_tally_items_doc_id_created_at_idx" ON "sales_tally_items"("doc_id", "created_at");
CREATE INDEX IF NOT EXISTS "sales_tally_items_company_key_outcome_idx" ON "sales_tally_items"("company_key", "outcome");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tally_items_run_id_doc_id_key" ON "sales_tally_items"("run_id", "doc_id");
CREATE INDEX IF NOT EXISTS "sales_tally_parties_company_key_ledger_key_idx" ON "sales_tally_parties"("company_key", "ledger_key");
CREATE INDEX IF NOT EXISTS "sales_tally_parties_client_id_idx" ON "sales_tally_parties"("client_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tally_parties_company_key_client_id_key" ON "sales_tally_parties"("company_key", "client_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_tally_items_run_id_fkey') THEN
    ALTER TABLE "sales_tally_items" ADD CONSTRAINT "sales_tally_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sales_tally_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_tally_parties_client_id_fkey') THEN
    ALTER TABLE "sales_tally_parties" ADD CONSTRAINT "sales_tally_parties_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
