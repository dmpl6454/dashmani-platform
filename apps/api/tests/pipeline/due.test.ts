/**
 * pipeline/due.test.ts — IST helpers and the due-soon / overdue cron (spec §7.8).
 * The clock is injected: every tick gets an explicit `now`.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@dashmani/db";
import { dayOfWeekIST, isWorkingDayIST, nextWorkingDayIST, istMinutesOfDay } from "@dashmani/shared";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { plnId } from "../../src/services/pipeline/notify";
import { runPipelineDueTick } from "../../src/cron/pipeline-due.cron";
import { setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";
import { createProjectFixture } from "./fixtures-messages";

/** An instant at `hh:mm` IST on `day`. */
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000+05:30`);

describe("IST helpers (§7.8)", () => {
  it("dayOfWeekIST / isWorkingDayIST / nextWorkingDayIST — Sunday is the only weekend", () => {
    expect(dayOfWeekIST("2026-09-27")).toBe(0);
    expect(dayOfWeekIST("2026-10-03")).toBe(6);
    expect(isWorkingDayIST("2026-09-27")).toBe(false);
    expect(isWorkingDayIST("2026-10-03")).toBe(true);
    expect(nextWorkingDayIST("2026-09-29")).toBe("2026-09-30");
    expect(nextWorkingDayIST("2026-10-02")).toBe("2026-10-03");
    expect(nextWorkingDayIST("2026-10-03")).toBe("2026-10-05");
    expect(nextWorkingDayIST("2026-12-31")).toBe("2027-01-01");
  });
  it("istMinutesOfDay", () => {
    expect(istMinutesOfDay(ist("2026-09-29", "09:30"))).toBe(570);
    expect(istMinutesOfDay(ist("2026-09-29", "00:05"))).toBe(5);
    expect(istMinutesOfDay(ist("2026-09-29", "23:59"))).toBe(1439);
  });
});

describe("pipeline due cron (§7.8)", () => {
  beforeEach(async () => {
    resetPipelineStateForTests();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
  });
  afterAll(async () => {
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  async function project(due: string, opts: { phaseKey?: string; archived?: boolean; title?: string } = {}) {
    const owner = await createPipelineUser({ name: "Owner", tag: "due-o" });
    const bob = await createPipelineUser({ name: "Bob", tag: "due-b" });
    const p = await createProjectFixture({
      ownerId: owner.id,
      memberIds: [bob.id],
      phaseKey: opts.phaseKey ?? "review",
      archived: opts.archived,
      title: opts.title ?? "Diwali campaign",
    });
    await pipelineDb.$executeRaw`UPDATE pipeline_projects SET due_date = ${due}::date WHERE id = ${p.id}`;
    return { owner, bob, p };
  }
  const pipelineRows = () => prisma.notification.findMany({ where: { type: "PIPELINE" }, orderBy: { id: "asc" } });

  it("Monday–Friday send the day before", async () => {
    const a = await project("2026-09-30");
    const b = await project("2026-10-01");
    const r = await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
    expect(r).toMatchObject({ status: "ran", dueSoon: 1, overdue: 0 });
    const rows = await pipelineRows();
    expect(rows.map((x) => x.userId).sort()).toEqual([a.owner.id, a.bob.id].sort());
    const bobRow = rows.find((x) => x.userId === a.bob.id)!;
    expect(bobRow.id).toBe(plnId("due_soon", a.p.id, a.bob.id, "2026-09-30"));
    expect(bobRow.title).toBe("“Diwali campaign” is due tomorrow (Wed 30 Sep)");
    expect(bobRow.message).toBe("Phase: Review");
    expect(bobRow.metadata).toMatchObject({ v: 1, kind: "due_soon", pid: a.p.id, due: "2026-09-30" });
    expect((await pipelineDb.pipelineProject.findUniqueOrThrow({ where: { id: b.p.id } })).dueSoonNotifiedFor).toBeNull();
  });

  it("Saturday covers Sunday and Monday; Sunday is a no-op", async () => {
    const sun = await project("2026-10-04");
    const mon = await project("2026-10-05");
    await project("2026-10-06");
    expect(await runPipelineDueTick({ now: ist("2026-10-04", "10:00") })).toMatchObject({ status: "skipped", reason: "weekend" });
    expect(await pipelineRows()).toHaveLength(0);
    await runPipelineDueTick({ now: ist("2026-10-03", "10:00") });
    const rows = await pipelineRows();
    expect(new Set(rows.map((r) => (r.metadata as { pid: string }).pid))).toEqual(new Set([sun.p.id, mon.p.id]));
    expect(rows.find((r) => r.userId === sun.bob.id)!.title).toBe("“Diwali campaign” is due tomorrow (Sun 4 Oct)");
    expect(rows.find((r) => r.userId === mon.bob.id)!.title).toBe("“Diwali campaign” is due Monday (5 Oct)");
  });

  it("09:29 IST is a no-op, 09:30 sends, 20:00 is a no-op", async () => {
    await project("2026-09-30");
    expect(await runPipelineDueTick({ now: ist("2026-09-29", "09:29") })).toMatchObject({ status: "skipped", reason: "hours" });
    expect(await runPipelineDueTick({ now: ist("2026-09-29", "20:00") })).toMatchObject({ status: "skipped", reason: "hours" });
    expect(await pipelineRows()).toHaveLength(0);
    expect(await runPipelineDueTick({ now: ist("2026-09-29", "09:30") })).toMatchObject({ status: "ran", dueSoon: 1 });
  });

  it("does nothing while the feature is off", async () => {
    await project("2026-09-30");
    await clearPipelineSettings();
    resetPipelineStateForTests();
    expect(await runPipelineDueTick({ now: ist("2026-09-29", "10:00") })).toMatchObject({ status: "skipped", reason: "off" });
  });

  it("a re-run inserts nothing, and a changed due date re-arms", async () => {
    const a = await project("2026-09-30");
    await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
    expect(await runPipelineDueTick({ now: ist("2026-09-29", "11:00") })).toMatchObject({ dueSoon: 0 });
    expect(await pipelineRows()).toHaveLength(2);
    await pipelineDb.$executeRaw`UPDATE pipeline_projects SET due_date = DATE '2026-10-01' WHERE id = ${a.p.id}`;
    expect(await runPipelineDueTick({ now: ist("2026-09-30", "10:00") })).toMatchObject({ dueSoon: 1 });
    const ids = (await pipelineRows()).filter((r) => r.userId === a.bob.id).map((r) => r.id);
    expect(ids.sort()).toEqual(
      [plnId("due_soon", a.p.id, a.bob.id, "2026-09-30"), plnId("due_soon", a.p.id, a.bob.id, "2026-10-01")].sort(),
    );
  });

  it("due-soon and then overdue for the same date give two rows", async () => {
    const a = await project("2026-09-30");
    await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
    expect(await runPipelineDueTick({ now: ist("2026-10-01", "10:00") })).toMatchObject({ overdue: 1 });
    const mine = (await pipelineRows()).filter((r) => r.userId === a.bob.id);
    expect(mine.map((r) => (r.metadata as { kind: string }).kind).sort()).toEqual(["due_soon", "overdue"]);
    expect(mine.find((r) => (r.metadata as { kind: string }).kind === "overdue")!.title).toBe(
      "“Diwali campaign” is overdue — was due Wed 30 Sep, still in Review",
    );
  });

  it("terminal-phase and archived projects are excluded", async () => {
    await project("2026-09-30", { phaseKey: "done" });
    await project("2026-09-30", { archived: true });
    await project("2026-09-20", { phaseKey: "done" });
    const r = await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
    expect(r).toMatchObject({ dueSoon: 0, overdue: 0 });
    expect(await pipelineRows()).toHaveLength(0);
  });

  it("a concurrent PATCH of the due date mid-run never stamps the wrong date", async () => {
    const a = await project("2026-09-30");
    await prisma.$transaction(async (tx) => {
      // The PATCH holds the row lock with the NEW date while the tick runs.
      await tx.$executeRaw`UPDATE pipeline_projects SET due_date = DATE '2026-10-01' WHERE id = ${a.p.id}`;
      const r = await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
      expect(r).toMatchObject({ dueSoon: 0 });
    });
    const row = await pipelineDb.pipelineProject.findUniqueOrThrow({ where: { id: a.p.id } });
    expect(row.dueSoonNotifiedFor).toBeNull();
    expect(await pipelineRows()).toHaveLength(0);
    // The next tick sees the committed date: 1 Oct is not due until the 30th's run.
    await runPipelineDueTick({ now: ist("2026-09-30", "10:00") });
    const after = await pipelineDb.pipelineProject.findUniqueOrThrow({ where: { id: a.p.id } });
    expect(after.dueSoonNotifiedFor?.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect((await pipelineRows()).every((r) => (r.metadata as { due: string }).due === "2026-10-01")).toBe(true);
  });

  it("the overlap flag is claimed before the first await", async () => {
    await project("2026-09-30");
    const first = runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
    const second = await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
    expect(second).toEqual({ status: "skipped", reason: "running" });
    expect(await first).toMatchObject({ status: "ran", dueSoon: 1 });
  });
});
