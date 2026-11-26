-- ============================================================================
-- scripts/budget-quick-client-ddl.sql — feature-only DDL (2026-11-26, owner ask):
--   1. a Pipeline project's budget            → pipeline_projects.budget_inr (INTEGER, nullable)
--   2. a client added with name + phone only  → clients.email becomes OPTIONAL (DROP NOT NULL)
-- Models:   PipelineProject (+budgetInr), Client (email String → String?)
-- Services: pipeline/projects.service.ts, board.ts, sync.service.ts (budget);
--           sales/clients.service.ts createSalesQuickClient / setFirstSalesClientEmail (email)
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like the other feature DDL scripts: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, idempotent statements.
--
-- Both statements are catalog-only: ADD COLUMN with no default rewrites nothing, and DROP NOT
-- NULL only relaxes a constraint (no scan, no rewrite). Each takes a brief ACCESS EXCLUSIVE lock;
-- lock_timeout 3s means a busy table makes the whole transaction roll back instead of queueing
-- logins behind it. The unique index on clients.email stays: Postgres never treats two NULLs as
-- equal, so any number of clients may have no email while a real address stays unique.
-- No existing row changes. No data is invented: a client without an email stores NULL.
--
-- ⚠️ The board snapshot reads p.budget_inr, so this must be on the database BEFORE the code
-- that reads it is deployed. Apply on prod with scripts/apply-budget-quick-client-ddl.sh BEFORE
-- merging the PR (Pipeline DDL cycle: docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md).
-- Safe to re-run.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "pipeline_projects" ADD COLUMN IF NOT EXISTS "budget_inr" INTEGER;

-- AlterTable (a no-op when already nullable)
ALTER TABLE "clients" ALTER COLUMN "email" DROP NOT NULL;

COMMIT;
