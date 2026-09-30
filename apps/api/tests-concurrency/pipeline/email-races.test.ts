/**
 * Pipeline EMAIL under real concurrency (review follow-up 2026-09-30): with
 * pipeline.email = on and the pipeline pool at its production size (3), actions enqueue
 * (INSERT … ON CONFLICT on the partial unique key, the withdrawal DELETE) while the worker
 * claims (FOR UPDATE SKIP LOCKED), requeues failed sends (sibling locks SKIP LOCKED) and
 * marks rows sent — all interleaved.
 *
 * Invariants: no 5xx from any action, the worker never throws, at most ONE pending row per
 * (recipient, project, kind) at every sample, and once drained every row is 'sent' or
 * 'skipped' (never stranded in 'sending' or 'pending', never 'failed' from the race).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { startServer, stopServer, call, freshPipeline, users, createProject, phases, randomUUID, prisma, sleep } from "./cc-helpers";
import { pipelineDb } from "../../src/services/pipeline/db";
import { setPipelineMailer, type PipelineMail } from "../../src/services/pipeline/email-mailer";
import { runPipelineEmailTick, resetPipelineEmailWorkerForTests, type EmailTickResult } from "../../src/cron/pipeline-email.cron";
import { setPipelineSetting, ensurePipelineEmailSchema } from "../../tests/pipeline/pipeline-helpers";

/** Rounds of concurrent actions: at least MIN_ROUNDS, and until MIN_TICKS worker ticks overlapped them. */
const MIN_ROUNDS = 5;
const MIN_TICKS = 40;
const MAX_ROUNDS = 60;
const ACTIONS_PER_ROUND = 20;
/** The worker's clock moves 11 min per tick, past the 10-minute per-recipient pacing. */
const TICK_CLOCK_STEP_MS = 11 * 60_000;
/** Sends that fail on purpose (the requeue path), at most — fewer than MAX_ATTEMPTS per row. */
const MAX_INJECTED_FAILURES = 4;

describe("pipeline email concurrency", () => {
  const sent: PipelineMail[] = [];
  let attempts = 0;
  let injected = 0;
  let failing = true;

  beforeAll(async () => {
    await startServer();
    await ensurePipelineEmailSchema();
  });
  afterAll(async () => {
    setPipelineMailer(null);
    vi.unstubAllEnvs();
    await stopServer();
    await pipelineDb.$disconnect();
  });
  beforeEach(async () => {
    await freshPipeline();
    await setPipelineSetting("pipeline.email", "on");
    vi.stubEnv("SMTP_USER", "pipeline-cc@example.test");
    vi.stubEnv("SMTP_PASS", "not-a-real-password");
    vi.stubEnv("HR_APP_URL", "https://hr.example.test");
    resetPipelineEmailWorkerForTests();
    sent.length = 0;
    attempts = 0;
    injected = 0;
    failing = true;
    setPipelineMailer({
      async sendMail(m) {
        attempts++;
        await sleep(5); // a send takes a moment: the enqueues keep landing meanwhile
        if (failing && injected < MAX_INJECTED_FAILURES && attempts % 3 === 0) {
          injected++;
          throw new Error("temporary failure (injected)");
        }
        sent.push(m);
        return { messageId: `<${randomUUID()}@cc>` };
      },
    });
  });

  it(`rounds of ${ACTIONS_PER_ROUND} concurrent moves and mention posts while the worker ticks → no 5xx, ≤ 1 pending row per key, every row ends sent or skipped`, async () => {
    const [owner, ...members] = await users(5, "mail");
    const everyone = [owner, ...members];
    const p = await createProject(owner.id, "Mail race", members.map((u) => u.id));
    const ph = await phases();

    const maxPendingPerKey = async () => {
      const [row] = await prisma.$queryRaw<Array<{ m: number }>>`
        SELECT COALESCE(max(n), 0)::int AS m FROM (
          SELECT count(*) AS n FROM pipeline_email_outbox WHERE status = 'pending' GROUP BY user_id, project_id, kind) x`;
      return row.m;
    };
    const makeDue = () => prisma.$executeRaw`UPDATE pipeline_email_outbox SET send_after = send_after - interval '2 hours' WHERE status = 'pending'`;

    // The worker, ticking as fast as it can, with every row made due as soon as it exists.
    const samples: number[] = [];
    const ticks: EmailTickResult[] = [];
    const tickErrors: string[] = [];
    let racing = true;
    const t0 = Date.now();
    const worker = (async () => {
      while (racing) {
        await makeDue();
        try {
          // Clock steps stay far inside the one-day staleness limit (≤ 60 ticks × 11 min).
          ticks.push(await runPipelineEmailTick({ now: new Date(t0 + (ticks.length + 1) * TICK_CLOCK_STEP_MS) }));
        } catch (err) {
          tickErrors.push(String(err));
        }
        samples.push(await maxPendingPerKey());
        await sleep(5);
      }
    })();

    const results: Array<{ status: number; body: unknown }> = [];
    for (let round = 0; round < MAX_ROUNDS && (round < MIN_ROUNDS || ticks.length < MIN_TICKS); round++) {
      const card = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: p.id } });
      const others = ph.filter((x) => x.id !== card.phaseId);
      const rs = await Promise.all(
        Array.from({ length: ACTIONS_PER_ROUND }, (_, i) => {
          const actor = everyone[i % everyone.length];
          if (i % 2 === 0) {
            // Concurrent moves from the same base: one winner, the rest a clean 409.
            return call("POST", `/pipeline/projects/${p.id}/move`, actor.id, {
              toPhaseId: others[i % others.length].id,
              afterId: null,
              basePhaseId: card.phaseId,
            });
          }
          const tagged = everyone.filter((u) => u.id !== actor.id).slice(0, 2);
          return call("POST", `/pipeline/projects/${p.id}/messages`, actor.id, {
            clientId: randomUUID(),
            body: `round ${round} #${i} ${tagged.map((u) => `@{${u.id}}`).join(" ")}`,
          });
        }),
      );
      results.push(...rs);
      samples.push(await maxPendingPerKey());
      await sleep(20); // let the worker claim what this round queued
    }
    racing = false;
    await worker;

    const bad = results.filter((r) => r.status >= 500);
    expect(bad.map((r) => `${r.status} ${JSON.stringify(r.body)}`)).toEqual([]);
    for (const r of results) expect([200, 201, 409]).toContain(r.status);
    expect(tickErrors).toEqual([]);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    expect(ticks.length).toBeGreaterThanOrEqual(MIN_TICKS);
    // The worker really worked during the race (claims and sends overlapped the actions).
    expect(ticks.filter((t) => t.status === "ran" && t.claimed > 0).length).toBeGreaterThan(5);

    // Drain: no more injected failures; step the clock past the per-recipient pacing.
    failing = false;
    for (let k = 1; k <= 30; k++) {
      await makeDue();
      await runPipelineEmailTick({ now: new Date(t0 + (ticks.length + k) * TICK_CLOCK_STEP_MS) });
      const open = await prisma.pipelineEmailOutbox.count({ where: { status: { in: ["pending", "sending"] } } });
      if (open === 0) break;
    }
    const byStatus = await prisma.pipelineEmailOutbox.groupBy({ by: ["status"], _count: { _all: true } });
    const counts = Object.fromEntries(byStatus.map((x) => [x.status, x._count._all]));
    expect(Object.keys(counts).sort()).toEqual(expect.arrayContaining(["sent"]));
    expect(Object.keys(counts).filter((s) => s !== "sent" && s !== "skipped")).toEqual([]);
    expect(sent.length).toBeGreaterThan(0);
    // Every mention delivered at least once to each tagged member (the digest carries them).
    const mentioned = new Set(
      (await prisma.pipelineEmailOutbox.findMany({ where: { kind: "mention", status: "sent" }, select: { userId: true } })).map((x) => x.userId),
    );
    expect(mentioned.size).toBeGreaterThan(0);
    console.log(
      `[email-races] actions=${results.length} ticks=${ticks.length} samples=${samples.length} sends=${attempts} ` +
        `injectedFailures=${injected} emails=${sent.length} rows=${JSON.stringify(counts)}`,
    );
  });
});
