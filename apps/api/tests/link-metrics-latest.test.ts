/**
 * link-metrics-latest.test.ts — DB-backed contract of the engagement READ model
 * (2026-09-18). See the LinkMetricLatest model comment in schema.prisma.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import {
  upsertLinkMetricLatest,
  findLatestSnapshotsByLinkIds,
  rehealLinkMetricLatest,
} from "../src/services/link-metrics-latest.service";
import { getMyLinkInsights, invalidateInsightsCache } from "../src/services/social-insights.service";
import { getLeaderboardCoverage, invalidateLeaderboardCache } from "../src/services/leaderboard.service";

const P = "https://zztest-lml.example/";
let dbAvailable = false;

async function cleanup() {
  await prisma.linkMetricLatest.deleteMany({ where: { url: { startsWith: P } } });
  await prisma.linkMetric.deleteMany({ where: { url: { startsWith: P } } });
}

async function ensureEmployeeRole(): Promise<string> {
  const existing = await prisma.role.findFirst({ where: { name: "Employee" } });
  if (existing) return existing.id;
  return (await prisma.role.create({ data: { name: "Employee", description: "test" } })).id;
}
async function seedEmployee(suffix: string) {
  const roleId = await ensureEmployeeRole();
  return prisma.user.create({
    data: { name: `ZZ ${suffix}`, email: `zztest-lml-${suffix}@example.com`, passwordHash: "x", status: "ACTIVE", roles: { create: [{ roleId }] } },
  });
}
async function seedAccount() {
  const platform = await prisma.platform.create({ data: { name: `ZZTEST_LML_${Date.now()}`, slug: `zztest-lml-${Date.now()}` } });
  return prisma.socialAccount.create({ data: { handle: "zztest-lml-acct", displayName: "ZZ Acct", platformId: platform.id } });
}

function latestInput(over: Partial<Parameters<typeof upsertLinkMetricLatest>[0]> & { employeeId: string; url: string }) {
  return {
    employeeId: over.employeeId,
    urlNormalized: over.url,
    linkId: over.linkId ?? null,
    reportDate: over.reportDate ?? new Date("2026-09-10T00:00:00Z"),
    url: over.url,
    platform: over.platform ?? "instagram",
    videoId: over.videoId ?? null,
    fetchedAt: over.fetchedAt ?? new Date("2026-09-18T10:00:00Z"),
    views: over.views ?? null,
    likes: over.likes ?? null,
    comments: over.comments ?? null,
    shares: over.shares ?? null,
  };
}

beforeAll(async () => {
  try { await cleanup(); dbAvailable = true; }
  catch (err) { console.warn("[link-metrics-latest.test] DB unavailable — skipping:", err); dbAvailable = false; }
});
afterAll(async () => { if (dbAvailable) await cleanup(); });
beforeEach(async () => {
  if (!dbAvailable) return;
  await cleanup();
  invalidateInsightsCache();
  invalidateLeaderboardCache();
});

describe("upsertLinkMetricLatest", () => {
  it("inserts, then a NEWER fetchedAt replaces every column; an OLDER write is a no-op", async () => {
    if (!dbAvailable) return;
    const emp = await seedEmployee("a");
    const url = `${P}a1`;
    expect(await upsertLinkMetricLatest(latestInput({ employeeId: emp.id, url, views: 10, likes: 1, fetchedAt: new Date("2026-09-18T10:00:00Z") }))).toBe(true);
    expect(await upsertLinkMetricLatest(latestInput({ employeeId: emp.id, url, views: 20, likes: 2, comments: 3, fetchedAt: new Date("2026-09-18T12:00:00Z") }))).toBe(true);
    // Older than the stored row → ignored (returns false, values untouched).
    expect(await upsertLinkMetricLatest(latestInput({ employeeId: emp.id, url, views: 999, fetchedAt: new Date("2026-09-18T11:00:00Z") }))).toBe(false);
    const rows = await prisma.linkMetricLatest.findMany({ where: { employeeId: emp.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ views: 20, likes: 2, comments: 3, shares: null, platform: "instagram" });
    expect(rows[0].fetchedAt.toISOString()).toBe("2026-09-18T12:00:00.000Z");
    expect(rows[0].reportDate.toISOString().slice(0, 10)).toBe("2026-09-10");
  });

  it("is keyed per (employee, url): the same url under two employees is two rows", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("b1");
    const b = await seedEmployee("b2");
    const url = `${P}shared`;
    await upsertLinkMetricLatest(latestInput({ employeeId: a.id, url, views: 1 }));
    await upsertLinkMetricLatest(latestInput({ employeeId: b.id, url, views: 2 }));
    expect(await prisma.linkMetricLatest.count({ where: { url } })).toBe(2);
  });

  it("carries the link FK with SetNull, and rehealLinkMetricLatest relinks by (employee, report day, platform, url)", async () => {
    if (!dbAvailable) return;
    const emp = await seedEmployee("c");
    const acct = await seedAccount();
    const url = `${P}c1`;
    const day = new Date("2026-09-10T00:00:00Z");
    const report = await prisma.dailyReport.create({
      data: { employeeId: emp.id, date: day, links: { create: [{ accountId: acct.id, url, platform: "instagram" }] } },
      include: { links: true },
    });
    const linkId = report.links[0].id;
    await upsertLinkMetricLatest(latestInput({ employeeId: emp.id, url, linkId, reportDate: day, views: 5 }));
    // Simulate the HR delete-and-recreate resubmit: the old link row goes away.
    await prisma.reportLink.delete({ where: { id: linkId } });
    let row = await prisma.linkMetricLatest.findUniqueOrThrow({ where: { employeeId_urlNormalized: { employeeId: emp.id, urlNormalized: url } } });
    expect(row.linkId).toBeNull(); // SetNull, not a cascade delete — the engagement survives
    // …and the recreated link is re-linked by the cron's re-heal rule.
    const recreated = await prisma.reportLink.create({ data: { reportId: report.id, accountId: acct.id, url, platform: "instagram" } });
    expect(await rehealLinkMetricLatest("instagram")).toBe(1);
    row = await prisma.linkMetricLatest.findUniqueOrThrow({ where: { employeeId_urlNormalized: { employeeId: emp.id, urlNormalized: url } } });
    expect(row.linkId).toBe(recreated.id);
  });
});

describe("findLatestSnapshotsByLinkIds", () => {
  it("returns the NEWEST snapshot (any status) per link id, only for the ids asked; empty input → no query", async () => {
    if (!dbAvailable) return;
    const emp = await seedEmployee("d");
    const acct = await seedAccount();
    const report = await prisma.dailyReport.create({
      data: {
        employeeId: emp.id, date: new Date("2026-09-10T00:00:00Z"),
        links: { create: [{ accountId: acct.id, url: `${P}d1`, platform: "instagram" }, { accountId: acct.id, url: `${P}d2`, platform: "instagram" }] },
      },
      include: { links: true },
    });
    const [l1, l2] = report.links;
    const mk = (linkId: string, url: string, status: string, views: number | null, at: string) =>
      prisma.linkMetric.create({ data: { linkId, employeeId: emp.id, reportDate: report.date, url, urlNormalized: url, platform: "instagram", status, views, fetchedAt: new Date(at) } });
    await mk(l1.id, l1.url!, "ok", 10, "2026-09-18T08:00:00Z");
    await mk(l1.id, l1.url!, "not_found", null, "2026-09-18T10:00:00Z"); // newest for l1
    await mk(l2.id, l2.url!, "ok", 7, "2026-09-18T09:00:00Z");

    const m = await findLatestSnapshotsByLinkIds([l1.id, "does-not-exist"]);
    expect([...m.keys()]).toEqual([l1.id]);
    expect(m.get(l1.id)).toEqual({ status: "not_found", views: null, likes: null, comments: null, shares: null });
    expect((await findLatestSnapshotsByLinkIds([])).size).toBe(0);
  });
});

describe("readers use link_metrics_latest", () => {
  it("getMyLinkInsights: one latest row per url, only within the window, null when the link has no ok snapshot", async () => {
    if (!dbAvailable) return;
    const emp = await seedEmployee("e");
    const acct = await seedAccount();
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const urlA = `${P}e-a`, urlB = `${P}e-b`;
    await prisma.dailyReport.create({
      data: { employeeId: emp.id, date: today, links: { create: [{ accountId: acct.id, url: urlA, platform: "instagram" }, { accountId: acct.id, url: urlB, platform: "instagram" }] } },
    });
    await upsertLinkMetricLatest(latestInput({ employeeId: emp.id, url: urlA, reportDate: today, views: null, likes: 40, comments: 4, fetchedAt: new Date() }));
    // A stale row far outside the 30-day window must not surface.
    await upsertLinkMetricLatest(latestInput({ employeeId: emp.id, url: `${P}e-old`, reportDate: new Date("2020-01-01T00:00:00Z"), likes: 1 }));

    const out = await getMyLinkInsights(emp.id, 30);
    const a = out.find((r) => r.url === urlA)!;
    const b = out.find((r) => r.url === urlB)!;
    expect(a.latest).toMatchObject({ views: null, likes: 40, comments: 4 });
    expect(b.latest).toBeNull();
    expect(out.some((r) => r.url.endsWith("e-old"))).toBe(false);
  });

  it("getLeaderboardCoverage.metricsSince is the earliest report_date in link_metrics_latest", async () => {
    if (!dbAvailable) return;
    const emp = await seedEmployee("f");
    await upsertLinkMetricLatest(latestInput({ employeeId: emp.id, url: `${P}f1`, reportDate: new Date("2026-03-04T00:00:00Z"), views: 1 }));
    await upsertLinkMetricLatest(latestInput({ employeeId: emp.id, url: `${P}f2`, reportDate: new Date("2026-05-06T00:00:00Z"), views: 1 }));
    const cov = await getLeaderboardCoverage();
    expect(cov.metricsSince).toBe("2026-03-04");
  });
});
