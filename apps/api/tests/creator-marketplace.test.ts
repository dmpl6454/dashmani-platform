/**
 * creator-marketplace.test.ts — creator portal Phase B/C end to end:
 *  • staff price a creator page per format (client price + creator payout) on /admin/creators/:id/pricing;
 *  • a priced, switched-on page of an approved creator appears in the client catalogue as a
 *    "creator" entry — never with the payout — and drops out when it stops being bookable;
 *  • a client can book it; staff approval OFFERS the post to the page's creator (nothing queued);
 *  • the creator sees only their own offers (no client identity, no client price), accepts or
 *    declines; accept with CREATOR_PUBLISH_ENABLED=1 queues it and the worker posts it with the
 *    CREATOR's page token; with the switch off the creator posts it and records the link;
 *  • decline / no answer in time → creator_declined, staff alerted, staff can refund;
 *  • a page that changed hands can't be accepted, and is never published under the old deal;
 *  • nothing is ever written to meta_assets / meta_connections; booked pages survive the purge.
 * The Graph API is a fake behind a stubbed fetch; Postgres and everything else are real.
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
import { sendEmail, notifyAdminByEmail } from "../src/services/email.service";
import { encryptToken } from "../src/utils/token-crypto";
import { runPublishTick } from "../src/services/campaign/publish.service";
import { invalidateCatalogueCache } from "../src/services/campaign/rate-card.service";
import { expireCreatorOffers, respondByFor } from "../src/services/creator/creator-offers.service";
import { creatorClientPricePaise } from "@dashmani/shared/src/validators/creator";
import { purgeCreatorPageData } from "../src/cron/creator.cron";
import { generateToken, generateClientToken, generateCreatorToken } from "./helpers";

// ── Fake Graph API ───────────────────────────────────────────────────────────────────────────

interface Call { method: string; path: string; body: URLSearchParams; query: URLSearchParams }
let calls: Call[] = [];
let handler: (c: Call) => unknown;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
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
  }));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

const PAGE_META_ID = "300000000000003";
let n = 0;
let adminToken: string;
let clientId: string;
let clientToken: string;
let creatorId: string;
let creatorToken: string;
let otherCreatorId: string;
let otherCreatorToken: string;
let connectionId: string;
let pageId: string;

async function seedCreator(name: string, status = "approved") {
  return prisma.creator.create({
    data: {
      email: `mk-${++n}-${Date.now()}@creators.test`, passwordHash: "x", name, status,
      emailVerifiedAt: new Date(), termsAcceptedAt: new Date(),
    },
  });
}

async function seed() {
  const staff = await prisma.user.create({ data: { name: "Staff", email: `staff-mk-${++n}@ds.test`, passwordHash: "x", status: "ACTIVE" } });
  adminToken = generateToken(staff.id, staff.email, ["Admin"]);
  const client = await prisma.client.create({ data: { companyName: "Secret Client Pvt", contactName: "Cara", email: `cara-${++n}@brand.test`, passwordHash: "x" } });
  clientId = client.id;
  clientToken = generateClientToken(client.id, client.email);

  const c = await seedCreator("Asha Iyer");
  creatorId = c.id;
  creatorToken = generateCreatorToken(c.id, c.email);
  const o = await seedCreator("Other Creator");
  otherCreatorId = o.id;
  otherCreatorToken = generateCreatorToken(o.id, o.email);

  const conn = await prisma.creatorConnection.create({
    data: {
      creatorId, metaUserId: `cm-${++n}`, status: "ACTIVE", userTokenEnc: encryptToken("CREATOR_USER_TOKEN"),
      grantedScopes: "pages_show_list,pages_manage_posts,instagram_basic,instagram_content_publish",
    },
  });
  connectionId = conn.id;
  const page = await prisma.creatorAsset.create({
    data: {
      creatorId, connectionId, kind: "facebook_page", metaId: PAGE_META_ID, name: "Asha Eats", username: "ashaeats",
      pageTokenEnc: encryptToken("CREATOR_PAGE_TOKEN"), tasks: ["CREATE_CONTENT"], canPublish: true, enabled: true,
      enabledAt: new Date(), followerCount: 42_000,
    },
  });
  pageId = page.id;
}

/** The creator sets their own price (= payout) for a format. */
async function setCreatorPrice(pricePaise: number | null, token = creatorToken, assetId = pageId) {
  return request(app).put("/v1/creator/prices").set("Authorization", `Bearer ${token}`)
    .send({ prices: [{ assetId, format: "post", pricePaise }] });
}

/** Staff set our margin for a format. */
async function setMargin(over: Record<string, unknown> = {}, forCreator = creatorId) {
  return request(app)
    .put(`/v1/admin/creators/${forCreator}/pricing`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ cards: [{ assetId: pageId, format: "post", marginBps: 5000, category: "Food", ...over }] });
}

/** Creator price ₹3,000 + our 50% margin → the client pays ₹4,500 for a post. */
async function priceCreatorPage() {
  expect((await setCreatorPrice(300_000)).status).toBe(200);
  expect((await setMargin()).status).toBe(200);
}

let keySeq = 0;
/** A paid booking for one post on the creator page, waiting for staff review. */
async function paidBooking(opts: { launchFrom?: Date; launchTo?: Date; audio?: boolean } = {}) {
  await priceCreatorPage();
  const card = await prisma.campaignRateCard.findFirstOrThrow({ where: { targetType: "creator_asset", targetId: pageId } });
  const b = await prisma.campaignBooking.create({
    data: {
      clientId, name: "Diwali drop", brand: "Brand Q", status: "paid_pending_review", format: "post",
      caption: "Glow up this Diwali", hashtags: ["diwali"], userTags: [], collaborators: [],
      audioIntegration: opts.audio ?? false,
      launchFrom: opts.launchFrom ?? new Date("2026-01-01T00:00:00Z"),
      launchTo: opts.launchTo ?? new Date("2099-01-01T00:00:00Z"),
      totalPaise: 590_000, submittedAt: new Date(),
    },
  });
  keySeq++;
  await prisma.campaignMedia.create({
    data: {
      clientId, bookingId: b.id, position: 0, kind: "image", role: "creative", originalName: "f.jpg", bytes: 10n,
      storageKey: `mkkey${keySeq}-${Date.now()}`, ext: "jpg", uploadStatus: "complete", chunkSize: 1, totalChunks: 1,
      renderStatus: "done", renderKey: `mkrender${keySeq}-${Date.now()}`,
    },
  });
  const item = await prisma.campaignBookingItem.create({
    data: {
      bookingId: b.id, rateCardId: card.id, targetType: "creator_asset", targetId: pageId, platform: "facebook", format: "post",
      accountName: "Asha Eats", accountHandle: "ashaeats", pricePaise: 450_000,
      // Frozen at checkout with the client price (payment.service), as a real checkout does.
      creatorPayoutPaise: 300_000,
    },
  });
  return { bookingId: b.id, itemId: item.id, cardId: card.id };
}

const approve = (bookingId: string) =>
  request(app).post(`/v1/admin/campaigns/${bookingId}/approve`).set("Authorization", `Bearer ${adminToken}`);
const asCreator = (token = creatorToken) => ({
  get: (p: string) => request(app).get(`/v1${p}`).set("Authorization", `Bearer ${token}`),
  post: (p: string, body: object = {}) => request(app).post(`/v1${p}`).set("Authorization", `Bearer ${token}`).send(body),
});

describe("creator marketplace", () => {
  beforeEach(async () => {
    vi.stubEnv("CREATORS_ENABLED", "1");
    vi.stubEnv("API_PUBLIC_URL", "https://api.example.test");
    calls = [];
    handler = () => json({ error: { code: 1, message: "unexpected call" } }, 500);
    vi.mocked(sendEmail).mockClear();
    vi.mocked(notifyAdminByEmail).mockClear();
    installFetch();
    invalidateCatalogueCache();
    await seed();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  afterAll(() => vi.unstubAllEnvs());

  // ── Pricing ────────────────────────────────────────────────────────────────────────────────

  describe("pricing: the creator's price + our margin", () => {
    it("derives the client card from the creator's price and the margin; payout = the creator's price", async () => {
      await priceCreatorPage();
      expect((await setMargin({ entertainmentMarginBps: 2000, category: "Food" })).status).toBe(200);
      const card = await prisma.campaignRateCard.findFirstOrThrow({ where: { targetType: "creator_asset", targetId: pageId } });
      expect(card).toMatchObject({ platform: "facebook", format: "post", active: true, pricePaise: 450_000, entertainmentPricePaise: 360_000, creatorPayoutPaise: 300_000, category: "Food" });
      const get = await request(app).get(`/v1/admin/creators/${creatorId}/pricing`).set("Authorization", `Bearer ${adminToken}`);
      expect(get.status).toBe(200);
      expect(get.body.data[0]).toMatchObject({ assetId: pageId, listed: true });
      expect(get.body.data[0].formats.find((f: { format: string }) => f.format === "post")).toMatchObject({
        creatorPricePaise: 300_000, marginBps: 5000, clientPricePaise: 450_000, entertainmentClientPricePaise: 360_000,
      });
    });

    it("rounds the client price UP to a whole rupee", () => {
      expect(creatorClientPricePaise(123_456, 2500)).toBe(154_400);
      expect(creatorClientPricePaise(100_000, 0)).toBe(100_000);
      expect(creatorClientPricePaise(99_950, 1)).toBe(100_000);
    });

    it("is listed only once BOTH the creator's price and our margin are set", async () => {
      expect((await setCreatorPrice(300_000)).status).toBe(200);
      expect(await prisma.campaignRateCard.count({ where: { active: true } })).toBe(0);
      expect((await setMargin()).status).toBe(200);
      expect(await prisma.campaignRateCard.count({ where: { active: true } })).toBe(1);
      // The creator withdraws the format → the card switches off (kept: bookings name it).
      expect((await setCreatorPrice(null)).status).toBe(200);
      expect(await prisma.campaignRateCard.count({ where: { active: true } })).toBe(0);
      expect(await prisma.campaignRateCard.count()).toBe(1);
      // Staff withdrawing the margin does the same.
      await setCreatorPrice(300_000);
      await setMargin({ marginBps: null });
      expect(await prisma.campaignRateCard.count({ where: { active: true } })).toBe(0);
    });

    it("a creator price change moves NEW bookings' client price automatically", async () => {
      await priceCreatorPage();
      await setCreatorPrice(400_000);
      const card = await prisma.campaignRateCard.findFirstOrThrow({ where: { targetType: "creator_asset" } });
      expect(card).toMatchObject({ pricePaise: 600_000, creatorPayoutPaise: 400_000, active: true });
    });

    it("the creator sees their own price only — never our margin or the client price", async () => {
      await priceCreatorPage();
      const res = await asCreator().get("/creator/prices");
      expect(res.status).toBe(200);
      expect(res.body.data[0].prices.find((p: { format: string }) => p.format === "post")).toMatchObject({ pricePaise: 300_000 });
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/margin/i);
      expect(body).not.toContain("450000");
    });

    it("each side can only price its own pages; staff can't set the payout", async () => {
      expect((await setCreatorPrice(300_000, otherCreatorToken)).status).toBe(404);
      expect((await setMargin({}, otherCreatorId)).status).toBe(404);
      await setCreatorPrice(300_000);
      // A payout or client price smuggled into the staff request is ignored (not in the schema).
      await setMargin({ creatorPayoutPaise: 1, creatorPricePaise: 1, pricePaise: 1 });
      const card = await prisma.campaignRateCard.findFirstOrThrow({ where: { targetType: "creator_asset" } });
      expect(card).toMatchObject({ pricePaise: 450_000, creatorPayoutPaise: 300_000 });
      await prisma.creator.update({ where: { id: creatorId }, data: { status: "suspended" } });
      expect((await setCreatorPrice(500_000)).status).toBe(403);
    });

    it("is staff-only: a client or creator token is refused on the margin endpoint", async () => {
      const asClient = await request(app).get(`/v1/admin/creators/${creatorId}/pricing`).set("Authorization", `Bearer ${clientToken}`);
      const asCreatorRes = await request(app).get(`/v1/admin/creators/${creatorId}/pricing`).set("Authorization", `Bearer ${creatorToken}`);
      expect(asClient.status).toBeGreaterThanOrEqual(401);
      expect(asClient.status).toBeLessThan(404);
      expect(asCreatorRes.status).toBeGreaterThanOrEqual(401);
      expect(asCreatorRes.status).toBeLessThan(404);
    });
  });

  // ── Catalogue ──────────────────────────────────────────────────────────────────────────────

  describe("client catalogue", () => {
    const catalogue = async () => {
      invalidateCatalogueCache();
      const res = await request(app).get("/v1/client/campaigns/catalogue").set("Authorization", `Bearer ${clientToken}`);
      expect(res.status).toBe(200);
      return res.body.data as Array<Record<string, unknown>>;
    };

    it("lists a priced, switched-on page of an approved creator as a creator entry — never the payout", async () => {
      await priceCreatorPage();
      const rows = await catalogue();
      const row = rows.find((r) => r.targetId === pageId)!;
      expect(row).toMatchObject({ targetType: "creator_asset", source: "creator", platform: "facebook", name: "Asha Eats", followers: 42_000 });
      expect(row.offers).toEqual([expect.objectContaining({ format: "post", pricePaise: 450_000 })]);
      expect(JSON.stringify(rows)).not.toMatch(/payout/i);
    });

    it("drops the page when it stops being bookable (switched off, creator suspended, grant lapsed, unpriced)", async () => {
      expect((await catalogue()).some((r) => r.targetId === pageId)).toBe(false); // no price yet
      await priceCreatorPage();
      expect((await catalogue()).some((r) => r.targetId === pageId)).toBe(true);
      await prisma.creatorAsset.update({ where: { id: pageId }, data: { enabled: false } });
      expect((await catalogue()).some((r) => r.targetId === pageId)).toBe(false);
      await prisma.creatorAsset.update({ where: { id: pageId }, data: { enabled: true } });
      await prisma.creatorConnection.update({ where: { id: connectionId }, data: { status: "NEEDS_REAUTH" } });
      expect((await catalogue()).some((r) => r.targetId === pageId)).toBe(false);
      await prisma.creatorConnection.update({ where: { id: connectionId }, data: { status: "ACTIVE" } });
      await prisma.creator.update({ where: { id: creatorId }, data: { status: "suspended" } });
      expect((await catalogue()).some((r) => r.targetId === pageId)).toBe(false);
    });

    it("lets a client book the creator page (price from the card) and refuses it once unbookable", async () => {
      await priceCreatorPage();
      const card = await prisma.campaignRateCard.findFirstOrThrow({ where: { targetType: "creator_asset" } });
      const b = await prisma.campaignBooking.create({ data: { clientId, name: "X", brand: "B", status: "draft", format: "post" } });
      const ok = await request(app).put(`/v1/client/campaigns/${b.id}/items`).set("Authorization", `Bearer ${clientToken}`).send({ rateCardIds: [card.id] });
      expect(ok.status).toBe(200);
      const item = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: b.id } });
      expect(item).toMatchObject({ targetType: "creator_asset", targetId: pageId, pricePaise: 450_000, creatorId: null });
      expect(JSON.stringify(ok.body)).not.toMatch(/payout/i);

      await prisma.creatorAsset.update({ where: { id: pageId }, data: { enabled: false } });
      const refused = await request(app).put(`/v1/client/campaigns/${b.id}/items`).set("Authorization", `Bearer ${clientToken}`).send({ rateCardIds: [card.id] });
      expect(refused.status).toBe(400);
    });
  });

  // ── Offer + decision ───────────────────────────────────────────────────────────────────────

  describe("offer on approval", () => {
    it("approval offers the post to the creator (payout frozen, deadline set), queues nothing and emails them", async () => {
      const { bookingId, itemId } = await paidBooking();
      const res = await approve(bookingId);
      expect(res.status).toBe(200);
      const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item).toMatchObject({ status: "awaiting_creator", creatorId, creatorPayoutPaise: 300_000, nextAttemptAt: null });
      expect(item.creatorRespondBy!.getTime()).toBeGreaterThan(Date.now() + 70 * 3600_000);
      expect(vi.mocked(sendEmail).mock.calls.some(([m]) => /paid post/i.test(m.subject))).toBe(true);
      // The creator raising their price later does not move a post already booked and offered.
      await setCreatorPrice(800_000);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).creatorPayoutPaise).toBe(300_000);
    });

    it("checkout freezes the payout with the client price; a later creator price change moves neither", async () => {
      await priceCreatorPage();
      const card = await prisma.campaignRateCard.findFirstOrThrow({ where: { targetType: "creator_asset" } });
      const b = await prisma.campaignBooking.create({
        data: { clientId, name: "Fest", brand: "Brand Q", status: "draft", format: "post", caption: "Hi", launchFrom: new Date("2099-01-01T00:00:00Z"), launchTo: new Date("2099-01-02T00:00:00Z") },
      });
      keySeq++;
      await prisma.campaignMedia.create({
        data: {
          clientId, bookingId: b.id, position: 0, kind: "image", role: "creative", originalName: "f.jpg", bytes: 10n,
          storageKey: `mkco${keySeq}-${Date.now()}`, ext: "jpg", uploadStatus: "complete", chunkSize: 1, totalChunks: 1,
          renderStatus: "done", renderKey: `mkcor${keySeq}-${Date.now()}`,
        },
      });
      expect((await request(app).put(`/v1/client/campaigns/${b.id}/items`).set("Authorization", `Bearer ${clientToken}`).send({ rateCardIds: [card.id] })).status).toBe(200);
      const co = await request(app).post(`/v1/client/campaigns/${b.id}/checkout`).set("Authorization", `Bearer ${clientToken}`);
      expect(co.status).toBe(200);
      expect(JSON.stringify(co.body)).not.toMatch(/payout/i);
      const item = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: b.id } });
      expect(item).toMatchObject({ pricePaise: 450_000, creatorPayoutPaise: 300_000 });

      await setCreatorPrice(900_000);
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("paid_pending_review");
      expect((await approve(b.id)).status).toBe(200);
      const offered = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(offered).toMatchObject({ status: "awaiting_creator", pricePaise: 450_000, creatorPayoutPaise: 300_000 });
    });

    it("a page switched off before approval goes to staff instead of being offered", async () => {
      const { bookingId, itemId } = await paidBooking();
      await prisma.creatorAsset.update({ where: { id: pageId }, data: { enabled: false } });
      await approve(bookingId);
      const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.status).toBe("manual_pending");
      expect(item.creatorId).toBeNull();
      expect(item.lastError).toMatch(/switched off/);
    });

    it("the creator sees their offer with previews and payout — never the client or the client price", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      const list = await asCreator().get("/creator/offers");
      expect(list.status).toBe(200);
      expect(list.body.data.counts.waiting).toBe(1);
      const one = await asCreator().get(`/creator/offers/${itemId}`);
      expect(one.status).toBe(200);
      expect(one.body.data).toMatchObject({
        status: "awaiting_creator", canAccept: true, payoutPaise: 300_000,
        campaign: expect.objectContaining({ brand: "Brand Q" }), caption: "Glow up this Diwali",
      });
      expect(one.body.data.files[0].url).toMatch(/^\/v1\/campaign-media\/.+\/preview\?exp=\d+&sig=/);
      const body = JSON.stringify([list.body, one.body]);
      expect(body).not.toContain("Secret Client Pvt");
      expect(body).not.toContain("cara-");
      expect(body).not.toContain("450000");
      expect(body).not.toMatch(/Enc"|TOKEN/);
      // Another creator cannot see it.
      expect((await asCreator(otherCreatorToken).get(`/creator/offers/${itemId}`)).status).toBe(404);
      expect((await asCreator(otherCreatorToken).post(`/creator/offers/${itemId}/accept`)).status).toBe(404);
      expect((await asCreator(otherCreatorToken).get("/creator/offers")).body.data.offers).toHaveLength(0);
    });
  });

  describe("accept → publish on the creator's page", () => {
    it("with CREATOR_PUBLISH_ENABLED=1: accept queues it, the worker posts with the CREATOR's page token", async () => {
      vi.stubEnv("CREATOR_PUBLISH_ENABLED", "1");
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      // Nothing is published before the creator accepts.
      await runPublishTick();
      expect(calls).toHaveLength(0);

      const acc = await asCreator().post(`/creator/offers/${itemId}/accept`);
      expect(acc.status).toBe(200);
      expect(acc.body.data.status).toBe("queued");
      expect((await asCreator().post(`/creator/offers/${itemId}/accept`)).status).toBe(409);

      handler = (c) => {
        if (c.method === "POST" && c.path === `/${PAGE_META_ID}/photos`) return json({ id: "PH1", post_id: `${PAGE_META_ID}_P1` });
        if (c.method === "GET" && c.path === `/${PAGE_META_ID}_P1`) return json({ permalink_url: `https://www.facebook.com/${PAGE_META_ID}/posts/P1` });
        return json({ error: { code: 1, message: "unexpected" } }, 500);
      };
      expect(await runPublishTick()).toBe(1);
      const post = calls.find((c) => c.path === `/${PAGE_META_ID}/photos`)!;
      expect(post.body.get("access_token")).toBe("CREATOR_PAGE_TOKEN");
      const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item).toMatchObject({ status: "published", permalink: `https://www.facebook.com/${PAGE_META_ID}/posts/P1` });
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("completed");
      // Never through our own network tables.
      expect(await prisma.metaAsset.count()).toBe(0);
      expect(await prisma.metaConnection.count()).toBe(0);
    });

    it("the Meta switch alone does not publish creator pages (own switch)", async () => {
      vi.stubEnv("CAMPAIGN_PUBLISH_ENABLED", "1");
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      // Force the queued state as if accepted while the creator switch was on.
      await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { status: "queued", creatorDecidedAt: new Date(), nextAttemptAt: new Date(0) } });
      await runPublishTick();
      expect(calls).toHaveLength(0);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe("queued");
    });

    it("with the switch off: accept hands it to the creator, who posts it and records the link", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      const acc = await asCreator().post(`/creator/offers/${itemId}/accept`);
      expect(acc.body.data).toMatchObject({ status: "manual_pending", canRecordPost: true });
      expect(acc.body.data.note).toMatch(/switched off/);
      expect((await asCreator().post(`/creator/offers/${itemId}/posted`, { url: "https://www.instagram.com/p/abc/" })).status).toBe(400);
      const done = await asCreator().post(`/creator/offers/${itemId}/posted`, { url: `https://www.facebook.com/${PAGE_META_ID}/posts/9` });
      expect(done.status).toBe(200);
      expect(done.body.data.status).toBe("posted_manual");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("completed");
      const events = await prisma.campaignBookingEvent.findMany({ where: { bookingId, actorType: "creator" } });
      expect(events.length).toBeGreaterThanOrEqual(2);
    });

    it("song audio cannot go through the API even when publishing is on", async () => {
      vi.stubEnv("CREATOR_PUBLISH_ENABLED", "1");
      const { bookingId, itemId } = await paidBooking({ audio: true });
      await prisma.campaignBooking.update({ where: { id: bookingId }, data: { format: "reel" } });
      await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { format: "reel" } });
      await approve(bookingId);
      const acc = await asCreator().post(`/creator/offers/${itemId}/accept`);
      expect(acc.body.data.status).toBe("manual_pending");
      expect(acc.body.data.note).toMatch(/song/i);
    });
  });

  describe("decline, expiry, ownership", () => {
    it("decline → creator_declined, staff alerted, staff refund it", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      expect((await asCreator().post(`/creator/offers/${itemId}/decline`, { reason: "x" })).status).toBe(400);
      const res = await asCreator().post(`/creator/offers/${itemId}/decline`, { reason: "Not my audience" });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: "creator_declined", declineReason: "Not my audience", canAccept: false });
      await vi.waitFor(() => expect(vi.mocked(notifyAdminByEmail)).toHaveBeenCalled());
      expect((await asCreator().post(`/creator/offers/${itemId}/accept`)).status).toBe(409);
      const refund = await request(app).post(`/v1/admin/campaigns/${bookingId}/items/${itemId}/refund`).set("Authorization", `Bearer ${adminToken}`);
      expect(refund.status).toBe(200);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe("refunded");
    });

    it("no answer by the deadline → declined (and an accept after it is refused)", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { creatorRespondBy: new Date(Date.now() - 1000) } });
      expect((await asCreator().post(`/creator/offers/${itemId}/accept`)).status).toBe(409);
      expect(await expireCreatorOffers()).toBe(1);
      expect(await expireCreatorOffers()).toBe(0);
      const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.status).toBe("creator_declined");
      expect(vi.mocked(notifyAdminByEmail)).toHaveBeenCalled();
    });

    it("a page that changed hands can't be accepted, and is never published under the old deal", async () => {
      vi.stubEnv("CREATOR_PUBLISH_ENABLED", "1");
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      const otherConn = await prisma.creatorConnection.create({ data: { creatorId: otherCreatorId, metaUserId: `cm-o-${++n}`, status: "ACTIVE" } });
      await prisma.creatorAsset.update({ where: { id: pageId }, data: { creatorId: otherCreatorId, connectionId: otherConn.id } });
      expect((await asCreator().post(`/creator/offers/${itemId}/accept`)).body.error.code).toBe("PAGE_NOT_YOURS");
      // The new owner cannot answer an offer that was made to someone else.
      expect((await asCreator(otherCreatorToken).post(`/creator/offers/${itemId}/accept`)).status).toBe(404);
      // Even if it had been accepted, the worker hands it to staff instead of posting.
      await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { status: "queued", creatorDecidedAt: new Date(), nextAttemptAt: new Date(0) } });
      await runPublishTick();
      expect(calls).toHaveLength(0);
      const item = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(item.status).toBe("manual_pending");
      expect(item.lastError).toMatch(/different creator/);
    });

    it("staff can't 'publish now' a post the creator hasn't accepted", async () => {
      vi.stubEnv("CREATOR_PUBLISH_ENABLED", "1");
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { status: "manual_pending" } });
      const res = await request(app).post(`/v1/admin/campaigns/${bookingId}/items/${itemId}/publish-now`).set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CREATOR_NOT_ACCEPTED");
    });

    it("rejecting the campaign closes an open offer", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      const res = await request(app).post(`/v1/admin/campaigns/${bookingId}/reject`).set("Authorization", `Bearer ${adminToken}`).send({ note: "Brand safety" });
      expect(res.status).toBe(200);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe("refunded");
      expect((await asCreator().get(`/creator/offers/${itemId}`)).body.data.canAccept).toBe(false);
    });

    it("a suspended creator can read but not answer", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      await prisma.creator.update({ where: { id: creatorId }, data: { status: "suspended" } });
      expect((await asCreator().get(`/creator/offers/${itemId}`)).status).toBe(200);
      expect((await asCreator().post(`/creator/offers/${itemId}/accept`)).status).toBe(403);
    });
  });

  describe("helpers and housekeeping", () => {
    it("respondByFor: 72 h, capped at the end of the last posting day (IST), never under 6 h", () => {
      const now = new Date("2026-03-01T00:00:00Z");
      expect(respondByFor(now, null).toISOString()).toBe("2026-03-04T00:00:00.000Z");
      // Last day 2 Mar IST ends 2 Mar 18:30 UTC.
      expect(respondByFor(now, new Date("2026-03-02T00:00:00Z")).toISOString()).toBe("2026-03-02T18:30:00.000Z");
      // A last day already over → still 6 h to answer.
      expect(respondByFor(now, new Date("2026-02-01T00:00:00Z")).toISOString()).toBe("2026-03-01T06:00:00.000Z");
    });

    it("the purge keeps a disconnected page that was booked (and its connection)", async () => {
      await paidBooking();
      const long = new Date(Date.now() - 60 * 86_400_000);
      await prisma.creatorAsset.update({ where: { id: pageId }, data: { disconnectedAt: long } });
      await prisma.creatorConnection.update({ where: { id: connectionId }, data: { revokedAt: long, status: "REVOKED" } });
      const spare = await prisma.creatorAsset.create({
        data: { creatorId: otherCreatorId, connectionId: (await prisma.creatorConnection.create({ data: { creatorId: otherCreatorId, metaUserId: `cm-p-${++n}`, revokedAt: long, status: "REVOKED" } })).id, kind: "facebook_page", metaId: `p-${++n}`, name: "Unbooked", disconnectedAt: long },
      });
      const r = await purgeCreatorPageData();
      expect(await prisma.creatorAsset.findUnique({ where: { id: pageId } })).not.toBeNull();
      expect(await prisma.creatorConnection.findUnique({ where: { id: connectionId } })).not.toBeNull();
      expect(await prisma.creatorAsset.findUnique({ where: { id: spare.id } })).toBeNull();
      expect(r.assets + r.connections).toBeGreaterThan(0);
    });
  });
});
