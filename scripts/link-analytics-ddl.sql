-- ============================================================================
-- scripts/link-analytics-ddl.sql — feature-only DDL for Link Analytics (sales portal /links,
-- branch feat/link-analytics, 2026-11-25). Spec: docs/link-analytics/SPEC.md
-- Models: LinkBatch, LinkBatchItem, LinkPost, LinkPostSnapshot (four NEW tables).
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then made re-runnable like scripts/sales-import-ddl.sql: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, CREATE ... IF NOT EXISTS, foreign keys guarded by
-- pg_constraint lookups. Definitions are byte-identical to the generated output.
--
-- Additive: touches NO existing table (no FK into users / meta_assets), so it cannot block
-- sign-in or any sync. Safe to re-run.
-- Apply on prod with scripts/apply-link-analytics-ddl.sh BEFORE merging the PR.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "link_batches" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "notes" TEXT,
    "keep_duplicates" BOOLEAN NOT NULL DEFAULT false,
    "state" VARCHAR(16) NOT NULL DEFAULT 'idle',
    "run_started_at" TIMESTAMP(3),
    "run_finished_at" TIMESTAMP(3),
    "refresh_every_hours" INTEGER,
    "schedule_ends_at" TIMESTAMP(3),
    "next_refresh_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "link_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "link_batch_items" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "raw_url" TEXT NOT NULL,
    "normalized_url" TEXT,
    "platform" VARCHAR(16),
    "post_type" VARCHAR(16),
    "post_key" VARCHAR(512),
    "validity" VARCHAR(16) NOT NULL,
    "invalid_reason" VARCHAR(200),
    "duplicate_of_id" TEXT,
    "username_hint" VARCHAR(64),
    "post_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "link_posts" (
    "id" TEXT NOT NULL,
    "post_key" VARCHAR(512) NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "post_type" VARCHAR(16) NOT NULL,
    "canonical_url" TEXT NOT NULL,
    "external_id" VARCHAR(128),
    "meta_asset_id" TEXT,
    "account_name" VARCHAR(255),
    "username" VARCHAR(64),
    "followers" INTEGER,
    "followers_at" TIMESTAMP(3),
    "caption" TEXT,
    "published_at" TIMESTAMP(3),
    "thumbnail_url" TEXT,
    "views" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "access" VARCHAR(8),
    "status_reason" VARCHAR(48),
    "error_message" TEXT,
    "data_source" VARCHAR(32),
    "metrics_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),
    "check_count" INTEGER NOT NULL DEFAULT 0,
    "fetch_state" VARCHAR(8) NOT NULL DEFAULT 'queued',
    "queued_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "link_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "link_post_snapshots" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(16) NOT NULL,
    "data_source" VARCHAR(32),
    "metrics_at" TIMESTAMP(3),
    "views" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "followers" INTEGER,

    CONSTRAINT "link_post_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "link_batches_archived_at_created_at_idx" ON "link_batches"("archived_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "link_batches_next_refresh_at_idx" ON "link_batches"("next_refresh_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "link_batch_items_batch_id_position_idx" ON "link_batch_items"("batch_id", "position");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "link_batch_items_post_id_idx" ON "link_batch_items"("post_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "link_posts_post_key_key" ON "link_posts"("post_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "link_posts_fetch_state_next_attempt_at_idx" ON "link_posts"("fetch_state", "next_attempt_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "link_post_snapshots_post_id_checked_at_idx" ON "link_post_snapshots"("post_id", "checked_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "link_post_snapshots_checked_at_idx" ON "link_post_snapshots"("checked_at");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'link_batch_items_batch_id_fkey') THEN
    ALTER TABLE "link_batch_items" ADD CONSTRAINT "link_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "link_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'link_batch_items_post_id_fkey') THEN
    ALTER TABLE "link_batch_items" ADD CONSTRAINT "link_batch_items_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "link_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'link_post_snapshots_post_id_fkey') THEN
    ALTER TABLE "link_post_snapshots" ADD CONSTRAINT "link_post_snapshots_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "link_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
