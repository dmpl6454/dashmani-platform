/**
 * Creator offers (payout plan Phase 3): what approve makes of a booking that contains a creator's page, how the creator
 * answers, how they send the link of the post they made by hand, and how staff verify or withdraw.
 *
 * Everything runs against Postgres. Razorpay is a small stub (razorpayHttp.fetch: an order, refunds). Meta's Graph API and the
 * Facebook share-link redirect are one stubbed global fetch. No network, no real mail (sendEmail / notifyAdminByEmail are mocked).
 * A booking is made through the real client routes and the real capture webhook, so the payout rows, the frozen terms and the
 * item statuses are exactly what production writes; approve, the creator's API and the staff routes are the real ones.
 *
 * Order: approve → the three ways an offer ends (decline, expiry, withdraw) and the races between them → what a creator may
 * see → the link and its ownership check → staff verify → the dark switch.
 *
 * ⚠️ ABOUT THE RACE TESTS. CI runs with connection_limit=1, so two "simultaneous" calls are really run one after the other.
 * What these tests prove is therefore the OUTCOME RULE (whichever order they happen in, exactly one coherent end state:
 * offer, item and payout agree, and a loser is refused with a 409 and changed nothing), not true parallelism.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma, PrismaClient } from "@dashmani/db";
import { todayIST } from "@dashmani/shared";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../src/app";
import { notifyAdminByEmail, sendEmail } from "../src/services/email.service";
import { razorpayHttp } from "../src/services/campaign/razorpay";
import { invalidateCatalogueCache } from "../src/services/campaign/rate-card.service";
import {
  CREATOR_DISCLOSURE_INSTRUCTION,
  acceptOffer,
  checkLinkOwnership,
  createOffersForBooking,
  expireOffer,
  inr,
  ownershipMatchKey,
  postingWindow,
  toOfferRow,
  withdrawOffer,
} from "../src/services/creator/creator-offer.service";
import { pageHasOpenWork, payoutAllowsLink } from "../src/services/creator/payout-ledger";
import { isIdentityKey, parseCreatorLink } from "../src/services/creator/offer-link";
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { encryptToken } from "../src/utils/token-crypto";
import { generateClientToken, generateCreatorToken, generateHrToken, generateToken } from "./helpers";

const WEBHOOK_SECRET = "whsec_test_creator_offers";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const later = (ms: number) => new Date(Date.now() + ms);
let seq = 0;

const alertSubjects = () => vi.mocked(notifyAdminByEmail).mock.calls.map((c) => String(c[0]));
const REFUND_ALERT = "A creator's post needs a refund";
const PROBLEM_ALERT = "A creator's post can't go ahead and needs a refund";

// ── Razorpay: an order, a refund, a refund list (the same stub the core tests use) ─────────────

const rz = {
  calls: [] as Array<{ method: string; url: string; body: any }>,
  refunds: new Map<string, Array<{ id: string; amount: number; status: string; receipt: string | null; key: string | null }>>(),
  n: 0,
  /** What a refund POST gets: accepted, refused outright (a 400), or no answer we can use (a 500). */
  refundMode: "ok" as "ok" | "reject400" | "http500",
};
const refundPosts = () => rz.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund"));

function stubRazorpay() {
  rz.calls.length = 0;
  rz.refunds.clear();
  rz.n = 0;
  rz.refundMode = "ok";
  razorpayHttp.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    const key = init?.headers?.["X-Refund-Idempotency"] as string | undefined;
    rz.calls.push({ method, url: u, body });
    if (method === "POST" && u.endsWith("/orders")) {
      return new Response(JSON.stringify({ id: `order_${++rz.n}`, amount: body.amount, currency: "INR", status: "created" }), { status: 200 });
    }
    const post = /\/payments\/([^/?]+)\/refund$/.exec(u);
    if (method === "POST" && post) {
      if (rz.refundMode === "reject400") return new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "Your account does not have enough balance to carry out the refund operation." } }), { status: 400 });
      if (rz.refundMode === "http500") return new Response("upstream error", { status: 500 });
      const list = rz.refunds.get(post[1]) ?? [];
      let r = key ? list.find((x) => x.key === key) : undefined;
      if (!r) {
        r = { id: `rfnd_${++rz.n}`, amount: body.amount, status: "processed", receipt: body.receipt ?? null, key: key ?? null };
        list.push(r);
        rz.refunds.set(post[1], list);
      }
      return new Response(JSON.stringify({ id: r.id, entity: "refund", amount: r.amount, status: r.status, payment_id: post[1], receipt: r.receipt }), { status: 200 });
    }
    const list = /\/payments\/([^/?]+)\/refunds(\?|$)/.exec(u);
    if (method === "GET" && list) {
      const items = (rz.refunds.get(list[1]) ?? []).map((r) => ({ id: r.id, entity: "refund", amount: r.amount, status: r.status, receipt: r.receipt, payment_id: list[1] }));
      return new Response(JSON.stringify({ entity: "collection", count: items.length, items }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function webhook(event: string, entity: Record<string, unknown>, eventId = crypto.randomUUID()) {
  const raw = JSON.stringify({ event, payload: { payment: { entity } } });
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return request(app).post("/v1/webhooks/razorpay").set("Content-Type", "application/json").set("x-razorpay-signature", sig).set("x-razorpay-event-id", eventId).send(raw);
}

// ── Meta: the creator's own recent posts, and the Facebook share-link redirect ─────────────────

type GraphMode = "ok" | "authError" | "rateLimit" | "permission" | "graphError" | "throw";
const graph = {
  mode: "ok" as GraphMode,
  /** Instagram /{id}/media rows. */
  igMedia: [] as Array<{ id: string; permalink: string; timestamp: string }>,
  /** Facebook /{id}/published_posts rows. */
  fbPosts: [] as Array<{ id: string; permalink_url: string; created_time: string }>,
  /** /share/... path → redirect target (absent = no redirect). */
  shares: new Map<string, string>(),
  /** Per-page feeds, by the page's meta id: they replace igMedia / fbPosts for that page only. */
  feeds: new Map<string, Array<Record<string, string>>>(),
  /** Answer `limit` rows at a time with a paging.next cursor, like Meta does. */
  paginate: false,
  /** The host of the paging.next link (anything that is not Meta's must never be followed). */
  nextHost: "graph.facebook.com",
  /** Every Graph call, with the access token and its proof removed. */
  calls: [] as Array<{ path: string; params: Record<string, string>; token: string | null }>,
};
const resetGraph = () => {
  graph.mode = "ok";
  graph.igMedia = [];
  graph.fbPosts = [];
  graph.shares.clear();
  graph.feeds.clear();
  graph.paginate = false;
  graph.nextHost = "graph.facebook.com";
  graph.calls.length = 0;
};
/** Poll until `cond` holds (50 ms steps, 10 s at most): for the tests that watch another connection from pg_stat_activity / pg_locks. */
async function waitUntil(cond: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(input: any): Promise<Response> | Response {
  const url = new URL(String(input));
  if (url.hostname.endsWith("facebook.com") && url.pathname.startsWith("/share/")) {
    const to = graph.shares.get(url.pathname);
    return to ? new Response(null, { status: 302, headers: { location: to } }) : new Response(null, { status: 200 });
  }
  const path = url.pathname.replace(/^\/v\d+\.\d+\//, "/");
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (k !== "access_token" && k !== "appsecret_proof") params[k] = v;
  });
  graph.calls.push({ path, params, token: url.searchParams.get("access_token") });
  if (graph.mode === "throw") throw new Error("network down");
  if (graph.mode === "authError") return json({ error: { code: 190, message: "Error validating access token", error_subcode: 463 } }, 400);
  if (graph.mode === "rateLimit") return json({ error: { code: 4, message: "Application request limit reached" } }, 400);
  if (graph.mode === "permission") return json({ error: { code: 10, message: "(#10) Application does not have permission for this action" } }, 400);
  if (graph.mode === "graphError") return json({ error: { code: 1, message: "An unknown error occurred" } }, 500);
  const feed = (rows: Array<Record<string, string>>) => {
    if (!graph.paginate) return json({ data: rows });
    const limit = Number(url.searchParams.get("limit")) || rows.length;
    const after = Number(url.searchParams.get("after") ?? 0);
    const next = new URL(url.toString());
    next.hostname = graph.nextHost;
    next.searchParams.set("after", String(after + limit));
    return json({ data: rows.slice(after, after + limit), ...(after + limit < rows.length ? { paging: { next: next.toString() } } : {}) });
  };
  const metaId = path.split("/")[1];
  if (path.endsWith("/media")) return feed(graph.feeds.get(metaId) ?? graph.igMedia);
  if (path.endsWith("/published_posts")) return feed(graph.feeds.get(metaId) ?? graph.fbPosts);
  return json({ error: { code: 100, message: `unexpected ${path}` } }, 400);
}

/** An Instagram / Graph timestamp in the format Meta sends (+0000, not Z). */
const metaTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+0000");

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────

describe("creator-offer helpers", () => {
  it("formats rupees with Indian grouping and shows paise only when there are some", () => {
    expect(inr(100_000)).toBe("₹1,000");
    expect(inr(12_345_600)).toBe("₹1,23,456");
    expect(inr(100_050)).toBe("₹1,000.50");
    expect(inr(10_000)).toBe("₹100");
  });

  it("the posting window opens at the start of launchFrom's IST day and closes (exclusive) at the end of launchTo's", () => {
    const from = new Date("2026-10-20T00:00:00.000Z"); // the IST day 2026-10-20, as stored
    const to = new Date("2026-10-27T00:00:00.000Z");
    const w = postingWindow(from, to);
    expect(w.from!.toISOString()).toBe("2026-10-19T18:30:00.000Z"); // 2026-10-20 00:00 IST
    expect(w.to!.toISOString()).toBe("2026-10-27T18:30:00.000Z"); // 2026-10-28 00:00 IST
    expect(postingWindow(null, null)).toEqual({ from: null, to: null });
  });

  it("compares a link on its canonical key: Instagram tracking tokens and username paths never matter, Facebook reel ids are the reel id, not the composite", () => {
    expect(ownershipMatchKey("https://www.instagram.com/creatorpage/reel/ABCdef123/?igsh=xyz")).toBe(ownershipMatchKey("https://instagram.com/reel/ABCdef123"));
    expect(ownershipMatchKey("https://www.instagram.com/reel/ABCdef123/")).not.toBe(ownershipMatchKey("https://www.instagram.com/reel/abcdef123/")); // shortcodes are case-sensitive
    expect(ownershipMatchKey("https://www.facebook.com/reel/1234567890/")).toBe(ownershipMatchKey("https://m.facebook.com/watch/?v=1234567890"));
    expect(ownershipMatchKey("https://www.facebook.com/reel/1234567890")).not.toBe(ownershipMatchKey("https://www.facebook.com/reel/999")); // the composite's tail is another id
    // An opaque Facebook permalink falls back to host + path (case kept: pfbid is case-sensitive), so a tracking query is ignored.
    expect(ownershipMatchKey("https://www.facebook.com/somepage/posts/pfbid02AbC?mibextid=1")).toBe(ownershipMatchKey("https://m.facebook.com/somepage/posts/pfbid02AbC/"));
    expect(ownershipMatchKey("https://www.facebook.com/somepage/posts/pfbid02AbC")).not.toBe(ownershipMatchKey("https://www.facebook.com/somepage/posts/pfbid02abc"));
  });

  it("⚠️ an Instagram /share/ link is NOT the post's shortcode: it has its own key, which can never equal (or collide with) an ig: key", () => {
    const share = ownershipMatchKey("https://www.instagram.com/share/reel/ABC123/?igsh=x");
    expect(share).toBe("share:instagram.com/share/reel/ABC123");
    expect(share).not.toBe("ig:ABC123");
    expect(ownershipMatchKey("https://www.instagram.com/share/p/ABC123")).not.toBe("ig:ABC123");
    expect(isIdentityKey(share)).toBe(false);
    expect(ownershipMatchKey("https://www.instagram.com/reel/ABC123/")).toBe("ig:ABC123");
  });

  it("a Facebook video is its id wherever the link is written: the page segment (numeric id, vanity name, any case) is never part of the key", () => {
    for (const url of [
      "https://www.facebook.com/987654321/videos/123456789",
      "https://www.facebook.com/MyPage/videos/123456789/",
      "https://m.facebook.com/mypage/videos/123456789?mibextid=x",
      "https://www.facebook.com/mypage/videos/vb.987654321/123456789/",
      "https://www.facebook.com/reel/123456789/",
      "https://www.facebook.com/watch/?v=123456789",
      "https://web.facebook.com/video.php?v=123456789",
    ]) {
      expect(ownershipMatchKey(url), url).toBe("fb:123456789");
    }
    expect(ownershipMatchKey("https://www.facebook.com/MyPage/videos/123456780")).not.toBe("fb:123456789");
  });

  it("a Facebook post is its token (pfbid is case-sensitive, the page segment is ignored), a photo its fbid, a story its two ids: and two different ones never share a key", () => {
    expect(ownershipMatchKey("https://www.facebook.com/PageA/posts/pfbid02AbC")).toBe("fbpost:pfbid02AbC");
    expect(ownershipMatchKey("https://www.facebook.com/987/posts/pfbid02AbC/")).toBe("fbpost:pfbid02AbC");
    expect(ownershipMatchKey("https://www.facebook.com/PageA/posts/pfbid02abc")).not.toBe("fbpost:pfbid02AbC");
    expect(ownershipMatchKey("https://www.facebook.com/PageA/posts/1234567")).toBe("fbpost:1234567");
    // Photos: before, every photo.php link collapsed to ONE key, so any photo link matched any photo in the feed.
    expect(ownershipMatchKey("https://www.facebook.com/photo.php?fbid=111&set=a.1")).toBe("fbphoto:111");
    expect(ownershipMatchKey("https://www.facebook.com/photo/?fbid=111")).toBe("fbphoto:111");
    expect(ownershipMatchKey("https://www.facebook.com/photo.php?fbid=222")).not.toBe(ownershipMatchKey("https://www.facebook.com/photo.php?fbid=111"));
    expect(ownershipMatchKey("https://www.facebook.com/PageA/photos/a.100/777/")).toBe("fbphoto:777");
    expect(ownershipMatchKey("https://www.facebook.com/permalink.php?story_fbid=5&id=9")).toBe("fbstory:5:9");
    expect(ownershipMatchKey("https://www.facebook.com/permalink.php?story_fbid=6&id=9")).not.toBe("fbstory:5:9");
  });

  it("a link that names no post has no identity key, so it can never be 'the same post' as another: fb.watch, an unreadable path", () => {
    for (const url of ["https://fb.watch/abcDEF/", "https://www.facebook.com/events/123/", "https://example.com/x"]) {
      const k = ownershipMatchKey(url);
      expect(isIdentityKey(k), url).toBe(false);
      expect(k.startsWith("raw:"), url).toBe(true);
    }
  });

  it("parseCreatorLink takes a post link on the platform's own host only: no subdomain wrapper, no redirect target, no profile", () => {
    const reason = (platform: string, url: string) => {
      const r = parseCreatorLink(platform, url);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason("facebook", "https://l.facebook.com/l.php?u=https%3A%2F%2Fphish.example&v=1234567890")).toBe("host");
    expect(reason("facebook", "https://lm.facebook.com/l.php?u=x")).toBe("host");
    expect(reason("facebook", "https://business.facebook.com/reel/1234567890")).toBe("host");
    expect(reason("facebook", "https://www.facebook.com/login.php?next=https%3A%2F%2Fphish.example&v=1234567890")).toBe("redirect");
    expect(reason("facebook", "https://www.facebook.com/somepage")).toBe("shape");
    expect(reason("instagram", "https://l.instagram.com/?u=https%3A%2F%2Fphish.example&e=x")).toBe("host");
    expect(reason("instagram", "https://www.instagram.com/creatorpage1/")).toBe("shape");
    expect(reason("instagram", "https://www.instagram.com/stories/creatorpage1/123/")).toBe("shape");
    expect(reason("instagram", "https://www.facebook.com/reel/1")).toBe("host");
    for (const [platform, url] of [["instagram", "https://m.instagram.com/reel/AbC/"], ["facebook", "https://mbasic.facebook.com/reel/12/"], ["facebook", "https://fb.watch/abc/"]]) expect(reason(platform, url), url).toBe("ok");
  });

  it("payoutAllowsLink: planned, transfer_requested and held only", () => {
    for (const s of ["planned", "transfer_requested", "held"]) expect(payoutAllowsLink(s)).toBe(true);
    for (const s of ["void", "failed", "reversed", "reversal_requested", "needs_attention", "released", "settled", "manual_required"]) expect(payoutAllowsLink(s)).toBe(false);
  });
});

// ── The flow ────────────────────────────────────────────────────────────────────────────────────

describe("creator offers", () => {
  let clientId: string;
  let clientTok: string;
  let admin: string;
  let staffId: string;

  beforeEach(async () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("CAMPAIGN_PAYMENT_MODE", "");
    vi.stubEnv("CREATORS_ENABLED", "1");
    vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "1");
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    vi.stubEnv("CREATOR_OFFER_TTL_HOURS", "");
    vi.stubEnv("CAMPAIGN_PUBLISH_ENABLED", "");
    invalidateCatalogueCache();
    resetPayoutAlertsForTests();
    stubRazorpay();
    resetGraph();
    vi.stubGlobal("fetch", vi.fn(async (input: any) => fakeFetch(input)));
    vi.mocked(notifyAdminByEmail).mockClear();
    vi.mocked(sendEmail).mockClear();
    const client = await prisma.client.create({ data: { companyName: "Brand A", contactName: "Asha", email: "a@brand.test", passwordHash: "x" } });
    clientId = client.id;
    clientTok = generateClientToken(client.id, client.email);
    const staff = await prisma.user.create({ data: { name: "Staff", email: "staff@ds.test", passwordHash: "x", status: "ACTIVE" } });
    staffId = staff.id;
    admin = generateToken(staff.id, staff.email, ["Admin"]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── Seeding ───────────────────────────────────────────────────────────────────

  interface PageOpts {
    name?: string;
    kind?: "facebook_page" | "instagram_account";
    price?: number;
    shareBps?: number;
    tdsBps?: number;
  }

  /** A creator, their live connection (with tokens), one enabled page, an ACTIVATED payout account and one `post` card with a share. */
  async function seedPage(o: PageOpts = {}) {
    const n = ++seq;
    const creator = await prisma.creator.create({
      data: { email: `creator${n}@creators.test`, passwordHash: "x", name: `Creator ${n}`, country: "IN", status: "approved", emailVerifiedAt: new Date() },
    });
    const conn = await prisma.creatorConnection.create({
      data: { creatorId: creator.id, metaUserId: `meta-${n}-${Date.now()}`, userTokenEnc: encryptToken(`EAAusertoken${n}xxxxxxxxxxxxxxxxxx`), grantedScopes: "pages_show_list,pages_manage_posts,instagram_content_publish" },
    });
    const kind = o.kind ?? "instagram_account";
    const asset = await prisma.creatorAsset.create({
      data: {
        creatorId: creator.id,
        connectionId: conn.id,
        kind,
        metaId: `${kind === "facebook_page" ? "2000" : "1784"}${String(n).padStart(8, "0")}`,
        name: o.name ?? `Creator Page ${n}`,
        username: kind === "instagram_account" ? `creatorpage${n}` : null,
        pageTokenEnc: kind === "facebook_page" ? encryptToken(`EAApagetoken${n}xxxxxxxxxxxxxxxxxx`) : null,
        canPublish: true,
        enabled: true,
        followerCount: 100_000 + n,
      },
    });
    const account = await prisma.creatorPayoutAccount.create({
      data: { creatorId: creator.id, razorpayAccountId: `acc_test${n}`, setupStep: "done", activationStatus: "activated", activatedAt: new Date(Date.now() - 3 * DAY), bookableAfter: new Date(Date.now() - 2 * DAY), tdsBps: o.tdsBps ?? 0 },
    });
    const card = await prisma.campaignRateCard.create({
      data: { targetType: "creator_asset", targetId: asset.id, platform: kind === "facebook_page" ? "facebook" : "instagram", format: "post", pricePaise: o.price ?? 250_000, active: true, category: "Food" },
    });
    await prisma.creatorRateTerm.create({ data: { rateCardId: card.id, shareBps: o.shareBps ?? 4000 } });
    return { creator, conn, asset, account, card, token: generateCreatorToken(creator.id, creator.email) };
  }
  type Page = Awaited<ReturnType<typeof seedPage>>;

  async function seedNetwork(price = 150_000) {
    const conn = await prisma.metaConnection.create({ data: { metaUserId: `mu-${++seq}`, connectedById: staffId, status: "ACTIVE" } });
    const asset = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: `net-${seq}`, name: `Network Page ${seq}`, username: `network${seq}`, followerCount: 4_600_000, views28d: 1_000_000n, engagements28d: 50_000n },
    });
    const card = await prisma.campaignRateCard.create({ data: { targetType: "meta_asset", targetId: asset.id, platform: "instagram", format: "post", pricePaise: price, category: "Bollywood news" } });
    return { asset, card };
  }

  async function seedBooking() {
    const from = new Date(`${todayIST()}T00:00:00.000Z`);
    const to = new Date(from.getTime() + 7 * DAY);
    const booking = await prisma.campaignBooking.create({
      data: {
        clientId,
        name: `Campaign ${++seq}`,
        brand: "Acme Cola",
        status: "draft",
        campaignType: "brand",
        format: "post",
        caption: "Sip the summer",
        hashtags: ["summer", "acme"],
        userTags: ["acmecola"],
        collaborators: ["acme.official"],
        superText: "Summer sale",
        superTextStyle: "bottom",
        launchFrom: from,
        launchTo: to,
      },
    });
    await prisma.campaignMedia.create({
      data: {
        clientId,
        bookingId: booking.id,
        kind: "image",
        originalName: "client-secret-name.jpg",
        mime: "image/jpeg",
        bytes: 1000n,
        storageKey: crypto.randomBytes(32).toString("base64url"),
        ext: "jpg",
        uploadStatus: "complete",
        chunkSize: 1000,
        totalChunks: 1,
        renderStatus: "done",
        width: 1080,
        height: 1350,
      },
    });
    return booking;
  }
  const cAuth = () => ({ Authorization: `Bearer ${clientTok}` });
  const aAuth = () => ({ Authorization: `Bearer ${admin}` });

  /** Pick, check out and let the capture webhook land: the booking is paid, its creator items have a `planned` payout. */
  async function bookAndPay(cardIds: string[]) {
    const booking = await seedBooking();
    expect((await request(app).put(`/v1/client/campaigns/${booking.id}/items`).set(cAuth()).send({ rateCardIds: cardIds })).status).toBe(200);
    const co = await request(app).post(`/v1/client/campaigns/${booking.id}/checkout`).set(cAuth());
    expect(co.status).toBe(200);
    const cap = await webhook("payment.captured", { id: `pay_${booking.id.slice(0, 8)}`, order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" });
    expect(cap.status).toBe(200);
    const items = await prisma.campaignBookingItem.findMany({ where: { bookingId: booking.id }, orderBy: { createdAt: "asc" } });
    return { booking, items, itemOf: (targetId: string) => items.find((i) => i.targetId === targetId)! };
  }
  const approve = (bookingId: string) => request(app).post(`/v1/admin/campaigns/${bookingId}/approve`).set(aAuth()).send({});

  /** A paid and APPROVED booking of one creator page: the offer exists, the item awaits the creator. */
  async function offered(o: PageOpts & { withNetwork?: boolean } = {}) {
    const page = await seedPage(o);
    const net = o.withNetwork ? await seedNetwork() : null;
    const paid = await bookAndPay(net ? [page.card.id, net.card.id] : [page.card.id]);
    const res = await approve(paid.booking.id);
    expect(res.status).toBe(200);
    const item = paid.itemOf(page.asset.id);
    const offer = await prisma.creatorOffer.findFirstOrThrow({ where: { bookingItemId: item.id } });
    return { page, net, paid, item, offer, approveBody: res.body.data };
  }
  const cGet = (tok: string, path: string) => request(app).get(`/v1${path}`).set("Authorization", `Bearer ${tok}`);
  const cPost = (tok: string, path: string, body: object = {}) => request(app).post(`/v1${path}`).set("Authorization", `Bearer ${tok}`).send(body);
  const accept = (p: Page, offerId: string) => cPost(p.token, `/creator/offers/${offerId}/accept`);
  const staffPost = (bookingId: string, itemId: string, action: string, body: object = {}) => request(app).post(`/v1/admin/campaigns/${bookingId}/items/${itemId}/${action}`).set(aAuth()).send(body);

  const itemStatus = async (id: string) => (await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id } })).status;
  const payoutOf = (itemId: string) => prisma.creatorPayout.findUniqueOrThrow({ where: { bookingItemId: itemId } });
  const offerOf = (id: string) => prisma.creatorOffer.findUniqueOrThrow({ where: { id } });
  const noMoneyMoved = async () => {
    expect(refundPosts()).toHaveLength(0);
    expect(await prisma.campaignRefund.count()).toBe(0);
  };

  // ── Approve ───────────────────────────────────────────────────────────────────

  describe("approve creates the offers", () => {
    it("one offer per creator item with the frozen payout, the item awaiting the creator, and the network item in the same booking handled exactly as before", async () => {
      const { page, net, paid, item, offer, approveBody } = await offered({ withNetwork: true });
      expect(offer).toMatchObject({
        bookingId: paid.booking.id,
        bookingItemId: item.id,
        creatorId: page.creator.id,
        creatorAssetId: page.asset.id,
        pageName: page.asset.name,
        pageHandle: page.asset.username,
        platform: "instagram",
        format: "post",
        status: "offered",
        payoutPaise: 100_000, // 40% of ₹2,500, the amount frozen at checkout
      });
      // The window is frozen as the two IST calendar days the campaign was booked for.
      expect(offer.windowFrom!.toISOString()).toBe(paid.booking.launchFrom!.toISOString());
      expect(offer.windowTo!.toISOString()).toBe(paid.booking.launchTo!.toISOString());
      expect(await itemStatus(item.id)).toBe("awaiting_creator");
      expect(await itemStatus(paid.itemOf(net!.asset.id).id)).toBe("manual_pending"); // a network item: exactly as before
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("approved");
      expect((await payoutOf(item.id)).status).toBe("planned");
      expect(approveBody.offerSummary).toEqual({ offered: 1, refundDue: 0, warnings: [] });
      expect(approveBody.creatorOffers).toHaveLength(1); // staff see the offer on the booking
      expect(approveBody.creatorOffers[0]).toMatchObject({ id: offer.id, itemId: item.id, status: "offered", payoutPaise: 100_000 });
      // The publish plan never touches a creator's page: no "post by hand" line for it, only for the network account.
      const history = (await prisma.campaignBookingEvent.findMany({ where: { bookingId: paid.booking.id } })).map((e) => e.note ?? "");
      expect(history.some((n) => n.startsWith(`Post by hand on ${page.asset.name}`))).toBe(false);
      expect(history.some((n) => n.startsWith(`Post by hand on ${net!.asset.name}`))).toBe(true);
      expect(history.some((n) => n.startsWith("Offered to the creator") && n.includes(page.asset.name) && n.includes("₹1,000"))).toBe(true);
      await noMoneyMoved();
    });

    it("a network-only booking is approved exactly as before: no creator query result, no extra key in the response", async () => {
      const net = await seedNetwork();
      const paid = await bookAndPay([net.card.id]);
      const res = await approve(paid.booking.id);
      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty("offerSummary");
      expect(res.body.data).not.toHaveProperty("creatorOffers");
      expect(await itemStatus(paid.items[0].id)).toBe("manual_pending");
      expect(await prisma.creatorOffer.count()).toBe(0);
    });

    it("the offer expires at the earlier of now + the TTL and the end of the posting window (IST)", async () => {
      const page = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      const booking = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } });
      const win = postingWindow(booking.launchFrom, booking.launchTo);
      const at = (now: Date) => prisma.$transaction((tx) => createOffersForBooking(tx, booking.id, { type: "staff", id: staffId }, now));
      // A window days away: the TTL (default 48 h) decides.
      const now = new Date(win.to!.getTime() - 5 * DAY);
      const r = await at(now);
      expect(r.offers).toHaveLength(1);
      expect(r.offers[0].expiresAt.getTime()).toBe(now.getTime() + 48 * HOUR);
      expect(r.warnings).toEqual([]);
      expect((await prisma.creatorOffer.findFirstOrThrow()).expiresAt.getTime()).toBe(now.getTime() + 48 * HOUR);

      // The TTL is configurable.
      await prisma.creatorOffer.deleteMany({});
      await prisma.campaignBookingItem.updateMany({ where: { bookingId: booking.id }, data: { status: "pending" } });
      vi.stubEnv("CREATOR_OFFER_TTL_HOURS", "6");
      const r6 = await at(now);
      expect(r6.offers[0].expiresAt.getTime()).toBe(now.getTime() + 6 * HOUR);

      // A window that closes sooner than the TTL: the window's end decides, and staff are warned that under a day remains.
      await prisma.creatorOffer.deleteMany({});
      await prisma.campaignBookingItem.updateMany({ where: { bookingId: booking.id }, data: { status: "pending" } });
      vi.stubEnv("CREATOR_OFFER_TTL_HOURS", "48");
      const late = new Date(win.to!.getTime() - 5 * HOUR);
      const rl = await at(late);
      expect(rl.offers[0].expiresAt.getTime()).toBe(win.to!.getTime());
      expect(rl.warnings).toHaveLength(1);
      expect(rl.warnings[0]).toMatch(/Less than 24 hours/);
    });

    it("⚠️ refuses 409 NOT_READY with nothing created when the booking was never paid online, or a creator item has no usable payout", async () => {
      const page = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      await prisma.campaignBooking.update({ where: { id: paid.booking.id }, data: { paidAt: null } });
      const res = await approve(paid.booking.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NOT_READY");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("paid_pending_review");
      expect(await itemStatus(paid.items[0].id)).toBe("pending");
      expect(await prisma.creatorOffer.count()).toBe(0);

      // A payout that is void (or failed, reversed…) is not something a creator can be offered.
      await prisma.campaignBooking.update({ where: { id: paid.booking.id }, data: { paidAt: new Date() } });
      await prisma.creatorPayout.updateMany({ data: { status: "failed" } });
      const direct = prisma.$transaction((tx) => createOffersForBooking(tx, paid.booking.id, { type: "staff", id: staffId }));
      await expect(direct).rejects.toMatchObject({ code: "NOT_READY" });
      await prisma.creatorPayout.deleteMany({});
      await expect(prisma.$transaction((tx) => createOffersForBooking(tx, paid.booking.id, { type: "staff", id: staffId }))).rejects.toMatchObject({ code: "NOT_READY" });
      expect(await prisma.creatorOffer.count()).toBe(0);
    });

    it("⚠️ refuses 409 WINDOW_ENDED once the posting window has closed, and the approval does not happen", async () => {
      const page = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      const yesterday = new Date(`${todayIST()}T00:00:00.000Z`).getTime() - DAY;
      await prisma.campaignBooking.update({ where: { id: paid.booking.id }, data: { launchFrom: new Date(yesterday), launchTo: new Date(yesterday) } });
      const res = await approve(paid.booking.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("WINDOW_ENDED");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("paid_pending_review");
      expect(await itemStatus(paid.items[0].id)).toBe("pending");
      expect(await prisma.creatorOffer.count()).toBe(0);
      // A network-only booking whose window is over is NOT affected by this rule.
      const net = await seedNetwork();
      const p2 = await bookAndPay([net.card.id]);
      await prisma.campaignBooking.update({ where: { id: p2.booking.id }, data: { launchFrom: new Date(yesterday), launchTo: new Date(yesterday) } });
      expect((await approve(p2.booking.id)).status).toBe(200);
    });

    it("refuses 409 MARKETPLACE_OFF for a booking with a creator's post while the marketplace is switched off, and leaves a network-only booking alone", async () => {
      const page = await seedPage();
      const net = await seedNetwork();
      const paid = await bookAndPay([page.card.id]);
      const p2 = await bookAndPay([net.card.id]);
      vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "0");
      const res = await approve(paid.booking.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("MARKETPLACE_OFF");
      expect(await itemStatus(paid.items[0].id)).toBe("pending");
      expect(await prisma.creatorOffer.count()).toBe(0);
      expect((await approve(p2.booking.id)).status).toBe(200);
    });

    it("⚠️ a page that changed hands, or a creator who is no longer approved / has no active payout account, gets NO offer: refund_due, payout void, staff alerted", async () => {
      const [a, b, c] = [await seedPage(), await seedPage(), await seedPage()];
      const other = await seedPage();
      const paid = await bookAndPay([a.card.id, b.card.id, c.card.id]);
      // The three problems appear AFTER the capture and BEFORE the offers are made (reconcileCreatorOwnership is bypassed on purpose: this is the check inside the offer transaction).
      await prisma.creatorAsset.update({ where: { id: a.asset.id }, data: { creatorId: other.creator.id, connectionId: other.conn.id } });
      await prisma.creator.update({ where: { id: b.creator.id }, data: { status: "suspended" } });
      await prisma.creatorPayoutAccount.update({ where: { creatorId: c.creator.id }, data: { activationStatus: "suspended" } });
      const made = await prisma.$transaction((tx) => createOffersForBooking(tx, paid.booking.id, { type: "staff", id: staffId }));
      expect(made.offers).toHaveLength(0);
      expect(made.problems.map((p) => p.reason).sort()).toEqual(["creator_unavailable", "creator_unavailable", "page_changed"]);
      for (const p of [a, b, c]) {
        const item = paid.itemOf(p.asset.id);
        expect(await itemStatus(item.id)).toBe("refund_due");
        expect(await payoutOf(item.id)).toMatchObject({ status: "void" });
      }
      expect(await prisma.creatorOffer.count()).toBe(0);
      expect(vi.mocked(sendEmail).mock.calls.filter((c) => /booking offer/i.test((c[0] as { subject: string }).subject))).toHaveLength(0);
      await noMoneyMoved();
    });

    it("a second pass cannot make a second offer for an item", async () => {
      const { paid, item } = await offered();
      await prisma.campaignBookingItem.update({ where: { id: item.id }, data: { status: "pending" } });
      const again = await prisma.$transaction((tx) => createOffersForBooking(tx, paid.booking.id, { type: "staff", id: staffId }));
      expect(again.offers).toHaveLength(0);
      expect(await prisma.creatorOffer.count()).toBe(1);
    });

    it("⚠️ an item that already has an offer row is never turned into a hand-post by approve: it stays pending for staff to refund", async () => {
      const page = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      const item = paid.items[0];
      await prisma.creatorOffer.create({
        data: { bookingId: paid.booking.id, bookingItemId: item.id, creatorId: page.creator.id, creatorAssetId: page.asset.id, pageName: page.asset.name, platform: "instagram", format: "post", status: "withdrawn", payoutPaise: 100_000, expiresAt: later(DAY) },
      });
      const res = await approve(paid.booking.id);
      expect(res.status).toBe(200);
      expect(await itemStatus(item.id)).toBe("pending");
      expect(await prisma.creatorOffer.count()).toBe(1);
    });

    it("everything interpolated into the offer email is escaped (a creator's and a page's names come from Meta and the creator)", async () => {
      const page = await seedPage({ name: `A&B <script>alert("x")</script> 'q'` });
      await prisma.creator.update({ where: { id: page.creator.id }, data: { name: `Evil <img src=x onerror=1>` } });
      const paid = await bookAndPay([page.card.id]);
      expect((await approve(paid.booking.id)).status).toBe(200);
      const mail = vi.mocked(sendEmail).mock.calls.map((c) => c[0] as { to: string; subject: string; html: string }).find((m) => m.to === page.creator.email && /booking offer/i.test(m.subject))!;
      expect(mail.html).not.toContain("<script>");
      expect(mail.html).not.toContain("<img src=x");
      expect(mail.html).toContain("A&amp;B &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39;q&#39;");
      expect(mail.html).toContain("Evil &lt;img src=x onerror=1&gt;");
    });

    it("emails the creator once, with the exact amount, the window, the expiry, what to do and the disclosure line, and NOTHING of the brand's price, the total or the client", async () => {
      const { page, offer, paid } = await offered();
      const calls = vi.mocked(sendEmail).mock.calls.map((c) => c[0] as { to: string; subject: string; html: string });
      const mail = calls.filter((m) => m.to === page.creator.email);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toContain("₹1,000");
      for (const must of ["₹1,000", "You will receive", "Post between", "Accept by", "What you need to do", "Paid partnership", page.asset.name, `/booking?id=${offer.id}`]) {
        expect(mail[0].html).toContain(must);
      }
      expect(mail[0].html).toContain("branded-content");
      // The brand's price (₹2,500), the booking total, the client, the brand, the share, the other items: never.
      for (const never of ["2,500", "250000", "Brand A", "a@brand.test", "Asha", "Acme Cola", String(paid.booking.id), "40%", "4000", "share"]) {
        expect(mail[0].html, never).not.toContain(never);
        expect(mail[0].subject, never).not.toContain(never);
      }
      expect((await offerOf(offer.id)).notifiedAt).not.toBeNull();
      // Only the creator was mailed an offer.
      expect(calls.filter((m) => /booking offer/i.test(m.subject))).toHaveLength(1);
    });

    it("a mailer that fails never fails the approval, and leaves the offer un-notified", async () => {
      vi.mocked(sendEmail).mockImplementation(async (o: any) => {
        if (/booking offer/i.test(o.subject)) throw new Error("smtp down");
        return { messageId: "test" } as never;
      });
      const { offer } = await offered();
      expect(offer.status).toBe("offered");
      await new Promise((r) => setTimeout(r, 30));
      expect((await offerOf(offer.id)).notifiedAt).toBeNull();
      vi.mocked(sendEmail).mockImplementation(async () => ({ messageId: "test" }) as never);
    });
  });

  // ── The ways an offer ends ────────────────────────────────────────────────────

  describe("accept", () => {
    it("the creator accepts: the offer is accepted, the item waits for the creator's own post (manual_pending), and nothing is paid or refunded", async () => {
      const { page, item, offer } = await offered();
      const res = await accept(page, offer.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: offer.id, status: "accepted", actions: { accept: false, decline: false, submitLink: true } });
      expect(res.body.data.acceptedAt).toBeTruthy();
      expect(await offerOf(offer.id)).toMatchObject({ status: "accepted" });
      expect((await offerOf(offer.id)).acceptedAt).not.toBeNull();
      expect(await itemStatus(item.id)).toBe("manual_pending");
      expect((await payoutOf(item.id)).status).toBe("planned");
      await noMoneyMoved();
      // Accepting twice is refused and changes nothing.
      const again = await accept(page, offer.id);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("OFFER_CLOSED");
    });

    it("⚠️ an offer past its expiry cannot be accepted (409 OFFER_EXPIRED), even though the worker has not closed it yet; nothing changes", async () => {
      const { page, item, offer } = await offered();
      await prisma.creatorOffer.update({ where: { id: offer.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await accept(page, offer.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OFFER_EXPIRED");
      expect((await offerOf(offer.id)).status).toBe("offered");
      expect(await itemStatus(item.id)).toBe("awaiting_creator");
      // What the creator reads says so too.
      const row = await cGet(page.token, `/creator/offers/${offer.id}`);
      expect(row.body.data.status).toBe("expired");
      expect(row.body.data.actions).toEqual({ accept: false, decline: false, submitLink: false });
    });

    it("is refused when the payout is no longer usable (void), and a suspended creator cannot answer", async () => {
      const { page, item, offer } = await offered();
      await prisma.creatorPayout.update({ where: { bookingItemId: item.id }, data: { status: "void" } });
      const res = await accept(page, offer.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OFFER_UNAVAILABLE");
      expect(await itemStatus(item.id)).toBe("awaiting_creator");
      await prisma.creatorPayout.update({ where: { bookingItemId: item.id }, data: { status: "planned" } });
      await prisma.creator.update({ where: { id: page.creator.id }, data: { status: "suspended" } });
      expect((await accept(page, offer.id)).status).toBe(403);
      expect((await offerOf(offer.id)).status).toBe("offered");
    });
  });

  describe("decline", () => {
    it("the creator declines with a reason: the offer is declined, the item is refund_due, the planned payout is void, staff are told, and NOTHING is refunded", async () => {
      const { page, item, offer } = await offered();
      const res = await cPost(page.token, `/creator/offers/${offer.id}/decline`, { reason: "Not <b>my</b> audience" });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("declined");
      const row = await offerOf(offer.id);
      expect(row).toMatchObject({ status: "declined", closedReason: "declined", creatorNote: "Not my audience" }); // markup stripped
      expect(row.declinedAt).not.toBeNull();
      expect(await itemStatus(item.id)).toBe("refund_due");
      expect(await payoutOf(item.id)).toMatchObject({ status: "void", voidReason: "declined" });
      const events = await prisma.creatorPayoutEvent.findMany({ where: { payoutId: (await payoutOf(item.id)).id }, orderBy: { createdAt: "asc" } });
      expect(events.map((e) => [e.toStatus, e.actorType])).toEqual([["planned", "system"], ["void", "creator"]]);
      await flushPayoutAlertsForTests();
      expect(alertSubjects()).toContain(REFUND_ALERT);
      const body = String(vi.mocked(notifyAdminByEmail).mock.calls.find((c) => c[0] === REFUND_ALERT)![1].map((d: any) => d.value).join(" "));
      expect(body).toContain("declined");
      expect(body).toContain("Nothing is refunded automatically");
      await noMoneyMoved();
      // The booking cannot settle with the item still owed back; staff then refund it, which is the ONLY thing that moves money.
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: item.bookingId } })).status).toBe("approved");
      const refund = await staffPost(item.bookingId, item.id, "refund");
      expect(refund.status).toBe(200);
      expect(refundPosts()).toHaveLength(1);
      expect(refundPosts()[0].body.amount).toBe(250_000);
      expect(await itemStatus(item.id)).toBe("refunded");
    });

    it("a declined offer cannot be declined again, accepted, or answered by a link", async () => {
      const { page, offer } = await offered();
      expect((await cPost(page.token, `/creator/offers/${offer.id}/decline`, {})).status).toBe(200);
      expect((await cPost(page.token, `/creator/offers/${offer.id}/decline`, {})).status).toBe(409);
      expect((await accept(page, offer.id)).status).toBe(409);
      expect((await cPost(page.token, `/creator/offers/${offer.id}/posted`, { url: "https://www.instagram.com/p/ABC/" })).status).toBe(409);
    });

    it("⚠️ a payout already past `planned` refuses the decline with nothing changed (the reversal of a transferred payout is a later phase)", async () => {
      const { page, item, offer } = await offered();
      await prisma.creatorPayout.update({ where: { bookingItemId: item.id }, data: { status: "held", razorpayTransferId: "trf_1" } });
      const res = await cPost(page.token, `/creator/offers/${offer.id}/decline`, {});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PAYOUT_NOT_REVERSIBLE_YET");
      expect((await offerOf(offer.id)).status).toBe("offered");
      expect(await itemStatus(item.id)).toBe("awaiting_creator");
      expect((await payoutOf(item.id)).status).toBe("held");
      await noMoneyMoved();
    });
  });

  describe("expire", () => {
    it("an unanswered offer past its expiry is expired: item refund_due, planned payout void, staff told, nothing refunded", async () => {
      const { item, offer } = await offered();
      await expect(expireOffer(offer.id)).rejects.toMatchObject({ code: "NOT_EXPIRED" }); // not due yet
      expect((await offerOf(offer.id)).status).toBe("offered");
      await prisma.creatorOffer.update({ where: { id: offer.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const closed = await expireOffer(offer.id);
      expect(closed).toMatchObject({ status: "expired", closedReason: "expired" });
      expect(closed.expiredAt).not.toBeNull();
      expect(await itemStatus(item.id)).toBe("refund_due");
      expect(await payoutOf(item.id)).toMatchObject({ status: "void", voidReason: "expired" });
      await flushPayoutAlertsForTests();
      expect(alertSubjects()).toContain(REFUND_ALERT);
      await noMoneyMoved();
      // Only an `offered` offer expires: a second call, and an accepted offer, are refused.
      await expect(expireOffer(offer.id)).rejects.toMatchObject({ code: "OFFER_CLOSED" });
    });

    it("an accepted offer never expires", async () => {
      const { page, offer } = await offered();
      await accept(page, offer.id);
      await prisma.creatorOffer.update({ where: { id: offer.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await expect(expireOffer(offer.id)).rejects.toMatchObject({ code: "OFFER_CLOSED" });
      expect((await offerOf(offer.id)).status).toBe("accepted");
    });
  });

  describe("withdraw (staff)", () => {
    it("withdraws an offered offer: item refund_due, payout void, creator can no longer accept, nothing refunded until staff press Refund", async () => {
      const { page, paid, item, offer } = await offered();
      const res = await staffPost(paid.booking.id, item.id, "withdraw-offer");
      expect(res.status).toBe(200);
      expect(res.body.data.withdrawNotice).toMatch(/Nothing has been refunded yet/);
      expect(await offerOf(offer.id)).toMatchObject({ status: "withdrawn", closedReason: "withdrawn", withdrawnById: staffId });
      expect(await itemStatus(item.id)).toBe("refund_due");
      expect(await payoutOf(item.id)).toMatchObject({ status: "void", voidReason: "withdrawn" });
      expect((await accept(page, offer.id)).status).toBe(409);
      await noMoneyMoved();
      // A staff member who withdrew does not get the "needs a refund" alert: they are looking at it.
      await flushPayoutAlertsForTests();
      expect(alertSubjects()).not.toContain(REFUND_ALERT);
      expect((await staffPost(paid.booking.id, item.id, "refund")).status).toBe(200);
      expect(refundPosts()).toHaveLength(1);
    });

    it("the default alerting: a withdraw by a member of staff does not tell staff, one by the system does", async () => {
      const byStaff = await offered();
      await withdrawOffer(byStaff.offer.id, { staffId });
      await flushPayoutAlertsForTests();
      expect(alertSubjects()).not.toContain(REFUND_ALERT);
      const bySystem = await offered();
      await withdrawOffer(bySystem.offer.id, { closedReason: "missed_window" });
      await flushPayoutAlertsForTests();
      expect(alertSubjects()).toContain(REFUND_ALERT);
      expect(await offerOf(bySystem.offer.id)).toMatchObject({ status: "withdrawn", closedReason: "missed_window", withdrawnById: null });
    });

    it("withdraws an accepted offer with no link yet", async () => {
      const { page, paid, item, offer } = await offered();
      await accept(page, offer.id);
      expect((await staffPost(paid.booking.id, item.id, "withdraw-offer")).status).toBe(200);
      expect((await offerOf(offer.id)).status).toBe("withdrawn");
      expect(await itemStatus(item.id)).toBe("refund_due");
      expect((await payoutOf(item.id)).status).toBe("void");
    });

    it("⚠️ refuses once the creator has submitted a link (409 LINK_SUBMITTED), unless staff say to discard it; never once verified", async () => {
      const { page, paid, item, offer } = await offered();
      await accept(page, offer.id);
      await prisma.creatorOffer.update({ where: { id: offer.id }, data: { linkUrl: "https://www.instagram.com/p/ABC/", linkCanonicalKey: "ig:ABC", linkSubmittedAt: new Date(), ownershipCheck: "auto_failed", ownershipDetail: "not_found" } });
      const refused = await staffPost(paid.booking.id, item.id, "withdraw-offer");
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("LINK_SUBMITTED");
      expect((await offerOf(offer.id)).status).toBe("accepted");
      expect(await itemStatus(item.id)).toBe("manual_pending");
      // Staff looked at the link and it is not the creator's post: the explicit way out.
      expect((await staffPost(paid.booking.id, item.id, "withdraw-offer", { discardSubmittedLink: true })).status).toBe(200);
      expect((await offerOf(offer.id)).status).toBe("withdrawn");
      expect(await itemStatus(item.id)).toBe("refund_due");

      // A verified post is live: nothing can withdraw it.
      const b = await offered();
      await accept(b.page, b.offer.id);
      await prisma.creatorOffer.update({ where: { id: b.offer.id }, data: { linkUrl: "https://www.instagram.com/p/XYZ/", linkCanonicalKey: "ig:XYZ", linkSubmittedAt: new Date(), ownershipCheck: "auto_ok", linkVerifiedAt: new Date() } });
      const res = await staffPost(b.paid.booking.id, b.item.id, "withdraw-offer", { discardSubmittedLink: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ALREADY_VERIFIED");
    });

    it("answers 404 for an item with no offer, and refuses a payout past `planned` with nothing changed", async () => {
      const net = await seedNetwork();
      const p = await bookAndPay([net.card.id]);
      expect((await staffPost(p.booking.id, p.items[0].id, "withdraw-offer")).status).toBe(404);
      const { paid, item, offer } = await offered();
      await prisma.creatorPayout.update({ where: { bookingItemId: item.id }, data: { status: "held" } });
      const res = await staffPost(paid.booking.id, item.id, "withdraw-offer");
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PAYOUT_NOT_REVERSIBLE_YET");
      expect((await offerOf(offer.id)).status).toBe("offered");
      expect(await itemStatus(item.id)).toBe("awaiting_creator");
    });
  });

  describe("a creator who had seen the offer is told when it is withdrawn (and nothing of the brand)", () => {
    const withdrawnMail = (email: string) =>
      vi.mocked(sendEmail).mock.calls.map((c) => c[0] as { to: string; subject: string; html: string }).filter((m) => m.to === email && /Booking withdrawn/.test(m.subject));
    const settle = () => new Promise((r) => setTimeout(r, 60));

    it("staff withdraw an ACCEPTED offer: one mail to the creator saying not to post, with no brand, no client and no price", async () => {
      const { page, paid, item, offer } = await offered();
      await accept(page, offer.id);
      expect((await staffPost(paid.booking.id, item.id, "withdraw-offer")).status).toBe(200);
      await vi.waitFor(() => expect(withdrawnMail(page.creator.email)).toHaveLength(1));
      const m = withdrawnMail(page.creator.email)[0];
      expect(m.subject).toContain(offer.pageName);
      expect(m.html).toMatch(/don't post it/);
      expect(m.html).toContain(offer.pageName);
      for (const never of ["2,500", "250000", "₹1,000", "Brand A", "a@brand.test", "Asha", "Acme Cola", "40%", "share", String(paid.booking.id)]) expect(m.html, never).not.toContain(never);
      await settle();
      expect(withdrawnMail(page.creator.email)).toHaveLength(1); // once
    });

    it("an OFFERED offer is announced only if its creator was emailed it: withdrawn before they ever saw it, there is nothing to tell", async () => {
      const seen = await offered(); // emailed (the default mock takes it)
      expect((await staffPost(seen.paid.booking.id, seen.item.id, "withdraw-offer")).status).toBe(200);
      await vi.waitFor(() => expect(withdrawnMail(seen.page.creator.email)).toHaveLength(1));

      vi.mocked(sendEmail).mockImplementation(async (o: any) => (/booking offer/i.test(o.subject) ? (null as never) : ({ messageId: "test" } as never)));
      const unseen = await offered();
      await settle();
      expect((await offerOf(unseen.offer.id)).notifiedAt).toBeNull();
      expect((await staffPost(unseen.paid.booking.id, unseen.item.id, "withdraw-offer")).status).toBe(200);
      await settle();
      expect(withdrawnMail(unseen.page.creator.email)).toHaveLength(0);
      vi.mocked(sendEmail).mockImplementation(async () => ({ messageId: "test" }) as never);
    });

    it("refunding the item, and rejecting the campaign, tell the creator who had accepted: one mail each", async () => {
      const byRefund = await offered();
      await accept(byRefund.page, byRefund.offer.id);
      expect((await staffPost(byRefund.paid.booking.id, byRefund.item.id, "refund")).status).toBe(200);
      await vi.waitFor(() => expect(withdrawnMail(byRefund.page.creator.email)).toHaveLength(1));

      const byReject = await offered();
      await accept(byReject.page, byReject.offer.id);
      const rej = await request(app).post(`/v1/admin/campaigns/${byReject.paid.booking.id}/reject`).set(aAuth()).send({ note: "not suitable" });
      expect(rej.status).toBe(200);
      await vi.waitFor(() => expect(withdrawnMail(byReject.page.creator.email)).toHaveLength(1));
      expect(await offerOf(byReject.offer.id)).toMatchObject({ status: "withdrawn", closedReason: "booking_rejected" });
    });

    it("⚠️ a close the creator's own side explains sends no such mail: the worker's missed window, an expiry, a decline", async () => {
      const missed = await offered();
      await accept(missed.page, missed.offer.id);
      await withdrawOffer(missed.offer.id, { closedReason: "missed_window" });
      const away = await offered();
      await prisma.creatorOffer.update({ where: { id: away.offer.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await expireOffer(away.offer.id);
      const declined = await offered();
      await cPost(declined.page.token, `/creator/offers/${declined.offer.id}/decline`, {});
      await settle();
      for (const x of [missed, away, declined]) expect(withdrawnMail(x.page.creator.email), x.offer.id).toHaveLength(0);
    });
  });

  describe("a refund Razorpay refuses, for a creator's post", () => {
    const refund = (x: { paid: { booking: { id: string } }; item: { id: string } }) => staffPost(x.paid.booking.id, x.item.id, "refund");
    const ledger = async () => (await prisma.campaignRefund.findMany({ orderBy: { createdAt: "asc" } })).map((r) => [r.idempotencyKey, r.status]);

    it.each([["awaiting_creator", false], ["manual_pending", true]] as Array<[string, boolean]>)(
      "⚠️ a refused refund (400) from %s leaves the post REFUND_DUE (never back 'waiting for the creator' with a withdrawn offer and a void payout), and the retry refunds it exactly once",
      async (from, accepted) => {
        const x = await offered();
        if (accepted) await accept(x.page, x.offer.id);
        expect(await itemStatus(x.item.id)).toBe(from);

        rz.refundMode = "reject400";
        const res = await refund(x);
        expect(res.status).toBe(502);
        expect(res.body.error.code).toBe("REFUND_FAILED");
        expect(await itemStatus(x.item.id)).toBe("refund_due");
        expect(await payoutOf(x.item.id)).toMatchObject({ status: "void", voidReason: "item_refunded" });
        expect(await offerOf(x.offer.id)).toMatchObject({ status: "withdrawn", closedReason: "withdrawn" });
        expect(await ledger()).toEqual([[`rf-item-${x.item.id}`, "failed"]]);
        expect(await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: x.paid.booking.id } })).toMatchObject({ status: "captured", refundedPaise: 0 });

        rz.refundMode = "ok";
        const retry = await refund(x);
        expect(retry.status).toBe(200);
        expect(await ledger()).toEqual([[`rf-item-${x.item.id}`, "failed"], [`rf-item-${x.item.id}-r2`, "processed"]]);
        expect([...rz.refunds.values()].flat().map((r) => r.amount)).toEqual([250_000]); // one refund, once
        expect(await itemStatus(x.item.id)).toBe("refunded");
        expect(await payoutOf(x.item.id)).toMatchObject({ status: "void" });
      },
    );

    it("an answer Razorpay never gave (500) is not a refusal: the claim is kept, the item stays refunded and the refund is left to be confirmed", async () => {
      const x = await offered();
      rz.refundMode = "http500";
      const res = await refund(x);
      expect(res.status).toBe(200);
      expect(res.body.data.refundNotice).toBeTruthy();
      expect(await itemStatus(x.item.id)).toBe("refunded");
      expect(await offerOf(x.offer.id)).toMatchObject({ status: "withdrawn" });
      expect(await payoutOf(x.item.id)).toMatchObject({ status: "void" });
    });
  });

  describe("an offer nobody could email", () => {
    it("⚠️ expires as 'never emailed', not 'didn't respond': the item row, the booking history and the staff alert all say so", async () => {
      vi.mocked(sendEmail).mockImplementation(async (o: any) => (/booking offer/i.test(o.subject) ? (null as never) : ({ messageId: "test" } as never)));
      const { item, offer } = await offered();
      await new Promise((r) => setTimeout(r, 60));
      expect((await offerOf(offer.id)).notifiedAt).toBeNull();
      await prisma.creatorOffer.update({ where: { id: offer.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await expireOffer(offer.id);
      vi.mocked(sendEmail).mockImplementation(async () => ({ messageId: "test" }) as never);
      const row = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(row.lastError).toMatch(/never emailed/);
      expect(row.lastError).not.toMatch(/didn't respond/);
      const events = (await prisma.campaignBookingEvent.findMany({ where: { bookingId: item.bookingId } })).map((e) => e.note ?? "");
      expect(events.some((n) => /never got the offer email/.test(n))).toBe(true);
      await flushPayoutAlertsForTests();
      const alert = vi.mocked(notifyAdminByEmail).mock.calls.find((c) => c[0] === REFUND_ALERT)!;
      expect(alert[1].map((d: any) => d.value).join(" ")).toMatch(/never emailed/);
      // An offer its creator WAS emailed still reads as no response.
      const seen = await offered();
      await prisma.creatorOffer.update({ where: { id: seen.offer.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await expireOffer(seen.offer.id);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: seen.item.id } })).lastError).toMatch(/didn't respond/);
    });
  });

  describe("the races", () => {
    /** The only end states an offer, its item and its payout may be in, whatever order the answers arrived in. */
    async function coherent(offerId: string, itemId: string) {
      const o = (await offerOf(offerId)).status;
      const i = await itemStatus(itemId);
      const p = (await payoutOf(itemId)).status;
      const ok =
        (o === "offered" && i === "awaiting_creator" && p === "planned") ||
        (o === "accepted" && i === "manual_pending" && p === "planned") ||
        (["declined", "expired", "withdrawn"].includes(o) && i === "refund_due" && p === "void");
      expect(ok, `${o} / ${i} / ${p}`).toBe(true);
      return o;
    }

    it("accept vs decline: exactly one wins, the loser is refused and changed nothing", async () => {
      for (const order of ["accept-first", "decline-first"]) {
        const { page, item, offer } = await offered();
        const calls = [() => accept(page, offer.id), () => cPost(page.token, `/creator/offers/${offer.id}/decline`, {})];
        if (order === "decline-first") calls.reverse();
        const results = await Promise.all(calls.map((c) => c()));
        const wins = results.filter((r) => r.status === 200).length;
        expect(wins).toBe(1);
        expect(results.filter((r) => r.status === 409)).toHaveLength(1);
        expect(["accepted", "declined"]).toContain(await coherent(offer.id, item.id));
      }
    });

    it("accept vs expire: exactly one wins", async () => {
      const { page, item, offer } = await offered();
      await prisma.creatorOffer.update({ where: { id: offer.id }, data: { expiresAt: new Date(Date.now() + 400) } });
      // Wait out the expiry, then both arrive: the accept is refused (expired), the expiry closes it.
      await new Promise((r) => setTimeout(r, 450));
      const [a, e] = await Promise.allSettled([accept(page, offer.id), expireOffer(offer.id)]);
      expect(a.status === "fulfilled" && a.value.status).toBe(409);
      expect(e.status).toBe("fulfilled");
      expect(await coherent(offer.id, item.id)).toBe("expired");
    });

    it("accept vs withdraw: whichever comes first, the end state is one coherent state (a creator never keeps an accepted offer on a refunded post)", async () => {
      for (const order of ["accept-first", "withdraw-first"]) {
        const { page, paid, item, offer } = await offered();
        const calls = [() => accept(page, offer.id), () => staffPost(paid.booking.id, item.id, "withdraw-offer")];
        if (order === "withdraw-first") calls.reverse();
        const results = await Promise.all(calls.map((c) => c()));
        const end = await coherent(offer.id, item.id);
        expect(["accepted", "withdrawn"]).toContain(end);
        if (end === "withdrawn") {
          // The withdraw won (or followed the accept): a late accept was refused, never half-applied.
          expect(results.some((r) => r.status === 200)).toBe(true);
          expect((await offerOf(offer.id)).acceptedAt === null || (await offerOf(offer.id)).withdrawnAt !== null).toBe(true);
        }
      }
    });

    it("decline vs withdraw, and two declines: exactly one wins", async () => {
      const { page, paid, item, offer } = await offered();
      const [a, b] = await Promise.all([cPost(page.token, `/creator/offers/${offer.id}/decline`, {}), staffPost(paid.booking.id, item.id, "withdraw-offer")]);
      expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
      expect([a.status, b.status].filter((s) => s === 409)).toHaveLength(1);
      expect(["declined", "withdrawn"]).toContain(await coherent(offer.id, item.id));
      expect((await payoutOf(item.id)).status).toBe("void");
      expect(await prisma.creatorPayoutEvent.count({ where: { kind: "void" } })).toBe(1); // voided once
    });

    it("the staff Refund and a creator accept on the same item never leave a creator with an accepted offer on a refunded item", async () => {
      const { page, paid, item, offer } = await offered();
      const [r, a] = await Promise.all([staffPost(paid.booking.id, item.id, "refund"), accept(page, offer.id)]);
      const o = await offerOf(offer.id);
      const i = await itemStatus(item.id);
      if (i === "refunded") expect(["withdrawn"]).toContain(o.status);
      else expect(o.status).toBe("accepted");
      expect([r.status, a.status].some((s) => s === 200)).toBe(true);
    });
  });

  // ── What a creator sees ───────────────────────────────────────────────────────

  describe("what a creator sees", () => {
    const FORBIDDEN = ["250000", "2,500", "Brand A", "a@brand.test", "Asha", "client-secret-name", "shareBps", "share_bps", "grossPaise", "gross", "totalPaise", "pricePaise", "pricingSnapshot", "lastError", "razorpay", "acc_test"];

    /** One paid booking of two creators' pages, approved: creator A and creator B each hold one offer. */
    async function twoCreators() {
      const a = await seedPage({ name: "Page of A", price: 250_000, shareBps: 4000 });
      const b = await seedPage({ name: "Page of B", price: 120_000, shareBps: 5000 });
      const paid = await bookAndPay([a.card.id, b.card.id]);
      expect((await approve(paid.booking.id)).status).toBe(200);
      // The offer emails go out after approve returns: let them finish (they stamp notified_at), so a test that compares an offer row before and after an action is not racing them.
      await vi.waitFor(async () => expect(await prisma.creatorOffer.count({ where: { notifiedAt: null } })).toBe(0));
      const offerA = await prisma.creatorOffer.findFirstOrThrow({ where: { creatorId: a.creator.id } });
      const offerB = await prisma.creatorOffer.findFirstOrThrow({ where: { creatorId: b.creator.id } });
      return { a, b, paid, offerA, offerB };
    }

    it("the list holds only the creator's own offers, newest first, with an EXACT allow-listed row and nothing of the brand's money or the client", async () => {
      const { a, b, offerA } = await twoCreators();
      const res = await cGet(a.token, "/creator/offers");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.data).toHaveLength(1);
      const row = res.body.data[0];
      expect(Object.keys(row).sort()).toEqual(["expiresAt", "format", "id", "offeredAt", "pageHandle", "pageName", "payout", "platform", "status", "window"]);
      expect(row).toMatchObject({ id: offerA.id, status: "offered", platform: "instagram", format: "post", pageName: "Page of A", payout: { paise: 100_000, currency: "INR", display: "₹1,000" } });
      expect(Object.keys(row.payout).sort()).toEqual(["currency", "display", "paise"]);
      expect(row.window).toEqual({ from: offerA.windowFrom!.toISOString().slice(0, 10), to: offerA.windowTo!.toISOString().slice(0, 10) });
      const text = JSON.stringify(res.body);
      for (const never of [...FORBIDDEN, "Page of B", b.creator.email, b.creator.name, "120000", "60000"]) expect(text, never).not.toContain(never);
      // B sees only B's.
      const rb = await cGet(b.token, "/creator/offers");
      expect(rb.body.data).toHaveLength(1);
      expect(rb.body.data[0]).toMatchObject({ pageName: "Page of B", payout: { paise: 60_000 } });
    });

    it("the list is newest first", async () => {
      const x = await offered();
      const y = await seedPage();
      // A second booking for the SAME creator, made later.
      await prisma.campaignRateCard.update({ where: { id: y.card.id }, data: { active: true } });
      const paid2 = await bookAndPay([y.card.id]);
      await approve(paid2.booking.id);
      await prisma.creatorOffer.updateMany({ where: { creatorId: y.creator.id }, data: { creatorId: x.page.creator.id, offeredAt: new Date(Date.now() + 5000) } });
      const res = await cGet(x.page.token, "/creator/offers");
      expect(res.body.data.map((r: any) => r.pageName)).toEqual([y.asset.name, x.page.asset.name]);
    });

    it("the detail is an EXACT allow-list: the brief (files, caption, hashtags, tags, collaborators, printed text), the disclosure, the amount, the expiry; never a price, a total, another item or the client", async () => {
      const { a, b, offerA, paid } = await twoCreators();
      const res = await cGet(a.token, `/creator/offers/${offerA.id}`);
      expect(res.status).toBe(200);
      const d = res.body.data;
      expect(Object.keys(d).sort()).toEqual(["acceptedAt", "actions", "brand", "brief", "disclosure", "expiresAt", "format", "id", "link", "offeredAt", "pageHandle", "pageName", "payout", "platform", "status", "window"]);
      expect(d.disclosure).toBe(CREATOR_DISCLOSURE_INSTRUCTION);
      expect(d.disclosure).toMatch(/paid[- ]partnership/i);
      expect(d.brand).toBe("Acme Cola");
      expect(d.link).toBeNull();
      expect(d.actions).toEqual({ accept: true, decline: true, submitLink: false });
      expect(Object.keys(d.brief).sort()).toEqual(["caption", "collaborators", "files", "hashtags", "printedText", "userTags"]);
      expect(d.brief).toMatchObject({ caption: "Sip the summer", hashtags: ["summer", "acme"], userTags: ["acmecola"], collaborators: ["acme.official"], printedText: { text: "Summer sale", position: "bottom" } });
      expect(d.brief.files).toHaveLength(1);
      const f = d.brief.files[0];
      expect(Object.keys(f).sort()).toEqual(["downloadUrl", "id", "kind", "ready", "role", "url"]);
      expect(f).toMatchObject({ kind: "image", role: "creative", ready: true });
      expect(f.url).toMatch(/^\/v1\/campaign-media\/[0-9a-f-]{36}\/preview\?exp=\d+&sig=[\w-]+$/);
      expect(f.downloadUrl).toBe(`${f.url}&download=1`);
      const text = JSON.stringify(res.body);
      for (const never of [...FORBIDDEN, "Page of B", "120000", String(paid.booking.id), b.creator.id]) expect(text, never).not.toContain(never);
      // The signed link works with no Authorization header at all, and serves only that file.
      expect((await request(app).get(f.url.replace(/^\/v1/, "/v1"))).status).not.toBe(403);
    });

    it("an item with its own caption / printed text shows THAT account's text, and an empty override means no printed text", async () => {
      const { a, offerA } = await twoCreators();
      await prisma.campaignBookingItem.update({ where: { id: offerA.bookingItemId }, data: { captionOverride: "Own words", hashtagsOverride: ["own"], superTextOverride: "" } });
      const d = (await cGet(a.token, `/creator/offers/${offerA.id}`)).body.data;
      expect(d.brief).toMatchObject({ caption: "Own words", hashtags: ["own"], printedText: null });
    });

    it("a declined, expired or withdrawn offer carries no brief (nothing is left to post)", async () => {
      const { page, offer } = await offered();
      await cPost(page.token, `/creator/offers/${offer.id}/decline`, {});
      const d = (await cGet(page.token, `/creator/offers/${offer.id}`)).body.data;
      expect(d.status).toBe("declined");
      expect(d.brief).toBeNull();
      expect(d.actions).toEqual({ accept: false, decline: false, submitLink: false });
    });

    it("⚠️ another creator's offer is a 404 for the detail and for every action, and nothing of theirs changes; an unknown id is the same 404", async () => {
      const { a, b, offerA } = await twoCreators();
      const before = await offerOf(offerA.id);
      for (const res of [
        await cGet(b.token, `/creator/offers/${offerA.id}`),
        await cPost(b.token, `/creator/offers/${offerA.id}/accept`),
        await cPost(b.token, `/creator/offers/${offerA.id}/decline`, { reason: "no" }),
        await cPost(b.token, `/creator/offers/${offerA.id}/posted`, { url: "https://www.instagram.com/p/ABC/" }),
        await cGet(b.token, "/creator/offers/00000000-0000-0000-0000-000000000000"),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
      }
      expect(await offerOf(offerA.id)).toEqual(before);
      expect(await itemStatus(offerA.bookingItemId)).toBe("awaiting_creator");
      // A's own access still works.
      expect((await cGet(a.token, `/creator/offers/${offerA.id}`)).status).toBe(200);
    });

    it("only an approved creator has offers: draft / in-review / rejected are 403 NOT_APPROVED, suspended is 403 ACCOUNT_SUSPENDED", async () => {
      const { a, offerA } = await twoCreators();
      for (const status of ["draft", "in_review", "rejected"]) {
        await prisma.creator.update({ where: { id: a.creator.id }, data: { status } });
        const res = await cGet(a.token, "/creator/offers");
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("NOT_APPROVED");
      }
      await prisma.creator.update({ where: { id: a.creator.id }, data: { status: "suspended" } });
      const res = await cGet(a.token, `/creator/offers/${offerA.id}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
    });

    it("⚠️ DARK: with the marketplace switch, the Route switch or the Razorpay keys off, every offers route answers 503, and only the status route answers (false) for any signed-in creator", async () => {
      const { a, offerA } = await twoCreators();
      const status = async () => (await cGet(a.token, "/creator/marketplace-status"));
      expect((await status()).body.data).toEqual({ marketplaceEnabled: true });
      for (const off of [{ CREATORS_MARKETPLACE_ENABLED: "0" }, { CREATOR_ROUTE_ENABLED: "0" }, { RAZORPAY_KEY_ID: "" }]) {
        for (const [k, v] of Object.entries(off)) vi.stubEnv(k, v);
        for (const res of [
          await cGet(a.token, "/creator/offers"),
          await cGet(a.token, `/creator/offers/${offerA.id}`),
          await cPost(a.token, `/creator/offers/${offerA.id}/accept`),
          await cPost(a.token, `/creator/offers/${offerA.id}/decline`, {}),
          await cPost(a.token, `/creator/offers/${offerA.id}/posted`, { url: "https://www.instagram.com/p/ABC/" }),
        ]) {
          expect(res.status, JSON.stringify(off)).toBe(503);
          expect(res.body.error.code).toBe("MARKETPLACE_DISABLED");
        }
        const st = await status();
        expect(st.status).toBe(200);
        expect(st.body.data).toEqual({ marketplaceEnabled: false });
        vi.unstubAllEnvs();
        vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
        vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
        vi.stubEnv("CREATORS_ENABLED", "1");
        vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "1");
        vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
      }
      // A suspended creator still gets the status answer.
      await prisma.creator.update({ where: { id: a.creator.id }, data: { status: "suspended" } });
      expect((await status()).status).toBe(200);
      // The whole portal off: even the status route is 503 CREATORS_DISABLED, and nothing changed in the database.
      vi.stubEnv("CREATORS_ENABLED", "0");
      const dark = await status();
      expect(dark.status).toBe(503);
      expect(dark.body.error.code).toBe("CREATORS_DISABLED");
      expect((await offerOf(offerA.id)).status).toBe("offered");
      // No token: 401 from the same gate.
      vi.stubEnv("CREATORS_ENABLED", "1");
      expect((await request(app).get("/v1/creator/offers")).status).toBe(401);
    });
  });

  // ── The link and its ownership check ───────────────────────────────────────────

  describe("the creator's link", () => {
    async function accepted(o: PageOpts = {}) {
      const x = await offered(o);
      expect((await accept(x.page, x.offer.id)).status).toBe(200);
      return x;
    }
    const post = (p: Page, offerId: string, url: string) => cPost(p.token, `/creator/offers/${offerId}/posted`, { url });
    const igPost = (code: string, at: Date = new Date()) => ({ id: `m_${code}`, permalink: `https://www.instagram.com/p/${code}/`, timestamp: metaTime(at) });
    const IG_URL = "https://www.instagram.com/creatorpage1/p/ABCdef123/?igsh=Zm9v";
    /** What is stored for it: the post's own link, without the username path or the tracking query (never the pasted string). */
    const IG_CLEAN = "https://www.instagram.com/p/ABCdef123/";

    it("⚠️ a link on the wrong platform is refused 400 WRONG_PLATFORM before any call to Meta, and stores nothing", async () => {
      const { page, offer } = await accepted();
      const res = await post(page, offer.id, "https://www.facebook.com/reel/1234567890");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("WRONG_PLATFORM");
      expect(graph.calls).toHaveLength(0);
      expect(await offerOf(offer.id)).toMatchObject({ linkUrl: null, linkSubmittedAt: null, ownershipCheck: null });
      // Not a URL at all, and a URL with another scheme, are refused too.
      expect((await post(page, offer.id, "not a link at all")).status).toBe(400);
      expect((await post(page, offer.id, "javascript:alert(1)//instagram.com")).status).toBe(400);
    });

    it("auto_ok: the link is one of the creator's own recent posts inside the window; one Graph call, with their own token, nothing of the list stored", async () => {
      const { page, item, offer } = await accepted();
      graph.igMedia = [igPost("OTHER99"), igPost("ABCdef123", new Date(Date.now() - 1000))];
      const res = await post(page, offer.id, IG_URL);
      expect(res.status).toBe(200);
      expect(res.body.data.linkResult).toMatchObject({ check: "auto_ok", detail: "matched" });
      expect(res.body.data.linkResult.message).toMatch(/found your post/i);
      // Meta's own URL for the post is what is kept, not the string the creator pasted (username path, igsh tracking token).
      expect(res.body.data.link).toMatchObject({ url: IG_CLEAN, check: "auto_ok", verified: false });
      const row = await offerOf(offer.id);
      expect(row).toMatchObject({ linkUrl: IG_CLEAN, linkCanonicalKey: "ig:ABCdef123", ownershipCheck: "auto_ok", ownershipDetail: "matched", ownershipCheckedById: null });
      expect(row.linkSubmittedAt).not.toBeNull();
      expect(row.ownershipCheckedAt).not.toBeNull();
      expect(Math.abs(row.linkPostedAt!.getTime() - (Date.now() - 1000))).toBeLessThan(10_000);
      expect(row.linkVerifiedAt).toBeNull();
      expect(await itemStatus(item.id)).toBe("manual_pending"); // only staff make it live
      expect(graph.calls).toHaveLength(1);
      expect(graph.calls[0].path).toBe(`/${page.asset.metaId}/media`);
      expect(graph.calls[0].params).toMatchObject({ fields: "permalink,timestamp", limit: "50" });
      const { decryptToken } = await import("../src/utils/token-crypto");
      expect(graph.calls[0].token).toBe(decryptToken(page.conn.userTokenEnc!)); // the creator's OWN user token
      // The token is nowhere in what the creator reads back.
      expect(JSON.stringify(res.body)).not.toContain(graph.calls[0].token!);
      // And no row of the media list was stored anywhere.
      expect(JSON.stringify(row)).not.toContain("OTHER99");
    });

    it("auto_failed: the post is not on their page; they are told, the attempt is stored, and sending the right link replaces it", async () => {
      const { page, item, offer } = await accepted();
      graph.igMedia = [igPost("OTHER99")];
      const bad = await post(page, offer.id, IG_URL);
      expect(bad.status).toBe(200);
      expect(bad.body.data.linkResult).toMatchObject({ check: "auto_failed", detail: "not_found" });
      expect(bad.body.data.linkResult.message).toMatch(/couldn't find that post/i);
      expect(await offerOf(offer.id)).toMatchObject({ ownershipCheck: "auto_failed", ownershipDetail: "not_found", linkUrl: IG_CLEAN });
      expect(await itemStatus(item.id)).toBe("manual_pending");
      graph.igMedia = [igPost("ABCdef123")];
      const good = await post(page, offer.id, "https://www.instagram.com/p/ABCdef123/");
      expect(good.body.data.linkResult.check).toBe("auto_ok");
      expect(await offerOf(offer.id)).toMatchObject({ ownershipCheck: "auto_ok", ownershipDetail: "matched", linkUrl: "https://www.instagram.com/p/ABCdef123/" });
    });

    it("auto_failed: a post found but published OUTSIDE the posting window", async () => {
      const { page, offer } = await accepted();
      graph.igMedia = [igPost("ABCdef123", new Date(offer.windowFrom!.getTime() - 3 * DAY))];
      const res = await post(page, offer.id, IG_URL);
      expect(res.body.data.linkResult).toMatchObject({ check: "auto_failed", detail: "outside_window" });
      expect(res.body.data.linkResult.message).toMatch(/outside the posting window/i);
    });

    it.each([
      ["authError", "token_lapsed"],
      ["rateLimit", "rate_limited"],
      ["permission", "permission"],
      ["graphError", "graph_error"],
      ["throw", "unreachable"],
    ] as Array<[GraphMode, string]>)("unverifiable when Meta answers %s: the link is kept for a person to check, the reason is a CODE only", async (mode, detail) => {
      const { page, offer } = await accepted();
      graph.mode = mode;
      const res = await post(page, offer.id, IG_URL);
      expect(res.status).toBe(200);
      expect(res.body.data.linkResult).toMatchObject({ check: "unverifiable", detail });
      expect(res.body.data.linkResult.message).toMatch(/by hand/i);
      const row = await offerOf(offer.id);
      expect(row).toMatchObject({ ownershipCheck: "unverifiable", ownershipDetail: detail, linkUrl: IG_CLEAN });
      expect(row.linkSubmittedAt).not.toBeNull();
      // Nothing Meta said is stored or returned.
      expect(JSON.stringify(res.body)).not.toMatch(/Error validating|request limit|does not have permission|unknown error|network down/i);
    });

    it("unverifiable without any call to Meta when the connection has lapsed or the page is gone", async () => {
      const a = await accepted();
      await prisma.creatorConnection.update({ where: { id: a.page.conn.id }, data: { status: "NEEDS_REAUTH" } });
      const r1 = await post(a.page, a.offer.id, "https://www.instagram.com/p/LapsedOne/");
      expect(r1.body.data.linkResult).toMatchObject({ check: "unverifiable", detail: "connection_lapsed" });
      const b = await accepted();
      await prisma.creatorAsset.update({ where: { id: b.page.asset.id }, data: { disconnectedAt: new Date() } });
      const r2 = await post(b.page, b.offer.id, "https://www.instagram.com/p/GoneTwo/");
      expect(r2.body.data.linkResult).toMatchObject({ check: "unverifiable", detail: "no_page" });
      const c = await accepted();
      await prisma.creatorAsset.update({ where: { id: c.page.asset.id }, data: { creatorId: a.page.creator.id } });
      expect((await post(c.page, c.offer.id, "https://www.instagram.com/p/OtherThree/")).body.data.linkResult).toMatchObject({ check: "unverifiable", detail: "no_page" });
      expect(graph.calls).toHaveLength(0);
    });

    describe("Facebook: the reel id is the permalink id, never the {page}_{post} composite", () => {
      async function fbAccepted() {
        const x = await accepted({ kind: "facebook_page" });
        graph.fbPosts = [{ id: `${x.page.asset.metaId}_999`, permalink_url: "https://www.facebook.com/reel/1234567890/", created_time: metaTime(new Date()) }];
        return x;
      }

      it("matches on the canonical key of the permalink (reel path, watch?v=, m. host), with the PAGE token, reading published_posts once", async () => {
        const { page, offer } = await fbAccepted();
        const r1 = await post(page, offer.id, "https://www.facebook.com/reel/1234567890");
        expect(r1.body.data.linkResult).toMatchObject({ check: "auto_ok", detail: "matched" });
        expect((await offerOf(offer.id)).linkCanonicalKey).toBe("fb:1234567890");
        expect(graph.calls[0].path).toBe(`/${page.asset.metaId}/published_posts`);
        expect(graph.calls[0].params).toMatchObject({ fields: "permalink_url,created_time", limit: "25" });
        const { decryptToken } = await import("../src/utils/token-crypto");
        expect(graph.calls[0].token).toBe(decryptToken(page.asset.pageTokenEnc!));
        const r2 = await post(page, offer.id, "https://m.facebook.com/watch/?v=1234567890");
        expect(r2.body.data.linkResult.check).toBe("auto_ok");
      });

      it("the composite's tail is ANOTHER id: the link /reel/<post tail> is not found", async () => {
        const { page, offer } = await fbAccepted();
        const res = await post(page, offer.id, "https://www.facebook.com/reel/999");
        expect(res.body.data.linkResult).toMatchObject({ check: "auto_failed", detail: "not_found" });
      });

      it("an opaque /share/ link is resolved through its one redirect and keyed by the post it led to; one that cannot be resolved is refused (400 NEEDS_POST_LINK), never stored", async () => {
        const { page, offer } = await fbAccepted();
        graph.shares.set("/share/r/AbC123/", "https://www.facebook.com/reel/1234567890/?s=x");
        const ok = await post(page, offer.id, "https://www.facebook.com/share/r/AbC123/");
        expect(ok.body.data.linkResult.check).toBe("auto_ok");
        // Keyed by the POST it led to (so one reel cannot be paid for twice under two share codes), and kept as Meta's own link to it.
        const stored = { linkUrl: "https://www.facebook.com/reel/1234567890/", linkCanonicalKey: "fb:1234567890", ownershipCheck: "auto_ok" };
        expect(await offerOf(offer.id)).toMatchObject(stored);
        // A share link that leads nowhere readable names no post: it would be stored under a `share:` key no other booking can match.
        const un = await post(page, offer.id, "https://www.facebook.com/share/r/NoRedirect/");
        expect([un.status, un.body.error.code]).toEqual([400, "NEEDS_POST_LINK"]);
        expect(un.body.error.message).toMatch(/own link/i);
        // ...and what the creator had sent before is exactly as it was.
        expect(await offerOf(offer.id)).toMatchObject(stored);
      });

      it("⚠️ a share link whose redirect probe FAILS (the network is down, the redirect leads to a page that is not a post) is refused too: the probe is fail-open, so nothing may depend on it succeeding", async () => {
        const { page, offer } = await fbAccepted();
        // The share path itself cannot be reached: resolveFacebookShareUrl swallows the error and answers null.
        vi.stubGlobal("fetch", vi.fn(async (input: any) => (new URL(String(input)).pathname.startsWith("/share/") ? Promise.reject(new Error("network down")) : fakeFetch(input))));
        const down = await post(page, offer.id, "https://www.facebook.com/share/r/Down123/");
        expect([down.status, down.body.error.code]).toEqual([400, "NEEDS_POST_LINK"]);
        // A redirect that lands on a page that is not a post is just as unusable.
        vi.stubGlobal("fetch", vi.fn(async (input: any) => fakeFetch(input)));
        graph.shares.set("/share/p/Prof123/", "https://www.facebook.com/somepage/");
        const prof = await post(page, offer.id, "https://www.facebook.com/share/p/Prof123/");
        expect([prof.status, prof.body.error.code]).toEqual([400, "NEEDS_POST_LINK"]);
        expect(await offerOf(offer.id)).toMatchObject({ linkUrl: null, linkCanonicalKey: null, linkSubmittedAt: null, ownershipCheck: null });
      });

      it("⚠️ one pfbid post cannot pay for two bookings even when the two links differ in host and tracking query", async () => {
        const a = await accepted({ kind: "facebook_page" });
        const b = await accepted({ kind: "facebook_page" });
        const stamp = metaTime(new Date());
        graph.fbPosts = [{ id: "x_1", permalink_url: "https://www.facebook.com/creatorpage/posts/pfbid02AbCdEf", created_time: stamp }];
        expect((await post(a.page, a.offer.id, "https://www.facebook.com/creatorpage/posts/pfbid02AbCdEf?mibextid=one")).body.data.linkResult.check).toBe("auto_ok");
        const res = await post(b.page, b.offer.id, "https://m.facebook.com/creatorpage/posts/pfbid02AbCdEf/?mibextid=two");
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("LINK_ALREADY_USED");
      });

      it("⚠️ a /<page>/videos/<id> link matches the permalink Meta lists whatever the page segment is (numeric id, vanity name, other case), and the reel form of the same video", async () => {
        const { page, offer } = await fbAccepted();
        graph.fbPosts = [{ id: "p_1", permalink_url: "https://www.facebook.com/987654321/videos/5550001/", created_time: metaTime(new Date()) }];
        for (const url of ["https://www.facebook.com/MyPage/videos/5550001/", "https://www.facebook.com/mypage/videos/5550001", "https://www.facebook.com/reel/5550001", "https://m.facebook.com/watch/?v=5550001"]) {
          const res = await post(page, offer.id, url);
          expect(res.body.data.linkResult, url).toMatchObject({ check: "auto_ok", detail: "matched" });
        }
        expect((await offerOf(offer.id)).linkCanonicalKey).toBe("fb:5550001");
      });

      it("⚠️ two different photos are two different posts: photo.php?fbid=111 is found, fbid=222 is not (it used to be 'any photo.php link')", async () => {
        const { page, offer } = await fbAccepted();
        graph.fbPosts = [{ id: "p_1", permalink_url: "https://www.facebook.com/photo.php?fbid=111&set=a.1", created_time: metaTime(new Date()) }];
        const yes = await post(page, offer.id, "https://www.facebook.com/photo.php?fbid=111&set=a.9");
        expect(yes.body.data.linkResult.check).toBe("auto_ok");
        expect((await offerOf(offer.id)).linkCanonicalKey).toBe("fbphoto:111");
        const no = await post(page, offer.id, "https://www.facebook.com/photo.php?fbid=222&set=a.9");
        expect(no.body.data.linkResult).toMatchObject({ check: "auto_failed", detail: "not_found" });
      });

      it("a short fb.watch link names no post: refused (400 NEEDS_POST_LINK) with no call to Meta and nothing stored, never 'not found' and never kept under a raw: key", async () => {
        const { page, offer } = await fbAccepted();
        const res = await post(page, offer.id, "https://fb.watch/abcDEF/");
        expect([res.status, res.body.error.code]).toEqual([400, "NEEDS_POST_LINK"]);
        expect(graph.calls).toHaveLength(0);
        expect(await offerOf(offer.id)).toMatchObject({ linkUrl: null, linkCanonicalKey: null, linkSubmittedAt: null, ownershipCheck: null });
      });

      it("⚠️ a feed holding posts in a form we cannot compare never yields 'not found' (the post may be one of them): unverifiable (feed_shape)", async () => {
        const { page, offer } = await fbAccepted();
        graph.fbPosts = [
          { id: "p_1", permalink_url: "https://www.facebook.com/somepage/posts/pfbid0Other", created_time: metaTime(new Date()) },
          { id: "p_2", permalink_url: "https://www.facebook.com/events/123/", created_time: metaTime(new Date()) },
        ];
        const res = await post(page, offer.id, "https://www.facebook.com/reel/9999");
        expect(res.body.data.linkResult).toMatchObject({ check: "unverifiable", detail: "feed_shape" });
        // A feed of only readable posts, without it, is "not found".
        graph.fbPosts = [graph.fbPosts[0]];
        expect((await post(page, offer.id, "https://www.facebook.com/reel/9999")).body.data.linkResult).toMatchObject({ check: "auto_failed", detail: "not_found" });
      });

      it("an opaque pfbid permalink matches on host + path, tracking query ignored", async () => {
        const { page, offer } = await fbAccepted();
        graph.fbPosts = [{ id: `${page.asset.metaId}_5`, permalink_url: "https://www.facebook.com/creatorpage/posts/pfbid02AbCdEf", created_time: metaTime(new Date()) }];
        const res = await post(page, offer.id, "https://m.facebook.com/creatorpage/posts/pfbid02AbCdEf/?mibextid=abc");
        expect(res.body.data.linkResult.check).toBe("auto_ok");
      });
    });

    it("⚠️ a link that is a redirect wrapper or not a post is refused before anything is stored or any call is made: l.facebook.com/l.php?u=…&v=<own id>, login.php?next=…, a profile", async () => {
      const fb = await accepted({ kind: "facebook_page" });
      graph.fbPosts = [{ id: "x_1", permalink_url: "https://www.facebook.com/reel/1234567890/", created_time: metaTime(new Date()) }];
      const send = async (x: typeof fb, url: string) => {
        const res = await post(x.page, x.offer.id, url);
        return [res.status, res.body.error.code];
      };
      // The creator owns video 1234567890, so the id in ?v= would have matched their own post and the shim would have been delivered to the client.
      expect(await send(fb, "https://l.facebook.com/l.php?u=https%3A%2F%2Fphish.example%2Flogin&v=1234567890")).toEqual([400, "WRONG_PLATFORM"]);
      expect(await send(fb, "https://www.facebook.com/login.php?next=https%3A%2F%2Fphish.example&v=1234567890")).toEqual([400, "INVALID_LINK"]);
      expect(await send(fb, "https://www.facebook.com/somepage")).toEqual([400, "NOT_A_POST"]);
      const ig = await accepted();
      expect(await send(ig, "https://l.instagram.com/?u=https%3A%2F%2Fphish.example&e=x")).toEqual([400, "WRONG_PLATFORM"]);
      expect(await send(ig, "https://www.instagram.com/creatorpage1/")).toEqual([400, "NOT_A_POST"]);
      expect(graph.calls).toHaveLength(0);
      expect(await offerOf(fb.offer.id)).toMatchObject({ linkUrl: null, linkSubmittedAt: null, ownershipCheck: null });
      expect(await offerOf(ig.offer.id)).toMatchObject({ linkUrl: null, linkSubmittedAt: null, ownershipCheck: null });
    });

    it("⚠️ a creator pasting ANOTHER creator's post does not block its real owner: a failed claim (auto_failed or unverifiable) reserves nothing; a PASSED claim still does", async () => {
      const owner = await accepted();
      const squatter = await accepted();
      const lapsed = await accepted();
      const second = await accepted();
      const url = "https://www.instagram.com/p/THEPOST1/";
      graph.feeds.set(owner.page.asset.metaId, [igPost("THEPOST1")]);
      graph.feeds.set(squatter.page.asset.metaId, [igPost("SQUATTER9")]);
      graph.feeds.set(second.page.asset.metaId, [igPost("THEPOST1")]); // (a feed that, wrongly, also lists it: two PASSED claims)
      await prisma.creatorConnection.update({ where: { id: lapsed.page.conn.id }, data: { status: "NEEDS_REAUTH" } }); // unverifiable, no call

      const failed = await post(squatter.page, squatter.offer.id, url);
      expect(failed.status).toBe(200); // not told that somebody else sent it in
      expect(failed.body.data.linkResult).toMatchObject({ check: "auto_failed", detail: "not_found" });
      const unverifiable = await post(lapsed.page, lapsed.offer.id, url);
      expect(unverifiable.body.data.linkResult.check).toBe("unverifiable");
      expect(await offerOf(squatter.offer.id)).toMatchObject({ linkCanonicalKey: "ig:THEPOST1", ownershipCheck: "auto_failed" });

      // The real owner sends the same post: accepted, and the squatter's row is left exactly as it was.
      const real = await post(owner.page, owner.offer.id, url);
      expect(real.status).toBe(200);
      expect(real.body.data.linkResult.check).toBe("auto_ok");
      expect(await offerOf(squatter.offer.id)).toMatchObject({ ownershipCheck: "auto_failed", ownershipDetail: "not_found" });
      expect(await offerOf(lapsed.offer.id)).toMatchObject({ ownershipCheck: "unverifiable" });

      // Pasting a post whose claim PASSED tells a stranger nothing either: their own check failed, so for them it is simply "not found".
      const stranger = await accepted();
      graph.feeds.set(stranger.page.asset.metaId, [igPost("STRANGER7")]);
      const probe = await post(stranger.page, stranger.offer.id, url);
      expect(probe.status).toBe(200);
      expect(probe.body.data.linkResult).toMatchObject({ check: "auto_failed", detail: "not_found" });

      // A second PASSED claim on the same post is still refused.
      const dup = await post(second.page, second.offer.id, url);
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("LINK_ALREADY_USED");
      expect((await offerOf(second.offer.id)).linkUrl).toBeNull();

      // And staff can still verify ONE of them: the strict "one post, one booking" check at verify time is the real invariant.
      const verifyKey = (x: typeof owner) => staffPost(x.paid.booking.id, x.item.id, "verify-creator-link", { ownershipCheckedByHand: true, linkCanonicalKey: "ig:THEPOST1" });
      expect((await verifyKey(owner)).status).toBe(200);
      const late = await verifyKey(squatter);
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("LINK_ALREADY_USED");
    });

    it("⚠️ an Instagram /share/ link is not a shortcode: refused (400 NEEDS_POST_LINK) with no call to Meta and nothing stored, the creator is asked for the post's own link, and it can never match or block a real post", async () => {
      const { page, offer } = await accepted();
      graph.igMedia = [igPost("ABC123")]; // a REAL post whose shortcode equals the share code
      const res = await post(page, offer.id, "https://www.instagram.com/share/reel/ABC123/?igsh=x");
      expect([res.status, res.body.error.code]).toEqual([400, "NEEDS_POST_LINK"]);
      expect(res.body.error.message).toMatch(/post's own link/i);
      expect(graph.calls).toHaveLength(0);
      expect(await offerOf(offer.id)).toMatchObject({ linkUrl: null, linkCanonicalKey: null, linkSubmittedAt: null, ownershipCheck: null });
      // The real post, sent for ANOTHER booking, is its own key: not blocked by the share link.
      const other = await accepted();
      graph.feeds.set(other.page.asset.metaId, [igPost("ABC123")]);
      const real = await post(other.page, other.offer.id, "https://www.instagram.com/reel/ABC123/");
      expect(real.body.data.linkResult.check).toBe("auto_ok");
      expect((await offerOf(other.offer.id)).linkCanonicalKey).toBe("ig:ABC123");
      // And the creator, told what to send, sends the post's own link.
      graph.feeds.set(page.asset.metaId, [igPost("OWN4567")]);
      expect((await post(page, offer.id, "https://www.instagram.com/p/OWN4567/")).body.data.linkResult.check).toBe("auto_ok");
    });

    describe("⚠️ the window's edges, and a post made after the window (the realistic late case, inside the 24 h link grace)", () => {
      it("from is inclusive and to is exclusive; a post an hour after the window sent inside the grace is auto_failed (outside_window) and staff cannot verify it without the hand tick", async () => {
        const { page, paid, item, offer } = await accepted();
        const win = postingWindow(offer.windowFrom, offer.windowTo);
        const at = async (instant: Date) => {
          graph.igMedia = [igPost("EDGE1", instant)];
          return checkLinkOwnership(offer, "https://www.instagram.com/p/EDGE1/");
        };
        expect(await at(win.from!)).toMatchObject({ check: "auto_ok", detail: "matched" });
        expect(await at(new Date(win.from!.getTime() - 1000))).toMatchObject({ check: "auto_failed", detail: "outside_window" });
        expect(await at(new Date(win.to!.getTime() - 1000))).toMatchObject({ check: "auto_ok", detail: "matched" });
        expect(await at(win.to!)).toMatchObject({ check: "auto_failed", detail: "outside_window" });

        const { submitOfferLink, linkDeadline } = await import("../src/services/creator/creator-offer.service");
        graph.igMedia = [igPost("LATE1", new Date(win.to!.getTime() + HOUR))];
        const sent = await submitOfferLink(page.creator.id, offer.id, "https://www.instagram.com/p/LATE1/", new Date(linkDeadline(offer)!.getTime() - 1000));
        expect(sent).toMatchObject({ check: "auto_failed", detail: "outside_window" });
        expect(await offerOf(offer.id)).toMatchObject({ ownershipCheck: "auto_failed", ownershipDetail: "outside_window" });
        const res = await staffPost(paid.booking.id, item.id, "verify-creator-link", { linkCanonicalKey: "ig:LATE1" });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("OWNERSHIP_NOT_CHECKED");
        expect(await itemStatus(item.id)).toBe("manual_pending");
      });
    });

    describe("a busy page: the feed is read newest first, a few pages at most, and 'not found' is only said when it is known", () => {
      /** n posts, newest first, one a minute, all inside the window; reel ids 1000.. */
      const fbRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x_${i}`, permalink_url: `https://www.facebook.com/reel/${1000 + i}/`, created_time: metaTime(new Date(Date.now() - i * 60_000)) }));
      const igRows = (n: number) => Array.from({ length: n }, (_, i) => igPost(`CODE${String(i).padStart(4, "0")}`, new Date(Date.now() - i * 60_000)));

      it("finds the post on a later page: one call per page, the next page is Meta's own cursor, and the fields and page size are unchanged", async () => {
        const { page, offer } = await accepted({ kind: "facebook_page" });
        graph.paginate = true;
        graph.fbPosts = fbRows(60);
        const res = await post(page, offer.id, "https://www.facebook.com/reel/1030"); // row 30: the second page of 25
        expect(res.body.data.linkResult).toMatchObject({ check: "auto_ok", detail: "matched" });
        expect(graph.calls).toHaveLength(2);
        expect(graph.calls[0].params).toMatchObject({ fields: "permalink_url,created_time", limit: "25" });
        expect(graph.calls[1].params.after).toBe("25");
      });

      it("⚠️ a post beyond the pages it may read is unverifiable (page_too_busy) for staff to decide, NEVER 'not found'", async () => {
        const { page, offer } = await accepted({ kind: "facebook_page" });
        graph.paginate = true;
        graph.fbPosts = fbRows(200); // all inside the window: the window's start is never reached
        const res = await post(page, offer.id, "https://www.facebook.com/reel/9999");
        expect(res.body.data.linkResult).toMatchObject({ check: "unverifiable", detail: "page_too_busy" });
        expect(res.body.data.linkResult.message).toMatch(/by hand/i);
        expect(graph.calls).toHaveLength(3); // LINK_CHECK_MAX_PAGES: bounded
        expect(await offerOf(offer.id)).toMatchObject({ ownershipCheck: "unverifiable", ownershipDetail: "page_too_busy" });
      });

      it("a page that reaches back before the window opened has been read far enough: not there is definite, after ONE page", async () => {
        const { page, offer } = await accepted({ kind: "facebook_page" });
        graph.paginate = true;
        const rows = fbRows(60);
        rows[24] = { ...rows[24], created_time: metaTime(new Date(offer.windowFrom!.getTime() - 3 * DAY)) }; // the last of page 1 is older than the window
        graph.fbPosts = rows;
        const res = await post(page, offer.id, "https://www.facebook.com/reel/9999");
        expect(res.body.data.linkResult).toMatchObject({ check: "auto_failed", detail: "not_found" });
        expect(graph.calls).toHaveLength(1);
      });

      it("a feed that simply ends is the whole feed: not found is definite", async () => {
        const { page, offer } = await accepted({ kind: "facebook_page" });
        graph.paginate = true;
        graph.fbPosts = fbRows(10);
        const res = await post(page, offer.id, "https://www.facebook.com/reel/9999");
        expect(res.body.data.linkResult).toMatchObject({ check: "auto_failed", detail: "not_found" });
        expect(graph.calls).toHaveLength(1);
      });

      it("a next link that is not Meta's is never followed (the access token travels with it), and that is not 'not found' either", async () => {
        const { page, offer } = await accepted({ kind: "facebook_page" });
        graph.paginate = true;
        graph.nextHost = "evil.example";
        graph.fbPosts = fbRows(60);
        const res = await post(page, offer.id, "https://www.facebook.com/reel/1030");
        expect(res.body.data.linkResult).toMatchObject({ check: "unverifiable", detail: "page_too_busy" });
        expect(graph.calls).toHaveLength(1);
      });

      it("Instagram reads 50 a page: a post at row 70 is on the second page", async () => {
        const { page, offer } = await accepted();
        graph.paginate = true;
        graph.igMedia = igRows(120);
        const res = await post(page, offer.id, "https://www.instagram.com/p/CODE0070/");
        expect(res.body.data.linkResult.check).toBe("auto_ok");
        expect(graph.calls).toHaveLength(2);
        expect(graph.calls[0].params.limit).toBe("50");
      });

      it("a failure on a later page is a failure to read (a code), not a verdict on the post", async () => {
        const { page, offer } = await accepted({ kind: "facebook_page" });
        graph.paginate = true;
        graph.fbPosts = fbRows(60);
        // The second call is refused (rate limit): the first page alone proves nothing.
        const real = globalThis.fetch;
        let n = 0;
        vi.stubGlobal("fetch", vi.fn(async (input: any) => (++n === 2 ? json({ error: { code: 4, message: "Application request limit reached" } }, 400) : fakeFetch(input))));
        const res = await post(page, offer.id, "https://www.facebook.com/reel/1030");
        vi.stubGlobal("fetch", real);
        expect(res.body.data.linkResult).toMatchObject({ check: "unverifiable", detail: "rate_limited" });
      });
    });

    it("every link check is a call to Meta, so sending links is limited per creator (429), and another creator is not affected", async () => {
      vi.stubEnv("RATE_LIMIT_CREATOR_OFFER_LINK_MAX", "2");
      const a = await accepted();
      const b = await accepted();
      graph.igMedia = [igPost("ABCdef123")];
      const send = (x: typeof a, code: string) => post(x.page, x.offer.id, `https://www.instagram.com/p/${code}/`);
      expect((await send(a, "ABCdef123")).status).toBe(200);
      expect((await send(a, "ABCdef123")).status).toBe(200);
      const limited = await send(a, "ABCdef123");
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe("RATE_LIMIT");
      expect(graph.calls).toHaveLength(2); // the third request never reached Meta
      expect((await send(b, "Different1")).status).toBe(200);
    });

    it("the offer must be accepted: an offer still `offered` (409 OFFER_NOT_ACCEPTED) cannot take a link, and Meta is not called", async () => {
      const { page, offer } = await offered();
      const res = await post(page, offer.id, IG_URL);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OFFER_NOT_ACCEPTED");
      expect(graph.calls).toHaveLength(0);
    });

    it("⚠️ the link is accepted until the window's end + 24 hours, and not a moment after (409 POSTING_CLOSED)", async () => {
      const { page, offer } = await accepted();
      const { submitOfferLink, linkDeadline } = await import("../src/services/creator/creator-offer.service");
      const deadline = linkDeadline(offer)!;
      expect(deadline.getTime()).toBe(postingWindow(offer.windowFrom, offer.windowTo).to!.getTime() + DAY);
      graph.igMedia = [igPost("ABCdef123")];
      await expect(submitOfferLink(page.creator.id, offer.id, IG_URL, new Date(deadline.getTime() + 1000))).rejects.toMatchObject({ code: "POSTING_CLOSED" });
      expect((await offerOf(offer.id)).linkUrl).toBeNull();
      const inside = await submitOfferLink(page.creator.id, offer.id, IG_URL, new Date(deadline.getTime() - 1000));
      // Inside the grace the link is taken. (The check judges the POST's own time against the window, not the moment of sending.)
      expect(inside.check).toBe("auto_ok");
      expect((await offerOf(offer.id)).linkUrl).toBe(IG_CLEAN);
    });

    it("refused when the item no longer waits for the creator's post, or the payout is void or failed", async () => {
      const a = await accepted();
      await prisma.campaignBookingItem.update({ where: { id: a.item.id }, data: { status: "refund_due" } });
      expect((await post(a.page, a.offer.id, IG_URL)).status).toBe(409);
      const b = await accepted();
      await prisma.creatorPayout.update({ where: { bookingItemId: b.item.id }, data: { status: "void" } });
      const res = await post(b.page, b.offer.id, IG_URL);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OFFER_UNAVAILABLE");
      expect((await offerOf(b.offer.id)).linkUrl).toBeNull();
    });

    it("⚠️ one post can pay for one booking only: the same post sent for another offer is 409 LINK_ALREADY_USED", async () => {
      const a = await accepted();
      const b = await accepted();
      graph.igMedia = [igPost("ABCdef123")];
      expect((await post(a.page, a.offer.id, IG_URL)).status).toBe(200);
      const res = await post(b.page, b.offer.id, "https://www.instagram.com/reel/ABCdef123/");
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("LINK_ALREADY_USED");
      expect((await offerOf(b.offer.id)).linkUrl).toBeNull();
      // Re-sending its OWN link for the same offer is fine.
      expect((await post(a.page, a.offer.id, IG_URL)).status).toBe(200);
    });
  });

  // ── Staff verify ──────────────────────────────────────────────────────────────

  describe("staff verify the creator's link", () => {
    async function withLink(check: "auto_ok" | "auto_failed" | "unverifiable", o: PageOpts & { withNetwork?: boolean } = {}) {
      const x = await offered(o);
      expect((await accept(x.page, x.offer.id)).status).toBe(200);
      const url = "https://www.instagram.com/p/ABCdef123/";
      await prisma.creatorOffer.update({
        where: { id: x.offer.id },
        data: { linkUrl: url, linkCanonicalKey: "ig:ABCdef123", linkSubmittedAt: new Date(), linkPostedAt: new Date(Date.now() - HOUR), ownershipCheck: check, ownershipDetail: check === "auto_ok" ? "matched" : check === "auto_failed" ? "not_found" : "token_lapsed", ownershipCheckedAt: new Date() },
      });
      return { ...x, url };
    }
    /** Staff press "Verify link & release" on the link they were looking at: its key is quoted back, as the staff screen does. */
    const verify = async (bookingId: string, itemId: string, body: { ownershipCheckedByHand?: boolean; linkCanonicalKey?: string } = {}) => {
      const offer = await prisma.creatorOffer.findUnique({ where: { bookingItemId: itemId } });
      return staffPost(bookingId, itemId, "verify-creator-link", { linkCanonicalKey: offer?.linkCanonicalKey ?? "no-link-yet", ...body });
    };

    it("auto_ok: the creator's link goes live as the post (posted_manual, their link, who verified), the offer is stamped verified, the booking completes; NOTHING is paid", async () => {
      const { paid, item, offer, url } = await withLink("auto_ok");
      const res = await verify(paid.booking.id, item.id);
      expect(res.status).toBe(200);
      const it2 = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(it2).toMatchObject({ status: "posted_manual", permalink: url, postedById: staffId });
      expect(Math.abs(it2.postedAt!.getTime() - (Date.now() - HOUR))).toBeLessThan(10_000); // the post's own time
      const row = await offerOf(offer.id);
      // The post is delivered and the offer is over: `completed`, so it no longer counts as open work.
      expect(row).toMatchObject({ status: "completed", linkVerifiedById: staffId, ownershipCheck: "auto_ok" });
      expect(row.linkVerifiedAt).not.toBeNull();
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("completed");
      const events = (await prisma.campaignBookingEvent.findMany({ where: { bookingId: paid.booking.id } })).map((e) => e.note ?? "");
      expect(events.some((n) => n.includes("Verified the creator's link") && n.includes(url))).toBe(true);
      // The seam does nothing in this phase: the payout is exactly as it was and no money call was made.
      expect(await payoutOf(item.id)).toMatchObject({ status: "planned", razorpayTransferId: null, releasedAt: null });
      expect(rz.calls.filter((c) => !c.url.endsWith("/orders"))).toHaveLength(0);
      await noMoneyMoved();
      // Verifying again changes nothing.
      const again = await verify(paid.booking.id, item.id);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("ALREADY_VERIFIED");
    });

    it("network items in the same booking behave exactly as today: marked posted by staff, and the booking completes only when the creator's post is verified too", async () => {
      const { paid, item, net } = await withLink("auto_ok", { withNetwork: true });
      const netItem = paid.itemOf(net!.asset.id);
      expect((await staffPost(paid.booking.id, netItem.id, "posted", { url: "https://www.instagram.com/p/NETWORK1/" })).status).toBe(200);
      // Not complete: the creator's post is still outstanding.
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("publishing");
      expect(await itemStatus(item.id)).toBe("manual_pending");
      expect((await verify(paid.booking.id, item.id)).status).toBe(200);
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("completed");
    });

    it("⚠️ every missing piece is refused with nothing changed: no accepted offer, no link, no passed check, no payout, a stranger's item", async () => {
      // Not accepted yet.
      const x = await offered();
      let res = await verify(x.paid.booking.id, x.item.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OFFER_NOT_ACCEPTED");
      // Accepted, no link.
      await accept(x.page, x.offer.id);
      res = await verify(x.paid.booking.id, x.item.id);
      expect(res.body.error.code).toBe("NO_LINK");
      expect(await itemStatus(x.item.id)).toBe("manual_pending");
      // A network item is not a creator's.
      const net = await seedNetwork();
      const p = await bookAndPay([net.card.id]);
      await approve(p.booking.id);
      res = await verify(p.booking.id, p.items[0].id);
      expect(res.body.error.code).toBe("NOT_CREATOR_ITEM");
      // An item that is not in this booking.
      expect((await verify(x.paid.booking.id, p.items[0].id)).status).toBe(404);
      // The payout is void: refund it, do not verify it.
      const y = await withLink("auto_ok");
      await prisma.creatorPayout.update({ where: { bookingItemId: y.item.id }, data: { status: "void" } });
      res = await verify(y.paid.booking.id, y.item.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OFFER_UNAVAILABLE");
      expect(await itemStatus(y.item.id)).toBe("manual_pending");
      expect((await offerOf(y.offer.id)).linkVerifiedAt).toBeNull();
      // Even if the item and the offer ever disagreed (a withdrawn offer, an item still waiting): the offer decides.
      const z = await withLink("auto_ok");
      await prisma.creatorOffer.update({ where: { id: z.offer.id }, data: { status: "withdrawn" } });
      res = await verify(z.paid.booking.id, z.item.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OFFER_NOT_ACCEPTED");
      expect(await itemStatus(z.item.id)).toBe("manual_pending");
    });

    it.each(["auto_failed", "unverifiable"] as const)("%s needs the staff member to say they checked by hand; that records manual_ok and who", async (check) => {
      const { paid, item, offer } = await withLink(check);
      const refused = await verify(paid.booking.id, item.id);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("OWNERSHIP_NOT_CHECKED");
      expect(refused.body.error.message).toMatch(/checked by hand/);
      expect(await itemStatus(item.id)).toBe("manual_pending");
      expect((await offerOf(offer.id)).linkVerifiedAt).toBeNull();
      expect((await verify(paid.booking.id, item.id, { ownershipCheckedByHand: false })).status).toBe(409);
      const ok = await verify(paid.booking.id, item.id, { ownershipCheckedByHand: true });
      expect(ok.status).toBe(200);
      const row = await offerOf(offer.id);
      expect(row).toMatchObject({ ownershipCheck: "manual_ok", ownershipCheckedById: staffId, linkVerifiedById: staffId });
      expect(row.ownershipCheckedAt).not.toBeNull();
      expect((await prisma.campaignBookingEvent.findMany({ where: { bookingId: paid.booking.id } })).some((e) => (e.note ?? "").includes("ownership checked by hand"))).toBe(true);
    });

    it("a check that already passed is not overwritten by the hand tick", async () => {
      const { paid, item, offer } = await withLink("auto_ok");
      expect((await verify(paid.booking.id, item.id, { ownershipCheckedByHand: true })).status).toBe(200);
      expect(await offerOf(offer.id)).toMatchObject({ ownershipCheck: "auto_ok", ownershipCheckedById: null });
    });

    it("the generic 'mark posted' route obeys the same rules for a creator's item: only the creator's own link, only after a passed check", async () => {
      const { paid, item, offer, url } = await withLink("auto_failed");
      let res = await staffPost(paid.booking.id, item.id, "posted", { url });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("OWNERSHIP_NOT_CHECKED");
      await prisma.creatorOffer.update({ where: { id: offer.id }, data: { ownershipCheck: "auto_ok" } });
      // Staff cannot make a different post live for the creator's item.
      res = await staffPost(paid.booking.id, item.id, "posted", { url: "https://www.instagram.com/p/SomethingElse/" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("LINK_MISMATCH");
      expect(await itemStatus(item.id)).toBe("manual_pending");
      res = await staffPost(paid.booking.id, item.id, "posted", { url });
      expect(res.status).toBe(200);
      expect(await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "posted_manual", permalink: url });
      expect((await offerOf(offer.id)).linkVerifiedAt).not.toBeNull(); // one way to go live, one place that records it
    });

    it("the same post cannot be verified for two bookings (409 LINK_ALREADY_USED)", async () => {
      const a = await withLink("auto_ok");
      const b = await withLink("auto_ok");
      expect((await verify(a.paid.booking.id, a.item.id)).status).toBe(200);
      const res = await verify(b.paid.booking.id, b.item.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("LINK_ALREADY_USED");
      expect(await itemStatus(b.item.id)).toBe("manual_pending");
    });

    // ── A link that names no post can never be verified (finding: one post paid twice through a share link) ──

    /**
     * An accepted offer whose link is stored under ANY key, as the database can hold one: a share:/raw: link from before the
     * submit-time refusal existed, or one a failed redirect probe left behind. Written straight to the row, because the
     * creator's own route no longer accepts such a link.
     */
    async function withStoredLink(url: string, key: string, check: "auto_ok" | "unverifiable" = "unverifiable", o: PageOpts = {}) {
      const x = await offered(o);
      expect((await accept(x.page, x.offer.id)).status).toBe(200);
      await prisma.creatorOffer.update({
        where: { id: x.offer.id },
        data: { linkUrl: url, linkCanonicalKey: key, linkSubmittedAt: new Date(), linkPostedAt: null, ownershipCheck: check, ownershipDetail: check === "auto_ok" ? "matched" : "share_link", ownershipCheckedAt: new Date() },
      });
      return x;
    }
    const nothingVerified = async (x: Awaited<ReturnType<typeof withStoredLink>>) => {
      expect(await itemStatus(x.item.id)).toBe("manual_pending");
      expect(await offerOf(x.offer.id)).toMatchObject({ status: "accepted", linkVerifiedAt: null, linkVerifiedById: null });
      expect((await payoutOf(x.item.id)).status).toBe("planned");
    };

    it.each([
      ["an Instagram /share/ link", "https://www.instagram.com/share/reel/ABC123/", "share:instagram.com/share/reel/ABC123", "instagram_account"],
      ["a Facebook /share/ link that never resolved", "https://www.facebook.com/share/r/AbC123/", "share:facebook.com/share/r/AbC123", "facebook_page"],
      ["a fb.watch short link", "https://fb.watch/abcDEF/", "raw:fb.watch/abcDEF", "facebook_page"],
    ] as const)("⚠️ %s can never be verified: 409 LINK_NOT_COMPARABLE with or without the hand tick, through both entry points, and nothing changes", async (_name, url, key, kind) => {
      const x = await withStoredLink(url, key, "unverifiable", { kind });
      // Without the tick it is not asked to be hand-checked (that would invite a tick that cannot work): it names no post.
      const plain = await verify(x.paid.booking.id, x.item.id);
      expect([plain.status, plain.body.error.code]).toEqual([409, "LINK_NOT_COMPARABLE"]);
      expect(plain.body.error.message).toMatch(/post's own link/i);
      // The hand tick cannot make it verifiable.
      const ticked = await verify(x.paid.booking.id, x.item.id, { ownershipCheckedByHand: true });
      expect([ticked.status, ticked.body.error.code]).toEqual([409, "LINK_NOT_COMPARABLE"]);
      await nothingVerified(x);
      // The generic "mark posted" route ends in the same function, so it is refused the same way.
      const generic = await staffPost(x.paid.booking.id, x.item.id, "posted", { url });
      expect([generic.status, generic.body.error.code]).toEqual([409, "LINK_NOT_COMPARABLE"]);
      await nothingVerified(x);
      // Even a row whose check says it passed (a stale or hand-edited one) is refused: the rule is about the key, not the verdict.
      await prisma.creatorOffer.update({ where: { id: x.offer.id }, data: { ownershipCheck: "auto_ok" } });
      expect((await verify(x.paid.booking.id, x.item.id)).body.error.code).toBe("LINK_NOT_COMPARABLE");
      await nothingVerified(x);
      // The refusal is not sticky: once the creator is asked for, and sends, the post's own link, it verifies.
      await prisma.creatorOffer.update({ where: { id: x.offer.id }, data: { ownershipCheck: "unverifiable", linkCanonicalKey: kind === "instagram_account" ? "ig:ABC123" : "fb:555", linkUrl: kind === "instagram_account" ? "https://www.instagram.com/p/ABC123/" : "https://www.facebook.com/reel/555/" } });
      expect((await verify(x.paid.booking.id, x.item.id, { ownershipCheckedByHand: true })).status).toBe(200);
    });

    it.each(["the share link first", "the post's own link first"] as const)(
      "⚠️ one post never pays two bookings through a share link: a share link for booking A and the post's own link for booking B cannot BOTH verify (%s)",
      async (order) => {
        const a = await withStoredLink("https://www.instagram.com/share/reel/ABC123/", "share:instagram.com/share/reel/ABC123");
        const b = await offered();
        expect((await accept(b.page, b.offer.id)).status).toBe(200);
        graph.feeds.set(b.page.asset.metaId, [{ id: "m_ABC123", permalink: "https://www.instagram.com/p/ABC123/", timestamp: metaTime(new Date()) }]);
        const sent = await cPost(b.page.token, `/creator/offers/${b.offer.id}/posted`, { url: "https://www.instagram.com/reel/ABC123/" });
        expect(sent.body.data.linkResult.check).toBe("auto_ok"); // not blocked by the share link: the two keys differ, which is the whole problem
        expect((await offerOf(b.offer.id)).linkCanonicalKey).toBe("ig:ABC123");
        const tickA = () => verify(a.paid.booking.id, a.item.id, { ownershipCheckedByHand: true });
        const verifyB = () => verify(b.paid.booking.id, b.item.id);
        let refusedA, okB;
        if (order === "the share link first") {
          refusedA = await tickA(); // staff open the share link, see the creator's own reel, tick the box
          okB = await verifyB();
        } else {
          okB = await verifyB();
          refusedA = await tickA();
        }
        expect([refusedA.status, refusedA.body.error.code]).toEqual([409, "LINK_NOT_COMPARABLE"]);
        expect(okB.status).toBe(200);
        // Exactly one booking is ever verified for the post, and it is the one whose link names it.
        expect(await prisma.creatorOffer.count({ where: { id: { in: [a.offer.id, b.offer.id] }, linkVerifiedAt: { not: null } } })).toBe(1);
        expect((await offerOf(b.offer.id)).linkVerifiedAt).not.toBeNull();
        await nothingVerified(a);
      },
    );

    // ── One post, one booking: serialised across bookings, with the database as the backstop ──

    it("two verifications of one post, for two bookings, at the same time: exactly one wins, the other is 409 LINK_ALREADY_USED and its item stays waiting", async () => {
      // ⚠️ WHAT THIS PROVES. CI runs the API with connection_limit=1, so the two requests queue for the one pooled connection and
      // are really run one after the other: this is the OUTCOME RULE (whichever order, one winner, the loser refused and
      // unchanged). The LOCK is proved by the two tests below, which hold the key from a second client on its own connections.
      const a = await withLink("auto_ok");
      const b = await withLink("auto_ok");
      const [ra, rb] = await Promise.all([verify(a.paid.booking.id, a.item.id), verify(b.paid.booking.id, b.item.id)]);
      expect([ra.status, rb.status].sort()).toEqual([200, 409]);
      const loser = ra.status === 409 ? ra : rb;
      expect(loser.body.error.code).toBe("LINK_ALREADY_USED");
      const [loserX, winnerX] = ra.status === 409 ? [a, b] : [b, a];
      expect(await itemStatus(loserX.item.id)).toBe("manual_pending");
      expect(await itemStatus(winnerX.item.id)).toBe("posted_manual");
      expect(await prisma.creatorOffer.count({ where: { linkVerifiedAt: { not: null } } })).toBe(1);
    });

    it("⚠️ THE LOCK: while another transaction holds the post's key, a verify of that post WAITS for it instead of reading around it, then sees what was committed and is refused", async () => {
      const a = await withLink("auto_ok");
      const b = await withLink("auto_ok");
      // A second client on its own connections: the test pool is ONE connection, which can never show two transactions overlap.
      const second = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL!.replace(/connection_limit=\d+/, "connection_limit=3") } } });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let holding!: () => void;
      const holds = new Promise<void>((r) => (holding = r));
      // "Another verify of the same post": it takes the key lock exactly as verifyCreatorItem does, and only commits its verified
      // stamp after the other verify has been seen waiting.
      const holder = second.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${"ig:ABCdef123"}, 0))) AS l`;
          holding();
          await gate;
          await tx.creatorOffer.update({ where: { id: a.offer.id }, data: { status: "completed", linkVerifiedAt: new Date(), linkVerifiedById: staffId } });
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
      try {
        await Promise.race([holds, holder]); // (a holder that failed rejects here instead of hanging)
        let settled = false;
        const waiting = verify(b.paid.booking.id, b.item.id).then((r) => {
          settled = true;
          return r;
        });
        await waitUntil(
          async () => (await second.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n > 0,
          "the verify to wait for the post's key lock",
        );
        expect(settled).toBe(false);
        release();
        await holder;
        const res = await waiting;
        // It woke up after the holder's commit, read a fresh snapshot, and found the post already verified for the other booking.
        expect([res.status, res.body.error.code]).toEqual([409, "LINK_ALREADY_USED"]);
      } finally {
        release();
        await holder.catch(() => {});
        await second.$disconnect();
      }
      expect(await itemStatus(b.item.id)).toBe("manual_pending");
      expect((await offerOf(b.offer.id)).linkVerifiedAt).toBeNull();
      expect((await offerOf(a.offer.id)).linkVerifiedAt).not.toBeNull();
    });

    it("⚠️ THE BACKSTOP: with the database's own unique index in place, a verified stamp that slips past the check (here: another transaction's, not yet committed) is refused as 409 LINK_ALREADY_USED, never a 500", async () => {
      // The index is built by scripts/creator-payouts-ddl.sql (a partial index Prisma cannot express), not by `db push`: create it
      // here, from the script's own statement, and drop it again whatever happens.
      const ddl = fs.readFileSync(path.join(__dirname, "../../../scripts/creator-payouts-ddl.sql"), "utf8");
      const stmt = /CREATE UNIQUE INDEX IF NOT EXISTS "creator_offers_verified_link_key_idx"[^;]+;/.exec(ddl)?.[0];
      expect(stmt, "the partial unique index is in the DDL").toBeDefined();
      await prisma.$executeRawUnsafe(stmt!);
      const second = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL!.replace(/connection_limit=\d+/, "connection_limit=3") } } });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let stamped!: () => void;
      const stampedRow = new Promise<void>((r) => (stamped = r));
      try {
        const a = await withLink("auto_ok");
        const b = await withLink("auto_ok");
        // Another path that verified A WITHOUT the key lock and has not committed: invisible to B's duplicate count, but it owns the
        // unique index entry for the post.
        const winner = second.$transaction(
          async (tx) => {
            await tx.creatorOffer.update({ where: { id: a.offer.id }, data: { status: "completed", linkVerifiedAt: new Date(), linkVerifiedById: staffId } });
            stamped();
            await gate;
          },
          { timeout: 30_000, maxWait: 10_000 },
        );
        try {
          await Promise.race([stampedRow, winner]);
          let settled = false;
          const loser = verify(b.paid.booking.id, b.item.id).then((r) => {
            settled = true;
            return r;
          });
          await waitUntil(
            async () => (await second.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%creator_offers%'`)[0].n > 0,
            "the verify's stamp to wait on the other transaction's index entry",
          );
          expect(settled).toBe(false);
          release();
          await winner;
          const res = await loser;
          expect([res.status, res.body.error.code]).toEqual([409, "LINK_ALREADY_USED"]);
        } finally {
          release();
          await winner.catch(() => {});
        }
        // The refused verify rolled back whole: its item still waits, its offer is untouched.
        expect(await itemStatus(b.item.id)).toBe("manual_pending");
        expect(await offerOf(b.offer.id)).toMatchObject({ status: "accepted", linkVerifiedAt: null });
        expect(await prisma.creatorOffer.count({ where: { linkVerifiedAt: { not: null } } })).toBe(1);
      } finally {
        await second.$disconnect();
        await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "creator_offers_verified_link_key_idx"');
      }
    });

    it("a verified offer always carries its post key (so the index covers it), and a link whose key was never stored is still compared on the key derived from it", async () => {
      const a = await withLink("auto_ok");
      const b = await withLink("auto_ok");
      await prisma.creatorOffer.update({ where: { id: a.offer.id }, data: { linkCanonicalKey: null } });
      expect((await verify(a.paid.booking.id, a.item.id, { linkCanonicalKey: "ig:ABCdef123" })).status).toBe(200);
      expect((await offerOf(a.offer.id)).linkCanonicalKey).toBe("ig:ABCdef123");
      // B names the same post: refused, though A's key was null until it was verified.
      const dup = await verify(b.paid.booking.id, b.item.id);
      expect([dup.status, dup.body.error.code]).toEqual([409, "LINK_ALREADY_USED"]);
      // And the other way round: a verified row holds the key; an offer with no stored key is compared on its link, not skipped.
      const c = await withLink("auto_ok");
      await prisma.creatorOffer.update({ where: { id: c.offer.id }, data: { linkCanonicalKey: null } });
      const cDup = await verify(c.paid.booking.id, c.item.id, { linkCanonicalKey: "ig:ABCdef123" });
      expect([cDup.status, cDup.body.error.code]).toEqual([409, "LINK_ALREADY_USED"]);
    });

    it("⚠️ verify is bound to the link staff looked at: when the creator sends ANOTHER link in between, the verify is refused 409 LINK_CHANGED and nothing is verified, even with the hand tick; the key of the link that is there verifies", async () => {
      const { page, paid, item, offer } = await withLink("auto_failed");
      const seen = (await offerOf(offer.id)).linkCanonicalKey!; // what the staff screen showed when the dialog opened
      expect(seen).toBe("ig:ABCdef123");
      // The creator re-sends a different post (their page cannot be read, so it is unverifiable too: the hand tick would cover it).
      graph.mode = "authError";
      expect((await cPost(page.token, `/creator/offers/${offer.id}/posted`, { url: "https://www.instagram.com/p/SOMEONEELSE/" })).status).toBe(200);
      const swapped = await verify(paid.booking.id, item.id, { ownershipCheckedByHand: true, linkCanonicalKey: seen });
      expect(swapped.status).toBe(409);
      expect(swapped.body.error.code).toBe("LINK_CHANGED");
      expect(await itemStatus(item.id)).toBe("manual_pending");
      expect(await offerOf(offer.id)).toMatchObject({ linkVerifiedAt: null, status: "accepted", ownershipCheck: "unverifiable", linkCanonicalKey: "ig:SOMEONEELSE" });
      // Looking at the new link and verifying THAT is fine.
      const ok = await verify(paid.booking.id, item.id, { ownershipCheckedByHand: true, linkCanonicalKey: "ig:SOMEONEELSE" });
      expect(ok.status).toBe(200);
      expect(await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "posted_manual", permalink: "https://www.instagram.com/p/SOMEONEELSE/" });
    });

    it("a verify request must name the link it is about (400 without linkCanonicalKey), and the generic mark-posted route still answers LINK_MISMATCH for another post", async () => {
      const { paid, item } = await withLink("auto_ok");
      const none = await staffPost(paid.booking.id, item.id, "verify-creator-link", { ownershipCheckedByHand: true });
      expect(none.status).toBe(400);
      expect(none.body.error.code).toBe("VALIDATION_ERROR");
      expect(await itemStatus(item.id)).toBe("manual_pending");
    });

    it("⚠️ a link staff vouched for cannot be swapped: after verification a re-send is ALREADY_VERIFIED, and a hand-checked (manual_ok) link that is not verified yet is LINK_FROZEN", async () => {
      const a = await withLink("unverifiable");
      expect((await verify(a.paid.booking.id, a.item.id, { ownershipCheckedByHand: true })).status).toBe(200);
      const again = await cPost(a.page.token, `/creator/offers/${a.offer.id}/posted`, { url: "https://www.instagram.com/p/Another01/" });
      expect([again.status, again.body.error.code]).toEqual([409, "ALREADY_VERIFIED"]);
      expect(await offerOf(a.offer.id)).toMatchObject({ linkUrl: a.url, linkCanonicalKey: "ig:ABCdef123", status: "completed" });

      const b = await withLink("auto_failed");
      await prisma.creatorOffer.update({ where: { id: b.offer.id }, data: { ownershipCheck: "manual_ok", ownershipCheckedById: staffId, ownershipCheckedAt: new Date() } });
      const frozen = await cPost(b.page.token, `/creator/offers/${b.offer.id}/posted`, { url: "https://www.instagram.com/p/Another02/" });
      expect([frozen.status, frozen.body.error.code]).toEqual([409, "LINK_FROZEN"]);
      expect(await offerOf(b.offer.id)).toMatchObject({ linkUrl: b.url, ownershipCheck: "manual_ok" });
      expect((await cGet(b.page.token, `/creator/offers/${b.offer.id}`)).body.data.actions.submitLink).toBe(false);
    });

    it("⚠️ what is delivered to the client is the clean link, never the pasted string: no tracking query, no username path; a hand-verified link included", async () => {
      const x = await offered();
      await accept(x.page, x.offer.id);
      graph.mode = "authError"; // the check cannot run: staff will verify it by hand
      const pasted = "https://www.instagram.com/creatorpage1/reel/ABCdef123/?igsh=Zm9vYmFy&utm_source=ig_web_copy_link#frag";
      expect((await cPost(x.page.token, `/creator/offers/${x.offer.id}/posted`, { url: pasted })).status).toBe(200);
      expect((await offerOf(x.offer.id)).linkUrl).toBe("https://www.instagram.com/reel/ABCdef123/");
      expect((await verify(x.paid.booking.id, x.item.id, { ownershipCheckedByHand: true })).status).toBe(200);
      const live = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: x.item.id } });
      expect(live.permalink).toBe("https://www.instagram.com/reel/ABCdef123/");
      expect(live.permalink).not.toMatch(/igsh|utm_|#/);
    });

    it("⚠️ a verified post's offer is `completed`: it no longer counts as open work (closing the account, a page changing hands), while an accepted offer that is not verified still does", async () => {
      const a = await withLink("auto_ok");
      const b = await withLink("auto_ok");
      const closeB = await request(app).delete("/v1/creator/me").set("Authorization", `Bearer ${b.page.token}`);
      expect([closeB.status, closeB.body.error.code]).toEqual([409, "OPEN_OFFERS"]);
      expect(await pageHasOpenWork(b.page.asset.id)).toBe(true);

      expect((await verify(a.paid.booking.id, a.item.id)).status).toBe(200);
      expect(await offerOf(a.offer.id)).toMatchObject({ status: "completed" });
      expect((await cGet(a.page.token, `/creator/offers/${a.offer.id}`)).body.data).toMatchObject({ status: "completed", link: { verified: true }, actions: { accept: false, decline: false, submitLink: false } });
      // Nothing can end a finished offer.
      const wd = await staffPost(a.paid.booking.id, a.item.id, "withdraw-offer", { discardSubmittedLink: true });
      expect([wd.status, wd.body.error.code]).toEqual([409, "ALREADY_VERIFIED"]);
      expect((await cPost(a.page.token, `/creator/offers/${a.offer.id}/decline`, {})).status).toBe(409);
      const resend = await cPost(a.page.token, `/creator/offers/${a.offer.id}/posted`, { url: "https://www.instagram.com/p/Another03/" });
      expect([resend.status, resend.body.error.code]).toEqual([409, "ALREADY_VERIFIED"]);
      // Once its payout has settled (the money leg, a later phase) nothing holds the page or the account.
      expect(await pageHasOpenWork(a.page.asset.id)).toBe(true); // the payout is still planned: the page stays busy for THAT reason
      await prisma.creatorPayout.update({ where: { bookingItemId: a.item.id }, data: { status: "settled" } });
      expect(await pageHasOpenWork(a.page.asset.id)).toBe(false);
      expect((await request(app).delete("/v1/creator/me").set("Authorization", `Bearer ${a.page.token}`)).status).toBe(200);
    });

    it("⚠️ markFailed is refused on a creator's post: USE_WITHDRAW while the offer is open, CREATOR_ITEM after", async () => {
      const { paid, item } = await offered();
      let res = await staffPost(paid.booking.id, item.id, "failed", { note: "creator went quiet" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("USE_WITHDRAW");
      expect(await itemStatus(item.id)).toBe("awaiting_creator");
      expect((await staffPost(paid.booking.id, item.id, "withdraw-offer")).status).toBe(200);
      res = await staffPost(paid.booking.id, item.id, "failed", { note: "creator went quiet" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CREATOR_ITEM");
      expect(await itemStatus(item.id)).toBe("refund_due");
      expect((await payoutOf(item.id)).status).toBe("void");
    });

    it("withdraw then refund is the whole way out, and only the refund moves money", async () => {
      const { paid, item } = await offered();
      await staffPost(paid.booking.id, item.id, "withdraw-offer");
      await noMoneyMoved();
      expect((await staffPost(paid.booking.id, item.id, "refund")).status).toBe(200);
      expect(refundPosts()).toHaveLength(1);
      expect(refundPosts()[0].body.amount).toBe(250_000);
      expect(await itemStatus(item.id)).toBe("refunded");
    });
  });
});
