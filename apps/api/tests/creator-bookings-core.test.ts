/**
 * Creator bookings, the core (payout plan Phase 3): a creator's page on a rate card with a staff-set share, who may book
 * it, what checkout freezes, what the capture plans, and what a booking may and may not do once creator money is on file.
 *
 * Everything runs against Postgres. Razorpay is a small stub (razorpayHttp.fetch): an order, a refund, a refund list.
 * No network, no real mail (sendEmail / notifyAdminByEmail are mocked). Every creator page, payout account and offer is
 * seeded straight into the database; the booking flow itself goes through the real client and staff routes.
 *
 * What this file is about, in order: the pure payout arithmetic and the item-status lists; staff pricing of creator pages;
 * the two lists (staff-priceable vs client-bookable, read fresh every time); the catalogue's allow-list; picking and
 * checkout (online only, re-checked, frozen); the capture (one planned payout per creator item, claimed once, rolled back
 * with everything else, page_changed); the approve-time owner check; the statuses that neither complete nor settle a
 * booking; the freeze guards; page take-over and purge; the refund seam (ensurePayoutRefundable); and the workers.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { prisma } from "@dashmani/db";
import {
  CREATOR_MIN_PAYOUT_PAISE,
  CREATOR_SHARE_MAX_BPS,
  ITEM_STATUSES,
  LIVE_ITEM_STATUSES,
  SETTLED_ITEM_STATUSES,
  campaignRateCardUpsertSchema,
  todayIST,
} from "@dashmani/shared";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { notifyAdminByEmail, sendEmail } from "../src/services/email.service";
import { razorpayHttp } from "../src/services/campaign/razorpay";
import { razorpayConfig } from "../src/services/campaign/config";
import * as bookingSvc from "../src/services/campaign/booking.service";
import { sendDeliveryEmail, sendItemLiveEmail } from "../src/services/campaign/delivery.service";
import { invalidateCatalogueCache, listBookableTargets, listCreatorTargets, creatorCardOfferable } from "../src/services/campaign/rate-card.service";
import { checkEligibility, runPublishTick } from "../src/services/campaign/publish.service";
import { computePayout, payoutAmountsAreValid } from "../src/services/creator/payout-math";
import {
  creatorItemsOfSnapshot,
  ensurePayoutRefundable,
  pageHasOpenWork,
  pagesWithOpenWork,
  planCreatorPayouts,
  reconcileCreatorOwnership,
} from "../src/services/creator/payout-ledger";
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { discoverCreatorAssets } from "../src/services/creator/creator-discovery.service";
import { creatorConfig } from "../src/services/creator/creator-config";
import { purgeCreatorPageData } from "../src/cron/creator.cron";
import { encryptToken } from "../src/utils/token-crypto";
import { generateClientToken, generateCreatorToken, generateHrToken, generateToken } from "./helpers";
import { FakeRazorpay, is } from "./fake-razorpay-route";
import { holdPayoutsOf, routeTransfersToFake } from "./payout-fixtures";
import { runRefundDueJob } from "../src/services/creator/creator-refund.service";

const WEBHOOK_SECRET = "whsec_test_creator_core";

// Transfers, reversals and disputes go to the stateful fake of Razorpay's Route API; orders and refunds stay with the small stub below.
const route = new FakeRazorpay();

// ── Razorpay: an order, a refund, a refund list ─────────────────────────────────

const rz = {
  calls: [] as Array<{ method: string; url: string; body: any; key: string | undefined }>,
  refunds: new Map<string, Array<{ id: string; amount: number; status: string; receipt: string | null; key: string | null }>>(),
  n: 0,
};
const refundPosts = () => rz.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund"));

function stubRazorpay() {
  rz.calls.length = 0;
  rz.refunds.clear();
  rz.n = 0;
  route.reset();
  const own = (async (url: any, init: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    const key = init?.headers?.["X-Refund-Idempotency"] as string | undefined;
    rz.calls.push({ method, url: u, body, key });
    if (method === "POST" && u.endsWith("/orders")) {
      return new Response(JSON.stringify({ id: `order_${++rz.n}`, amount: body.amount, currency: "INR", status: "created" }), { status: 200 });
    }
    const post = /\/payments\/([^/?]+)\/refund$/.exec(u);
    if (method === "POST" && post) {
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
  razorpayHttp.fetch = routeTransfersToFake(route, own as never);
}

function webhook(event: string, entity: Record<string, unknown>, eventId = crypto.randomUUID()) {
  const raw = JSON.stringify({ event, payload: { payment: { entity } } });
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return request(app).post("/v1/webhooks/razorpay").set("Content-Type", "application/json").set("x-razorpay-signature", sig).set("x-razorpay-event-id", eventId).send(raw);
}

// ── Pure: the arithmetic and the status lists ───────────────────────────────────

describe("computePayout", () => {
  it("is floor(price x share), then floor(gross x tds), and amount = gross - tds", () => {
    expect(computePayout(250_000, 4000, 1000)).toEqual({ grossPaise: 100_000, tdsPaise: 10_000, amountPaise: 90_000 });
    // Rounding goes DOWN at both steps, so a remainder stays with us.
    expect(computePayout(10_001, 3333, 0)).toEqual({ grossPaise: 3333, tdsPaise: 0, amountPaise: 3333 });
    expect(computePayout(10_001, 3333, 1)).toEqual({ grossPaise: 3333, tdsPaise: 0, amountPaise: 3333 });
    expect(computePayout(99_999, 5555, 1250)).toEqual({ grossPaise: 55_549, tdsPaise: 6943, amountPaise: 48_606 });
    // tdsBps defaults to 0.
    expect(computePayout(250_000, 4000)).toEqual({ grossPaise: 100_000, tdsPaise: 0, amountPaise: 100_000 });
  });

  it("holds amount <= gross <= price, and amount + tds = gross, over many prices, shares and tax rates", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const prices = [0, 1, 99, 100, 9_999, 10_000, 10_001, 123_457, 250_000, 99_999_999, 100_000_000];
    for (let i = 0; i < 5000; i++) {
      const price = i < prices.length ? prices[i] : rnd(100_000_001);
      const share = rnd(10_001);
      const tds = rnd(10_001);
      const r = computePayout(price, share, tds);
      expect(r.amountPaise).toBeGreaterThanOrEqual(0);
      expect(r.amountPaise).toBeLessThanOrEqual(r.grossPaise);
      expect(r.grossPaise).toBeLessThanOrEqual(price);
      expect(r.amountPaise + r.tdsPaise).toBe(r.grossPaise);
      expect(r.grossPaise).toBe(Math.floor((price * share) / 10_000));
      expect(payoutAmountsAreValid({ itemPricePaise: price, ...r })).toBe(true);
    }
  });

  it("is monotonic: a higher price or share never pays the creator less", () => {
    for (let price = 0; price < 2000; price += 7) {
      expect(computePayout(price + 1, 3000, 500).amountPaise).toBeGreaterThanOrEqual(computePayout(price, 3000, 500).amountPaise);
    }
    for (let share = 0; share < 10_000; share += 97) {
      expect(computePayout(77_777, share + 1, 0).amountPaise).toBeGreaterThanOrEqual(computePayout(77_777, share, 0).amountPaise);
    }
  });

  it("refuses anything that is not a whole number in range (wrong money fails loudly)", () => {
    expect(() => computePayout(-1, 1000)).toThrow(RangeError);
    expect(() => computePayout(100.5, 1000)).toThrow(RangeError);
    expect(() => computePayout(Number.NaN, 1000)).toThrow(RangeError);
    expect(() => computePayout(1000, -1)).toThrow(RangeError);
    expect(() => computePayout(1000, 10_001)).toThrow(RangeError);
    expect(() => computePayout(1000, 1000, 10_001)).toThrow(RangeError);
    expect(() => computePayout(1000, 1000.5)).toThrow(RangeError);
  });

  it("payoutAmountsAreValid mirrors the table's rules", () => {
    const ok = { itemPricePaise: 1000, grossPaise: 500, tdsPaise: 50, amountPaise: 450 };
    expect(payoutAmountsAreValid(ok)).toBe(true);
    expect(payoutAmountsAreValid({ ...ok, amountPaise: 451 })).toBe(false); // amount + tds != gross
    expect(payoutAmountsAreValid({ ...ok, grossPaise: 1001, amountPaise: 951 })).toBe(false); // gross > price
    expect(payoutAmountsAreValid({ ...ok, tdsPaise: -50, amountPaise: 550 })).toBe(false);
    expect(payoutAmountsAreValid({ ...ok, itemPricePaise: 1000.5 })).toBe(false);
  });
});

describe("item statuses", () => {
  it("awaiting_creator and refund_due exist, and are NEITHER live NOR settled", () => {
    expect(ITEM_STATUSES).toContain("awaiting_creator");
    expect(ITEM_STATUSES).toContain("refund_due");
    for (const s of ["awaiting_creator", "refund_due"] as const) {
      expect(LIVE_ITEM_STATUSES).not.toContain(s);
      expect(SETTLED_ITEM_STATUSES).not.toContain(s);
    }
    // The two lists are exactly what they were.
    expect([...LIVE_ITEM_STATUSES]).toEqual(["posted_manual", "published"]);
    expect([...SETTLED_ITEM_STATUSES]).toEqual(["posted_manual", "published", "failed", "refunded"]);
  });
});

describe("the rate-card upsert schema", () => {
  const card = (over: Record<string, unknown>) => ({ targetType: "creator_asset", targetId: crypto.randomUUID(), format: "post", pricePaise: 250_000, ...over });
  const parse = (c: Record<string, unknown>) => campaignRateCardUpsertSchema.safeParse({ cards: [c] });

  it("needs a share on a creator card, forbids it elsewhere, and lets a delete go without one", () => {
    expect(parse(card({})).success).toBe(false);
    expect(parse(card({ shareBps: 4000 })).success).toBe(true);
    expect(parse(card({ pricePaise: null })).success).toBe(true);
    expect(parse(card({ targetType: "meta_asset", shareBps: 4000 })).success).toBe(false);
    expect(parse(card({ targetType: "meta_asset" })).success).toBe(true);
    expect(parse(card({ targetType: "social_account", shareBps: 1 })).success).toBe(false);
  });

  it("takes 1..10000 here; the service owns the 9000 cap (so the answer is SHARE_TOO_HIGH, not a generic 400)", () => {
    expect(parse(card({ shareBps: 0 })).success).toBe(false);
    expect(parse(card({ shareBps: 9001 })).success).toBe(true);
    expect(parse(card({ shareBps: 10_001 })).success).toBe(false);
    expect(parse(card({ shareBps: 40.5 })).success).toBe(false);
  });
});

// ── Everything below talks to Postgres ──────────────────────────────────────────

let seq = 0;
const later = (ms: number) => new Date(Date.now() + ms);
const DAY = 86_400_000;
const alertSubjects = () => vi.mocked(notifyAdminByEmail).mock.calls.map((c) => String(c[0]));
/** The staff alert for a creator item that was paid for but cannot go ahead. */
const PROBLEM_SUBJECT = "A creator's post can't go ahead and needs a refund";

// vitest runs top-level beforeEach hooks in parallel with setup.ts's TRUNCATE: every DB-seeding hook lives inside a describe.
describe("creator bookings, the core", () => {
  let clientId: string;
  let clientTok: string;
  let admin: string;
  let staffId: string;

  beforeAll(() => {
    vi.stubEnv("CAMPAIGN_PAYMENT_MODE", "");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("CAMPAIGN_PAYMENT_MODE", "");
    vi.stubEnv("CREATORS_ENABLED", "1");
    vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "1");
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    // The money leg (the transfer kick after a capture) is not under test here: payouts stay exactly where these tests put them.
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    vi.stubEnv("CAMPAIGN_PUBLISH_ENABLED", "");
    invalidateCatalogueCache();
    resetPayoutAlertsForTests();
    stubRazorpay();
    vi.mocked(notifyAdminByEmail).mockClear();
    const client = await prisma.client.create({ data: { companyName: "Brand A", contactName: "Asha", email: "a@brand.test", passwordHash: "x" } });
    clientId = client.id;
    clientTok = generateClientToken(client.id, client.email);
    const staff = await prisma.user.create({ data: { name: "Staff", email: "staff@ds.test", passwordHash: "x", status: "ACTIVE" } });
    staffId = staff.id;
    admin = generateToken(staff.id, staff.email, ["Admin"]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // ── Seeding ───────────────────────────────────────────────────────────────────

  interface PageOpts {
    name?: string;
    creatorName?: string;
    creatorStatus?: string;
    kind?: "facebook_page" | "instagram_account";
    price?: number;
    entertainment?: number | null;
    audio?: number | null;
    /** null = no creator_rate_terms row. */
    shareBps?: number | null;
    cardActive?: boolean;
    tdsBps?: number;
    /** false = no payout account at all. */
    payout?: boolean;
    activation?: string;
    bookableAfter?: Date | null;
    enabled?: boolean;
    canPublish?: boolean;
    followers?: number;
  }

  /** A creator, their live connection, one enabled page, an ACTIVATED payout account and one `post` card with a share. */
  async function seedPage(o: PageOpts = {}) {
    const n = ++seq;
    const creator = await prisma.creator.create({
      data: {
        email: `creator${n}@creators.test`,
        passwordHash: "x",
        name: o.creatorName ?? `Creator ${n}`,
        country: "IN",
        status: o.creatorStatus ?? "approved",
        emailVerifiedAt: new Date(),
      },
    });
    const conn = await prisma.creatorConnection.create({
      data: { creatorId: creator.id, metaUserId: `meta-${n}-${Date.now()}`, userTokenEnc: encryptToken("EAAusertokenxxxxxxxxxxxxxxxxxx"), grantedScopes: "pages_show_list,pages_manage_posts,instagram_content_publish" },
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
        canPublish: o.canPublish ?? true,
        enabled: o.enabled ?? true,
        followerCount: o.followers ?? 100_000 + n,
      },
    });
    const account =
      o.payout === false
        ? null
        : await prisma.creatorPayoutAccount.create({
            data: {
              creatorId: creator.id,
              razorpayAccountId: `acc_test${n}`,
              setupStep: "done",
              activationStatus: o.activation ?? "activated",
              activatedAt: new Date(Date.now() - 3 * DAY),
              bookableAfter: o.bookableAfter === undefined ? new Date(Date.now() - 2 * DAY) : o.bookableAfter,
              tdsBps: o.tdsBps ?? 0,
            },
          });
    const platform = kind === "facebook_page" ? "facebook" : "instagram";
    const card = await prisma.campaignRateCard.create({
      data: {
        targetType: "creator_asset",
        targetId: asset.id,
        platform,
        format: "post",
        pricePaise: o.price ?? 250_000,
        entertainmentPricePaise: o.entertainment === undefined ? null : o.entertainment,
        audioAddonPaise: o.audio === undefined ? null : o.audio,
        active: o.cardActive ?? true,
        category: "Food",
      },
    });
    const term = o.shareBps === null ? null : await prisma.creatorRateTerm.create({ data: { rateCardId: card.id, shareBps: o.shareBps ?? 4000 } });
    return { creator, conn, asset, account, card, term };
  }
  type Page = Awaited<ReturnType<typeof seedPage>>;

  /** One of OUR OWN network accounts, with a `post` card. */
  async function seedNetwork(price = 150_000) {
    const staff = await prisma.user.findFirstOrThrow();
    const conn = await prisma.metaConnection.create({ data: { metaUserId: `mu-${++seq}`, connectedById: staff.id, status: "ACTIVE" } });
    const asset = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: `net-${seq}`, name: `Network Page ${seq}`, username: `network${seq}`, followerCount: 4_600_000, views28d: 1_000_000n, engagements28d: 50_000n },
    });
    const card = await prisma.campaignRateCard.create({
      data: { targetType: "meta_asset", targetId: asset.id, platform: "instagram", format: "post", pricePaise: price, category: "Bollywood news" },
    });
    return { asset, card };
  }

  /** A draft campaign with a finished creative (so checkout's render gate passes). Items are picked through the real route. */
  async function seedBooking(o: { status?: string; campaignType?: string } = {}) {
    const from = new Date(`${todayIST()}T00:00:00.000Z`);
    const to = new Date(from.getTime() + 7 * DAY);
    const booking = await prisma.campaignBooking.create({
      data: { clientId, name: `Campaign ${++seq}`, brand: "Brand", status: o.status ?? "draft", campaignType: o.campaignType ?? "brand", format: "post", launchFrom: from, launchTo: to },
    });
    await prisma.campaignMedia.create({
      data: {
        clientId,
        bookingId: booking.id,
        kind: "image",
        originalName: "a.jpg",
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
  const auth = () => ({ Authorization: `Bearer ${clientTok}` });
  const pick = (bookingId: string, rateCardIds: string[]) => request(app).put(`/v1/client/campaigns/${bookingId}/items`).set(auth()).send({ rateCardIds });
  const checkout = (bookingId: string) => request(app).post(`/v1/client/campaigns/${bookingId}/checkout`).set(auth());
  const adminPost = (path: string, body?: unknown) => request(app).post(path).set("Authorization", `Bearer ${admin}`).send(body ?? {});

  /** Pick, check out, and let the capture webhook land. */
  async function bookAndPay(cardIds: string[], o: { paymentId?: string; campaignType?: string; held?: boolean } = {}) {
    const booking = await seedBooking({ campaignType: o.campaignType });
    const picked = await pick(booking.id, cardIds);
    expect(picked.status).toBe(200);
    const co = await checkout(booking.id);
    expect(co.status).toBe(200);
    const paymentId = o.paymentId ?? `pay_${booking.id.slice(0, 8)}`;
    const cap = await webhook("payment.captured", { id: paymentId, order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" });
    expect(cap.status).toBe(200);
    // `held`: the transfer leg has run (a post is only offered once its payout is held). By default the capture is left as it lands: `planned`.
    if (o.held) await holdPayoutsOf(route, booking.id);
    const items = await prisma.campaignBookingItem.findMany({ where: { bookingId: booking.id }, orderBy: { createdAt: "asc" } });
    return { booking, items, paymentId, order: co.body.data, itemOf: (targetId: string) => items.find((i) => i.targetId === targetId)! };
  }

  /** The catalogue as a client sees it. */
  async function catalogue() {
    const res = await request(app).get("/v1/client/campaigns/catalogue").set(auth());
    expect(res.status).toBe(200);
    return res.body.data as Array<Record<string, any>>;
  }
  const entryFor = async (page: Page) => (await catalogue()).find((e) => e.targetId === page.asset.id);

  // ── Staff pricing ─────────────────────────────────────────────────────────────

  describe("staff price a creator page", () => {
    const put = (cards: unknown[]) => request(app).put("/v1/admin/campaign-rate-cards").set("Authorization", `Bearer ${admin}`).send({ cards });
    const creatorCard = (page: Page, over: Record<string, unknown> = {}) => ({ targetType: "creator_asset", targetId: page.asset.id, format: "post", pricePaise: 250_000, shareBps: 4000, ...over });

    it("lists only the pages staff can price, on their own endpoint, behind the admin gate", async () => {
      const ok = await seedPage();
      await seedPage({ creatorStatus: "suspended" });
      await seedPage({ enabled: false });
      await seedPage({ canPublish: false });
      const dup = await seedPage();
      await prisma.creatorAsset.update({ where: { id: dup.asset.id }, data: { networkDuplicateOf: "some-meta-asset" } });
      const lapsed = await seedPage();
      await prisma.creatorConnection.update({ where: { id: lapsed.conn.id }, data: { status: "NEEDS_REAUTH" } });
      const gone = await seedPage();
      await prisma.creatorAsset.update({ where: { id: gone.asset.id }, data: { disconnectedAt: new Date() } });

      const res = await request(app).get("/v1/admin/campaigns/rate-cards/creator-targets").set("Authorization", `Bearer ${admin}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((p: any) => p.targetId)).toEqual([ok.asset.id]);
      expect(res.body.data[0]).toMatchObject({
        targetType: "creator_asset",
        creator: { id: ok.creator.id, name: ok.creator.name, bookable: true, notBookable: null },
        cards: [{ id: ok.card.id, format: "post", pricePaise: 250_000, shareBps: 4000, active: true }],
      });
      // The two lists agree with the endpoint.
      expect((await listCreatorTargets()).map((t) => t.targetId)).toEqual([ok.asset.id]);

      for (const tok of [generateClientToken(clientId, "a@brand.test"), generateHrToken(staffId, "staff@ds.test", ["Admin"]), generateCreatorToken(ok.creator.id, ok.creator.email), generateToken(staffId, "staff@ds.test", ["Employee"])]) {
        const denied = await request(app).get("/v1/admin/campaigns/rate-cards/creator-targets").set("Authorization", `Bearer ${tok}`);
        expect([401, 403]).toContain(denied.status);
      }
      expect((await request(app).get("/v1/admin/campaigns/rate-cards/creator-targets")).status).toBe(401);
    });

    it("saves a creator card with its share, updates it, and deleting the card takes the share with it", async () => {
      const page = await seedPage({ price: 0 + 250_000, shareBps: null });
      await prisma.campaignRateCard.deleteMany({});
      const created = await put([creatorCard(page, { shareBps: 3500, entertainmentPricePaise: 180_000, category: "Food" })]);
      expect(created.status).toBe(200);
      expect(created.body.data).toMatchObject({ upserted: 1, deleted: 0 });
      const card = await prisma.campaignRateCard.findFirstOrThrow({ where: { targetType: "creator_asset", targetId: page.asset.id }, include: { creatorTerm: true } });
      expect(card).toMatchObject({ platform: "instagram", pricePaise: 250_000, entertainmentPricePaise: 180_000, active: true });
      expect(card.creatorTerm).toMatchObject({ shareBps: 3500, updatedById: staffId });

      const updated = await put([creatorCard(page, { shareBps: 5000, pricePaise: 300_000 })]);
      expect(updated.status).toBe(200);
      const after = await prisma.campaignRateCard.findFirstOrThrow({ where: { id: card.id }, include: { creatorTerm: true } });
      expect(after.pricePaise).toBe(300_000);
      expect(after.entertainmentPricePaise).toBe(180_000); // an omitted price keeps what is stored
      expect(after.creatorTerm?.shareBps).toBe(5000);
      expect(await prisma.creatorRateTerm.count()).toBe(1); // updated in place, not a second row

      const removed = await put([{ targetType: "creator_asset", targetId: page.asset.id, format: "post", pricePaise: null }]);
      expect(removed.body.data).toMatchObject({ deleted: 1 });
      expect(await prisma.creatorRateTerm.count()).toBe(0); // the share goes with the card
    });

    it("answers 400 for a missing share, a share on a network card, and a creator page that staff cannot price", async () => {
      const page = await seedPage({ shareBps: null });
      await prisma.campaignRateCard.deleteMany({});
      const net = await seedNetwork();
      expect((await put([{ ...creatorCard(page), shareBps: undefined }])).status).toBe(400);
      expect((await put([{ targetType: "meta_asset", targetId: net.asset.id, format: "post", pricePaise: 150_000, shareBps: 4000 }])).status).toBe(400);
      expect(await prisma.creatorRateTerm.count()).toBe(0);
      // A page that is not priceable (suspended creator) is refused like an unknown account.
      const off = await seedPage({ creatorStatus: "suspended", shareBps: null });
      const res = await put([creatorCard(off)]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("UNKNOWN_ACCOUNT");
    });

    it("caps the share at 90%: 9000 is fine, 9001 is SHARE_TOO_HIGH, and nothing is written for a refused batch", async () => {
      const page = await seedPage({ shareBps: null });
      await prisma.campaignRateCard.deleteMany({});
      expect(CREATOR_SHARE_MAX_BPS).toBe(9000);
      const high = await put([creatorCard(page, { shareBps: 9001 })]);
      expect(high.status).toBe(400);
      expect(high.body.error.code).toBe("SHARE_TOO_HIGH");
      expect(await prisma.campaignRateCard.count()).toBe(0);
      expect((await put([creatorCard(page, { shareBps: 9000 })])).status).toBe(200);
      expect((await prisma.creatorRateTerm.findFirstOrThrow()).shareBps).toBe(9000);
      expect((await put([creatorCard(page, { shareBps: 0 })])).status).toBe(400);
    });

    it("refuses a share that would pay the creator under ₹100 at the card's LOWEST price, with the edges exact", async () => {
      const page = await seedPage({ shareBps: null });
      await prisma.campaignRateCard.deleteMany({});
      expect(CREATOR_MIN_PAYOUT_PAISE).toBe(10_000);
      // 20,000 x 49.99% = 9,998 < 10,000.
      const low = await put([creatorCard(page, { pricePaise: 20_000, shareBps: 4999 })]);
      expect(low.status).toBe(400);
      expect(low.body.error.code).toBe("PAYOUT_TOO_LOW");
      // 20,000 x 50% = 10,000: exactly the floor, allowed.
      expect((await put([creatorCard(page, { pricePaise: 20_000, shareBps: 5000 })])).status).toBe(200);
      // The entertainment price is a price too: its payout is judged as well (the LOWER one decides).
      const ent = await put([creatorCard(page, { pricePaise: 250_000, entertainmentPricePaise: 15_000, shareBps: 5000 })]);
      expect(ent.status).toBe(400);
      expect(ent.body.error.code).toBe("PAYOUT_TOO_LOW");
      // The song add-on only ever raises a price, so it never rescues (and never breaks) the floor.
      const audio = await put([creatorCard(page, { pricePaise: 20_000, shareBps: 4999, audioAddonPaise: 500_000 })]);
      expect(audio.body.error.code).toBe("PAYOUT_TOO_LOW");
      // An omitted entertainment price keeps the STORED one, and that stored one is judged too.
      expect((await put([creatorCard(page, { pricePaise: 250_000, entertainmentPricePaise: 20_000, shareBps: 5000 })])).status).toBe(200);
      const keeps = await put([creatorCard(page, { pricePaise: 300_000, shareBps: 4000 })]);
      expect(keeps.body.error.code).toBe("PAYOUT_TOO_LOW"); // 20,000 x 40% = 8,000
    });

    it("judges the floor AFTER the creator's tax: 10,000 before TDS is 9,000 after 10% TDS", async () => {
      const page = await seedPage({ shareBps: null, tdsBps: 1000 });
      await prisma.campaignRateCard.deleteMany({});
      const res = await put([creatorCard(page, { pricePaise: 20_000, shareBps: 5000 })]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PAYOUT_TOO_LOW");
      expect((await put([creatorCard(page, { pricePaise: 22_300, shareBps: 5000 })])).status).toBe(200); // 11,150 - 1,115 = 10,035
    });

    it("keeps creator pages out of OUR network's grid, and the grid exactly as it was", async () => {
      const net = await seedNetwork();
      const gridBefore = await request(app).get("/v1/admin/campaign-rate-cards").set("Authorization", `Bearer ${admin}`);
      expect(gridBefore.status).toBe(200);
      expect(gridBefore.body.data.map((t: any) => t.targetId)).toEqual([net.asset.id]);
      const page = await seedPage();
      const gridAfter = await request(app).get("/v1/admin/campaign-rate-cards").set("Authorization", `Bearer ${admin}`);
      expect(gridAfter.body).toEqual(gridBefore.body);
      expect(JSON.stringify(gridAfter.body)).not.toContain(page.asset.id);
    });

    it("prices a page while the marketplace is still dark (staff-priceable has no switches)", async () => {
      vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "0");
      vi.stubEnv("CREATOR_ROUTE_ENABLED", "0");
      const page = await seedPage({ shareBps: null });
      await prisma.campaignRateCard.deleteMany({});
      expect((await put([creatorCard(page)])).status).toBe(200);
      expect((await listCreatorTargets()).map((t) => t.targetId)).toEqual([page.asset.id]);
      expect(await listBookableTargets()).toEqual([]);
    });
  });

  // ── Who can book a page, read fresh every time ────────────────────────────────

  describe("the client catalogue", () => {
    it("with every switch off, the catalogue is exactly the network's, creator pages and all in the database", async () => {
      const net = await seedNetwork();
      const baseline = await catalogue();
      expect(baseline.map((e) => e.targetId)).toEqual([net.asset.id]);
      expect(baseline[0].provider).toEqual({ type: "network", name: null });

      await seedPage();
      vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "");
      vi.stubEnv("CREATOR_ROUTE_ENABLED", "");
      invalidateCatalogueCache();
      const off = await catalogue();
      expect(off).toEqual(baseline);
      expect(JSON.stringify(off)).toBe(JSON.stringify(baseline));
    });

    it("each of the four conditions alone keeps creator pages out: the portal's master switch, marketplace, Route, Razorpay's keys", async () => {
      const page = await seedPage();
      expect(await entryFor(page)).toBeTruthy();
      for (const [name, off] of [["CREATORS_ENABLED", "0"], ["CREATORS_MARKETPLACE_ENABLED", "0"], ["CREATOR_ROUTE_ENABLED", "0"], ["RAZORPAY_KEY_SECRET", ""]] as const) {
        vi.stubEnv(name, off);
        expect(await entryFor(page), name).toBeUndefined();
        expect(creatorConfig.marketplaceAvailable()).toBe(false);
        vi.unstubAllEnvs();
        // unstubAllEnvs removed every stub: put the shared ones back.
        vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
        vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
        vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
        vi.stubEnv("CAMPAIGN_PAYMENT_MODE", "");
        vi.stubEnv("CREATORS_ENABLED", "1");
        vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "1");
        vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
      }
      expect(await entryFor(page)).toBeTruthy();
    });

    it("⚠️ the creator portal's master switch (CREATORS_ENABLED) alone closes EVERY client-facing creator path, with the other switches on", async () => {
      // With it off every /v1/creator/* answers 503, so a creator cannot sign in to accept: a client who could still
      // see, pick, pay for or be offered the page would only end in an expiry and a refund.
      const page = await seedPage();
      const net = await seedNetwork();
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      const paid = await bookAndPay([page.card.id], { held: true });

      vi.stubEnv("CREATORS_ENABLED", "0");
      // The catalogue is the network's alone.
      expect((await catalogue()).map((e) => e.targetId)).toEqual([net.asset.id]);
      expect(await listBookableTargets()).toHaveLength(1);
      // Picking the page is refused, and so is checking out a booking that already holds it.
      const second = await seedBooking();
      const refusedPick = await pick(second.id, [page.card.id]);
      expect(refusedPick.status).toBe(400);
      expect(refusedPick.body.error.code).toBe("RATE_CARD_UNAVAILABLE");
      const orders = rz.calls.filter((c) => c.url.endsWith("/orders")).length;
      const co = await checkout(booking.id);
      expect(co.status).toBe(409);
      expect(rz.calls.filter((c) => c.url.endsWith("/orders"))).toHaveLength(orders);
      // Approval makes no offer for it (the 409 rolls the approval back, nothing is half done).
      const approve = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/approve`);
      expect(approve.status).toBe(409);
      expect(approve.body.error.code).toBe("MARKETPLACE_OFF");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("paid_pending_review");
      expect(await prisma.creatorOffer.count()).toBe(0);
      // Staff can still price the page (their screen never depends on the switches).
      expect((await listCreatorTargets()).map((t) => t.targetId)).toContain(page.asset.id);

      vi.stubEnv("CREATORS_ENABLED", "1");
      expect((await adminPost(`/v1/admin/campaigns/${paid.booking.id}/approve`)).status).toBe(200);
    });

    it("⚠️ a creator's PRIVATE Page Insights never reach a client: views and engagement are null on a creator entry, and the client list never reads them", async () => {
      // The creator's own token filled these (creator-metrics), and the creators' privacy page promises brands only "public statistics".
      const net = await seedNetwork();
      const page = await seedPage({ followers: 321_000 });
      await prisma.creatorAsset.update({ where: { id: page.asset.id }, data: { views28d: 987_654_321n, engagements28d: 12_345_678n, reach28d: 876_543_219n } });
      const all = await catalogue();
      const entry = all.find((e) => e.targetId === page.asset.id)!;
      const networkEntry = all.find((e) => e.targetId === net.asset.id)!;
      // The keys stay (the same shape as a network entry), the values are empty.
      expect(Object.keys(entry).sort()).toEqual(Object.keys(networkEntry).sort());
      expect(entry.views28d).toBeNull();
      expect(entry.engagementRatePct).toBeNull();
      // Public statistics stay.
      expect(entry.followers).toBe(321_000);
      expect(entry.name).toBe(page.asset.name);
      const json = JSON.stringify(entry);
      for (const figure of ["987654321", "12345678", "876543219"]) expect(json, figure).not.toContain(figure);
      // Our own network's figures are our own data and are unchanged.
      expect(networkEntry.views28d).toBe(1_000_000);
      expect(networkEntry.engagementRatePct).toBe(5);

      // The client path of the list carries nothing either (a later field-copy cannot hand them over).
      for (const t of await listBookableTargets()) {
        if (t.targetType !== "creator_asset") continue;
        expect([t.views28d, t.engagements28d, t.engagementRatePct]).toEqual([null, null, null]);
      }
      // Staff still see them, to price the page.
      const staffList = await listCreatorTargets();
      expect(staffList[0]).toMatchObject({ views28d: 987_654_321, engagements28d: 12_345_678 });
      const res = await request(app).get("/v1/admin/campaigns/rate-cards/creator-targets").set("Authorization", `Bearer ${admin}`);
      expect(res.body.data[0]).toMatchObject({ views28d: 987_654_321, engagements28d: 12_345_678 });
      expect(res.body.data[0].engagementRatePct).toBeCloseTo(1.25, 2);
    });

    it("lists a bookable page with an allow-listed set of fields and a NAMED provider, and leaks nothing else of the creator", async () => {
      const net = await seedNetwork();
      const page = await seedPage({ creatorName: "Meera Kapoor", name: "Meera Eats", entertainment: 180_000, audio: 40_000, tdsBps: 1000, shareBps: 4321 });
      const all = await catalogue();
      expect(all.map((e) => e.targetId).sort()).toEqual([net.asset.id, page.asset.id].sort());
      const entry = all.find((e) => e.targetId === page.asset.id)!;
      const networkEntry = all.find((e) => e.targetId === net.asset.id)!;
      // The very same keys as a network entry: a creator's page is not a different shape.
      expect(Object.keys(entry).sort()).toEqual(Object.keys(networkEntry).sort());
      expect(Object.keys(entry).sort()).toEqual(
        ["category", "engagementRatePct", "followers", "linkDeliveryMinutes", "name", "offers", "pictureUrl", "platform", "profileUrl", "provider", "targetId", "targetType", "username", "views28d"].sort(),
      );
      expect(entry).toMatchObject({
        targetType: "creator_asset",
        platform: "instagram",
        name: "Meera Eats",
        username: page.asset.username,
        category: "Food",
        provider: { type: "creator", name: "Meera Kapoor" },
        offers: [{ rateCardId: page.card.id, format: "post", pricePaise: 250_000, entertainmentPricePaise: 180_000, audioAddonPaise: 40_000 }],
      });
      expect(Object.keys(entry.provider).sort()).toEqual(["name", "type"]);
      expect(Object.keys(entry.offers[0]).sort()).toEqual(["audioAddonPaise", "entertainmentPricePaise", "format", "pricePaise", "rateCardId"]);
      // Nothing of the creator beyond the name leaves: no ids, no email, no share, no tax, no payout, no Razorpay account.
      const json = JSON.stringify(entry);
      for (const secret of [page.creator.id, page.creator.email, page.account!.id, page.account!.razorpayAccountId!, "shareBps", "4321", "tdsBps", "payout", "razorpayAccount", page.conn.id]) {
        expect(json, secret).not.toContain(secret);
      }
      // Sorted like the network list: followers first.
      expect(all[0].targetId).toBe(net.asset.id);
    });

    // Every way a page can stop being bookable. Each is applied to a bookable page (it must disappear at once) and then undone
    // (it must come back at once): the list is read fresh, so there is no cache to clear and nothing to go stale.
    const WAYS: Array<[string, (p: Page) => Promise<unknown>, (p: Page) => Promise<unknown>]> = [
      ["the creator is suspended", (p) => prisma.creator.update({ where: { id: p.creator.id }, data: { status: "suspended" } }), (p) => prisma.creator.update({ where: { id: p.creator.id }, data: { status: "approved" } })],
      ["the creator is rejected", (p) => prisma.creator.update({ where: { id: p.creator.id }, data: { status: "rejected" } }), (p) => prisma.creator.update({ where: { id: p.creator.id }, data: { status: "approved" } })],
      ["the creator closed the account", (p) => prisma.creator.update({ where: { id: p.creator.id }, data: { status: "closed" } }), (p) => prisma.creator.update({ where: { id: p.creator.id }, data: { status: "approved" } })],
      ["the page is switched off", (p) => prisma.creatorAsset.update({ where: { id: p.asset.id }, data: { enabled: false } }), (p) => prisma.creatorAsset.update({ where: { id: p.asset.id }, data: { enabled: true } })],
      ["the page is disconnected", (p) => prisma.creatorAsset.update({ where: { id: p.asset.id }, data: { disconnectedAt: new Date() } }), (p) => prisma.creatorAsset.update({ where: { id: p.asset.id }, data: { disconnectedAt: null } })],
      ["the page cannot publish", (p) => prisma.creatorAsset.update({ where: { id: p.asset.id }, data: { canPublish: false } }), (p) => prisma.creatorAsset.update({ where: { id: p.asset.id }, data: { canPublish: true } })],
      ["the page joined our network", (p) => prisma.creatorAsset.update({ where: { id: p.asset.id }, data: { networkDuplicateOf: "x" } }), (p) => prisma.creatorAsset.update({ where: { id: p.asset.id }, data: { networkDuplicateOf: null } })],
      ["the connection lapsed", (p) => prisma.creatorConnection.update({ where: { id: p.conn.id }, data: { status: "NEEDS_REAUTH" } }), (p) => prisma.creatorConnection.update({ where: { id: p.conn.id }, data: { status: "ACTIVE" } })],
      ["the connection was revoked", (p) => prisma.creatorConnection.update({ where: { id: p.conn.id }, data: { revokedAt: new Date() } }), (p) => prisma.creatorConnection.update({ where: { id: p.conn.id }, data: { revokedAt: null } })],
      ["the payout account is not activated", (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { activationStatus: "under_review" } }), (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { activationStatus: "activated" } })],
      ["Razorpay suspended the payout account", (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { activationStatus: "suspended" } }), (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { activationStatus: "activated" } })],
      ["the payout account is still inside its 24-hour wait", (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { bookableAfter: later(3_600_000) } }), (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { bookableAfter: later(-3_600_000) } })],
      ["bookable_after was never set", (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { bookableAfter: null } }), (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { bookableAfter: later(-3_600_000) } })],
      ["a bank change is waiting for staff", (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { bankChangeRequestedAt: new Date(), bankChangeClearedAt: null } }), (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { bankChangeRequestedAt: null, bankChangeClearedAt: null } })],
      ["a bank change was cleared less than 72 hours ago", (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { bankChangeRequestedAt: later(-5 * 3_600_000), bankChangeClearedAt: later(-3_600_000) } }), (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { bankChangeRequestedAt: later(-5 * DAY), bankChangeClearedAt: later(-4 * DAY) } })],
      ["the card is inactive", (p) => prisma.campaignRateCard.update({ where: { id: p.card.id }, data: { active: false } }), (p) => prisma.campaignRateCard.update({ where: { id: p.card.id }, data: { active: true } })],
      ["the card has no share", (p) => prisma.creatorRateTerm.deleteMany({ where: { rateCardId: p.card.id } }), (p) => prisma.creatorRateTerm.create({ data: { rateCardId: p.card.id, shareBps: 4000 } })],
      ["the creator's TDS rose until the payout would be under ₹100", (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { tdsBps: 9990 } }), (p) => prisma.creatorPayoutAccount.update({ where: { id: p.account!.id }, data: { tdsBps: 0 } })],
    ];

    it.each(WAYS.map((w) => [w[0], w[1], w[2]] as const))("%s: the page leaves the client's list at once, and returns when it is undone", async (_name, apply, undo) => {
      // 25,000 x 40% = 10,000: right at the floor, so a TDS rise matters. Brand price only.
      const page = await seedPage({ price: 25_000, shareBps: 4000 });
      expect(await entryFor(page)).toBeTruthy();
      expect((await listBookableTargets()).map((t) => t.targetId)).toContain(page.asset.id);
      await apply(page);
      // No invalidateCatalogueCache(): a stale 60-second memo must not be able to keep a dead page on offer.
      expect(await entryFor(page)).toBeUndefined();
      expect((await listBookableTargets()).map((t) => t.targetId)).not.toContain(page.asset.id);
      await undo(page);
      expect(await entryFor(page)).toBeTruthy();
    });

    it("a page with no payout account at all is not offered, but staff still see it (with the reason)", async () => {
      const page = await seedPage({ payout: false });
      expect(await entryFor(page)).toBeUndefined();
      const res = await request(app).get("/v1/admin/campaigns/rate-cards/creator-targets").set("Authorization", `Bearer ${admin}`);
      expect(res.body.data[0].creator).toMatchObject({ id: page.creator.id, bookable: false, notBookable: "no_payout_account" });
    });

    it("hides only the card formats that no longer clear the floor, and keeps the rest of the page's offers", async () => {
      const page = await seedPage({ price: 250_000, shareBps: 4000 });
      const reel = await prisma.campaignRateCard.create({ data: { targetType: "creator_asset", targetId: page.asset.id, platform: "instagram", format: "reel", pricePaise: 20_000, active: true } });
      await prisma.creatorRateTerm.create({ data: { rateCardId: reel.id, shareBps: 4000 } }); // 8,000 < 10,000: could not be saved through the editor, but a TDS change can cause the same
      const entry = await entryFor(page);
      expect(entry!.offers.map((o: any) => o.format)).toEqual(["post"]);
      expect(creatorCardOfferable({ pricePaise: 20_000, entertainmentPricePaise: null }, { shareBps: 4000 }, 0)).toBe(false);
      expect(creatorCardOfferable({ pricePaise: 25_000, entertainmentPricePaise: null }, { shareBps: 4000 }, 0)).toBe(true);
      expect(creatorCardOfferable({ pricePaise: 250_000, entertainmentPricePaise: 20_000 }, { shareBps: 4000 }, 0)).toBe(false);
      expect(creatorCardOfferable({ pricePaise: 250_000, entertainmentPricePaise: null }, null, 0)).toBe(false);
      expect(creatorCardOfferable({ pricePaise: 250_000, entertainmentPricePaise: null }, { shareBps: 9001 }, 0)).toBe(false);
    });
  });

  // ── Picking a page and checking out ───────────────────────────────────────────

  describe("picking and checkout", () => {
    it("a client can pick a bookable creator page, and cannot pick one that is not", async () => {
      const ok = await seedPage();
      const closed = await seedPage({ creatorStatus: "suspended" });
      const noTerm = await seedPage({ shareBps: null });
      const booking = await seedBooking();
      const good = await pick(booking.id, [ok.card.id]);
      expect(good.status).toBe(200);
      expect(good.body.data.items).toHaveLength(1);
      for (const bad of [closed, noTerm]) {
        const res = await pick(booking.id, [bad.card.id]);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("RATE_CARD_UNAVAILABLE");
      }
      // Dark: even the good one cannot be picked.
      vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "0");
      expect((await pick(booking.id, [ok.card.id])).status).toBe(400);
    });

    it("refuses a card that has no share, or no longer clears the floor, even when the page is on offer through ANOTHER card", async () => {
      const noShare = await seedPage({ shareBps: null });
      const reel = await prisma.campaignRateCard.create({ data: { targetType: "creator_asset", targetId: noShare.asset.id, platform: "instagram", format: "reel", pricePaise: 400_000, active: true } });
      await prisma.creatorRateTerm.create({ data: { rateCardId: reel.id, shareBps: 4000 } });
      const lowPay = await seedPage({ price: 25_000, shareBps: 4000, tdsBps: 500 }); // 10,000 gross, 9,500 after tax
      const lowReel = await prisma.campaignRateCard.create({ data: { targetType: "creator_asset", targetId: lowPay.asset.id, platform: "instagram", format: "reel", pricePaise: 400_000, active: true } });
      await prisma.creatorRateTerm.create({ data: { rateCardId: lowReel.id, shareBps: 4000 } });
      expect(await entryFor(noShare)).toBeTruthy(); // both pages ARE on offer, through their reel cards
      expect(await entryFor(lowPay)).toBeTruthy();
      const booking = await seedBooking(); // a `post` booking: the picked card is the post one
      for (const bad of [noShare.card, lowPay.card]) {
        const res = await pick(booking.id, [bad.id]);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("RATE_CARD_UNAVAILABLE");
      }
      expect(await prisma.campaignBookingItem.count({ where: { bookingId: booking.id } })).toBe(0);
    });

    it("a booking can mix our network and a creator, priced as a sum, and checkout creates ONE order for it", async () => {
      const page = await seedPage({ price: 250_000 });
      const net = await seedNetwork(150_000);
      const booking = await seedBooking();
      expect((await pick(booking.id, [net.card.id, page.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      expect(co.status).toBe(200);
      expect(co.body.data).toMatchObject({ offline: false, amount: 400_000 });
      expect(rz.calls.filter((c) => c.url.endsWith("/orders"))).toHaveLength(1);
    });

    it("⚠️ a creator booking is ONLINE PAYMENT ONLY: without Razorpay's keys it is 409 CREATOR_ONLINE_ONLY, never a silent fallback to offline", async () => {
      const page = await seedPage();
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      for (const globalMode of ["", "offline"]) {
        vi.stubEnv("CAMPAIGN_PAYMENT_MODE", globalMode);
        vi.stubEnv("RAZORPAY_KEY_SECRET", "");
        const res = await checkout(booking.id);
        expect(res.status, globalMode).toBe(409);
        expect(res.body.error.code).toBe("CREATOR_ONLINE_ONLY");
        const after = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } });
        expect(after).toMatchObject({ status: "draft", totalPaise: null, paidAt: null, submittedAt: null });
        expect(await prisma.campaignPayment.count()).toBe(0);
        expect(rz.calls).toHaveLength(0);
        // And the booking the client sees says so too: the Pay step must not offer "Submit for review".
        const shown = await request(app).get(`/v1/client/campaigns/${booking.id}`).set(auth());
        expect(shown.body.data.paymentMode, globalMode).toBe("offline");
      }
    });

    it("⚠️ CAMPAIGN_PAYMENT_MODE=offline is for OUR network's bookings: a creator booking is still paid online with the keys set (the plan's go-live config)", async () => {
      vi.stubEnv("CAMPAIGN_PAYMENT_MODE", "offline");
      const page = await seedPage({ price: 250_000 });
      const net = await seedNetwork(150_000);
      // A creator-only booking: an order is created, a payment row waits for the webhook, nothing is submitted offline.
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      expect(co.status).toBe(200);
      expect(co.body.data).toMatchObject({ offline: false, amount: 250_000, currency: "INR", keyId: "rzp_test_key" });
      expect(rz.calls.filter((c) => c.url.endsWith("/orders"))).toHaveLength(1);
      const row = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(row).toMatchObject({ status: "awaiting_payment", totalPaise: 250_000, paidAt: null, submittedAt: null });
      expect(await prisma.campaignPayment.count({ where: { bookingId: booking.id } })).toBe(1);
      // A mixed booking is one online order for the WHOLE total, the network post included.
      const mixed = await seedBooking();
      expect((await pick(mixed.id, [net.card.id, page.card.id])).status).toBe(200);
      const coMixed = await checkout(mixed.id);
      expect(coMixed.status).toBe(200);
      expect(coMixed.body.data).toMatchObject({ offline: false, amount: 400_000 });
      // The capture then lands exactly as in any online booking: paid, in review, one payout planned.
      const cap = await webhook("payment.captured", { id: "pay_offline_env", order_id: co.body.data.orderId, amount: 250_000, currency: "INR" });
      expect(cap.status).toBe(200);
      const paid = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(paid.status).toBe("paid_pending_review");
      expect(paid.paidAt).not.toBeNull();
      expect(await prisma.creatorPayout.count({ where: { bookingId: booking.id } })).toBe(1);
    });

    it("the booking the client sees follows ITS items: a creator booking reports 'razorpay' under offline + keys, a network-only one still 'offline'", async () => {
      vi.stubEnv("CAMPAIGN_PAYMENT_MODE", "offline");
      const page = await seedPage();
      const net = await seedNetwork();
      const modeOf = async (id: string) => (await request(app).get(`/v1/client/campaigns/${id}`).set(auth())).body.data.paymentMode;
      const empty = await seedBooking();
      const netOnly = await seedBooking();
      const withCreator = await seedBooking();
      const mixed = await seedBooking();
      expect((await pick(netOnly.id, [net.card.id])).status).toBe(200);
      expect((await pick(withCreator.id, [page.card.id])).status).toBe(200);
      expect((await pick(mixed.id, [net.card.id, page.card.id])).status).toBe(200);
      expect(await modeOf(empty.id)).toBe("offline");
      expect(await modeOf(netOnly.id)).toBe("offline");
      expect(await modeOf(withCreator.id)).toBe("razorpay");
      expect(await modeOf(mixed.id)).toBe("razorpay");
      // The pick response itself (what the wizard re-renders from) says it too.
      const repicked = await pick(withCreator.id, [page.card.id]);
      expect(repicked.body.data.paymentMode).toBe("razorpay");
      // Without the gateway's keys every booking is offline again (and a creator one cannot be paid: see above).
      vi.stubEnv("RAZORPAY_KEY_SECRET", "");
      expect(await modeOf(withCreator.id)).toBe("offline");
      // With no global override the network-only booking is online too, as before.
      vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
      vi.stubEnv("CAMPAIGN_PAYMENT_MODE", "");
      expect(await modeOf(netOnly.id)).toBe("razorpay");
    });

    it("bookingPaymentMode: creator items -> 'razorpay' with the keys whatever CAMPAIGN_PAYMENT_MODE says; network-only keeps paymentMode()", () => {
      const withKeys = (globalMode: string) => {
        vi.stubEnv("RAZORPAY_KEY_ID", "k");
        vi.stubEnv("RAZORPAY_KEY_SECRET", "s");
        vi.stubEnv("CAMPAIGN_PAYMENT_MODE", globalMode);
      };
      for (const g of ["", "offline", "razorpay", "anything"]) {
        withKeys(g);
        expect(razorpayConfig.bookingPaymentMode(true), g).toBe("razorpay");
        expect(razorpayConfig.bookingPaymentMode(false), g).toBe(razorpayConfig.paymentMode());
      }
      withKeys("offline");
      expect(razorpayConfig.bookingPaymentMode(false)).toBe("offline");
      withKeys("");
      expect(razorpayConfig.bookingPaymentMode(false)).toBe("razorpay");
      // No keys: offline for both, so checkout can refuse the creator one.
      for (const [id, secret] of [["", ""], ["k", ""], ["", "s"]]) {
        vi.stubEnv("RAZORPAY_KEY_ID", id);
        vi.stubEnv("RAZORPAY_KEY_SECRET", secret);
        for (const g of ["", "offline"]) {
          vi.stubEnv("CAMPAIGN_PAYMENT_MODE", g);
          expect(razorpayConfig.bookingPaymentMode(true)).toBe("offline");
          expect(razorpayConfig.bookingPaymentMode(false)).toBe("offline");
        }
      }
    });

    it("a network-only booking still submits offline exactly as before", async () => {
      const net = await seedNetwork();
      const booking = await seedBooking();
      expect((await pick(booking.id, [net.card.id])).status).toBe(200);
      vi.stubEnv("CAMPAIGN_PAYMENT_MODE", "offline");
      const res = await checkout(booking.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ offline: true, status: "paid_pending_review" });
      expect(await prisma.creatorPayout.count()).toBe(0);
    });

    it("re-checks every creator page at checkout, naming the one that is gone, and creates no order", async () => {
      const keep = await seedPage({ name: "Stays Bookable" });
      const lose = await seedPage({ name: "Goes Away" });
      const booking = await seedBooking();
      expect((await pick(booking.id, [keep.card.id, lose.card.id])).status).toBe(200);
      await prisma.creatorPayoutAccount.update({ where: { id: lose.account!.id }, data: { bankChangeRequestedAt: new Date(), bankChangeClearedAt: null } });
      const res = await checkout(booking.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CREATOR_UNAVAILABLE");
      expect(res.body.error.message).toContain("Goes Away");
      expect(res.body.error.message).not.toContain("Stays Bookable");
      expect(rz.calls).toHaveLength(0);
      expect(await prisma.campaignPayment.count()).toBe(0);
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("draft");
    });

    it("refuses at checkout an item whose OWN card lost its share or now pays under ₹100, even while the page stays bookable through another card", async () => {
      /** A second card (a reel) that keeps the page on offer, so only the picked card's own condition can stop the checkout. */
      const keepPageBookable = async (page: Page) => {
        const reel = await prisma.campaignRateCard.create({ data: { targetType: "creator_asset", targetId: page.asset.id, platform: page.asset.kind === "facebook_page" ? "facebook" : "instagram", format: "reel", pricePaise: 400_000, active: true } });
        await prisma.creatorRateTerm.create({ data: { rateCardId: reel.id, shareBps: 4000 } });
      };

      // 1. The picked card loses its share.
      const a = await seedPage({ name: "Share removed" });
      await keepPageBookable(a);
      const booking = await seedBooking();
      expect((await pick(booking.id, [a.card.id])).status).toBe(200);
      await prisma.creatorRateTerm.deleteMany({ where: { rateCardId: a.card.id } });
      expect(await entryFor(a)).toBeTruthy(); // the page itself is still on offer
      const res = await checkout(booking.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CREATOR_UNAVAILABLE");
      expect(res.body.error.message).toContain("Share removed");
      expect(rz.calls).toHaveLength(0);

      // 2. The creator's tax rises until the picked card would pay under ₹100 (25,000 x 40% = 10,000, exactly the floor).
      const b = await seedPage({ name: "Tax rose", price: 25_000, shareBps: 4000 });
      await keepPageBookable(b);
      const booking2 = await seedBooking();
      expect((await pick(booking2.id, [b.card.id])).status).toBe(200);
      await prisma.creatorPayoutAccount.update({ where: { id: b.account!.id }, data: { tdsBps: 500 } });
      expect(await entryFor(b)).toBeTruthy();
      const res2 = await checkout(booking2.id);
      expect(res2.status).toBe(409);
      expect(res2.body.error.code).toBe("CREATOR_UNAVAILABLE");
      expect(res2.body.error.message).toContain("Tax rose");
      expect(rz.calls).toHaveLength(0);
      expect(await prisma.campaignPayment.count()).toBe(0);
    });

    it("freezes each creator item's terms into the pricing snapshot, and a network item gets none of those keys", async () => {
      const page = await seedPage({ price: 250_000, shareBps: 4000, tdsBps: 1000, creatorName: "Meera Kapoor", name: "Meera Eats" });
      const net = await seedNetwork(150_000);
      const booking = await seedBooking();
      expect((await pick(booking.id, [net.card.id, page.card.id])).status).toBe(200);
      expect((await checkout(booking.id)).status).toBe(200);
      const b = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id }, include: { items: true } });
      const snap = b.pricingSnapshot as any;
      const creatorItem = b.items.find((i) => i.targetId === page.asset.id)!;
      const netItem = b.items.find((i) => i.targetId === net.asset.id)!;
      const frozen = snap.items.find((i: any) => i.itemId === creatorItem.id);
      expect(frozen).toMatchObject({
        itemId: creatorItem.id,
        pricePaise: 250_000,
        accountName: "Meera Eats",
        creatorId: page.creator.id,
        creatorName: "Meera Kapoor",
        payoutAccountId: page.account!.id,
        razorpayAccountId: page.account!.razorpayAccountId,
        shareBps: 4000,
        tdsBps: 1000,
        grossPaise: 100_000,
        tdsPaise: 10_000,
        amountPaise: 90_000,
        assetName: "Meera Eats",
        handle: page.asset.username,
      });
      // The network entry is byte-identical to what it always was.
      const frozenNet = snap.items.find((i: any) => i.itemId === netItem.id);
      expect(Object.keys(frozenNet).sort()).toEqual(["accountName", "audioAddonPaise", "basePaise", "format", "itemId", "platform", "pricePaise", "rateCardId"]);
      // And the frozen figures are what computePayout says.
      expect(creatorItemsOfSnapshot(snap)).toHaveLength(1);
      expect(creatorItemsOfSnapshot(snap)[0]).toMatchObject({ itemId: creatorItem.id, ...computePayout(250_000, 4000, 1000), itemPricePaise: 250_000 });
      // Re-pricing later never reaches a frozen snapshot: change the share and the tax and read it again.
      await prisma.creatorRateTerm.update({ where: { rateCardId: page.card.id }, data: { shareBps: 9000 } });
      await prisma.creatorPayoutAccount.update({ where: { id: page.account!.id }, data: { tdsBps: 0 } });
      const again = (await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).pricingSnapshot as any;
      expect(creatorItemsOfSnapshot(again)[0]).toMatchObject({ shareBps: 4000, tdsBps: 1000, amountPaise: 90_000 });
    });

    it("the entertainment price and the song add-on go into the frozen price, and the payout follows that price", async () => {
      const page = await seedPage({ price: 250_000, entertainment: 180_000, audio: 40_000, shareBps: 5000, tdsBps: 0 });
      const booking = await seedBooking({ campaignType: "entertainment" });
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      expect((await checkout(booking.id)).status).toBe(200);
      const b = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(creatorItemsOfSnapshot(b.pricingSnapshot)[0]).toMatchObject({ itemPricePaise: 180_000, grossPaise: 90_000, amountPaise: 90_000 });
      // With the song add-on on a reel booking: base + add-on is the price, and the share applies to all of it.
      const reel = await prisma.campaignRateCard.create({ data: { targetType: "creator_asset", targetId: page.asset.id, platform: "instagram", format: "reel", pricePaise: 300_000, audioAddonPaise: 50_000, active: true } });
      await prisma.creatorRateTerm.create({ data: { rateCardId: reel.id, shareBps: 5000 } });
      const rb = await prisma.campaignBooking.create({
        data: { clientId, name: "Reel", brand: "B", format: "reel", audioIntegration: true, audioTrack: "Song", launchFrom: new Date(`${todayIST()}T00:00:00.000Z`), launchTo: new Date(`${todayIST()}T00:00:00.000Z`) },
      });
      await prisma.campaignMedia.create({
        data: { clientId, bookingId: rb.id, kind: "video", originalName: "a.mp4", mime: "video/mp4", bytes: 1000n, storageKey: crypto.randomBytes(32).toString("base64url"), ext: "mp4", uploadStatus: "complete", chunkSize: 1000, totalChunks: 1, renderStatus: "done" },
      });
      expect((await pick(rb.id, [reel.id])).status).toBe(200);
      expect((await checkout(rb.id)).status).toBe(200);
      const after = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: rb.id } });
      expect(creatorItemsOfSnapshot(after.pricingSnapshot)[0]).toMatchObject({ itemPricePaise: 350_000, grossPaise: 175_000, amountPaise: 175_000 });
    });

    it("a network-only checkout is untouched: same snapshot shape, no creator keys, same order", async () => {
      const net = await seedNetwork(150_000);
      const booking = await seedBooking();
      expect((await pick(booking.id, [net.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      expect(co.status).toBe(200);
      expect(Object.keys(co.body.data).sort()).toEqual(["amount", "currency", "keyId", "name", "offline", "orderId"]);
      const b = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(Object.keys(b.pricingSnapshot as object).sort()).toEqual(["audioIntegration", "audioTrack", "campaignType", "items"]);
      expect(Object.keys((b.pricingSnapshot as any).items[0]).sort()).toEqual(["accountName", "audioAddonPaise", "basePaise", "format", "itemId", "platform", "pricePaise", "rateCardId"]);
      expect(creatorItemsOfSnapshot(b.pricingSnapshot)).toEqual([]);
    });
  });

  // ── The capture ───────────────────────────────────────────────────────────────

  describe("capture plans one payout per creator item", () => {
    it("writes a `planned` row per creator item, frozen from checkout, with the WINNING payment id, and one audit event each", async () => {
      const a = await seedPage({ price: 250_000, shareBps: 4000, tdsBps: 1000 });
      const b = await seedPage({ price: 120_000, shareBps: 5000, tdsBps: 0 });
      const net = await seedNetwork(150_000);
      const paid = await bookAndPay([a.card.id, b.card.id, net.card.id], { paymentId: "pay_winner" });

      const booking = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } });
      expect(booking.status).toBe("paid_pending_review");
      expect(booking.paidAt).not.toBeNull();
      const rows = await prisma.creatorPayout.findMany({ where: { bookingId: paid.booking.id }, orderBy: { amountPaise: "desc" } });
      expect(rows).toHaveLength(2); // the network item has none
      expect(rows[0]).toMatchObject({
        bookingItemId: paid.itemOf(a.asset.id).id,
        creatorId: a.creator.id,
        payoutAccountId: a.account!.id,
        razorpayAccountId: a.account!.razorpayAccountId,
        razorpayPaymentId: "pay_winner",
        status: "planned",
        itemPricePaise: 250_000,
        shareBps: 4000,
        tdsBps: 1000,
        grossPaise: 100_000,
        tdsPaise: 10_000,
        amountPaise: 90_000,
        razorpayTransferId: null,
        voidReason: null,
        pausedAt: null,
      });
      expect(rows[1]).toMatchObject({ bookingItemId: paid.itemOf(b.asset.id).id, razorpayPaymentId: "pay_winner", status: "planned", grossPaise: 60_000, tdsPaise: 0, amountPaise: 60_000 });
      for (const r of rows) {
        expect(payoutAmountsAreValid({ itemPricePaise: r.itemPricePaise, grossPaise: r.grossPaise, tdsPaise: r.tdsPaise, amountPaise: r.amountPaise })).toBe(true);
      }
      const events = await prisma.creatorPayoutEvent.findMany({ where: { bookingId: paid.booking.id } });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.kind === "planned" && e.toStatus === "planned" && e.actorType === "system")).toBe(true);
      expect(new Set(events.map((e) => e.payoutId))).toEqual(new Set(rows.map((r) => r.id)));
      // The items themselves are untouched: still waiting for approval.
      expect((await prisma.campaignBookingItem.findMany({ where: { bookingId: paid.booking.id } })).every((i) => i.status === "pending")).toBe(true);
      // Nothing was refunded and no alert was needed.
      await flushPayoutAlertsForTests();
      expect(refundPosts()).toHaveLength(0);
      expect(alertSubjects()).not.toContain(PROBLEM_SUBJECT);
    });

    it("a network-only capture creates no payout rows and behaves exactly as before", async () => {
      const net = await seedNetwork();
      const paid = await bookAndPay([net.card.id]);
      expect(await prisma.creatorPayout.count()).toBe(0);
      expect(await prisma.creatorPayoutEvent.count()).toBe(0);
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("paid_pending_review");
    });

    // ⚠️ CI pins this suite to ONE connection, so these two webhooks run one after the other: it proves the claim-first rule (one
    // delivery wins, only its payment id is used, the loser plans nothing), not true interleaving (see the same note in
    // campaign-payments-safety.test.ts).
    it("payment.captured + order.paid together create exactly ONE set of rows, with the winner's payment id", async () => {
      const page = await seedPage();
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      const entity = (id: string) => ({ id, order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" });
      const [x, y] = await Promise.all([webhook("payment.captured", entity("pay_A")), webhook("order.paid", entity("pay_B"))]);
      expect([x.status, y.status]).toEqual([200, 200]);
      expect([x, y].filter((r) => r.body.data.duplicate === true)).toHaveLength(1);
      const rows = await prisma.creatorPayout.findMany({ where: { bookingId: booking.id } });
      expect(rows).toHaveLength(1);
      const pay = await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(rows[0].razorpayPaymentId).toBe(pay.razorpayPaymentId);
      expect(["pay_A", "pay_B"]).toContain(rows[0].razorpayPaymentId);
      expect(await prisma.creatorPayoutEvent.count()).toBe(1);
    });

    it("a redelivery of the same event neither doubles a row nor an audit event", async () => {
      const page = await seedPage();
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      const entity = { id: "pay_once", order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" };
      const eventId = crypto.randomUUID();
      expect((await webhook("payment.captured", entity, eventId)).status).toBe(200);
      const again = await webhook("payment.captured", entity, eventId);
      expect(again.body.data.duplicate).toBe(true);
      expect((await webhook("order.paid", entity)).body.data.duplicate).toBe(true);
      expect(await prisma.creatorPayout.count()).toBe(1);
      expect(await prisma.creatorPayoutEvent.count()).toBe(1);
    });

    it("⚠️ a failure after the payouts are written rolls them back with the claim and the booking, and the retry then plans them once", async () => {
      const page = await seedPage();
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      const entity = { id: "pay_rollback", order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" };
      const eventId = crypto.randomUUID();

      // The audit rows are written AFTER the payout rows, in the same transaction: with that table gone the capture throws.
      await prisma.$executeRawUnsafe(`ALTER TABLE creator_payout_events RENAME TO creator_payout_events_away`);
      let first;
      try {
        first = await webhook("payment.captured", entity, eventId);
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE creator_payout_events_away RENAME TO creator_payout_events`);
      }
      expect(first.status).toBe(500);
      expect(await prisma.creatorPayout.count()).toBe(0); // the rows that WERE inserted are gone with the transaction
      expect((await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: booking.id } })).status).toBe("created");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("awaiting_payment");
      expect((await prisma.razorpayWebhookEvent.findUniqueOrThrow({ where: { eventId } })).processedAt).toBeNull();
      expect(refundPosts()).toHaveLength(0);

      const retry = await webhook("payment.captured", entity, eventId);
      expect(retry.status).toBe(200);
      expect(await prisma.creatorPayout.count()).toBe(1);
      expect(await prisma.creatorPayoutEvent.count()).toBe(1);
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("paid_pending_review");
    });

    it("a capture that does not match the booking is refunded and plans NO payout", async () => {
      const page = await seedPage();
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      const res = await webhook("payment.captured", { id: "pay_short", order_id: co.body.data.orderId, amount: co.body.data.amount - 1, currency: "INR" });
      expect(res.status).toBe(200);
      expect(await prisma.creatorPayout.count()).toBe(0);
      expect(await prisma.creatorPayoutEvent.count()).toBe(0);
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("awaiting_payment");
      expect(refundPosts()).toHaveLength(1);
    });

    it("⚠️ a page that changed hands between checkout and capture gets a VOID row (page_changed), the item goes refund_due, and staff are told", async () => {
      const page = await seedPage();
      const other = await seedPage();
      const net = await seedNetwork();
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id, net.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      // The page is taken over by someone else after the brand saw the price.
      await prisma.creatorAsset.update({ where: { id: page.asset.id }, data: { creatorId: other.creator.id, connectionId: other.conn.id } });
      const res = await webhook("payment.captured", { id: "pay_late", order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" });
      expect(res.status).toBe(200);

      // The brand's payment is real and the booking moves: only THIS creator item is stopped.
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("paid_pending_review");
      const row = await prisma.creatorPayout.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(row).toMatchObject({ status: "void", voidReason: "page_changed", creatorId: page.creator.id, razorpayPaymentId: "pay_late" });
      expect(await prisma.creatorPayout.count({ where: { status: "planned" } })).toBe(0);
      const items = await prisma.campaignBookingItem.findMany({ where: { bookingId: booking.id } });
      expect(items.find((i) => i.targetId === page.asset.id)).toMatchObject({ status: "refund_due" });
      expect(items.find((i) => i.targetId === page.asset.id)!.lastError).toContain("changed hands");
      expect(items.find((i) => i.targetId === net.asset.id)!.status).toBe("pending");
      const event = await prisma.creatorPayoutEvent.findFirstOrThrow({ where: { payoutId: row.id } });
      expect(event).toMatchObject({ kind: "void", toStatus: "void" });
      await flushPayoutAlertsForTests();
      expect(alertSubjects()).toContain(PROBLEM_SUBJECT);
      // No money moved by itself: nothing automatic refunds an item.
      expect(refundPosts()).toHaveLength(0);
    });

    it("an item whose frozen terms are missing gets no row, goes refund_due, and staff are told (money is never guessed)", async () => {
      const page = await seedPage();
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      await prisma.campaignBooking.update({ where: { id: booking.id }, data: { pricingSnapshot: { campaignType: "brand", audioIntegration: false, audioTrack: null, items: [] } } });
      expect((await webhook("payment.captured", { id: "pay_x", order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" })).status).toBe(200);
      expect(await prisma.creatorPayout.count()).toBe(0);
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: booking.id } })).status).toBe("refund_due");
      await flushPayoutAlertsForTests();
      expect(alertSubjects()).toContain(PROBLEM_SUBJECT);
    });

    it("planCreatorPayouts is idempotent: running it again for the same booking neither doubles a row nor an audit event", async () => {
      const page = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      const again = await prisma.$transaction((tx) => planCreatorPayouts(tx, paid.booking.id, "pay_replayed"));
      expect(again).toEqual({ planned: 0, problems: [] });
      const rows = await prisma.creatorPayout.findMany({ where: { bookingId: paid.booking.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].razorpayPaymentId).toBe(paid.paymentId); // the first capture's id is kept, never overwritten
      expect(await prisma.creatorPayoutEvent.count()).toBe(1);
    });

    it("an item whose price no longer equals the frozen one gets no row either: refund_due, never a payout for a different price", async () => {
      const page = await seedPage();
      const booking = await seedBooking();
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      await prisma.campaignBookingItem.updateMany({ where: { bookingId: booking.id }, data: { pricePaise: 260_000 } });
      expect((await webhook("payment.captured", { id: "pay_px", order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" })).status).toBe(200);
      expect(await prisma.creatorPayout.count()).toBe(0);
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: booking.id } })).status).toBe("refund_due");
    });

    it("creatorItemsOfSnapshot drops anything that is not a complete, valid frozen entry", () => {
      const good = { itemId: "i1", pricePaise: 1000, creatorId: "c", payoutAccountId: "p", razorpayAccountId: "acc_1", shareBps: 5000, tdsBps: 0, grossPaise: 500, tdsPaise: 0, amountPaise: 500, accountName: "A", handle: "h", creatorName: "N" };
      expect(creatorItemsOfSnapshot({ items: [good] })).toHaveLength(1);
      expect(creatorItemsOfSnapshot(null)).toEqual([]);
      expect(creatorItemsOfSnapshot({ items: "x" })).toEqual([]);
      for (const broken of [{ ...good, amountPaise: 501 }, { ...good, grossPaise: 1001, amountPaise: 1001 }, { ...good, shareBps: 10_001 }, { ...good, creatorId: undefined }, { ...good, razorpayAccountId: "" }, { ...good, shareBps: 5000.5 }, { ...good, pricePaise: -1 }]) {
        expect(creatorItemsOfSnapshot({ items: [broken] }), JSON.stringify(broken)).toEqual([]);
      }
      // A network entry (no creatorId) is simply not a creator entry.
      expect(creatorItemsOfSnapshot({ items: [{ itemId: "n", pricePaise: 5 }] })).toEqual([]);
    });
  });

  // ── Approve: the owner is checked again ───────────────────────────────────────

  describe("approve checks the page's owner again", () => {
    it("an unchanged page is approved as usual: no refund_due, no void, no alert", async () => {
      const page = await seedPage();
      const net = await seedNetwork();
      const paid = await bookAndPay([page.card.id, net.card.id], { held: true });
      const res = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/approve`);
      expect(res.status).toBe(200);
      expect((await prisma.creatorPayout.findFirstOrThrow()).status).toBe("held");
      const items = await prisma.campaignBookingItem.findMany({ where: { bookingId: paid.booking.id } });
      // The creator's own page is never auto-published: it waits for the creator / staff, it is never queued.
      expect(items.every((i) => ["manual_pending", "awaiting_creator"].includes(i.status))).toBe(true);
      await flushPayoutAlertsForTests();
      expect(alertSubjects()).not.toContain(PROBLEM_SUBJECT);
    });

    it("a page that changed hands after the capture (payout still planned): approval moves the item to refund_due and the rest goes ahead; the worker then voids the payout and refunds the item, once", async () => {
      const page = await seedPage();
      const other = await seedPage();
      const net = await seedNetwork();
      const paid = await bookAndPay([page.card.id, net.card.id]);
      await prisma.creatorAsset.update({ where: { id: page.asset.id }, data: { creatorId: other.creator.id, connectionId: other.conn.id } });
      // An offer that was somehow already open for the page's former owner is withdrawn with it.
      const stale = await prisma.creatorOffer.create({
        data: { bookingId: paid.booking.id, bookingItemId: paid.itemOf(page.asset.id).id, creatorId: page.creator.id, creatorAssetId: page.asset.id, pageName: page.asset.name, platform: "instagram", format: "post", status: "offered", payoutPaise: 100_000, expiresAt: later(DAY) },
      });
      const res = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/approve`);
      expect(res.status).toBe(200);
      expect(await prisma.creatorOffer.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: "withdrawn", closedReason: "page_taken_over" });
      const items = await prisma.campaignBookingItem.findMany({ where: { bookingId: paid.booking.id } });
      const creatorItem = items.find((i) => i.targetId === page.asset.id)!;
      expect(creatorItem.status).toBe("refund_due");
      expect(items.find((i) => i.targetId === net.asset.id)!.status).toBe("manual_pending");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("approved");
      await flushPayoutAlertsForTests();
      expect(alertSubjects()).toContain(PROBLEM_SUBJECT);
      // Approval claims only: nothing was refunded, and the payout is untouched. The worker does the rest, OUTSIDE any transaction.
      expect(refundPosts()).toHaveLength(0);
      expect((await prisma.creatorPayout.findFirstOrThrow({ where: { bookingId: paid.booking.id } })).status).toBe("planned");
      await runRefundDueJob({ now: new Date(Date.now() + 10 * 60_000) });
      const row = await prisma.creatorPayout.findFirstOrThrow({ where: { bookingId: paid.booking.id } });
      expect(row).toMatchObject({ status: "void", voidReason: "refund_due" });
      expect((await prisma.creatorPayoutEvent.findMany({ where: { payoutId: row.id }, orderBy: { createdAt: "asc" } })).map((e) => e.toStatus)).toEqual(["planned", "void"]);
      // The brand gets that item's price back, the item is refunded, and doing it again refunds nothing more.
      expect(refundPosts()).toHaveLength(1);
      expect(refundPosts()[0].body.amount).toBe(250_000);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: creatorItem.id } })).status).toBe("refunded");
      await runRefundDueJob({ now: new Date(Date.now() + 20 * 60_000) });
      expect(refundPosts()).toHaveLength(1);
      expect((await adminPost(`/v1/admin/campaigns/${paid.booking.id}/items/${creatorItem.id}/refund`)).status).toBe(409);
    });

    it("never touches a booking that is not awaiting approval", async () => {
      const page = await seedPage();
      const other = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      await prisma.creatorAsset.update({ where: { id: page.asset.id }, data: { creatorId: other.creator.id } });
      await prisma.campaignBooking.update({ where: { id: paid.booking.id }, data: { status: "draft" } });
      expect(await reconcileCreatorOwnership(paid.booking.id)).toEqual([]);
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: paid.booking.id } })).status).toBe("pending");
      expect((await prisma.creatorPayout.findFirstOrThrow()).status).toBe("planned");
    });

    it("an item with no payout row at all is refund_due, not approved blind; the worker then refunds it (nothing to unwind)", async () => {
      const page = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      await prisma.creatorPayout.deleteMany({});
      const res = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/approve`);
      expect(res.status).toBe(200);
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: paid.booking.id } })).status).toBe("refund_due");
      await runRefundDueJob({ now: new Date(Date.now() + 10 * 60_000) });
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: paid.booking.id } })).status).toBe("refunded");
      expect(refundPosts()).toHaveLength(1);
    });

    it("a changed-hands page whose payout is already HELD is no longer a reason to refuse the approval: the share is reversed first, then the brand is refunded", async () => {
      const page = await seedPage();
      const other = await seedPage();
      const paid = await bookAndPay([page.card.id], { held: true });
      expect((await prisma.creatorPayout.findFirstOrThrow()).status).toBe("held");
      await prisma.creatorAsset.update({ where: { id: page.asset.id }, data: { creatorId: other.creator.id } });
      const res = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/approve`);
      expect(res.status).toBe(200);
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: paid.booking.id } })).status).toBe("refund_due");
      expect(refundPosts()).toHaveLength(0);
      route.calls.length = 0;
      await runRefundDueJob({ now: new Date(Date.now() + 10 * 60_000) });
      const payout = await prisma.creatorPayout.findFirstOrThrow();
      expect(payout).toMatchObject({ status: "reversed", amountReversedPaise: payout.amountPaise });
      // The reversal came first, then the refund.
      const order = [...route.calls.map((c) => `${c.method} ${c.path.replace(/\/[^/]*(?=\/reversals)/, "")}`), ...refundPosts().map(() => "refund")];
      expect(order.some((x) => x.endsWith("/reversals"))).toBe(true);
      expect(refundPosts()).toHaveLength(1);
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: paid.booking.id } })).status).toBe("refunded");
    });

    it("⚠️ a changed-hands page whose payout is already RELEASED is never refunded around: the approval goes ahead, the item stays refund_due, and the money is left alone", async () => {
      const page = await seedPage();
      const other = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      await prisma.creatorPayout.updateMany({ data: { status: "released", razorpayTransferId: "trf_1", releasedAt: new Date() } });
      await prisma.creatorAsset.update({ where: { id: page.asset.id }, data: { creatorId: other.creator.id } });
      expect((await adminPost(`/v1/admin/campaigns/${paid.booking.id}/approve`)).status).toBe(200);
      await runRefundDueJob({ now: new Date(Date.now() + 10 * 60_000) });
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: paid.booking.id } })).status).toBe("refund_due");
      expect((await prisma.creatorPayout.findFirstOrThrow()).status).toBe("released");
      expect(refundPosts()).toHaveLength(0);
      expect(route.writes()).toHaveLength(0);
    });
  });

  // ── awaiting_creator / refund_due neither complete nor settle ─────────────────

  describe("open creator statuses keep a booking open", () => {
    async function withItems(statuses: string[], bookingStatus = "approved") {
      const booking = await prisma.campaignBooking.create({
        data: { clientId, name: "Open", brand: "B", status: bookingStatus, format: "post", totalPaise: 100_000 * statuses.length, launchFrom: new Date(), launchTo: new Date() },
      });
      for (const [i, status] of statuses.entries()) {
        await prisma.campaignBookingItem.create({
          data: { bookingId: booking.id, rateCardId: `rc-${i}`, targetType: i === 0 ? "meta_asset" : "creator_asset", targetId: `t-${booking.id}-${i}`, platform: "instagram", format: "post", accountName: `Acct ${i}`, pricePaise: 100_000, status },
        });
      }
      return booking;
    }
    const statusOf = async (id: string) => (await prisma.campaignBooking.findUniqueOrThrow({ where: { id } })).status;

    it.each(["awaiting_creator", "refund_due"])("a booking with a %s item does not complete or settle, even when every other item is live", async (open) => {
      const b = await withItems(["posted_manual", open]);
      expect(await bookingSvc.settleBooking(b.id, { type: "system" })).toBe(false);
      // The live item moves it to `publishing`, and no further.
      expect(await statusOf(b.id)).toBe("publishing");
      expect(await bookingSvc.settleBooking(b.id, { type: "system" })).toBe(false);
      expect(await statusOf(b.id)).toBe("publishing");
    });

    it.each(["awaiting_creator", "refund_due"])("a %s item with only refunded / failed siblings still does not settle", async (open) => {
      const b = await withItems(["refunded", open, "failed"]);
      expect(await bookingSvc.settleBooking(b.id, { type: "system" })).toBe(false);
      expect(await statusOf(b.id)).toBe("approved");
    });

    it("once the open item is refunded the booking settles as partially_published (and the delivery email would go out)", async () => {
      const b = await withItems(["posted_manual", "refund_due"]);
      await prisma.campaignBookingItem.updateMany({ where: { bookingId: b.id, status: "refund_due" }, data: { status: "refunded" } });
      expect(await bookingSvc.settleBooking(b.id, { type: "system" })).toBe(true);
      expect(await statusOf(b.id)).toBe("partially_published");
    });
  });

  // ── Freeze guards ─────────────────────────────────────────────────────────────

  describe("a booking with creator money on file cannot be edited out from under it", () => {
    const put = (path: string, body: object) => request(app).put(path).set(auth()).send(body);

    it("after payment the client cannot change the items, the info, the format or cancel; a 'changes requested' booking only takes creative edits", async () => {
      const page = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      const id = paid.booking.id;
      // paid_pending_review: nothing is editable (the existing rule), and cancel says why.
      expect((await pick(id, [page.card.id])).status).toBe(409);
      expect((await put(`/v1/client/campaigns/${id}/info`, { name: "Renamed", brand: "Brand X", launchFrom: todayIST(), launchTo: todayIST(), campaignType: "entertainment" })).status).toBe(409);
      const cancel = await request(app).post(`/v1/client/campaigns/${id}/cancel`).set(auth());
      expect(cancel.status).toBe(409);
      expect(cancel.body.error.code).toBe("CREATOR_BOOKING_LOCKED");
      expect(cancel.body.error.message).toMatch(/contact us/i);

      // changes_requested: the creative may be edited, but the format and the song option are frozen, and per-account text still saves.
      await prisma.campaignBooking.update({ where: { id }, data: { status: "changes_requested" } });
      const media = await prisma.campaignMedia.findFirstOrThrow({ where: { bookingId: id } });
      const creative = (format: string) => put(`/v1/client/campaigns/${id}/creative`, { format, mediaIds: [media.id], caption: "New caption" });
      const frozen = await creative("reel");
      expect(frozen.status).toBe(409);
      expect(frozen.body.error.code).toBe("PAID_TERMS_FROZEN");
      expect((await creative("post")).status).toBe(200);
      const item = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: id } });
      expect((await put(`/v1/client/campaigns/${id}/items/${item.id}/text`, { caption: "Own caption", hashtags: [], superText: null })).status).toBe(200);
      // Still the same item, the same price, the same snapshot: and the payout row is untouched.
      const after = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: id } });
      expect(after).toMatchObject({ id: item.id, pricePaise: 250_000 });
      expect((await prisma.creatorPayout.findFirstOrThrow()).amountPaise).toBe(100_000);
      expect(await prisma.campaignBookingItem.count({ where: { bookingId: id } })).toBe(1);
    });

    it("⚠️ the race the status check cannot see: payouts exist but the booking still reads awaiting_payment (a capture landed between the check and the lock)", async () => {
      const page = await seedPage();
      const net = await seedNetwork();
      const booking = await seedBooking({ status: "awaiting_payment" });
      expect((await pick(booking.id, [page.card.id, net.card.id])).status).toBe(200);
      const item = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: booking.id, targetType: "creator_asset" } });
      await prisma.creatorPayout.create({
        data: { bookingId: booking.id, bookingItemId: item.id, creatorId: page.creator.id, payoutAccountId: page.account!.id, razorpayAccountId: page.account!.razorpayAccountId!, razorpayPaymentId: "pay_race", itemPricePaise: 250_000, shareBps: 4000, grossPaise: 100_000, amountPaise: 100_000 },
      });
      const before = await prisma.campaignBookingItem.findMany({ where: { bookingId: booking.id }, orderBy: { id: "asc" } });
      const statusBefore = (await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).status;

      for (const attempt of [
        pick(booking.id, [net.card.id]), // would delete the creator item
        put(`/v1/client/campaigns/${booking.id}/info`, { name: "Renamed", brand: "Brand X", launchFrom: todayIST(), launchTo: todayIST(), campaignType: "entertainment" }), // would re-price
      ]) {
        const res = await attempt;
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("PAID_TERMS_FROZEN");
      }
      const media = await prisma.campaignMedia.findFirstOrThrow({ where: { bookingId: booking.id } });
      // A format change decides which accounts were booked: refused UNDER the lock, where the payout rows are final.
      const reformat = await put(`/v1/client/campaigns/${booking.id}/creative`, { format: "story", mediaIds: [media.id] });
      expect(reformat.status).toBe(409);
      expect(reformat.body.error.code).toBe("PAID_TERMS_FROZEN");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).format).toBe("post");
      const cancel = await request(app).post(`/v1/client/campaigns/${booking.id}/cancel`).set(auth());
      expect(cancel.body.error.code).toBe("CREATOR_BOOKING_LOCKED");
      // Nothing changed: same items, same prices, same status.
      const after = await prisma.campaignBookingItem.findMany({ where: { bookingId: booking.id }, orderBy: { id: "asc" } });
      expect(after.map((i) => [i.id, i.pricePaise, i.status])).toEqual(before.map((i) => [i.id, i.pricePaise, i.status]));
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(statusBefore);
    });

    it("⚠️ the same race cannot re-price a paid creator item through a creative save either (the rate card moved since checkout)", async () => {
      const page = await seedPage({ price: 250_000 });
      const booking = await seedBooking({ status: "awaiting_payment" });
      expect((await pick(booking.id, [page.card.id])).status).toBe(200);
      const item = await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: booking.id } });
      await prisma.creatorPayout.create({
        data: { bookingId: booking.id, bookingItemId: item.id, creatorId: page.creator.id, payoutAccountId: page.account!.id, razorpayAccountId: page.account!.razorpayAccountId!, razorpayPaymentId: "pay_race2", itemPricePaise: 250_000, shareBps: 4000, grossPaise: 100_000, amountPaise: 100_000 },
      });
      await prisma.campaignRateCard.update({ where: { id: page.card.id }, data: { pricePaise: 400_000 } });
      const media = await prisma.campaignMedia.findFirstOrThrow({ where: { bookingId: booking.id } });
      const res = await put(`/v1/client/campaigns/${booking.id}/creative`, { format: "post", mediaIds: [media.id], caption: "Same format, same song option" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PAID_TERMS_FROZEN");
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } })).pricePaise).toBe(250_000);
    });

    it("a network-only paid booking keeps its old answers (NOT_EDITABLE), and an unpaid one can still be edited and cancelled", async () => {
      const net = await seedNetwork();
      const paid = await bookAndPay([net.card.id]);
      const cancel = await request(app).post(`/v1/client/campaigns/${paid.booking.id}/cancel`).set(auth());
      expect(cancel.status).toBe(409);
      expect(cancel.body.error.code).toBe("NOT_EDITABLE");
      const open = await seedBooking();
      expect((await pick(open.id, [net.card.id])).status).toBe(200);
      expect((await put(`/v1/client/campaigns/${open.id}/info`, { name: "Renamed", brand: "Brand X", launchFrom: todayIST(), launchTo: todayIST(), campaignType: "entertainment" })).status).toBe(200);
      expect((await request(app).post(`/v1/client/campaigns/${open.id}/cancel`).set(auth())).status).toBe(200);
    });

    it("another client's creator booking is a 404, never a 403, and the cancel check does not reveal it exists", async () => {
      const page = await seedPage();
      const paid = await bookAndPay([page.card.id]);
      const other = await prisma.client.create({ data: { companyName: "Brand B", contactName: "Bo", email: "b@brand.test", passwordHash: "x" } });
      const res = await request(app).post(`/v1/client/campaigns/${paid.booking.id}/cancel`).set("Authorization", `Bearer ${generateClientToken(other.id, other.email)}`);
      expect(res.status).toBe(404);
    });
  });

  // ── What the client sees: the provider is named ───────────────────────────────

  describe("the client sees who provides each post", () => {
    it("names the creator on the booking and the results, from the name frozen at checkout, and shows nothing else of them", async () => {
      const page = await seedPage({ creatorName: "Meera Kapoor", name: "Meera Eats", tdsBps: 1000 });
      const net = await seedNetwork();
      const paid = await bookAndPay([page.card.id, net.card.id]);
      // The creator renames themselves afterwards: the brand paid "Meera Kapoor", and that is who it keeps seeing.
      await prisma.creator.update({ where: { id: page.creator.id }, data: { name: "Someone Else" } });
      const res = await request(app).get(`/v1/client/campaigns/${paid.booking.id}`).set(auth());
      expect(res.status).toBe(200);
      const items = res.body.data.items as Array<Record<string, any>>;
      expect(items.find((i) => i.accountName === "Meera Eats")!.provider).toEqual({ type: "creator", name: "Meera Kapoor" });
      expect(items.find((i) => i.accountName.startsWith("Network"))!.provider).toEqual({ type: "network", name: null });
      expect(items.every((i) => !("targetType" in i) && !("targetId" in i))).toBe(true);
      const json = JSON.stringify(res.body);
      for (const secret of [page.creator.id, page.creator.email, page.account!.id, page.account!.razorpayAccountId!, "shareBps", "tdsBps", "grossPaise", "amountPaise", "razorpayAccount", "pricingSnapshot"]) {
        expect(json, secret).not.toContain(secret);
      }
      // Approved: results carry it too.
      await prisma.campaignBooking.update({ where: { id: paid.booking.id }, data: { status: "approved" } });
      const results = await request(app).get(`/v1/client/campaigns/${paid.booking.id}/results`).set(auth());
      expect(results.status).toBe(200);
      expect(results.body.data.items.find((i: any) => i.accountName === "Meera Eats").provider).toEqual({ type: "creator", name: "Meera Kapoor" });
      expect(JSON.stringify(results.body)).not.toContain(page.creator.email);
    });

    it("before checkout the name is the page's current owner's", async () => {
      const page = await seedPage({ creatorName: "Meera Kapoor" });
      const booking = await seedBooking();
      const res = await pick(booking.id, [page.card.id]);
      expect(res.body.data.items[0].provider).toEqual({ type: "creator", name: "Meera Kapoor" });
    });
  });

  // ── What the client is told: the creator is named, and a creator's post is never "scheduled" ──

  describe("what the client is told names the creator", () => {
    type Mail = { to: string; subject: string; html: string };
    const mails = (prefix: string): Mail[] =>
      vi.mocked(sendEmail).mock.calls.map((c) => c[0] as Mail).filter((o) => o.to === "a@brand.test" && o.subject.startsWith(prefix));
    const mailed = async (prefix: string): Promise<Mail> => {
      await vi.waitFor(() => expect(mails(prefix).length).toBeGreaterThan(0));
      return mails(prefix)[0];
    };
    /** Nothing of a creator's payout, share, tax or Razorpay account is ever in what a client reads. */
    const expectNoPayoutData = (text: string, page: Page) => {
      for (const secret of [page.creator.id, page.creator.email, page.account!.id, page.account!.razorpayAccountId!, "shareBps", "4321", "tdsBps", "grossPaise", "amountPaise", "payout"]) {
        expect(text, secret).not.toContain(secret);
      }
    };

    it("the order's notes and the checkout response name the creator and nothing of the payout; a network-only order is exactly what it was", async () => {
      const page = await seedPage({ creatorName: "Meera Kapoor", name: "Meera Eats", tdsBps: 1000, shareBps: 4321 });
      const other = await seedPage({ creatorName: "Rohan Sethi", name: "Rohan Reels" });
      const net = await seedNetwork();
      const orders = () => rz.calls.filter((c) => c.url.endsWith("/orders"));

      const plain = await seedBooking();
      expect((await pick(plain.id, [net.card.id])).status).toBe(200);
      const coPlain = await checkout(plain.id);
      expect(coPlain.status).toBe(200);
      expect(orders()[0].body.notes).toEqual({ bookingId: plain.id, clientId });
      expect(Object.keys(coPlain.body.data).sort()).toEqual(["amount", "currency", "keyId", "name", "offline", "orderId"]);

      const booking = await seedBooking();
      expect((await pick(booking.id, [net.card.id, page.card.id, other.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      expect(co.status).toBe(200);
      const notes = orders()[1].body.notes as Record<string, string>;
      expect(Object.keys(notes).sort()).toEqual(["bookingId", "clientId", "creators"]);
      expect(notes.creators.split(", ").sort()).toEqual(["Meera Kapoor", "Rohan Sethi"]);
      expect(co.body.data.description).toBe(`${booking.name} — includes posts by ${notes.creators}`);
      expect(co.body.data.name).toBe(booking.name);
      // The whole order request and the whole response: names only.
      expectNoPayoutData(JSON.stringify(orders()[1].body), page);
      expectNoPayoutData(JSON.stringify(co.body), page);
    });

    it("the 'payment received' email says who makes the creator posts (the name frozen at checkout), and a network-only receipt is unchanged", async () => {
      const page = await seedPage({ creatorName: "Meera Kapoor", name: "Meera Eats", tdsBps: 1000, shareBps: 4321 });
      const net = await seedNetwork();
      vi.mocked(sendEmail).mockClear();
      const plain = await bookAndPay([net.card.id]);
      const plainMail = await mailed("Payment received");
      expect(plainMail.html).toContain(`for <strong>${plain.booking.name}</strong>. Our team will review your campaign, usually within one working day, and let you know.</p><p><a href=`);
      expect(plainMail.html).not.toContain("creators");

      vi.mocked(sendEmail).mockClear();
      const paid = await bookAndPay([net.card.id, page.card.id]);
      // The creator renames themselves after the payment: the receipt is about who was booked.
      await prisma.creator.update({ where: { id: page.creator.id }, data: { name: "Someone Else" } });
      const mail = await mailed("Payment received");
      expect(mail.html).toContain(`<strong>${paid.booking.name}</strong>`);
      expect(mail.html).toContain("This includes 1 post made by creators: <strong>Meera Kapoor</strong> (Meera Eats on Instagram).");
      expect(mail.html).toContain("a post a creator doesn't confirm is refunded to you");
      expect(mail.html).not.toContain("scheduled");
      expect(mail.html).not.toContain("Someone Else");
      expectNoPayoutData(mail.html, page);
    });

    it("⚠️ the 'approved' email never calls a creator's post 'scheduled': it says the creator confirms and posts, and that an unconfirmed post is refunded", async () => {
      const page = await seedPage({ creatorName: "Meera Kapoor", name: "Meera Eats", tdsBps: 1000, shareBps: 4321 });
      const net = await seedNetwork();
      // seedBooking's go-live window: today (IST) to a week later, as date-only columns formatted in UTC.
      const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
      const from = new Date(`${todayIST()}T00:00:00Z`);
      const windowText = `${fmt(from)} – ${fmt(new Date(from.getTime() + 7 * DAY))}`;

      // Network-only: the sentence is exactly what it always was.
      vi.mocked(sendEmail).mockClear();
      const plain = await bookAndPay([net.card.id]);
      expect((await adminPost(`/v1/admin/campaigns/${plain.booking.id}/approve`)).status).toBe(200);
      const plainMail = await mailed("Approved");
      expect(plainMail.html).toContain(`<p><strong>${plain.booking.name}</strong> is approved and scheduled. You'll get an email with the link as each post goes live.</p><p>Your go-live window is ${windowText}.</p>`);

      // A creator-only booking.
      vi.mocked(sendEmail).mockClear();
      const only = await bookAndPay([page.card.id], { held: true });
      expect((await adminPost(`/v1/admin/campaigns/${only.booking.id}/approve`)).status).toBe(200);
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: only.booking.id } })).status).toBe("awaiting_creator");
      const onlyMail = await mailed("Approved");
      expect(onlyMail.html).not.toContain("scheduled");
      expect(onlyMail.html).toContain(`<strong>${only.booking.name}</strong> is approved.`);
      expect(onlyMail.html).toContain("Posts by creators: <strong>Meera Kapoor</strong> (Meera Eats on Instagram).");
      expect(onlyMail.html).toContain("Each creator is asked to confirm their post and posts it by hand within your go-live window.");
      expect(onlyMail.html).toContain("A post a creator doesn't confirm is refunded to you.");
      expect(onlyMail.html).toContain(`Your go-live window is ${windowText}.</p>`);
      expectNoPayoutData(onlyMail.html, page);

      // A mixed booking: "scheduled" is said of OUR accounts only.
      vi.mocked(sendEmail).mockClear();
      const mixed = await bookAndPay([net.card.id, page.card.id], { held: true });
      expect((await adminPost(`/v1/admin/campaigns/${mixed.booking.id}/approve`)).status).toBe(200);
      const mixedMail = await mailed("Approved");
      expect(mixedMail.html).toContain("Posts on our own accounts are scheduled, and you'll get an email with each link as it goes live.");
      expect(mixedMail.html).toContain("Posts by creators: <strong>Meera Kapoor</strong> (Meera Eats on Instagram).");
      expect(mixedMail.html.match(/scheduled/g)).toHaveLength(1);
    });

    it("an approved creator post that will not go ahead (the page changed hands) is said to be returned, not waited for", async () => {
      const page = await seedPage({ creatorName: "Meera Kapoor", name: "Meera Eats" });
      const other = await seedPage();
      vi.mocked(sendEmail).mockClear();
      const paid = await bookAndPay([page.card.id]);
      await prisma.creatorAsset.update({ where: { id: page.asset.id }, data: { creatorId: other.creator.id, connectionId: other.conn.id } });
      expect((await adminPost(`/v1/admin/campaigns/${paid.booking.id}/approve`)).status).toBe(200);
      expect((await prisma.campaignBookingItem.findFirstOrThrow({ where: { bookingId: paid.booking.id } })).status).toBe("refund_due");
      const mail = await mailed("Approved");
      expect(mail.html).not.toContain("scheduled");
      expect(mail.html).toContain("1 creator post won't go ahead. The amount for it is being returned to you.");
      expect(mail.html).not.toContain("Each creator is asked to confirm");
    });

    it("the 'post is live' and delivery emails name the creator (the name frozen at checkout) on a creator's post and only there", async () => {
      const page = await seedPage({ creatorName: "Meera Kapoor", name: "Meera Eats", tdsBps: 1000, shareBps: 4321 });
      const net = await seedNetwork();
      const paid = await bookAndPay([page.card.id, net.card.id]);
      await prisma.creator.update({ where: { id: page.creator.id }, data: { name: "Someone Else" } });
      const creatorItem = paid.itemOf(page.asset.id);
      await prisma.campaignBooking.update({ where: { id: paid.booking.id }, data: { status: "approved" } });
      await prisma.campaignBookingItem.update({ where: { id: creatorItem.id }, data: { status: "posted_manual", permalink: "https://www.instagram.com/p/creatorpost/", postedAt: new Date() } });

      vi.mocked(sendEmail).mockClear();
      expect(await sendItemLiveEmail(creatorItem.id)).toBe(true);
      const live = await mailed("Live on");
      expect(live.html).toMatch(/posted [^<]* by <strong>Meera Kapoor<\/strong>\.<\/p>/);
      expect(live.html).not.toContain("Someone Else");
      expectNoPayoutData(live.html, page);

      // A network post on a booking of its own (the last post of a multi-post booking is left to the delivery email).
      const plainBooking = await bookAndPay([net.card.id]);
      const plainItem = plainBooking.itemOf(net.asset.id);
      await prisma.campaignBookingItem.update({ where: { id: plainItem.id }, data: { status: "posted_manual", permalink: "https://www.instagram.com/p/networkpost/", postedAt: new Date() } });
      vi.mocked(sendEmail).mockClear();
      expect(await sendItemLiveEmail(plainItem.id)).toBe(true);
      const liveNet = await mailed("Live on");
      expect(liveNet.html).toMatch(/posted [^<]*\.<\/p>/);
      expect(liveNet.html).not.toContain(" by <strong>");

      vi.mocked(sendEmail).mockClear();
      await sendDeliveryEmail(paid.booking.id, { force: true });
      const delivered = await mailed("Delivered");
      expect(delivered.html.match(/Posted by /g)).toHaveLength(1);
      expect(delivered.html).toContain("Posted by Meera Kapoor</span>");
      expect(delivered.html).not.toContain("Someone Else");
      expectNoPayoutData(delivered.html, page);
      // A network-only booking's table has no "Posted by" at all.
      const plain = await bookAndPay([net.card.id]);
      await prisma.campaignBookingItem.updateMany({ where: { bookingId: plain.booking.id }, data: { status: "posted_manual", permalink: "https://www.instagram.com/p/plain/", postedAt: new Date() } });
      vi.mocked(sendEmail).mockClear();
      await sendDeliveryEmail(plain.booking.id, { force: true });
      expect((await mailed("Delivered")).html).not.toContain("Posted by");
    });
  });

  // ── Page take-over and purge ──────────────────────────────────────────────────

  describe("a page with open work cannot change hands or be purged", () => {
    /** An open offer on a page. */
    async function openOffer(page: Page, status = "offered") {
      return prisma.creatorOffer.create({
        data: {
          bookingId: `bk-${++seq}`,
          bookingItemId: `bi-${seq}`,
          creatorId: page.creator.id,
          creatorAssetId: page.asset.id,
          pageName: page.asset.name,
          platform: "instagram",
          format: "post",
          status,
          payoutPaise: 90_000,
          expiresAt: later(DAY),
        },
      });
    }
    /** An unsettled payout on a page: a real booking item pointing at the page, plus the payout row. */
    async function payoutOn(page: Page, status: string) {
      const booking = await prisma.campaignBooking.create({ data: { clientId, name: "P", brand: "B", status: "approved", format: "post", launchFrom: new Date(), launchTo: new Date() } });
      const item = await prisma.campaignBookingItem.create({
        data: { bookingId: booking.id, rateCardId: page.card.id, targetType: "creator_asset", targetId: page.asset.id, platform: "instagram", format: "post", accountName: page.asset.name, pricePaise: 250_000, status: "manual_pending" },
      });
      return prisma.creatorPayout.create({
        data: { bookingId: booking.id, bookingItemId: item.id, creatorId: page.creator.id, payoutAccountId: page.account!.id, razorpayAccountId: page.account!.razorpayAccountId!, razorpayPaymentId: `pay_${seq++}`, status, itemPricePaise: 250_000, shareBps: 4000, grossPaise: 100_000, amountPaise: 100_000 },
      });
    }

    it("pagesWithOpenWork: an offered or accepted offer and every unsettled payout status count; finished work does not", async () => {
      const page = await seedPage();
      expect(await pageHasOpenWork(page.asset.id)).toBe(false);
      for (const s of ["declined", "expired", "withdrawn", "completed"]) {
        const p = await seedPage();
        await openOffer(p, s);
        expect(await pageHasOpenWork(p.asset.id), `offer ${s}`).toBe(false);
      }
      for (const s of ["offered", "accepted"]) {
        const p = await seedPage();
        await openOffer(p, s);
        expect(await pageHasOpenWork(p.asset.id), `offer ${s}`).toBe(true);
      }
      for (const s of ["settled", "paid_manual", "void", "reversed"]) {
        const p = await seedPage();
        await payoutOn(p, s);
        expect(await pageHasOpenWork(p.asset.id), `payout ${s}`).toBe(false);
      }
      for (const s of ["planned", "transfer_requested", "held", "release_requested", "released", "settlement_failed", "reversal_requested", "failed", "needs_attention", "manual_required"]) {
        const p = await seedPage();
        await payoutOn(p, s);
        expect(await pageHasOpenWork(p.asset.id), `payout ${s}`).toBe(true);
      }
      const busy = await seedPage();
      await openOffer(busy);
      const idle = await seedPage();
      expect([...(await pagesWithOpenWork([busy.asset.id, idle.asset.id, "no-such-page"]))]).toEqual([busy.asset.id]);
      expect([...(await pagesWithOpenWork([]))]).toEqual([]);
    });

    // A tiny Graph: B's connection can publish to ONE page.
    const PAGE_ID = "300000000000777";
    const ENV = { META_OAUTH_APP_ID: "298449321694397", META_OAUTH_APP_SECRET: "test-app-secret", CREATORS_ENABLED: "1" };
    function installGraph() {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          const url = new URL(String(input));
          const p = url.pathname.replace(/^\/v\d+\.\d+\//, "/");
          const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
          if (p === "/me") return json({ id: "u1", name: "New Owner" });
          if (p === "/me/accounts") {
            return (url.searchParams.get("fields") ?? "").includes("access_token")
              ? json({ data: [{ id: PAGE_ID, name: "Contested Page", tasks: ["MANAGE", "CREATE_CONTENT"], access_token: "EAApagetokenxxxxxxxxxxxxxxxx", followers_count: 10 }] })
              : json({ data: [] });
          }
          return new Response(JSON.stringify({ error: { code: 100, message: `unexpected ${p}` } }), { status: 400 });
        }),
      );
    }
    /** The holder A (a lapsed connection, so any claimant may take the page) and a claimant B with a live connection. */
    async function contested() {
      for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
      installGraph();
      const holder = await seedPage({ name: "Contested Page" });
      await prisma.creatorAsset.update({ where: { id: holder.asset.id }, data: { metaId: PAGE_ID, kind: "facebook_page" } });
      await prisma.campaignRateCard.update({ where: { id: holder.card.id }, data: { platform: "facebook" } });
      await prisma.creatorConnection.update({ where: { id: holder.conn.id }, data: { status: "NEEDS_REAUTH" } });
      const claimantCreator = await prisma.creator.create({ data: { email: "claimant@creators.test", passwordHash: "x", name: "Claimant", status: "approved", emailVerifiedAt: new Date() } });
      const claimantConn = await prisma.creatorConnection.create({
        data: { creatorId: claimantCreator.id, metaUserId: "meta-claimant", userTokenEnc: encryptToken("EAAusertokenxxxxxxxxxxxxxxxxxx"), grantedScopes: "pages_show_list,pages_manage_posts" },
      });
      return { holder, claimantCreator, claimantConn };
    }

    it("a lapsed holder's page is taken over by a new claimant, and the page's card goes inactive and loses its share", async () => {
      const { holder, claimantCreator, claimantConn } = await contested();
      const out = await discoverCreatorAssets(claimantConn.id);
      expect(out.claimedElsewhere).toBe(0);
      const asset = await prisma.creatorAsset.findUniqueOrThrow({ where: { id: holder.asset.id } });
      expect(asset).toMatchObject({ creatorId: claimantCreator.id, connectionId: claimantConn.id, enabled: false });
      const card = await prisma.campaignRateCard.findUniqueOrThrow({ where: { id: holder.card.id } });
      expect(card.active).toBe(false);
      expect(await prisma.creatorRateTerm.count({ where: { rateCardId: holder.card.id } })).toBe(0);
      expect(await entryFor(holder)).toBeUndefined();
    });

    it.each(["offer offered", "offer accepted", "payout planned", "payout held"])("⚠️ refuses the take-over while there is an open %s, and leaves the card and the share alone", async (kind) => {
      const { holder, claimantCreator, claimantConn } = await contested();
      if (kind.startsWith("offer")) await openOffer(holder, kind.endsWith("accepted") ? "accepted" : "offered");
      else await payoutOn(holder, kind.endsWith("held") ? "held" : "planned");
      const out = await discoverCreatorAssets(claimantConn.id);
      expect(out.claimedElsewhere).toBe(1);
      const asset = await prisma.creatorAsset.findUniqueOrThrow({ where: { id: holder.asset.id } });
      expect(asset.creatorId).toBe(holder.creator.id);
      expect(asset.connectionId).toBe(holder.conn.id);
      expect((await prisma.campaignRateCard.findUniqueOrThrow({ where: { id: holder.card.id } })).active).toBe(true);
      expect(await prisma.creatorRateTerm.count({ where: { rateCardId: holder.card.id } })).toBe(1);
      expect(await prisma.creatorAsset.count({ where: { creatorId: claimantCreator.id } })).toBe(0);
    });

    it("a take-over IS allowed once the work is finished (a settled payout, a declined offer)", async () => {
      const { holder, claimantCreator, claimantConn } = await contested();
      await payoutOn(holder, "settled");
      await openOffer(holder, "declined");
      expect((await discoverCreatorAssets(claimantConn.id)).claimedElsewhere).toBe(0);
      expect((await prisma.creatorAsset.findUniqueOrThrow({ where: { id: holder.asset.id } })).creatorId).toBe(claimantCreator.id);
    });

    it("the daily purge keeps pages and connections with open offers or unsettled payouts, and deletes the rest", async () => {
      const old = new Date(Date.now() - 40 * DAY);
      const free = await seedPage();
      const withOffer = await seedPage();
      const withPayout = await seedPage();
      const settled = await seedPage();
      for (const p of [free, withOffer, withPayout, settled]) await prisma.creatorAsset.update({ where: { id: p.asset.id }, data: { disconnectedAt: old, enabled: false } });
      await openOffer(withOffer, "accepted");
      await payoutOn(withPayout, "held");
      await payoutOn(settled, "settled");
      const result = await purgeCreatorPageData();
      expect(result).toEqual({ assets: 2, connections: 0 });
      const left = new Set((await prisma.creatorAsset.findMany({ select: { id: true } })).map((a) => a.id));
      expect(left.has(free.asset.id)).toBe(false);
      expect(left.has(settled.asset.id)).toBe(false);
      expect(left.has(withOffer.asset.id)).toBe(true);
      expect(left.has(withPayout.asset.id)).toBe(true);
    });

    it("a revoked connection is kept while ANY page under it has open work, and purged (with its pages) when none does", async () => {
      const old = new Date(Date.now() - 40 * DAY);
      const busy = await seedPage();
      const quiet = await seedPage();
      for (const p of [busy, quiet]) await prisma.creatorConnection.update({ where: { id: p.conn.id }, data: { revokedAt: old, status: "REVOKED", userTokenEnc: null } });
      // The page itself is NOT disconnected: only its connection was revoked long ago.
      await openOffer(busy, "offered");
      expect(await purgeCreatorPageData()).toEqual({ assets: 0, connections: 1 });
      expect(await prisma.creatorConnection.findUnique({ where: { id: busy.conn.id } })).not.toBeNull();
      expect(await prisma.creatorAsset.findUnique({ where: { id: busy.asset.id } })).not.toBeNull();
      expect(await prisma.creatorConnection.findUnique({ where: { id: quiet.conn.id } })).toBeNull();
      expect(await prisma.creatorAsset.findUnique({ where: { id: quiet.asset.id } })).toBeNull(); // cascaded
      // Once the work is done the next pass takes it.
      await prisma.creatorOffer.updateMany({ data: { status: "completed" } });
      expect(await purgeCreatorPageData()).toEqual({ assets: 0, connections: 1 });
    });

    it("the purge is unchanged when there are no offers or payouts at all, and keeps a page that is not yet 30 days old", async () => {
      const recent = await seedPage();
      const old = await seedPage();
      await prisma.creatorAsset.update({ where: { id: recent.asset.id }, data: { disconnectedAt: new Date(Date.now() - 10 * DAY) } });
      await prisma.creatorAsset.update({ where: { id: old.asset.id }, data: { disconnectedAt: new Date(Date.now() - 40 * DAY) } });
      expect(await purgeCreatorPageData()).toEqual({ assets: 1, connections: 0 });
      expect(await prisma.creatorAsset.findUnique({ where: { id: recent.asset.id } })).not.toBeNull();
      expect(await purgeCreatorPageData()).toEqual({ assets: 0, connections: 0 });
    });
  });

  // ── The refund seam ───────────────────────────────────────────────────────────

  describe("ensurePayoutRefundable: a creator item's payout is taken out of the way BEFORE its price is refunded", () => {
    /** A creator item whose payout is `planned` (the capture's own state), or really `held` (the transfer made at the fake). */
    async function payoutItem(state: "planned" | "held" | string = "planned") {
      const page = await seedPage();
      const paid = await bookAndPay([page.card.id], { held: state === "held" });
      const item = paid.itemOf(page.asset.id);
      if (state !== "planned" && state !== "held") await prisma.creatorPayout.updateMany({ where: { bookingItemId: item.id }, data: { status: state } });
      return { page, paid, item };
    }
    const reversals = () => route.calls.filter((c) => c.method === "POST" && /\/reversals$/.test(c.path));
    let maybeSeq = 0;
    /** An approved booking whose creator item waits for the creator, with the offer that goes with it. */
    async function approvedWithOffer(state: "planned" | "held", o: { offerStatus?: string; linkSubmitted?: boolean } = {}) {
      const { page, paid, item } = await payoutItem(state);
      await prisma.campaignBooking.update({ where: { id: paid.booking.id }, data: { status: "approved" } });
      await prisma.campaignBookingItem.update({ where: { id: item.id }, data: { status: (o.offerStatus ?? "offered") === "offered" ? "awaiting_creator" : "manual_pending" } });
      const offer = await prisma.creatorOffer.create({
        data: {
          bookingId: paid.booking.id, bookingItemId: item.id, creatorId: page.creator.id, creatorAssetId: page.asset.id, pageName: page.asset.name, platform: "instagram", format: "post",
          status: o.offerStatus ?? "offered", payoutPaise: 100_000, expiresAt: later(DAY),
          ...(o.linkSubmitted ? { linkUrl: "https://www.instagram.com/p/abc/", linkSubmittedAt: new Date() } : {}),
        },
      });
      return { page, paid, item, offer };
    }

    it("voids a planned payout: status void, a reason, one audit row, no Razorpay call; a second call is a no-op", async () => {
      const { item } = await payoutItem();
      const first = await ensurePayoutRefundable(item.id, { actor: { type: "staff", id: staffId }, reason: "item_refunded" });
      expect(first).toMatchObject({ voided: true, reversed: false, state: "voided" });
      const row = await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: item.id } });
      expect(row).toMatchObject({ status: "void", voidReason: "item_refunded", id: first.payoutId });
      const events = await prisma.creatorPayoutEvent.findMany({ where: { payoutId: row.id }, orderBy: { createdAt: "asc" } });
      expect(events.map((e) => [e.kind, e.fromStatus, e.toStatus, e.actorType, e.actorId])).toEqual([
        ["planned", null, "planned", "system", null],
        ["void", "planned", "void", "staff", staffId],
      ]);
      expect(route.writes()).toHaveLength(0);
      const again = await ensurePayoutRefundable(item.id);
      expect(again).toMatchObject({ payoutId: row.id, voided: false, reversed: false, state: "void" });
      expect(await prisma.creatorPayoutEvent.count({ where: { payoutId: row.id } })).toBe(2);
    });

    it("returns for an item with no payout at all", async () => {
      expect(await ensurePayoutRefundable("no-such-item")).toEqual({ payoutId: null, voided: false, reversed: false, state: "no_payout" });
    });

    it("⚠️ a HELD payout is reversed at Razorpay (explicit amount, one reversal) and only then reads refundable; a second call reverses nothing more", async () => {
      const { item } = await payoutItem("held");
      const before = await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: item.id } });
      expect(before.status).toBe("held");
      const first = await ensurePayoutRefundable(item.id, { actor: { type: "staff", id: staffId }, reason: "item_refunded" });
      expect(first).toMatchObject({ voided: false, reversed: true, state: "reversed", payoutId: before.id });
      expect((await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: item.id } })).status).toBe("reversed");
      expect(reversals()).toHaveLength(1);
      expect(reversals()[0].body).toMatchObject({ amount: before.amountPaise });
      expect(reversals()[0].body).not.toHaveProperty("reverse_all");
      expect(await ensurePayoutRefundable(item.id)).toMatchObject({ reversed: true, state: "reversed" });
      expect(reversals()).toHaveLength(1);
    });

    it("a failed payout (Razorpay refused the transfer, so no money moved) is voided", async () => {
      const { item } = await payoutItem("failed");
      expect(await ensurePayoutRefundable(item.id)).toMatchObject({ voided: true, state: "voided" });
      expect((await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: item.id } })).status).toBe("void");
    });

    it("an already reversed or void payout is refundable with no call and no new audit row", async () => {
      for (const status of ["reversed", "void"]) {
        const { item } = await payoutItem(status);
        const events = await prisma.creatorPayoutEvent.count();
        expect(await ensurePayoutRefundable(item.id)).toMatchObject({ state: status === "void" ? "void" : "reversed" });
        expect(await prisma.creatorPayoutEvent.count()).toBe(events);
      }
      expect(route.writes()).toHaveLength(0);
    });

    it.each([
      ["transfer_requested", "PAYOUT_BUSY"],
      ["release_requested", "PAYOUT_BUSY"],
      ["released", "PAYOUT_PAID_OUT"],
      ["settled", "PAYOUT_PAID_OUT"],
      ["settlement_failed", "PAYOUT_PAID_OUT"],
      ["paid_manual", "PAYOUT_PAID_OUT"],
      ["needs_attention", "PAYOUT_NEEDS_ATTENTION"],
    ])("⚠️ %s: throws 409 %s and changes nothing (no refund may start)", async (status, code) => {
      const { item } = await payoutItem(status);
      const events = await prisma.creatorPayoutEvent.count();
      await expect(ensurePayoutRefundable(item.id)).rejects.toMatchObject({ statusCode: 409, code });
      expect((await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: item.id } })).status).toBe(status);
      expect(await prisma.creatorPayoutEvent.count({ where: { kind: "void" } })).toBe(0);
      expect(refundPosts()).toHaveLength(0);
      expect(route.writes()).toHaveLength(0);
      expect(await prisma.creatorPayoutEvent.count()).toBe(events);
    });

    it("manual_required that may have moved money is a person's decision, not a refund's; one that provably never sent a transfer is voided", async () => {
      /** A manual_required payout whose request was sent twice and that records transfer `trf_maybe`, its last request `agoMin` minutes ago. */
      async function maybeMoved(agoMin: number) {
        const x = await payoutItem("manual_required");
        const p = await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: x.item.id } });
        if (!route.payments.has(p.razorpayPaymentId)) route.seedPayment({ id: p.razorpayPaymentId, amount: p.itemPricePaise });
        const id = `trf_maybe${++maybeSeq}`;
        // ALIVE at Razorpay (processed, on hold) and carrying the payout's id, but not on the payment's listing yet (Razorpay's list lags).
        route.seedTransfer({ id, source: p.razorpayPaymentId, recipient: p.razorpayAccountId, amount: p.amountPaise, status: "processed", onHold: true, notes: { payout_id: p.id }, hidden: 10 });
        await prisma.creatorPayout.update({ where: { id: p.id }, data: { attempts: 2, razorpayTransferId: id, transferRequestedAt: new Date(Date.now() - agoMin * 60_000) } });
        return { ...x, payoutId: p.id, transferId: id };
      }
      const statusOf = async (itemId: string) => (await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: itemId } })).status;

      // Its transfer is read and is alive (not failed, not reversed): nothing proves the money is back, so a PERSON decides; nothing is voided.
      const unproven = await maybeMoved(15);
      await expect(ensurePayoutRefundable(unproven.item.id)).rejects.toMatchObject({ statusCode: 409, code: "PAYOUT_NEEDS_ATTENTION" });
      expect(await statusOf(unproven.item.id)).toBe("manual_required");

      // Its transfer cannot be read: the refund WAITS (asked again by the worker), it is not voided and nobody is asked to decide yet.
      const unread = await maybeMoved(15);
      route.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 });
      await expect(ensurePayoutRefundable(unread.item.id)).rejects.toMatchObject({ statusCode: 409, code: "PAYOUT_BUSY" });
      expect(await statusOf(unread.item.id)).toBe("manual_required");

      // Its last request was sent minutes ago (a request can still be on its way in): it waits too, and nothing is even read yet.
      const recent = await maybeMoved(2);
      const calls = route.calls.length;
      await expect(ensurePayoutRefundable(recent.item.id)).rejects.toMatchObject({ statusCode: 409, code: "PAYOUT_BUSY" });
      expect(route.calls.length).toBe(calls);
      expect(await statusOf(recent.item.id)).toBe("manual_required");
      expect(route.writes()).toHaveLength(0);
      expect(refundPosts()).toHaveLength(0);

      const proven = await payoutItem("manual_required");
      await prisma.creatorPayout.updateMany({ where: { bookingItemId: proven.item.id }, data: { attempts: 0, razorpayTransferId: null } });
      expect(await ensurePayoutRefundable(proven.item.id)).toMatchObject({ voided: true });
    });

    it("refundItem on a creator item (planned payout) voids the payout, withdraws the offer, claims the item, and refunds that item's price once", async () => {
      const { paid, item, offer } = await approvedWithOffer("planned");
      const res = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/items/${item.id}/refund`);
      expect(res.status).toBe(200);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("refunded");
      expect(await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: item.id } })).toMatchObject({ status: "void", voidReason: "item_refunded" });
      expect(await prisma.creatorOffer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({ status: "withdrawn", closedReason: "withdrawn", withdrawnById: staffId });
      expect(refundPosts()).toHaveLength(1);
      expect(refundPosts()[0]).toMatchObject({ key: `rf-item-${item.id}`, body: { amount: 250_000 } });
      // Doing it again changes nothing and refunds nothing more.
      expect((await adminPost(`/v1/admin/campaigns/${paid.booking.id}/items/${item.id}/refund`)).status).toBe(409);
      expect(refundPosts()).toHaveLength(1);
    });

    it("⚠️ refundItem on a HELD payout reverses the transfer FIRST, then refunds: the reversal comes before the refund, once each", async () => {
      const { paid, item, offer } = await approvedWithOffer("held", { offerStatus: "accepted" });
      const mark = route.calls.length;
      const res = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/items/${item.id}/refund`);
      expect(res.status).toBe(200);
      expect(await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: item.id } })).toMatchObject({ status: "reversed" });
      expect((await prisma.creatorOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe("withdrawn");
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("refunded");
      expect(refundPosts()).toHaveLength(1);
      expect(reversals()).toHaveLength(1);
      // The two logs are separate (the transfer leg is the fake's, the refund the file's own stub), so the order is read from the ledger:
      // the payout was reversed before the refund row was written.
      const payout = await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: item.id } });
      const refund = await prisma.campaignRefund.findFirstOrThrow({ where: { bookingId: paid.booking.id } });
      expect(payout.reversedAt).not.toBeNull();
      expect(payout.reversedAt!.getTime()).toBeLessThanOrEqual(refund.createdAt.getTime());
      const transfer = [...route.transfers.values()][0];
      expect(transfer.amountReversed).toBe(transfer.amount);
      expect(route.calls.length).toBeGreaterThan(mark);
    });

    it("⚠️ refundItem is REFUSED once the share is paid out: nothing refunded, nothing voided, item and offer as they were", async () => {
      const { paid, item, offer } = await approvedWithOffer("held", { offerStatus: "accepted" });
      await prisma.creatorPayout.updateMany({ where: { bookingItemId: item.id }, data: { status: "released" } });
      const res = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/items/${item.id}/refund`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PAYOUT_PAID_OUT");
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("manual_pending");
      expect((await prisma.creatorPayout.findFirstOrThrow({ where: { bookingItemId: item.id } })).status).toBe("released");
      expect((await prisma.creatorOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe("accepted");
      expect(refundPosts()).toHaveLength(0);
      expect(await prisma.campaignRefund.count()).toBe(0);
    });

    it("refundItem is refused once the creator has submitted their link: staff verify it instead", async () => {
      const { paid, item } = await approvedWithOffer("planned", { offerStatus: "accepted", linkSubmitted: true });
      const res = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/items/${item.id}/refund`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CREATOR_LINK_SUBMITTED");
      expect((await prisma.creatorPayout.findFirstOrThrow()).status).toBe("planned");
      expect(refundPosts()).toHaveLength(0);
    });

    it("refundItem accepts a refund_due item, and a network item is refunded exactly as before (no payout code in the way)", async () => {
      const page = await seedPage();
      const other = await seedPage();
      const net = await seedNetwork();
      const paid = await bookAndPay([page.card.id, net.card.id]);
      await prisma.creatorAsset.update({ where: { id: page.asset.id }, data: { creatorId: other.creator.id } });
      expect((await adminPost(`/v1/admin/campaigns/${paid.booking.id}/approve`)).status).toBe(200);
      const creatorItem = paid.itemOf(page.asset.id);
      const netItem = paid.itemOf(net.asset.id);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: creatorItem.id } })).status).toBe("refund_due");
      expect((await adminPost(`/v1/admin/campaigns/${paid.booking.id}/items/${creatorItem.id}/refund`)).status).toBe(200);
      expect((await adminPost(`/v1/admin/campaigns/${paid.booking.id}/items/${netItem.id}/refund`)).status).toBe(200);
      expect(refundPosts().map((r) => r.body.amount).sort()).toEqual([150_000, 250_000]);
      // Both items are refunded and the booking settles.
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("partially_published");
    });

    it("reject refunds every creator item PER ITEM (void or reverse first), withdraws their offers, and the whole rejection is refused while one share is paid out", async () => {
      const a = await seedPage({ price: 250_000 });
      const b = await seedPage({ price: 120_000 });
      const paid = await bookAndPay([a.card.id, b.card.id], { held: true });
      await prisma.campaignBooking.update({ where: { id: paid.booking.id }, data: { status: "approved" } });
      await prisma.campaignBookingItem.updateMany({ where: { bookingId: paid.booking.id }, data: { status: "awaiting_creator" } });
      await prisma.creatorOffer.createMany({
        data: [a, b].map((p, i) => ({ bookingId: paid.booking.id, bookingItemId: paid.itemOf(p.asset.id).id, creatorId: p.creator.id, creatorAssetId: p.asset.id, pageName: p.asset.name, platform: "instagram", format: "post", status: i === 0 ? "offered" : "accepted", payoutPaise: 1, expiresAt: later(DAY) })),
      });

      // One share has already been paid out to its creator: the WHOLE rejection is refused, nothing half-done.
      await prisma.creatorPayout.updateMany({ where: { bookingItemId: paid.itemOf(b.asset.id).id }, data: { status: "released" } });
      const refused = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/reject`, { note: "Not suitable" });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("PAYOUT_PAID_OUT");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("approved");
      expect((await prisma.campaignBookingItem.findMany({ where: { bookingId: paid.booking.id } })).every((i) => i.status === "awaiting_creator")).toBe(true);
      expect((await prisma.creatorPayout.findMany()).map((p) => p.status).sort()).toEqual(["held", "released"]);
      expect((await prisma.creatorOffer.findMany()).every((o) => ["offered", "accepted"].includes(o.status))).toBe(true);
      expect(refundPosts()).toHaveLength(0);
      expect(reversals()).toHaveLength(0);

      await prisma.creatorPayout.updateMany({ where: { status: "released" }, data: { status: "held" } });
      const ok = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/reject`, { note: "Not suitable" });
      expect(ok.status).toBe(200);
      expect((await prisma.creatorPayout.findMany()).every((p) => p.status === "reversed")).toBe(true);
      expect((await prisma.creatorOffer.findMany()).every((o) => o.status === "withdrawn" && o.closedReason === "booking_rejected")).toBe(true);
      expect(refundPosts().map((r) => [r.key, r.body.amount]).sort()).toEqual(
        [[`rf-item-${paid.itemOf(a.asset.id).id}`, 250_000], [`rf-item-${paid.itemOf(b.asset.id).id}`, 120_000]].sort(),
      );
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: paid.booking.id } })).status).toBe("refunded");
    });

    it("reject also refunds a refund_due creator item (a page that changed hands), per item, next to a normal one", async () => {
      const gone = await seedPage({ price: 120_000 });
      const kept = await seedPage({ price: 250_000 });
      const other = await seedPage();
      const booking = await seedBooking();
      expect((await pick(booking.id, [gone.card.id, kept.card.id])).status).toBe(200);
      const co = await checkout(booking.id);
      await prisma.creatorAsset.update({ where: { id: gone.asset.id }, data: { creatorId: other.creator.id, connectionId: other.conn.id } });
      expect((await webhook("payment.captured", { id: "pay_rej", order_id: co.body.data.orderId, amount: co.body.data.amount, currency: "INR" })).status).toBe(200);
      const items = await prisma.campaignBookingItem.findMany({ where: { bookingId: booking.id } });
      const goneItem = items.find((i) => i.targetId === gone.asset.id)!;
      const keptItem = items.find((i) => i.targetId === kept.asset.id)!;
      expect(goneItem.status).toBe("refund_due");

      const res = await adminPost(`/v1/admin/campaigns/${booking.id}/reject`, { note: "Not suitable" });
      expect(res.status).toBe(200);
      expect((await prisma.campaignBookingItem.findMany({ where: { bookingId: booking.id } })).every((i) => i.status === "refunded")).toBe(true);
      expect(refundPosts().map((r) => [r.key, r.body.amount]).sort()).toEqual([[`rf-item-${goneItem.id}`, 120_000], [`rf-item-${keptItem.id}`, 250_000]].sort());
      const payouts = await prisma.creatorPayout.findMany({ where: { bookingId: booking.id } });
      expect(payouts.map((p) => [p.status, p.voidReason]).sort()).toEqual([["void", "booking_rejected"], ["void", "page_changed"]]);
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe("refunded");
    });

    it("markFailed is refused on a creator item (it would refund nothing and leave the offer and payout standing)", async () => {
      const { paid, item } = await payoutItem();
      await prisma.campaignBooking.update({ where: { id: paid.booking.id }, data: { status: "approved" } });
      await prisma.campaignBookingItem.update({ where: { id: item.id }, data: { status: "manual_pending" } });
      const res = await adminPost(`/v1/admin/campaigns/${paid.booking.id}/items/${item.id}/failed`, { note: "The creator went quiet" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CREATOR_ITEM");
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("manual_pending");
    });
  });

  // ── What a delivery email says about an open creator item ─────────────────────

  describe("delivery labels", () => {
    it("an item that is waiting for a creator, or whose money is owed back, is not called 'Scheduled'", async () => {
      const booking = await prisma.campaignBooking.create({
        data: { clientId, name: "Labels", brand: "B", status: "partially_published", format: "post", totalPaise: 300_000, paidAt: new Date(), launchFrom: new Date(), launchTo: new Date() },
      });
      const mk = (status: string, i: number, permalink: string | null = null) =>
        prisma.campaignBookingItem.create({
          data: { bookingId: booking.id, rateCardId: `rc-${i}`, targetType: "creator_asset", targetId: `t-${i}`, platform: "instagram", format: "post", accountName: `Acct${i}`, pricePaise: 100_000, status, permalink },
        });
      await mk("posted_manual", 1, "https://www.instagram.com/p/live/");
      await mk("awaiting_creator", 2);
      await mk("refund_due", 3);
      vi.mocked(sendEmail).mockClear();
      await sendDeliveryEmail(booking.id, { force: true });
      const html = vi.mocked(sendEmail).mock.calls.map((c) => String((c[0] as { html?: string }).html ?? "")).join("\n");
      expect(html).toContain("Waiting for the creator");
      expect(html).toContain("Not posted — being returned");
      expect(html).not.toContain("Scheduled");
    });
  });

  // ── The workers never pick these up ───────────────────────────────────────────

  describe("auto-publish never touches a creator's post", () => {
    it("checkEligibility refuses a creator page even with publishing on, and the worker ignores awaiting_creator and refund_due", async () => {
      vi.stubEnv("CAMPAIGN_PUBLISH_ENABLED", "1");
      const e = await checkEligibility({ targetType: "creator_asset", targetId: "x", platform: "instagram", format: "post" }, { audioIntegration: false, media: [{ kind: "image" }] });
      expect(e).toMatchObject({ ok: false });
      expect((e as { reason: string }).reason).toMatch(/creator/i);

      const booking = await prisma.campaignBooking.create({ data: { clientId, name: "W", brand: "B", status: "approved", format: "post", launchFrom: new Date(), launchTo: new Date() } });
      const mk = (status: string, i: number) =>
        prisma.campaignBookingItem.create({
          data: { bookingId: booking.id, rateCardId: `rc-${i}`, targetType: "creator_asset", targetId: `t-${i}`, platform: "instagram", format: "post", accountName: `A${i}`, pricePaise: 1000, status, nextAttemptAt: new Date(Date.now() - 60_000) },
        });
      const items = [await mk("awaiting_creator", 1), await mk("refund_due", 2)];
      expect(await runPublishTick()).toBe(0);
      const after = await prisma.campaignBookingItem.findMany({ where: { id: { in: items.map((i) => i.id) } }, orderBy: { accountName: "asc" } });
      expect(after.map((i) => [i.status, i.attempts, i.lockedUntil])).toEqual([["awaiting_creator", 0, null], ["refund_due", 0, null]]);
    });
  });

  // ── With the switches off nothing changes for anyone ──────────────────────────

  describe("dark", () => {
    it("with no switch set, a creator page in the database changes nothing a client or staff can see", async () => {
      vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "");
      vi.stubEnv("CREATOR_ROUTE_ENABLED", "");
      const net = await seedNetwork();
      const catBefore = await catalogue();
      const gridBefore = (await request(app).get("/v1/admin/campaign-rate-cards").set("Authorization", `Bearer ${admin}`)).body;
      await seedPage({ creatorName: "Hidden Creator" });
      invalidateCatalogueCache();
      expect(await catalogue()).toEqual(catBefore);
      expect((await request(app).get("/v1/admin/campaign-rate-cards").set("Authorization", `Bearer ${admin}`)).body).toEqual(gridBefore);
      expect(JSON.stringify(await catalogue())).not.toContain("Hidden Creator");
      expect(creatorConfig.marketplaceEnabled()).toBe(false);
      expect(creatorConfig.marketplaceAvailable()).toBe(false);
      expect((await catalogue()).map((e) => e.targetId)).toEqual([net.asset.id]);
    });

    it("marketplaceEnabled is exactly '1', and marketplaceAvailable needs all FOUR: the portal's master switch, the marketplace, Route and Razorpay's keys", () => {
      for (const v of ["", "0", "true", "yes", "01", " 1"]) {
        vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", v);
        expect(creatorConfig.marketplaceEnabled(), v).toBe(false);
      }
      vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "1");
      expect(creatorConfig.marketplaceEnabled()).toBe(true);
      expect(creatorConfig.marketplaceAvailable()).toBe(true);
      // Each one missing fails closed, on its own (beforeEach put every one of them on).
      for (const [name, off] of [["CREATORS_ENABLED", ""], ["CREATORS_ENABLED", "0"], ["CREATORS_ENABLED", "true"], ["CREATORS_MARKETPLACE_ENABLED", ""], ["CREATOR_ROUTE_ENABLED", ""], ["RAZORPAY_KEY_ID", ""], ["RAZORPAY_KEY_SECRET", ""]] as const) {
        const was = process.env[name] as string;
        vi.stubEnv(name, off);
        expect(creatorConfig.marketplaceAvailable(), `${name}=${off}`).toBe(false);
        vi.stubEnv(name, was);
        expect(creatorConfig.marketplaceAvailable(), `${name} restored`).toBe(true);
      }
    });
  });
});
