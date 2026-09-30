/**
 * pipeline/email-worker.test.ts — cron/pipeline-email.cron.ts with an injected mailer
 * (setPipelineMailer): one digest per recipient, what is skipped at send time, retries,
 * the transport breaker, stale-'sending' recovery, the gates, the daily cap, and the rule
 * that no DB transaction or bulkhead slot is held while a message is being sent.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { pipelineGate } from "../../src/services/pipeline/tx";
import { setPipelineMailer, type PipelineMail } from "../../src/services/pipeline/email-mailer";
import { runPipelineEmailTick, resetPipelineEmailWorkerForTests, MAX_ATTEMPTS } from "../../src/cron/pipeline-email.cron";
import {
  hrToken,
  setPipelineSetting,
  clearPipelineSettings,
  createPipelineUser,
  seedPipelinePhases,
  ensurePipelineEmailSchema,
} from "./pipeline-helpers";
import { createProjectFixture, phaseIdOf, mention } from "./fixtures-messages";

const auth = (userId: string) => ({ Authorization: `Bearer ${hrToken(userId)}` });
type Json = Record<string, unknown>;

const sent: PipelineMail[] = [];
let failWith: unknown = null;
let duringSend: (() => Promise<void>) | null = null;

const outbox = (where: Record<string, unknown> = {}) =>
  prisma.pipelineEmailOutbox.findMany({ where, orderBy: [{ userId: "asc" }, { createdAt: "asc" }] });
/** Make every pending row due now (the settle delays are minutes long). */
const makeDue = () => prisma.$executeRaw`UPDATE pipeline_email_outbox SET send_after = send_after - interval '2 hours' WHERE status = 'pending'`;

describe("pipeline email — worker", () => {
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
    failWith = null;
    duringSend = null;
    setPipelineMailer({
      async sendMail(m) {
        if (duringSend) await duringSend();
        if (failWith) throw failWith;
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

  const move = async (uid: string, pid: string, toKey: string, fromKey: string) => {
    const r = await request(app)
      .post(`/v1/pipeline/projects/${pid}/move`)
      .set(auth(uid))
      .send({ toPhaseId: await phaseIdOf(toKey), afterId: null, basePhaseId: await phaseIdOf(fromKey) });
    expect(r.status).toBe(200);
  };
  const post = async (uid: string, pid: string, body: string) => {
    const r = await request(app).post(`/v1/pipeline/projects/${pid}/messages`).set(auth(uid)).send({ clientId: randomUUID(), body });
    expect(r.status).toBe(201);
    return r.body.data.message.id as string;
  };
  const patchDue = async (uid: string, pid: string, from: string | null, to: string | null) => {
    const r = await request(app).patch(`/v1/pipeline/projects/${pid}`).set(auth(uid)).send({ changes: { dueDate: to }, base: { dueDate: from } });
    expect(r.status).toBe(200);
  };
  /** The tick, with fresh memos (names of users created in the test, current settings). */
  const tick = async (opts: { now?: Date } = {}) => {
    resetPipelineStateForTests();
    return runPipelineEmailTick(opts);
  };

  async function team(title = "Diwali campaign") {
    const priya = await createPipelineUser({ name: "Priya Owner", tag: "ew-priya" });
    const bob = await createPipelineUser({ name: "Bob Member", tag: "ew-bob" });
    const cara = await createPipelineUser({ name: "Cara Member", tag: "ew-cara" });
    const project = await createProjectFixture({ ownerId: priya.id, title, memberIds: [bob.id, cara.id] });
    return { priya, bob, cara, project };
  }

  it("sends ONE digest per recipient, marks its rows sent with one sent_at, and links every item", async () => {
    const { priya, bob, cara, project } = await team();
    const other = await createProjectFixture({ ownerId: priya.id, title: "Holi shoot", memberIds: [bob.id] });
    const mid = await post(priya.id, project.id, `review this ${mention(bob.id)}`);
    await move(priya.id, project.id, "planning", "brief");
    await move(priya.id, other.id, "review", "brief");
    expect(await outbox({ userId: bob.id })).toHaveLength(3);

    // Nothing is due yet (2–3 minute settle delays).
    expect(await tick()).toMatchObject({ status: "ran", claimed: 0, emails: 0 });
    expect(sent).toHaveLength(0);

    await makeDue();
    const r = await tick();
    expect(r).toMatchObject({ status: "ran", claimed: 4, emails: 2, failed: 0, skippedRows: 0 });
    const toBob = sent.find((m) => m.to === bob.email)!;
    const toCara = sent.find((m) => m.to === cara.email)!;
    expect(sent).toHaveLength(2);
    expect(toBob.from).toBe(`"Digital Sukoon Pipeline" <pipeline-test@example.test>`);
    expect(toBob.subject).toBe("Pipeline: 3 updates");
    expect(toBob.html).toContain(`https://hr.example.test/pipeline/${project.id}?m=${mid}`);
    expect(toBob.html).toContain(`https://hr.example.test/pipeline/${other.id}`);
    expect(toBob.text).toContain("Priya Owner mentioned you in “Diwali campaign”");
    expect(toBob.text).toContain("“review this @Bob Member”");
    expect(toBob.text).toContain("Priya Owner moved “Holi shoot” to Review");
    expect(toBob.text).toContain("From Brief → Planning");
    expect(toBob.html).toContain("You&#39;re receiving this because you&#39;re part of this project. Unfollow it in the Pipeline to stop these emails.");
    expect(toBob.html).not.toMatch(/<img|<script/i);
    expect(toCara.subject).toBe("Priya Owner moved “Diwali campaign” to Planning");

    const bobRows = await outbox({ userId: bob.id });
    expect(bobRows.every((x) => x.status === "sent" && x.sentAt !== null)).toBe(true);
    expect(new Set(bobRows.map((x) => x.sentAt!.getTime())).size).toBe(1);
    // A second tick has nothing to do.
    expect(await tick()).toMatchObject({ status: "ran", claimed: 0, emails: 0 });
  });

  it("skips what no longer applies at send time: a net-zero move, a net-zero due change, a deleted or un-mentioning message", async () => {
    const { priya, bob, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await move(priya.id, project.id, "brief", "planning"); // back where it started
    await patchDue(priya.id, project.id, null, "2026-10-09");
    await patchDue(priya.id, project.id, "2026-10-09", null); // and back
    const m1 = await post(priya.id, project.id, `first ${mention(bob.id)}`);
    const m2 = await post(priya.id, project.id, `second ${mention(bob.id)}`);
    expect((await request(app).delete(`/v1/pipeline/messages/${m1}`).set(auth(priya.id))).status).toBe(200);
    expect((await request(app).patch(`/v1/pipeline/messages/${m2}`).set(auth(priya.id)).send({ body: "second, no tag" })).status).toBe(200);
    await makeDue();

    const r = await tick();
    expect(r).toMatchObject({ status: "ran", emails: 0 });
    expect(sent).toHaveLength(0);
    const reasons = Object.fromEntries((await outbox({ userId: bob.id })).map((x) => [x.kind, [x.status, x.lastError]]));
    expect(reasons).toEqual({
      moved: ["skipped", "net-zero move"],
      due_changed: ["skipped", "net-zero due change"],
      mention: ["skipped", "mention deleted or removed"],
    });
  });

  it("renders a mention from the CURRENT message body, and a real due change", async () => {
    const { priya, bob, project } = await team();
    const mid = await post(priya.id, project.id, `old text ${mention(bob.id)}`);
    expect((await request(app).patch(`/v1/pipeline/messages/${mid}`).set(auth(priya.id)).send({ body: `new text ${mention(bob.id)}` })).status).toBe(200);
    await patchDue(priya.id, project.id, null, "2026-10-03");
    await patchDue(priya.id, project.id, "2026-10-03", "2026-10-05");
    await makeDue();
    await tick();
    expect(sent).toHaveLength(2); // Bob (mention + due change) and Cara (due change)
    const toBob = sent.find((m) => m.to === bob.email)!;
    expect(toBob.subject).toBe("Pipeline: 2 updates");
    expect(toBob.text).toContain("“new text @Bob Member”");
    expect(toBob.text).not.toContain("old text");
    // Coalesced: the FIRST from-date (none) against the current date.
    expect(toBob.text).toContain("Priya Owner set the due date of “Diwali campaign” to Mon 5 Oct");
  });

  it("a send failure is retried with backoff and becomes 'failed' after 5 attempts", async () => {
    const { priya, bob, project } = await team();
    await post(priya.id, project.id, `hi ${mention(bob.id)}`);
    failWith = Object.assign(new Error("550 mailbox unavailable"), { responseCode: 550 });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await makeDue();
      const r = await tick();
      expect(r).toMatchObject({ status: "ran", emails: 0, failed: 1 });
      const [row] = await outbox({ userId: bob.id });
      expect(row.attempts).toBe(attempt);
      if (attempt < MAX_ATTEMPTS) {
        expect(row.status).toBe("pending");
        const wait = row.sendAfter.getTime() - row.updatedAt.getTime();
        expect(wait).toBe(2 * 60_000 * 2 ** (attempt - 1)); // 2, 4, 8, 16 min
      } else {
        expect(row.status).toBe("failed");
      }
      expect(row.lastError).toContain("550 mailbox unavailable");
    }
    await makeDue();
    expect(await tick()).toMatchObject({ claimed: 0 }); // failed rows are never picked up again
  });

  it("a broken transport stops the tick: the failed digest counts an attempt, the rest are released untouched", async () => {
    const { priya, project } = await team();
    await move(priya.id, project.id, "planning", "brief"); // Bob and Cara
    await makeDue();
    failWith = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" });
    const r = await tick();
    expect(r).toMatchObject({ status: "ran", claimed: 2, emails: 0, failed: 1, released: 1 });
    const rows = await outbox();
    expect(rows.map((x) => x.status)).toEqual(["pending", "pending"]);
    expect(rows.map((x) => x.attempts).sort()).toEqual([0, 1]);

    // The SMTP account is shared with every other platform email: no retry hammering.
    failWith = null;
    await makeDue();
    expect(await tick()).toEqual({ status: "skipped", reason: "smtp_cooldown" });
    resetPipelineEmailWorkerForTests(); // the cooldown has passed
    expect(await tick()).toMatchObject({ emails: 2 });
  });

  it("a row returning to pending merges into a NEWER pending row for the same email instead of breaking the unique key", async () => {
    const { priya, bob, project } = await team();
    const m1 = await post(priya.id, project.id, `one ${mention(bob.id)}`);
    await makeDue();
    // While the first mention is being sent, a second one arrives (a new pending row).
    let m2 = "";
    duringSend = async () => {
      duringSend = null;
      m2 = await post(priya.id, project.id, `two ${mention(bob.id)}`);
    };
    failWith = new Error("temporary failure");
    await tick();
    const rows = await outbox({ userId: bob.id, kind: "mention" });
    const pending = rows.filter((x) => x.status === "pending");
    expect(pending).toHaveLength(1);
    expect((pending[0].payload as Json).messageIds).toEqual([m1, m2]);
    expect(rows.find((x) => x.status === "skipped")!.lastError).toBe("merged into a newer pending row");

    failWith = null;
    await makeDue();
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Priya Owner mentioned you 2 times in “Diwali campaign”");
  });

  it("recovers rows stuck in 'sending' for more than 10 minutes (an interrupted send), and leaves fresh ones alone", async () => {
    const { priya, bob, cara, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await prisma.$executeRaw`UPDATE pipeline_email_outbox SET status = 'sending', send_after = send_after - interval '1 hour',
      updated_at = timezone('utc', now()) - interval '11 minutes' WHERE user_id = ${bob.id}`;
    await prisma.$executeRaw`UPDATE pipeline_email_outbox SET status = 'sending', send_after = send_after - interval '1 hour',
      updated_at = timezone('utc', now()) - interval '2 minutes' WHERE user_id = ${cara.id}`;
    const r = await tick();
    expect(r).toMatchObject({ status: "ran", recovered: 1, emails: 1 });
    expect(sent.map((m) => m.to)).toEqual([bob.email]);
    const [b] = await outbox({ userId: bob.id });
    expect(b).toMatchObject({ status: "sent", attempts: 1 });
    const [c] = await outbox({ userId: cara.id });
    expect(c.status).toBe("sending");
  });

  it("is a no-op with pipeline.email off, without SMTP, or with the feature off", async () => {
    const { priya, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await makeDue();
    await setPipelineSetting("pipeline.email", "off");
    expect(await tick()).toEqual({ status: "skipped", reason: "email_off" });
    await setPipelineSetting("pipeline.email", "on");
    vi.stubEnv("SMTP_USER", "");
    expect(await tick()).toEqual({ status: "skipped", reason: "smtp" });
    vi.stubEnv("SMTP_USER", "pipeline-test@example.test");
    await setPipelineSetting("pipeline.mode", "off");
    expect(await tick()).toEqual({ status: "skipped", reason: "off" });
    expect(sent).toHaveLength(0);
    expect((await outbox()).every((x) => x.status === "pending")).toBe(true);
  });

  it("honours the daily cap (counted in emails, per IST day)", async () => {
    vi.stubEnv("PIPELINE_EMAIL_DAILY_CAP", "1");
    const { priya, project } = await team();
    await move(priya.id, project.id, "planning", "brief"); // two recipients
    await makeDue();
    expect(await tick()).toMatchObject({ status: "ran", emails: 1 });
    expect(await tick()).toEqual({ status: "skipped", reason: "cap" });
    expect(sent).toHaveLength(1);
    expect((await outbox({ status: "pending" })).length).toBe(1);
    // The next IST day starts a fresh count (1 s after the next IST midnight — still less
    // than a day after the rows were created, so they are not stale).
    const IST = 330 * 60_000;
    const DAY = 24 * 60 * 60_000;
    const tomorrow = new Date(Date.now() + (DAY - ((Date.now() + IST) % DAY)) + 1000);
    expect(await tick({ now: tomorrow })).toMatchObject({ status: "ran", emails: 1 });
    expect(sent).toHaveLength(2);
  });

  it("holds NO DB transaction and NO bulkhead slot while a message is being sent", async () => {
    const { priya, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await makeDue();
    const tx = vi.spyOn(pipelineDb, "$transaction");
    const seen: Array<{ active: number; inTx: number }> = [];
    duringSend = async () => {
      const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = 'dashmani-pipeline'
           AND state LIKE 'idle in transaction%'`;
      seen.push({ active: pipelineGate.stats().active, inTx: row.n });
    };
    const r = await tick();
    expect(r).toMatchObject({ emails: 2 });
    expect(seen).toEqual([
      { active: 0, inTx: 0 },
      { active: 0, inTx: 0 },
    ]);
    expect(tx).not.toHaveBeenCalled();
    tx.mockRestore();
  });

  it("escapes every name, title and message (no raw HTML from users reaches the email)", async () => {
    const priya = await createPipelineUser({ name: `<b onmouseover="x">Priya</b>`, tag: "ew-xss-p" });
    const bob = await createPipelineUser({ name: "Bob <i>Member</i>", tag: "ew-xss-b" });
    const project = await createProjectFixture({ ownerId: priya.id, title: `<script>alert("t")</script> & co`, memberIds: [bob.id] });
    await post(priya.id, project.id, `<img src=x onerror=alert(1)> "quoted" ${mention(bob.id)}`);
    await makeDue();
    await tick();
    expect(sent).toHaveLength(1);
    const { html, subject, text } = sent[0];
    expect(html).not.toMatch(/<script|<img|<b |<i>|onerror=alert\(1\)>/i);
    expect(html).toContain("&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt; &amp; co");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;");
    expect(html).toContain("Hi Bob,");
    // Subject and text are plain text (a mail client never renders them as HTML).
    expect(subject).toContain(`mentioned you in “<script>alert("t")</script> & co”`);
    expect(text).toContain(`<img src=x onerror=alert(1)>`);
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it("skips a recipient who became inactive or left the pilot before the send", async () => {
    const { priya, bob, cara, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await makeDue();
    await prisma.user.update({ where: { id: cara.id }, data: { status: "INACTIVE" } });
    await setPipelineSetting("pipeline.mode", "pilot");
    await setPipelineSetting("pipeline.pilotUserIds", JSON.stringify([priya.id, bob.id]));
    const r = await tick();
    expect(r).toMatchObject({ emails: 1, skippedRows: 1 });
    expect(sent.map((m) => m.to)).toEqual([bob.email]);
    expect((await outbox({ userId: cara.id }))[0]).toMatchObject({ status: "skipped", lastError: "recipient inactive" });
  });
});
