/**
 * pipeline/notify-ids.test.ts — deterministic notification ids and the recipient
 * predicate (spec §7.1–§7.3).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import { pipelineDb, Prisma } from "../../src/services/pipeline/db";
import { plnId, plnIdSql, recipientFragment, PLN_KINDS } from "../../src/services/pipeline/notify";
import { dispatchNotification } from "../../src/services/notification.service";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { createPipelineUser } from "./pipeline-helpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("pipeline notification ids", () => {
  beforeEach(() => resetPipelineStateForTests());
  afterAll(async () => {
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  const pid = randomUUID();
  const uid = randomUUID();
  const mid = randomUUID();
  const cases: Array<[(typeof PLN_KINDS)[number], string[]]> = [
    ["messages", [pid, uid]],
    ["mention", [mid, uid]],
    ["reply", [mid]],
    ["added", [pid, uid]],
    ["moved", [pid, uid, "7"]],
    ["due_soon", [pid, uid, "2026-09-27"]],
    ["overdue", [pid, uid, "2026-09-27"]],
  ];

  it("plnId() equals SELECT plnIdSql(...) on the DB for every kind in §7.2", async () => {
    for (const [kind, parts] of cases) {
      const js = plnId(kind, ...parts);
      expect(js).toMatch(UUID_RE);
      const [row] = await pipelineDb.$queryRaw<Array<{ id: string }>>`SELECT ${plnIdSql(kind, ...parts)} AS id`;
      expect(row.id).toBe(js);
    }
  });

  it("SQL parts may be column expressions (date and int columns render like the JS text)", async () => {
    const [row] = await pipelineDb.$queryRaw<Array<{ a: string; b: string }>>`
      SELECT ${plnIdSql("due_soon", pid, uid, Prisma.sql`to_char(DATE '2026-09-27', 'YYYY-MM-DD')`)} AS a,
             ${plnIdSql("moved", pid, uid, Prisma.sql`(7)::int::text`)} AS b`;
    expect(row.a).toBe(plnId("due_soon", pid, uid, "2026-09-27"));
    expect(row.b).toBe(plnId("moved", pid, uid, "7"));
  });

  it("due_soon and overdue ids differ for the same date; different parts differ", () => {
    expect(plnId("due_soon", pid, uid, "2026-09-27")).not.toBe(plnId("overdue", pid, uid, "2026-09-27"));
    expect(plnId("messages", pid, uid)).not.toBe(plnId("added", pid, uid));
    expect(plnId("moved", pid, uid, "1")).not.toBe(plnId("moved", pid, uid, "2"));
  });

  it("a stray dispatchNotification({type: PIPELINE}) writes 0 rows", async () => {
    const u = await createPipelineUser({ name: "Stray", tag: "stray", roleNames: ["Admin"] });
    await dispatchNotification({ type: "PIPELINE", title: "x", message: "y", recipientUserId: u.id });
    expect(await prisma.notification.count({ where: { type: "PIPELINE" } })).toBe(0);
  });

  describe("recipient fragment (§7.3)", () => {
    it("keeps ACTIVE, undeleted, non-actor users, and applies the pilot allowlist", async () => {
      const actor = await createPipelineUser({ name: "Actor", tag: "rf-actor" });
      const a = await createPipelineUser({ name: "Active", tag: "rf-a" });
      const inactive = await createPipelineUser({ name: "Inactive", tag: "rf-i", status: "INACTIVE" });
      const gone = await createPipelineUser({ name: "Gone", tag: "rf-d", deleted: true });
      const b = await createPipelineUser({ name: "Other", tag: "rf-b" });
      const ids = [actor.id, a.id, inactive.id, gone.id, b.id];
      const pick = async (actorId: string | null, allow: string[] | null) => {
        const rows = await pipelineDb.$queryRaw<Array<{ id: string }>>`
          SELECT u.id FROM users u
           WHERE u.id = ANY(${ids}::text[]) AND ${recipientFragment(Prisma.sql`u.id`, actorId, allow)}
           ORDER BY u.id`;
        return rows.map((r) => r.id).sort();
      };
      expect(await pick(actor.id, null)).toEqual([a.id, b.id].sort());
      expect(await pick(null, null)).toEqual([actor.id, a.id, b.id].sort());
      expect(await pick(actor.id, [a.id, inactive.id])).toEqual([a.id]);
      expect(await pick(actor.id, [])).toEqual([]);
    });
  });
});
