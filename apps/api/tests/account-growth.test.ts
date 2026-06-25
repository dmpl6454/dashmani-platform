import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { prisma } from "@dashmani/db";
import "./setup";

// Helper: a date-only N days ago (UTC midnight, matching how @db.Date rows are stored).
function dateOnlyDaysAgo(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - days * 86400000);
}

describe("Account Growth API", () => {
  let adminToken: string;
  let platformId: string;
  let accountAId: string;
  let accountBId: string;

  beforeEach(async () => {
    await createTestRole("Admin", [
      { resource: "reports", action: "view", scope: "global" },
      { resource: "reports", action: "manage", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    const platform = await prisma.platform.create({
      data: { name: "Instagram", slug: "instagram" },
    });
    platformId = platform.id;

    // Account A — gaining: 1000 → 1200 (delta +200, +20%), latest 1200
    const accountA = await prisma.socialAccount.create({
      data: { handle: "@gainer", displayName: "Gainer", platformId, status: "ACTIVE", followerCount: 1200 },
    });
    accountAId = accountA.id;

    // Account B — losing: 5000 → 4900 (delta -100, -2%), latest 4900
    const accountB = await prisma.socialAccount.create({
      data: { handle: "@loser", displayName: "Loser", platformId, status: "ACTIVE", followerCount: 4900 },
    });
    accountBId = accountB.id;

    // Seed snapshots a few days ago (within the 30d window, avoiding IST "today" edge flakiness).
    await prisma.accountGrowthSnapshot.createMany({
      data: [
        { accountId: accountAId, date: dateOnlyDaysAgo(10), followerCount: 1000 },
        { accountId: accountAId, date: dateOnlyDaysAgo(2), followerCount: 1200 },
        { accountId: accountBId, date: dateOnlyDaysAgo(10), followerCount: 5000 },
        { accountId: accountBId, date: dateOnlyDaysAgo(2), followerCount: 4900 },
      ],
    });
  });

  describe("GET /v1/admin/growth", () => {
    it("returns org-wide follower-growth overview", async () => {
      const res = await request(app)
        .get("/v1/admin/growth")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const d = res.body.data;

      expect(d.accountCount).toBe(2);
      expect(d.totalFollowers).toBe(6100); // 1200 + 4900
      expect(d.totalDelta).toBe(100); // +200 + (-100)

      const a = d.accounts.find((x: any) => x.accountId === accountAId);
      const b = d.accounts.find((x: any) => x.accountId === accountBId);

      expect(a.delta).toBe(200);
      expect(a.deltaPct).toBe(20);
      expect(a.latest).toBe(1200);
      expect(a.first).toBe(1000);
      expect(a.platform).toBe("Instagram");
      expect(a.snapshots.length).toBe(2);

      expect(b.delta).toBe(-100);
      expect(b.deltaPct).toBe(-2);
      expect(b.latest).toBe(4900);
      expect(b.first).toBe(5000);

      // topMovers sorted by abs(delta) desc — A (200) before B (100).
      expect(d.topMovers[0].accountId).toBe(accountAId);
      expect(d.topMovers[0].delta).toBe(200);
      expect(d.topMovers[1].accountId).toBe(accountBId);
    });

    it("respects the days query param", async () => {
      const res = await request(app)
        .get("/v1/admin/growth?days=30")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.accountCount).toBe(2);
    });

    it("returns 403 without reports:view permission", async () => {
      await createTestRole("NoPerms", []);
      const user = await createTestUser({ email: `noperms-${Date.now()}@test.com`, roleNames: ["NoPerms"] });
      const token = generateToken(user.id, user.email, ["NoPerms"]);

      const res = await request(app)
        .get("/v1/admin/growth")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });

  describe("GET /v1/admin/growth/:accountId", () => {
    it("returns the per-account follower trend", async () => {
      const res = await request(app)
        .get(`/v1/admin/growth/${accountAId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(d.accountId).toBe(accountAId);
      expect(d.accountName).toBe("Gainer");
      expect(d.platform).toBe("Instagram");
      expect(Array.isArray(d.snapshots)).toBe(true);
      expect(d.snapshots.length).toBe(2);
      expect(d.snapshots[0].followerCount).toBe(1000);
      expect(d.snapshots[1].followerCount).toBe(1200);
    });

    it("returns 404 for an unknown account", async () => {
      const res = await request(app)
        .get(`/v1/admin/growth/00000000-0000-0000-0000-000000000000`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
    });
  });
});
