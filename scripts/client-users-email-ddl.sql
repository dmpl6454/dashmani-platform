-- ============================================================================
-- scripts/client-users-email-ddl.sql — per-login email choices for client-portal team logins
-- (2026-10-31): client_users.email_campaigns / email_invoices (both default true).
-- Generated with prisma migrate diff, hand-edited like scripts/client-users-ddl.sql: one
-- transaction, lock_timeout 3s, ADD COLUMN IF NOT EXISTS. NOT NULL with a constant default is
-- metadata-only on Postgres 11+ (no table rewrite). Safe to re-run.
-- Apply on prod with scripts/apply-client-users-email-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

ALTER TABLE "client_users" ADD COLUMN IF NOT EXISTS "email_campaigns" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "client_users" ADD COLUMN IF NOT EXISTS "email_invoices" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
