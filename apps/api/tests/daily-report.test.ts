import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { prisma } from "@dashmani/db";
import jwt from "jsonwebtoken";
import { __setShareResolverForTesting } from "../src/services/daily-report.service";
import { submitDailyReportSchema } from "@dashmani/shared";
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

    it("submit-time FB resolution is FAIL-OPEN: keeps the ORIGINAL url when the resolver throws", async () => {
      // Force the opaque-share resolver to throw on every call. A throwing resolver
      // must NEVER fail or alter the submit — the original /share/ url is stored.
      __setShareResolverForTesting(async () => {
        throw new Error("network down");
      });
      try {
        const shareUrl = "https://www.facebook.com/share/r/181uwpf9M7/";
        const res = await request(app)
          .post("/v1/hr/reports")
          .set("Authorization", `Bearer ${hrToken}`)
          .send({
            date: "2026-04-20",
            links: [{ accountId, url: shareUrl, platform: "facebook" }],
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.links.length).toBe(1);
        // Fail-open: the original opaque url survives untouched.
        expect(res.body.data.links[0].url).toBe(shareUrl);
      } finally {
        __setShareResolverForTesting(null); // restore the real (default) resolver
      }
    });

    it("submit-time FB resolution REPLACES an opaque /share/ url with the clean redirect target", async () => {
      // Resolver returns a clean /reel url for the opaque link; the stored url is
      // the CLEAN one (additive replacement — link count unchanged, never dropped).
      __setShareResolverForTesting(async (url: string) =>
        /share\//i.test(url) ? "https://www.facebook.com/reel/841188021963723" : null,
      );
      try {
        const res = await request(app)
          .post("/v1/hr/reports")
          .set("Authorization", `Bearer ${hrToken}`)
          .send({
            date: "2026-04-21",
            links: [{ accountId, url: "https://www.facebook.com/share/r/181uwpf9M7/", platform: "facebook" }],
          });

        expect(res.status).toBe(201);
        expect(res.body.data.links.length).toBe(1); // additive — never dropped
        expect(res.body.data.links[0].url).toBe("https://www.facebook.com/reel/841188021963723");
      } finally {
        __setShareResolverForTesting(null);
      }
    });

    it("submit-time FB resolution hands the resolver an AbortSignal (budget can cancel in-flight probes)", async () => {
      // Prove the wall-clock budget is wired to actually cancel work: the resolver
      // must be invoked WITH a signal argument.
      let receivedSignal: AbortSignal | undefined | "absent" = "absent";
      __setShareResolverForTesting(async (_url: string, signal?: AbortSignal) => {
        receivedSignal = signal;
        return null; // no clean url → original kept (fail-open path)
      });
      try {
        const res = await request(app)
          .post("/v1/hr/reports")
          .set("Authorization", `Bearer ${hrToken}`)
          .send({
            date: "2026-04-23",
            links: [{ accountId, url: "https://www.facebook.com/share/r/abc999/", platform: "facebook" }],
          });

        expect(res.status).toBe(201);
        expect(res.body.data.links.length).toBe(1);
        // The resolver was handed an AbortSignal (not undefined) — budget is wired.
        expect(receivedSignal).not.toBe("absent");
        expect(receivedSignal).toBeInstanceOf(AbortSignal);
      } finally {
        __setShareResolverForTesting(null);
      }
    });

    it("submit-time FB resolution leaves NON-/share/ urls untouched (no-op for IG/clean links)", async () => {
      // The resolver must never even be asked about non-/share/ urls; assert via a
      // resolver that would corrupt anything it touched.
      const seen: string[] = [];
      __setShareResolverForTesting(async (url: string) => {
        seen.push(url);
        return "https://www.facebook.com/reel/000000000";
      });
      try {
        const res = await request(app)
          .post("/v1/hr/reports")
          .set("Authorization", `Bearer ${hrToken}`)
          .send({
            date: "2026-04-22",
            links: [{ accountId, url: "https://instagram.com/reel/ABC123", platform: "instagram" }],
          });

        expect(res.status).toBe(201);
        expect(res.body.data.links[0].url).toBe("https://instagram.com/reel/ABC123");
        expect(seen).toHaveLength(0); // resolver never invoked for a non-/share/ url
      } finally {
        __setShareResolverForTesting(null);
      }
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

    it("in-submission duplicates are silently merged (keep-first), NOT rejected with 400", async () => {
      // The same URL twice in one submission used to throw 400 DUPLICATE_LINKS.
      // Now the server keeps the first and drops the rest — submit always succeeds.
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-15",
          links: [
            { accountId, url: "https://instagram.com/p/dup-1", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/dup-1", platform: "instagram" }, // exact repeat
            { accountId, url: "https://instagram.com/p/unique-1", platform: "instagram" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.links.length).toBe(2); // 3 sent, 1 dropped as dup
      const urls = res.body.data.links.map((l: any) => l.url).sort();
      expect(urls).toEqual(["https://instagram.com/p/dup-1", "https://instagram.com/p/unique-1"]);
      // dedupe summary reports the silent drop so the client can explain it
      expect(res.body.data.dedupe).toEqual({ inSubmission: 1, crossDay: 0, total: 1 });
    });

    it("merges Instagram reels that differ only by ?igsh= within one submission (canonical key)", async () => {
      // Same reel copied twice → different igsh tokens → must collapse to one.
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-16",
          links: [
            { accountId, url: "https://www.instagram.com/reel/DZJyjhBKN5-/?igsh=AAA", platform: "instagram" },
            { accountId, url: "https://www.instagram.com/reel/DZJyjhBKN5-/?igsh=BBB", platform: "instagram" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.links.length).toBe(1); // same reel, merged to one
      expect(res.body.data.dedupe).toEqual({ inSubmission: 1, crossDay: 0, total: 1 });
    });

    it("reports zero dedupe when all links are unique (no false 'duplicates skipped')", async () => {
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-21",
          links: [
            { accountId, url: "https://www.instagram.com/reel/UniqueOne11/?igsh=AAA", platform: "instagram" },
            { accountId, url: "https://www.instagram.com/reel/UniqueTwo22/?igsh=BBB", platform: "instagram" },
            { accountId, url: "https://www.instagram.com/reel/UniqueThr33/?igsh=CCC", platform: "instagram" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.links.length).toBe(3);
      expect(res.body.data.dedupe).toEqual({ inSubmission: 0, crossDay: 0, total: 0 });
    });

    it("drops an Instagram reel cross-day even when the ?igsh= token differs from the stored one", async () => {
      // Day 1: post the reel with one igsh token.
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-17",
          links: [{ accountId, url: "https://www.instagram.com/reel/CrossDayCode/?igsh=ORIGINAL", platform: "instagram" }],
        });

      // Day 2: re-copy the SAME reel (fresh igsh) + one genuinely new reel.
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-18",
          links: [
            { accountId, url: "https://www.instagram.com/reel/CrossDayCode/?igsh=DIFFERENT_999", platform: "instagram" },
            { accountId, url: "https://www.instagram.com/reel/BrandNewCode/?igsh=xyz", platform: "instagram" },
          ],
        });

      expect(res.status).toBe(201);
      // The re-copied reel is recognized as the same content and dropped; only the new one remains.
      expect(res.body.data.links.length).toBe(1);
      expect(res.body.data.links[0].url).toContain("BrandNewCode");
      // The drop is attributed to cross-day (not in-submission) so the copy is accurate.
      expect(res.body.data.dedupe).toEqual({ inSubmission: 0, crossDay: 1, total: 1 });
    });

    it("igsh-variant merge keeps the EARLIEST firstSeenAt across a same-day resubmit", async () => {
      // Submit the reel once (igsh=AAA) → firstSeenAt = T1.
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-19",
          links: [{ accountId, url: "https://www.instagram.com/reel/FirstSeenCode/?igsh=AAA", platform: "instagram" }],
        });
      const firstRow = await prisma.reportLink.findFirst({
        where: { url: { contains: "FirstSeenCode" } },
        select: { firstSeenAt: true },
      });
      const t1 = firstRow!.firstSeenAt;

      await new Promise((r) => setTimeout(r, 25));

      // Resubmit SAME day with the same reel but a DIFFERENT igsh (+ a new link).
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-19",
          links: [
            { accountId, url: "https://www.instagram.com/reel/FirstSeenCode/?igsh=BBB", platform: "instagram" },
            { accountId, url: "https://www.instagram.com/reel/FirstSeenNew/?igsh=zzz", platform: "instagram" },
          ],
        });

      const after = await prisma.reportLink.findFirst({
        where: { url: { contains: "FirstSeenCode" } },
        select: { firstSeenAt: true },
      });
      // firstSeenAt preserved by canonical key even though the URL string changed.
      expect(after!.firstSeenAt.getTime()).toBe(t1.getTime());
    });

    it("keeps two DIFFERENT Facebook opaque /share/ links as distinct (never over-collapse)", async () => {
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-20",
          links: [
            { accountId, url: "https://www.facebook.com/share/r/16abcXYZ/", platform: "facebook" },
            { accountId, url: "https://www.facebook.com/share/r/99zzzQQQ/", platform: "facebook" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.links.length).toBe(2); // distinct opaque shares both survive
    });

    it("keeps two YouTube videos that differ only by id case (ids are case-sensitive)", async () => {
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-21",
          links: [
            { accountId, url: "https://youtube.com/watch?v=dQw4w9WgXcQ", platform: "youtube" },
            { accountId, url: "https://youtube.com/watch?v=DQW4W9WGXCQ", platform: "youtube" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.data.links.length).toBe(2); // different videos — neither dropped
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

    it("paginates: defaults to 50/page and reports meta", async () => {
      // getAllReports used to be unbounded (incident 2026-07-08 — OOM'd mobile
      // browsers + held pooled DB connections for the full unbounded query).
      // Seed 55 reports (one per date, since DailyReport is unique per
      // employee+date) to exercise the default page size.
      for (let i = 0; i < 55; i++) {
        const day = String((i % 28) + 1).padStart(2, "0");
        const month = i < 28 ? "01" : "02";
        await request(app)
          .post("/v1/hr/reports")
          .set("Authorization", `Bearer ${hrToken}`)
          .send({
            date: `2025-${month}-${day}`,
            links: [{ accountId, url: `https://instagram.com/p/page-${i}`, platform: "instagram" }],
          });
      }

      const page1 = await request(app)
        .get("/v1/admin/reports")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(page1.status).toBe(200);
      expect(page1.body.data.length).toBe(50);
      expect(page1.body.meta).toMatchObject({ page: 1, pageSize: 50, total: 55, hasMore: true });

      const page2 = await request(app)
        .get("/v1/admin/reports?page=2&pageSize=50")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(page2.status).toBe(200);
      expect(page2.body.data.length).toBe(5);
      expect(page2.body.meta).toMatchObject({ page: 2, pageSize: 50, total: 55, hasMore: false });
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

    it("aggregates platform breakdown across platforms and days (groupBy rewrite)", async () => {
      // getReportSummary was rewritten (2026-07-09) to derive per-report platform
      // COUNTS via a DB groupBy instead of hydrating every report_links row into
      // Node heap (the OOM/502 fix). This locks in that the aggregation output is
      // byte-identical: correct per-platform counts, totalLinks, and reportCount
      // across MULTIPLE platforms and MULTIPLE days for one employee.
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-03-01",
          links: [
            { accountId, url: "https://instagram.com/p/m1", platform: "instagram" },
            { accountId, url: "https://instagram.com/p/m2", platform: "instagram" },
            { accountId, url: "https://facebook.com/reel/100", platform: "facebook" },
          ],
        });
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-03-02",
          links: [
            { accountId, url: "https://youtube.com/watch?v=aaa", platform: "youtube" },
            { accountId, url: "https://instagram.com/p/m3", platform: "instagram" },
          ],
        });

      const res = await request(app)
        .get("/v1/admin/reports/summary?startDate=2026-03-01&endDate=2026-03-02")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const entry = res.body.data.employees.find((e: any) => e.id === employeeId);
      expect(entry).toBeDefined();
      expect(entry.reportCount).toBe(2);       // two distinct days
      expect(entry.totalLinks).toBe(5);        // 3 + 2
      // Per-employee platform breakdown: instagram 3, facebook 1, youtube 1
      const pb: Record<string, number> = {};
      for (const p of entry.platformBreakdown) pb[p.platform] = p.count;
      expect(pb.instagram).toBe(3);
      expect(pb.facebook).toBe(1);
      expect(pb.youtube).toBe(1);
      // Team-wide breakdown should reflect the same totals for this single employee
      const teamPb: Record<string, number> = {};
      for (const p of res.body.data.platformBreakdown) teamPb[p.platform] = p.count;
      expect(teamPb.instagram).toBeGreaterThanOrEqual(3);
      expect(res.body.data.totalLinks).toBeGreaterThanOrEqual(5);
    });

    it("requires admin auth", async () => {
      const res = await request(app)
        .get("/v1/admin/reports/summary")
        .set("Authorization", `Bearer ${hrToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe("submitDailyReportSchema — oversized URL guard (btree 54000 fix)", () => {
    const base = {
      date: "2026-07-09",
      links: [
        {
          accountId: "11111111-1111-1111-1111-111111111111",
          url: "https://instagram.com/reel/" + "A".repeat(3000), // ~3027 bytes > 2704 btree limit
          platform: "instagram",
        },
      ],
    };

    it("rejects a URL longer than 2048 chars with a structured field error (not a thrown 500)", () => {
      const result = submitDailyReportSchema.safeParse(base);
      expect(result.success).toBe(false);
      if (!result.success) {
        const urlIssue = result.error.issues.find((i) => i.path.join(".") === "links.0.url");
        expect(urlIssue).toBeTruthy();
        expect(urlIssue!.message).toMatch(/too long/i);
      }
    });

    it("accepts a normal-length URL", () => {
      const ok = { ...base, links: [{ ...base.links[0], url: "https://instagram.com/reel/DaUlZhNoAbc" }] };
      expect(submitDailyReportSchema.safeParse(ok).success).toBe(true);
    });
  });
});
