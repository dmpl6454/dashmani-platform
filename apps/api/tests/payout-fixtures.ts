/**
 * Shared fixtures for the Phase 4 integration tests (payout-integration, payout-cron, payout-admin): a paid booking of creator
 * pages (and optionally network accounts) that goes through the REAL capture webhook, so the payout rows, the frozen terms and the
 * item statuses are what production writes, with the stateful fake of Razorpay (tests/fake-razorpay-route.ts) behind every call.
 *
 * The capture is delivered through the real webhook route (HMAC-signed); the money leg then runs for real: onCaptured plans the
 * payouts, kickPayoutsForPayment makes the held transfers in the fake, and `settlePayoutKicksForTests` waits for it.
 */
import crypto from "crypto";
import request from "supertest";
import { vi } from "vitest";
import { prisma } from "@dashmani/db";
import { todayIST } from "@dashmani/shared";
import app from "../src/app";
import { buildCreatorSnapshotFields } from "../src/services/creator/payout-ledger";
import { settlePayoutKicksForTests } from "../src/services/campaign/payment.service";
import { razorpayHttp } from "../src/services/campaign/razorpay";
import { executePlannedPayout } from "../src/services/creator/payout.service";
import { FakeRazorpay, is, type FakeCall } from "./fake-razorpay-route";
import { generateToken } from "./helpers";

export const WEBHOOK_SECRET = "whsec_p4_integration";
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** The environment of a booking that pays a creator through Razorpay, with every money switch ON. */
export function stubPayoutEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    RAZORPAY_KEY_ID: "rzp_test_key",
    RAZORPAY_KEY_SECRET: "rzp_test_secret",
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    CAMPAIGN_PAYMENT_MODE: "",
    CREATORS_ENABLED: "1",
    CREATORS_MARKETPLACE_ENABLED: "1",
    CREATOR_ROUTE_ENABLED: "1",
    CREATOR_PAYOUT_CRON_ENABLED: "",
    CREATOR_PAYOUT_HOLD_DAYS: "",
    CREATOR_OFFER_TTL_HOURS: "",
    CAMPAIGN_PUBLISH_ENABLED: "",
    CAMPAIGN_REFUND_SWEEP_ENABLED: "",
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

let seq = 0;

export interface StaffWorld {
  staffId: string;
  admin: string;
}

export async function mkStaff(): Promise<StaffWorld> {
  const n = ++seq;
  const staff = await prisma.user.create({ data: { name: `Staff ${n}`, email: `staff${n}@p4i.test`, passwordHash: "x", status: "ACTIVE" } });
  return { staffId: staff.id, admin: generateToken(staff.id, staff.email, ["Admin"]) };
}

export interface PageSpec {
  /** What the brand pays for this post. Default ₹2,500. */
  price?: number;
  /** The creator's share, in basis points. Default 4000 (40%). */
  shareBps?: number;
}

export interface BookingSpec {
  pages: PageSpec[];
  /** Network (our own) accounts in the same booking, by price. */
  network?: number[];
}

export interface WorldItem {
  id: string;
  kind: "creator" | "network";
  price: number;
  /** creator items only */
  payout: number;
  creatorId: string | null;
  accountId: string | null;
  assetId: string | null;
}

export interface World {
  n: number;
  clientId: string;
  booking: { id: string; name: string };
  orderId: string;
  payId: string;
  total: number;
  items: WorldItem[];
  creators: WorldItem[];
  networkItems: WorldItem[];
}

/**
 * A booking, in `awaiting_payment` with its checkout frozen exactly as checkout() freezes it (the pricing snapshot carries each
 * creator item's frozen terms), its items, and its unpaid payment row. The creators, their pages and their ACTIVATED payout
 * accounts exist, and so does each linked account at the fake. Nothing is captured yet: see capture().
 */
export async function mkWorld(fake: FakeRazorpay, spec: BookingSpec): Promise<World> {
  const n = ++seq;
  const client = await prisma.client.create({ data: { companyName: `Brand ${n}`, contactName: "Asha", email: `brand${n}@p4i.test`, passwordHash: "x" } });
  const from = new Date(`${todayIST()}T00:00:00.000Z`);
  const to = new Date(from.getTime() + 7 * DAY);
  const booking = await prisma.campaignBooking.create({
    data: { clientId: client.id, name: `Campaign ${n}`, brand: "Acme Cola", status: "awaiting_payment", campaignType: "brand", format: "post", caption: "Sip", launchFrom: from, launchTo: to },
  });

  const items: WorldItem[] = [];
  const snapshotItems: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const [i, p] of spec.pages.entries()) {
    const price = p.price ?? 250_000;
    const shareBps = p.shareBps ?? 4000;
    const m = `${n}x${i}`;
    const creator = await prisma.creator.create({ data: { email: `creator${m}@p4i.test`, passwordHash: "x", name: `Creator ${m}`, country: "IN", status: "approved", emailVerifiedAt: new Date() } });
    const conn = await prisma.creatorConnection.create({ data: { creatorId: creator.id, metaUserId: `meta-${m}-${Date.now()}`, userTokenEnc: "enc", grantedScopes: "pages_show_list" } });
    const asset = await prisma.creatorAsset.create({
      data: { creatorId: creator.id, connectionId: conn.id, kind: "instagram_account", metaId: `1784${n}${String(i).padStart(3, "0")}`.padEnd(14, "0"), name: `Creator Page ${m}`, username: `creatorpage${n}x${i}`, canPublish: true, enabled: true, followerCount: 100_000 },
    });
    const acc = `acc_P4I${n}x${i}x`;
    const product = `acc_prd_P4I${n}x${i}x`;
    const account = await prisma.creatorPayoutAccount.create({
      data: {
        creatorId: creator.id,
        razorpayAccountId: acc,
        razorpayProductId: product,
        setupStep: "done",
        activationStatus: "activated",
        activatedAt: new Date(Date.now() - 3 * DAY),
        bookableAfter: new Date(Date.now() - 2 * DAY),
        destinationHint: "HDFC ••••1234",
      },
    });
    fake.seedAccount({ id: acc, email: `creator${m}@p4i.test`, productId: product, status: "activated" });
    const item = await prisma.campaignBookingItem.create({
      data: { bookingId: booking.id, rateCardId: crypto.randomUUID(), targetType: "creator_asset", targetId: asset.id, platform: "instagram", format: "post", accountName: asset.name, accountHandle: asset.username, pricePaise: price, status: "pending" },
    });
    const frozen = buildCreatorSnapshotFields({
      creatorId: creator.id,
      creatorName: creator.name,
      payoutAccountId: account.id,
      razorpayAccountId: acc,
      shareBps,
      tdsBps: 0,
      itemPricePaise: price,
      assetName: asset.name,
      handle: asset.username,
    });
    snapshotItems.push({ itemId: item.id, rateCardId: item.rateCardId, platform: "instagram", format: "post", accountName: asset.name, basePaise: price, audioAddonPaise: 0, pricePaise: price, ...frozen });
    items.push({ id: item.id, kind: "creator", price, payout: frozen.amountPaise, creatorId: creator.id, accountId: account.id, assetId: asset.id });
    total += price;
  }
  for (const [i, price] of (spec.network ?? []).entries()) {
    const item = await prisma.campaignBookingItem.create({
      data: { bookingId: booking.id, rateCardId: crypto.randomUUID(), targetType: "meta_asset", targetId: crypto.randomUUID(), platform: "instagram", format: "post", accountName: `Network Page ${n}x${i}`, pricePaise: price, status: "pending" },
    });
    snapshotItems.push({ itemId: item.id, rateCardId: item.rateCardId, platform: "instagram", format: "post", accountName: item.accountName, basePaise: price, audioAddonPaise: 0, pricePaise: price });
    items.push({ id: item.id, kind: "network", price, payout: 0, creatorId: null, accountId: null, assetId: null });
    total += price;
  }
  await prisma.campaignBooking.update({
    where: { id: booking.id },
    data: { totalPaise: total, pricingSnapshot: { campaignType: "brand", audioIntegration: false, audioTrack: null, items: snapshotItems } as never },
  });
  const orderId = `order_P4I${n}x`;
  await prisma.campaignPayment.create({ data: { bookingId: booking.id, razorpayOrderId: orderId, amountPaise: total } });
  return {
    n,
    clientId: client.id,
    booking: { id: booking.id, name: booking.name },
    orderId,
    payId: `pay_P4I${n}x`,
    total,
    items,
    creators: items.filter((i) => i.kind === "creator"),
    networkItems: items.filter((i) => i.kind === "network"),
  };
}

/** Deliver an HMAC-signed Razorpay webhook through the real route. */
export function sendWebhook(event: string, payload: Record<string, unknown>, eventId = crypto.randomUUID()) {
  const raw = JSON.stringify({ event, payload });
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return request(app).post("/v1/webhooks/razorpay").set("Content-Type", "application/json").set("x-razorpay-signature", sig).set("x-razorpay-event-id", eventId).send(raw);
}

/**
 * The brand's payment is captured: the payment exists at the fake, and the capture webhook lands through the real route. By the time
 * this returns the kick has finished too (set `settle: false` to look at the moment right after the webhook answered).
 */
export async function capture(fake: FakeRazorpay, w: World, o: { settle?: boolean; event?: "payment.captured" | "order.paid" } = {}) {
  if (!fake.payments.has(w.payId)) fake.seedPayment({ id: w.payId, amount: w.total });
  const res = await sendWebhook(o.event ?? "payment.captured", { payment: { entity: { id: w.payId, order_id: w.orderId, amount: w.total, currency: "INR" } } });
  if (o.settle !== false) await settlePayoutKicksForTests();
  return res;
}

export const payoutOf = (itemId: string) => prisma.creatorPayout.findUniqueOrThrow({ where: { bookingItemId: itemId } });
export const itemOf = (itemId: string) => prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } });
export const bookingOf = (id: string) => prisma.campaignBooking.findUniqueOrThrow({ where: { id } });
export const paymentOf = (bookingId: string) => prisma.campaignPayment.findFirstOrThrow({ where: { bookingId } });
export const offerOf = (itemId: string) => prisma.creatorOffer.findUniqueOrThrow({ where: { bookingItemId: itemId } });

/** The refunds Razorpay really made on this world's payment (the fake's side of it). */
export const fakeRefunds = (fake: FakeRazorpay, w: World) => fake.payments.get(w.payId)?.refunds ?? [];

/** A short name for every call, in order: what the order of money moves looks like. */
export function callLog(fake: FakeRazorpay): string[] {
  return fake.calls.map((c) => nameOf(c));
}
export function nameOf(c: FakeCall): string {
  if (is.createTransfer(c)) return "transfer.create";
  if (is.listTransfers(c)) return "transfer.list";
  if (is.fetchTransfer(c)) return "transfer.fetch";
  if (is.setHold(c, true)) return "hold.on";
  if (is.setHold(c, false)) return "hold.off";
  if (is.createReversal(c)) return "reversal.create";
  if (is.listReversals(c)) return "reversal.list";
  if (is.refund(c)) return "refund.create";
  if (is.listDisputes(c)) return "disputes.list";
  if (is.fetchProduct(c)) return "product.fetch";
  if (is.fetchPayment(c)) return "payment.fetch";
  return `${c.method} ${c.path}`;
}
/** The index of the first call with this name (-1 when none): the order of two moves is a comparison of two indexes. */
export const firstIndex = (log: string[], name: string) => log.indexOf(name);
export const countOf = (log: string[], name: string) => log.filter((x) => x === name).length;

/** Put a creator item's offer where it would be after the creator accepted, sent a link, and staff verified it (the release gate's offer facts). */
export async function verifiedOffer(w: World, itemId: string, o: { ownership?: string; verifiedAt?: Date } = {}) {
  const item = w.items.find((i) => i.id === itemId)!;
  await prisma.creatorOffer.create({
    data: {
      bookingId: w.booking.id,
      bookingItemId: itemId,
      creatorId: item.creatorId!,
      creatorAssetId: item.assetId!,
      pageName: "Creator Page",
      platform: "instagram",
      format: "post",
      status: "completed",
      payoutPaise: item.payout,
      expiresAt: new Date(Date.now() + DAY),
      acceptedAt: new Date(Date.now() - 2 * HOUR),
      linkUrl: `https://www.instagram.com/p/POST${itemId.slice(0, 8)}/`,
      linkCanonicalKey: `ig:POST${itemId.slice(0, 8)}`,
      linkSubmittedAt: new Date(Date.now() - HOUR),
      linkVerifiedAt: o.verifiedAt ?? new Date(Date.now() - 30 * MIN),
      ownershipCheck: o.ownership ?? "auto_ok",
      windowFrom: new Date(`${todayIST()}T00:00:00.000Z`),
      windowTo: new Date(new Date(`${todayIST()}T00:00:00.000Z`).getTime() + 7 * DAY),
    },
  });
  await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { status: "posted_manual", permalink: "https://www.instagram.com/p/x/", postedAt: new Date() } });
  await prisma.campaignBooking.update({ where: { id: w.booking.id }, data: { status: "approved" } });
}

/** An OPEN offer on a creator item (the item waits for / has the creator): offered or accepted, the link not yet sent. */
export async function openOffer(w: World, itemId: string, o: { status?: "offered" | "accepted"; expiresAt?: Date; windowTo?: Date; linkSubmitted?: boolean } = {}) {
  const item = w.items.find((i) => i.id === itemId)!;
  const status = o.status ?? "offered";
  const from = new Date(`${todayIST()}T00:00:00.000Z`);
  const offer = await prisma.creatorOffer.create({
    data: {
      bookingId: w.booking.id,
      bookingItemId: itemId,
      creatorId: item.creatorId!,
      creatorAssetId: item.assetId!,
      pageName: "Creator Page",
      platform: "instagram",
      format: "post",
      status,
      payoutPaise: item.payout,
      expiresAt: o.expiresAt ?? new Date(Date.now() + 2 * DAY),
      offeredAt: new Date(Date.now() - HOUR),
      notifiedAt: new Date(Date.now() - HOUR),
      acceptedAt: status === "accepted" ? new Date() : null,
      windowFrom: from,
      windowTo: o.windowTo ?? new Date(from.getTime() + 7 * DAY),
      ...(o.linkSubmitted ? { linkUrl: "https://www.instagram.com/p/ABC123/", linkCanonicalKey: "ig:ABC123", linkSubmittedAt: new Date(), ownershipCheck: "unverifiable" } : {}),
    },
  });
  await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { status: status === "offered" ? "awaiting_creator" : "manual_pending" } });
  // paidAt stays what the capture webhook wrote: it is the one signal for "paid online", and nothing in the money leg may touch it.
  await prisma.campaignBooking.update({ where: { id: w.booking.id }, data: { status: "approved" } });
  return offer;
}

// ── For the older Phase 3 test files, which keep their own small Razorpay stub (orders and refunds) ──────────

/**
 * Send everything about transfers, disputes and linked accounts to the stateful fake, and the rest (orders, refunds, the refund
 * list) to the file's own stub. Returns the function to assign to razorpayHttp.fetch.
 */
export function routeTransfersToFake(fake: FakeRazorpay, own: (url: any, init: any) => Promise<Response>): typeof fetch {
  fake.install();
  const viaFake = razorpayHttp.fetch;
  return (async (url: any, init: any) => (/\/v1\/(transfers|disputes)|\/payments\/[^/?]+\/transfers|\/v2\/accounts/.test(String(url)) ? viaFake(url, init) : own(url, init))) as typeof fetch;
}

/**
 * What the transfer leg leaves behind once it has done its job: every `planned` payout of the booking made into a HELD transfer at the
 * fake (the real engine step, so a later reversal reads a real transfer). The older files switch the payout worker off
 * (CREATOR_PAYOUT_CRON_ENABLED=0) so a capture leaves `planned` rows exactly as their assertions expect, and call this where a test
 * needs the money set aside (an approved booking: a post is only offered once its payout is held).
 */
export async function holdPayoutsOf(fake: FakeRazorpay, bookingId: string): Promise<void> {
  const payments = await prisma.campaignPayment.findMany({ where: { bookingId, razorpayPaymentId: { not: null } } });
  for (const pay of payments) if (!fake.payments.has(pay.razorpayPaymentId!)) fake.seedPayment({ id: pay.razorpayPaymentId!, amount: pay.amountPaise });
  const planned = await prisma.creatorPayout.findMany({ where: { bookingId, status: "planned" }, orderBy: { createdAt: "asc" } });
  for (const p of planned) await executePlannedPayout(p.id);
}
