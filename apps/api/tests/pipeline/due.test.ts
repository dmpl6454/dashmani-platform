/**
 * pipeline/due.test.ts — IST helpers and the due-soon / overdue cron (spec §7.8).
 * The clock is injected: every tick gets an explicit `now`.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { dayOfWeekIST, isWorkingDayIST, nextWorkingDayIST, istMinutesOfDay } from "@dashmani/shared";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { plnId } from "../../src/services/pipeline/notify";
import { runPipelineDueTick } from "../../src/cron/pipeline-due.cron";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";
import { createProjectFixture, phaseIdOf } from "./fixtures-messages";

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
    // ABSOLUTE wording (D3): "tomorrow" would be false from the next day on (rows live 90 days).
    expect(bobRow.title).toBe("“Diwali campaign” is due Wednesday (30 Sep)");
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
    expect(rows.find((r) => r.userId === sun.bob.id)!.title).toBe("“Diwali campaign” is due Sunday (4 Oct)");
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
    const overdue = mine.find((r) => (r.metadata as { kind: string }).kind === "overdue")!;
    // No "still in <phase>" in the title: a later move between live phases would make it false
    // (the row stays). The phase lives in the message, like every other row's "Phase: …".
    expect(overdue.title).toBe("“Diwali campaign” is overdue — was due Wed 30 Sep");
    expect(overdue.message).toBe("Phase: Review");
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

  it("dates carry their year when it is not the year of the run (B9)", async () => {
    const next = await project("2027-01-01");
    const last = await project("2025-12-30", { title: "Year-end recap" });
    expect(await runPipelineDueTick({ now: ist("2026-12-31", "10:00") })).toMatchObject({ status: "ran", dueSoon: 1, overdue: 1 });
    const rows = await pipelineRows();
    expect(rows.find((r) => r.userId === next.bob.id)!.title).toBe("“Diwali campaign” is due Friday (1 Jan 2027)");
    expect(rows.find((r) => r.userId === last.bob.id)!.title).toBe("“Year-end recap” is overdue — was due Tue 30 Dec 2025");
  });

  it("pilot mode: due-soon and overdue rows go only to pilot participants (F16)", async () => {
    const soon = await project("2026-09-30");
    const late = await project("2026-09-28");
    await setPipelineSetting("pipeline.mode", "pilot");
    await setPipelineSetting("pipeline.pilotUserIds", JSON.stringify([soon.owner.id, late.bob.id]));
    resetPipelineStateForTests();
    expect(await runPipelineDueTick({ now: ist("2026-09-29", "10:00") })).toMatchObject({ status: "ran", dueSoon: 1, overdue: 1 });
    const got = (await pipelineRows()).map((r) => [r.userId, (r.metadata as { kind: string }).kind].join(":")).sort();
    expect(got).toEqual([`${soon.owner.id}:due_soon`, `${late.bob.id}:overdue`].sort());
  });

  describe("a due date that changes, or reaches Done, withdraws the alerts it no longer supports (D1, D2)", () => {
    const auth = (uid: string) => ({ Authorization: `Bearer ${hrToken(uid)}` });
    const patchDue = (uid: string, pid: string, from: string | null, to: string | null) =>
      request(app).patch(`/v1/pipeline/projects/${pid}`).set(auth(uid)).send({ changes: { dueDate: to }, base: { dueDate: from } });
    const move = (uid: string, pid: string, toPhaseId: string, basePhaseId: string) =>
      request(app).post(`/v1/pipeline/projects/${pid}/move`).set(auth(uid)).send({ toPhaseId, afterId: null, basePhaseId });
    const ofKind = async (kind: string) => (await pipelineRows()).filter((r) => (r.metadata as { kind: string }).kind === kind);
    const markers = async (pid: string) => {
      const p = await pipelineDb.pipelineProject.findUniqueOrThrow({ where: { id: pid } });
      return { dueSoon: p.dueSoonNotifiedFor, overdue: p.overdueNotifiedFor };
    };

    it("PATCH D1 → D2 deletes every participant's D1 due-soon row, read or not; D2's alert comes on its own day (B1)", async () => {
      const a = await project("2026-09-30");
      await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
      expect(await ofKind("due_soon")).toHaveLength(2); // owner + Bob
      await prisma.notification.update({ where: { id: plnId("due_soon", a.p.id, a.owner.id, "2026-09-30") }, data: { read: true } });
      expect((await patchDue(a.owner.id, a.p.id, "2026-09-30", "2026-10-06")).status).toBe(200);
      expect(await ofKind("due_soon")).toHaveLength(0);
      expect(await markers(a.p.id)).toEqual({ dueSoon: null, overdue: null });
      expect((await ofKind("due_changed")).map((r) => r.userId)).toEqual([a.bob.id]); // the change itself is told
      // Nothing re-alerts for 6 Oct before its eve…
      expect(await runPipelineDueTick({ now: ist("2026-09-30", "10:00") })).toMatchObject({ dueSoon: 0 });
      // …and the run on its eve (Mon 5 Oct; 6 Oct is a Tuesday) alerts it.
      expect(await runPipelineDueTick({ now: ist("2026-10-05", "10:00") })).toMatchObject({ dueSoon: 1 });
      expect((await ofKind("due_soon")).map((r) => r.id).sort()).toEqual(
        [plnId("due_soon", a.p.id, a.owner.id, "2026-10-06"), plnId("due_soon", a.p.id, a.bob.id, "2026-10-06")].sort(),
      );
    });

    it("an overdue row goes when the date is extended or removed (B1)", async () => {
      const a = await project("2026-09-26");
      await runPipelineDueTick({ now: ist("2026-09-28", "10:00") });
      expect(await ofKind("overdue")).toHaveLength(2);
      expect((await patchDue(a.owner.id, a.p.id, "2026-09-26", "2026-10-10")).status).toBe(200);
      expect(await ofKind("overdue")).toHaveLength(0);

      const b = await project("2026-09-26");
      await runPipelineDueTick({ now: ist("2026-09-28", "11:00") });
      expect(await ofKind("overdue")).toHaveLength(2);
      expect((await patchDue(b.owner.id, b.p.id, "2026-09-26", null)).status).toBe(200);
      expect(await ofKind("overdue")).toHaveLength(0);
    });

    it("A → B → A re-arms A's alert: the markers went with the rows", async () => {
      const a = await project("2026-09-30");
      await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
      expect((await patchDue(a.owner.id, a.p.id, "2026-09-30", "2026-10-09")).status).toBe(200);
      expect((await patchDue(a.owner.id, a.p.id, "2026-10-09", "2026-09-30")).status).toBe(200);
      expect(await ofKind("due_soon")).toHaveLength(0);
      expect(await runPipelineDueTick({ now: ist("2026-09-29", "11:00") })).toMatchObject({ dueSoon: 1 });
      expect((await ofKind("due_soon")).filter((r) => r.userId === a.bob.id).map((r) => r.id)).toEqual([
        plnId("due_soon", a.p.id, a.bob.id, "2026-09-30"),
      ]);
    });

    it("moving to Done withdraws the current date's rows; moving back out re-arms them (D2)", async () => {
      const a = await project("2026-09-28"); // in Review
      await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
      expect(await ofKind("overdue")).toHaveLength(2);
      const [review, done] = [await phaseIdOf("review"), await phaseIdOf("done")];
      expect((await move(a.owner.id, a.p.id, done, review)).status).toBe(200);
      expect(await ofKind("overdue")).toHaveLength(0);
      expect(await markers(a.p.id)).toEqual({ dueSoon: null, overdue: null });
      expect(await runPipelineDueTick({ now: ist("2026-09-29", "11:00") })).toMatchObject({ overdue: 0 }); // Done: no alerts
      expect((await move(a.owner.id, a.p.id, review, done)).status).toBe(200);
      expect(await runPipelineDueTick({ now: ist("2026-09-29", "12:00") })).toMatchObject({ overdue: 1 });
      expect(await ofKind("overdue")).toHaveLength(2);
    });

    it("a leaver's due rows go with them: no later withdrawal can reach someone who is no longer a participant", async () => {
      // withdrawDueRows (a due change, a move into Done) reaches CURRENT participants only, so
      // a row left behind would keep a deadline that no longer exists for up to 90 days.
      const left = await project("2026-09-28"); // overdue; Bob leaves on his own
      const removed = await project("2026-09-30", { title: "Year-end recap" }); // due soon; the owner removes Bob
      await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
      expect(await ofKind("overdue")).toHaveLength(2);
      expect(await ofKind("due_soon")).toHaveLength(2);
      const remove = (uid: string, pid: string, target: string) =>
        request(app).delete(`/v1/pipeline/projects/${pid}/members/${target}`).set(auth(uid));
      expect((await remove(left.bob.id, left.p.id, left.bob.id)).status).toBe(200);
      expect((await remove(removed.owner.id, removed.p.id, removed.bob.id)).status).toBe(200);
      expect((await ofKind("overdue")).map((r) => r.userId)).toEqual([left.owner.id]);
      expect((await ofKind("due_soon")).map((r) => r.userId)).toEqual([removed.owner.id]);
    });

    it("a move between live phases, or a same-phase reorder, leaves the due rows alone", async () => {
      const a = await project("2026-09-28", { phaseKey: "planning" });
      await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
      const [planning, review] = [await phaseIdOf("planning"), await phaseIdOf("review")];
      expect((await move(a.owner.id, a.p.id, review, planning)).status).toBe(200);
      const kept = await ofKind("overdue");
      expect(kept).toHaveLength(2);
      // …and their titles are still true: they never claimed the card was "still in Planning".
      for (const r of kept) expect(r.title).toBe("“Diwali campaign” is overdue — was due Mon 28 Sep");
      expect((await markers(a.p.id)).overdue?.toISOString().slice(0, 10)).toBe("2026-09-28");
    });
  });

  it("the overlap flag is claimed before the first await", async () => {
    await project("2026-09-30");
    const first = runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
    const second = await runPipelineDueTick({ now: ist("2026-09-29", "10:00") });
    expect(second).toEqual({ status: "skipped", reason: "running" });
    expect(await first).toMatchObject({ status: "ran", dueSoon: 1 });
  });
});
