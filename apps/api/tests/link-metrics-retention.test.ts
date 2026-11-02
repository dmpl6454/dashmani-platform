/**
 * link_metrics retention: snapshots older than the keep window go, except each link's newest
 * row and newest ok row, and orphans. The block-cursor walk must cover the whole table.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import {
  LINK_METRICS_RETENTION_CURSOR_KEY,
  LINK_METRICS_RETENTION_MARKER_KEY,
  pruneLinkMetrics,
  runLinkMetricsRetentionIfDue,
} from "../src/services/link-metrics-retention.service";
import { findLatestSnapshotsByLinkIds } from "../src/services/link-metrics-latest.service";
import { API_USAGE_ROLLUP_KEEP_DAYS } from "../src/services/api-usage-rollup.service";

const NOW = new Date("2026-11-01T23:10:00.000Z"); // 04:40 IST on 2 Nov
const DAY_MS = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY_MS);

async function seedLinks(n: number) {
  const role =
    (await prisma.role.findFirst({ where: { name: "Employee" } })) ??
    (await prisma.role.create({ data: { name: "Employee", description: "test" } }));
  const emp = await prisma.user.create({
    data: { name: "ZZ Ret", email: `zztest-lmr-${Date.now()}@example.com`, passwordHash: "x", status: "ACTIVE", roles: { create: [{ roleId: role.id }] } },
  });
  const platform = await prisma.platform.create({ data: { name: `ZZTEST_LMR_${Date.now()}`, slug: `zztest-lmr-${Date.now()}` } });
  const acct = await prisma.socialAccount.create({ data: { handle: "zztest-lmr", displayName: "ZZ", platformId: platform.id } });
  const report = await prisma.dailyReport.create({
    data: {
      employeeId: emp.id,
      date: new Date("2026-07-01T00:00:00Z"),
      links: { create: Array.from({ length: n }, (_, i) => ({ accountId: acct.id, url: `https://zz.test/r${i}`, platform: "instagram" })) },
    },
    include: { links: true },
  });
  const mk = (linkId: string | null, status: string, at: Date, views: number | null = 1) =>
    prisma.linkMetric.create({
      data: { linkId, employeeId: emp.id, reportDate: report.date, url: "https://zz.test/x", urlNormalized: "https://zz.test/x", platform: "instagram", status, views, fetchedAt: at },
    });
  return { links: report.links, mk };
}

const idsOf = async () => (await prisma.linkMetric.findMany({ select: { id: true } })).map((r) => r.id).sort();

describe("link_metrics retention", () => {
  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: { in: [LINK_METRICS_RETENTION_MARKER_KEY, LINK_METRICS_RETENTION_CURSOR_KEY] } } });
  });

  it("deletes old history but keeps each link's newest row, newest ok row, recent rows and orphans", async () => {
    const { links, mk } = await seedLinks(3);
    const [a, b, c] = links;
    // link a: three old oks + one recent ok → only the recent one and nothing old survives
    const aOld1 = await mk(a.id, "ok", daysAgo(120));
    const aOld2 = await mk(a.id, "ok", daysAgo(100));
    const aOld3 = await mk(a.id, "error", daysAgo(90));
    const aNew = await mk(a.id, "ok", daysAgo(5));
    // link b: old ok, then old errors only → the newest error AND the last ok survive
    const bOk = await mk(b.id, "ok", daysAgo(150));
    const bErr1 = await mk(b.id, "not_found", daysAgo(140));
    const bErr2 = await mk(b.id, "not_found", daysAgo(130));
    // link c: a single old row → it is the newest, so it stays
    const cOnly = await mk(c.id, "ok", daysAgo(200));
    // orphans are never touched
    const orphanOld = await mk(null, "ok", daysAgo(200));
    const orphanOld2 = await mk(null, "ok", daysAgo(190));

    const r = await pruneLinkMetrics({ now: NOW, pauseMs: 0 });
    expect(r.deleted).toBe(4);
    expect(r.nextBlock).toBe(0);
    expect(await idsOf()).toEqual([aNew.id, bOk.id, bErr2.id, cOnly.id, orphanOld.id, orphanOld2.id].sort());
    void [aOld1, aOld2, aOld3, bErr1];

    // The cron's dedupe lookup still sees the same newest row per link.
    const latest = await findLatestSnapshotsByLinkIds([a.id, b.id, c.id]);
    expect(latest.get(a.id)?.fetchedAt.getTime()).toBe(aNew.fetchedAt.getTime());
    expect(latest.get(b.id)?.status).toBe("not_found");
    expect(latest.get(c.id)?.fetchedAt.getTime()).toBe(cOnly.fetchedAt.getTime());

    // A second sweep is a no-op.
    expect((await pruneLinkMetrics({ now: NOW, pauseMs: 0 })).deleted).toBe(0);
  });

  it("walks every block in small batches and resumes from a saved cursor", async () => {
    const { links, mk } = await seedLinks(40);
    // 40 links × 6 old rows + 1 new = 280 rows — spread over several 8 KB blocks
    for (const l of links) {
      for (let d = 0; d < 6; d++) await mk(l.id, "ok", daysAgo(100 + d), d);
      await mk(l.id, "ok", daysAgo(1));
    }
    const full = await pruneLinkMetrics({ now: NOW, blocksPerBatch: 1, pauseMs: 0, budgetMs: 0 });
    // budgetMs 0 → exactly one batch (block 0), then the cursor stops there
    expect(full.batches).toBe(1);
    expect(full.totalBlocks).toBeGreaterThan(1);
    expect(full.nextBlock).toBe(1);

    const rest = await pruneLinkMetrics({ now: NOW, blocksPerBatch: 1, pauseMs: 0, fromBlock: full.nextBlock });
    expect(rest.nextBlock).toBe(0);
    expect(full.deleted + rest.deleted).toBe(40 * 6);
    expect(await prisma.linkMetric.count()).toBe(40);
  });

  it("runs once per IST day inside the quiet window, keeps the cursor, and honours the kill switch", async () => {
    const { links, mk } = await seedLinks(1);
    await mk(links[0].id, "ok", daysAgo(100));
    await mk(links[0].id, "ok", daysAgo(1));

    const noon = new Date("2026-11-02T06:30:00.000Z"); // 12:00 IST
    expect(await runLinkMetricsRetentionIfDue({ now: noon })).toEqual({ status: "skipped", reason: "hours" });

    process.env.LINK_METRICS_RETENTION_ENABLED = "0";
    try {
      expect(await runLinkMetricsRetentionIfDue({ now: NOW })).toEqual({ status: "skipped", reason: "disabled" });
    } finally {
      delete process.env.LINK_METRICS_RETENTION_ENABLED;
    }

    const first = await runLinkMetricsRetentionIfDue({ now: NOW, pauseMs: 0 });
    expect(first.status).toBe("ran");
    expect(first.status === "ran" && first.deleted).toBe(1);
    expect((await prisma.systemSetting.findUnique({ where: { key: LINK_METRICS_RETENTION_CURSOR_KEY } }))?.value).toBe("0");
    expect(await runLinkMetricsRetentionIfDue({ now: NOW, pauseMs: 0 })).toEqual({ status: "skipped", reason: "done" });
  });
});

/** scripts/link-metrics-catchup.sql's own statements, run in one transaction (its temp table is
 *  per-session) over the whole table instead of psql's \gexec batches. */
async function runCatchupSql() {
  const sql = readFileSync(join(__dirname, "../../../scripts/link-metrics-catchup.sql"), "utf8");
  const createMarks = sql.match(/CREATE TEMP TABLE lm_marks AS[\s\S]*?;/)![0].replace("CREATE TEMP TABLE", "CREATE TEMP TABLE IF NOT EXISTS");
  const del = sql.match(/\$q\$([\s\S]*?)\$q\$/)![1].replace("'(%s,0)'", "'(0,0)'").replace("'(%s,0)'", "'(1000000,0)'");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("DROP TABLE IF EXISTS lm_marks");
    await tx.$executeRawUnsafe(createMarks);
    await tx.$executeRawUnsafe(del);
    await tx.$executeRawUnsafe("DROP TABLE lm_marks");
  });
}

describe("link_metrics catch-up SQL", () => {
  it("deletes exactly what the nightly sweep deletes", async () => {
    const { links, mk } = await seedLinks(3);
    const [a, b, c] = links;
    const rel = (d: number) => new Date(Date.now() - d * DAY_MS); // the SQL uses now()
    for (const [l, st, d] of [
      [a, "ok", 120], [a, "ok", 100], [a, "error", 90], [a, "ok", 5],
      [b, "ok", 150], [b, "not_found", 140], [b, "not_found", 130],
      [c, "ok", 200],
    ] as const) await mk(l.id, st, rel(d));
    await mk(null, "ok", rel(200));

    await runCatchupSql();
    const left = await prisma.linkMetric.findMany({ select: { linkId: true, status: true, fetchedAt: true }, orderBy: { fetchedAt: "asc" } });
    const days = (t: Date) => Math.round((Date.now() - t.getTime()) / DAY_MS);
    expect(left.map((r) => [r.linkId === a.id ? "a" : r.linkId === b.id ? "b" : r.linkId === c.id ? "c" : "orphan", r.status, days(r.fetchedAt)])).toEqual([
      ["c", "ok", 200],
      ["orphan", "ok", 200],
      ["b", "ok", 150],
      ["b", "not_found", 130],
      ["a", "ok", 5],
    ]);
    // …and the nightly sweep finds nothing more to do.
    expect((await pruneLinkMetrics({ pauseMs: 0 })).deleted).toBe(0);
  });
});

describe("api_usage rollup window", () => {
  it("keeps more raw days than the Cost Sheet's 3-day steady-state edge", () => {
    expect(API_USAGE_ROLLUP_KEEP_DAYS).toBeGreaterThan(3);
    expect(API_USAGE_ROLLUP_KEEP_DAYS).toBeLessThanOrEqual(30);
  });
});
