import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import { getLeaderboard, getTopLinksLeaderboard } from "../src/services/leaderboard.service";

// ── DB-backed: verifies the 2026-06-29 fix that engagement comes from link_metrics
// (the real snapshots) and NOT report_links.likes/comments/shares (always 0). Also
// covers the new Top Links engagement leaderboard. Skips cleanly if no DB.
//
// Distinctive prefixes keep us off real data. setup.ts TRUNCATEs report_links /
// daily_reports / users / platforms, but NOT link_metrics — so this file owns its
// link_metrics cleanup (keyed by a ZZTEST url prefix).

const URL_PREFIX = "https://zztest-lb.example/";
let dbAvailable = false;

async function cleanup() {
  await prisma.linkMetric.deleteMany({ where: { url: { startsWith: URL_PREFIX } } });
  await prisma.dailyReport.deleteMany({ where: { employee: { email: { startsWith: "zztest-lb-" } } } });
  await prisma.socialAccount.deleteMany({ where: { handle: { startsWith: "zztest-lb-" } } });
  await prisma.platform.deleteMany({ where: { name: { startsWith: "ZZTEST_LB_" } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: "zztest-lb-" } } });
}

// A report link requires a SocialAccount (FK accountId) + Platform. Seed minimal ones.
async function seedAccount() {
  const platform = await prisma.platform.create({
    data: { name: `ZZTEST_LB_${Date.now()}`, slug: `zztest-lb-${Date.now()}` },
  });
  return prisma.socialAccount.create({
    data: { handle: `zztest-lb-acct`, displayName: "ZZ Acct", platformId: platform.id },
  });
}

beforeAll(async () => {
  try {
    await cleanup();
    dbAvailable = true;
  } catch (err) {
    console.warn("[leaderboard-engagement.test] DB unavailable — skipping:", err);
    dbAvailable = false;
  }
});
beforeEach(async () => {
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

// getLeaderboard / getTopLinksLeaderboard filter by employeeWhere, which requires a
// non-admin role (roles.some.role.name notIn [Super Admin, Admin]). So a seeded user
// MUST have an Employee role or it's excluded. Reuse the seeded "Employee" role if it
// exists (db:seed creates it), else create one.
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
      email: `zztest-lb-${suffix}@example.com`,
      passwordHash: "x",
      status: "ACTIVE",
      roles: { create: [{ roleId }] },
    },
  });
}

// Insert a link_metric snapshot. The leaderboard dedups to the LATEST snapshot per
// (employeeId, urlNormalized) by fetchedAt desc — so two snapshots of the same url
// must collapse to the newer one's numbers.
async function snap(opts: {
  employeeId: string;
  url: string;
  fetchedAt: Date;
  views?: number;
  likes?: number;
  comments?: number;
  platform?: string;
}) {
  return prisma.linkMetric.create({
    data: {
      url: opts.url,
      urlNormalized: opts.url,
      platform: opts.platform ?? "youtube",
      employeeId: opts.employeeId,
      status: "ok",
      fetchedAt: opts.fetchedAt,
      reportDate: opts.fetchedAt,
      views: opts.views ?? null,
      likes: opts.likes ?? null,
      comments: opts.comments ?? null,
    },
  });
}

describe("leaderboard engagement (link_metrics-sourced)", () => {
  it("getTopLinksLeaderboard sums latest-per-link engagement and ranks by total desc", async () => {
    if (!dbAvailable) return;
    const alice = await seedEmployee("alice", "ZZ Alice");
    const bob = await seedEmployee("bob", "ZZ Bob");

    // Alice: one link, two snapshots — the NEWER (higher) must win, not summed twice.
    await snap({ employeeId: alice.id, url: `${URL_PREFIX}a1`, fetchedAt: new Date("2026-06-01"), views: 100, likes: 10, comments: 1 });
    await snap({ employeeId: alice.id, url: `${URL_PREFIX}a1`, fetchedAt: new Date("2026-06-10"), views: 500, likes: 50, comments: 5 });
    // Bob: two distinct links.
    await snap({ employeeId: bob.id, url: `${URL_PREFIX}b1`, fetchedAt: new Date("2026-06-05"), views: 200, likes: 20, comments: 2 });
    await snap({ employeeId: bob.id, url: `${URL_PREFIX}b2`, fetchedAt: new Date("2026-06-06"), views: 50, likes: 5, comments: 0 });

    const board = await getTopLinksLeaderboard();
    const a = board.find((r) => r.employee.id === alice.id)!;
    const b = board.find((r) => r.employee.id === bob.id)!;

    // Alice: latest snapshot only → 500+50+5 = 555 (NOT 100+10+1 added too).
    expect(a.views).toBe(500);
    expect(a.likes).toBe(50);
    expect(a.comments).toBe(5);
    expect(a.totalEngagement).toBe(555);
    expect(a.engagedLinkCount).toBe(1);

    // Bob: 200+20+2 + 50+5+0 = 277 across 2 links.
    expect(b.totalEngagement).toBe(277);
    expect(b.engagedLinkCount).toBe(2);

    // Ranked by total engagement desc → Alice (#1) before Bob (#2).
    expect(a.rank).toBeLessThan(b.rank);
    expect(board[0].employee.id).toBe(alice.id);
  });

  it("main leaderboard totalEngagement comes from link_metrics, never the always-zero report_links columns", async () => {
    if (!dbAvailable) return;
    const carol = await seedEmployee("carol", "ZZ Carol");
    const acct = await seedAccount();
    // A daily report with a link (the report_links row carries 0/null engagement,
    // as ALL real rows do) — engagement must still surface from link_metrics.
    await prisma.dailyReport.create({
      data: {
        employeeId: carol.id,
        date: new Date("2026-06-09"),
        links: { create: [{ accountId: acct.id, url: `${URL_PREFIX}c1`, platform: "youtube" }] },
      },
    });
    await snap({ employeeId: carol.id, url: `${URL_PREFIX}c1`, fetchedAt: new Date("2026-06-09"), views: 999, likes: 9, comments: 0 });

    const lb = await getLeaderboard();
    const c = lb.find((r) => r.employee.id === carol.id)!;
    expect(c.totalEngagement).toBe(1008); // 999+9+0 from link_metrics, NOT 0
    expect(c.engagementViews).toBe(999);
  });

  it("an employee with reports but no metrics shows 0 engagement (no crash, no fake number)", async () => {
    if (!dbAvailable) return;
    const dave = await seedEmployee("dave", "ZZ Dave");
    const acct = await seedAccount();
    await prisma.dailyReport.create({
      data: {
        employeeId: dave.id,
        date: new Date("2026-06-09"),
        links: { create: [{ accountId: acct.id, url: `${URL_PREFIX}d1`, platform: "instagram" }] },
      },
    });
    const lb = await getLeaderboard();
    const d = lb.find((r) => r.employee.id === dave.id)!;
    expect(d.totalEngagement).toBe(0);
    // Dave has no metrics → must NOT appear on the engagement-only board.
    const board = await getTopLinksLeaderboard();
    expect(board.find((r) => r.employee.id === dave.id)).toBeUndefined();
  });
});
