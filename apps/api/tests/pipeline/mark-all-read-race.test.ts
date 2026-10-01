/**
 * pipeline/mark-all-read-race.test.ts — "Mark all read" against a pipeline write that holds
 * several of the same user's notification rows (review finding: concurrency F1).
 *
 * A due-date change (D1/D4) or a move into Done (D2) writes SEVERAL of each participant's
 * rows, in separate statements, on the pipeline pool. The main pool's markAllAsRead marks
 * every unread row of one user read in ONE statement, in heap order. In a rare overlap the
 * two form a two-party lock cycle, and Postgres's deadlock check kills the side that waited
 * first. The pipeline side retries (retryOnce); markAllAsRead must too — otherwise the bell
 * click comes back 500 "An unexpected error occurred" and the badge stays.
 *
 * The cycle is built deterministically: the pipeline transaction holds row B, mark-all-read
 * locks A and waits for B, then the pipeline transaction asks for A. Mark-all-read waited
 * first, so it is the deadlock victim (its 1 s deadlock_timeout expires before the pipeline
 * side's 1 s lock_timeout does).
 */
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@dashmani/db";
import { pipelineDb } from "../../src/services/pipeline/db";
import { markAllAsRead } from "../../src/services/notification.service";
import { createPipelineUser } from "./pipeline-helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("markAllAsRead vs a pipeline write holding several of the user's rows", () => {
  afterAll(async () => {
    await pipelineDb.$disconnect();
  });

  it("survives a lock cycle: it is the deadlock loser, retries once, and every row ends read", async () => {
    const bob = await createPipelineUser({ name: "Bob Bell", tag: "mark-all-race" });
    // A first, so it precedes B in the heap: mark-all-read locks A, then waits for B.
    const a = await prisma.notification.create({ data: { userId: bob.id, type: "PIPELINE", title: "A", message: "m", read: false } });
    const b = await prisma.notification.create({ data: { userId: bob.id, type: "PIPELINE", title: "B", message: "m", read: false } });

    let startMarking!: () => void;
    const bLocked = new Promise<void>((r) => (startMarking = r));
    const marking = bLocked.then(() => markAllAsRead(bob.id));
    // Settle it early so a rejection is never reported as unhandled while the pipeline side runs.
    const outcome = marking.then(
      (v) => ({ ok: true as const, v }),
      (err: unknown) => ({ ok: false as const, err }),
    );

    await pipelineDb.$transaction(
      async (t) => {
        await t.$executeRaw`UPDATE notifications SET message = 'held' WHERE id = ${b.id}`; // holds B
        startMarking();
        // Wait until mark-all-read is blocked on B (it already holds A).
        for (let i = 0; i < 100; i++) {
          const [w] = await t.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
          if (w.n > 0) break;
          await sleep(20);
        }
        await sleep(250); // the pipeline side waits LATER, so mark-all-read's deadlock check fires first
        await t.$executeRaw`UPDATE notifications SET message = 'held' WHERE id = ${a.id}`; // closes the cycle
      },
      { timeout: 8000, maxWait: 5000 },
    );

    const res = await outcome;
    if (!res.ok) throw res.err; // without the retry: the deadlock error a 500 would carry
    expect(res.v.count).toBe(2);
    expect(await prisma.notification.count({ where: { userId: bob.id, read: false } })).toBe(0);
  });
});
