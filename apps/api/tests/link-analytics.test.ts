/**
 * Link Analytics (sales portal /links) — intake, the worker against a fake Graph, statuses,
 * live-vs-cached, pause/resume/restart, reports, exports, retention and the route gates.
 * Spec: docs/link-analytics/SPEC.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { encryptToken } from "../src/utils/token-crypto";
import { runLinkAnalyticsTick, __resetWorkerForTesting, RETRY_DELAYS_MIN } from "../src/services/link-analytics/worker";
import { buildReport } from "../src/services/link-analytics/report.service";
import { exportBatch } from "../src/services/link-analytics/export.service";
import { runLinkAnalyticsRetention } from "../src/services/link-analytics/retention.service";
import type { GraphFn } from "../src/services/link-analytics/types";
import { createTestRole, createTestUser, generateToken } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const XLSX = require("xlsx-js-style");

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
type Call = { path: string; fields: string; label: string };

/** A fake Graph: our IG account @ourpage (media OWN1), our FB Page 111 (post 1111111_2222222), a third-party
 *  business account @brandx (reel BX1 + photo BX2), a personal account @someone (not readable). */
function fakeGraph(calls: Call[], opts: { failOwn?: "rate" | "deleted" | "network" } = {}): GraphFn {
  return (async (path: string, params: Record<string, string | number | undefined>, _token: string, label: string) => {
    const fields = String(params.fields ?? "");
    calls.push({ path, fields, label });
    const ok = (data: unknown) => ({ ok: true, rateLimited: false, authInvalid: false, status: 200, usage: { source: "buc" as const, callCountPct: 5, usagePct: 5, regainMinutes: null }, data });
    if (path === "OWNMEDIA1") {
      if (opts.failOwn === "rate") return { ok: false, rateLimited: true, authInvalid: false, status: 400, usage: null, error: "(#4) rate limit", errorCode: 4 };
      if (opts.failOwn === "network") return { ok: false, rateLimited: false, authInvalid: false, status: 0, usage: null, error: "fetch failed" };
      if (opts.failOwn === "deleted") return { ok: false, rateLimited: false, authInvalid: false, status: 400, usage: null, error: "(#100) Object does not exist", errorCode: 100, errorSubcode: 33 };
      return ok({
        id: "OWNMEDIA1", shortcode: "OWNCODE1", caption: "Our reel", like_count: 120, comments_count: 8, media_type: "VIDEO", media_product_type: "REELS",
        timestamp: "2026-11-20T10:00:00+0000", thumbnail_url: "https://cdn.example/x.jpg",
        insights: { data: [{ name: "reach", values: [{ value: 4000 }] }, { name: "views", values: [{ value: 9000 }] }, { name: "saved", values: [{ value: 15 }] }, { name: "shares", values: [{ value: 22 }] }] },
      });
    }
    if (path === "1111111_2222222") {
      return ok({ id: "1111111_2222222", message: "FB post", created_time: "2026-11-21T08:00:00+0000", likes: { summary: { total_count: 50 } }, comments: { summary: { total_count: 5 } },
        insights: { data: [{ name: "post_media_view", values: [{ value: 3000 }] }, { name: "post_total_media_view_unique", values: [{ value: 1500 }] }] } });
    }
    if (path === "IGBIZ") {
      // Meta rejects `shortcode` inside business_discovery media (live, 2026-11-25): mirror that.
      if (fields.includes("business_discovery") && /media[^{]*\{[^}]*\bshortcode\b/.test(fields)) {
        return { ok: false, rateLimited: false, authInvalid: false, status: 400, usage: null, error: "(#100) Please read documentation for supported fields.", errorCode: 100 };
      }
      if (fields.includes("username(brandx)")) {
        return ok({ business_discovery: { id: "X", username: "brandx", name: "Brand X", followers_count: 10000, media: { data: [
          { id: "m1", permalink: "https://www.instagram.com/reel/BXREEL1/", like_count: 300, comments_count: 30, view_count: 20000, media_product_type: "REELS", timestamp: "2026-11-22T00:00:00+0000" },
          { id: "m2", permalink: "https://www.instagram.com/p/BXPHOTO2/", like_count: 100, comments_count: 10, view_count: 999, media_product_type: "FEED" },
        ] } } });
      }
      return { ok: false, rateLimited: false, authInvalid: false, status: 400, usage: null, error: "(#110) Cannot find User", errorCode: 110 };
    }
    if (path === "999888777") return { ok: false, rateLimited: false, authInvalid: false, status: 400, usage: null, error: "(#10) requires Page Public Content Access", errorCode: 10 };
    return { ok: false, rateLimited: false, authInvalid: false, status: 404, usage: null, error: `unexpected ${path}` };
  }) as GraphFn;
}

describe("link analytics", () => {
  let salesToken: string;
  let employeeToken: string;
  let userId: string;
  const calls: Call[] = [];

  beforeEach(async () => {
    __resetWorkerForTesting();
    calls.length = 0;
    await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Employee", [{ resource: "tasks", action: "view", scope: "own" }]);
    const s = await createTestUser({ roleNames: ["Sales"] });
    const e = await createTestUser({ roleNames: ["Employee"] });
    userId = s.id;
    salesToken = generateToken(s.id, s.email, ["Sales"]);
    employeeToken = generateToken(e.id, e.email, ["Employee"]);

    const conn = await prisma.metaConnection.create({ data: { metaUserId: "fbuser1", connectedById: s.id, userTokenEnc: encryptToken("USER-TOKEN") } });
    const ig = await prisma.metaAsset.create({ data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "IGBIZ", name: "Our Page", username: "ourpage", followerCount: 50000 } });
    const fb = await prisma.metaAsset.create({ data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "1111111", name: "Our FB Page", username: "ourfbpage", followerCount: 80000, pageTokenEnc: encryptToken("PAGE-TOKEN") } });
    await prisma.metaPost.create({ data: { assetId: ig.id, metaPostId: "OWNMEDIA1", matchId: "OWNCODE1", likes: 100, views: 7000, metricsStatus: "ok", metricsFetchedAt: new Date(Date.now() - 3 * 3600_000) } });
    await prisma.metaPost.create({ data: { assetId: fb.id, metaPostId: "1111111_2222222", matchId: "2222222" } });
  });
  afterEach(() => __resetWorkerForTesting());

  const LINKS = [
    "https://www.instagram.com/reel/OWNCODE1/",                 // ours → Verified
    "https://www.instagram.com/brandx/reel/BXREEL1/",           // third-party business → Restricted (public)
    "https://www.instagram.com/brandx/p/BXPHOTO2/",             // third-party photo → no views
    "https://www.instagram.com/p/NOUSER123/",                   // no username → Restricted
    "https://www.instagram.com/someone/p/PERSONAL1/",           // personal account → Restricted
    "https://www.facebook.com/ourfbpage/posts/2222222",             // our FB → Verified
    "https://www.facebook.com/reel/999888777",                  // not ours → Restricted
    "https://www.facebook.com/share/r/OPAQUE1/",                // unresolvable → Restricted
    "https://instagram.com/reel/OWNCODE1?igsh=dup",             // duplicate
    "not a link",                                               // invalid
  ].join("\n");

  async function create(text = LINKS, extra: Record<string, unknown> = {}) {
    const r = await request(app).post("/v1/sales/links/batches").set(auth(salesToken)).send({ name: "Diwali push", text, ...extra });
    expect(r.status).toBe(201);
    return r.body.data as { id: string; counts: Record<string, number> };
  }
  const tick = (graph = fakeGraph(calls)) => runLinkAnalyticsTick({ graph, resolveOpaqueFacebook: async () => null });
  const postByKey = (k: string) => prisma.linkPost.findUniqueOrThrow({ where: { postKey: k } });

  it("intake counts: total, valid, invalid, unique, duplicate, pending", async () => {
    const b = await create();
    expect(b.counts).toEqual({ total: 10, valid: 8, invalid: 1, unique: 8, duplicate: 1 });
    const g = await request(app).get(`/v1/sales/links/batches/${b.id}`).set(auth(salesToken));
    expect(g.body.data.counts).toMatchObject({ total: 10, valid: 8, invalid: 1, unique: 8, duplicate: 1, pending: 8 });
    expect(g.body.data.state).toBe("running");
  });

  it("the worker reads each post the way Meta allows, and never invents a zero", async () => {
    const b = await create();
    expect(await tick()).toBe(8);

    const own = await postByKey("ig:OWNCODE1");
    expect(own).toMatchObject({ status: "verified", access: "full", dataSource: "meta_graph", views: 9000, reach: 4000, likes: 120, comments: 8, shares: 22, saves: 15, followers: 50000, accountName: "Our Page", postType: "reel" });

    const bx = await postByKey("ig:BXREEL1");
    expect(bx).toMatchObject({ status: "restricted", access: "public", dataSource: "meta_business_discovery", views: 20000, likes: 300, comments: 30, followers: 10000, username: "brandx" });
    expect(bx.reach).toBeNull();
    expect(bx.shares).toBeNull();
    expect(bx.saves).toBeNull();
    const photo = await postByKey("ig:BXPHOTO2");
    expect(photo.views).toBeNull(); // view_count is documented for reels only
    // One business-discovery read covers both @brandx posts.
    expect(calls.filter((c) => c.label === "links-ig-discovery" && c.fields.includes("username(brandx)"))).toHaveLength(1);

    expect(await postByKey("ig:NOUSER123")).toMatchObject({ status: "restricted", access: "none", statusReason: "ig_no_username", likes: null });
    expect(await postByKey("ig:PERSONAL1")).toMatchObject({ status: "restricted", statusReason: "ig_account_not_public" });

    const fb = await postByKey("fb:2222222");
    expect(fb).toMatchObject({ status: "verified", views: 3000, reach: 1500, likes: 50, comments: 5, shares: null, saves: null });
    expect(await postByKey("fb:999888777")).toMatchObject({ status: "restricted", statusReason: "fb_not_our_page", views: null });
    expect(await postByKey("fbx:https://www.facebook.com/share/r/OPAQUE1/")).toMatchObject({ status: "restricted", statusReason: "fb_unresolvable_link" });

    // Finished: the batch is idle, every check has a snapshot.
    expect((await prisma.linkBatch.findUniqueOrThrow({ where: { id: b.id } })).state).toBe("idle");
    expect(await prisma.linkPostSnapshot.count()).toBe(8);
    const list = await request(app).get(`/v1/sales/links/batches/${b.id}/items?sort=views&dir=desc`).set(auth(salesToken));
    expect(list.body.data.rows[0].post).toMatchObject({ views: 20000, freshness: "live" });
    expect(list.body.data.total).toBe(8);
  });

  it("a Facebook reel's reach of 0 next to real views is unavailable, never a zero", async () => {
    await create("https://www.facebook.com/ourfbpage/posts/2222222");
    const base = fakeGraph(calls);
    const graph = (async (...args: Parameters<GraphFn>) => {
      const r = (await base(...args)) as { ok: boolean; data?: { insights?: unknown } };
      if (args[0] === "1111111_2222222" && r.ok && r.data) {
        r.data.insights = { data: [{ name: "post_media_view", values: [{ value: 3000 }] }, { name: "post_total_media_view_unique", values: [{ value: 0 }] }] };
      }
      return r;
    }) as GraphFn;
    await tick(graph);
    expect(await postByKey("fb:2222222")).toMatchObject({ status: "verified", views: 3000, reach: null });
  });

  it("a post in two batches is fetched once; a fresh post is not fetched again", async () => {
    await create("https://www.instagram.com/reel/OWNCODE1/");
    await tick();
    const before = calls.length;
    const b2 = await create("https://www.instagram.com/p/OWNCODE1/\nhttps://www.facebook.com/ourfbpage/posts/2222222");
    expect(await prisma.linkPost.count({ where: { postKey: "ig:OWNCODE1" } })).toBe(1);
    await tick();
    expect(calls.slice(before).map((c) => c.path)).toEqual(["1111111_2222222"]); // OWNCODE1 was checked minutes ago
    expect((await prisma.linkBatch.findUniqueOrThrow({ where: { id: b2.id } })).state).toBe("idle");
    // The per-post refresh forces it.
    const p = await postByKey("ig:OWNCODE1");
    expect((await request(app).post(`/v1/sales/links/batches/${b2.id}/posts/${p.id}/refresh`).set(auth(salesToken))).status).toBe(200);
    await tick();
    expect(calls.at(-1)!.path).toBe("OWNMEDIA1");
    expect((await postByKey("ig:OWNCODE1")).checkCount).toBe(2);
  });

  it("pause stops fetching; resume continues; a lapsed lease is claimed again after a restart", async () => {
    const b = await create("https://www.instagram.com/reel/OWNCODE1/\nhttps://www.facebook.com/ourfbpage/posts/2222222");
    expect((await request(app).post(`/v1/sales/links/batches/${b.id}/pause`).set(auth(salesToken))).status).toBe(200);
    expect(await tick()).toBe(0);
    expect(calls).toHaveLength(0);
    await request(app).post(`/v1/sales/links/batches/${b.id}/resume`).set(auth(salesToken));
    // Simulate a crash mid-tick: a post claimed with a lease that then lapsed.
    await prisma.linkPost.updateMany({ where: { postKey: "fb:2222222" }, data: { leaseUntil: new Date(Date.now() - 60_000) } });
    expect(await tick()).toBe(2);
    expect((await postByKey("fb:2222222")).status).toBe("verified");
  });

  it("transient errors retry with back-off, then Failed with the platform sync's values marked cached", async () => {
    await create("https://www.instagram.com/reel/OWNCODE1/");
    const g = fakeGraph(calls, { failOwn: "network" });
    for (let i = 0; i <= RETRY_DELAYS_MIN.length; i++) {
      await prisma.linkPost.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await tick(g);
    }
    const p = await postByKey("ig:OWNCODE1");
    expect(p).toMatchObject({ status: "failed", dataSource: "platform_sync", views: 7000, likes: 100, fetchState: "idle" });
    expect(p.errorMessage).toMatch(/Network/);
    const shaped = (await request(app).get(`/v1/sales/links/posts/${p.id}`).set(auth(salesToken))).body.data.post;
    expect(shaped.freshness).toBe("cached");
  });

  it("a rate limit pauses the worker and does not use up a retry", async () => {
    await create("https://www.instagram.com/reel/OWNCODE1/");
    await tick(fakeGraph(calls, { failOwn: "rate" }));
    const p = await postByKey("ig:OWNCODE1");
    expect(p).toMatchObject({ fetchState: "queued", attempts: 0 });
    await prisma.linkPost.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect(await tick()).toBe(0); // throttled
    const s = (await request(app).get("/v1/sales/links/batches").set(auth(salesToken))).body.data.worker;
    expect(s.throttledUntil).toBeTruthy();
  });

  it("a deleted post is Failed, not zero", async () => {
    await create("https://www.instagram.com/reel/OWNCODE1/");
    await tick(fakeGraph(calls, { failOwn: "deleted" }));
    expect((await postByKey("ig:OWNCODE1")).errorMessage).toMatch(/no longer exists/);
  });

  it("report: sums say N of M, followers count unique accounts once, engagement formulas", async () => {
    const b = await create();
    await tick();
    const r = await buildReport(b.id);
    const k = r.executive.kpis;
    expect(k.posts).toMatchObject({ total: 8, verified: 2, restricted: 6, failed: 0 });
    expect(k.views).toMatchObject({ sum: 9000 + 20000 + 3000, reporting: 3, of: 8 });
    expect(k.shares).toMatchObject({ sum: 22, reporting: 1 });
    // @brandx has two posts but counts once.
    expect(k.followers).toMatchObject({ sum: 50000 + 10000 + 80000, accountsWithFollowers: 3 });
    const own = r.posts.find((p) => p.url.includes("OWNCODE1"))!;
    expect(own).toMatchObject({ engagement: 150, engagementPartial: false, erFollowers: 0.3, erReach: 3.75 });
    const bx = r.posts.find((p) => p.url.includes("BXREEL1"))!;
    expect(bx).toMatchObject({ engagement: 330, engagementPartial: true, erFollowers: 3.3, erReach: null });
    expect(r.engagement.formulas.join(" ")).toMatch(/likes \+ comments \+ shares/);
    expect(r.top.byViews[0].url).toContain("BXREEL1");
    expect(r.executive.dataLimitations.join(" ")).toMatch(/never a zero/);
  });

  it("exports: Excel has the eight sheets, CSV/PDF/JSON are well-formed", async () => {
    const b = await create();
    await tick();
    const x = await exportBatch(b.id, "xlsx");
    const wb = XLSX.read(x.body, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["Executive Summary", "All Posts", "Facebook", "Instagram", "Page-Wise", "Top Posts", "Failed Links", "Extraction History"]);
    const failed = XLSX.utils.sheet_to_json(wb.Sheets["Failed Links"], { header: 1 }) as unknown[][];
    expect(failed.length).toBe(1 + 1 + 4); // header + invalid line + 4 restricted-with-nothing
    const csv = (await exportBatch(b.id, "csv")).body.toString("utf8");
    expect(csv.split("\r\n")).toHaveLength(2 + 8);
    expect((await exportBatch(b.id, "pdf")).body.subarray(0, 4).toString()).toBe("%PDF");
    expect(JSON.parse((await exportBatch(b.id, "json")).body.toString()).posts).toHaveLength(8);
    const http = await request(app).get(`/v1/sales/links/batches/${b.id}/export?format=pdf`).set(auth(salesToken));
    expect(http.status).toBe(200);
    expect(http.headers["content-disposition"]).toMatch(/attachment; filename="Diwali-push-.*\.pdf"/);
  });

  it("schedule enqueues stale posts when due and ends after its window", async () => {
    const b = await create("https://www.instagram.com/reel/OWNCODE1/");
    await tick();
    expect((await request(app).put(`/v1/sales/links/batches/${b.id}/schedule`).set(auth(salesToken)).send({ hours: 7 })).status).toBe(400);
    expect((await request(app).put(`/v1/sales/links/batches/${b.id}/schedule`).set(auth(salesToken)).send({ hours: 6 })).status).toBe(200);
    await prisma.linkBatch.update({ where: { id: b.id }, data: { nextRefreshAt: new Date(Date.now() - 1000) } });
    await prisma.linkPost.updateMany({ data: { lastCheckedAt: new Date(Date.now() - 7 * 3600_000) } });
    await tick();
    expect((await postByKey("ig:OWNCODE1")).checkCount).toBe(2);
    await prisma.linkBatch.update({ where: { id: b.id }, data: { nextRefreshAt: new Date(Date.now() - 1000), scheduleEndsAt: new Date(Date.now() - 1) } });
    await tick();
    expect((await prisma.linkBatch.findUniqueOrThrow({ where: { id: b.id } })).refreshEveryHours).toBeNull();
  });

  it("a username typed for a bare IG link sends it to business discovery", async () => {
    const b = await create("https://www.instagram.com/p/BXREEL1/");
    await tick();
    expect((await postByKey("ig:BXREEL1")).statusReason).toBe("ig_no_username");
    const item = await prisma.linkBatchItem.findFirstOrThrow({ where: { batchId: b.id } });
    expect((await request(app).put(`/v1/sales/links/batches/${b.id}/items/${item.id}/username`).set(auth(salesToken)).send({ username: "@BrandX" })).status).toBe(200);
    await tick();
    expect(await postByKey("ig:BXREEL1")).toMatchObject({ status: "restricted", access: "public", likes: 300 });
  });

  it("retention: archived batches go after 30 days, orphan posts go, old snapshots thin to one per IST day and keep the first", async () => {
    const b = await create("https://www.instagram.com/reel/OWNCODE1/");
    await tick();
    const p = await postByKey("ig:OWNCODE1");
    const day = (d: number, h: number) => new Date(Date.UTC(2026, 9, d, h)); // October 2026, UTC hours
    await prisma.linkPostSnapshot.deleteMany();
    for (const at of [day(1, 1), day(1, 5), day(1, 9), day(2, 1), day(2, 2)]) {
      await prisma.linkPostSnapshot.create({ data: { postId: p.id, checkedAt: at, status: "verified", views: at.getUTCHours() } });
    }
    const now = new Date(Date.UTC(2026, 10, 25));
    let r = await runLinkAnalyticsRetention(now);
    const left = (await prisma.linkPostSnapshot.findMany({ orderBy: { checkedAt: "asc" } })).map((s) => s.checkedAt.toISOString());
    // Oct 1: first (01:00) kept + last of that IST day (09:00); Oct 2: last only (02:00).
    expect(left).toEqual([day(1, 1), day(1, 9), day(2, 2)].map((d) => d.toISOString()));
    expect(r.snapshotsThinned).toBe(2);
    expect((await runLinkAnalyticsRetention(now)).snapshotsThinned).toBe(0);

    await prisma.linkBatch.update({ where: { id: b.id }, data: { archivedAt: new Date(now.getTime() - 31 * 86400_000) } });
    await prisma.linkPost.update({ where: { id: p.id }, data: { createdAt: new Date(now.getTime() - 2 * 86400_000) } });
    r = await runLinkAnalyticsRetention(now);
    expect(r).toMatchObject({ batchesDeleted: 1, postsDeleted: 1 });
    expect(await prisma.linkPostSnapshot.count()).toBe(0);
  });

  it("gates: sales:view reads, others are refused; bad input is a clean 400", async () => {
    expect((await request(app).get("/v1/sales/links/batches").set(auth(employeeToken))).status).toBe(403);
    expect((await request(app).post("/v1/sales/links/batches").set(auth(employeeToken)).send({ name: "x", text: "https://www.instagram.com/p/AAAAA11111/" })).status).toBe(403);
    expect((await request(app).get("/v1/sales/links/batches")).status).toBe(401);
    expect((await request(app).post("/v1/sales/links/batches").set(auth(salesToken)).send({ name: "x", text: "nothing here" })).status).toBe(201);
    const empty = await request(app).post("/v1/sales/links/batches").set(auth(salesToken)).send({ name: "x", text: "   " });
    expect(empty.body.error.code).toBe("NO_LINKS");
    expect(await prisma.linkBatch.count({ where: { createdById: userId } })).toBe(1);
    const tooMany = Array.from({ length: 5001 }, (_, i) => `https://www.instagram.com/p/CODE${String(i).padStart(6, "0")}/`).join("\n");
    expect((await request(app).post("/v1/sales/links/batches").set(auth(salesToken)).send({ name: "big", text: tooMany })).body.error.code).toBe("TOO_MANY_LINKS");
  });
});
