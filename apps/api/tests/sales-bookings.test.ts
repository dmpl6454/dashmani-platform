/**
 * Client campaign bookings in the sales portal: listed by stage with their billing state,
 * shown on the dashboard, and invoiced only when they were bought and only for posts made.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
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

  it("is a 404 for an unknown booking and needs sales access", async () => {
    expect((await request(app).get("/v1/sales/bookings/00000000-0000-0000-0000-000000000000").set(auth(token))).status).toBe(404);
    const other = await createTestUser({ roleNames: [] });
    expect((await request(app).get("/v1/sales/bookings").set(auth(generateToken(other.id, other.email, [])))).status).toBe(403);
  });
});
