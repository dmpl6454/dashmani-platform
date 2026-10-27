-- ============================================================================
-- scripts/campaign-youtube-ddl.sql — feature-only DDL for campaign YouTube auto-upload (Phase 3,
-- 2026-10-28): one new table, youtube_connections (a staff-connected YouTube channel and its
-- encrypted Google refresh token). Model: YoutubeConnection. Service:
-- apps/api/src/services/campaign/youtube.service.ts.
-- Same shape as scripts/sales-einvoice-ddl.sql: one transaction, lock_timeout 3s, IF NOT EXISTS.
-- Purely additive, no FK into any existing table. Apply on prod with
-- scripts/apply-campaign-youtube-ddl.sh BEFORE merging.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE IF NOT EXISTS "youtube_connections" (
    "id" TEXT NOT NULL,
    "channel_id" VARCHAR(64) NOT NULL,
    "channel_title" VARCHAR(200) NOT NULL,
    "google_email" VARCHAR(320),
    "refresh_token_enc" TEXT NOT NULL,
    "granted_scopes" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "last_error" TEXT,
    "connected_by_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "youtube_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "youtube_connections_channel_id_key" ON "youtube_connections"("channel_id");

COMMIT;
