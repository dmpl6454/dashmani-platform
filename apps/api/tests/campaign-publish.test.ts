/**
 * Phase 2 — Meta auto-publish. The Graph API is replaced by a small in-memory fake behind a
 * stubbed global fetch; everything else (Postgres, the state machine, settlement, emails) is
 * real. What is locked here:
 *  • approval routes each item to auto-publish or to staff, with the reason, and only when
 *    CAMPAIGN_PUBLISH_ENABLED=1;
 *  • an Instagram container is created once and reused across ticks;
 *  • an unanswered media_publish is never repeated — the container is re-checked first;
 *  • an unanswered Facebook post goes to staff instead of being re-posted;
 *  • a rejected token hands the item to staff at once; transient errors back off, then hand over;
 *  • the launch day is respected; staff can publish now or switch to posting by hand.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { sendEmail } from "../src/services/email.service";
import { encryptToken } from "../src/utils/token-crypto";
import { buildCaption, launchAt, publishItem, runPublishTick } from "../src/services/campaign/publish.service";
import { generateToken } from "./helpers";

// ── Fake Graph API ─────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body: URLSearchParams;
  query: URLSearchParams;
}

let calls: Call[] = [];
/** Override per test: return a Response, or throw to simulate a lost answer. */
let handler: (c: Call) => unknown;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const graphError = (code: number, message = "boom", status = 400) => json({ error: { code, message } }, status);

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const c: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname.replace(/^\/v\d+\.\d+\//, "/"),
        body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
        query: url.searchParams,
      };
      calls.push(c);
      const r = handler(c);
      if (r instanceof Error) throw r;
      return r as Response;
    }),
  );
}

const count = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;

// ── Fixtures ───────────────────────────────────────────────────────────────────

const IG_ID = "17841400000000001";
const PAGE_ID = "100000000000001";

let admin: string;
let clientId: string;
let igAssetId: string;
let fbAssetId: string;
let fbNoScopeAssetId: string;

async function seed() {
  const staff = await prisma.user.create({ data: { name: "Staff", email: "staff-pub@ds.test", passwordHash: "x", status: "ACTIVE" } });
  admin = generateToken(staff.id, staff.email, ["Admin"]);
  const client = await prisma.client.create({ data: { companyName: "Brand P", contactName: "Pia", email: "p@brand.test", passwordHash: "x" } });
  clientId = client.id;
  const conn = await prisma.metaConnection.create({
    data: {
      metaUserId: "mu-pub",
      connectedById: staff.id,
      status: "ACTIVE",
      userTokenEnc: encryptToken("USER_TOKEN"),
      grantedScopes: "pages_show_list,instagram_basic,instagram_content_publish,pages_manage_posts",
    },
  });
  const ig = await prisma.metaAsset.create({ data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: IG_ID, name: "Bollywood Society", username: "bollywoodsociety" } });
  const fb = await prisma.metaAsset.create({ data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: PAGE_ID, name: "Filme Flicks", pageTokenEnc: encryptToken("PAGE_TOKEN") } });
  igAssetId = ig.id;
  fbAssetId = fb.id;
  // A Page on a connection that never granted publishing.
  const conn2 = await prisma.metaConnection.create({
    data: { metaUserId: "mu-ro", connectedById: staff.id, status: "ACTIVE", userTokenEnc: encryptToken("RO"), grantedScopes: "pages_show_list" },
  });
  const ro = await prisma.metaAsset.create({ data: { connectionId: conn2.id, kind: "FACEBOOK_PAGE", metaId: "200000000000002", name: "Read Only Page", pageTokenEnc: encryptToken("RO_PAGE") } });
  fbNoScopeAssetId = ro.id;
}

let keySeq = 0;
async function booking(opts: {
  status?: string;
  format: string;
  kinds: Array<"video" | "image">;
  items: Array<{ assetId: string; platform: "instagram" | "facebook"; status?: string; containerId?: string | null }>;
  audio?: boolean;
  launchFrom?: Date;
}) {
  const b = await prisma.campaignBooking.create({
    data: {
      clientId,
      name: "Diwali drop",
      brand: "Brand P",
      status: opts.status ?? "approved",
      format: opts.format,
      caption: "Glow up this Diwali #diwali",
      hashtags: ["diwali", "sale"],
      userTags: ["brandp"],
      collaborators: ["brandp"],
      audioIntegration: opts.audio ?? false,
      audioTrack: opts.audio ? "Kesariya" : null,
      launchFrom: opts.launchFrom ?? new Date("2026-01-01T00:00:00Z"),
      launchTo: opts.launchFrom ?? new Date("2026-01-01T00:00:00Z"),
      totalPaise: 100_000,
    },
  });
  for (const [position, kind] of opts.kinds.entries()) {
    keySeq++;
    await prisma.campaignMedia.create({
      data: {
        clientId, bookingId: b.id, position, kind, originalName: `f${position}`, bytes: 10n, storageKey: `pubkey${keySeq}`,
        ext: kind === "video" ? "mp4" : "jpg", uploadStatus: "complete", chunkSize: 1, totalChunks: 1,
        renderStatus: "done", renderKey: `pubrender${keySeq}`,
      },
    });
  }
  const items = [];
  for (const it of opts.items) {
    items.push(
      await prisma.campaignBookingItem.create({
        data: {
          bookingId: b.id, rateCardId: "00000000-0000-0000-0000-000000000000", targetType: "meta_asset", targetId: it.assetId,
          platform: it.platform, format: opts.format, accountName: it.platform === "instagram" ? "Bollywood Society" : "Filme Flicks",
          pricePaise: 100_000, status: it.status ?? "queued", containerId: it.containerId ?? null,
        },
      }),
    );
  }
  return { id: b.id, items };
}

// ⚠️ Everything lives inside ONE describe so this beforeEach runs AFTER tests/setup.ts's
// TRUNCATE: vitest 1.x runs same-level hooks in parallel, so a root-level beforeEach would
// race the truncate and lose its fixtures.
describe("campaign auto-publish", () => {
beforeEach(async () => {
  process.env.CAMPAIGN_PUBLISH_ENABLED = "1";
  process.env.API_PUBLIC_URL = "https://api.example.test";
  calls = [];
  vi.mocked(sendEmail).mockClear();
  installFetch();
  await seed();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  delete process.env.CAMPAIGN_PUBLISH_ENABLED;
  delete process.env.API_PUBLIC_URL;
});

// ── Pure helpers ───────────────────────────────────────────────────────────────

describe("publish helpers", () => {
  it("appends only hashtags the caption doesn't already carry", () => {
    expect(buildCaption("Glow up #Diwali", ["diwali", "sale"])).toBe("Glow up #Diwali\n\n#sale");
    expect(buildCaption("", ["a"])).toBe("#a");
  });

  it("is due on the launch day at the configured IST hour, never in the past", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    // 2026-10-10 10:00 IST = 04:30 UTC
    expect(launchAt(new Date("2026-10-10T00:00:00Z"), now).toISOString()).toBe("2026-10-10T04:30:00.000Z");
    expect(launchAt(new Date("2026-09-01T00:00:00Z"), now)).toBe(now);
  });
});

// ── Approval routing ───────────────────────────────────────────────────────────

describe("approval decides auto vs by hand", () => {
  it("queues what the API can post and hands the rest to staff with the reason", async () => {
    const b = await booking({
      status: "paid_pending_review",
      format: "reel",
      kinds: ["video"],
      launchFrom: new Date("2099-01-05T00:00:00Z"),
      items: [
        { assetId: igAssetId, platform: "instagram", status: "pending" },
        { assetId: fbNoScopeAssetId, platform: "facebook", status: "pending" },
      ],
    });
    const res = await request(app).post(`/v1/admin/campaigns/${b.id}/approve`).set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const items = await prisma.campaignBookingItem.findMany({ where: { bookingId: b.id } });
    const ig = items.find((i) => i.targetId === igAssetId)!;
    const fb = items.find((i) => i.targetId === fbNoScopeAssetId)!;
    expect(ig.status).toBe("queued");
    expect(ig.nextAttemptAt?.toISOString()).toBe("2099-01-05T04:30:00.000Z");
    expect(fb.status).toBe("manual_pending");
    const notes = (await prisma.campaignBookingEvent.findMany({ where: { bookingId: b.id } })).map((e) => e.note ?? "");
    expect(notes.some((n) => n.includes("Read Only Page") || n.includes("Filme Flicks"))).toBe(true);
    expect(notes.some((n) => n.includes("pages_manage_posts"))).toBe(true);
  });

  it("song audio and a switched-off publisher both mean posting by hand", async () => {
    const withAudio = await booking({ status: "paid_pending_review", format: "reel", kinds: ["video"], audio: true, items: [{ assetId: igAssetId, platform: "instagram", status: "pending" }] });
    await request(app).post(`/v1/admin/campaigns/${withAudio.id}/approve`).set("Authorization", `Bearer ${admin}`);
    expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: withAudio.id } })).status).toBe("manual_pending");

    process.env.CAMPAIGN_PUBLISH_ENABLED = "0";
    const off = await booking({ status: "paid_pending_review", format: "reel", kinds: ["video"], items: [{ assetId: igAssetId, platform: "instagram", status: "pending" }] });
    await request(app).post(`/v1/admin/campaigns/${off.id}/approve`).set("Authorization", `Bearer ${admin}`);
    expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: off.id } })).status).toBe("manual_pending");
    expect(await runPublishTick()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// ── Instagram ──────────────────────────────────────────────────────────────────

function igFake(opts: { statuses?: string[]; publish?: () => unknown; recent?: Array<{ id: string; caption: string; permalink: string }> } = {}) {
  const statuses = [...(opts.statuses ?? ["IN_PROGRESS", "FINISHED"])];
  handler = (c) => {
    if (c.path === `/${IG_ID}/content_publishing_limit`) return json({ data: [{ quota_usage: 1, config: { quota_total: 100 } }] });
    if (c.method === "POST" && c.path === `/${IG_ID}/media`) return json({ id: "CONT1" });
    if (c.method === "GET" && c.path === "/CONT1") return json({ status_code: statuses.length > 1 ? statuses.shift() : statuses[0] });
    if (c.method === "POST" && c.path === `/${IG_ID}/media_publish`) return opts.publish ? opts.publish() : json({ id: "MEDIA1" });
    if (c.method === "GET" && c.path === "/MEDIA1") return json({ permalink: "https://www.instagram.com/reel/ABC123/" });
    if (c.method === "GET" && c.path === `/${IG_ID}/media`) return json({ data: opts.recent ?? [] });
    return graphError(100, `unexpected ${c.method} ${c.path}`);
  };
}

describe("Instagram auto-publish", () => {
  it("creates one container, waits for it, publishes, and delivers the link", async () => {
    igFake();
    const b = await booking({ format: "reel", kinds: ["video"], items: [{ assetId: igAssetId, platform: "instagram" }] });
    const itemId = b.items[0].id;

    expect((await publishItem(itemId))?.kind).toBe("wait"); // container created
    expect((await publishItem(itemId))?.kind).toBe("wait"); // IN_PROGRESS
    expect((await publishItem(itemId))?.kind).toBe("published"); // FINISHED → publish
    await new Promise((r) => setTimeout(r, 30));

    expect(count("POST", `/${IG_ID}/media`)).toBe(1);
    expect(count("POST", `/${IG_ID}/media_publish`)).toBe(1);
    const create = calls.find((c) => c.method === "POST" && c.path === `/${IG_ID}/media`)!;
    expect(create.body.get("media_type")).toBe("REELS");
    expect(create.body.get("video_url")).toMatch(/^https:\/\/api\.example\.test\/v1\/campaign-media\/[0-9a-f-]+\/preview\?exp=\d+&sig=/);
    expect(create.body.get("caption")).toBe("Glow up this Diwali #diwali\n\n#sale");
    expect(create.body.get("collaborators")).toBe('["brandp"]');
    expect(create.body.get("access_token")).toBe("USER_TOKEN");

    const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item).toMatchObject({ status: "published", remotePostId: "MEDIA1", permalink: "https://www.instagram.com/reel/ABC123/" });
    expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("completed");
    const delivered = vi.mocked(sendEmail).mock.calls.filter(([o]) => o.subject.startsWith("Delivered"));
    expect(delivered).toHaveLength(1);
    expect(delivered[0][0].html).toContain("https://www.instagram.com/reel/ABC123/");
  });

  it("an unanswered media_publish is never repeated: the container's PUBLISHED status is used", async () => {
    let published = false;
    igFake({
      statuses: ["FINISHED"],
      publish: () => {
        published = true;
        return new Error("socket hang up");
      },
      recent: [{ id: "MEDIA1", caption: "Glow up this Diwali #diwali\n\n#sale", permalink: "https://www.instagram.com/reel/ABC123/" }],
    });
    const b = await booking({ format: "reel", kinds: ["video"], items: [{ assetId: igAssetId, platform: "instagram", containerId: "CONT1" }] });
    const itemId = b.items[0].id;
    expect((await publishItem(itemId))?.kind).toBe("wait"); // publish lost → wait, don't retry
    expect(published).toBe(true);
    // Meta did publish: the container now reports it.
    handler = ((prev) => (c: Call) => (c.method === "GET" && c.path === "/CONT1" ? json({ status_code: "PUBLISHED" }) : prev(c)))(handler);
    expect((await publishItem(itemId))?.kind).toBe("published");
    expect(count("POST", `/${IG_ID}/media_publish`)).toBe(1);
    expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).permalink).toBe("https://www.instagram.com/reel/ABC123/");
  });

  it("an expired container is replaced by a fresh one", async () => {
    igFake({ statuses: ["EXPIRED"] });
    const b = await booking({ format: "reel", kinds: ["video"], items: [{ assetId: igAssetId, platform: "instagram", containerId: "CONT1" }] });
    expect((await publishItem(b.items[0].id))?.kind).toBe("retry");
    const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.items[0].id } });
    expect(item.containerId).toBeNull();
    expect(item.attempts).toBe(1);
    expect(item.status).toBe("queued");
  });

  it("a rejected token hands the item to staff immediately", async () => {
    handler = (c) => (c.path.endsWith("content_publishing_limit") ? json({ data: [] }) : graphError(190, "Error validating access token", 400));
    const b = await booking({ format: "reel", kinds: ["video"], items: [{ assetId: igAssetId, platform: "instagram" }] });
    expect((await publishItem(b.items[0].id))?.kind).toBe("manual");
    const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.items[0].id } });
    expect(item.status).toBe("manual_pending");
    expect(item.lastError).toMatch(/reconnect/i);
  });

  it("transient errors back off, and after five attempts the item goes to staff", async () => {
    handler = (c) => (c.path.endsWith("content_publishing_limit") ? json({ data: [] }) : graphError(2, "An unexpected error has occurred", 500));
    const b = await booking({ format: "reel", kinds: ["video"], items: [{ assetId: igAssetId, platform: "instagram" }] });
    const id = b.items[0].id;
    await publishItem(id);
    let item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id } });
    expect(item).toMatchObject({ status: "queued", attempts: 1 });
    expect(item.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    for (let i = 0; i < 4; i++) await publishItem(id);
    item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id } });
    expect(item.status).toBe("manual_pending");
    expect(item.lastError).toMatch(/failed 5 times/);
  });
});

// ── Facebook ───────────────────────────────────────────────────────────────────

describe("Facebook auto-publish", () => {
  it("posts a photo with the Page token and records its permalink", async () => {
    handler = (c) => {
      if (c.method === "POST" && c.path === `/${PAGE_ID}/photos`) return json({ id: "PHOTO1", post_id: `${PAGE_ID}_POST1` });
      if (c.method === "GET" && c.path === `/${PAGE_ID}_POST1`) return json({ permalink_url: "https://www.facebook.com/filmeflicks/posts/1" });
      return graphError(100, "unexpected");
    };
    const b = await booking({ format: "post", kinds: ["image"], items: [{ assetId: fbAssetId, platform: "facebook" }] });
    expect((await publishItem(b.items[0].id))?.kind).toBe("published");
    const post = calls.find((c) => c.path === `/${PAGE_ID}/photos`)!;
    expect(post.body.get("access_token")).toBe("PAGE_TOKEN");
    expect(post.body.get("caption")).toContain("Glow up this Diwali");
    expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.items[0].id } })).permalink).toBe("https://www.facebook.com/filmeflicks/posts/1");
  });

  it("an unconfirmed Facebook post goes to staff instead of being posted again", async () => {
    handler = (c) => (c.path === `/${PAGE_ID}/photos` ? new Error("timeout") : graphError(100, "unexpected"));
    const b = await booking({ format: "post", kinds: ["image"], items: [{ assetId: fbAssetId, platform: "facebook" }] });
    expect((await publishItem(b.items[0].id))?.kind).toBe("manual");
    await publishItem(b.items[0].id); // no longer queued → nothing happens
    expect(count("POST", `/${PAGE_ID}/photos`)).toBe(1);
    expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: b.items[0].id } })).lastError).toMatch(/check the Page/);
  });

  it("publishes a reel through start → upload → finish, then waits until it is live", async () => {
    let phase = "processing";
    handler = (c) => {
      if (c.method === "POST" && c.path === `/${PAGE_ID}/video_reels` && c.body.get("upload_phase") === "start") return json({ video_id: "VID1" });
      if (c.method === "POST" && c.path.endsWith("/VID1")) return json({ success: true }); // rupload
      if (c.method === "POST" && c.path === `/${PAGE_ID}/video_reels` && c.body.get("upload_phase") === "finish") return json({ success: true });
      if (c.method === "GET" && c.path === "/VID1" && c.query.get("fields") === "status") return json({ status: { video_status: "ready", publishing_phase: { status: phase } } });
      if (c.method === "GET" && c.path === "/VID1") return json({ permalink_url: "/reel/987654321" });
      return graphError(100, `unexpected ${c.method} ${c.path}`);
    };
    const b = await booking({ format: "reel", kinds: ["video"], items: [{ assetId: fbAssetId, platform: "facebook" }] });
    const id = b.items[0].id;
    expect((await publishItem(id))?.kind).toBe("wait");
    const upload = calls.find((c) => c.path.endsWith("/VID1") && c.method === "POST")!;
    expect(upload).toBeDefined();
    expect((await publishItem(id))?.kind).toBe("wait"); // still processing
    phase = "complete";
    expect((await publishItem(id))?.kind).toBe("published");
    expect(calls.filter((c) => c.path === `/${PAGE_ID}/video_reels`).length).toBe(2); // start + finish, once each
    expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id } })).permalink).toBe("https://www.facebook.com/reel/987654321");
  });
});

// ── Worker + staff controls ────────────────────────────────────────────────────

describe("worker and staff controls", () => {
  it("waits for the launch day; Publish now overrides it; Post by hand stops it", async () => {
    igFake();
    const b = await booking({ format: "reel", kinds: ["video"], launchFrom: new Date("2099-01-05T00:00:00Z"), items: [{ assetId: igAssetId, platform: "instagram" }] });
    const id = b.items[0].id;
    await prisma.campaignBookingItem.update({ where: { id }, data: { nextAttemptAt: launchAt(new Date("2099-01-05T00:00:00Z")) } });

    expect(await runPublishTick()).toBe(0);
    expect(calls).toHaveLength(0);

    // Hand-posting is refused while the item is set to auto-publish (no double posts).
    const hand = await request(app).post(`/v1/admin/campaigns/${b.id}/items/${id}/posted`).set("Authorization", `Bearer ${admin}`).send({ url: "https://www.instagram.com/p/XYZ/" });
    expect(hand.status).toBe(409);
    expect(hand.body.error.message).toMatch(/Post by hand instead/);

    const now = await request(app).post(`/v1/admin/campaigns/${b.id}/items/${id}/publish-now`).set("Authorization", `Bearer ${admin}`);
    expect(now.status).toBe(200);
    expect(await runPublishTick()).toBe(1);
    expect(count("POST", `/${IG_ID}/media`)).toBe(1);

    const manual = await request(app).post(`/v1/admin/campaigns/${b.id}/items/${id}/manual`).set("Authorization", `Bearer ${admin}`);
    expect(manual.status).toBe(200);
    expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id } })).status).toBe("manual_pending");
    expect(await runPublishTick()).toBe(0);
  });

  it("Publish now refuses an item the API can't post, and explains why", async () => {
    const b = await booking({ format: "post", kinds: ["image"], items: [{ assetId: fbNoScopeAssetId, platform: "facebook", status: "manual_pending" }] });
    const res = await request(app).post(`/v1/admin/campaigns/${b.id}/items/${b.items[0].id}/publish-now`).set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/pages_manage_posts/);
  });
});
});
