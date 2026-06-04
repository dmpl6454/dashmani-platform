import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { prisma } from "@dashmani/db";
import jwt from "jsonwebtoken";
import "./setup";

// Generate an HR token (type: "hr")
function generateHrToken(userId: string, email: string, roles: string[] = []) {
  return jwt.sign(
    { userId, email, roles, type: "hr" },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "15m" },
  );
}

describe("Daily Report API", () => {
  let employeeId: string;
  let hrToken: string;
  let adminToken: string;
  let platformId: string;
  let accountId: string;

  beforeEach(async () => {
    // Create roles
    await createTestRole("Employee", [
      { resource: "employees", action: "view", scope: "own" },
    ]);
    await createTestRole("Admin", [
      { resource: "reports", action: "view", scope: "global" },
      { resource: "reports", action: "manage", scope: "global" },
    ]);

    // Create employee (HR user)
    const employee = await createTestUser({
      email: "employee@digitalsukoon.com",
      roleNames: ["Employee"],
    });
    employeeId = employee.id;
    hrToken = generateHrToken(employee.id, employee.email, ["Employee"]);

    // Create admin user
    const admin = await createTestUser({ email: "admin@digitalsukoon.com", roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    // Create platform and account
    const platform = await prisma.platform.create({
      data: { name: "Instagram", slug: "instagram" },
    });
    platformId = platform.id;

    const account = await prisma.socialAccount.create({
      data: {
        handle: "@testhandle",
        displayName: "Test Handle",
        platformId: platform.id,
        clientName: "Test Client",
        status: "ACTIVE",
      },
    });
    accountId = account.id;

    // Assign account to employee
    await prisma.accountAssignment.create({
      data: {
        accountId: account.id,
        employeeId: employee.id,
        assignedBy: employee.id,
      },
    });
  });

  describe("GET /v1/hr/accounts", () => {
    it("returns assigned accounts for HR user", async () => {
      const res = await request(app)
        .get("/v1/hr/accounts")
        .set("Authorization", `Bearer ${hrToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].id).toBe(accountId);
      expect(res.body.data[0].platformSlug).toBe("instagram");
    });

    it("requires HR authentication", async () => {
      const res = await request(app).get("/v1/hr/accounts");
      expect(res.status).toBe(401);
    });

    it("rejects non-HR tokens (employee type)", async () => {
      const employeeTypeToken = generateToken(employeeId, "employee@digitalsukoon.com", ["Employee"]);
      const res = await request(app)
        .get("/v1/hr/accounts")
        .set("Authorization", `Bearer ${employeeTypeToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("POST /v1/hr/reports", () => {
    it("creates a daily report", async () => {
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-05",
          links: [
            {
              accountId,
              url: "https://instagram.com/p/abc123",
              platform: "instagram",
              likes: 100,
              comments: 10,
            },
          ],
          notes: "Good day",
          latitude: 28.6139,
          longitude: 77.209,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.employeeId).toBe(employeeId);
      expect(res.body.data.date).toBe("2026-04-05");
      expect(res.body.data.links.length).toBe(1);
      expect(res.body.data.links[0].likes).toBe(100);
      expect(res.body.data.latitude).toBe(28.6139);
    });

    it("updates existing report for the same date", async () => {
      // First submission
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-05",
          links: [{ accountId, url: "https://instagram.com/p/first", platform: "instagram" }],
        });

      // Second submission — same date
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-05",
          links: [
            { accountId, url: "https://instagram.com/p/updated", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/second", platform: "instagram" },
          ],
          notes: "Updated report",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.links.length).toBe(2);
      expect(res.body.data.notes).toBe("Updated report");
    });

    it("returns 400 when links array is empty", async () => {
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-05",
          links: [],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for invalid date format", async () => {
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "05-04-2026",
          links: [{ accountId, url: "https://instagram.com/p/abc", platform: "instagram" }],
        });

      expect(res.status).toBe(400);
    });

    it("requires HR authentication", async () => {
      const res = await request(app)
        .post("/v1/hr/reports")
        .send({
          date: "2026-04-05",
          links: [{ accountId, url: "https://instagram.com/p/abc", platform: "instagram" }],
        });

      expect(res.status).toBe(401);
    });

    it("accepts a submission with more than 500 links (no cap)", async () => {
      const links = Array.from({ length: 650 }, (_, i) => ({
        accountId,
        url: `https://instagram.com/p/bulk-${i}`,
        platform: "instagram",
      }));

      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({ date: "2026-04-07", links });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.links.length).toBe(650);
    });

    it("drops cross-day duplicate links even in a large batch", async () => {
      // Day 1: submit a link
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-08",
          links: [{ accountId, url: "https://instagram.com/p/yesterday", platform: "instagram" }],
        });

      // Day 2: submit a large batch that RE-INCLUDES yesterday's URL plus 600 new ones
      const links = [
        { accountId, url: "https://instagram.com/p/yesterday", platform: "instagram" }, // dup from day 1
        ...Array.from({ length: 600 }, (_, i) => ({
          accountId,
          url: `https://instagram.com/p/day2-${i}`,
          platform: "instagram",
        })),
      ];

      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({ date: "2026-04-09", links });

      expect(res.status).toBe(201);
      // The yesterday dup is silently dropped; only the 600 new ones remain.
      expect(res.body.data.links.length).toBe(600);
      const urls = res.body.data.links.map((l: any) => l.url);
      expect(urls).not.toContain("https://instagram.com/p/yesterday");
    });

    it("preserves firstSeenAt per-URL across a same-day resubmit (true posting time)", async () => {
      // First submission: 2 links. These get their firstSeenAt = T1.
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-12",
          links: [
            { accountId, url: "https://instagram.com/p/early-a", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/early-b", platform: "instagram" },
          ],
        });

      // Capture the original firstSeenAt for the two early links.
      const earlyRows = await prisma.reportLink.findMany({
        where: { url: { in: ["https://instagram.com/p/early-a", "https://instagram.com/p/early-b"] } },
        select: { url: true, firstSeenAt: true },
      });
      expect(earlyRows.length).toBe(2);
      const earlyA = earlyRows.find((r) => r.url === "https://instagram.com/p/early-a")!.firstSeenAt;

      // Ensure a measurable time gap so T2 > T1.
      await new Promise((r) => setTimeout(r, 25));

      // Resubmit SAME day with the 2 originals + 2 brand-new links (the user's
      // "2 links at 10am, then 10 more at 8:30pm" scenario, scaled down).
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-12",
          links: [
            { accountId, url: "https://instagram.com/p/early-a", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/early-b", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/late-c", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/late-d", platform: "instagram" },
          ],
        });

      const afterRows = await prisma.reportLink.findMany({
        where: {
          url: {
            in: [
              "https://instagram.com/p/early-a",
              "https://instagram.com/p/early-b",
              "https://instagram.com/p/late-c",
              "https://instagram.com/p/late-d",
            ],
          },
        },
        select: { url: true, firstSeenAt: true },
      });
      expect(afterRows.length).toBe(4);

      const byUrl = Object.fromEntries(afterRows.map((r) => [r.url, r.firstSeenAt]));

      // The two early links KEPT their original firstSeenAt (not rewritten to T2).
      expect(byUrl["https://instagram.com/p/early-a"]!.getTime()).toBe(earlyA.getTime());

      // The two new links got a LATER firstSeenAt than the early ones.
      expect(byUrl["https://instagram.com/p/late-c"]!.getTime()).toBeGreaterThan(earlyA.getTime());
      expect(byUrl["https://instagram.com/p/late-d"]!.getTime()).toBeGreaterThan(earlyA.getTime());
    });

    it("resubmitting a SUPERSET (base + increment) persists ALL links — the Anish scenario", async () => {
      // Base: submit a batch (stand-in for Anish's 181 already-saved links).
      const base = Array.from({ length: 30 }, (_, i) => ({
        accountId,
        url: `https://instagram.com/p/anish-base-${i}`,
        platform: "instagram",
      }));
      const r1 = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({ date: "2026-04-14", links: base });
      expect(r1.status).toBe(201);
      expect(r1.body.data.links.length).toBe(30);

      // Later: reopen, add an increment (stand-in for the +22), resubmit the FULL set.
      // The server must persist 30 + 8 = 38 — never silently drop the increment.
      const increment = Array.from({ length: 8 }, (_, i) => ({
        accountId,
        url: `https://instagram.com/p/anish-more-${i}`,
        platform: "instagram",
      }));
      const r2 = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({ date: "2026-04-14", links: [...base, ...increment] });
      expect(r2.status).toBe(201);
      expect(r2.body.data.links.length).toBe(38);

      // Verify against the DB (server truth, what a hard refresh would show).
      const today = await request(app)
        .get("/v1/hr/reports/today")
        .set("Authorization", `Bearer ${hrToken}`);
      // (today endpoint is IST-today; assert via direct DB read instead for date 2026-04-14)
      const dbRows = await prisma.reportLink.count({
        where: { report: { employeeId, date: new Date("2026-04-14") } },
      });
      expect(dbRows).toBe(38);
    });

    it("intentional link REMOVAL still works on resubmit (must not regress with the fix)", async () => {
      // Submit 3 links.
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-15",
          links: [
            { accountId, url: "https://instagram.com/p/keep-1", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/remove-me", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/keep-2", platform: "instagram" },
          ],
        });

      // Resubmit WITHOUT the middle link (user removed it via the form).
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-15",
          links: [
            { accountId, url: "https://instagram.com/p/keep-1", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/keep-2", platform: "instagram" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.links.length).toBe(2);
      const urls = res.body.data.links.map((l: any) => l.url);
      expect(urls).not.toContain("https://instagram.com/p/remove-me");
      // DB confirms the removed link is truly gone (delete-and-recreate semantics preserved).
      const removed = await prisma.reportLink.count({
        where: { url: "https://instagram.com/p/remove-me", report: { employeeId } },
      });
      expect(removed).toBe(0);
    });

    it("does not drop a link when re-submitting the same day (not a cross-day dup of itself)", async () => {
      // First submission
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-10",
          links: [{ accountId, url: "https://instagram.com/p/sameday", platform: "instagram" }],
          notes: "first",
        });

      // Re-submit SAME date + SAME link (e.g. just changing notes)
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-10",
          links: [{ accountId, url: "https://instagram.com/p/sameday", platform: "instagram" }],
          notes: "edited notes",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.links.length).toBe(1); // link survives — not dropped
      expect(res.body.data.notes).toBe("edited notes");
    });
  });

  describe("GET /v1/hr/reports/today", () => {
    it("returns null when no report submitted today", async () => {
      const res = await request(app)
        .get("/v1/hr/reports/today")
        .set("Authorization", `Bearer ${hrToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it("returns today's report after submission", async () => {
      const today = new Date().toISOString().split("T")[0];

      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: today,
          links: [{ accountId, url: "https://instagram.com/p/today", platform: "instagram" }],
        });

      const res = await request(app)
        .get("/v1/hr/reports/today")
        .set("Authorization", `Bearer ${hrToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).not.toBeNull();
      expect(res.body.data.date).toBe(today);
    });
  });

  describe("GET /v1/hr/reports", () => {
    it("returns report history", async () => {
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-05",
          links: [{ accountId, url: "https://instagram.com/p/hist", platform: "instagram" }],
        });

      const res = await request(app)
        .get("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it("requires HR authentication", async () => {
      const res = await request(app).get("/v1/hr/reports");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/admin/reports", () => {
    it("returns all reports for admin", async () => {
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-05",
          links: [{ accountId, url: "https://instagram.com/p/admin", platform: "instagram" }],
        });

      const res = await request(app)
        .get("/v1/admin/reports")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it("filters reports by employeeId", async () => {
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-05",
          links: [{ accountId, url: "https://instagram.com/p/filter", platform: "instagram" }],
        });

      const res = await request(app)
        .get(`/v1/admin/reports?employeeId=${employeeId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.every((r: any) => r.employeeId === employeeId)).toBe(true);
    });

    it("returns 403 when HR token is used (not admin)", async () => {
      const res = await request(app)
        .get("/v1/admin/reports")
        .set("Authorization", `Bearer ${hrToken}`);

      expect(res.status).toBe(403);
    });

    it("returns 401 without auth", async () => {
      const res = await request(app).get("/v1/admin/reports");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/admin/reports/summary", () => {
    it("returns per-employee summary", async () => {
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-05",
          links: [
            { accountId, url: "https://instagram.com/p/s1", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/s2", platform: "instagram" },
          ],
        });

      const res = await request(app)
        .get("/v1/admin/reports/summary")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.employees.length).toBeGreaterThan(0);
      const entry = res.body.data.employees.find((e: any) => e.id === employeeId);
      expect(entry).toBeDefined();
      expect(entry.reportCount).toBe(1);
      expect(entry.totalLinks).toBe(2);
    });

    it("requires admin auth", async () => {
      const res = await request(app)
        .get("/v1/admin/reports/summary")
        .set("Authorization", `Bearer ${hrToken}`);

      expect(res.status).toBe(403);
    });
  });
});
