/**
 * The billing follow-ups (2026-10-27): voiding a recorded payment, credit released by a credit note
 * after payment, refunds out of a receipt's unallocated cash, the credit-note PDF, and converting a
 * proforma into a tax invoice that carries its payments.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { financialYear, todayIST } from "@dashmani/shared";

const SELLER = {
  legalName: "Dashmani Media Private Limited", gstin: "27AAACD1234E1Z5", pan: "AAACD1234E", addressLine1: "Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "DS", creditNotePrefix: "CN", defaultDueDays: 15, roundToRupee: true,
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("billing follow-ups", () => {
  let token: string;
  let clientMh: string;
  let fyShort: string;
  const today = todayIST();

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: "sales.seller" } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ name: "Biller", roleNames: ["Sales"] });
    const a = await createTestUser({ name: "Office Admin", roleNames: ["Admin"] });
    token = generateToken(u.id, u.email, ["Sales"]);
    const adminToken = generateToken(a.id, a.email, ["Admin"]);
    const mh = await prisma.client.create({ data: { companyName: "Filmy Brands", contactName: "Riya", email: "riya@filmy.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: mh.id, legalName: "Filmy Brands Pvt Ltd", gstin: "27AABCU9603R1ZX", stateCode: "27", state: "Maharashtra", city: "Mumbai" } });
    clientMh = mh.id;
    fyShort = financialYear(today).short;
    expect((await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER)).status).toBe(200);
  });

  const api = () => request(app);
  const draft = (extra: Record<string, unknown> = {}, unit = 100_000) =>
    api().post("/v1/sales/invoices").set(auth(token)).send({ clientId: clientMh, items: [{ description: "Reel on Bollywood Society", quantity: 1, unitPricePaise: unit }], ...extra });
  const issue = (id: string, body: Record<string, unknown> = {}) => api().post(`/v1/sales/invoices/${id}/issue`).set(auth(token)).send(body);
  async function issued(extra: Record<string, unknown> = {}, unit = 100_000) {
    const d = (await draft(extra, unit)).body.data;
    const i = await issue(d.id);
    expect(i.status).toBe(200);
    return i.body.data as { id: string; number: string; totalPaise: number };
  }
  const receipt = (amountPaise: number, allocations: Array<{ invoiceId: string; amountPaise: number }> = []) =>
    api().post("/v1/sales/payments").set(auth(token)).send({ clientId: clientMh, amountPaise, mode: "bank_transfer", paidOn: today, allocations });
  const inv = (id: string) => api().get(`/v1/sales/invoices/${id}`).set(auth(token)).then((r) => r.body.data);
  const statement = () => api().get(`/v1/sales/clients/${clientMh}/statement`).set(auth(token)).then((r) => r.body.data);

  // ── Void ──────────────────────────────────────────────────────────────────────────

  it("voids a receipt recorded by mistake: the invoice reopens, the number stays, the money stops counting", async () => {
    const i = await issued(); // ₹1,180
    const p = (await receipt(i.totalPaise, [{ invoiceId: i.id, amountPaise: i.totalPaise }])).body.data;
    expect((await inv(i.id)).derivedStatus).toBe("paid");
    const v = await api().post(`/v1/sales/payments/${p.id}/void`).set(auth(token)).send({ reason: "Cheque bounced" });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ number: p.number, status: "voided", voidReason: "Cheque bounced", unallocatedPaise: 0 });
    expect(await inv(i.id)).toMatchObject({ status: "issued", paidPaise: 0, balancePaise: i.totalPaise });
    expect((await statement()).totals).toMatchObject({ collectedPaise: 0, outstandingPaise: i.totalPaise });
    const dash = (await api().get("/v1/sales/dashboard").set(auth(token))).body.data;
    expect(dash.collectedFyPaise).toBe(0);
    // Idempotent, and a voided receipt cannot be applied or refunded.
    expect((await api().post(`/v1/sales/payments/${p.id}/void`).set(auth(token)).send({ reason: "again" })).status).toBe(200);
    expect((await api().post(`/v1/sales/payments/${p.id}/allocations`).set(auth(token)).send({ allocations: [{ invoiceId: i.id, amountPaise: 100 }] })).body.error.code).toBe("PAYMENT_VOIDED");
    expect((await api().post(`/v1/sales/payments/${p.id}/refunds`).set(auth(token)).send({ amountPaise: 100, mode: "upi", refundedOn: today })).body.error.code).toBe("PAYMENT_VOIDED");
  });

  it("will not void a receipt with a live refund until the refund is cancelled", async () => {
    const p = (await receipt(100_000)).body.data; // an advance of ₹1,000
    const r = await api().post(`/v1/sales/payments/${p.id}/refunds`).set(auth(token)).send({ amountPaise: 20_000, mode: "upi", reference: "UTR9", refundedOn: today });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ refundedPaise: 20_000, unallocatedPaise: 80_000 });
    expect(r.body.data.refunds[0].number).toBe(`RF/${fyShort}/0001`);
    expect((await api().post(`/v1/sales/payments/${p.id}/void`).set(auth(token)).send({ reason: "Wrong client" })).body.error.code).toBe("PAYMENT_HAS_REFUNDS");
    const c = await api().post(`/v1/sales/refunds/${r.body.data.refunds[0].id}/cancel`).set(auth(token));
    expect(c.body.data).toMatchObject({ refundedPaise: 0, unallocatedPaise: 100_000 });
    expect((await api().post(`/v1/sales/payments/${p.id}/void`).set(auth(token)).send({ reason: "Wrong client" })).status).toBe(200);
  });

  // ── Credit after payment, refunds ─────────────────────────────────────────────────

  it("returns the excess to the receipt when a paid invoice is credited, and lets it be refunded", async () => {
    const i = await issued(); // ₹1,000 + CGST/SGST = ₹1,180
    const p = (await receipt(118_000, [{ invoiceId: i.id, amountPaise: 118_000 }])).body.data;
    const cn = await api().post("/v1/sales/credit-notes").set(auth(token)).send({ invoiceId: i.id, reason: "One reel dropped", taxablePaise: 50_000 });
    expect(cn.status).toBe(201);
    expect(cn.body.data.totalPaise).toBe(59_000);
    // Paid ₹1,180 + credited ₹590 on a ₹1,180 invoice: ₹590 goes back to the receipt.
    expect(await inv(i.id)).toMatchObject({ paidPaise: 59_000, creditedPaise: 59_000, balancePaise: 0, derivedStatus: "paid" });
    const pay = (await api().get(`/v1/sales/payments/${p.id}`).set(auth(token))).body.data;
    expect(pay).toMatchObject({ allocatedPaise: 59_000, unallocatedPaise: 59_000 });
    expect((await statement()).totals).toMatchObject({ unappliedPaise: 59_000, collectedPaise: 118_000 });
    // Refund it (not more, not before the receipt).
    expect((await api().post(`/v1/sales/payments/${p.id}/refunds`).set(auth(token)).send({ amountPaise: 59_100, mode: "bank_transfer", refundedOn: today })).body.error.code).toBe("OVER_REFUNDED");
    expect((await api().post(`/v1/sales/payments/${p.id}/refunds`).set(auth(token)).send({ amountPaise: 1_000, mode: "bank_transfer", refundedOn: "2020-01-01" })).body.error.code).toBe("REFUND_BEFORE_PAYMENT");
    expect((await api().post(`/v1/sales/payments/${p.id}/refunds`).set(auth(token)).send({ amountPaise: 59_000, mode: "bank_transfer", reference: "NEFT77", refundedOn: today })).status).toBe(201);
    expect((await statement()).totals).toMatchObject({ unappliedPaise: 0, refundedPaise: 59_000, collectedPaise: 59_000 });
    const dash = (await api().get("/v1/sales/dashboard").set(auth(token))).body.data;
    expect(dash.collectedFyPaise).toBe(59_000);
  });

  it("prints a credit note PDF", async () => {
    const i = await issued();
    const made = await api().post("/v1/sales/credit-notes").set(auth(token)).send({ invoiceId: i.id, reason: "Placement not delivered", taxablePaise: 100_000 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const cn = made.body.data;
    const pdf = await api().get(`/v1/sales/credit-notes/${cn.id}/pdf`).set(auth(token)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain(`${cn.number.replace(/\//g, "-")}.pdf`);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  // ── Proforma → tax invoice ────────────────────────────────────────────────────────

  it("converts a paid proforma into a tax invoice that carries its payment, and retires the proforma", async () => {
    const pf = await issued({ kind: "proforma" });
    expect(pf.number).toBe(`PI/${fyShort}/0001`);
    const p = (await receipt(pf.totalPaise, [{ invoiceId: pf.id, amountPaise: pf.totalPaise }])).body.data;
    const conv = await api().post(`/v1/sales/invoices/${pf.id}/convert`).set(auth(token));
    expect(conv.status).toBe(201);
    expect(conv.body.data).toMatchObject({ kind: "tax_invoice", status: "draft", totalPaise: pf.totalPaise, convertedFrom: { id: pf.id, number: pf.number } });
    expect((await api().post(`/v1/sales/invoices/${pf.id}/convert`).set(auth(token))).body.error.code).toBe("ALREADY_CONVERTED");
    const ti = await issue(conv.body.data.id);
    expect(ti.status).toBe(200);
    expect(ti.body.data).toMatchObject({ number: `DS/${fyShort}/0001`, paidPaise: pf.totalPaise, derivedStatus: "paid" });
    expect(await inv(pf.id)).toMatchObject({ status: "cancelled", paidPaise: 0, cancelReason: `Converted to tax invoice DS/${fyShort}/0001`, conversions: [{ id: conv.body.data.id }] });
    const alloc = await prisma.salesPaymentAllocation.findMany({ where: { paymentId: p.id } });
    expect(alloc.map((a) => a.invoiceId)).toEqual([conv.body.data.id]);
    expect((await statement()).totals).toMatchObject({ invoicedPaise: pf.totalPaise, outstandingPaise: 0, unappliedPaise: 0 });
    // Only a live proforma converts.
    expect((await api().post(`/v1/sales/invoices/${conv.body.data.id}/convert`).set(auth(token))).body.error.code).toBe("NOT_PROFORMA");
    expect((await api().post(`/v1/sales/invoices/${pf.id}/convert`).set(auth(token))).status).toBe(409);
  });

  it("returns the difference to the receipt when the converted tax invoice comes out smaller", async () => {
    const pf = await issued({ kind: "proforma" }); // ₹1,180
    const p = (await receipt(118_000, [{ invoiceId: pf.id, amountPaise: 118_000 }])).body.data;
    const conv = (await api().post(`/v1/sales/invoices/${pf.id}/convert`).set(auth(token))).body.data;
    // Half the work was delivered: edit the draft down to ₹500 (+ GST = ₹590).
    await api().put(`/v1/sales/invoices/${conv.id}`).set(auth(token)).send({ clientId: clientMh, items: [{ description: "Reel on Bollywood Society", quantity: 1, unitPricePaise: 50_000 }] });
    const ti = (await issue(conv.id)).body.data;
    expect(ti).toMatchObject({ totalPaise: 59_000, paidPaise: 59_000, derivedStatus: "paid" });
    expect((await api().get(`/v1/sales/payments/${p.id}`).set(auth(token))).body.data).toMatchObject({ allocatedPaise: 59_000, unallocatedPaise: 59_000 });
  });

  it("does not treat the proforma an order's lines sit on as a second bill when its conversion is issued", async () => {
    const order = (await api().post("/v1/sales/orders").set(auth(token)).send({ clientId: clientMh, title: "Reels", items: [{ description: "Reel", quantity: 1, unitPricePaise: 200_000 }] })).body.data;
    await api().post(`/v1/sales/orders/${order.id}/confirm`).set(auth(token));
    const line = await prisma.salesOrderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const pf = (await draft({ kind: "proforma", orderId: order.id, items: [{ description: "Reel", quantity: 1, unitPricePaise: 200_000, orderItemId: line.id }] })).body.data;
    expect((await issue(pf.id)).status).toBe(200);
    // "Create invoice" on the order points at the proforma instead of billing twice…
    const again = await api().post(`/v1/sales/orders/${order.id}/invoice`).set(auth(token));
    expect(again.body.error.code).toBe("ORDER_ALREADY_INVOICED");
    expect(again.body.error.message).toContain("convert that proforma");
    // …and the conversion issues cleanly.
    const conv = (await api().post(`/v1/sales/invoices/${pf.id}/convert`).set(auth(token))).body.data;
    expect((await issue(conv.id)).status).toBe(200);
  });
});
