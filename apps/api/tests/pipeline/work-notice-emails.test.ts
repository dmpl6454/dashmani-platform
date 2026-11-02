/**
 * pipeline/work-notice-emails.test.ts — EMAIL for the work notices (2026-11-02): a page
 * assigned to you, a page you created or were assigned going live, a shoot assigned to you.
 *
 * The rules locked here:
 *   - each is queued in the action's transaction, exactly like the bell row, and only when
 *     pipeline email is on; the actor is never mailed;
 *   - the worker re-checks at send time: a page reassigned, done or deleted, a page no longer
 *     published, a shoot reassigned / finished / cancelled — skipped, never mailed;
 *   - a shoot with no project is still mailed (its outbox row has a NULL project);
 *   - several pages assigned in a short while fold into one email;
 *   - every link opens the Work tab (or the shoot desk), built from HR_APP_URL.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import request from "supertest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { setPipelineMailer, type PipelineMail } from "../../src/services/pipeline/email-mailer";
import { runPipelineEmailTick, resetPipelineEmailWorkerForTests } from "../../src/cron/pipeline-email.cron";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases, ensurePipelineEmailSchema } from "./pipeline-helpers";

const P = "/v1/pipeline/projects";
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const sent: PipelineMail[] = [];

async function hrUser(name: string) {
  const u = await createPipelineUser({ name, tag: `wne-${name.toLowerCase().replace(/\W+/g, "-")}` });
  return { ...u, token: hrToken(u.id) };
}
async function newProject(token: string, title: string) {
  const r = await request(app).post(P).set(auth(token)).send({ clientId: randomUUID(), title });
  expect(r.status).toBe(201);
  return r.body.data.card.id as string;
}
const outbox = (where: Record<string, unknown> = {}) =>
  prisma.pipelineEmailOutbox.findMany({ where, orderBy: [{ createdAt: "asc" }] });
const makeDue = () => prisma.$executeRaw`UPDATE pipeline_email_outbox SET send_after = send_after - interval '2 hours' WHERE status = 'pending'`;
const tick = async () => {
  resetPipelineStateForTests();
  return runPipelineEmailTick();
};
const mailTo = (email: string) => sent.filter((m) => m.to === email);

describe("pipeline email — work notices", () => {
  beforeAll(async () => {
    await ensurePipelineEmailSchema();
  });
  beforeEach(async () => {
    resetPipelineStateForTests();
    resetPipelineEmailWorkerForTests();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
    await setPipelineSetting("pipeline.email", "on");
    vi.stubEnv("SMTP_USER", "pipeline-test@example.test");
    vi.stubEnv("SMTP_PASS", "not-a-real-password");
    vi.stubEnv("HR_APP_URL", "https://hr.example.test");
    vi.stubEnv("PIPELINE_EMAIL_DAILY_CAP", "");
    sent.length = 0;
    setPipelineMailer({
      async sendMail(m) {
        sent.push(m);
        return { messageId: `<${randomUUID()}@test>` };
      },
    });
  });
  afterAll(async () => {
    setPipelineMailer(null);
    vi.unstubAllEnvs();
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  it("mails a page assignment, folds several into one email, and skips one taken away before sending", async () => {
    const editor = await hrUser("Meera Editor");
    const asha = await hrUser("Asha Publisher");
    const bilal = await hrUser("Bilal Publisher");
    const id = await newProject(editor.token, "Trailer drop");
    const add = (destination: string, assigneeId: string) =>
      request(app).post(`${P}/${id}/deliverables`).set(auth(editor.token)).send({ platform: "instagram", destination, assigneeId });
    const a1 = (await add("@bollywood", asha.id)).body.data;
    await add("@filmy", asha.id);
    const b1 = (await add("@cinema", bilal.id)).body.data;

    // One pending row per recipient (the second page folded in), nothing for the actor.
    const rows = await outbox({ kind: "assigned" });
    expect(rows.map((r) => r.userId).sort()).toEqual([asha.id, bilal.id].sort());
    expect((rows.find((r) => r.userId === asha.id)!.payload as { refIds: string[] }).refIds).toHaveLength(2);

    // Bilal's page goes back to Asha before anything is sent: Bilal is not mailed.
    await request(app).patch(`/v1/pipeline/deliverables/${b1.id}`).set(auth(editor.token)).send({ base: b1.rev, changes: { assigneeId: asha.id } });
    // Asha's first page is cancelled: only the live assignments are listed.
    await request(app).patch(`/v1/pipeline/deliverables/${a1.id}`).set(auth(editor.token)).send({ base: a1.rev, changes: { status: "cancelled" } });

    await makeDue();
    await tick();
    expect(mailTo(bilal.email)).toEqual([]);
    const [mail] = mailTo(asha.email);
    expect(mail.subject).toBe("Meera Editor assigned you 2 pages in “Trailer drop”");
    expect(mail.text).toContain("Instagram · @filmy");
    expect(mail.text).toContain("Instagram · @cinema");
    expect(mail.text).not.toContain("@bollywood");
    expect(mail.text).toContain(`https://hr.example.test/pipeline/${id}?tab=work`);
    expect(mail.text).toContain("Pipeline work assigned to you");
    expect(mailTo(editor.email)).toEqual([]);
  });

  it("mails the creator when a page goes live, and not if it is taken down before sending", async () => {
    const editor = await hrUser("Kabir Editor");
    const pub = await hrUser("Nisha Publisher");
    const id = await newProject(editor.token, "Diwali reel");
    const d = (await request(app).post(`${P}/${id}/deliverables`).set(auth(editor.token))
      .send({ platform: "facebook", destination: "Bollywood Page", assigneeId: pub.id })).body.data;
    await makeDue();
    await tick(); // Nisha's assignment email
    sent.length = 0;

    const live = await request(app).patch(`/v1/pipeline/deliverables/${d.id}`).set(auth(pub.token))
      .send({ base: d.rev, changes: { status: "published", liveUrl: "https://facebook.com/p/1" } });
    expect(live.status).toBe(200);
    await makeDue();
    await tick();
    const [mail] = mailTo(editor.email);
    expect(mail.subject).toBe("Nisha Publisher published “Diwali reel”");
    expect(mail.text).toContain("Live on Facebook · Bollywood Page");
    expect(mailTo(pub.email)).toEqual([]);

    // Published again later, then unpublished before the email goes: nothing is sent.
    sent.length = 0;
    const back = await request(app).patch(`/v1/pipeline/deliverables/${d.id}`).set(auth(pub.token))
      .send({ base: live.body.data.rev, changes: { status: "ready" } });
    const again = await request(app).patch(`/v1/pipeline/deliverables/${d.id}`).set(auth(pub.token))
      .send({ base: back.body.data.rev, changes: { status: "published", liveUrl: "https://facebook.com/p/1" } });
    await request(app).patch(`/v1/pipeline/deliverables/${d.id}`).set(auth(pub.token))
      .send({ base: again.body.data.rev, changes: { status: "ready" } });
    await makeDue();
    await tick();
    expect(mailTo(editor.email)).toEqual([]);
  });

  it("mails a shoot with no project, and skips a cancelled one", async () => {
    const desk = await hrUser("Desk Lead");
    const cam = await hrUser("Cam One");
    const call = new Date("2026-12-01T11:00:00.000Z");
    const s1 = (await request(app).post("/v1/pipeline/shoots").set(auth(desk.token))
      .send({ title: "Airport arrival", callTime: call.toISOString(), location: "T2 Mumbai", cameraId: cam.id })).body.data;
    const rows = await outbox({ kind: "shoot" });
    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBeNull();

    await makeDue();
    await tick();
    const [mail] = mailTo(cam.email);
    expect(mail.subject).toBe("Desk Lead assigned you a shoot: Airport arrival");
    expect(mail.text).toContain("Call Tue 1 Dec, 4:30 pm IST · T2 Mumbai");
    expect(mail.text).toContain("https://hr.example.test/pipeline/shoots?view=mine");

    // A second shoot, cancelled before the email goes: skipped.
    sent.length = 0;
    const s2 = (await request(app).post("/v1/pipeline/shoots").set(auth(desk.token))
      .send({ title: "Premiere", callTime: call.toISOString(), cameraId: cam.id })).body.data;
    await request(app).patch(`/v1/pipeline/shoots/${s2.id}`).set(auth(desk.token)).send({ base: s2.rev, changes: { status: "cancelled" } });
    await makeDue();
    await tick();
    expect(mailTo(cam.email)).toEqual([]);
    expect(s1.id).not.toBe(s2.id);
  });

  it("queues nothing while pipeline email is off", async () => {
    await setPipelineSetting("pipeline.email", "off");
    resetPipelineStateForTests();
    const editor = await hrUser("Ravi Editor");
    const pub = await hrUser("Sana Publisher");
    const id = await newProject(editor.token, "Holi");
    await request(app).post(`${P}/${id}/deliverables`).set(auth(editor.token)).send({ platform: "instagram", destination: "@x", assigneeId: pub.id });
    expect(await outbox()).toEqual([]);
  });
});

describe("scripts/pipeline-email-work-ddl.sql", () => {
  const sql = fs.readFileSync(path.resolve(__dirname, "../../../../scripts/pipeline-email-work-ddl.sql"), "utf8");
  const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--") && l.trim() !== "").join("\n");
  it("only makes the outbox's project_id nullable, in one bounded transaction", () => {
    expect(statements).toContain("BEGIN;");
    expect(statements).toContain("SET LOCAL lock_timeout = '3s';");
    expect(statements).toContain('ALTER TABLE "pipeline_email_outbox" ALTER COLUMN "project_id" DROP NOT NULL;');
    expect(statements).toContain("COMMIT;");
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(statements).not.toMatch(/\bDROP (TABLE|INDEX|CONSTRAINT|COLUMN)\b/);
  });
});

