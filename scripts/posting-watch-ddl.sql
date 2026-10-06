-- ============================================================================
-- scripts/posting-watch-ddl.sql — feature-only DDL for the posting watch
-- (dashboard: assigned channels whose connected FB/IG Page has no new post for 2h+,
-- 07:00–23:00 IST).
-- Model:   MetaPostWatch in packages/db/prisma/schema.prisma
-- Service: apps/api/src/services/meta-oauth/posting-watch.service.ts
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited exactly like scripts/pipeline-email-ddl.sql:
--   * one transaction, lock_timeout 3s, statement_timeout 60s, search_path pinned to public;
--   * CREATE ... IF NOT EXISTS.
-- The table and index definitions are byte-identical to the generated output, so after
-- this runs `prisma migrate diff --from-url <db> --to-schema-datamodel ... --exit-code`
-- shows no drift for this table.
--
-- Touches ONLY the new meta_post_watch table. No existing table gets DDL, there is NO
-- foreign key (so no lock on meta_assets, users or anything else), and the running API
-- ignores a table its Prisma client does not know, so applying it before the deploy
-- changes nothing the running code can see. Deploying WITHOUT it is also safe: the
-- feature's self-check reports "paused" (never a 500) and re-checks every 10 minutes.
--
-- ⚠️ Apply it as the LAST step before the merge, not while the PR waits. Until the code
-- that writes it is deployed the table is EMPTY, and `prisma db push` drops an empty table
-- WITHOUT a data-loss prompt — any `db push` from a schema without MetaPostWatch in the
-- meantime would silently remove it. If the model ever changes after an early apply, ship
-- an ALTER: re-running this IF NOT EXISTS script would leave the old shape in place.
--
-- Safe to run twice: the second run changes nothing and raises no error (CREATE INDEX IF
-- NOT EXISTS still takes a brief SHARE lock on this new, small table).
--
-- Apply ONLY through psql, as the app role (never sudo -u postgres — a postgres-owned
-- table breaks later Prisma DDL):  psql "$DBURL" -v ON_ERROR_STOP=1 -f scripts/posting-watch-ddl.sql
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
-- Every name below is unqualified and psql's default search_path is "$user", public: a
-- schema named after the app role would otherwise receive the table. Prisma uses public.
SET LOCAL search_path = public;

-- CreateTable
CREATE TABLE IF NOT EXISTS "meta_post_watch" (
    "id" TEXT NOT NULL,
    "kind" "MetaAssetKind" NOT NULL,
    "meta_id" TEXT NOT NULL,
    "last_post_at" TIMESTAMP(3),
    "last_post_id" TEXT,
    "last_post_url" TEXT,
    "checked_at" TIMESTAMP(3),
    "attempted_at" TIMESTAMP(3),
    "error_kind" VARCHAR(16),
    "error" TEXT,
    "error_since" TIMESTAMP(3),
    "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_post_watch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "meta_post_watch_kind_meta_id_key" ON "meta_post_watch"("kind", "meta_id");

COMMIT;
