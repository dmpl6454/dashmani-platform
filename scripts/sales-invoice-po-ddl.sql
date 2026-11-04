-- ============================================================================
-- scripts/sales-invoice-po-ddl.sql — feature-only DDL for the client's purchase order on an
-- invoice (2026-11-04).
-- Model:    SalesInvoice (+poNumber, +poDate)
-- Service:  apps/api/src/services/sales/invoices.service.ts (printed by pdf.service.ts)
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-recurring-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN IF NOT EXISTS. Definitions are
-- byte-identical to the generated output.
--
-- Purely additive: two nullable columns on sales_invoices. Safe to re-run.
-- Apply on prod with scripts/apply-sales-invoice-po-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "po_date" DATE;
ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "po_number" VARCHAR(60);

COMMIT;
