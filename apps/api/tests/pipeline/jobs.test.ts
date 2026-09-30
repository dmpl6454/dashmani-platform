/**
 * pipeline/jobs.test.ts — wall-clock notification trim and soft-delete purge (spec §7.12).
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { plnId } from "../../src/services/pipeline/notify";
import {
  msUntilNextIST,
  runPipelineMaintenanceIfDue,
  schedulePipelineMaintenance,
  trimPipelineNotifications,
  trimPipelineEmailOutbox,
  purgeDeletedProjects,
  TRIM_MARKER_KEY,
} from "../../src/services/pipeline/jobs";
import { clearPipelineSettings, createPipelineUser, seedPipelinePhases, ensurePipelineEmailSchema } from "./pipeline-helpers";
import { createProjectFixture } from "./fixtures-messages";

const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000+05:30`);

describe("pipeline maintenance jobs", () => {
  beforeEach(async () => {
    resetPipelineStateForTests();
    await clearPipelineSettings();
    await seedPipelinePhases();
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  async function note(userId: string, o: { id?: string; read: boolean; ageDays: number; pid?: string; type?: "PIPELINE" | "GENERAL" }) {
    const id = o.id ?? randomUUID();
    await prisma.notification.create({
      data: {
        id,
        userId,
        type: o.type ?? "PIPELINE",
        title: "t",
        message: "m",
        read: o.read,
        metadata: { v: 1, kind: "messages", pid: o.pid ?? randomUUID() },
        createdAt: new Date(Date.now() - o.ageDays * 86_400_000),
      },
    });
    return id;
  }
  const exists = async (id: string) => (await prisma.notification.findUnique({ where: { id } })) !== null;

  describe("scheduling (wall clock, never at boot)", () => {
    it("msUntilNextIST aims at the next 04:00 IST and is never 0", () => {
      expect(msUntilNextIST(240, ist("2026-09-29", "03:00"))).toBe(60 * 60_000);
      expect(msUntilNextIST(240, ist("2026-09-29", "04:00"))).toBe(24 * 60 * 60_000);
      expect(msUntilNextIST(240, ist("2026-09-29", "05:00"))).toBe(23 * 60 * 60_000);
    });

    it("the scheduler never runs at boot; it runs at the next 04:00", () => {
      vi.useFakeTimers({ now: ist("2026-09-29", "02:00") });
      const run = vi.fn(async () => ({ status: "skipped" as const, reason: "hours" as const }));
      const handle = schedulePipelineMaintenance(run);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2 * 60 * 60_000 - 1);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);
      handle.stop();
    });

    it("runs only in 03:30–05:30 IST, once per IST day (the marker)", async () => {
      expect(await runPipelineMaintenanceIfDue({ now: ist("2026-09-29", "03:29"), pauseMs: 0 })).toMatchObject({ status: "skipped", reason: "hours" });
      expect(await runPipelineMaintenanceIfDue({ now: ist("2026-09-29", "05:30"), pauseMs: 0 })).toMatchObject({ status: "skipped", reason: "hours" });
      expect(await runPipelineMaintenanceIfDue({ now: ist("2026-09-29", "04:00"), pauseMs: 0 })).toMatchObject({ status: "ran" });
      expect((await prisma.systemSetting.findUnique({ where: { key: TRIM_MARKER_KEY } }))?.value).toBe("2026-09-29");
      expect(await runPipelineMaintenanceIfDue({ now: ist("2026-09-29", "04:30"), pauseMs: 0 })).toMatchObject({ status: "skipped", reason: "done" });
      expect(await runPipelineMaintenanceIfDue({ now: ist("2026-09-30", "03:45"), pauseMs: 0 })).toMatchObject({ status: "ran" });
    });
  });

  describe("email outbox trim", () => {
    it("deletes sent / skipped / failed rows older than 30 days; never pending or sending ones; runs in the maintenance run", async () => {
      await ensurePipelineEmailSchema();
      const u = await createPipelineUser({ name: "U", tag: "trim-ob" });
      const p = await createProjectFixture({ ownerId: u.id });
      const row = async (status: string, ageDays: number, kind = "moved") =>
        (
          await prisma.pipelineEmailOutbox.create({
            data: {
              userId: u.id,
              projectId: p.id,
              kind,
              status,
              sendAfter: new Date(),
              createdAt: new Date(Date.now() - ageDays * 86_400_000),
            },
          })
        ).id;
      const gone = [await row("sent", 31), await row("skipped", 40, "mention"), await row("failed", 60, "due_soon")];
      const kept = [await row("sent", 29), await row("pending", 45, "due_changed"), await row("sending", 45, "mention")];
      expect(await trimPipelineEmailOutbox({ pauseMs: 0 })).toBe(3);
      const left = (await prisma.pipelineEmailOutbox.findMany({ select: { id: true } })).map((r) => r.id).sort();
      expect(left).toEqual([...kept].sort());
      expect(gone.some((id) => left.includes(id))).toBe(false);

      await row("failed", 35, "moved");
      const r = await runPipelineMaintenanceIfDue({ now: ist("2026-09-29", "04:00"), pauseMs: 0 });
      expect(r).toMatchObject({ status: "ran", outboxTrimmed: 1 });
    });
  });

  describe("trim", () => {
    it("deletes read rows > 30 days and any row > 90 days, PIPELINE only", async () => {
      const u = await createPipelineUser({ name: "U", tag: "trim-u" });
      const oldRead = await note(u.id, { read: true, ageDays: 31 });
      const oldUnread = await note(u.id, { read: false, ageDays: 31 });
      const ancient = await note(u.id, { read: false, ageDays: 91 });
      const fresh = await note(u.id, { read: true, ageDays: 2 });
      const general = await note(u.id, { read: true, ageDays: 200, type: "GENERAL" });
      expect(await trimPipelineNotifications({ pauseMs: 0 })).toBe(2);
      expect(await exists(oldRead)).toBe(false);
      expect(await exists(ancient)).toBe(false);
      expect(await exists(oldUnread)).toBe(true);
      expect(await exists(fresh)).toBe(true);
      expect(await exists(general)).toBe(true);
    });

    it("a trim racing a re-armed grouped row does not delete it", async () => {
      const u = await createPipelineUser({ name: "U", tag: "trim-r" });
      const pid = randomUUID();
      const grouped = await note(u.id, { id: plnId("messages", pid, u.id), read: true, ageDays: 40, pid });
      const other = await note(u.id, { read: true, ageDays: 40 });
      await prisma.$transaction(async (tx) => {
        // The next message re-arms the row (and holds it) while the trim runs.
        await tx.$executeRaw`UPDATE notifications SET read = false, created_at = timezone('utc', now()) WHERE id = ${grouped}`;
        await trimPipelineNotifications({ pauseMs: 0 });
      });
      expect(await exists(other)).toBe(false);
      const row = await prisma.notification.findUniqueOrThrow({ where: { id: grouped } });
      expect(row.read).toBe(false);
      await trimPipelineNotifications({ pauseMs: 0 });
      expect(await exists(grouped)).toBe(true);
    });
  });

  describe("purge", () => {
    it("a project with >= 5,000 messages: chunks < 1 s, replies before roots, PIPELINE rows gone for every affected user", async () => {
      const owner = await createPipelineUser({ name: "Owner", tag: "pg-o" });
      const author = await createPipelineUser({ name: "Author", tag: "pg-a" });
      const mentioned = await createPipelineUser({ name: "Mentioned", tag: "pg-m" });
      const bystander = await createPipelineUser({ name: "Bystander", tag: "pg-b" });
      const project = await createProjectFixture({ ownerId: owner.id, deleted: true });
      const keep = await createProjectFixture({ ownerId: owner.id, deleted: true });
      await pipelineDb.$executeRaw`UPDATE pipeline_projects SET deleted_at = timezone('utc', now()) - interval '31 days' WHERE id = ${project.id}`;
      await pipelineDb.$executeRaw`UPDATE pipeline_projects SET deleted_at = timezone('utc', now()) - interval '10 days' WHERE id = ${keep.id}`;
      // 2,500 roots then 2,500 replies (one per root).
      await pipelineDb.$executeRaw`
        INSERT INTO pipeline_messages (id, client_id, project_id, seq, rev, parent_id, author_id, body, mention_ids, created_at, updated_at)
        SELECT md5(${project.id} || 'r' || g)::uuid::text, md5('cr' || g)::uuid::text, ${project.id}, g, g, NULL,
               CASE WHEN g % 2 = 0 THEN ${author.id} ELSE ${owner.id} END, 'root ' || g,
               CASE WHEN g = 7 THEN ARRAY[${mentioned.id}] ELSE '{}'::text[] END,
               timezone('utc', now()), timezone('utc', now())
          FROM generate_series(1, 2500) g`;
      await pipelineDb.$executeRaw`
        INSERT INTO pipeline_messages (id, client_id, project_id, seq, rev, parent_id, author_id, body, mention_ids, created_at, updated_at)
        SELECT md5(${project.id} || 'p' || g)::uuid::text, md5('cp' || g)::uuid::text, ${project.id}, 2500 + g, 2500 + g,
               md5(${project.id} || 'r' || g)::uuid::text, ${author.id}, 'reply ' || g, '{}'::text[],
               timezone('utc', now()), timezone('utc', now())
          FROM generate_series(1, 2500) g`;
      const gone = [
        await note(owner.id, { read: false, ageDays: 1, pid: project.id }),
        await note(author.id, { read: true, ageDays: 1, pid: project.id }),
        await note(mentioned.id, { read: false, ageDays: 1, pid: project.id }),
      ];
      const kept = [
        await note(owner.id, { read: false, ageDays: 1, pid: keep.id }),
        await note(bystander.id, { read: false, ageDays: 1, pid: randomUUID() }),
      ];

      const chunks: Array<{ phase: string; rows: number; ms: number }> = [];
      const r = await purgeDeletedProjects({ onChunk: (c) => chunks.push(c) });
      expect(r).toEqual({ purged: 1 });
      expect(await pipelineDb.pipelineProject.findUnique({ where: { id: project.id } })).toBeNull();
      expect(await pipelineDb.pipelineProject.findUnique({ where: { id: keep.id } })).not.toBeNull();
      expect(await pipelineDb.pipelineMessage.count({ where: { projectId: project.id } })).toBe(0);
      expect(await pipelineDb.pipelineParticipant.count({ where: { projectId: project.id } })).toBe(0);
      for (const id of gone) expect(await exists(id)).toBe(false);
      for (const id of kept) expect(await exists(id)).toBe(true);

      const msgChunks = chunks.filter((c) => c.phase === "replies" || c.phase === "roots");
      expect(msgChunks.reduce((n, c) => n + c.rows, 0)).toBe(5000);
      expect(msgChunks.every((c) => c.rows <= 1000)).toBe(true);
      const firstRoot = msgChunks.findIndex((c) => c.phase === "roots");
      expect(firstRoot).toBeGreaterThan(0);
      expect(msgChunks.slice(firstRoot).every((c) => c.phase === "roots")).toBe(true);
      for (const c of chunks) expect(c.ms).toBeLessThan(1000);
    });
  });
});
