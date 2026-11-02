/**
 * Client campaign bookings in the sales portal: listed by stage with their billing state,
 * shown on the dashboard, and invoiced only when they were bought and only for posts made.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const item = (n: number, status: string, pricePaise: number, extra: Record<string, unknown> = {}) => ({
  rateCardId: `rc-${n}`, targetType: "meta_asset", targetId: `asset-${n}`, platform: "instagram", format: "reel",
  accountName: `Account ${n}`, accountHandle: `acct${n}`, pricePaise, status, ...extra,
});

describe("Sales: campaign bookings", () => {
  let token: string;
  let clientId: string;

  beforeEach(async () => {
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ roleNames: ["Sales"] });
    token = generateToken(u.id, u.email, ["Sales"]);
    const c = await prisma.client.create({ data: { companyName: "Filmy Co", contactName: "X", email: "filmy@c.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName: "Filmy Co Pvt Ltd", gstin: "27AABCU9603R1ZX", stateCode: "27" } });
    clientId = c.id;
  });

  const booking = (name: string, status: string, items: ReturnType<typeof item>[], extra: Record<string, unknown> = {}) =>
    prisma.campaignBooking.create({ data: { clientId, name, brand: "Filmy", status, totalPaise: items.reduce((s, i) => s + i.pricePaise, 0), submittedAt: new Date(), items: { create: items }, ...extra } });

  it("lists bookings by stage with what is billable, and hides client drafts", async () => {
    const live = await booking("Live one", "completed", [item(1, "posted_manual", 100_000, { permalink: "https://instagram.com/reel/abc" }), item(2, "failed", 50_000)]);
    await booking("In review", "paid_pending_review", [item(3, "pending", 70_000)]);
    await booking("Cart", "draft", [item(4, "pending", 10_000)]);
    await booking("Gone", "refunded", [item(5, "refunded", 20_000)]);

    const all = await request(app).get("/v1/sales/bookings").set(auth(token));
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.data.map((b: { name: string }) => b.name).sort()).toEqual(["Gone", "In review", "Live one"]);
    const row = all.body.data.find((b: { name: string }) => b.name === "Live one");
    // The failed post is not billed; one of two accounts is live.
    expect(row).toMatchObject({ statusLabel: "Live", itemCount: 2, liveCount: 1, billablePaise: 100_000, billable: true, invoiced: false, client: { companyName: "Filmy Co" } });

    const review = await request(app).get("/v1/sales/bookings?stage=review").set(auth(token));
    expect(review.body.data.map((b: { name: string }) => b.name)).toEqual(["In review"]);
    const toInvoice = await request(app).get("/v1/sales/bookings?stage=to_invoice").set(auth(token));
    expect(toInvoice.body.data.map((b: { name: string }) => b.name).sort()).toEqual(["In review", "Live one"]);

    const detail = await request(app).get(`/v1/sales/bookings/${live.id}`).set(auth(token));
    expect(detail.body.data.items.map((i: { live: boolean; billed: boolean }) => [i.live, i.billed])).toEqual([[true, true], [false, false]]);

    const dash = await request(app).get("/v1/sales/dashboard").set(auth(token));
    expect(dash.body.data.bookings).toMatchObject({ review: { count: 1, totalPaise: 70_000 }, live: { count: 1 }, toInvoice: { count: 2, totalPaise: 170_000 } });
  });

  it("invoices only posts that were made, never twice, and never an unpaid or refunded booking", async () => {
    const live = await booking("Live one", "partially_published", [item(1, "published", 100_000), item(2, "failed", 50_000), item(3, "refunded", 30_000)]);
    const res = await request(app).post(`/v1/sales/invoices/from-booking/${live.id}?company=dmpl`).set(auth(token));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ companyKey: "dmpl", campaignBookingId: live.id, subtotalPaise: 100_000 });
    expect(res.body.data.items).toHaveLength(1);

    // Now on an invoice: it leaves "to invoice" and a second invoice is refused.
    const after = await request(app).get(`/v1/sales/bookings?stage=to_invoice`).set(auth(token));
    expect(after.body.data).toHaveLength(0);
    const listed = await request(app).get(`/v1/sales/bookings/${live.id}`).set(auth(token));
    expect(listed.body.data.invoices).toEqual([expect.objectContaining({ companyKey: "dmpl", status: "draft" })]);
    expect((await request(app).post(`/v1/sales/invoices/from-booking/${live.id}`).set(auth(token))).status).toBe(409);

    const unpaid = await booking("Unpaid", "awaiting_payment", [item(4, "pending", 10_000)]);
    const r1 = await request(app).post(`/v1/sales/invoices/from-booking/${unpaid.id}`).set(auth(token));
    expect(r1.status).toBe(409);
    expect(r1.body.error?.code ?? r1.body.code).toBe("BOOKING_NOT_BILLABLE");
    const allFailed = await booking("All failed", "partially_published", [item(5, "failed", 10_000)]);
    const r2 = await request(app).post(`/v1/sales/invoices/from-booking/${allFailed.id}`).set(auth(token));
    expect(r2.status).toBe(409);
    expect(r2.body.error?.code ?? r2.body.code).toBe("BOOKING_EMPTY");
  });

  it("shows the booking's creative and caption, with signed preview links for sales", async () => {
    const b = await booking("Content", "approved", [item(1, "approved", 50_000), item(2, "approved", 40_000, { captionOverride: "Own words", hashtagsOverride: ["mine"] })], {
      caption: "Watch the trailer", hashtags: ["filmy", "trailer"], userTags: ["filmyco"], collaborators: ["star"], superText: "OUT NOW", superTextStyle: "bold",
    });
    const media = await prisma.campaignMedia.create({
      data: { clientId, bookingId: b.id, kind: "video", originalName: "trailer.mp4", bytes: BigInt(1000), durationMs: 15_000, width: 1080, height: 1920,
        storageKey: `k-${b.id}`, ext: "mp4", uploadStatus: "complete", chunkSize: 1000, totalChunks: 1, renderStatus: "done" },
    });
    await prisma.campaignMedia.create({
      data: { clientId, bookingId: b.id, kind: "image", originalName: "gone.jpg", bytes: BigInt(10), storageKey: `g-${b.id}`, ext: "jpg", uploadStatus: "complete", chunkSize: 10, totalChunks: 1, purgedAt: new Date() },
    });

    const res = await request(app).get(`/v1/sales/bookings/${b.id}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ caption: "Watch the trailer", hashtags: ["filmy", "trailer"], userTags: ["filmyco"], collaborators: ["star"], superText: "OUT NOW", superTextStyle: "bold" });
    expect(res.body.data.media).toEqual([expect.objectContaining({ id: media.id, kind: "video", role: "creative", durationMs: 15_000, width: 1080, height: 1920 })]);
    const own = res.body.data.items.find((i: { accountName: string }) => i.accountName === "Account 2");
    expect(own).toMatchObject({ captionOverride: "Own words", hashtagsOverride: ["mine"], superTextOverride: null });

    const urls = await request(app).get(`/v1/sales/bookings/${b.id}/media-urls`).set(auth(token));
    expect(urls.status).toBe(200);
    expect(urls.body.data.media).toHaveLength(1); // the purged file is not offered
    expect(urls.body.data.media[0].preview).toMatch(new RegExp(`^/v1/campaign-media/${media.id}/preview\\?exp=\\d+&sig=`));

    expect((await request(app).get("/v1/sales/bookings/00000000-0000-0000-0000-000000000000/media-urls").set(auth(token))).status).toBe(404);
    const other = await createTestUser({ roleNames: [] });
    expect((await request(app).get(`/v1/sales/bookings/${b.id}/media-urls`).set(auth(generateToken(other.id, other.email, [])))).status).toBe(403);
  });

  it("lets sales review a booking: approve, ask for changes, reject — same rules as the staff portal", async () => {
    const a = await booking("Approve me", "paid_pending_review", [item(1, "pending", 50_000), item(2, "pending", 40_000)]);
    const approved = await request(app).post(`/v1/sales/bookings/${a.id}/approve`).set(auth(token));
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ id: a.id, status: "approved" });
    // Same side effects as the staff route: nothing stays pending (auto-publish is off in tests).
    expect((await prisma.campaignBookingItem.findMany({ where: { bookingId: a.id } })).map((i) => i.status)).toEqual(["manual_pending", "manual_pending"]);
    const events = await prisma.campaignBookingEvent.findMany({ where: { bookingId: a.id, toStatus: "approved" } });
    expect(events).toHaveLength(1);
    // Approving again is a state-machine conflict, never a second approval.
    expect((await request(app).post(`/v1/sales/bookings/${a.id}/approve`).set(auth(token))).status).toBe(409);

    const c = await booking("Change me", "paid_pending_review", [item(3, "pending", 30_000)]);
    expect((await request(app).post(`/v1/sales/bookings/${c.id}/request-changes`).set(auth(token)).send({})).status).toBe(400);
    const changed = await request(app).post(`/v1/sales/bookings/${c.id}/request-changes`).set(auth(token)).send({ note: "Please use the 9:16 cut" });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ status: "changes_requested", reviewNote: "Please use the 9:16 cut" });

    // Reject works from changes_requested too; an offline booking has nothing to refund.
    const rejected = await request(app).post(`/v1/sales/bookings/${c.id}/reject`).set(auth(token)).send({ note: "Brand not a fit" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({ status: "rejected", refundError: null });
    expect((await prisma.campaignBookingItem.findMany({ where: { bookingId: c.id } })).map((i) => i.status)).toEqual(["refunded"]);
    expect((await request(app).post(`/v1/sales/bookings/${c.id}/reject`).set(auth(token)).send({ note: "again" })).status).toBe(409);
  });

  it("booking review needs sales:manage and refuses non-staff tokens", async () => {
    const b = await booking("Guarded", "paid_pending_review", [item(1, "pending", 50_000)]);
    await createTestRole("Viewer", [{ resource: "sales", action: "view", scope: "global" }]);
    const viewer = await createTestUser({ roleNames: ["Viewer"] });
    expect((await request(app).post(`/v1/sales/bookings/${b.id}/approve`).set(auth(generateToken(viewer.id, viewer.email, ["Viewer"])))).status).toBe(403);
    const plain = await createTestUser({ roleNames: [] });
    expect((await request(app).post(`/v1/sales/bookings/${b.id}/approve`).set(auth(generateToken(plain.id, plain.email, [])))).status).toBe(403);
    const clientToken = jwt.sign({ userId: clientId, email: "filmy@c.test", roles: [], type: "client" }, process.env.JWT_SECRET || "dev-secret", { expiresIn: "15m" });
    expect((await request(app).post(`/v1/sales/bookings/${b.id}/approve`).set(auth(clientToken))).status).toBe(403);
    expect((await prisma.campaignBooking.findUnique({ where: { id: b.id } }))?.status).toBe("paid_pending_review");
  });

  it("is a 404 for an unknown booking and needs sales access", async () => {
    expect((await request(app).get("/v1/sales/bookings/00000000-0000-0000-0000-000000000000").set(auth(token))).status).toBe(404);
    const other = await createTestUser({ roleNames: [] });
    expect((await request(app).get("/v1/sales/bookings").set(auth(generateToken(other.id, other.email, [])))).status).toBe(403);
  });
});
