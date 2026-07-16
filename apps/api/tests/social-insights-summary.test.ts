import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import {
  getInsightsSummary,
  getTopLinksByPlatform,
  invalidateInsightsCache,
} from "../src/services/social-insights.service";

// ── DB-backed characterization + regression guard for the DISTINCT ON rewrite of
// getInsightsSummary + getTopLinksByPlatform (the unbounded `linkMetric.findMany`
// pool-exhaustion culprit, incident 2026-07-16). These tests capture the EXACT
// CURRENT output (latest-snapshot-per-link dedup, aggregation totals, score-desc
// top-N with the stable tie-break) so they PASS against BOTH the old JS-dedup code
// and the new SQL DISTINCT ON code — a true before/after equivalence check.
//
// setup.ts TRUNCATEs report_links / daily_reports / users / platforms but NOT
// link_metrics — so this file owns its link_metrics cleanup, keyed by a ZZTEST url
// prefix. Uses real youtube.com / instagram.com / facebook.com hosts where the
// platform column and host must agree (they always do in real data).

const P = "https://zztest-ins.example/"; // generic fake host (platform set explicitly)
let dbAvailable = false;

async function cleanup() {
  // Only link_metrics — setup.ts's global beforeEach TRUNCATE already wipes users,
  // roles, etc. (but NOT link_metrics). Deleting users here too would contend with
  // that TRUNCATE for the same table lock and deadlock (40P01).
  await prisma.linkMetric.deleteMany({ where: { url: { startsWith: P } } });
}

async function ensureEmployeeRole(): Promise<string> {
  const existing = await prisma.role.findFirst({ where: { name: "Employee" } });
  if (existing) return existing.id;
  const created = await prisma.role.create({ data: { name: "Employee", description: "test" } });
  return created.id;
}

async function seedEmployee(suffix: string, name: string) {
  const roleId = await ensureEmployeeRole();
  return prisma.user.create({
    data: {
      name,
      email: `zztest-ins-${suffix}@example.com`,
      passwordHash: "x",
      status: "ACTIVE",
      roles: { create: [{ roleId }] },
    },
  });
}

// A link_metric snapshot. The summary dedups to the LATEST snapshot per
// (employeeId, urlNormalized) by fetchedAt desc.
async function snap(opts: {
  employeeId: string;
  url: string;
  fetchedAt: Date;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  platform?: string;
  status?: string;
}) {
  return prisma.linkMetric.create({
    data: {
      url: opts.url,
      urlNormalized: opts.url,
      platform: opts.platform ?? "youtube",
      employeeId: opts.employeeId,
      status: opts.status ?? "ok",
      fetchedAt: opts.fetchedAt,
      reportDate: opts.fetchedAt,
      views: opts.views ?? null,
      likes: opts.likes ?? null,
      comments: opts.comments ?? null,
    },
  });
}

beforeAll(async () => {
  try {
    await cleanup();
    dbAvailable = true;
  } catch (err) {
    console.warn("[social-insights-summary.test] DB unavailable — skipping:", err);
    dbAvailable = false;
  }
});
beforeEach(async () => {
  // Reset the module-singleton 60s TTL cache before EVERY test — otherwise a prior
  // test's cached summary/top-links result is served to a later test that seeds fresh
  // data (the exact cross-test leak documented for leaderboard.service.ts's _lbCache
  // and link-search.service.ts's coverage cache).
  invalidateInsightsCache();
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  if (dbAvailable) {
    try {
      await cleanup();
    } catch {
      /* ignore */
    }
  }
});

describe("getInsightsSummary — latest-per-link dedup + aggregation", () => {
  it("dedups to the LATEST snapshot per link (never sums two snapshots of one url)", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    // Same url, two snapshots — newer must win.
    await snap({ employeeId: a.id, url: `${P}yt1`, fetchedAt: new Date("2026-06-01"), views: 100, likes: 10, comments: 1, platform: "youtube" });
    await snap({ employeeId: a.id, url: `${P}yt1`, fetchedAt: new Date("2026-06-10"), views: 500, likes: 50, comments: 5, platform: "youtube" });

    const r = await getInsightsSummary({});
    // Only the newer snapshot counts: 500 / 50 / 5, NOT 600 / 60 / 6.
    expect(r.totalViews).toBe(500);
    expect(r.totalLikes).toBe(50);
    expect(r.totalComments).toBe(5);
    expect(r.topLinks.length).toBe(1);
    expect(r.topLinks[0].views).toBe(500);
  });

  it("aggregates totals + per-platform breakdown across employees & platforms", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    const b = await seedEmployee("b", "ZZ B");
    await snap({ employeeId: a.id, url: `${P}yt1`, fetchedAt: new Date("2026-06-10"), views: 300, likes: 30, comments: 3, platform: "youtube" });
    await snap({ employeeId: b.id, url: `${P}ig1`, fetchedAt: new Date("2026-06-10"), views: null, likes: 20, comments: 2, platform: "instagram" });
    await snap({ employeeId: b.id, url: `${P}fb1`, fetchedAt: new Date("2026-06-10"), views: 10, likes: 5, comments: 1, platform: "facebook" });

    const r = await getInsightsSummary({});
    expect(r.totalViews).toBe(310); // 300 + 0(null) + 10
    expect(r.totalLikes).toBe(55); // 30 + 20 + 5
    expect(r.totalComments).toBe(6); // 3 + 2 + 1

    const byP = Object.fromEntries(r.byPlatform.map((p) => [p.platform, p]));
    expect(byP["youtube"].totalViews).toBe(300);
    expect(byP["youtube"].linkCount).toBe(1);
    expect(byP["instagram"].totalLikes).toBe(20);
    expect(byP["instagram"].linkCount).toBe(1);
    expect(byP["facebook"].totalComments).toBe(1);
  });

  it("topLinks are sorted by views desc and capped at 20", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    // 25 distinct links with descending views 25..1.
    for (let i = 25; i >= 1; i--) {
      await snap({ employeeId: a.id, url: `${P}v${i}`, fetchedAt: new Date("2026-06-10"), views: i, platform: "youtube" });
    }
    const r = await getInsightsSummary({});
    expect(r.topLinks.length).toBe(20); // capped
    expect(r.topLinks[0].views).toBe(25); // highest first
    expect(r.topLinks[19].views).toBe(6); // 20th
    // Strictly descending
    for (let i = 1; i < r.topLinks.length; i++) {
      expect((r.topLinks[i - 1].views ?? 0) >= (r.topLinks[i].views ?? 0)).toBe(true);
    }
  });

  it("respects the startDate/endDate window (reportDate filter)", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    await snap({ employeeId: a.id, url: `${P}old`, fetchedAt: new Date("2026-01-01"), views: 999, platform: "youtube" });
    await snap({ employeeId: a.id, url: `${P}new`, fetchedAt: new Date("2026-06-15"), views: 5, platform: "youtube" });

    const r = await getInsightsSummary({ startDate: "2026-06-01", endDate: "2026-06-30" });
    expect(r.totalViews).toBe(5); // only the in-window link
    expect(r.topLinks.length).toBe(1);
    expect(r.topLinks[0].url).toBe(`${P}new`);
  });

  it("scopes to a single employee when employeeId is passed", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    const b = await seedEmployee("b", "ZZ B");
    await snap({ employeeId: a.id, url: `${P}a1`, fetchedAt: new Date("2026-06-10"), views: 100, platform: "youtube" });
    await snap({ employeeId: b.id, url: `${P}b1`, fetchedAt: new Date("2026-06-10"), views: 999, platform: "youtube" });

    const r = await getInsightsSummary({ employeeId: a.id });
    expect(r.totalViews).toBe(100); // b's 999 excluded
    expect(r.topLinks.length).toBe(1);
  });

  it("ignores non-ok status rows", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    await snap({ employeeId: a.id, url: `${P}ok`, fetchedAt: new Date("2026-06-10"), views: 7, platform: "youtube", status: "ok" });
    await snap({ employeeId: a.id, url: `${P}nf`, fetchedAt: new Date("2026-06-10"), views: 999, platform: "youtube", status: "not_found" });

    const r = await getInsightsSummary({});
    expect(r.totalViews).toBe(7); // not_found row excluded
    expect(r.topLinks.length).toBe(1);
  });

  it("dedup picks latest even when the OLDER snapshot has the higher metric", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    // Older = high, newer = low. Latest-wins must take the LOW newer value.
    await snap({ employeeId: a.id, url: `${P}drop`, fetchedAt: new Date("2026-06-01"), views: 900, platform: "youtube" });
    await snap({ employeeId: a.id, url: `${P}drop`, fetchedAt: new Date("2026-06-20"), views: 3, platform: "youtube" });

    const r = await getInsightsSummary({});
    expect(r.totalViews).toBe(3); // newer wins even though it's smaller
  });
});

describe("getTopLinksByPlatform — per-platform sort + limit", () => {
  it("youtube sorts by views desc and honors limit", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    await snap({ employeeId: a.id, url: `${P}y1`, fetchedAt: new Date("2026-06-10"), views: 10, likes: 999, comments: 999, platform: "youtube" });
    await snap({ employeeId: a.id, url: `${P}y2`, fetchedAt: new Date("2026-06-10"), views: 50, likes: 0, comments: 0, platform: "youtube" });
    await snap({ employeeId: a.id, url: `${P}y3`, fetchedAt: new Date("2026-06-10"), views: 30, likes: 0, comments: 0, platform: "youtube" });

    const rows = await getTopLinksByPlatform({ platform: "youtube", limit: 2 });
    expect(rows.length).toBe(2);
    // Sorted by VIEWS (not likes+comments) → y2(50), y3(30). y1 has huge engagement but low views.
    expect(rows[0].url).toBe(`${P}y2`);
    expect(rows[1].url).toBe(`${P}y3`);
  });

  it("instagram sorts by likes+comments (engagement), not views", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    await snap({ employeeId: a.id, url: `${P}i1`, fetchedAt: new Date("2026-06-10"), views: 999, likes: 1, comments: 1, platform: "instagram" });
    await snap({ employeeId: a.id, url: `${P}i2`, fetchedAt: new Date("2026-06-10"), views: 0, likes: 40, comments: 10, platform: "instagram" });

    const rows = await getTopLinksByPlatform({ platform: "instagram" });
    // Engagement: i2 = 50, i1 = 2 → i2 first even though i1 has more views.
    expect(rows[0].url).toBe(`${P}i2`);
    expect(rows[1].url).toBe(`${P}i1`);
  });

  it("filters to the requested platform only", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    await snap({ employeeId: a.id, url: `${P}y1`, fetchedAt: new Date("2026-06-10"), views: 10, platform: "youtube" });
    await snap({ employeeId: a.id, url: `${P}i1`, fetchedAt: new Date("2026-06-10"), likes: 10, platform: "instagram" });

    const rows = await getTopLinksByPlatform({ platform: "youtube" });
    expect(rows.length).toBe(1);
    expect(rows[0].platform).toBe("youtube");
  });

  it("dedups to latest snapshot per link before ranking", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    await snap({ employeeId: a.id, url: `${P}y1`, fetchedAt: new Date("2026-06-01"), views: 5, platform: "youtube" });
    await snap({ employeeId: a.id, url: `${P}y1`, fetchedAt: new Date("2026-06-10"), views: 80, platform: "youtube" });

    const rows = await getTopLinksByPlatform({ platform: "youtube" });
    expect(rows.length).toBe(1);
    expect(rows[0].views).toBe(80); // latest snapshot
  });

  it("returns [] for a platform with no ok rows in window", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ A");
    await snap({ employeeId: a.id, url: `${P}y1`, fetchedAt: new Date("2026-06-10"), views: 10, platform: "youtube" });
    const rows = await getTopLinksByPlatform({ platform: "facebook" });
    expect(rows).toEqual([]);
  });

  it("carries through employeeName + all metric fields on each row", async () => {
    if (!dbAvailable) return;
    const a = await seedEmployee("a", "ZZ Named");
    await snap({ employeeId: a.id, url: `${P}y1`, fetchedAt: new Date("2026-06-10"), views: 10, likes: 2, comments: 1, platform: "youtube" });
    const rows = await getTopLinksByPlatform({ platform: "youtube" });
    expect(rows[0].employeeName).toBe("ZZ Named");
    expect(rows[0].employeeId).toBe(a.id);
    expect(rows[0].views).toBe(10);
    expect(rows[0].likes).toBe(2);
    expect(rows[0].comments).toBe(1);
    expect(rows[0].urlNormalized).toBe(`${P}y1`);
  });
});
