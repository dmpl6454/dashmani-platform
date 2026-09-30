/**
 * pipeline/email-worker.test.ts — cron/pipeline-email.cron.ts with an injected mailer
 * (setPipelineMailer): one digest per recipient, what is skipped at send time, retries,
 * the transport breaker, stale-'sending' recovery, the gates, the daily cap, and the rule
 * that no DB transaction or bulkhead slot is held while a message is being sent.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { pipelineGate } from "../../src/services/pipeline/tx";
import { invalidatePipelineSettings } from "../../src/services/pipeline/settings";
import { setPipelineMailer, type PipelineMail } from "../../src/services/pipeline/email-mailer";
import { runPipelineDueTick } from "../../src/cron/pipeline-due.cron";
import {
  runPipelineEmailTick,
  resetPipelineEmailWorkerForTests,
  MAX_ATTEMPTS,
  DAILY_LIMIT_COOLDOWN_MS,
  RECIPIENT_MIN_INTERVAL_MS,
} from "../../src/cron/pipeline-email.cron";
import {
  hrToken,
  setPipelineSetting,
  clearPipelineSettings,
  createPipelineUser,
  seedPipelinePhases,
  ensurePipelineEmailSchema,
} from "./pipeline-helpers";
import { createProjectFixture, addParticipantFixture, phaseIdOf, mention } from "./fixtures-messages";

const auth = (userId: string) => ({ Authorization: `Bearer ${hrToken(userId)}` });
type Json = Record<string, unknown>;

const sent: PipelineMail[] = [];
let failWith: unknown = null;
/** Per-message failure (wins over failWith when it returns something). */
let failFor: ((m: PipelineMail) => unknown) | null = null;
/** Every SMTP attempt, successful or not. */
let attempted = 0;
let duringSend: (() => Promise<void>) | null = null;

/** nodemailer 8 error shapes (smtp-connection _formatError): code, responseCode, command, response. */
const smtpError = (code: string, command: string, response: string) =>
  Object.assign(new Error(`${command === "MAIL FROM" ? "Mail command failed" : "Recipient command failed"}: ${response}`), {
    code,
    command,
    response,
    responseCode: Number(response.slice(0, 3)),
  });

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
    failFor = null;
    attempted = 0;
    duringSend = null;
    setPipelineMailer({
      async sendMail(m) {
        attempted++;
        if (duringSend) await duringSend();
        const f = failFor?.(m) ?? failWith;
        if (f) throw f;
        sent.push(m);
        return { messageId: `<${randomUUID()}@test>` };
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
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
    // Two moved projects + a mention: both reasons, and no "unfollow" promise for the mention.
    expect(toBob.text).toContain("You're receiving this because you follow these projects in the Pipeline. Unfollow a project there to stop its updates.");
    expect(toBob.html).toContain("You were @mentioned in a Pipeline message. Mention emails arrive even if you don&#39;t follow the project.");
    expect(toCara.text).toContain("You're receiving this because you follow this project in the Pipeline. Unfollow it there to stop these updates.");
    expect(toCara.text).not.toContain("@mentioned");
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

  // ── review follow-ups (2026-09-30) ─────────────────────────────────────────────────

  async function bigTeam() {
    const t = await team();
    const dan = await createPipelineUser({ name: "Dan Member", tag: "ew-dan" });
    const eve = await createPipelineUser({ name: "Eve Member", tag: "ew-eve" });
    await addParticipantFixture(t.project.id, dan.id, { role: "MEMBER" });
    await addParticipantFixture(t.project.id, eve.id, { role: "MEMBER" });
    return { ...t, dan, eve };
  }

  it("an ACCOUNT-level refusal (550 5.4.5 at MAIL FROM) trips the breaker: ONE attempt, the rest released unharmed, an hour's pause", async () => {
    const { priya, project } = await bigTeam();
    await move(priya.id, project.id, "planning", "brief"); // Bob, Cara, Dan, Eve
    await makeDue();
    failWith = smtpError("EENVELOPE", "MAIL FROM", "550 5.4.5 Daily user sending limit exceeded. For more information on Gmail sending limits go to …");

    const r = await tick();
    expect(r).toMatchObject({ status: "ran", claimed: 4, emails: 0, failed: 1, released: 3 });
    expect(attempted).toBe(1); // not one per recipient
    let rows = await outbox();
    expect(rows.every((x) => x.status === "pending")).toBe(true);
    expect(rows.map((x) => x.attempts).sort()).toEqual([0, 0, 0, 1]);
    expect(rows.find((x) => x.attempts === 1)!.lastError).toContain("5.4.5");

    // The next ticks do not touch the throttled account — no attempt, no attempts burned.
    await makeDue();
    expect(await tick()).toEqual({ status: "skipped", reason: "smtp_cooldown" });
    expect(await tick({ now: new Date(Date.now() + DAILY_LIMIT_COOLDOWN_MS - 5 * 60_000) })).toEqual({ status: "skipped", reason: "smtp_cooldown" });
    expect(attempted).toBe(1);
    rows = await outbox();
    expect(rows.map((x) => x.attempts).sort()).toEqual([0, 0, 0, 1]);

    failWith = null;
    expect(await tick({ now: new Date(Date.now() + DAILY_LIMIT_COOLDOWN_MS + 60_000) })).toMatchObject({ status: "ran", emails: 4 });
  });

  it("a 421 (\"try again later\") during DATA also pauses sending instead of trying every recipient", async () => {
    const { priya, project } = await bigTeam();
    await move(priya.id, project.id, "planning", "brief");
    await makeDue();
    failWith = Object.assign(new Error("Message failed: 421 4.7.0 Try again later, closing connection."), {
      code: "EMESSAGE",
      command: "DATA",
      response: "421 4.7.0 Try again later, closing connection.",
      responseCode: 421,
    });
    expect(await tick()).toMatchObject({ failed: 1, released: 3 });
    expect(attempted).toBe(1);
    await makeDue();
    expect(await tick()).toEqual({ status: "skipped", reason: "smtp_cooldown" });
  });

  it("a recipient refused for good (550 5.1.1 at RCPT TO) is 'failed' at once — no retries, and no pause for everyone else", async () => {
    const { priya, bob, cara, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await makeDue();
    failFor = (m) =>
      m.to === bob.email
        ? Object.assign(smtpError("EENVELOPE", "RCPT TO", "550 5.1.1 The email account that you tried to reach does not exist."), {
            message: "Can't send mail - all recipients were rejected: 550 5.1.1 The email account that you tried to reach does not exist.",
          })
        : null;
    const r = await tick();
    expect(r).toMatchObject({ status: "ran", emails: 1, failed: 1, released: 0 });
    expect(sent.map((m) => m.to)).toEqual([cara.email]);
    const [b] = await outbox({ userId: bob.id });
    expect(b).toMatchObject({ status: "failed", attempts: 1 });
    expect(b.lastError).toContain("5.1.1");
    // No cooldown: the next tick runs normally.
    await makeDue();
    expect(await tick()).toMatchObject({ status: "ran", claimed: 0 });
  });

  it("a refused state read AFTER the claim puts every claimed row back UNHARMED (no attempt counted); the next tick sends them", async () => {
    const { priya, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await makeDue();
    const orig = pipelineDb.$queryRaw.bind(pipelineDb) as (...a: unknown[]) => Promise<unknown>;
    let failures = 0;
    vi.spyOn(pipelineDb, "$queryRaw").mockImplementation(((q: unknown, ...v: unknown[]) => {
      if (Array.isArray(q) && q.join("?").includes("FROM pipeline_projects p") && failures === 0) {
        failures++;
        return Promise.reject(new Error("canceling statement due to statement timeout"));
      }
      return orig(q, ...v);
    }) as never);

    const r = await tick();
    expect(failures).toBe(1);
    expect(r).toMatchObject({ status: "ran", claimed: 2, emails: 0, failed: 0, released: 2 });
    const rows = await outbox();
    expect(rows.map((x) => [x.status, x.attempts])).toEqual([
      ["pending", 0],
      ["pending", 0],
    ]);
    // Back in about a minute (the release delay), not stranded for the 10-minute recovery.
    for (const x of rows) expect(x.sendAfter.getTime() - x.updatedAt.getTime()).toBe(60_000);

    await makeDue();
    expect(await tick()).toMatchObject({ status: "ran", emails: 2 });
    expect((await outbox()).map((x) => [x.status, x.attempts])).toEqual([
      ["sent", 0],
      ["sent", 0],
    ]);
  });

  it("a refused 'mark sent' after a DELIVERED email is retried — even across ticks and the 10-minute recovery — and never re-sends it", async () => {
    const { priya, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await makeDue();
    const orig = pipelineDb.$executeRaw.bind(pipelineDb) as (...a: unknown[]) => Promise<unknown>;
    let refuse = 3; // every try inside the first tick
    vi.spyOn(pipelineDb, "$executeRaw").mockImplementation(((q: unknown, ...v: unknown[]) => {
      if (Array.isArray(q) && q.join("?").includes("SET status = 'sent'") && refuse > 0) {
        refuse--;
        return Promise.reject(new Error("canceling statement due to statement timeout"));
      }
      return orig(q, ...v);
    }) as never);

    const r = await tick();
    expect(r).toMatchObject({ emails: 2 });
    expect(refuse).toBe(0);
    // The first digest's rows could not be marked yet; age them past the recovery window.
    await prisma.$executeRaw`UPDATE pipeline_email_outbox SET updated_at = updated_at - interval '11 minutes' WHERE status = 'sending'`;
    expect((await outbox({ status: "sending" })).length).toBe(1);

    // The next tick writes the held "sent" first, so the recovery never sees the row.
    await makeDue();
    const r2 = await tick();
    expect(r2).toMatchObject({ status: "ran", recovered: 0, emails: 0 });
    expect(sent).toHaveLength(2); // one email each — no duplicate
    expect((await outbox()).every((x) => x.status === "sent")).toBe(true);
  });

  it("one refused 'mark sent' is retried inside the same tick", async () => {
    const { priya, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await makeDue();
    const orig = pipelineDb.$executeRaw.bind(pipelineDb) as (...a: unknown[]) => Promise<unknown>;
    let refuse = 1;
    vi.spyOn(pipelineDb, "$executeRaw").mockImplementation(((q: unknown, ...v: unknown[]) => {
      if (Array.isArray(q) && q.join("?").includes("SET status = 'sent'") && refuse > 0) {
        refuse--;
        return Promise.reject(new Error("canceling statement due to statement timeout"));
      }
      return orig(q, ...v);
    }) as never);
    expect(await tick()).toMatchObject({ emails: 2 });
    expect((await outbox()).every((x) => x.status === "sent")).toBe(true);
  });

  it("switching email off stops a tick that is already sending: the rest go back to pending unharmed", async () => {
    const { priya, project } = await bigTeam();
    await move(priya.id, project.id, "planning", "brief"); // four recipients
    await makeDue();
    duringSend = async () => {
      duringSend = null;
      await setPipelineSetting("pipeline.email", "off");
      invalidatePipelineSettings(); // the 15 s memo has expired
    };
    const r = await tick();
    expect(r).toMatchObject({ status: "ran", claimed: 4, emails: 1, failed: 0, released: 3 });
    expect(sent).toHaveLength(1); // the one already mid-send finished; nothing after it
    const pending = await outbox({ status: "pending" });
    expect(pending).toHaveLength(3);
    expect(pending.every((x) => x.attempts === 0)).toBe(true);
  });

  it(`holds back a recipient emailed in the last ${RECIPIENT_MIN_INTERVAL_MS / 60_000} minutes; their new rows fold into the next digest`, async () => {
    const { priya, bob, cara, project } = await team();
    await post(priya.id, project.id, `first ${mention(bob.id)}`);
    await makeDue();
    expect(await tick()).toMatchObject({ emails: 1 });

    await post(priya.id, project.id, `second ${mention(bob.id)}`);
    await move(priya.id, project.id, "planning", "brief"); // Bob and Cara
    await makeDue();
    expect(await tick()).toMatchObject({ status: "ran", emails: 1 }); // Cara only
    expect(sent.map((m) => m.to)).toEqual([bob.email, cara.email]);
    expect((await outbox({ userId: bob.id, status: "pending" })).map((x) => x.kind).sort()).toEqual(["mention", "moved"]);

    const later = new Date(Date.now() + RECIPIENT_MIN_INTERVAL_MS + 60_000);
    expect(await tick({ now: later })).toMatchObject({ emails: 1 });
    expect(sent[2].to).toBe(bob.email);
    expect(sent[2].subject).toBe("Pipeline: 2 updates");
  });

  it("in production, an unset HR_APP_URL keeps email off (no localhost links in real inboxes)", async () => {
    const { priya, project } = await team();
    await move(priya.id, project.id, "planning", "brief");
    await makeDue();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HR_APP_URL", "");
    try {
      expect(await tick()).toEqual({ status: "skipped", reason: "config" });
      expect(sent).toHaveLength(0);
      vi.stubEnv("HR_APP_URL", "https://hr.example.test");
      expect(await tick()).toMatchObject({ status: "ran", emails: 2 });
    } finally {
      vi.stubEnv("NODE_ENV", "test");
    }
  });

  it("sends the due-soon email the due cron queued", async () => {
    const { bob, project } = await team();
    await pipelineDb.$executeRaw`UPDATE pipeline_projects SET due_date = DATE '2026-09-30' WHERE id = ${project.id}`;
    const at = new Date("2026-09-29T10:00:00.000+05:30"); // a Tuesday, inside the due window
    expect(await runPipelineDueTick({ now: at })).toMatchObject({ status: "ran", dueSoon: 1 });
    const r = await tick({ now: at });
    expect(r).toMatchObject({ status: "ran", emails: 3 }); // Priya, Bob, Cara — the due cron has no actor
    const toBob = sent.find((m) => m.to === bob.email)!;
    expect(toBob.subject).toBe("“Diwali campaign” is due tomorrow (Wed 30 Sep)");
    expect(toBob.text).toContain("Phase: Brief");
    expect(toBob.html).toContain(`https://hr.example.test/pipeline/${project.id}`);
  });

  it("two stranded 'sending' rows for the SAME email are recovered together: one row, both mentions, one email", async () => {
    const { priya, bob, project } = await team();
    const m1 = await post(priya.id, project.id, `one ${mention(bob.id)}`);
    await prisma.$executeRaw`UPDATE pipeline_email_outbox SET status = 'sending' WHERE user_id = ${bob.id}`;
    const m2 = await post(priya.id, project.id, `two ${mention(bob.id)}`); // a NEW pending row (the old one is 'sending')
    await prisma.$executeRaw`UPDATE pipeline_email_outbox SET status = 'sending', send_after = send_after - interval '1 hour',
      updated_at = timezone('utc', now()) - interval '11 minutes' WHERE user_id = ${bob.id}`;
    const before = await outbox({ userId: bob.id });
    expect(before.map((x) => x.status)).toEqual(["sending", "sending"]);

    const r = await tick();
    expect(r).toMatchObject({ status: "ran", recovered: 2, emails: 1 });
    expect(sent[0].subject).toBe("Priya Owner mentioned you 2 times in “Diwali campaign”");
    const after = await outbox({ userId: bob.id });
    const kept = after.find((x) => x.id === before[0].id)!;
    const dropped = after.find((x) => x.id === before[1].id)!;
    expect(kept).toMatchObject({ status: "sent", attempts: 1 });
    expect((kept.payload as Json).messageIds).toEqual([m1, m2]);
    expect(dropped).toMatchObject({ status: "skipped", lastError: "merged into another row for the same email" });
  });

  it("a row merged into a newer pending row carries its attempts (a failing address does not get a fresh 5)", async () => {
    const { priya, bob, project } = await team();
    await post(priya.id, project.id, `one ${mention(bob.id)}`);
    await prisma.$executeRaw`UPDATE pipeline_email_outbox SET attempts = 3 WHERE user_id = ${bob.id}`;
    await makeDue();
    duringSend = async () => {
      duringSend = null;
      await post(priya.id, project.id, `two ${mention(bob.id)}`);
    };
    failWith = new Error("temporary failure");
    await tick();
    const [pending] = await outbox({ userId: bob.id, status: "pending" });
    expect(pending.attempts).toBe(4);
  });

  it("returning a row never WAITS for a pending sibling an action is writing: that key is left alone and finished next tick", async () => {
    const { priya, bob, project } = await team();
    const m1 = await post(priya.id, project.id, `one ${mention(bob.id)}`);
    await makeDue();
    let m2 = "";
    let release!: () => void;
    let hold: Promise<unknown> = Promise.resolve();
    duringSend = async () => {
      duringSend = null;
      m2 = await post(priya.id, project.id, `two ${mention(bob.id)}`);
      // Another transaction holds the new pending row (as an action's ON CONFLICT would).
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const gate = new Promise<void>((r) => (release = r));
      hold = prisma.$transaction(
        async (txc) => {
          await txc.$queryRaw`SELECT id FROM pipeline_email_outbox WHERE user_id = ${bob.id} AND status = 'pending' FOR UPDATE`;
          locked();
          await gate;
        },
        { timeout: 20_000 },
      );
      await isLocked;
    };
    failWith = new Error("temporary failure");
    const t0 = Date.now();
    const r = await tick();
    expect(Date.now() - t0).toBeLessThan(5_000); // never stuck behind the lock (lock_timeout would be 1 s per try)
    expect(r).toMatchObject({ failed: 1 });
    // Read through the pipeline pool: the main test pool's only connection is the holder.
    const during = await pipelineDb.$queryRaw<Array<{ id: string; status: string; payload: Json }>>`
      SELECT id, status, payload FROM pipeline_email_outbox WHERE user_id = ${bob.id} ORDER BY created_at`;
    expect(during.map((x) => x.status)).toEqual(["sending", "pending"]);
    expect(during[1].payload.messageIds).toEqual([m2]);

    release();
    await hold;
    failWith = null;
    await tick(); // writes the held requeue first
    const rows = await outbox({ userId: bob.id });
    expect(rows.find((x) => x.id === during[0].id)!).toMatchObject({ status: "skipped", lastError: "merged into a newer pending row" });
    const pending = rows.find((x) => x.status === "pending")!;
    expect((pending.payload as Json).messageIds).toEqual([m1, m2]);
    expect(pending.attempts).toBe(1);
  });

  it("defangs links in person-written text; only the Pipeline links stay clickable", async () => {
    const priya = await createPipelineUser({ name: "Priya Owner", tag: "ew-link-p" });
    const bob = await createPipelineUser({ name: "Bob Member", tag: "ew-link-b" });
    const project = await createProjectFixture({ ownerId: priya.id, title: "Pay at pay.evil.io", memberIds: [bob.id] });
    await post(priya.id, project.id, `urgent: https://evil.example/login or www.phish.co ${mention(bob.id)}`);
    await makeDue();
    await tick();
    expect(sent).toHaveLength(1);
    const { html, text, subject } = sent[0];
    for (const part of [html, text, subject]) {
      expect(part).not.toMatch(/https?:\/\/evil|evil\.example|www\.phish|pay\.evil/);
    }
    expect(subject).toContain("“Pay at pay[.]evil[.]io”");
    expect(text).toContain("https[:]//evil[.]example/login or www[.]phish[.]co");
    expect(html).toContain(`href="https://hr.example.test/pipeline/${project.id}?m=`);
    expect(text).toContain(`Open in Pipeline: https://hr.example.test/pipeline/${project.id}?m=`);
  });

  it("a mention-only digest does not promise that unfollowing stops it", async () => {
    const { priya, bob, project } = await team();
    await post(priya.id, project.id, `hi ${mention(bob.id)}`);
    await makeDue();
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("You were @mentioned in a Pipeline message. Mention emails arrive even if you don't follow the project.");
    expect(sent[0].text).not.toContain("Unfollow");
  });
});
