import { describe, it, expect, beforeEach } from "vitest";
import { getEmployeePerformance } from "../src/services/employee-performance.service";
import { prisma } from "@dashmani/db";
import { createTestUser, createTestRole } from "./helpers";
import "./setup";

// DB-backed characterization of the 2026-07-20 memory-safe rewrite: the service
// used to hydrate EVERY report with EVERY link (+account+platform) — the
// unbounded-include class behind the 2026-07-09 OOM. The rewrite aggregates in
// the DB; these tests lock that the OUTPUT stayed identical.

describe("getEmployeePerformance (DB-backed)", () => {
  let employeeId: string;
  let accountIgId: string;
  let accountYtId: string;

  beforeEach(async () => {
    await createTestRole("Employee", []);
    const emp = await createTestUser({ name: "Perf Emp", email: `perf-${Date.now()}@test.com`, roleNames: ["Employee"] });
    employeeId = emp.id;

    const uniq = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const ig = await prisma.platform.create({ data: { name: `PerfIG_${uniq}`, slug: `perf-ig-${uniq}` } });
    const yt = await prisma.platform.create({ data: { name: `PerfYT_${uniq}`, slug: `perf-yt-${uniq}` } });
    const accIg = await prisma.socialAccount.create({ data: { handle: "perfig", displayName: "Perf IG", platformId: ig.id } });
    const accYt = await prisma.socialAccount.create({ data: { handle: "perfyt", displayName: "Perf YT", platformId: yt.id } });
    accountIgId = accIg.id;
    accountYtId = accYt.id;
  });

  async function addReport(date: Date, links: Array<{ accountId: string; likes?: number; comments?: number; views?: number }>) {
    const report = await prisma.dailyReport.create({ data: { employeeId, date } });
    for (const l of links) {
      await prisma.reportLink.create({
        data: {
          reportId: report.id,
          accountId: l.accountId,
          url: `https://example.com/${Math.random().toString(36).slice(2)}`,
          platform: "instagram",
          likes: l.likes ?? null,
          comments: l.comments ?? null,
          views: l.views ?? null,
        },
      });
    }
    return report;
  }

  it("aggregates totals, per-platform breakdown, and metric sums without hydrating links", async () => {
    const d1 = new Date("2026-06-01T00:00:00.000Z");
    const d2 = new Date("2026-06-02T00:00:00.000Z");
    await addReport(d1, [
      { accountId: accountIgId, likes: 10, comments: 2 },
      { accountId: accountIgId, likes: 5, views: 100 },
      { accountId: accountYtId, views: 1000, likes: 1 },
    ]);
    await addReport(d2, [{ accountId: accountYtId, likes: 3, comments: 4 }]);

    const res = await getEmployeePerformance(employeeId);

    expect(res.stats.totalReports).toBe(2);
    expect(res.stats.totalLinks).toBe(4);
    expect(res.stats.totalLikes).toBe(19);
    expect(res.stats.totalComments).toBe(6);
    expect(res.stats.totalViews).toBe(1100);
    expect(res.stats.totalEngagement).toBe(25); // likes+comments+shares
    expect(res.stats.avgLinksPerDay).toBe(2);

    // Per-platform: IG 2 links (eng 10+2+5=17), YT 2 links (eng 1+3+4=8); sorted by links desc.
    expect(res.platformBreakdown).toHaveLength(2);
    const ig = res.platformBreakdown.find((p: any) => p.name.startsWith("PerfIG"));
    const yt = res.platformBreakdown.find((p: any) => p.name.startsWith("PerfYT"));
    expect(ig).toMatchObject({ links: 2, engagement: 17 });
    expect(yt).toMatchObject({ links: 2, engagement: 8 });
  });

  it("recentReports carries per-report linkCount, engagement, and platform names (bounded hydration)", async () => {
    const d1 = new Date("2026-06-03T00:00:00.000Z");
    await addReport(d1, [
      { accountId: accountIgId, likes: 7 },
      { accountId: accountYtId, comments: 3 },
    ]);

    const res = await getEmployeePerformance(employeeId);
    expect(res.recentReports).toHaveLength(1);
    expect(res.recentReports[0].linkCount).toBe(2);
    expect(res.recentReports[0].totalEngagement).toBe(10);
    expect(res.recentReports[0].platforms).toHaveLength(2);
    expect(res.recentReports[0].date).toBe("2026-06-03");
  });

  it("returns zeroed stats (not a crash) for an employee with no reports", async () => {
    const res = await getEmployeePerformance(employeeId);
    expect(res.stats.totalReports).toBe(0);
    expect(res.stats.totalLinks).toBe(0);
    expect(res.platformBreakdown).toEqual([]);
    expect(res.recentReports).toEqual([]);
    expect(res.calendar).toHaveLength(90);
  });
});
