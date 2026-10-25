/**
 * sales.digitalsukoon.com: GST arithmetic, per-financial-year numbering, the quote → order →
 * invoice → payment lifecycle, credit notes, derived statuses, and the `sales` permission gate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { computeTotals, documentNumber, financialYear, numberInWords, rupeesInWords, taxModeFor, todayIST } from "@dashmani/shared";
import { invalidateInventoryCache } from "../src/services/sales/inventory.service";

const SELLER = {
  legalName: "Dashmani Media Private Limited", gstin: "27AAACD1234E1Z5", pan: "AAACD1234E", addressLine1: "Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", bankName: "HDFC Bank", accountName: "Dashmani Media Pvt Ltd", accountNumber: "50100123456789",
  ifsc: "HDFC0000123", invoicePrefix: "DS", defaultDueDays: 15, roundToRupee: true, terms: "Payable within 15 days.",
};

let salesToken: string;
let employeeToken: string;
let salesUserId: string;
let clientMh: string; // Maharashtra, GST-registered
let clientKa: string; // Karnataka
let fy: ReturnType<typeof financialYear>;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function seedWorld() {
  // system_settings is not in the suite's TRUNCATE list: clear the seller profile ourselves so a
  // test that saved it cannot make a later test's "profile incomplete" check pass by accident.
  await prisma.systemSetting.deleteMany({ where: { key: "sales.seller" } });
  await createTestRole("Sales", [
    ...["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })),
    { resource: "clients", action: "view", scope: "global" },
  ]);
  await createTestRole("Employee", [{ resource: "attendance", action: "view", scope: "own" }]);
  const sales = await createTestUser({ name: "Sales Person", roleNames: ["Sales"] });
  const emp = await createTestUser({ name: "Plain Employee", roleNames: ["Employee"] });
  salesUserId = sales.id;
  salesToken = generateToken(sales.id, sales.email, ["Sales"]);
  employeeToken = generateToken(emp.id, emp.email, ["Employee"]);
  const mh = await prisma.client.create({ data: { companyName: "Filmy Brands", contactName: "Riya", email: "riya@filmybrands.test", passwordHash: "x" } });
  await prisma.clientBillingProfile.create({ data: { clientId: mh.id, legalName: "Filmy Brands Private Limited", gstin: "27AABCU9603R1ZX", stateCode: "27", state: "Maharashtra", city: "Mumbai", addressLine1: "Bandra", pincode: "400050" } });
  const ka = await prisma.client.create({ data: { companyName: "Bengaluru Apps", contactName: "Arjun", email: "arjun@blrapps.test", passwordHash: "x" } });
  await prisma.clientBillingProfile.create({ data: { clientId: ka.id, legalName: "Bengaluru Apps LLP", gstin: "29AAACB1234F1Z9", stateCode: "29", state: "Karnataka", city: "Bengaluru" } });
  clientMh = mh.id;
  clientKa = ka.id;
  fy = financialYear(todayIST());
  invalidateInventoryCache();
}

const quoteBody = (clientId: string, extra: Record<string, unknown> = {}) => ({
  clientId,
  title: "Diwali reels",
  campaignType: "brand",
  items: [
    { kind: "placement", platform: "instagram", format: "reel", description: "Bollywood Society · Instagram Reel", accountName: "Bollywood Society", quantity: 2, unitPricePaise: 5_000_000 },
    { kind: "custom", description: "Story mention", quantity: 1, unitPricePaise: 1_234_560, discountPaise: 34_560 },
  ],
  ...extra,
});

describe("GST arithmetic and numbering (pure)", () => {
  it("knows the Indian financial year", () => {
    expect(financialYear("2026-10-26")).toMatchObject({ label: "2026-27", short: "26-27", startDay: "2026-04-01", endDay: "2027-03-31" });
    expect(financialYear("2026-03-31").label).toBe("2025-26");
    expect(financialYear("2026-04-01").label).toBe("2026-27");
  });

  it("formats document numbers per financial year without truncating big serials", () => {
    expect(documentNumber("DS", "2026-27", 7)).toBe("DS/26-27/0007");
    expect(documentNumber("DS", "2026-27", 12345)).toBe("DS/26-27/12345");
  });

  it("picks CGST+SGST in-state, IGST across states, none abroad", () => {
    expect(taxModeFor("27", "27")).toBe("intra");
    expect(taxModeFor("27", "29")).toBe("inter");
    expect(taxModeFor("27", null)).toBe("inter");
    expect(taxModeFor("27", "27", "US")).toBe("none");
  });

  it("computes totals exactly and rounds the payable amount to the rupee", () => {
    const lines = [{ quantity: 2, unitPricePaise: 50_000 }, { quantity: 1, unitPricePaise: 123_456, discountPaise: 3_456 }];
    const intra = computeTotals({ lines, discountPaise: 20_000, taxMode: "intra", gstRateBp: 1800 });
    expect(intra).toMatchObject({ subtotalPaise: 220_000, discountPaise: 20_000, taxablePaise: 200_000, cgstPaise: 18_000, sgstPaise: 18_000, igstPaise: 0, totalPaise: 236_000, roundOffPaise: 0 });
    const inter = computeTotals({ lines, discountPaise: 20_000, taxMode: "inter", gstRateBp: 1800 });
    expect(inter).toMatchObject({ igstPaise: 36_000, cgstPaise: 0, totalPaise: 236_000 });
    expect(computeTotals({ lines, taxMode: "none", gstRateBp: 1800 }).totalPaise).toBe(220_000);
    const odd = computeTotals({ lines: [{ quantity: 1, unitPricePaise: 100_001 }], taxMode: "intra", gstRateBp: 1800 });
    expect(odd).toMatchObject({ cgstPaise: 9_000, sgstPaise: 9_000, totalPaise: 118_000, roundOffPaise: -1 });
    expect(computeTotals({ lines: [{ quantity: 1, unitPricePaise: 100_001 }], taxMode: "intra", gstRateBp: 1800, roundToRupee: false }).totalPaise).toBe(118_001);
  });

  it("writes amounts in words the Indian way", () => {
    expect(numberInWords(10_000_000)).toBe("One Crore");
    expect(numberInWords(1_234_567)).toBe("Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven");
    expect(rupeesInWords(12_345_678)).toBe("Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Paise Seventy Eight Only");
    expect(rupeesInWords(0)).toBe("Rupees Zero Only");
    expect(rupeesInWords(100)).toBe("Rupees One Only");
  });
});

describe("sales API", () => {
  beforeEach(seedWorld);

  it("gates every route on the sales permission", async () => {
    expect((await request(app).get("/v1/sales/dashboard")).status).toBe(401);
    expect((await request(app).get("/v1/sales/dashboard").set(auth(employeeToken))).status).toBe(403);
    expect((await request(app).get("/v1/sales/dashboard").set(auth(salesToken))).status).toBe(200);
    expect((await request(app).get("/v1/sales/inventory").set(auth(employeeToken))).status).toBe(403);
  });

  it("stores the seller profile and reports what a tax invoice still needs", async () => {
    const before = await request(app).get("/v1/sales/settings/seller").set(auth(salesToken));
    expect(before.body.data.saved).toBe(false);
    expect(before.body.data.missing).toContain("gstin");
    const bad = await request(app).put("/v1/sales/settings/seller").set(auth(salesToken)).send({ ...SELLER, gstin: "nope" });
    expect(bad.status).toBe(400);
    const saved = await request(app).put("/v1/sales/settings/seller").set(auth(salesToken)).send(SELLER);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ saved: true, missing: [] });
    expect(saved.body.data.profile.gstin).toBe("27AAACD1234E1Z5");
  });

  it("lists every active channel as inventory, priced or not", async () => {
    const platform = await prisma.platform.create({ data: { name: "Snapchat", slug: "snapchat" } });
    await prisma.socialAccount.create({ data: { handle: "bollywoodsociety", displayName: "Bollywood Society", platformId: platform.id, followerCount: 147_300, status: "ACTIVE" } });
    invalidateInventoryCache();
    const res = await request(app).get("/v1/sales/inventory").set(auth(salesToken));
    expect(res.status).toBe(200);
    const row = res.body.data.find((c: { handle: string }) => c.handle === "bollywoodsociety");
    expect(row).toMatchObject({ platform: "snapchat", followers: 147_300, bookable: false, offers: [] });
  });

  it("creates clients without a usable login and keeps billing profiles", async () => {
    const dup = await request(app).post("/v1/sales/clients").set(auth(salesToken)).send({ companyName: "Dup", contactName: "Someone", email: "RIYA@filmybrands.test" });
    expect(dup.status).toBe(409);
    const res = await request(app).post("/v1/sales/clients").set(auth(salesToken)).send({ companyName: "New Brand", contactName: "Neha", email: "neha@newbrand.test", phone: "9999999999" });
    expect(res.status).toBe(201);
    const id = res.body.data.id;
    const billing = await request(app).put(`/v1/sales/clients/${id}/billing`).set(auth(salesToken)).send({ legalName: "New Brand Pvt Ltd", gstin: "07AABCN1234G1Z2", stateCode: "07", country: "in" });
    expect(billing.status).toBe(200);
    expect(billing.body.data).toMatchObject({ legalName: "New Brand Pvt Ltd", stateCode: "07", country: "IN" });
    const stmt = await request(app).get(`/v1/sales/clients/${id}/statement`).set(auth(salesToken));
    expect(stmt.body.data.totals).toMatchObject({ invoicedPaise: 0, outstandingPaise: 0 });
    const listed = await request(app).get("/v1/sales/clients?q=new brand").set(auth(salesToken));
    expect(listed.body.data.map((c: { id: string }) => c.id)).toEqual([id]);
  });

  it("runs a quote through send → accept → convert into a confirmed order with the same totals", async () => {
    const created = await request(app).post("/v1/sales/quotes").set(auth(salesToken)).send(quoteBody(clientMh, { validUntil: "2030-01-01" }));
    expect(created.status).toBe(201);
    const q = created.body.data;
    expect(q.number).toBe(documentNumber("Q", fy.label, 1));
    expect(q).toMatchObject({ status: "draft", taxMode: "intra", placeOfSupplyCode: "27", gstRateBp: 1800, subtotalPaise: 11_200_000, taxablePaise: 11_200_000, cgstPaise: 1_008_000, sgstPaise: 1_008_000, totalPaise: 13_216_000 });
    expect(q.items).toHaveLength(2);
    expect(q.items[1].sac).toBe("998365");

    const second = await request(app).post("/v1/sales/quotes").set(auth(salesToken)).send(quoteBody(clientKa));
    expect(second.body.data.number).toBe(documentNumber("Q", fy.label, 2));
    expect(second.body.data).toMatchObject({ taxMode: "inter", igstPaise: 2_016_000, cgstPaise: 0 });

    expect((await request(app).post(`/v1/sales/quotes/${q.id}/send`).set(auth(salesToken))).body.data.status).toBe("sent");
    expect((await request(app).post(`/v1/sales/quotes/${q.id}/accept`).set(auth(salesToken))).body.data.status).toBe("accepted");
    const conv = await request(app).post(`/v1/sales/quotes/${q.id}/convert`).set(auth(salesToken));
    expect(conv.status).toBe(201);
    const order = conv.body.data;
    expect(order).toMatchObject({ number: documentNumber("SO", fy.label, 1), status: "confirmed", quoteId: q.id, totalPaise: 13_216_000 });
    expect(order.items).toHaveLength(2);
    expect((await request(app).get(`/v1/sales/quotes/${q.id}`).set(auth(salesToken))).body.data).toMatchObject({ status: "converted", convertedOrderId: order.id });
    expect((await request(app).put(`/v1/sales/quotes/${q.id}`).set(auth(salesToken)).send(quoteBody(clientMh))).status).toBe(409);
    expect((await request(app).post(`/v1/sales/quotes/${q.id}/convert`).set(auth(salesToken))).body.data.id).toBe(order.id);
  });

  it("issues GST invoices with consecutive numbers, snapshots and settlement through payments and credit notes", async () => {
    const order = (await request(app).post("/v1/sales/orders").set(auth(salesToken)).send(quoteBody(clientMh, { poNumber: "PO-77" }))).body.data;
    expect(order.status).toBe("draft");
    expect((await request(app).post(`/v1/sales/orders/${order.id}/invoice`).set(auth(salesToken))).status).toBe(409); // drafts are not billable
    await request(app).post(`/v1/sales/orders/${order.id}/confirm`).set(auth(salesToken));
    const draft = (await request(app).post(`/v1/sales/orders/${order.id}/invoice`).set(auth(salesToken))).body.data;
    expect(draft).toMatchObject({ status: "draft", number: null, orderId: order.id, totalPaise: 13_216_000, derivedStatus: "draft" });

    // Issuing needs the company GST profile.
    const blocked = await request(app).post(`/v1/sales/invoices/${draft.id}/issue`).set(auth(salesToken)).send({});
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("SELLER_PROFILE_INCOMPLETE");
    await request(app).put("/v1/sales/settings/seller").set(auth(salesToken)).send(SELLER);

    const issued = (await request(app).post(`/v1/sales/invoices/${draft.id}/issue`).set(auth(salesToken)).send({ issueDate: "2026-10-20" })).body.data;
    expect(issued).toMatchObject({ number: documentNumber("DS", financialYear("2026-10-20").label, 1), status: "issued", issueDate: "2026-10-20", dueDate: "2026-11-04", balancePaise: 13_216_000 });
    expect(issued.amountInWords).toBe("Rupees One Lakh Thirty Two Thousand One Hundred Sixty Only");
    expect(issued.sellerSnapshot.gstin).toBe("27AAACD1234E1Z5");
    expect(issued.buyerSnapshot).toMatchObject({ legalName: "Filmy Brands Private Limited", gstin: "27AABCU9603R1ZX" });
    expect((await request(app).post(`/v1/sales/invoices/${draft.id}/issue`).set(auth(salesToken)).send({})).status).toBe(409);
    expect((await request(app).put(`/v1/sales/invoices/${draft.id}`).set(auth(salesToken)).send({ clientId: clientMh, items: [{ description: "x", unitPricePaise: 1 }] })).status).toBe(409);

    const pdf = await request(app).get(`/v1/sales/invoices/${draft.id}/pdf`).set(auth(salesToken)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");

    // Part payment with TDS, then the rest.
    const over = await request(app).post("/v1/sales/payments").set(auth(salesToken)).send({ clientId: clientMh, amountPaise: 20_000_000, mode: "bank_transfer", paidOn: "2026-10-22", allocations: [{ invoiceId: draft.id, amountPaise: 20_000_000 }] });
    expect(over.status).toBe(409);
    const part = await request(app).post("/v1/sales/payments").set(auth(salesToken)).send({ clientId: clientMh, amountPaise: 5_000_000, tdsPaise: 264_320, mode: "upi", reference: "UTR123", paidOn: "2026-10-22", allocations: [{ invoiceId: draft.id, amountPaise: 5_000_000, tdsPaise: 264_320 }] });
    expect(part.status).toBe(201);
    expect(part.body.data.number).toBe(documentNumber("RCPT", financialYear("2026-10-22").label, 1));
    let inv = (await request(app).get(`/v1/sales/invoices/${draft.id}`).set(auth(salesToken))).body.data;
    expect(inv).toMatchObject({ status: "issued", derivedStatus: "partially_paid", paidPaise: 5_000_000, tdsPaise: 264_320, balancePaise: 7_951_680 });

    const cn = await request(app).post("/v1/sales/credit-notes").set(auth(salesToken)).send({ invoiceId: draft.id, reason: "One reel cancelled", taxablePaise: 1_000_000, issueDate: "2026-10-23" });
    expect(cn.status).toBe(201);
    expect(cn.body.data).toMatchObject({ number: documentNumber("CN", financialYear("2026-10-23").label, 1), taxablePaise: 1_000_000, cgstPaise: 90_000, sgstPaise: 90_000, totalPaise: 1_180_000 });
    inv = (await request(app).get(`/v1/sales/invoices/${draft.id}`).set(auth(salesToken))).body.data;
    expect(inv).toMatchObject({ creditedPaise: 1_180_000, balancePaise: 6_771_680, derivedStatus: "partially_paid" });

    const rest = await request(app).post("/v1/sales/payments").set(auth(salesToken)).send({ clientId: clientMh, amountPaise: 6_771_680, mode: "bank_transfer", paidOn: "2026-10-25", allocations: [{ invoiceId: draft.id, amountPaise: 6_771_680 }] });
    expect(rest.status).toBe(201);
    inv = (await request(app).get(`/v1/sales/invoices/${draft.id}`).set(auth(salesToken))).body.data;
    expect(inv).toMatchObject({ status: "paid", derivedStatus: "paid", balancePaise: 0 });
    expect(inv.paidAt).toBeTruthy();
    expect((await request(app).post(`/v1/sales/invoices/${draft.id}/cancel`).set(auth(salesToken)).send({ reason: "oops" })).status).toBe(409);

    // Cancelling an unpaid invoice keeps its serial; the next invoice takes the next one.
    const second = (await request(app).post("/v1/sales/invoices").set(auth(salesToken)).send({ clientId: clientKa, items: [{ description: "YouTube integration", unitPricePaise: 10_000_000 }] })).body.data;
    const secondIssued = (await request(app).post(`/v1/sales/invoices/${second.id}/issue`).set(auth(salesToken)).send({ issueDate: "2026-10-21", dueDate: "2026-10-01" })).body.data;
    expect(secondIssued).toMatchObject({ number: documentNumber("DS", fy.label, 2), taxMode: "inter", igstPaise: 1_800_000, totalPaise: 11_800_000, derivedStatus: "overdue" });
    const overdue = await request(app).get("/v1/sales/invoices?status=overdue").set(auth(salesToken));
    expect(overdue.body.data.map((i: { id: string }) => i.id)).toEqual([second.id]);
    const cancelled = (await request(app).post(`/v1/sales/invoices/${second.id}/cancel`).set(auth(salesToken)).send({ reason: "Duplicate" })).body.data;
    expect(cancelled).toMatchObject({ status: "cancelled", number: documentNumber("DS", fy.label, 2), derivedStatus: "cancelled" });
    const third = (await request(app).post("/v1/sales/invoices").set(auth(salesToken)).send({ clientId: clientKa, items: [{ description: "Story", unitPricePaise: 100_000 }] })).body.data;
    expect((await request(app).post(`/v1/sales/invoices/${third.id}/issue`).set(auth(salesToken)).send({})).body.data.number).toBe(documentNumber("DS", fy.label, 3));

    const dash = (await request(app).get("/v1/sales/dashboard").set(auth(salesToken))).body.data;
    expect(dash.financialYear).toBe(fy.label);
    expect(dash.collectedFyPaise).toBe(11_771_680);
    expect(dash.tdsFyPaise).toBe(264_320);
    expect(dash.outstandingPaise).toBe(118_000);
    const events = (await request(app).get(`/v1/sales/events?entityType=invoice&entityId=${draft.id}`).set(auth(salesToken))).body.data;
    expect(events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["created", "issued", "payment_allocated", "credit_note_issued"]));
    expect(events.every((e: { actorId: string }) => e.actorId === salesUserId)).toBe(true);
  });

  it("invoices a client's self-serve campaign booking at its frozen prices", async () => {
    const booking = await prisma.campaignBooking.create({
      data: {
        clientId: clientMh, name: "Spring launch", brand: "Filmy", status: "paid_pending_review", totalPaise: 7_000_000,
        items: { create: [
          { rateCardId: "rc-1", targetType: "meta_asset", targetId: "asset-1", platform: "instagram", format: "reel", accountName: "Bollywood Society", accountHandle: "bollywoodsociety", pricePaise: 5_000_000, status: "pending" },
          { rateCardId: "rc-2", targetType: "meta_asset", targetId: "asset-2", platform: "facebook", format: "post", accountName: "Paparazzi", pricePaise: 2_000_000, status: "pending" },
        ] },
      },
    });
    const res = await request(app).post(`/v1/sales/invoices/from-booking/${booking.id}`).set(auth(salesToken));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ campaignBookingId: booking.id, subtotalPaise: 7_000_000, totalPaise: 8_260_000, taxMode: "intra" });
    expect(res.body.data.items.map((i: { description: string }) => i.description)).toEqual(["Bollywood Society (@bollywoodsociety) · Instagram Reel", "Paparazzi · Facebook Post"]);
  });
});
