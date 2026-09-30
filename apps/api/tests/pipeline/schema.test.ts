/**
 * pipeline/schema.test.ts — the M1 schema contract (spec §2).
 *
 * The pipeline ships its tables DARK: nothing reads or writes them in this PR. What this
 * file locks is the SHAPE later PRs depend on, because their hot paths are raw SQL that
 * names columns, unique indexes and FK behaviour directly — a renamed column or a missing
 * index would only surface as a 500 (or a full scan) in production:
 *   - every column of every `pipeline_*` table in §2, under its mapped snake_case name;
 *   - the unique and secondary indexes (including `parent_id`, which the purge's FK
 *     cascade must not full-scan without);
 *   - the §2 onDelete table (Restrict to users for owner/creator/author, Cascade for rows
 *     that belong to a user or a project, and NO FK for the informational actor ids);
 *   - `PIPELINE` exists in the Postgres enum AND in the generated client;
 *   - `NOTIFICATION_AUDIENCE.PIPELINE` is `[]`, so the generic dispatcher can never fan a
 *     pipeline row out to admins (pipeline rows are written only by services/pipeline/notify.ts);
 *   - the tables are in the test TRUNCATE list, so pipeline fixtures cannot leak across tests.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, NotificationType } from "@dashmani/db";
import { ensurePipelineEmailSchema } from "./pipeline-helpers";
import { NOTIFICATION_AUDIENCE } from "../../src/services/notification-routing";
import { dispatchNotification } from "../../src/services/notification.service";

const COLUMNS: Record<string, string[]> = {
  pipeline_phases: [
    "id", "key", "name", "position", "color", "is_terminal", "archived_at", "created_at", "updated_at",
  ],
  pipeline_board_state: ["id", "seq", "updated_at"],
  pipeline_projects: [
    "id", "client_id", "title", "description", "owner_id", "created_by_id", "phase_id", "rank",
    "start_date", "due_date", "header_rev", "thread_rev", "last_message_seq", "last_message_at",
    "member_count", "phase_changed_at", "phase_changed_by_id", "move_gen", "move_actor_id",
    "move_started_at", "move_last_at", "move_from_phase_id", "due_soon_notified_for",
    "overdue_notified_for", "archived_at", "archived_by_id", "archived_by_admin", "deleted_at",
    "deleted_by_id", "deleted_by_admin", "created_at", "updated_at",
  ],
  pipeline_participants: [
    "project_id", "user_id", "role", "notify", "last_read_seq", "seen_at", "engaged_at",
    "member_added_by_id", "member_added_at", "created_at", "updated_at",
  ],
  pipeline_messages: [
    "id", "client_id", "project_id", "seq", "rev", "parent_id", "author_id", "body", "mention_ids",
    "reactions", "reply_count", "last_reply_at", "edited_at", "deleted_at", "created_at", "updated_at",
  ],
  // The email outbox (owner request 2026-09-30).
  pipeline_email_outbox: [
    "id", "user_id", "project_id", "kind", "payload", "status", "attempts", "send_after",
    "last_error", "sent_at", "created_at", "updated_at",
  ],
};

// Prisma's deterministic index names for the §2 @@id / @unique / @@unique / @@index set.
const INDEXES: Record<string, string[]> = {
  pipeline_phases: ["pipeline_phases_pkey", "pipeline_phases_key_key", "pipeline_phases_position_id_idx"],
  pipeline_board_state: ["pipeline_board_state_pkey"],
  pipeline_projects: [
    "pipeline_projects_pkey",
    "pipeline_projects_created_by_id_client_id_key",
    "pipeline_projects_phase_id_idx",
    "pipeline_projects_owner_id_idx",
    "pipeline_projects_due_date_idx",
    "pipeline_projects_archived_at_id_idx",
    "pipeline_projects_deleted_at_idx",
  ],
  pipeline_participants: ["pipeline_participants_pkey", "pipeline_participants_user_id_idx"],
  pipeline_messages: [
    "pipeline_messages_pkey",
    "pipeline_messages_author_id_client_id_key",
    "pipeline_messages_project_id_seq_key",
    "pipeline_messages_project_id_rev_key",
    "pipeline_messages_project_id_parent_id_seq_idx",
    "pipeline_messages_parent_id_idx",
  ],
  // + the hand-written partial unique index (scripts/pipeline-email-ddl.sql; Prisma cannot
  // express it — beforeAll creates it from that script, as CI's db-push database lacks it).
  pipeline_email_outbox: [
    "pipeline_email_outbox_pkey",
    "pipeline_email_outbox_status_send_after_idx",
    "pipeline_email_outbox_project_id_idx",
    "pipeline_email_outbox_pending_key",
  ],
};

// §2 "onDelete rules and why". confdeltype: r = RESTRICT, c = CASCADE.
const FOREIGN_KEYS = [
  "pipeline_email_outbox.project_id -> pipeline_projects : c",
  "pipeline_email_outbox.user_id -> users : c",
  "pipeline_messages.author_id -> users : r",
  "pipeline_messages.parent_id -> pipeline_messages : c",
  "pipeline_messages.project_id -> pipeline_projects : c",
  "pipeline_participants.project_id -> pipeline_projects : c",
  "pipeline_participants.user_id -> users : c",
  "pipeline_projects.created_by_id -> users : r",
  "pipeline_projects.owner_id -> users : r",
  "pipeline_projects.phase_id -> pipeline_phases : r",
];

describe("pipeline schema (spec §2)", () => {
  beforeAll(async () => {
    await ensurePipelineEmailSchema();
  });

  for (const [table, cols] of Object.entries(COLUMNS)) {
    it(`${table} has every §2 column`, async () => {
      // Identifiers come from the constant above, never from input.
      const sql = `SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}" LIMIT 0`;
      await expect(prisma.$queryRawUnsafe(sql)).resolves.toEqual([]);

      // …and no column the spec does not define (catches a stray or renamed field).
      const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
        ORDER BY column_name`;
      expect(rows.map((r) => r.column_name).sort()).toEqual([...cols].sort());
    });
  }

  for (const [table, names] of Object.entries(INDEXES)) {
    it(`${table} carries exactly the §2 indexes`, async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;
      expect(rows.map((r) => r.indexname).sort()).toEqual([...names].sort());
    });
  }

  it("the outbox coalescing key is UNIQUE and PARTIAL on status = 'pending'", async () => {
    const [row] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'pipeline_email_outbox_pending_key'`;
    expect(row.indexdef).toBe(
      "CREATE UNIQUE INDEX pipeline_email_outbox_pending_key ON public.pipeline_email_outbox USING btree (user_id, project_id, kind) WHERE ((status)::text = 'pending'::text)",
    );
  });

  it("foreign keys follow the §2 onDelete table, and informational actor ids have no FK", async () => {
    const rows = await prisma.$queryRaw<Array<{ fk: string }>>`
      SELECT c.conrelid::regclass::text || '.' || a.attname || ' -> ' ||
             c.confrelid::regclass::text || ' : ' || c.confdeltype::text AS fk
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'
        AND c.conrelid::regclass::text LIKE 'pipeline\\_%'`;
    expect(rows.map((r) => r.fk).sort()).toEqual([...FOREIGN_KEYS].sort());
  });

  it("messages.mention_ids is text[] defaulting to '{}', reactions is NOT NULL jsonb defaulting to {}", async () => {
    // ⚠️ Prisma cannot declare NOT NULL on a scalar list, so mention_ids is NULLABLE at the
    // DB level (Prisma's standard shape; hand-adding NOT NULL to the prod DDL would drift
    // from every `db push` environment). Raw-SQL writers must therefore omit the column or
    // write an explicit array — never NULL — and raw readers should COALESCE(…, '{}').
    const rows = await prisma.$queryRaw<
      Array<{ column_name: string; udt_name: string; is_nullable: string; column_default: string }>
    >`
      SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pipeline_messages'
        AND column_name IN ('mention_ids', 'reactions')
      ORDER BY column_name`;
    expect(rows).toEqual([
      { column_name: "mention_ids", udt_name: "_text", is_nullable: "YES", column_default: "ARRAY[]::text[]" },
      { column_name: "reactions", udt_name: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" },
    ]);
  });

  it("PIPELINE is a NotificationType value in Postgres and in the generated client", async () => {
    const rows = await prisma.$queryRaw<Array<{ t: string }>>`SELECT 'PIPELINE'::"NotificationType"::text AS t`;
    expect(rows).toEqual([{ t: "PIPELINE" }]);
    expect(NotificationType.PIPELINE).toBe("PIPELINE");
  });

  it("NOTIFICATION_AUDIENCE.PIPELINE is empty", () => {
    expect(NOTIFICATION_AUDIENCE.PIPELINE).toEqual([]);
  });

  it("dispatchNotification never fans a PIPELINE row out (no admin fallback)", async () => {
    const role = await prisma.role.create({ data: { name: "Admin", description: "test" } });
    const admin = await prisma.user.create({
      data: {
        name: "Pipeline Admin",
        email: "pipeline-schema-admin@test.com",
        passwordHash: "x",
        status: "ACTIVE",
        roles: { create: [{ roleId: role.id }] },
      },
    });
    await dispatchNotification({
      type: "PIPELINE",
      title: "t",
      message: "m",
      recipientUserId: admin.id,
    });
    expect(await prisma.notification.count()).toBe(0);
  });

  // The next two run in order (vitest runs a file's tests sequentially): the first writes
  // pipeline rows, the second proves setup.ts's beforeEach TRUNCATE removed them.
  it("pipeline rows can be written (fixture for the truncate check)", async () => {
    const owner = await prisma.user.create({
      data: { name: "Owner", email: "pipeline-schema-owner@test.com", passwordHash: "x", status: "ACTIVE" },
    });
    const phase = await prisma.pipelinePhase.create({ data: { key: "zz_schema_test", name: "ZZ", position: 1 } });
    await prisma.pipelineBoardState.create({ data: { id: 1, seq: 0 } });
    const project = await prisma.pipelineProject.create({
      data: {
        clientId: "c1",
        title: "T",
        ownerId: owner.id,
        createdById: owner.id,
        phaseId: phase.id,
        rank: "a0",
        participants: { create: [{ userId: owner.id, role: "MEMBER" }] },
      },
    });
    await prisma.pipelineMessage.create({
      data: { clientId: "m1", projectId: project.id, seq: 1, rev: 1, authorId: owner.id, body: "hi" },
    });
    await prisma.pipelineEmailOutbox.create({
      data: { userId: owner.id, projectId: project.id, kind: "moved", sendAfter: new Date() },
    });
    expect(await prisma.pipelineMessage.count()).toBe(1);
    expect(await prisma.pipelineEmailOutbox.count()).toBe(1);
  });

  it("the pipeline tables are truncated between tests", async () => {
    expect(await prisma.pipelinePhase.count()).toBe(0);
    expect(await prisma.pipelineBoardState.count()).toBe(0);
    expect(await prisma.pipelineProject.count()).toBe(0);
    expect(await prisma.pipelineParticipant.count()).toBe(0);
    expect(await prisma.pipelineMessage.count()).toBe(0);
    expect(await prisma.pipelineEmailOutbox.count()).toBe(0);
  });
});
