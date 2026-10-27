-- ============================================================================
-- scripts/client-users-ddl.sql — feature-only DDL for team logins on the client portal
-- (2026-10-28): more than one person can sign in as the same client company.
-- Models:   ClientUser (new), ClientRefreshToken (+clientUserId)
-- Services: apps/api/src/services/client-auth.service.ts, client-team.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/sales-billing-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE ... IF NOT EXISTS, foreign keys
-- guarded by pg_constraint lookups. Definitions are byte-identical to the generated output.
--
-- Purely additive: one nullable column on client_refresh_tokens, one new table. Safe to re-run.
-- Apply on prod with scripts/apply-client-users-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "client_refresh_tokens" ADD COLUMN IF NOT EXISTS "client_user_id" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "client_users" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "password_hash" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'invited',
    "session_version" INTEGER NOT NULL DEFAULT 0,
    "token_hash" VARCHAR(64),
    "token_purpose" VARCHAR(16),
    "token_expires_at" TIMESTAMP(3),
    "invited_by" VARCHAR(200),
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "client_users_email_key" ON "client_users"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "client_users_token_hash_key" ON "client_users"("token_hash");
CREATE INDEX IF NOT EXISTS "client_users_client_id_idx" ON "client_users"("client_id");
CREATE INDEX IF NOT EXISTS "client_refresh_tokens_client_user_id_idx" ON "client_refresh_tokens"("client_user_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_refresh_tokens_client_user_id_fkey') THEN
    ALTER TABLE "client_refresh_tokens" ADD CONSTRAINT "client_refresh_tokens_client_user_id_fkey" FOREIGN KEY ("client_user_id") REFERENCES "client_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_users_client_id_fkey') THEN
    ALTER TABLE "client_users" ADD CONSTRAINT "client_users_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
