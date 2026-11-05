/**
 * Invoice numbers typed by hand at Issue, per-registration serial digits (Mumbai INV/26-27/0015,
 * Gurugram INV/26-27/060), the client's PO on an invoice, and editing an issued invoice: same
 * number, every change recorded, refused once money / a credit note is on it or the date leaves
 * its financial year.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { documentNumber, financialYear, seriesSerial, todayIST } from "@dashmani/shared";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const HARYANA = {
  label: "Gurugram", gstin: "06AAKCD3352K1ZJ", addressLine1: "Hunch Circle, Huda City Centre", city: "Gurugram", pincode: "122001",
  invoicePrefix: "INV", creditNotePrefix: "CNHR", serialDigits: 3,
};
const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702, Parinee I, Andheri West",
  city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "INV", serialDigits: 4, creditNotePrefix: "CN", branches: [HARYANA],
};

// T-08 (spec-import §8, moved to PR 0 by spec-00 §2.10): pure, no database.
describe("seriesSerial — a typed number is a series' own only in its exact format", () => {
  it("reads the serial only when prefix, financial year AND digit count all match", () => {
    expect(seriesSerial("INV/26-27/060", "INV", "2026-27", 3)).toBe(60);
    expect(seriesSerial("INV/26-27/060", "INV", "2026-27", 4)).toBeNull();
    expect(seriesSerial("INV/26-27/0016", "INV", "2026-27", 4)).toBe(16);
    expect(seriesSerial("INV/26-27/0016", "INV", "2026-27", 3)).toBeNull();
    expect(seriesSerial("INV/26-27/10000", "INV", "2026-27", 4)).toBe(10000);
    expect(seriesSerial("INV/25-26/0016", "INV", "2026-27", 4)).toBeNull();
    expect(seriesSerial(" inv/26-27/0016 ", "INV", "2026-27", 4)).toBe(16);
    expect(seriesSerial("DSHR/26-27/0016", "INV", "2026-27", 4)).toBeNull();
    expect(seriesSerial("INV/26-27/00x6", "INV", "2026-27", 4)).toBeNull();
    expect(seriesSerial("INV/26-27/", "INV", "2026-27", 4)).toBeNull();
  });
});

let salesToken: string;
let adminToken: string;
let mumbaiClient: string;
let gurugramClient: string;
const fy = () => financialYear(todayIST());
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

// Inside each describe, like the sales suite: vitest runs same-level beforeEach hooks in parallel,
// so a top-level one would race the setup file's TRUNCATE.
async function seed() {
  await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales.seller" } } });
  await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
  await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
  const sales = await createTestUser({ name: "Sales Person", roleNames: ["Sales"] });
  const adm = await createTestUser({ name: "Office Admin", roleNames: ["Admin"] });
  salesToken = generateToken(sales.id, sales.email, ["Sales"]);
  adminToken = generateToken(adm.id, adm.email, ["Admin"]);
  const mh = await prisma.client.create({ data: { companyName: "Filmy Brands", contactName: "Riya", email: "riya@filmy.test", passwordHash: "x" } });
  await prisma.clientBillingProfile.create({ data: { clientId: mh.id, legalName: "Filmy Brands Private Limited", gstin: "27AABCU9603R1ZX", stateCode: "27", state: "Maharashtra", city: "Mumbai", addressLine1: "Bandra", pincode: "400050" } });
  const hr = await prisma.client.create({ data: { companyName: "Eleve Media", contactName: "Namit", email: "namit@eleve.test", passwordHash: "x" } });
  await prisma.clientBillingProfile.create({ data: { clientId: hr.id, legalName: "Eleve Media Private Limited", gstin: "06AADCE2627H1ZW", stateCode: "06", state: "Haryana", city: "Gurgaon", addressLine1: "Sector 44", pincode: "122001" } });
  mumbaiClient = mh.id;
  gurugramClient = hr.id;
  const saved = await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}

const draft = async (clientId: string, extra: Record<string, unknown> = {}) => {
  const r = await request(app).post("/v1/sales/invoices").set(auth(salesToken)).send({ clientId, items: [{ description: "Instagram reel", quantity: 1, unitPricePaise: 1_000_000 }], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; totalPaise: number };
};
const issue = (id: string, body: Record<string, unknown> = {}) => request(app).post(`/v1/sales/invoices/${id}/issue`).set(auth(salesToken)).send(body);

describe("invoice numbers", () => {
  beforeEach(seed);
  it("continues a series from a number typed at Issue, per registration and with its own digits", async () => {
    // Mumbai: the old app reached INV/26-27/0014, so the first portal invoice is typed as 0015.
    const typed = documentNumber("INV", fy().label, 15, 4);
    const a = await issue((await draft(mumbaiClient)).id, { number: typed });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data.number).toBe(typed);
    expect((await issue((await draft(mumbaiClient)).id)).body.data.number).toBe(documentNumber("INV", fy().label, 16, 4));

    // Gurugram: same prefix, 3 digits, its own series.
    expect((await issue((await draft(gurugramClient)).id)).body.data.number).toBe(documentNumber("INV", fy().label, 1, 3));
    const g = await issue((await draft(gurugramClient)).id, { number: documentNumber("INV", fy().label, 60, 3) });
    expect(g.body.data.number).toBe(`INV/${fy().label.slice(2, 4)}-${fy().label.slice(5)}/060`);
    expect((await issue((await draft(gurugramClient)).id)).body.data.number).toBe(documentNumber("INV", fy().label, 61, 3));
    // …and the Mumbai series did not move.
    expect((await issue((await draft(mumbaiClient)).id)).body.data.number).toBe(documentNumber("INV", fy().label, 17, 4));
  });

  // T-30 (spec-import §8, PR 0 per spec-00 §2.10): both registrations print INV; only the digits differ.
  it("a number typed in the OTHER registration's format never moves this registration's series", async () => {
    await issue((await draft(mumbaiClient)).id, { number: documentNumber("INV", fy().label, 15, 4) });
    // Gurugram's 3-digit format typed on a Mumbai draft: accepted as typed, Mumbai stays at 16.
    const odd = await issue((await draft(mumbaiClient)).id, { number: documentNumber("INV", fy().label, 60, 3) });
    expect(odd.status, JSON.stringify(odd.body)).toBe(200);
    expect(odd.body.data.number).toBe(documentNumber("INV", fy().label, 60, 3));
    expect((await issue((await draft(mumbaiClient)).id)).body.data.number).toBe(documentNumber("INV", fy().label, 16, 4));
    // Mumbai's 4-digit format typed on a Gurugram draft leaves Gurugram's series alone.
    const odd2 = await issue((await draft(gurugramClient)).id, { number: documentNumber("INV", fy().label, 20, 4) });
    expect(odd2.status, JSON.stringify(odd2.body)).toBe(200);
    expect((await issue((await draft(gurugramClient)).id)).body.data.number).toBe(documentNumber("INV", fy().label, 1, 3));
  });

  it("refuses a number already used, an invalid one, and leaves the series alone for another format", async () => {
    const first = (await issue((await draft(mumbaiClient)).id)).body.data.number;
    const dup = await issue((await draft(mumbaiClient)).id, { number: first.toLowerCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("NUMBER_TAKEN");
    expect((await issue((await draft(mumbaiClient)).id, { number: "INV 26/27 #9" })).status).toBe(400);
    expect((await issue((await draft(mumbaiClient)).id, { number: "A-VERY-LONG-NUMBER-17" })).status).toBe(400);
    const other = await issue((await draft(mumbaiClient)).id, { number: "OLD-77" });
    expect(other.body.data.number).toBe("OLD-77");
    expect((await issue((await draft(mumbaiClient)).id)).body.data.number).toBe(documentNumber("INV", fy().label, 2, 4));
  });

  it("allows a shared invoice prefix only when the digits differ", async () => {
    const save = (b: object) => request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(b);
    expect((await save({ ...SELLER, branches: [{ ...HARYANA, serialDigits: 4 }] })).status).toBe(400);
    expect((await save({ ...SELLER, branches: [{ ...HARYANA, creditNotePrefix: "INV" }] })).status).toBe(400);
    expect((await save(SELLER)).status).toBe(200);
  });
});

describe("client PO on an invoice", () => {
  beforeEach(seed);
  it("is saved, returned and copied from the sales order", async () => {
    const inv = await draft(mumbaiClient, { poNumber: "PO-2026-118", poDate: "2026-10-30" });
    expect((await request(app).get(`/v1/sales/invoices/${inv.id}`).set(auth(salesToken))).body.data).toMatchObject({ poNumber: "PO-2026-118", poDate: "2026-10-30" });
    const order = (await request(app).post("/v1/sales/orders").set(auth(salesToken)).send({ clientId: mumbaiClient, title: "Diwali", campaignType: "brand", poNumber: "PO-77", items: [{ kind: "custom", description: "Reel", quantity: 1, unitPricePaise: 500_000 }] })).body.data;
    await request(app).post(`/v1/sales/orders/${order.id}/confirm`).set(auth(salesToken));
    const fromOrder = await request(app).post(`/v1/sales/orders/${order.id}/invoice`).set(auth(salesToken));
    expect(fromOrder.status, JSON.stringify(fromOrder.body)).toBe(201);
    expect(fromOrder.body.data.poNumber).toBe("PO-77");
  });
});

describe("editing an issued invoice", () => {
  beforeEach(seed);
  const body = (clientId: string, unitPricePaise: number, extra: Record<string, unknown> = {}) => ({ clientId, items: [{ description: "Instagram reel", quantity: 1, unitPricePaise }], ...extra });

  it("keeps the number, re-totals, refreshes the buyer and records what changed", async () => {
    const d = await draft(mumbaiClient);
    const issued = (await issue(d.id)).body.data;
    await prisma.clientBillingProfile.update({ where: { clientId: mumbaiClient }, data: { addressLine1: "Linking Road, Bandra" } });
    const r = await request(app).put(`/v1/sales/invoices/${d.id}`).set(auth(salesToken)).send(body(mumbaiClient, 2_000_000, { issueDate: issued.issueDate, poNumber: "PO-9" }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ number: issued.number, status: "issued", poNumber: "PO-9", totalPaise: 2_360_000 });
    expect(r.body.data.amountInWords).toBe("Rupees Twenty Three Thousand Six Hundred Only");
    expect(r.body.data.buyerSnapshot.addressLine1).toBe("Linking Road, Bandra");
    expect(r.body.data.sellerSnapshot.gstin).toBe(SELLER.gstin);
    const ev = await prisma.salesEvent.findFirst({ where: { entityId: d.id, action: "edited_after_issue" } });
    expect(ev?.note).toContain(issued.number);
    expect(ev?.note).toContain("Total ₹11,800.00 → ₹23,600.00");
    expect(ev?.note).toContain("PO — → PO-9");
  });

  it("refuses a kind change, a date in another financial year, and any edit once a payment is recorded", async () => {
    const d = await draft(mumbaiClient);
    const issued = (await issue(d.id)).body.data;
    const put = (b: object) => request(app).put(`/v1/sales/invoices/${d.id}`).set(auth(salesToken)).send(b);
    expect((await put(body(mumbaiClient, 1_000_000, { kind: "proforma" }))).body.error.code).toBe("KIND_FIXED");
    const nextFy = `${Number(fy().endDay.slice(0, 4))}-05-01`;
    expect((await put(body(mumbaiClient, 1_000_000, { issueDate: nextFy }))).body.error.code).toBe("DATE_OUTSIDE_FY");
    const pay = await request(app).post("/v1/sales/payments").set(auth(salesToken)).send({ clientId: mumbaiClient, amountPaise: 100_000, mode: "upi", paidOn: issued.issueDate, allocations: [{ invoiceId: d.id, amountPaise: 100_000 }] });
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const locked = await put(body(mumbaiClient, 2_000_000));
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("INVOICE_LOCKED");
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: d.id } })).totalPaise).toBe(issued.totalPaise);
  });
});

describe("next invoice number preview", () => {
  beforeEach(seed);
  const peek = (q: Record<string, string>) => request(app).get("/v1/sales/invoices/next-number").query(q).set(auth(salesToken));

  it("shows the number Issue will take, per registration, without taking it", async () => {
    const mh = await peek({ company: "dspl", kind: "tax_invoice", clientId: mumbaiClient });
    expect(mh.status, JSON.stringify(mh.body)).toBe(200);
    expect(mh.body.data).toMatchObject({ number: documentNumber("INV", fy().label, 1, 4), gstin: SELLER.gstin });
    expect((await peek({ company: "dspl", kind: "tax_invoice", clientId: mumbaiClient })).body.data.number).toBe(mh.body.data.number); // nothing consumed
    const d = await draft(mumbaiClient);
    expect((await issue(d.id)).body.data.number).toBe(mh.body.data.number);
    expect((await peek({ company: "dspl", kind: "tax_invoice", clientId: mumbaiClient })).body.data.number).toBe(documentNumber("INV", fy().label, 2, 4));

    // Gurugram client → the Gurugram series, 3 digits; after a typed 060 the preview says 061.
    expect((await peek({ company: "dspl", kind: "tax_invoice", clientId: gurugramClient })).body.data).toMatchObject({ number: documentNumber("INV", fy().label, 1, 3), gstin: HARYANA.gstin, registration: "Gurugram" });
    await issue((await draft(gurugramClient)).id, { number: documentNumber("INV", fy().label, 60, 3) });
    expect((await peek({ company: "dspl", kind: "tax_invoice", clientId: gurugramClient })).body.data.number).toBe(documentNumber("INV", fy().label, 61, 3));
    // Picking the registration by hand wins over the client's state; a proforma uses PI.
    expect((await peek({ company: "dspl", kind: "tax_invoice", clientId: gurugramClient, sellerGstin: SELLER.gstin })).body.data.number).toBe(documentNumber("INV", fy().label, 2, 4));
    expect((await peek({ company: "dspl", kind: "proforma", clientId: mumbaiClient })).body.data.number).toBe(documentNumber("PI", fy().label, 1, 4));
  });
});
