/**
 * pipeline/dashboard.test.ts — the sales Dashboard's Pipeline section (2026-11-23).
 *
 * The rules locked here:
 *   - only live projects count (archived and deleted ones don't); phases come in board order;
 *   - overdue skips terminal phases and today's due dates; lists are oldest first;
 *   - "waiting on client" = documents Sent with no answer; accepted / draft ones don't count;
 *   - "waiting for review" = pending reviews only;
 *   - "this week" = pages scheduled in the next 7 days (not published / cancelled) and
 *     projects due in the next 7 days, soonest first.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { addDaysIST, todayIST, type PipelineDashboardDto } from "@dashmani/shared";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const B = "/v1/pipeline";
const P = `${B}/projects`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function hrUser(name: string) {
  const u = await createPipelineUser({ name, tag: name.toLowerCase().replace(/\W+/g, "-") });
  return { ...u, token: hrToken(u.id) };
}

async function newProject(token: string, title: string, dueDate?: string) {
  const r = await request(app).post(P).set(auth(token)).send({ clientId: crypto.randomUUID(), title, ...(dueDate ? { dueDate } : {}) });
  expect(r.status).toBe(201);
  return r.body.data.card.id as string;
}

const dashboard = async (token: string) => {
  const r = await request(app).get(`${B}/dashboard`).set(auth(token));
  expect(r.status).toBe(200);
  return r.body.data as PipelineDashboardDto;
};

describe("pipeline dashboard", () => {
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

  it("counts live projects per phase and lists overdue ones, oldest first", async () => {
    const asha = await hrUser("Asha Dash");
    const today = todayIST();
    const late5 = await newProject(asha.token, "Five days late", addDaysIST(today, -5));
    const late1 = await newProject(asha.token, "One day late", addDaysIST(today, -1));
    await newProject(asha.token, "Due today", today);
    const archived = await newProject(asha.token, "Archived late", addDaysIST(today, -9));
    await request(app).post(`${P}/${archived}/archive`).set(auth(asha.token)).send({});
    // A late project in the terminal phase is done, not overdue.
    const done = await newProject(asha.token, "Done late", addDaysIST(today, -3));
    const terminal = await prisma.pipelinePhase.findFirstOrThrow({ where: { isTerminal: true } });
    await prisma.pipelineProject.update({ where: { id: done }, data: { phaseId: terminal.id } });

    const d = await dashboard(asha.token);
    expect(d.today).toBe(today);
    expect(d.phases.map((p) => p.name)).toEqual(["Brief", "Planning", "In Production", "Review", "Approved", "Live", "Done"]);
    expect(d.phases.find((p) => p.name === "Brief")!.count).toBe(3);
    expect(d.phases.find((p) => p.name === "Done")!.count).toBe(1);
    expect(d.counts.active).toBe(3);
    expect(d.counts.overdue).toBe(2);
    expect(d.overdue.map((p) => [p.id, p.days])).toEqual([[late5, 5], [late1, 1]]);
  });

  it("lists documents waiting on the client and pending reviews", async () => {
    const asha = await hrUser("Asha Wait");
    const ravi = await hrUser("Ravi Wait");
    const id = await newProject(asha.token, "Diwali");
    const doc = (body: Record<string, unknown>) => request(app).post(`${P}/${id}/documents`).set(auth(asha.token)).send({ url: "https://example.com/d", ...body });
    await doc({ type: "pitch", title: "Pitch v1", status: "sent" });
    await doc({ type: "quote", title: "Quote", status: "accepted" });
    await doc({ type: "brief", title: "Brief draft" });
    await request(app).post(`${P}/${id}/versions`).set(auth(asha.token)).send({ kind: "video", url: "https://example.com/v" });
    await request(app).post(`${P}/${id}/reviews`).set(auth(asha.token)).send({ reviewerId: ravi.id });

    const d = await dashboard(asha.token);
    expect(d.counts.waitingClient).toBe(1);
    expect(d.waitingClient[0]).toMatchObject({ project: { id, title: "Diwali" }, docType: "Pitch", docTitle: "Pitch v1" });
    expect(d.counts.waitingReview).toBe(1);
    expect(d.waitingReview[0]).toMatchObject({ project: { id }, reviewer: "Ravi Wait" });
  });

  it("shows each project's newest chat message — thread or public channel — never a private channel's", async () => {
    const asha = await hrUser("Asha Chat");
    const ravi = await hrUser("Ravi Chat");
    const post = (conv: string, body: string, token = asha.token) =>
      request(app).post(`${P}/${conv}/messages`).set(auth(token)).send({ clientId: crypto.randomUUID(), body });
    const channel = async (body: Record<string, unknown>) => {
      const r = await request(app).post(`${B}/channels`).set(auth(asha.token)).send({ clientId: crypto.randomUUID(), ...body });
      expect(r.status).toBe(201);
      return (r.body.data.id ?? r.body.data.header.id) as string;
    };
    const a = await newProject(asha.token, "Diwali");
    const b = await newProject(asha.token, "Jio");
    await newProject(asha.token, "Quiet"); // no messages: not listed
    const pub = await channel({ name: "shoot-day", projectId: b });
    const priv = await channel({ name: "client-secret", projectId: a, isPrivate: true });

    expect((await post(a, `@{${ravi.id}} client ne rates approve kar diye`)).status).toBe(201);
    await new Promise((r) => setTimeout(r, 15));
    expect((await post(pub, "Shoot kal 10 baje")).status).toBe(201);
    await new Promise((r) => setTimeout(r, 15));
    expect((await post(priv, "Secret margin 40%")).status).toBe(201); // newer, but private

    const d = await dashboard(asha.token);
    expect(d.latestChats.map((x) => [x.project.title, x.channel, x.text])).toEqual([
      ["Jio", "shoot-day", "Shoot kal 10 baje"],
      ["Diwali", null, "@Ravi Chat client ne rates approve kar diye"],
    ]);
    expect(d.latestChats[1]).toMatchObject({ author: "Asha Chat", conversationId: a, project: { id: a } });
    expect(JSON.stringify(d)).not.toContain("Secret margin");

    // A conversation silent for longer than the window drops off the list.
    await prisma.$executeRaw`UPDATE pipeline_projects SET last_message_at = last_message_at - interval '31 days' WHERE id = ${pub}`;
    expect((await dashboard(asha.token)).latestChats.map((x) => x.project.title)).toEqual(["Diwali"]);
  });

  it("puts this week's pages and due dates in time order, and leaves out done pages and later ones", async () => {
    const asha = await hrUser("Asha Week");
    const today = todayIST();
    const dueSoon = await newProject(asha.token, "Due in 3 days", addDaysIST(today, 3));
    await newProject(asha.token, "Due in 10 days", addDaysIST(today, 10));
    const pid = await newProject(asha.token, "Posting");
    const page = async (destination: string, hours: number) => {
      const r = await request(app).post(`${P}/${pid}/deliverables`).set(auth(asha.token))
        .send({ platform: "instagram", destination, scheduledAt: new Date(Date.now() + hours * 3_600_000).toISOString() });
      expect(r.status).toBe(201);
      return r.body.data;
    };
    await page("@soon", 2);
    await page("@far", 24 * 20);
    const cancelled = await page("@cancelled", 5);
    await request(app).patch(`${B}/deliverables/${cancelled.id}`).set(auth(asha.token)).send({ base: cancelled.rev, changes: { status: "cancelled" } });

    const d = await dashboard(asha.token);
    expect(d.counts.thisWeek).toBe(2);
    expect(d.thisWeek.map((x) => (x.kind === "page" ? x.label : x.project.id))).toEqual(["Instagram · @soon", dueSoon]);
  });
});
