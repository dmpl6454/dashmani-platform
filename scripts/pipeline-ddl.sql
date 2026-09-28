-- ============================================================================
-- scripts/pipeline-ddl.sql — feature-only DDL for the Pipeline (HR portal v1).
-- Spec: docs/superpowers/specs/2026-09-26-pipeline-design.md §2 and §12.
-- Runbook: docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited per §12 step 2:
--   * one transaction, lock_timeout 3s, statement_timeout 60s, search_path pinned to public;
--   * ADD VALUE IF NOT EXISTS, CREATE ... IF NOT EXISTS, every FK behind a guard scoped to
--     its own table (conname AND conrelid);
--   * the board row and the 7 phases seeded ON CONFLICT DO NOTHING.
-- The column and index definitions are byte-identical to the generated output, so
-- after this runs, `prisma migrate diff --from-url <db> --to-schema-datamodel ...`
-- shows no pipeline drift.
--
-- Safe to run twice: the second run changes nothing and raises no error.
-- ⚠️ But a re-run is NOT lock-free: CREATE INDEX IF NOT EXISTS takes a SHARE lock on its
-- table BEFORE it finds the index already exists, and holds it until COMMIT. On a live
-- pipeline that blocks every write to pipeline_phases/projects/participants/messages for
-- the rest of the transaction. Re-run only as the runbook's §7 says (pipeline.mode=off).
-- Touches ONLY pipeline_* tables plus one enum value. No existing table gets DDL.
--
-- LOCKS. The four FKs that reference "users" take a brief SHARE ROW EXCLUSIVE lock on
-- "users": it blocks writes to users (not reads such as login) until COMMIT. They are
-- placed LAST, right before COMMIT, so that lock is held for milliseconds. If it is not
-- granted within 3s the whole script aborts and rolls back; retry later.
--
-- Apply ONLY through psql:  psql -v ON_ERROR_STOP=1 -f scripts/pipeline-ddl.sql
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
-- Every name below is unqualified and psql's default search_path is "$user", public: a
-- schema named after the app role would otherwise receive the tables. Prisma uses public.
SET LOCAL search_path = public;

-- AlterEnum. Allowed inside a transaction on PG >= 12; unusable until COMMIT, and
-- nothing below uses it. ⚠️ PERMANENT: an enum value cannot be removed.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PIPELINE';

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_phases" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "position" INTEGER NOT NULL,
    "color" VARCHAR(16) NOT NULL DEFAULT 'indigo',
    "is_terminal" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_board_state" (
    "id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_board_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_projects" (
    "id" TEXT NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "owner_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "phase_id" TEXT NOT NULL,
    "rank" VARCHAR(64) NOT NULL,
    "start_date" DATE,
    "due_date" DATE,
    "header_rev" INTEGER NOT NULL DEFAULT 1,
    "thread_rev" INTEGER NOT NULL DEFAULT 0,
    "last_message_seq" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "member_count" INTEGER NOT NULL DEFAULT 1,
    "phase_changed_at" TIMESTAMP(3),
    "phase_changed_by_id" TEXT,
    "move_gen" INTEGER NOT NULL DEFAULT 0,
    "move_actor_id" TEXT,
    "move_started_at" TIMESTAMP(3),
    "move_last_at" TIMESTAMP(3),
    "move_from_phase_id" TEXT,
    "due_soon_notified_for" DATE,
    "overdue_notified_for" DATE,
    "archived_at" TIMESTAMP(3),
    "archived_by_id" TEXT,
    "archived_by_admin" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "deleted_by_id" TEXT,
    "deleted_by_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_participants" (
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" VARCHAR(12) NOT NULL,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "last_read_seq" INTEGER NOT NULL DEFAULT 0,
    "seen_at" TIMESTAMP(3),
    "engaged_at" TIMESTAMP(3),
    "member_added_by_id" TEXT,
    "member_added_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_participants_pkey" PRIMARY KEY ("project_id","user_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_messages" (
    "id" TEXT NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "project_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "rev" INTEGER NOT NULL,
    "parent_id" TEXT,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mention_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reactions" JSONB NOT NULL DEFAULT '{}',
    "reply_count" INTEGER NOT NULL DEFAULT 0,
    "last_reply_at" TIMESTAMP(3),
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_phases_key_key" ON "pipeline_phases"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_phases_position_id_idx" ON "pipeline_phases"("position", "id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_projects_phase_id_idx" ON "pipeline_projects"("phase_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_projects_owner_id_idx" ON "pipeline_projects"("owner_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_projects_due_date_idx" ON "pipeline_projects"("due_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_projects_archived_at_id_idx" ON "pipeline_projects"("archived_at", "id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_projects_deleted_at_idx" ON "pipeline_projects"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_projects_created_by_id_client_id_key" ON "pipeline_projects"("created_by_id", "client_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_participants_user_id_idx" ON "pipeline_participants"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_messages_project_id_parent_id_seq_idx" ON "pipeline_messages"("project_id", "parent_id", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_messages_parent_id_idx" ON "pipeline_messages"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_messages_author_id_client_id_key" ON "pipeline_messages"("author_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_messages_project_id_seq_key" ON "pipeline_messages"("project_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_messages_project_id_rev_key" ON "pipeline_messages"("project_id", "rev");

-- AddForeignKey (pipeline -> pipeline; no lock on any existing table)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_projects_phase_id_fkey' AND conrelid = '"public"."pipeline_projects"'::regclass) THEN
    ALTER TABLE "pipeline_projects" ADD CONSTRAINT "pipeline_projects_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "pipeline_phases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_participants_project_id_fkey' AND conrelid = '"public"."pipeline_participants"'::regclass) THEN
    ALTER TABLE "pipeline_participants" ADD CONSTRAINT "pipeline_participants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_messages_project_id_fkey' AND conrelid = '"public"."pipeline_messages"'::regclass) THEN
    ALTER TABLE "pipeline_messages" ADD CONSTRAINT "pipeline_messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_messages_parent_id_fkey' AND conrelid = '"public"."pipeline_messages"'::regclass) THEN
    ALTER TABLE "pipeline_messages" ADD CONSTRAINT "pipeline_messages_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "pipeline_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Seeds (spec §2 "Seeds"). ids have no DB default (Prisma generates them client-side),
-- so they are supplied here; updated_at has no DB default either (@updatedAt).
INSERT INTO "pipeline_board_state" ("id", "seq", "updated_at")
VALUES (1, 0, timezone('utc', now()))
ON CONFLICT DO NOTHING;

INSERT INTO "pipeline_phases" ("id", "key", "name", "position", "is_terminal", "created_at", "updated_at")
VALUES
  (gen_random_uuid()::text, 'brief',         'Brief',         1, false, timezone('utc', now()), timezone('utc', now())),
  (gen_random_uuid()::text, 'planning',      'Planning',      2, false, timezone('utc', now()), timezone('utc', now())),
  (gen_random_uuid()::text, 'in_production', 'In Production', 3, false, timezone('utc', now()), timezone('utc', now())),
  (gen_random_uuid()::text, 'review',        'Review',        4, false, timezone('utc', now()), timezone('utc', now())),
  (gen_random_uuid()::text, 'approved',      'Approved',      5, false, timezone('utc', now()), timezone('utc', now())),
  (gen_random_uuid()::text, 'live',          'Live',          6, false, timezone('utc', now()), timezone('utc', now())),
  (gen_random_uuid()::text, 'done',          'Done',          7, true,  timezone('utc', now()), timezone('utc', now()))
ON CONFLICT ("key") DO NOTHING;

-- AddForeignKey (pipeline -> "users"). LAST on purpose: each takes the SHARE ROW EXCLUSIVE
-- lock on "users" described in the header, held from here until COMMIT.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_projects_owner_id_fkey' AND conrelid = '"public"."pipeline_projects"'::regclass) THEN
    ALTER TABLE "pipeline_projects" ADD CONSTRAINT "pipeline_projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_projects_created_by_id_fkey' AND conrelid = '"public"."pipeline_projects"'::regclass) THEN
    ALTER TABLE "pipeline_projects" ADD CONSTRAINT "pipeline_projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_participants_user_id_fkey' AND conrelid = '"public"."pipeline_participants"'::regclass) THEN
    ALTER TABLE "pipeline_participants" ADD CONSTRAINT "pipeline_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_messages_author_id_fkey' AND conrelid = '"public"."pipeline_messages"'::regclass) THEN
    ALTER TABLE "pipeline_messages" ADD CONSTRAINT "pipeline_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
