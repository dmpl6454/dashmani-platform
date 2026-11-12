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
import { creatorNote, expireCreatorOffers, remindCreatorOffers, BRIEF_SHARED_SINCE, respondByFor } from "../src/services/creator/creator-offers.service";
import { creatorClientPricePaise } from "@dashmani/shared/src/validators/creator";
import { purgeCreatorPageData } from "../src/cron/creator.cron";
import { alertPassedWindows, listQueue } from "../src/services/campaign/review.service";
import { todayIST } from "@dashmani/shared";
import { generateToken, generateClientToken, generateCreatorToken, createTestRole } from "./helpers";

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
      objective: "Make people try the new Diwali glow kit.",
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

    it("the creator sees whether each format is listed: their price alone is not enough, our margin completes it", async () => {
      const listed = async () => (await asCreator().get("/creator/prices")).body.data[0].prices.find((p: { format: string }) => p.format === "post").listed;
      expect((await setCreatorPrice(300_000)).status).toBe(200);
      expect(await listed()).toBe(false);
      expect((await setMargin()).status).toBe(200);
      expect(await listed()).toBe(true);
      await prisma.creatorAsset.update({ where: { id: pageId }, data: { enabled: false } });
      expect(await listed()).toBe(false);
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
      // No "link in 5–10 min" promise on a creator's page; the client sees how long the creator has instead.
      expect(row.linkDeliveryMinutes).toBeNull();
      expect(row.creatorResponseHours).toBe(72);
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

    it("a song reel: the song add-on goes to the creator in full (no margin on it)", async () => {
      expect((await request(app).put("/v1/creator/prices").set("Authorization", `Bearer ${creatorToken}`)
        .send({ prices: [{ assetId: pageId, format: "reel", pricePaise: 300_000 }] })).status).toBe(200);
      expect((await setMargin({ format: "reel", marginBps: 5000, audioAddonPaise: 50_000 })).status).toBe(200);
      const card = await prisma.campaignRateCard.findFirstOrThrow({ where: { targetType: "creator_asset", format: "reel" } });
      expect(card).toMatchObject({ pricePaise: 450_000, audioAddonPaise: 50_000, creatorPayoutPaise: 300_000 });
      const b = await prisma.campaignBooking.create({
        data: {
          clientId, name: "Song", brand: "Brand Q", status: "draft", format: "reel", caption: "Hi", audioIntegration: true, audioTrack: "Kesariya",
          launchFrom: new Date("2099-01-01T00:00:00Z"), launchTo: new Date("2099-01-02T00:00:00Z"),
        },
      });
      keySeq++;
      await prisma.campaignMedia.create({
        data: {
          clientId, bookingId: b.id, position: 0, kind: "video", role: "creative", originalName: "f.mp4", bytes: 10n, durationMs: 20_000,
          storageKey: `mksong${keySeq}-${Date.now()}`, ext: "mp4", uploadStatus: "complete", chunkSize: 1, totalChunks: 1,
          renderStatus: "done", renderKey: `mksongr${keySeq}-${Date.now()}`,
        },
      });
      expect((await request(app).put(`/v1/client/campaigns/${b.id}/items`).set("Authorization", `Bearer ${clientToken}`).send({ rateCardIds: [card.id] })).status).toBe(200);
      expect((await request(app).post(`/v1/client/campaigns/${b.id}/checkout`).set("Authorization", `Bearer ${clientToken}`)).status).toBe(200);
      const item = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: b.id } });
      // Client pays ₹4,500 + ₹500 song; the creator gets ₹3,000 + the whole ₹500.
      expect(item).toMatchObject({ pricePaise: 500_000, audioAddonPaise: 50_000, creatorPayoutPaise: 350_000 });
      await approve(b.id);
      const offer = await asCreator().get(`/creator/offers/${item.id}`);
      expect(offer.body.data).toMatchObject({ payoutPaise: 350_000, campaign: expect.objectContaining({ songTrack: "Kesariya" }) });
      // With auto-posting off, the creator still learns WHY this one is theirs to post (the song).
      const acc = await asCreator().post(`/creator/offers/${item.id}/accept`);
      expect(acc.body.data).toMatchObject({ status: "manual_pending" });
      expect(acc.body.data.note).toMatch(/song/);
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
      expect(acc.body.data).toMatchObject({ status: "queued", autoPost: true });
      expect((await asCreator().get("/creator/me")).body.data.autoPost).toBe(true);
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
      expect(acc.body.data).toMatchObject({ status: "manual_pending", canRecordPost: true, autoPost: false, note: "You post accepted bookings yourself for now." });
      // The staff reason stays on the item; the creator never sees staff wording.
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).lastError).toMatch(/switched off/);
      expect(JSON.stringify((await asCreator().get(`/creator/offers/${itemId}`)).body)).not.toMatch(/switched off|paste the link\./);
      expect((await asCreator().get("/creator/offers")).body.data.autoPost).toBe(false);
      expect((await asCreator().get("/creator/me")).body.data.autoPost).toBe(false);
      expect((await asCreator().post(`/creator/offers/${itemId}/posted`, { url: "https://www.instagram.com/p/abc/" })).status).toBe(400);
      // The bare site or the page itself is not a post link: it used to count as "Live" and email the client.
      expect((await asCreator().post(`/creator/offers/${itemId}/posted`, { url: "https://www.facebook.com/" })).status).toBe(400);
      const profile = await asCreator().post(`/creator/offers/${itemId}/posted`, { url: "https://www.facebook.com/AshaEats" });
      expect(profile.status).toBe(400);
      expect(JSON.stringify(profile.body)).toContain("a post on Facebook");
      const done = await asCreator().post(`/creator/offers/${itemId}/posted`, { url: `https://www.facebook.com/${PAGE_META_ID}/posts/9` });
      expect(done.status).toBe(200);
      expect(done.body.data.status).toBe("posted_manual");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe("completed");
      const events = await prisma.campaignBookingEvent.findMany({ where: { bookingId, actorType: "creator" } });
      expect(events.length).toBeGreaterThanOrEqual(2);
      // The client's results mark the creator page as one whose stats never reach us (no "Collecting stats…" for ever).
      const results = await request(app).get(`/v1/client/campaigns/${bookingId}/results`).set("Authorization", `Bearer ${clientToken}`);
      expect(results.status).toBe(200);
      expect(results.body.data.items[0]).toMatchObject({ status: "posted_manual", targetType: "creator_asset", metricsAvailable: false });
      // And the client's own campaign view says which account is a creator's page.
      const view = await request(app).get(`/v1/client/campaigns/${bookingId}`).set("Authorization", `Bearer ${clientToken}`);
      expect(view.body.data.items[0]).toMatchObject({ targetType: "creator_asset" });
    });

    it("a post can't be recorded before the campaign's posting window opens", async () => {
      const from = new Date(Date.now() + 3 * 86_400_000);
      from.setUTCHours(0, 0, 0, 0);
      const { bookingId, itemId } = await paidBooking({ launchFrom: from, launchTo: new Date(from.getTime() + 7 * 86_400_000) });
      await approve(bookingId);
      expect((await asCreator().post(`/creator/offers/${itemId}/accept`)).status).toBe(200);
      const early = await asCreator().post(`/creator/offers/${itemId}/posted`, { url: `https://www.facebook.com/${PAGE_META_ID}/posts/early` });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe("BEFORE_WINDOW");
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe("manual_pending");
      // Once the window has opened the same link is accepted.
      await prisma.campaignBooking.update({ where: { id: bookingId }, data: { launchFrom: new Date("2026-01-01T00:00:00Z") } });
      expect((await asCreator().post(`/creator/offers/${itemId}/posted`, { url: `https://www.facebook.com/${PAGE_META_ID}/posts/early` })).status).toBe(200);
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
      // The client is told at once, with what happens next — not left on "Approved. Your posts will go live…".
      await vi.waitFor(() => expect(vi.mocked(sendEmail).mock.calls.some(([m]) => /couldn't take a post/.test(m.subject) && /Asha Eats/.test(m.html))).toBe(true));
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
      // An expiry tells the client too, and says the creator didn't answer in time.
      expect(vi.mocked(sendEmail).mock.calls.some(([m]) => /couldn't take a post/.test(m.subject) && /didn't answer in time/.test(m.html))).toBe(true);
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

    it("staff can't mark posted a creator post the creator hasn't accepted", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      const early = await request(app).post(`/v1/admin/campaigns/${bookingId}/items/${itemId}/posted`).set("Authorization", `Bearer ${adminToken}`).send({ url: `https://www.facebook.com/${PAGE_META_ID}/posts/7` });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe("CREATOR_NOT_ACCEPTED");
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe("awaiting_creator");
      // Once the creator accepts, staff may record the link on their behalf.
      expect((await asCreator().post(`/creator/offers/${itemId}/accept`)).status).toBe(200);
      const ok = await request(app).post(`/v1/admin/campaigns/${bookingId}/items/${itemId}/posted`).set("Authorization", `Bearer ${adminToken}`).send({ url: `https://www.facebook.com/${PAGE_META_ID}/posts/7` });
      expect(ok.status).toBe(200);
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

  // ── Batch 2: a creator can do the job without asking ───────────────────────────────────────

  describe("doing the job without asking (batch 2)", () => {
    const emails = () => vi.mocked(sendEmail).mock.calls.map(([m]) => m);
    const accepted = async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      expect((await asCreator().post(`/creator/offers/${itemId}/accept`)).body.data.status).toBe("manual_pending");
      return { bookingId, itemId };
    };

    it("the offer carries the brand's brief, and the offer email lets the creator reply with a question", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      // A booking made before the client form said creators read it keeps its objective private.
      await prisma.campaignBooking.update({ where: { id: bookingId }, data: { createdAt: new Date(BRIEF_SHARED_SINCE.getTime() - 1000) } });
      expect((await asCreator().get(`/creator/offers/${itemId}`)).body.data.campaign.brief).toBeNull();
      await prisma.campaignBooking.update({ where: { id: bookingId }, data: { createdAt: BRIEF_SHARED_SINCE } });
      const one = await asCreator().get(`/creator/offers/${itemId}`);
      expect(one.body.data.campaign.brief).toBe("Make people try the new Diwali glow kit.");
      await vi.waitFor(() => expect(emails().some((m) => /paid post is waiting/.test(m.subject))).toBe(true));
      const offerMail = emails().find((m) => /paid post is waiting/.test(m.subject))!;
      expect(offerMail.replyTo).toBe("creators@digitalsukoon.com");
      expect(offerMail.html).toMatch(/Reply to this email before you decide/);
    });

    it("the checklist says when a switched-on page has no price", async () => {
      const before = (await asCreator().get("/creator/me")).body.data.checklist;
      expect(before).toMatchObject({ enabledPages: 1, pricedPages: 0, pricesSet: false });
      await setCreatorPrice(300_000);
      expect((await asCreator().get("/creator/me")).body.data.checklist).toMatchObject({ pricedPages: 1, pricesSet: true });
    });

    it("a recorded link can be corrected: only the link changes, no second client email", async () => {
      const { itemId } = await accepted();
      expect((await asCreator().post(`/creator/offers/${itemId}/posted`, { url: `https://www.facebook.com/${PAGE_META_ID}/posts/1` })).status).toBe(200);
      const liveMails = () => emails().filter((m) => /live|delivered/i.test(m.subject)).length;
      await new Promise((r) => setTimeout(r, 50));
      const before = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } });
      const sentBefore = liveMails();
      expect((await asCreator().get(`/creator/offers/${itemId}`)).body.data.canCorrectPost).toBe(true);
      const fix = await asCreator().post(`/creator/offers/${itemId}/posted`, { url: `https://www.facebook.com/${PAGE_META_ID}/posts/2` });
      expect(fix.status).toBe(200);
      const after = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } });
      expect(after).toMatchObject({ status: "posted_manual", permalink: `https://www.facebook.com/${PAGE_META_ID}/posts/2` });
      expect(after.postedAt?.getTime()).toBe(before.postedAt?.getTime());
      await new Promise((r) => setTimeout(r, 50));
      expect(liveMails()).toBe(sentBefore);
      await vi.waitFor(() => expect(vi.mocked(notifyAdminByEmail).mock.calls.some(([subject]) => /corrected a post link/.test(String(subject)))).toBe(true));
      // A bare profile link is still refused on a correction.
      expect((await asCreator().post(`/creator/offers/${itemId}/posted`, { url: "https://www.facebook.com/AshaEats" })).status).toBe(400);
    });

    it("an accepted post can still be recorded after the page is disconnected; a new offer can't be accepted", async () => {
      const { itemId } = await accepted();
      await prisma.creatorAsset.update({ where: { id: pageId }, data: { disconnectedAt: new Date(), enabled: false } });
      expect((await asCreator().post(`/creator/offers/${itemId}/posted`, { url: `https://www.facebook.com/${PAGE_META_ID}/posts/7` })).status).toBe(200);
      // A fresh offer on the same (now disconnected) page cannot be accepted.
      await prisma.creatorAsset.update({ where: { id: pageId }, data: { disconnectedAt: null, enabled: true } });
      const { bookingId: b2, itemId: i2 } = await paidBooking();
      await approve(b2);
      await prisma.creatorAsset.update({ where: { id: pageId }, data: { disconnectedAt: new Date() } });
      expect((await asCreator().post(`/creator/offers/${i2}/accept`)).body.error.code).toBe("PAGE_DISCONNECTED");
    });

    it("staff withdrawing an offered or accepted post tell the creator once; the creator sees no payout", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      vi.mocked(sendEmail).mockClear();
      expect((await request(app).post(`/v1/admin/campaigns/${bookingId}/items/${itemId}/refund`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(200);
      await vi.waitFor(() => expect(emails().filter((m) => /withdrawn/i.test(m.subject))).toHaveLength(1));
      const view = (await asCreator().get(`/creator/offers/${itemId}`)).body.data;
      expect(view.status).toBe("refunded");
      expect(view.note).toMatch(/Withdrawn by our team before you answered/);

      const { bookingId: b2, itemId: i2 } = await accepted();
      vi.mocked(sendEmail).mockClear();
      expect((await request(app).post(`/v1/admin/campaigns/${b2}/items/${i2}/failed`).set("Authorization", `Bearer ${adminToken}`).send({ note: "Internal: client changed their mind" })).status).toBe(200);
      await vi.waitFor(() => expect(emails().filter((m) => /withdrawn/i.test(m.subject))).toHaveLength(1));
      const failedView = (await asCreator().get(`/creator/offers/${i2}`)).body;
      expect(failedView.data.note).toMatch(/marked this post as not made/);
      expect(JSON.stringify(failedView)).not.toContain("client changed their mind");
    });

    it("a post the creator declined is refunded without emailing the creator", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      await asCreator().post(`/creator/offers/${itemId}/decline`, { reason: "Not my audience" });
      vi.mocked(sendEmail).mockClear();
      expect((await request(app).post(`/v1/admin/campaigns/${bookingId}/items/${itemId}/refund`).set("Authorization", `Bearer ${adminToken}`)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(emails().filter((m) => /withdrawn/i.test(m.subject))).toHaveLength(0);
      expect((await asCreator().get(`/creator/offers/${itemId}`)).body.data.note).toMatch(/You declined this post/);
    });

    it("rejecting a campaign with an offered post emails that creator", async () => {
      const { bookingId } = await paidBooking();
      await approve(bookingId);
      vi.mocked(sendEmail).mockClear();
      expect((await request(app).post(`/v1/admin/campaigns/${bookingId}/reject`).set("Authorization", `Bearer ${adminToken}`).send({ note: "Brand safety" })).status).toBe(200);
      await vi.waitFor(() => expect(emails().filter((m) => /withdrawn/i.test(m.subject))).toHaveLength(1));
    });

    it("reminds the creator once about a day before the answer deadline, never on a short window", async () => {
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      const now = new Date();
      await prisma.campaignBookingItem.update({
        where: { id: itemId },
        data: { creatorOfferedAt: new Date(now.getTime() - 60 * 3600_000), creatorRespondBy: new Date(now.getTime() + 10 * 3600_000) },
      });
      vi.mocked(sendEmail).mockClear();
      expect(await remindCreatorOffers(now)).toBe(1);
      expect(emails().filter((m) => /Answer by/.test(m.subject))).toHaveLength(1);
      expect(await remindCreatorOffers(now)).toBe(0);
      expect(emails().filter((m) => /Answer by/.test(m.subject))).toHaveLength(1);

      // A window that was short from the start (offered 5 h before a 10 h deadline): no reminder.
      const { bookingId: b2, itemId: i2 } = await paidBooking();
      await approve(b2);
      await prisma.campaignBookingItem.update({
        where: { id: i2 },
        data: { creatorOfferedAt: new Date(now.getTime() - 5 * 3600_000), creatorRespondBy: new Date(now.getTime() + 10 * 3600_000) },
      });
      // Far from its deadline: no reminder either.
      const { bookingId: b3, itemId: i3 } = await paidBooking();
      await approve(b3);
      await prisma.campaignBookingItem.update({
        where: { id: i3 },
        data: { creatorOfferedAt: new Date(now.getTime() - 10 * 3600_000), creatorRespondBy: new Date(now.getTime() + 50 * 3600_000) },
      });
      expect(await remindCreatorOffers(now)).toBe(0);
    });
  });

  describe("the client and staff always know where a campaign stands (batch 3)", () => {
    const yesterday = () => new Date(`${todayIST()}T00:00:00Z`).getTime() - 86_400_000;

    it("a passed posting window with an open post alerts staff once, and the queue flags it", async () => {
      const { bookingId } = await paidBooking({ launchTo: new Date(yesterday()) });
      await approve(bookingId);
      vi.mocked(notifyAdminByEmail).mockClear();
      expect(await alertPassedWindows()).toBe(1);
      expect(vi.mocked(notifyAdminByEmail).mock.calls[0][0]).toMatch(/Posting window passed: Diwali drop/);
      // A second run (or a restart) is a no-op.
      expect(await alertPassedWindows()).toBe(0);
      const q = await request(app).get("/v1/admin/campaigns").set("Authorization", `Bearer ${adminToken}`);
      expect(q.body.data.find((r: { id: string }) => r.id === bookingId).overdue).toBe(true);
    });

    it("a window that is still open, or a campaign with every post settled, is never flagged", async () => {
      const { bookingId } = await paidBooking();
      await approve(bookingId);
      expect(await alertPassedWindows()).toBe(0);
      const { bookingId: b2, itemId: i2 } = await paidBooking({ launchTo: new Date(yesterday()) });
      await approve(b2);
      await prisma.campaignBookingItem.update({ where: { id: i2 }, data: { status: "refunded" } });
      expect(await alertPassedWindows()).toBe(0);
    });

    it("an email that didn't go out is recorded, and resend reports it honestly", async () => {
      const { bookingId, itemId } = await paidBooking();
      // The offer email fails: staff read that the creator was not told.
      vi.mocked(sendEmail).mockResolvedValueOnce(null as never);
      await approve(bookingId);
      await vi.waitFor(async () => {
        const ev = await prisma.campaignBookingEvent.findFirst({ where: { bookingId, note: { contains: "Offer email could not be sent" } } });
        expect(ev).not.toBeNull();
      });
      // Resend of the delivery email with SMTP failing → sent:false and an "Email not sent" event.
      await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { status: "refunded" } });
      await prisma.campaignBooking.update({ where: { id: bookingId }, data: { status: "partially_published" } });
      vi.mocked(sendEmail).mockResolvedValueOnce(null as never);
      const r = await request(app).post(`/v1/admin/campaigns/${bookingId}/resend-delivery`).set("Authorization", `Bearer ${adminToken}`);
      expect(r.status).toBe(200);
      expect(r.body.data.sent).toBe(false);
      expect(await prisma.campaignBookingEvent.findFirst({ where: { bookingId, note: { startsWith: "Email not sent: delivery email" } } })).not.toBeNull();
      // Green path.
      const ok = await request(app).post(`/v1/admin/campaigns/${bookingId}/resend-delivery`).set("Authorization", `Bearer ${adminToken}`);
      expect(ok.body.data.sent).toBe(true);
    });

    it("the changes-needed email says what can't change and where to ask", async () => {
      const { bookingId } = await paidBooking();
      vi.mocked(sendEmail).mockClear();
      const r = await request(app).post(`/v1/admin/campaigns/${bookingId}/request-changes`).set("Authorization", `Bearer ${adminToken}`).send({ note: "Please brighten the video." });
      expect(r.status).toBe(200);
      await vi.waitFor(() => {
        const m = vi.mocked(sendEmail).mock.calls.map(([x]) => x).find((x) => /Changes needed/.test(x.subject));
        expect(m?.html).toMatch(/fixed once a campaign is submitted/);
      });
    });
  });

  describe("staff see what needs doing (batch 5)", () => {
    async function salesUser() {
      const role = await createTestRole(`Sales-${++n}`, [{ resource: "sales", action: "view", scope: "global" }]);
      const u = await prisma.user.create({ data: { name: "Seller", email: `seller-${++n}@ds.test`, passwordHash: "x", status: "ACTIVE" } });
      await prisma.userRole.create({ data: { userId: u.id, roleId: role.id } });
      return u;
    }

    it("the queue counts a creator page as waiting on its creator, not as a post for staff", async () => {
      const { bookingId } = await paidBooking();
      await approve(bookingId);
      const row = (await listQueue()).find((r) => r.id === bookingId)!;
      expect(row.toPostCount).toBe(0);
      expect(row.waitingOnCreatorCount).toBe(1);
      expect(row.creatorDeclinedCount).toBe(0);
      expect(row.nextCreatorDeadline).not.toBeNull();
    });

    it("reviews are listed oldest submission first, with their submit time", async () => {
      const { bookingId: newer } = await paidBooking();
      const { bookingId: older } = await paidBooking();
      await prisma.campaignBooking.update({ where: { id: older }, data: { submittedAt: new Date(Date.now() - 30 * 3_600_000) } });
      const ids = (await listQueue()).filter((r) => r.status === "paid_pending_review").map((r) => r.id);
      expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
      expect((await listQueue()).find((r) => r.id === older)!.submittedAt).not.toBeNull();
    });

    it("a creator decline puts a bell row in front of the sales team, linking to the booking", async () => {
      const seller = await salesUser();
      const { bookingId, itemId } = await paidBooking();
      await approve(bookingId);
      const r = await asCreator().post(`/creator/offers/${itemId}/decline`, { reason: "Not a fit for my page" });
      expect(r.status).toBe(200);
      await vi.waitFor(async () => {
        const rows = await prisma.notification.findMany({ where: { userId: seller.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].title).toMatch(/needs a refund or another page/);
        expect(rows[0].metadata).toMatchObject({ kind: "campaign_alert", bookingId, url: expect.stringContaining(`/bookings/view?id=${bookingId}`) });
      });
      const row = (await listQueue()).find((q) => q.id === bookingId)!;
      expect(row.creatorDeclinedCount).toBe(1);
    });

    it("staff see which switched-on pages brands can actually book", async () => {
      const before = await request(app).get(`/v1/admin/creators/${creatorId}`).set("Authorization", `Bearer ${adminToken}`);
      expect(before.body.data.assets[0].listedFormats).toEqual([]);
      await priceCreatorPage();
      const after = await request(app).get(`/v1/admin/creators/${creatorId}`).set("Authorization", `Bearer ${adminToken}`);
      expect(after.body.data.assets[0].listedFormats.length).toBeGreaterThan(0);
    });
  });

  describe("owner decisions 2026-11-12 (G8 withdraw, G72 how creators are paid)", () => {
    const withdraw = (id: string) => request(app).post(`/v1/client/campaigns/${id}/cancel`).set("Authorization", `Bearer ${clientToken}`);

    it("a client can withdraw a submitted campaign before approval when nothing was paid online, and staff are told", async () => {
      const { bookingId } = await paidBooking();
      vi.mocked(notifyAdminByEmail).mockClear();
      const r = await withdraw(bookingId);
      expect(r.status).toBe(200);
      expect(r.body.data.status).toBe("cancelled");
      await vi.waitFor(() => expect(vi.mocked(notifyAdminByEmail).mock.calls.some(([s]) => /withdrawn by the client/.test(s))).toBe(true));
      // changes_requested is withdrawable too.
      const { bookingId: b2 } = await paidBooking();
      await prisma.campaignBooking.update({ where: { id: b2 }, data: { status: "changes_requested" } });
      expect((await withdraw(b2)).status).toBe(200);
    });

    it("refuses once approved, when paid online, or when an invoice exists", async () => {
      const { bookingId } = await paidBooking();
      await approve(bookingId);
      expect((await withdraw(bookingId)).body.error.code).toBe("NOT_EDITABLE");
      const { bookingId: paid } = await paidBooking();
      await prisma.campaignBooking.update({ where: { id: paid }, data: { paidAt: new Date() } });
      expect((await withdraw(paid)).body.error.code).toBe("PAID_ONLINE");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid } })).status).toBe("paid_pending_review");
    });

    it("a creator saves a GSTIN or a PAN; only a masked hint comes back, staff see the full number", async () => {
      if (!process.env.META_TOKEN_ENC_KEY) vi.stubEnv("META_TOKEN_ENC_KEY", "test-key-for-creator-tax-details-0123456789");
      const put = (body: object) => request(app).put("/v1/creator/me/tax").set("Authorization", `Bearer ${creatorToken}`).send(body);
      expect((await put({ route: "pan", pan: "abc", legalName: "Asha" })).body.error.code).toBe("INVALID_PAN");
      expect((await put({ route: "gst", gstin: "27ABCDE1234F1Z", legalName: "Asha" })).body.error.code).toBe("INVALID_GSTIN");
      const ok = await put({ route: "gst", gstin: "27abcde1234f1z5", legalName: "Asha Eats LLP" });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ route: "gst", hint: "GSTIN ••••1Z5" });
      const me = await request(app).get("/v1/creator/me").set("Authorization", `Bearer ${creatorToken}`);
      expect(me.body.data.tax).toEqual({ route: "gst", hint: "GSTIN ••••1Z5" });
      expect(JSON.stringify(me.body)).not.toContain("27ABCDE1234F1Z5");
      const row = await prisma.creator.findUniqueOrThrow({ where: { id: creatorId } });
      expect(row.payoutDetailsEnc).not.toContain("ABCDE1234F");
      const staff = await request(app).get(`/v1/admin/creators/${creatorId}`).set("Authorization", `Bearer ${adminToken}`);
      expect(staff.body.data.creator.taxDetails).toEqual({ route: "gst", gstin: "27ABCDE1234F1Z5", pan: "ABCDE1234F", legalName: "Asha Eats LLP" });
      // Switching to PAN replaces it.
      expect((await put({ route: "pan", pan: "ABCDE1234F", legalName: "Asha" })).body.data).toEqual({ route: "pan", hint: "PAN ••••34F" });
    });
  });
});

describe("creatorNote: why a creator posts a booking themselves", () => {
  it("translates the content reasons a creator can act on, and hides everything written for staff", () => {
    expect(creatorNote("Song audio integration has to be added in the app — the API cannot attach a song.")).toMatch(/song/);
    expect(creatorNote("The client chose a thumbnail — Facebook can't take it through the API, so post it by hand with the thumbnail.")).toMatch(/cover image/);
    expect(creatorNote("Facebook carousels can only hold images through the API.")).toMatch(/photo carousels/);
    expect(creatorNote("Stories are posted by hand.")).toMatch(/Stories/);
    // A post we may already have published must never fall back to the generic sentence: a second copy would go up.
    expect(creatorNote("Meta didn't confirm the Facebook post — check the Page before posting again, then paste the link.")).toMatch(/Check your Page first/);
    expect(creatorNote("Instagram published the post but we couldn't read its link — open the profile and paste it.")).toMatch(/don't post it again/);
    expect(creatorNote("The creator's Facebook login has expired — they must reconnect it.")).toMatch(/Reconnect Facebook/);
    expect(creatorNote("Auto-posting on creator pages is switched off — post it on the page and paste the link.")).toBe("You post accepted bookings yourself for now.");
    for (const staff of [
      "This page now belongs to a different creator account — check with the creator before posting.",
      "Staff switched this creator page off.",
      "Token rejected (190)",
      "",
      null,
    ]) expect(creatorNote(staff)).toBeNull();
  });
});
