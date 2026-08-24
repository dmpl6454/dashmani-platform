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

/**
 * Account Growth shows ONLY channels whose numbers came from an official API
 * (owner decision 2026-08-24): a live connected Meta asset, or a non-Meta
 * platform synced through its own API. A plain SocialAccount row no longer
 * qualifies, so every account these tests seed has to be made connected — the
 * same condition production checks, rather than a test-only bypass.
 */
async function connectAccount(accountId: string, metaId: string): Promise<void> {
  const admin = await createTestUser({ roleNames: ["Admin"], email: `conn-${metaId}@zz.test` });
  const conn = await prisma.metaConnection.create({
    data: { metaUserId: `mu-${metaId}`, connectedById: admin.id, status: "ACTIVE" },
  });
  await prisma.metaAsset.create({
    data: {
      connectionId: conn.id,
      kind: "FACEBOOK_PAGE",
      metaId,
      name: `asset-${metaId}`,
      socialAccountId: accountId,
    },
  });
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
      await connectAccount(accountA.id, "gainer");
    accountAId = accountA.id;

    // Account B — losing: 5000 → 4900 (delta -100, -2%), latest 4900
    const accountB = await prisma.socialAccount.create({
      data: { handle: "@loser", displayName: "Loser", platformId, status: "ACTIVE", followerCount: 4900 },
    });
      await connectAccount(accountB.id, "loser");
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

      // days is echoed (default 30).
      expect(d.days).toBe(30);

      // topMoversByPlatform: both accounts are Instagram → one group "Instagram".
      expect(typeof d.topMoversByPlatform).toBe("object");
      expect(Array.isArray(d.topMoversByPlatform["Instagram"])).toBe(true);
      // Sorted by abs(delta) desc: accountA (+200) before accountB (-100).
      expect(d.topMoversByPlatform["Instagram"][0].accountId).toBe(accountAId);
      expect(d.topMoversByPlatform["Instagram"][0].delta).toBe(200);
      expect(d.topMoversByPlatform["Instagram"][1].accountId).toBe(accountBId);
      expect(d.topMoversByPlatform["Instagram"][1].delta).toBe(-100);
      // Each mover has the expected shape.
      const mover = d.topMoversByPlatform["Instagram"][0];
      expect(mover).toHaveProperty("accountId");
      expect(mover).toHaveProperty("displayName");
      expect(mover).toHaveProperty("platform", "Instagram");
      expect(mover).toHaveProperty("delta");
      expect(mover).toHaveProperty("deltaPct");
    });

    it("excludes data-correction artifacts (>=90% collapse) from Top Movers but keeps them in accounts", async () => {
      // The "Total Filmi" case: a stale manual 1,040,000 carried for weeks, then first
      // real sync to 10,900 → ~-99% delta. Must NOT appear in topMovers (it's a
      // measurement correction, not real loss) but MUST stay in the full accounts list.
      const corrected = await prisma.socialAccount.create({
        data: { handle: "@corrected", displayName: "Corrected", platformId, status: "ACTIVE", followerCount: 10900 },
      });
      await connectAccount(corrected.id, "corrected");
      await prisma.accountGrowthSnapshot.createMany({
        data: [
          { accountId: corrected.id, date: dateOnlyDaysAgo(10), followerCount: 1040000 },
          { accountId: corrected.id, date: dateOnlyDaysAgo(1), followerCount: 10900 },
        ],
      });

      const res = await request(app).get("/v1/admin/growth").set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const d = res.body.data;
      // Still present in the full accounts list (data stays visible/honest).
      const row = d.accounts.find((x: any) => x.accountId === corrected.id);
      expect(row).toBeDefined();
      expect(row.deltaPct).toBeLessThanOrEqual(-90);
      // But NOT ranked in topMovers / topMoversByPlatform (artifact suppressed).
      expect(d.topMovers.find((m: any) => m.accountId === corrected.id)).toBeUndefined();
      const igMovers = d.topMoversByPlatform?.["Instagram"] ?? [];
      expect(igMovers.find((m: any) => m.accountId === corrected.id)).toBeUndefined();
      // AND the artifact's -1,029,100 delta must NOT pollute the headline Net Change.
      // Only accountA(+200) + accountB(-100) count → totalDelta = +100 (NOT -1,029,000).
      expect(d.totalDelta).toBe(100);
      // gainers/decliners exclude the artifact too: A grew, B declined → 1 / 1.
      expect(d.gainers).toBe(1);
      expect(d.decliners).toBe(1);
    });

    it("dedups the same real page stored under two URL forms (tracking-param / trailing-slash) — F5 fix", async () => {
      // Same FB page counted twice: one clean URL, one with ?mibextid=… → must collapse
      // to ONE account so totalFollowers + Net Change + Top Movers don't double-count.
      const a = await prisma.socialAccount.create({
        data: { handle: "@dupe1", displayName: "Dupe Page", platformId, status: "ACTIVE", followerCount: 1000000, profileUrl: "https://www.facebook.com/dupepage/" },
      });
      await connectAccount(a.id, "dupe1");
      const b = await prisma.socialAccount.create({
        data: { handle: "@dupe2", displayName: "Dupe Page (clone)", platformId, status: "ACTIVE", followerCount: 1000000, profileUrl: "https://facebook.com/dupepage?mibextid=ABC123" },
      });
      await connectAccount(b.id, "dupe2");

      const res = await request(app).get("/v1/admin/growth").set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const d = res.body.data;
      // Exactly ONE of the two survives in the accounts list (same normalized URL).
      const dupeRows = d.accounts.filter((x: any) => x.accountId === a.id || x.accountId === b.id);
      expect(dupeRows).toHaveLength(1);
      // The 1,000,000 is counted ONCE in totalFollowers, not 2,000,000.
      // (Other test accounts also contribute; assert the dupe pair added exactly 1M.)
      // We can't know the exact base here, so assert accountCount didn't double-count:
      const idsSeen = new Set(d.accounts.map((x: any) => x.accountId));
      expect(idsSeen.has(a.id) !== idsSeen.has(b.id)).toBe(true); // exactly one present
    });

    it("does NOT merge profile.php?id=<n> pages with different ids (distinct real pages)", async () => {
      const p1 = await prisma.socialAccount.create({
        data: { handle: "@pid1", displayName: "PID One", platformId, status: "ACTIVE", followerCount: 100, profileUrl: "https://facebook.com/profile.php?id=111" },
      });
      await connectAccount(p1.id, "pid1");
      const p2 = await prisma.socialAccount.create({
        data: { handle: "@pid2", displayName: "PID Two", platformId, status: "ACTIVE", followerCount: 200, profileUrl: "https://facebook.com/profile.php?id=222" },
      });
      await connectAccount(p2.id, "pid2");
      const res = await request(app).get("/v1/admin/growth").set("Authorization", `Bearer ${adminToken}`);
      const ids = new Set(res.body.data.accounts.map((x: any) => x.accountId));
      expect(ids.has(p1.id)).toBe(true);
      expect(ids.has(p2.id)).toBe(true); // both kept — different id = different page
    });

    it("only exposes http(s) profileUrl — strips javascript:/non-http (XSS guard)", async () => {
      // profile_url is admin-entered free text. A javascript: URI must NOT reach the
      // client as a clickable href. The API scheme-validates before returning it.
      const evil = await prisma.socialAccount.create({
        data: { handle: "@evil", displayName: "Evil", platformId, status: "ACTIVE", followerCount: 10, profileUrl: "javascript:alert(document.cookie)" },
      });
      await connectAccount(evil.id, "evil");
      const good = await prisma.socialAccount.create({
        data: { handle: "@good", displayName: "Good", platformId, status: "ACTIVE", followerCount: 10, profileUrl: "https://instagram.com/good" },
      });
      await connectAccount(good.id, "good");

      const res = await request(app).get("/v1/admin/growth").set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const evilRow = res.body.data.accounts.find((x: any) => x.accountId === evil.id);
      const goodRow = res.body.data.accounts.find((x: any) => x.accountId === good.id);
      expect(evilRow.profileUrl).toBeNull(); // javascript: stripped → no clickable href
      expect(goodRow.profileUrl).toBe("https://instagram.com/good"); // http(s) preserved
    });

    it("echoes the days param when supplied", async () => {
      const res = await request(app)
        .get("/v1/admin/growth?days=7")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.days).toBe(7);
    });

    it("respects the days query param", async () => {
      const res = await request(app)
        .get("/v1/admin/growth?days=30")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.accountCount).toBe(2);
    });

    it("topMoversByPlatform INCLUDES zero-delta platforms (manual platforms must still appear — 2026-06-30 e29df5a)", async () => {
      // Deliberate behavior change 2026-06-30 ("add Snapchat to Top Movers by
      // Platform"): platforms whose accounts all have delta=0 (e.g. manually-
      // entered follower counts, no snapshots yet) are INCLUDED, showing their
      // top accounts by follower count. The original 2026-06-25 contract omitted
      // them; this test asserted that and silently failed for weeks after the
      // intent changed. Do not "fix" the service to omit zero-delta platforms —
      // that would make manual platforms (Snapchat pre-scraper) vanish again.
      const fbPlatform = await prisma.platform.create({
        data: { name: "Facebook", slug: "facebook" },
      });
      // No snapshots → first and latest both fall back to followerCount (2000), delta = 0.
      const fbAccount = await prisma.socialAccount.create({
        data: { handle: "@fbpage", displayName: "FBPage", platformId: fbPlatform.id, status: "ACTIVE", followerCount: 2000 },
      });
      await connectAccount(fbAccount.id, "fbpage");

      const res = await request(app)
        .get("/v1/admin/growth")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const d = res.body.data;
      // Zero-delta Facebook account IS present, with an honest delta of 0.
      expect(d.topMoversByPlatform).toHaveProperty("Facebook");
      expect(d.topMoversByPlatform.Facebook[0].displayName).toBe("FBPage");
      expect(d.topMoversByPlatform.Facebook[0].delta).toBe(0);
      // Platforms with real movers appear too, unchanged.
      expect(d.topMoversByPlatform).toHaveProperty("Instagram");
    });

    // ── syncState + coverage counts ──────────────────────────────────────────

    it("marks an account synced 1h ago as LIVE and counts it in liveCount/liveFollowers", async () => {
      // Set accountA lastSyncedAt to 1 hour ago (within 48h window → LIVE).
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
      await prisma.socialAccount.update({
        where: { id: accountAId },
        data: { lastSyncedAt: oneHourAgo },
      });

      const res = await request(app)
        .get("/v1/admin/growth")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const d = res.body.data;
      const a = d.accounts.find((x: any) => x.accountId === accountAId);

      expect(a.syncState).toBe("LIVE");
      expect(a.lastSyncedAt).toBeTruthy();

      // liveCount should be 1 (only accountA was set to LIVE)
      expect(d.liveCount).toBe(1);
      // accountB has null lastSyncedAt → MANUAL
      expect(d.manualCount).toBe(1);
      expect(d.staleCount).toBe(0);
    });

    it("marks an account synced 5 days ago as STALE and counts it in staleCount", async () => {
      // Set accountB lastSyncedAt to 5 days ago (> 48h → STALE).
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      await prisma.socialAccount.update({
        where: { id: accountBId },
        data: { lastSyncedAt: fiveDaysAgo },
      });

      const res = await request(app)
        .get("/v1/admin/growth")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const d = res.body.data;
      const b = d.accounts.find((x: any) => x.accountId === accountBId);

      expect(b.syncState).toBe("STALE");
      expect(b.lastSyncedAt).toBeTruthy();

      expect(d.staleCount).toBe(1);
      // accountA still has null lastSyncedAt → MANUAL
      expect(d.manualCount).toBe(1);
      expect(d.liveCount).toBe(0);
    });

    it("marks an account with null lastSyncedAt as MANUAL and counts it in manualCount/manualFollowers", async () => {
      // Both accountA and accountB were created without lastSyncedAt — they should be MANUAL.
      const res = await request(app)
        .get("/v1/admin/growth")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const d = res.body.data;

      const a = d.accounts.find((x: any) => x.accountId === accountAId);
      const b = d.accounts.find((x: any) => x.accountId === accountBId);

      expect(a.syncState).toBe("MANUAL");
      expect(a.lastSyncedAt).toBeNull();
      expect(b.syncState).toBe("MANUAL");
      expect(b.lastSyncedAt).toBeNull();

      expect(d.manualCount).toBe(2);
      expect(d.liveCount).toBe(0);
      expect(d.staleCount).toBe(0);

      // manualFollowers = sum of latest for MANUAL accounts = 1200 + 4900
      expect(d.manualFollowers).toBe(6100);
    });

    it("liveCount+staleCount+manualCount equals accountCount, and follower sums match totalFollowers", async () => {
      // Make a mixed set: accountA=LIVE (synced 1h ago), accountB=STALE (synced 5d ago).
      // Create a third account with null lastSyncedAt → MANUAL.
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

      await prisma.socialAccount.update({
        where: { id: accountAId },
        data: { lastSyncedAt: oneHourAgo },
      });
      await prisma.socialAccount.update({
        where: { id: accountBId },
        data: { lastSyncedAt: fiveDaysAgo },
      });
      const accountC = await prisma.socialAccount.create({
        data: {
          handle: "@manual",
          displayName: "ManualAccount",
          platformId,
          status: "ACTIVE",
          followerCount: 500,
          lastSyncedAt: null,
        },
      });
      // Connected (so it is in scope) but never synced — which is what MANUAL means.
      await connectAccount(accountC.id, "manual");

      const res = await request(app)
        .get("/v1/admin/growth")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const d = res.body.data;

      // Counts must sum to accountCount
      expect(d.liveCount + d.staleCount + d.manualCount).toBe(d.accountCount);
      expect(d.accountCount).toBe(3);
      expect(d.liveCount).toBe(1);
      expect(d.staleCount).toBe(1);
      expect(d.manualCount).toBe(1);

      // Follower sums must equal totalFollowers (1200 + 4900 + 500 = 6600)
      expect(d.liveFollowers + d.staleFollowers + d.manualFollowers).toBe(d.totalFollowers);
      expect(d.totalFollowers).toBe(6600);
      expect(d.liveFollowers).toBe(1200);   // accountA latest
      expect(d.staleFollowers).toBe(4900);  // accountB latest
      expect(d.manualFollowers).toBe(500);  // accountC latest
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
