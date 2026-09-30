/**
 * Pipeline email worker cost measurement (owner request 2026-09-30).
 *
 *   DATABASE_URL="postgresql://user:password@localhost:5432/dashmani_pipeline_cc?connection_limit=10" \
 *   PIPELINE_DB_CONNECTIONS=3 npx tsx scripts/load/pipeline-email-measure.ts
 *
 * Seeds 2,000 DUE pending outbox rows (200 users × 5 projects × 2 kinds, mention and
 * moved, over real projects, participants and messages) plus HISTORY (default 20,000)
 * 'sent' rows — the steady state is dominated by up to 30 days of sent history, which is
 * what the claim's index has to skip — then runs worker ticks with a MOCK mailer that
 * resolves at once until the backlog drains, and reports per tick: wall time, DB time
 * (the time spent inside the pipeline bulkhead — every worker statement runs in one),
 * statements, rows claimed, emails; plus EXPLAIN (ANALYZE, BUFFERS) of the claim statement
 * (inside a rolled-back transaction) and the event-loop delay p99/max over the ticks
 * (monitorEventLoopDelay, resolution 10 ms, reported as the excess over the resolution,
 * like scripts/load/api-entry.ts). HISTORY=0 measures the 2,000 pending rows alone.
 *
 * ⚠️ It REFUSES any database but a localhost `dashmani_pipeline_cc`, TRUNCATEs its pipeline
 * tables and users first, and removes the `pipeline.*` settings it set when it finishes.
 */
import { monitorEventLoopDelay } from "perf_hooks";
import { randomUUID } from "crypto";

const url = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/dashmani_pipeline_cc") {
  throw new Error("pipeline-email-measure: refusing — DATABASE_URL must be a localhost dashmani_pipeline_cc");
}
process.env.SMTP_USER ||= "measure@example.test";
process.env.SMTP_PASS ||= "not-a-real-password";
process.env.PIPELINE_EMAIL_DAILY_CAP = "100000";

const USERS = 200;
const PROJECTS = 5;
const MAX_TICKS = 30;
const HISTORY = Number.isInteger(Number(process.env.HISTORY)) ? Number(process.env.HISTORY) : 20_000;

async function main() {
  const { prisma } = await import("@dashmani/db");
  const { pipelineDb } = await import("../../apps/api/src/services/pipeline/db");
  const { pipelineGate } = await import("../../apps/api/src/services/pipeline/tx");
  const { setPipelineMailer } = await import("../../apps/api/src/services/pipeline/email-mailer");
  const { invalidatePipelineCaches } = await import("../../apps/api/src/services/pipeline");
  const cron = await import("../../apps/api/src/cron/pipeline-email.cron");

  // ── Seed ──────────────────────────────────────────────────────────────────────────
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE pipeline_email_outbox, pipeline_messages, pipeline_participants, pipeline_projects, pipeline_phases, pipeline_board_state, notifications, users CASCADE`,
  );
  const phaseIds = ["brief", "planning"].map(() => randomUUID());
  await prisma.pipelinePhase.createMany({
    data: [
      { id: phaseIds[0], key: "brief", name: "Brief", position: 1 },
      { id: phaseIds[1], key: "planning", name: "Planning", position: 2 },
    ],
  });
  await prisma.pipelineBoardState.create({ data: { id: 1, seq: 0 } });
  const users = Array.from({ length: USERS }, (_, i) => ({
    id: randomUUID(),
    name: `Measure User ${i}`,
    email: `measure-${i}-${Date.now()}@example.test`,
    passwordHash: "x",
    status: "ACTIVE" as const,
  }));
  await prisma.user.createMany({ data: users });
  const owner = users[0].id;
  const projects = Array.from({ length: PROJECTS }, (_, i) => ({
    id: randomUUID(),
    clientId: randomUUID(),
    title: `Measure project ${i}`,
    ownerId: owner,
    createdById: owner,
    phaseId: phaseIds[1],
    rank: `a${i}`,
  }));
  await prisma.pipelineProject.createMany({ data: projects });
  await prisma.pipelineParticipant.createMany({
    data: projects.flatMap((p) => users.map((u) => ({ projectId: p.id, userId: u.id, role: "MEMBER" }))),
  });
  // One message per project that mentions everyone (the mention rows point at it).
  const messages = projects.map((p) => ({
    id: randomUUID(),
    clientId: randomUUID(),
    projectId: p.id,
    seq: 1,
    rev: 1,
    authorId: owner,
    body: `status update ${users.slice(1, 21).map((u) => `@{${u.id}}`).join(" ")} please check the brief and reply by EOD`,
    mentionIds: users.map((u) => u.id),
  }));
  await prisma.pipelineMessage.createMany({ data: messages });
  const past = new Date(Date.now() - 60_000);
  const rows = projects.flatMap((p, pi) =>
    users.flatMap((u) => [
      { userId: u.id, projectId: p.id, kind: "moved", payload: { fromPhaseId: phaseIds[0], actorIds: [owner] }, sendAfter: past },
      { userId: u.id, projectId: p.id, kind: "mention", payload: { messageIds: [messages[pi].id] }, sendAfter: past },
    ]),
  );
  await prisma.pipelineEmailOutbox.createMany({ data: rows });
  // Sent history (never claimed; the claim must skip it through the index).
  const kinds = ["moved", "mention", "due_soon", "due_changed"];
  for (let off = 0; off < HISTORY; off += 5_000) {
    const n = Math.min(5_000, HISTORY - off);
    await prisma.pipelineEmailOutbox.createMany({
      data: Array.from({ length: n }, (_, i) => {
        const at = new Date(Date.now() - ((off + i) % (29 * 24)) * 3_600_000);
        return {
          userId: users[(off + i) % USERS].id,
          projectId: projects[(off + i) % PROJECTS].id,
          kind: kinds[(off + i) % 4],
          status: "sent",
          sendAfter: at,
          sentAt: at,
          createdAt: at,
        };
      }),
    });
  }
  await prisma.$executeRawUnsafe(`ANALYZE pipeline_email_outbox`);
  for (const [key, value] of [
    ["pipeline.mode", "on"],
    ["pipeline.email", "on"],
  ]) {
    await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  invalidatePipelineCaches();
  console.log(`seeded: ${rows.length} due pending rows + ${HISTORY} sent history rows, ${USERS} users, ${PROJECTS} projects`);

  // ── The claim plan (rolled back) ───────────────────────────────────────────────────
  const plan = await pipelineDb
    .$transaction(async (tx) => {
      const r = await tx.$queryRaw<Array<{ "QUERY PLAN": string }>>(cron.claimStatement(cron.EMAILS_PER_TICK, "EXPLAIN (ANALYZE, BUFFERS)"));
      throw Object.assign(new Error("rollback"), { plan: r.map((x) => x["QUERY PLAN"]) });
    })
    .catch((e: { plan?: string[] }) => e.plan ?? []);
  console.log(`\nEXPLAIN (ANALYZE, BUFFERS) claim, ${rows.length} due pending + ${HISTORY} sent rows:\n` + plan.join("\n"));

  // ── Ticks with a mock mailer ───────────────────────────────────────────────────────
  let sent = 0;
  setPipelineMailer({
    async sendMail() {
      sent++;
      return {};
    },
  });
  const origRun = pipelineGate.run.bind(pipelineGate);
  let dbMs = 0;
  let statements = 0;
  (pipelineGate as { run: typeof pipelineGate.run }).run = async (kind, fn) => {
    return origRun(kind, async () => {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        dbMs += performance.now() - t0;
        statements++;
      }
    });
  };
  const eld = monitorEventLoopDelay({ resolution: 10 });
  // Ticks after the first: the first one also pays process-cold costs (the self-check probe,
  // the directory load, JIT and Intl.Segmenter warm-up) and is reported on its own.
  const warm = monitorEventLoopDelay({ resolution: 10 });
  const excess = (ns: number) => Math.max(0, Math.round((ns / 1e6 - 10) * 100) / 100);
  eld.enable();
  const results = [];
  for (let i = 0; i < MAX_TICKS; i++) {
    dbMs = 0;
    statements = 0;
    const before = sent;
    const t0 = performance.now();
    const r = await cron.runPipelineEmailTick();
    const wall = performance.now() - t0;
    if (i === 0) warm.enable();
    results.push({
      tick: i + 1,
      wallMs: Math.round(wall * 10) / 10,
      dbMs: Math.round(dbMs * 10) / 10,
      statements,
      claimed: r.status === "ran" ? r.claimed : 0,
      emails: sent - before,
      status: r.status,
    });
    if (r.status !== "ran" || r.claimed === 0) break;
  }
  eld.disable();
  warm.disable();
  console.log("\nticks (mock transport):");
  console.table(results);
  const busy = results.filter((r) => r.claimed > 0);
  const sorted = (k: "wallMs" | "dbMs") => busy.map((r) => r[k]).sort((a, b) => a - b);
  const med = (a: number[]) => a[Math.floor(a.length / 2)];
  console.log(
    `busy ticks=${busy.length} wall median=${med(sorted("wallMs"))}ms max=${Math.max(...sorted("wallMs"))}ms · ` +
      `DB median=${med(sorted("dbMs"))}ms max=${Math.max(...sorted("dbMs"))}ms · emails=${sent}`,
  );
  console.log(
    `event-loop delay over ${results.length} ticks (${eld.count} samples): p99=${excess(eld.percentile(99))}ms max=${excess(eld.max)}ms · ` +
      `after the first tick (${warm.count} samples): p99=${excess(warm.percentile(99))}ms max=${excess(warm.max)}ms (excess over the 10 ms resolution)`,
  );
  const left = await prisma.pipelineEmailOutbox.groupBy({ by: ["status"], _count: true });
  console.log("outbox after:", JSON.stringify(left));

  await prisma.systemSetting.deleteMany({ where: { key: { in: ["pipeline.mode", "pipeline.email"] } } });
  setPipelineMailer(null);
  await pipelineDb.$disconnect();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
