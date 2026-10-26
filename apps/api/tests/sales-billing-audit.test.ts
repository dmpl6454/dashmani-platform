/**
 * Billing audit (2026-10-26): the GST invoice / payment / credit-note rules that matter for
 * compliance and for the books, each pinned by a test. Covers the defects the audit found
 * (proforma serials, double issue, concurrent settlement, money beyond the INT columns, GST
 * number format, stale GST type at issue, proformas in receivables, double billing an order,
 * due date before issue date) and re-checks the rules that already held.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { computeTotals, financialYear, rupeesInWords, todayIST } from "@dashmani/shared";

const SELLER = {
  legalName: "Dashmani Media Private Limited", gstin: "27AAACD1234E1Z5", pan: "AAACD1234E", addressLine1: "Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "DS", creditNotePrefix: "CN", defaultDueDays: 15, roundToRupee: true,
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("billing audit", () => {
  let token: string;
  let adminToken: string;
  let clientMh: string; // Maharashtra (same state as the seller)
  let clientKa: string; // Karnataka
  let fyShort: string;

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: "sales.seller" } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ name: "Biller", roleNames: ["Sales"] });
    token = generateToken(u.id, u.email, ["Sales"]);
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const a = await createTestUser({ name: "Office Admin", roleNames: ["Admin"] });
    adminToken = generateToken(a.id, a.email, ["Admin"]);
    const mh = await prisma.client.create({ data: { companyName: "Filmy Brands", contactName: "Riya", email: "riya@filmy.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: mh.id, legalName: "Filmy Brands Pvt Ltd", gstin: "27AABCU9603R1ZX", stateCode: "27", state: "Maharashtra", city: "Mumbai" } });
    const ka = await prisma.client.create({ data: { companyName: "Bengaluru Apps", contactName: "Arjun", email: "arjun@blr.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: ka.id, legalName: "Bengaluru Apps LLP", gstin: "29AAACB1234F1Z9", stateCode: "29", state: "Karnataka" } });
    clientMh = mh.id;
    clientKa = ka.id;
    fyShort = financialYear(todayIST()).short;
  });

  const api = () => request(app);
  const saveSeller = (extra: Record<string, unknown> = {}) => api().put("/v1/sales/settings/seller").set(auth(adminToken)).send({ ...SELLER, ...extra });
  const draft = (clientId: string, extra: Record<string, unknown> = {}, unit = 100_000) =>
    api().post("/v1/sales/invoices").set(auth(token)).send({ clientId, items: [{ description: "Reel on Bollywood Society", quantity: 1, unitPricePaise: unit }], ...extra });
  const issue = (id: string, body: Record<string, unknown> = {}) => api().post(`/v1/sales/invoices/${id}/issue`).set(auth(token)).send(body);
  const pay = (clientId: string, invoiceId: string, amountPaise: number, tdsPaise = 0) =>
    api().post("/v1/sales/payments").set(auth(token)).send({ clientId, amountPaise, tdsPaise, mode: "bank_transfer", paidOn: todayIST(), allocations: [{ invoiceId, amountPaise, tdsPaise }] });
  const credit = (invoiceId: string, taxablePaise: number) => api().post("/v1/sales/credit-notes").set(auth(token)).send({ invoiceId, reason: "Placement not delivered", taxablePaise });
  async function issued(clientId: string, extra: Record<string, unknown> = {}, unit = 100_000) {
    const d = await draft(clientId, extra, unit);
    expect(d.status).toBe(201);
    const i = await issue(d.body.data.id);
    expect(i.status).toBe(200);
    return i.body.data as { id: string; number: string; totalPaise: number; taxablePaise: number };
  }

  // ── GST serial numbers ────────────────────────────────────────────────────────────

  it("numbers proformas in their own series, so tax invoice serials stay consecutive", async () => {
    expect((await saveSeller()).status).toBe(200);
    expect((await issued(clientMh)).number).toBe(`DS/${fyShort}/0001`);
    expect((await issued(clientMh, { kind: "proforma" })).number).toBe(`PI/${fyShort}/0001`);
    expect((await issued(clientMh)).number).toBe(`DS/${fyShort}/0002`);
  });

  it("issues a draft once even when Issue is sent twice at the same moment", async () => {
    await saveSeller();
    const d = (await draft(clientMh)).body.data;
    const [a, b] = await Promise.all([issue(d.id), issue(d.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const inv = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: d.id } });
    expect(inv.number).toBe(`DS/${fyShort}/0001`);
    expect((await issued(clientMh)).number).toBe(`DS/${fyShort}/0002`); // no serial was burned
  });

  it("starts a new series on 1 April and keeps backdated invoices in their own year", async () => {
    await saveSeller();
    const y = Number(todayIST().slice(0, 4));
    const fyEnd = `${y + 1}-03-31`;
    const fyNext = `${y + 1}-04-01`;
    const d1 = (await draft(clientMh)).body.data;
    const d2 = (await draft(clientMh)).body.data;
    expect((await issue(d1.id, { issueDate: fyEnd, dueDate: fyEnd })).body.data.number).toBe(`DS/${financialYear(fyEnd).short}/0001`);
    expect((await issue(d2.id, { issueDate: fyNext, dueDate: fyNext })).body.data.number).toBe(`DS/${financialYear(fyNext).short}/0001`);
  });

  it("keeps invoice and credit-note numbers within GST's 16 characters of letters, digits, - and /", async () => {
    expect((await saveSeller({ invoicePrefix: "DSMEDIAPVT" })).status).toBe(400);
    expect((await saveSeller({ invoicePrefix: "DS M" })).status).toBe(400);
    expect((await saveSeller({ creditNotePrefix: "CREDITNOTE" })).status).toBe(400);
    expect((await saveSeller({ invoicePrefix: "DSM-1" })).status).toBe(200);
    const n = (await issued(clientMh)).number;
    expect(n).toBe(`DSM-1/${fyShort}/0001`);
    expect(n.length).toBeLessThanOrEqual(16);
    expect(n).toMatch(/^[A-Za-z0-9/-]+$/);
  });

  // ── Issue-time checks ─────────────────────────────────────────────────────────────

  it("refuses a due date before the issue date", async () => {
    await saveSeller();
    const d = (await draft(clientMh)).body.data;
    const res = await issue(d.id, { issueDate: "2026-10-26", dueDate: "2026-10-01" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DUE_BEFORE_ISSUE");
  });

  it("catches a GST type that went stale between saving the draft and issuing it", async () => {
    // Drafted while no profile was saved: the fallback seller is in Maharashtra, so a Mumbai buyer is CGST+SGST.
    const d = (await draft(clientMh)).body.data;
    expect(d.taxMode).toBe("intra");
    // The real profile says Delhi: the same buyer is now inter-state (IGST).
    await saveSeller({ stateCode: "07", state: "Delhi", gstin: "07AAACD1234E1Z5" });
    const blocked = await issue(d.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("TAX_CHANGED");
    expect(await prisma.salesInvoice.findUniqueOrThrow({ where: { id: d.id }, select: { number: true } })).toEqual({ number: null });
    const fixed = await issue(d.id, { taxResolution: "recompute" });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data).toMatchObject({ taxMode: "inter", cgstPaise: 0, sgstPaise: 0, igstPaise: 18_000, totalPaise: 118_000, amountInWords: "Rupees One Thousand One Hundred Eighty Only" });
    // Keeping a deliberate choice (e.g. an SEZ buyer) is possible too.
    const sez = (await draft(clientMh, { taxMode: "none" })).body.data;
    expect((await issue(sez.id)).status).toBe(409);
    expect((await issue(sez.id, { taxResolution: "keep" })).body.data).toMatchObject({ taxMode: "none", totalPaise: 100_000 });
  });

  // ── Money limits ──────────────────────────────────────────────────────────────────

  it("refuses amounts the INT money columns cannot hold, with a clear error instead of a 500", async () => {
    await saveSeller();
    expect((await draft(clientMh, {}, 3_000_000_000)).status).toBe(400); // ₹3 crore in one field
    const big = await api().post("/v1/sales/invoices").set(auth(token)).send({ clientId: clientMh, items: [{ description: "Year-long package", quantity: 2, unitPricePaise: 1_500_000_000 }] });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe("AMOUNT_TOO_LARGE");
    const q = await api().post("/v1/sales/quotes").set(auth(token)).send({ clientId: clientMh, title: "Big", items: [{ description: "x", quantity: 2, unitPricePaise: 1_500_000_000 }] });
    expect(q.status).toBe(422);
    expect((await api().post("/v1/sales/payments").set(auth(token)).send({ clientId: clientMh, amountPaise: 3_000_000_000, mode: "upi", paidOn: todayIST() })).status).toBe(400);
  });

  // ── Settlement under concurrency ──────────────────────────────────────────────────

  it("never lets two simultaneous payments settle more than the invoice total", async () => {
    await saveSeller();
    const inv = await issued(clientMh);
    const [a, b] = await Promise.all([pay(clientMh, inv.id, inv.totalPaise), pay(clientMh, inv.id, inv.totalPaise)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.paidPaise).toBe(inv.totalPaise);
    expect(row.status).toBe("paid");
  });

  it("never lets two simultaneous credit notes credit more than the taxable value", async () => {
    await saveSeller();
    const inv = await issued(clientMh);
    const part = Math.round(inv.taxablePaise * 0.6);
    const [a, b] = await Promise.all([credit(inv.id, part), credit(inv.id, part)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const sum = await prisma.salesCreditNote.aggregate({ where: { invoiceId: inv.id, status: "issued" }, _sum: { taxablePaise: true } });
    expect(sum._sum.taxablePaise).toBe(part);
  });

  it("does not cancel an invoice that took a payment at the same moment", async () => {
    await saveSeller();
    const inv = await issued(clientMh);
    const [p, c] = await Promise.all([pay(clientMh, inv.id, 50_000), api().post(`/v1/sales/invoices/${inv.id}/cancel`).set(auth(token)).send({ reason: "Raised by mistake" })]);
    const row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    // Either order is fine, but never both: a cancelled invoice must carry no payment.
    if (row.status === "cancelled") {
      expect(p.status).toBe(409);
      expect(row.paidPaise).toBe(0);
    } else {
      expect(c.status).toBe(409);
      expect(row.paidPaise).toBe(50_000);
    }
  });

  // ── Receivables ───────────────────────────────────────────────────────────────────

  it("keeps proforma balances out of a client's outstanding and overdue", async () => {
    await saveSeller();
    const p = (await draft(clientMh, { kind: "proforma" })).body.data;
    await issue(p.id, { issueDate: "2026-01-01", dueDate: "2026-01-15" });
    const st = await api().get(`/v1/sales/clients/${clientMh}/statement`).set(auth(token));
    expect(st.body.data.totals).toMatchObject({ outstandingPaise: 0, overduePaise: 0, invoicedPaise: 0 });
    const list = await api().get("/v1/sales/clients").set(auth(token));
    expect(list.body.data.find((c: { id: string }) => c.id === clientMh).outstandingPaise).toBe(0);
  });

  it("will not invoice the same order twice while an invoice for it is live", async () => {
    await saveSeller();
    const order = await api().post("/v1/sales/orders").set(auth(token)).send({ clientId: clientMh, title: "Diwali reels", items: [{ description: "Reel", quantity: 1, unitPricePaise: 200_000 }] });
    expect(order.status).toBe(201);
    expect((await api().post(`/v1/sales/orders/${order.body.data.id}/confirm`).set(auth(token))).status).toBe(200);
    const first = await api().post(`/v1/sales/orders/${order.body.data.id}/invoice`).set(auth(token));
    expect(first.status).toBe(201);
    const again = await api().post(`/v1/sales/orders/${order.body.data.id}/invoice`).set(auth(token));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ORDER_ALREADY_INVOICED");
    // Deleting the draft frees the order for a fresh invoice.
    await api().post(`/v1/sales/invoices/${first.body.data.id}/cancel`).set(auth(token)).send({ reason: "redo" });
    expect((await api().post(`/v1/sales/orders/${order.body.data.id}/invoice`).set(auth(token))).status).toBe(201);
  });

  it("will not invoice the same campaign booking twice", async () => {
    await saveSeller();
    const booking = await prisma.campaignBooking.create({
      data: {
        clientId: clientMh, name: "Spring launch", brand: "Filmy", status: "paid_pending_review", totalPaise: 5_000_000,
        items: { create: [{ rateCardId: "rc-1", targetType: "meta_asset", targetId: "asset-1", platform: "instagram", format: "reel", accountName: "Bollywood Society", pricePaise: 5_000_000, status: "pending" }] },
      },
    });
    expect((await api().post(`/v1/sales/invoices/from-booking/${booking.id}`).set(auth(token))).status).toBe(201);
    const again = await api().post(`/v1/sales/invoices/from-booking/${booking.id}`).set(auth(token));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("BOOKING_ALREADY_INVOICED");
  });

  // ── Second round (independent review) ─────────────────────────────────────────────

  it("lets only an admin change the company GST and bank details", async () => {
    expect((await api().put("/v1/sales/settings/seller").set(auth(token)).send(SELLER)).status).toBe(403);
    expect((await saveSeller()).status).toBe(200);
  });

  it("adds split credit notes back up to exactly the invoice total", async () => {
    await saveSeller();
    const halves = await issued(clientMh, {}, 10_050); // ₹100.50 + CGST/SGST ₹9.05 each = ₹118.60 → ₹119
    expect(halves.totalPaise).toBe(11_900);
    expect((await credit(halves.id, 5_025)).status).toBe(201);
    expect((await credit(halves.id, 5_025)).status).toBe(201);
    let row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: halves.id } });
    expect(row).toMatchObject({ creditedPaise: 11_900, status: "paid" });
    const thirds = await issued(clientMh, {}, 10_050);
    for (let i = 0; i < 3; i++) expect((await credit(thirds.id, 3_350)).status).toBe(201);
    row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: thirds.id } });
    expect(row.creditedPaise).toBe(11_900); // per-note rounding used to give ₹120 here
    const notes = await prisma.salesCreditNote.findMany({ where: { invoiceId: thirds.id }, orderBy: { createdAt: "asc" } });
    expect(notes.reduce((s, n) => s + n.cgstPaise, 0)).toBe(row.cgstPaise);
    expect(notes.reduce((s, n) => s + n.sgstPaise, 0)).toBe(row.sgstPaise);
  });

  it("applies an advance recorded before the invoice existed, and tops up an allocation", async () => {
    await saveSeller();
    const advance = await api().post("/v1/sales/payments").set(auth(token)).send({ clientId: clientMh, amountPaise: 150_000, mode: "bank_transfer", paidOn: todayIST() });
    expect(advance.status).toBe(201);
    const inv = await issued(clientMh); // ₹1,180
    const apply = (amountPaise: number, invoiceId = inv.id) => api().post(`/v1/sales/payments/${advance.body.data.id}/allocations`).set(auth(token)).send({ allocations: [{ invoiceId, amountPaise }] });
    expect((await apply(50_000)).status).toBe(200);
    expect((await apply(50_000)).status).toBe(200); // the same invoice again: one allocation, topped up
    const allocs = await prisma.salesPaymentAllocation.findMany({ where: { paymentId: advance.body.data.id } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0].amountPaise).toBe(100_000);
    expect((await apply(60_000)).body.error.code).toBe("OVER_ALLOCATED"); // only ₹500 left on the receipt
    const other = await issued(clientKa);
    expect((await apply(10_000, other.id)).body.error.code).toBe("WRONG_CLIENT");
    const view = await api().get(`/v1/sales/invoices/${inv.id}`).set(auth(token));
    expect(view.body.data).toMatchObject({ paidPaise: 100_000, balancePaise: 18_000, derivedStatus: "partially_paid" });
  });

  it("freezes an order's lines once it is invoiced, so an edit cannot hide them from the double-billing check", async () => {
    await saveSeller();
    const body = { clientId: clientMh, title: "Diwali reels", items: [{ description: "Reel", quantity: 1, unitPricePaise: 200_000 }] };
    const order = (await api().post("/v1/sales/orders").set(auth(token)).send(body)).body.data;
    await api().post(`/v1/sales/orders/${order.id}/confirm`).set(auth(token));
    const draftInv = (await api().post(`/v1/sales/orders/${order.id}/invoice`).set(auth(token))).body.data;
    const edit = await api().put(`/v1/sales/orders/${order.id}`).set(auth(token)).send({ ...body, items: [...body.items, { description: "Extra story", quantity: 1, unitPricePaise: 50_000 }] });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("ORDER_INVOICED");
    await api().post(`/v1/sales/invoices/${draftInv.id}/cancel`).set(auth(token)).send({ reason: "Draft deleted" });
    expect((await api().put(`/v1/sales/orders/${order.id}`).set(auth(token)).send(body)).status).toBe(200);
  });

  it("refuses at issue time a second invoice for order lines or a booking already billed", async () => {
    await saveSeller();
    const order = (await api().post("/v1/sales/orders").set(auth(token)).send({ clientId: clientMh, title: "Reels", items: [{ description: "Reel", quantity: 1, unitPricePaise: 200_000 }] })).body.data;
    await api().post(`/v1/sales/orders/${order.id}/confirm`).set(auth(token));
    const lineId = (await prisma.salesOrderItem.findFirstOrThrow({ where: { orderId: order.id } })).id;
    // Two drafts for the same line (two quick "Create invoice" clicks end up like this).
    const dupBody = { orderId: order.id, items: [{ description: "Reel", quantity: 1, unitPricePaise: 200_000, orderItemId: lineId }] };
    const d1 = (await draft(clientMh, dupBody)).body.data;
    const d2 = (await draft(clientMh, dupBody)).body.data;
    expect((await issue(d1.id)).status).toBe(200);
    const second = await issue(d2.id);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ORDER_ALREADY_INVOICED");
    const booking = await prisma.campaignBooking.create({ data: { clientId: clientMh, name: "Launch", brand: "Filmy", status: "paid_pending_review", totalPaise: 100_000 } });
    const b1 = (await draft(clientMh, { campaignBookingId: booking.id })).body.data;
    const b2 = (await draft(clientMh, { campaignBookingId: booking.id })).body.data;
    expect((await issue(b1.id)).status).toBe(200);
    expect((await issue(b2.id)).body.error.code).toBe("BOOKING_ALREADY_INVOICED");
  });

  it("never numbers figures that an edit replaced, nor edits a numbered invoice", async () => {
    await saveSeller();
    const d = (await draft(clientMh)).body.data;
    const [, upd] = await Promise.all([
      issue(d.id),
      api().put(`/v1/sales/invoices/${d.id}`).set(auth(token)).send({ clientId: clientMh, items: [{ description: "Bigger package", quantity: 3, unitPricePaise: 250_000 }] }),
    ]);
    const row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: d.id }, include: { items: true } });
    expect(row.status).toBe("issued");
    // Whatever the order, the numbered document is internally consistent…
    const t = computeTotals({ lines: row.items, discountPaise: row.discountPaise, taxMode: row.taxMode as "intra", gstRateBp: row.gstRateBp });
    expect(row.totalPaise).toBe(t.totalPaise);
    expect(row.amountInWords).toBe(rupeesInWords(row.totalPaise));
    // …and an edit that lost the race was refused, not applied afterwards.
    if (upd.status !== 200) expect(upd.body.error.code).toBe("INVOICE_LOCKED");
  });

  it("refuses dates that do not exist and a GSTIN that disagrees with its state", async () => {
    await saveSeller();
    expect((await draft(clientMh, { dueDate: "2026-02-31" })).status).toBe(400);
    expect((await api().post("/v1/sales/payments").set(auth(token)).send({ clientId: clientMh, amountPaise: 100, mode: "upi", paidOn: "2026-13-45" })).status).toBe(400);
    const mismatch = await api().put(`/v1/sales/clients/${clientKa}/billing`).set(auth(token)).send({ legalName: "Bengaluru Apps LLP", gstin: "29AAACB1234F1Z9", stateCode: "27" });
    expect(mismatch.status).toBe(400);
    const derived = await api().put(`/v1/sales/clients/${clientKa}/billing`).set(auth(token)).send({ legalName: "Bengaluru Apps LLP", gstin: "29AAACB1234F1Z9" });
    expect(derived.status).toBe(200);
    expect(await prisma.clientBillingProfile.findUniqueOrThrow({ where: { clientId: clientKa }, select: { stateCode: true, state: true } })).toEqual({ stateCode: "29", state: "Karnataka" });
  });

  it("buckets an order made at 00:30 IST on 1 April into the new financial year", async () => {
    await saveSeller();
    const order = (await api().post("/v1/sales/orders").set(auth(token)).send({ clientId: clientMh, title: "FY edge", items: [{ description: "Reel", quantity: 1, unitPricePaise: 300_000 }] })).body.data;
    await api().post(`/v1/sales/orders/${order.id}/confirm`).set(auth(token));
    await prisma.salesOrder.update({ where: { id: order.id }, data: { createdAt: new Date("2027-03-31T19:00:00.000Z"), startDate: null } }); // 1 Apr 2027, 00:30 IST
    const dash = await api().get("/v1/sales/dashboard").set(auth(token));
    expect(dash.body.data.ordersByFy.find((r: { financialYear: string }) => r.financialYear === "2027-28")).toMatchObject({ count: 1, totalPaise: order.totalPaise });
  });

  // ── Rules that already held (re-checked) ──────────────────────────────────────────

  it("refuses payments to another client's, a draft or a cancelled invoice, and over-allocation", async () => {
    await saveSeller();
    const inv = await issued(clientMh);
    expect((await pay(clientKa, inv.id, 1_000)).body.error.code).toBe("WRONG_CLIENT");
    const d = (await draft(clientMh)).body.data;
    expect((await pay(clientMh, d.id, 1_000)).body.error.code).toBe("NOT_ISSUED");
    expect((await pay(clientMh, inv.id, inv.totalPaise + 100)).body.error.code).toBe("OVER_ALLOCATED");
    const bad = await api().post("/v1/sales/payments").set(auth(token)).send({ clientId: clientMh, amountPaise: 100, mode: "upi", paidOn: todayIST(), allocations: [{ invoiceId: inv.id, amountPaise: 200 }] });
    expect(bad.status).toBe(400);
    const other = await issued(clientMh);
    await api().post(`/v1/sales/invoices/${other.id}/cancel`).set(auth(token)).send({ reason: "Raised by mistake" });
    expect((await pay(clientMh, other.id, 1_000)).body.error.code).toBe("NOT_ISSUED");
  });

  it("settles with TDS and credit notes, and reopens when a credit note is cancelled", async () => {
    await saveSeller();
    const inv = await issued(clientKa); // IGST: ₹1,000 + ₹180
    expect(inv.totalPaise).toBe(118_000);
    expect((await pay(clientKa, inv.id, 98_000, 10_000)).status).toBe(201);
    const cn = await credit(inv.id, 8_475); // ₹84.75 + IGST ₹15.26 = ₹100.01 → rounds to ₹100
    expect(cn.status).toBe(201);
    let row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row).toMatchObject({ paidPaise: 98_000, tdsPaise: 10_000, creditedPaise: 10_000, status: "paid" });
    expect((await api().post(`/v1/sales/credit-notes/${cn.body.data.id}/cancel`).set(auth(token))).status).toBe(200);
    row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row).toMatchObject({ creditedPaise: 0, status: "issued", paidAt: null });
    const view = await api().get(`/v1/sales/invoices/${inv.id}`).set(auth(token));
    expect(view.body.data).toMatchObject({ balancePaise: 10_000, derivedStatus: "partially_paid" });
  });

  it("splits CGST and SGST into equal halves and prints the round-off", async () => {
    await saveSeller();
    const inv = await issued(clientMh, {}, 100_001);
    const row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row).toMatchObject({ taxablePaise: 100_001, cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0, roundOffPaise: -1, totalPaise: 118_000 });
  });
  // The concurrency cases queue behind row locks (and behind CI's one-connection pool): give each
  // test room beyond Vitest's 5 s default so a slow runner is not mistaken for a hang.
}, 20_000);
