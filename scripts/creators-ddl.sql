-- ============================================================================
-- scripts/creators-ddl.sql — feature-only DDL for the creator portal (Phase A):
-- creators.digitalsukoon.com sign-up, the creator's own Facebook Login grant and the
-- Pages / Instagram accounts it reaches, plus the Meta deauthorize / data-deletion log.
-- Models:   Creator, CreatorRefreshToken, CreatorToken, CreatorOauthState, CreatorConnection,
--           CreatorAsset, MetaDeletionRequest (all new)
-- Services: apps/api/src/services/creator/*, services/meta-platform-callbacks.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like scripts/campaign-overrides-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE ... IF NOT EXISTS, foreign keys guarded
-- by pg_constraint lookups. Definitions are byte-identical to the generated output, so
-- `prisma migrate diff --from-url <db> ... --exit-code` shows no drift.
--
-- Purely additive: seven NEW tables, no ALTER of any existing table, no enum change, no
-- foreign key into users / clients / meta_* (creator pages are deliberately kept out of
-- meta_assets — see the schema comment). The running API never reads these tables before the
-- deploy that ships the code, so applying this first is invisible to it.
--
-- Safe to run twice: the second run changes nothing and raises no error.
-- Apply ONLY through psql, as the app role (never sudo -u postgres) — or with the helper:
--   bash scripts/apply-creators-ddl.sh
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "creators" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "country" CHAR(2),
    "phone" VARCHAR(32),
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "email_verified_at" TIMESTAMP(3),
    "terms_version" VARCHAR(16),
    "terms_accepted_at" TIMESTAMP(3),
    "adult_confirmed_at" TIMESTAMP(3),
    "payout_currency" CHAR(3),
    "payout_method" VARCHAR(16),
    "payout_details_enc" TEXT,
    "payout_details_hint" VARCHAR(80),
    "submitted_at" TIMESTAMP(3),
    "review_note" TEXT,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_refresh_tokens" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_tokens" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "purpose" VARCHAR(16) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_oauth_states" (
    "state" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "mode" VARCHAR(16) NOT NULL DEFAULT 'connect',
    "used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creator_oauth_states_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_connections" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "meta_user_id" TEXT NOT NULL,
    "meta_user_name" TEXT,
    "user_token_enc" TEXT,
    "granted_scopes" TEXT NOT NULL DEFAULT '',
    "granular_scopes" JSONB,
    "token_expires_at" TIMESTAMP(3),
    "data_access_expires_at" TIMESTAMP(3),
    "graph_version" VARCHAR(16) NOT NULL DEFAULT 'v21.0',
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "discovery_state" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "last_verified_at" TIMESTAMP(3),
    "last_error" VARCHAR(500),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "creator_assets" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "meta_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "parent_page_id" TEXT,
    "page_token_enc" TEXT,
    "tasks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "can_publish" BOOLEAN NOT NULL DEFAULT false,
    "publish_probe_error" VARCHAR(300),
    "follower_count" INTEGER,
    "media_count" INTEGER,
    "picture_url" TEXT,
    "views_28d" BIGINT,
    "engagements_28d" BIGINT,
    "reach_28d" BIGINT,
    "metrics_fetched_at" TIMESTAMP(3),
    "metrics_error" VARCHAR(300),
    "network_duplicate_of" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled_by_id" TEXT,
    "enabled_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "meta_deletion_requests" (
    "id" TEXT NOT NULL,
    "confirmation_code" VARCHAR(16) NOT NULL,
    "user_hash" CHAR(64) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "matched" VARCHAR(24) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "note" VARCHAR(500),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "meta_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creators_email_key" ON "creators"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creators_status_idx" ON "creators"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creators_created_at_idx" ON "creators"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_refresh_tokens_token_hash_key" ON "creator_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_refresh_tokens_creator_id_idx" ON "creator_refresh_tokens"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_tokens_token_hash_key" ON "creator_tokens"("token_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_tokens_creator_id_purpose_idx" ON "creator_tokens"("creator_id", "purpose");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_oauth_states_expires_at_idx" ON "creator_oauth_states"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_connections_meta_user_id_key" ON "creator_connections"("meta_user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_connections_creator_id_idx" ON "creator_connections"("creator_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_connections_status_idx" ON "creator_connections"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_assets_creator_id_idx" ON "creator_assets"("creator_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "creator_assets_connection_id_idx" ON "creator_assets"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "creator_assets_kind_meta_id_key" ON "creator_assets"("kind", "meta_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meta_deletion_requests_confirmation_code_key" ON "meta_deletion_requests"("confirmation_code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "meta_deletion_requests_user_hash_idx" ON "meta_deletion_requests"("user_hash");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_refresh_tokens_creator_id_fkey' AND conrelid = '"public"."creator_refresh_tokens"'::regclass) THEN
    ALTER TABLE "creator_refresh_tokens" ADD CONSTRAINT "creator_refresh_tokens_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_tokens_creator_id_fkey' AND conrelid = '"public"."creator_tokens"'::regclass) THEN
    ALTER TABLE "creator_tokens" ADD CONSTRAINT "creator_tokens_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_oauth_states_creator_id_fkey' AND conrelid = '"public"."creator_oauth_states"'::regclass) THEN
    ALTER TABLE "creator_oauth_states" ADD CONSTRAINT "creator_oauth_states_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_connections_creator_id_fkey' AND conrelid = '"public"."creator_connections"'::regclass) THEN
    ALTER TABLE "creator_connections" ADD CONSTRAINT "creator_connections_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_assets_creator_id_fkey' AND conrelid = '"public"."creator_assets"'::regclass) THEN
    ALTER TABLE "creator_assets" ADD CONSTRAINT "creator_assets_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'creator_assets_connection_id_fkey' AND conrelid = '"public"."creator_assets"'::regclass) THEN
    ALTER TABLE "creator_assets" ADD CONSTRAINT "creator_assets_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "creator_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
