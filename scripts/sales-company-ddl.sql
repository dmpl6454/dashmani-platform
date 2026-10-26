-- ============================================================================
-- scripts/sales-company-ddl.sql — feature-only DDL for the second billing company (2026-10-27):
-- a company_key column on sales_quotes, sales_orders, sales_invoices and sales_payments
-- ('dspl' = Digital Sukoon Private Limited, 'dmpl' = Dashmani Media Private Limited). Every
-- existing row belongs to Digital Sukoon, which is exactly what the default gives it.
-- Generated with `prisma migrate diff` and hand-edited like scripts/sales-ddl.sql: one
-- transaction, lock_timeout 3s, IF NOT EXISTS. Purely additive. ADD COLUMN with a constant
-- default is metadata-only on Postgres 11+ (no table rewrite). Apply on prod with
-- scripts/apply-sales-company-ddl.sh BEFORE merging.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE "sales_quotes"   ADD COLUMN IF NOT EXISTS "company_key" VARCHAR(8) NOT NULL DEFAULT 'dspl';
ALTER TABLE "sales_orders"   ADD COLUMN IF NOT EXISTS "company_key" VARCHAR(8) NOT NULL DEFAULT 'dspl';
ALTER TABLE "sales_invoices" ADD COLUMN IF NOT EXISTS "company_key" VARCHAR(8) NOT NULL DEFAULT 'dspl';
ALTER TABLE "sales_payments" ADD COLUMN IF NOT EXISTS "company_key" VARCHAR(8) NOT NULL DEFAULT 'dspl';

CREATE INDEX IF NOT EXISTS "sales_quotes_company_key_idx"   ON "sales_quotes"("company_key");
CREATE INDEX IF NOT EXISTS "sales_orders_company_key_idx"   ON "sales_orders"("company_key");
CREATE INDEX IF NOT EXISTS "sales_invoices_company_key_idx" ON "sales_invoices"("company_key");
CREATE INDEX IF NOT EXISTS "sales_payments_company_key_idx" ON "sales_payments"("company_key");

COMMIT;
