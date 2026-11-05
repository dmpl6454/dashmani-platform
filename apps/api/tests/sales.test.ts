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
import { invalidateCatalogueCache } from "../src/services/campaign/rate-card.service";
import jwt from "jsonwebtoken";

const SELLER = {
  legalName: "Dashmani Media Private Limited", gstin: "27AAACD1234E1Z5", pan: "AAACD1234E", addressLine1: "Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", bankName: "HDFC Bank", accountName: "Dashmani Media Pvt Ltd", accountNumber: "50100123456789",
  ifsc: "HDFC0000123", invoicePrefix: "DS", defaultDueDays: 15, roundToRupee: true, terms: "Payable within 15 days.",
};

let salesToken: string;
let adminToken: string;
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
  await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
  await createTestRole("Employee", [{ resource: "attendance", action: "view", scope: "own" }]);
  const sales = await createTestUser({ name: "Sales Person", roleNames: ["Sales"] });
  const emp = await createTestUser({ name: "Plain Employee", roleNames: ["Employee"] });
  const adm = await createTestUser({ name: "Office Admin", roleNames: ["Admin"] });
  adminToken = generateToken(adm.id, adm.email, ["Admin"]);
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
    // Bank details and GSTIN print on every invoice: only an admin may change them.
    expect((await request(app).put("/v1/sales/settings/seller").set(auth(salesToken)).send(SELLER)).status).toBe(403);
    const bad = await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send({ ...SELLER, gstin: "nope" });
    expect(bad.status).toBe(400);
    const saved = await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ saved: true, missing: [] });
    expect(saved.body.data.profile.gstin).toBe("27AAACD1234E1Z5");
  });

  it("lists the client catalogue first, then every other active channel without a price", async () => {
    const platform = await prisma.platform.create({ data: { name: "Snapchat", slug: "snapchat" } });
    await prisma.socialAccount.create({ data: { handle: "bollywoodsociety", displayName: "Bollywood Society", platformId: platform.id, followerCount: 147_300, status: "ACTIVE" } });
    const x = await prisma.platform.create({ data: { name: "X", slug: "x" } });
    await prisma.socialAccount.create({ data: { handle: "filmyx", displayName: "Filmy X", platformId: x.id, followerCount: 5_000, status: "ACTIVE" } });
    // Two connected Instagram accounts: one priced (= in the client catalogue), one not.
    const conn = await prisma.metaConnection.create({ data: { metaUserId: "mu-sales", connectedById: salesUserId, status: "ACTIVE" } });
    const priced = await prisma.metaAsset.create({ data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "9001", name: "Paparazzi Feed", username: "paparazzifeed", followerCount: 2_000_000 } });
    const unpriced = await prisma.metaAsset.create({ data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "9002", name: "Filme Flicks", username: "filmeflicks", followerCount: 9_000_000 } });
    await prisma.campaignRateCard.createMany({
      data: [
        { targetType: "meta_asset", targetId: priced.id, platform: "instagram", format: "reel", pricePaise: 150_000, entertainmentPricePaise: 180_000, category: "Bollywood" },
        { targetType: "meta_asset", targetId: priced.id, platform: "instagram", format: "story", pricePaise: 40_000, active: false },
      ],
    });
    invalidateCatalogueCache();
    invalidateInventoryCache();
    const res = await request(app).get("/v1/sales/inventory").set(auth(salesToken));
    expect(res.status).toBe(200);
    const rows: Array<{ handle: string; inCatalogue: boolean; bookable: boolean; category: string | null; offers: Array<{ format: string; active: boolean; pricePaise: number }> }> = res.body.data;
    // The client portal's list comes first — same offers, only the active ones.
    expect(rows[0]).toMatchObject({ handle: "paparazzifeed", inCatalogue: true, bookable: true, category: "Bollywood" });
    expect(rows[0].offers).toEqual([expect.objectContaining({ format: "reel", pricePaise: 150_000, entertainmentPricePaise: 180_000, active: true })]);
    // A connected account without an active price is bookable but not in the catalogue; its reach does not move it up.
    expect(rows.find((c) => c.handle === "filmeflicks")).toMatchObject({ inCatalogue: false, bookable: true, offers: [] });
    expect(rows.findIndex((c) => c.handle === "filmeflicks")).toBeGreaterThan(0);
    // A Snapchat profile can take a price (bookable) but is not in the catalogue until it has one.
    expect(rows.find((c) => c.handle === "bollywoodsociety")).toMatchObject({ platform: "snapchat", followers: 147_300, bookable: true, inCatalogue: false, offers: [] });
    // A tracked-only channel on a platform clients can't book is listed too, never bookable.
    expect(rows.find((c) => c.handle === "filmyx")).toMatchObject({ platform: "x", bookable: false, inCatalogue: false, offers: [] });
    // Exactly what the client portal serves, in the same order.
    const clientToken = jwt.sign({ userId: clientMh, email: "mh@client.test", roles: [], type: "client" }, process.env.JWT_SECRET || "dev-secret", { expiresIn: "15m" });
    const cat = await request(app).get("/v1/client/campaigns/catalogue").set(auth(clientToken));
    expect(cat.status).toBe(200);
    expect(cat.body.data.map((e: { targetId: string }) => e.targetId)).toEqual(rows.filter((c) => c.inCatalogue).map((c: any) => c.targetId));
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

  it("creates a client with its billing profile in one step, edits details, and keeps the sign-in email admin-only", async () => {
    const bad = await request(app).post("/v1/sales/clients").set(auth(salesToken)).send({
      companyName: "Half Brand", contactName: "Asha", email: "asha@half.test", billing: { legalName: "Half Brand LLP", gstin: "07AABCN1234G1Z2", stateCode: "27" },
    });
    expect(bad.status).toBe(400); // GSTIN state 07 vs place of supply 27 — and nothing was created
    expect((await request(app).get("/v1/sales/clients?q=half brand").set(auth(salesToken))).body.data).toEqual([]);

    const res = await request(app).post("/v1/sales/clients").set(auth(salesToken)).send({
      companyName: "Full Brand", contactName: "Asha", email: "asha@full.test", phone: "9876543210",
      billing: { legalName: "Full Brand Pvt Ltd", gstin: "07AABCN1234G1Z2", addressLine1: "1 Main Rd", city: "Delhi", pincode: "110001" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ companyName: "Full Brand", phone: "9876543210", billingProfile: { legalName: "Full Brand Pvt Ltd", gstin: "07AABCN1234G1Z2", stateCode: "07", city: "Delhi" } });
    const id = res.body.data.id;

    const edited = await request(app).put(`/v1/sales/clients/${id}`).set(auth(salesToken)).send({ companyName: "Full Brand Co", contactName: "Asha Rao", phone: null });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ companyName: "Full Brand Co", contactName: "Asha Rao", phone: null, email: "asha@full.test" });
    // email is ignored by the details edit (strict fields only)…
    const sneaky = await request(app).put(`/v1/sales/clients/${id}`).set(auth(salesToken)).send({ email: "evil@x.test" });
    expect(sneaky.status).toBe(400);
    expect((await request(app).put(`/v1/sales/clients/${id}`).set(auth(employeeToken)).send({ companyName: "Nope" })).status).toBe(403);

    // …and the email route needs the sales admin grant.
    expect((await request(app).put(`/v1/sales/clients/${id}/email`).set(auth(salesToken)).send({ email: "new@full.test" })).status).toBe(403);
    expect((await request(app).put(`/v1/sales/clients/${id}/email`).set(auth(adminToken)).send({ email: "RIYA@filmybrands.test" })).status).toBe(409);
    await prisma.clientRefreshToken.create({ data: { clientId: id, token: `rt-${id}`, expiresAt: new Date(Date.now() + 86_400_000) } });
    const moved = await request(app).put(`/v1/sales/clients/${id}/email`).set(auth(adminToken)).send({ email: "New@Full.test" });
    expect(moved.status).toBe(200);
    expect(moved.body.data.email).toBe("new@full.test");
    expect(await prisma.clientRefreshToken.count({ where: { clientId: id } })).toBe(0);
    expect(await prisma.salesEvent.count({ where: { entityId: id, action: { in: ["client_created", "billing_profile_saved", "client_updated", "client_email_changed"] } } })).toBe(4);
  });

  it("saves the whole client profile (details + billing) in one call, atomically", async () => {
    const res = await request(app).post("/v1/sales/clients").set(auth(salesToken)).send({ companyName: "Profile Co", contactName: "Ravi", email: "ravi@profile.test" });
    const id = res.body.data.id;
    // A bad billing profile rejects the whole save — the details are not half-applied.
    const bad = await request(app).put(`/v1/sales/clients/${id}/profile`).set(auth(salesToken)).send({
      companyName: "Profile Co Renamed", contactName: "Ravi K", billing: { legalName: "Profile Co Pvt Ltd", gstin: "07AABCN1234G1Z2", stateCode: "27" },
    });
    expect(bad.status).toBe(400);
    expect((await request(app).get(`/v1/sales/clients/${id}`).set(auth(salesToken))).body.data.companyName).toBe("Profile Co");

    const ok = await request(app).put(`/v1/sales/clients/${id}/profile`).set(auth(salesToken)).send({
      companyName: "Profile Co Renamed", contactName: "Ravi K", phone: "9000000000",
      billing: { legalName: "Profile Co Pvt Ltd", gstin: "07AABCN1234G1Z2", city: "Delhi", notes: "Pays by NEFT, 30 days" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ companyName: "Profile Co Renamed", contactName: "Ravi K", phone: "9000000000", email: "ravi@profile.test", billingProfile: { legalName: "Profile Co Pvt Ltd", stateCode: "07", city: "Delhi", notes: "Pays by NEFT, 30 days" } });

    // billing: null keeps the saved profile
    const again = await request(app).put(`/v1/sales/clients/${id}/profile`).set(auth(salesToken)).send({ companyName: "Profile Co", contactName: "Ravi K", phone: null, billing: null });
    expect(again.body.data).toMatchObject({ companyName: "Profile Co", phone: null, billingProfile: { legalName: "Profile Co Pvt Ltd" } });
    // the email is not part of the profile save
    const sneaky = await request(app).put(`/v1/sales/clients/${id}/profile`).set(auth(salesToken)).send({ companyName: "Profile Co", contactName: "Ravi K", email: "evil@x.test" });
    expect(sneaky.status).toBe(200);
    expect(sneaky.body.data.email).toBe("ravi@profile.test");
    expect((await request(app).put(`/v1/sales/clients/${id}/profile`).set(auth(employeeToken)).send({ companyName: "X Co", contactName: "Ravi" })).status).toBe(403);
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
    const confirmed = await request(app).post(`/v1/sales/orders/${order.id}/confirm`).set(auth(salesToken));
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const fromOrder = await request(app).post(`/v1/sales/orders/${order.id}/invoice`).set(auth(salesToken));
    expect(fromOrder.status, JSON.stringify(fromOrder.body)).toBe(201);
    const draft = fromOrder.body.data;
    expect(draft).toMatchObject({ status: "draft", number: null, orderId: order.id, totalPaise: 13_216_000, derivedStatus: "draft" });

    // Issuing needs the company GST profile.
    const blocked = await request(app).post(`/v1/sales/invoices/${draft.id}/issue`).set(auth(salesToken)).send({});
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe("SELLER_PROFILE_INCOMPLETE");
    await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER);

    const issued = (await request(app).post(`/v1/sales/invoices/${draft.id}/issue`).set(auth(salesToken)).send({ issueDate: "2026-10-20" })).body.data;
    expect(issued).toMatchObject({ number: documentNumber("DS", financialYear("2026-10-20").label, 1), status: "issued", issueDate: "2026-10-20", dueDate: "2026-11-04", balancePaise: 13_216_000 });
    // The default terms put the due date in the past once the calendar passes 4 Nov 2026; push it
    // out so the "partially paid" checks below do not turn into "overdue" with the date.
    await prisma.salesInvoice.update({ where: { id: draft.id }, data: { dueDate: new Date("2099-12-31T00:00:00.000Z") } });
    expect(issued.amountInWords).toBe("Rupees One Lakh Thirty Two Thousand One Hundred Sixty Only");
    expect(issued.sellerSnapshot.gstin).toBe("27AAACD1234E1Z5");
    expect(issued.buyerSnapshot).toMatchObject({ legalName: "Filmy Brands Private Limited", gstin: "27AABCU9603R1ZX" });
    expect((await request(app).post(`/v1/sales/invoices/${draft.id}/issue`).set(auth(salesToken)).send({})).status).toBe(409);
    // An issued invoice can be edited (tests/sales-numbering-edit.test.ts), but never into another kind.
    expect((await request(app).put(`/v1/sales/invoices/${draft.id}`).set(auth(salesToken)).send({ clientId: clientMh, kind: "proforma", items: [{ description: "x", unitPricePaise: 1 }] })).body.error.code).toBe("KIND_FIXED");

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
    const secondIssued = (await request(app).post(`/v1/sales/invoices/${second.id}/issue`).set(auth(salesToken)).send({ issueDate: "2026-10-21", dueDate: "2026-10-21" })).body.data; // due on receipt, so overdue by now
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

describe("draft invoice preview", () => {
  beforeEach(seedWorld);

  const pdfOf = (id: string) => request(app).get(`/v1/sales/invoices/${id}/pdf?inline=1`).set(auth(salesToken)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });

  it("prints a draft as issuing would freeze it, without writing anything or taking a number", async () => {
    await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER);
    const draft = (await request(app).post("/v1/sales/invoices").set(auth(salesToken)).send({ clientId: clientKa, items: [{ description: "Instagram reel", quantity: 1, unitPricePaise: 1_000_000 }] })).body.data;
    expect(draft).toMatchObject({ status: "draft", number: null });

    const { previewInvoice } = await import("../src/services/sales/invoices.service");
    const p = await previewInvoice(draft.id);
    expect(p.number).toBeNull();
    expect(p.sellerSnapshot).toMatchObject({ legalName: SELLER.legalName, gstin: SELLER.gstin, stateCode: "27" });
    expect(p.buyerSnapshot).toMatchObject({ legalName: "Bengaluru Apps LLP", gstin: "29AAACB1234F1Z9", stateCode: "29" });
    expect(p.issueDate).toBe(todayIST());
    expect(p.dueDate).not.toBeNull();
    expect(p.amountInWords).toBe(rupeesInWords(draft.totalPaise));
    expect(p.terms).toBe(SELLER.terms);

    const pdf = await pdfOf(draft.id);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["content-disposition"]).toMatch(/^inline; filename="preview-draft-/);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");

    // Nothing was frozen and no serial was used: issuing still takes the first number.
    const row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row).toMatchObject({ status: "draft", number: null, sellerSnapshot: null, buyerSnapshot: null, amountInWords: null, issueDate: null });
    const issued = (await request(app).post(`/v1/sales/invoices/${draft.id}/issue`).set(auth(salesToken)).send({})).body.data;
    expect(issued.number).toBe(documentNumber("DS", fy.label, 1));
  });

  it("leaves an issued invoice printing its frozen snapshot", async () => {
    await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER);
    const draft = (await request(app).post("/v1/sales/invoices").set(auth(salesToken)).send({ clientId: clientMh, items: [{ description: "Reel", quantity: 1, unitPricePaise: 500_000 }] })).body.data;
    await request(app).post(`/v1/sales/invoices/${draft.id}/issue`).set(auth(salesToken)).send({});
    // The company changes its name after issue: the issued invoice must still print the old one.
    await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send({ ...SELLER, legalName: "Renamed Media Private Limited" });
    const { previewInvoice } = await import("../src/services/sales/invoices.service");
    expect((await previewInvoice(draft.id)).sellerSnapshot).toMatchObject({ legalName: SELLER.legalName });
  });

  it("is gated like the PDF: a user without sales access is refused", async () => {
    const draft = (await request(app).post("/v1/sales/invoices").set(auth(salesToken)).send({ clientId: clientMh, items: [{ description: "Reel", quantity: 1, unitPricePaise: 500_000 }] })).body.data;
    expect((await request(app).get(`/v1/sales/invoices/${draft.id}/pdf`).set(auth(employeeToken))).status).toBe(403);
  });
});
