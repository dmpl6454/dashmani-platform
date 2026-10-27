/**
 * Invoice emails + client downloads (2026-10-27): recording a payment emails the invoice PDF to the
 * client and the company's billing addresses; an online campaign payment is invoiced (GST on top),
 * receipted and emailed on its own; the client portal lists and downloads its own invoices.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { todayIST } from "@dashmani/shared";

const sent: Array<{ to: string; cc?: string; subject: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];
vi.mock("../src/services/email.service", async (orig) => {
  const real = await orig<typeof import("../src/services/email.service")>();
  return { ...real, sendEmail: vi.fn(async (o: (typeof sent)[number]) => { sent.push(o); return { messageId: "test" }; }) };
});

import app from "../src/app";
import { flushSalesBackground } from "../src/services/sales/common";
import { emailInvoice } from "../src/services/sales/invoice-email.service";
import { billOnlineBookingPayment } from "../src/services/sales/booking-billing.service";
import { campaignPricing, itemGstPaise } from "../src/services/campaign/gst";
import { createTestRole, createTestUser, generateClientToken, generateToken } from "./helpers";

const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAACD1234E1Z5", pan: "AAACD1234E", addressLine1: "Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "DS", creditNotePrefix: "CN", defaultDueDays: 15, roundToRupee: true,
  email: "accounts@ds.test", billingEmails: ["finance@ds.test"],
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const today = todayIST();

describe("invoice emails and client downloads", () => {
  let token: string;
  let adminToken: string;
  let clientId: string;
  let clientToken: string;

  beforeEach(async () => {
    sent.length = 0;
    await prisma.systemSetting.deleteMany({ where: { key: "sales.seller" } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ roleNames: ["Sales"] });
    const a = await createTestUser({ roleNames: ["Admin"] });
    token = generateToken(u.id, u.email, ["Sales"]);
    adminToken = generateToken(a.id, a.email, ["Admin"]);
    const c = await prisma.client.create({ data: { companyName: "Filmy Brands", contactName: "Riya", email: "riya@filmy.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName: "Filmy Brands Pvt Ltd", stateCode: "27", state: "Maharashtra", city: "Mumbai", billingEmail: "bills@filmy.test" } });
    clientId = c.id;
    clientToken = generateClientToken(c.id, c.email);
    expect((await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER)).status).toBe(200);
  });

  async function issued(unit = 100_000) {
    const d = await request(app).post("/v1/sales/invoices").set(auth(token)).send({ clientId, items: [{ description: "Reel", quantity: 1, unitPricePaise: unit }] });
    const i = await request(app).post(`/v1/sales/invoices/${d.body.data.id}/issue`).set(auth(token)).send({});
    expect(i.status, JSON.stringify(i.body)).toBe(200);
    return i.body.data as { id: string; number: string; totalPaise: number };
  }
  const receipt = (amountPaise: number, allocations: Array<{ invoiceId: string; amountPaise: number }>) =>
    request(app).post("/v1/sales/payments").set(auth(token)).send({ clientId, amountPaise, mode: "upi", paidOn: today, allocations });

  it("emails the invoice PDF to the client and the billing addresses when a payment is recorded — once per payment", async () => {
    const inv = await issued(); // ₹1,180
    const p = await receipt(50_000, [{ invoiceId: inv.id, amountPaise: 50_000 }]);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    await flushSalesBackground();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("bills@filmy.test, riya@filmy.test");
    expect(sent[0].cc).toBe("accounts@ds.test, finance@ds.test");
    expect(sent[0].subject).toContain(inv.number);
    expect(sent[0].subject).toContain("payment of ₹500.00 received");
    expect(sent[0].attachments?.[0].filename).toBe(`${inv.number.replace(/[^\w.-]+/g, "-")}.pdf`);
    expect(sent[0].attachments?.[0].content.subarray(0, 4).toString()).toBe("%PDF");

    // The same payment is never emailed twice; the next payment is.
    expect((await emailInvoice(inv.id, { paymentId: p.body.data.id })).skipped).toBe("already emailed for this payment");
    await receipt(inv.totalPaise - 50_000, [{ invoiceId: inv.id, amountPaise: inv.totalPaise - 50_000 }]);
    await flushSalesBackground();
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toContain("(paid in full)");
    const events = await prisma.salesEvent.findMany({ where: { entityId: inv.id, action: "emailed" } });
    expect(events).toHaveLength(2);
    expect((await prisma.salesInvoice.findUnique({ where: { id: inv.id } }))?.sentAt).not.toBeNull();
  });

  it("applying an advance emails too; switching automatic emails off stops them; staff can send by hand", async () => {
    const inv = await issued();
    const adv = await receipt(200_000, []);
    await flushSalesBackground();
    expect(sent).toHaveLength(0); // an unallocated advance has no invoice to send
    await request(app).post(`/v1/sales/payments/${adv.body.data.id}/allocations`).set(auth(token)).send({ allocations: [{ invoiceId: inv.id, amountPaise: 10_000 }] });
    await flushSalesBackground();
    expect(sent).toHaveLength(1);

    expect((await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send({ ...SELLER, autoEmailInvoices: false })).status).toBe(200);
    await request(app).post(`/v1/sales/payments/${adv.body.data.id}/allocations`).set(auth(token)).send({ allocations: [{ invoiceId: inv.id, amountPaise: 10_000 }] });
    await flushSalesBackground();
    expect(sent).toHaveLength(1);

    const manual = await request(app).post(`/v1/sales/invoices/${inv.id}/email`).set(auth(token));
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    expect(sent).toHaveLength(2);
    const d = await request(app).post("/v1/sales/invoices").set(auth(token)).send({ clientId, items: [{ description: "Draft", quantity: 1, unitPricePaise: 1000 }] });
    expect((await request(app).post(`/v1/sales/invoices/${d.body.data.id}/email`).set(auth(token))).status).toBe(409);
  });

  it("the client portal lists only the client's own issued invoices and downloads their PDF", async () => {
    const inv = await issued();
    await request(app).post("/v1/sales/invoices").set(auth(token)).send({ clientId, items: [{ description: "Draft", quantity: 1, unitPricePaise: 1000 }] });
    const list = await request(app).get("/v1/client/invoices").set(auth(clientToken));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id: inv.id, number: inv.number, status: "issued", totalPaise: inv.totalPaise, balancePaise: inv.totalPaise, company: "Digital Sukoon Private Limited" })]);
    const pdf = await request(app).get(`/v1/client/invoices/${inv.id}/pdf`).set(auth(clientToken)).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on("data", (c: Buffer) => b.push(c)); res.on("end", () => cb(null, Buffer.concat(b))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");

    const other = await prisma.client.create({ data: { companyName: "Other", contactName: "O", email: "o@o.test", passwordHash: "x" } });
    const otherToken = generateClientToken(other.id, other.email);
    expect((await request(app).get(`/v1/client/invoices/${inv.id}/pdf`).set(auth(otherToken))).status).toBe(404);
    expect((await request(app).get("/v1/client/invoices").set(auth(otherToken))).body.data).toEqual([]);
    expect((await request(app).get("/v1/client/invoices").set(auth(token))).status).toBe(403);
  });

  it("an online campaign payment is invoiced with GST on top, receipted and emailed — once", async () => {
    const b = await prisma.campaignBooking.create({
      data: {
        clientId, name: "Diwali push", brand: "Filmy", status: "paid_pending_review", totalPaise: 1_392_400, submittedAt: new Date(), paidAt: new Date(),
        items: { create: [
          { rateCardId: "rc-1", targetType: "meta_asset", targetId: "a1", platform: "instagram", format: "reel", accountName: "Bollywood Society", accountHandle: "bs", pricePaise: 700_000, status: "pending" },
          { rateCardId: "rc-2", targetType: "meta_asset", targetId: "a2", platform: "facebook", format: "post", accountName: "Filmy Page", pricePaise: 480_000, status: "pending" },
        ] },
      },
    });
    // Checkout charged ₹11,800 of rate cards + 18% GST = ₹13,924.
    const r = await billOnlineBookingPayment(b.id, "pay_test123", 1_392_400);
    await flushSalesBackground();
    const inv = await prisma.salesInvoice.findUnique({ where: { id: r.invoiceId! } });
    // Rate-card prices are the taxable value with 18% GST on top — exactly what checkout charged.
    expect(inv).toMatchObject({ status: "paid", taxablePaise: 1_180_000, cgstPaise: 106_200, sgstPaise: 106_200, totalPaise: 1_392_400, paidPaise: 1_392_400, campaignBookingId: b.id });
    const pay = await prisma.salesPayment.findUnique({ where: { id: r.paymentId! } });
    expect(pay).toMatchObject({ mode: "razorpay", reference: "pay_test123", amountPaise: 1_392_400, recordedById: "system" });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("payment of ₹13,924.00 received (paid in full)");

    // The webhook can arrive twice: no second receipt, invoice or email.
    const again = await billOnlineBookingPayment(b.id, "pay_test123", 1_392_400);
    await flushSalesBackground();
    expect(again.paymentId).toBe(r.paymentId);
    expect(await prisma.salesPayment.count()).toBe(1);
    expect(await prisma.salesInvoice.count()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("campaign checkout pricing equals the booking's tax invoice total", async () => {
    const pricing = await campaignPricing(clientId, [700_000, 480_000]);
    expect(pricing).toMatchObject({ subtotalPaise: 1_180_000, taxMode: "intra", cgstPaise: 106_200, sgstPaise: 106_200, gstPaise: 212_400, totalPaise: 1_392_400 });
    // A client billed from another state pays IGST; export / no state on file → as resolved for the invoice.
    await prisma.clientBillingProfile.update({ where: { clientId }, data: { stateCode: "07", state: "Delhi" } });
    expect(await campaignPricing(clientId, [100_000])).toMatchObject({ taxMode: "inter", igstPaise: 18_000, totalPaise: 118_000 });
    expect(itemGstPaise(100_000, { taxMode: "inter", gstRateBp: 1800 })).toBe(18_000);
    expect(itemGstPaise(100_000, { taxMode: "none", gstRateBp: 1800 })).toBe(0);
  });
});
