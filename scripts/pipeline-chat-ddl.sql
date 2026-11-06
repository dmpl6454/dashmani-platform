-- ============================================================================
-- scripts/pipeline-chat-ddl.sql — feature-only DDL: Slack-style channels and direct messages
-- in the sales portal's Pipeline (2026-11-03).
-- Model:    PipelineProject (+kind, +isPrivate, +dmKey @unique, +parentProjectId → pipeline_projects),
--           PipelineParticipant (+hiddenSeq)
-- Services: apps/api/src/services/pipeline/conversations.service.ts (and the kind filters in
--           board.ts, projects.service.ts, sync.service.ts, shoots.service.ts)
--
-- A channel or DM is a pipeline_projects row with kind <> 'project', so it reuses the thread,
-- replies, reactions, mentions, unread and sync machinery unchanged. Every project surface
-- (board, archived/deleted lists, rank neighbours, workload) filters kind = 'project'.
--
-- Generated with
--   prisma migrate diff --from-schema-datamodel <origin/main schema.prisma>
--     --to-schema-datamodel packages/db/prisma/schema.prisma --script
-- then hand-edited like the other feature DDL scripts: one transaction, lock_timeout 3s,
-- statement_timeout 60s, search_path pinned, ADD COLUMN / CREATE INDEX IF NOT EXISTS.
-- Definitions are byte-identical to the generated output. pipeline_projects is small (one row
-- per project); ADD COLUMN with a constant default is metadata-only on Postgres 11+.
--
-- A channel may belong to a campaign (parent_project_id → pipeline_projects ON DELETE CASCADE):
-- it then shows in that campaign's sidebar, and the 30-day purge of the campaign removes it.
--
-- "Deleting" a DM hides it from that person's sidebar only: pipeline_participants.hidden_seq is
-- the conversation's last_message_seq at that moment, and a newer message shows it again.
--
-- Purely additive: five columns (two with constant defaults, three nullable), two indexes and one
-- self-referencing foreign key (pipeline_projects → pipeline_projects; no lock on any other table).
-- Channel-name uniqueness is enforced in the service under an advisory lock, not by an index.
-- Safe to re-run. Apply on prod with scripts/apply-pipeline-chat-ddl.sh BEFORE deploying the code
-- (Pipeline DDL cycle: docs/superpowers/plans/2026-09-26-pipeline-ddl-runbook.md).
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = public;

-- AlterTable
ALTER TABLE "pipeline_projects" ADD COLUMN IF NOT EXISTS "kind" VARCHAR(8) NOT NULL DEFAULT 'project';
ALTER TABLE "pipeline_projects" ADD COLUMN IF NOT EXISTS "is_private" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "pipeline_projects" ADD COLUMN IF NOT EXISTS "dm_key" TEXT;
ALTER TABLE "pipeline_projects" ADD COLUMN IF NOT EXISTS "parent_project_id" TEXT;
ALTER TABLE "pipeline_participants" ADD COLUMN IF NOT EXISTS "hidden_seq" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_projects_dm_key_key" ON "pipeline_projects"("dm_key");
CREATE INDEX IF NOT EXISTS "pipeline_projects_parent_project_id_idx" ON "pipeline_projects"("parent_project_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_projects_parent_project_id_fkey') THEN
    ALTER TABLE "pipeline_projects" ADD CONSTRAINT "pipeline_projects_parent_project_id_fkey" FOREIGN KEY ("parent_project_id") REFERENCES "pipeline_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
