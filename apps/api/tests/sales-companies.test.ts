/**
 * Two billing companies: Digital Sukoon Private Limited (dspl) and Dashmani Media Private Limited
 * (dmpl). Each has its own seller profile, its own document series and its own books — a receipt
 * of one company can never settle the other's invoice, and a document never changes company.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { financialYear, todayIST } from "@dashmani/shared";

const DSPL = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702, Parinee I, Andheri West",
  city: "Mumbai", stateCode: "27", pincode: "400053", invoicePrefix: "DS", creditNotePrefix: "CN", bankName: "DSPL Bank", accountNumber: "111111",
};
const DMPL = {
  legalName: "Dashmani Media Private Limited", gstin: "27AABCD5678E1Z2", pan: "AABCD5678E", addressLine1: "1, Media House, Andheri East",
  city: "Mumbai", stateCode: "27", pincode: "400069", invoicePrefix: "DM", creditNotePrefix: "DMCN", quotePrefix: "DMQ", orderPrefix: "DMSO",
  receiptPrefix: "DMRC", bankName: "DMPL Bank", accountNumber: "222222",
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("Second billing company", () => {
  let token: string;
  let adminToken: string;
  let clientId: string;
  const fy = financialYear(todayIST()).short;

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: { in: ["sales.seller", "sales.seller.dmpl"] } } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ roleNames: ["Sales"] });
    const a = await createTestUser({ roleNames: ["Admin"] });
    token = generateToken(u.id, u.email, ["Sales"]);
    adminToken = generateToken(a.id, a.email, ["Admin"]);
    const c = await prisma.client.create({ data: { companyName: "Brand Co", contactName: "X", email: "brand@c.test", passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName: "Brand Co Pvt Ltd", gstin: "27AABCU9603R1ZX", stateCode: "27" } });
    clientId = c.id;
  });

  const save = (company: string, body: unknown) => request(app).put(`/v1/sales/settings/seller?company=${company}`).set(auth(adminToken)).send(body);
  const post = (path: string, body: unknown) => request(app).post(`/v1${path}`).set(auth(token)).send(body);
  const line = [{ description: "Reel", quantity: 1, unitPricePaise: 100_000 }];
  async function issued(companyKey: string, kind = "tax_invoice") {
    const d = await post("/sales/invoices", { companyKey, kind, clientId, items: line });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const r = await post(`/sales/invoices/${d.body.data.id}/issue`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  }

  it("keeps a profile per company: fallback, clashes, bad company", async () => {
    const fresh = await request(app).get("/v1/sales/settings/seller?company=dmpl").set(auth(token));
    expect(fresh.body.data).toMatchObject({ company: "dmpl", saved: false, profile: { legalName: "Dashmani Media Private Limited", invoicePrefix: "DM", receiptPrefix: "DMRC" } });
    expect((await request(app).get("/v1/sales/settings/seller?company=xyz").set(auth(token))).status).toBe(400);
    expect((await save("dspl", DSPL)).status).toBe(200);
    // Numbers are unique platform-wide: the second company may not reuse a prefix or a GSTIN.
    const prefix = await save("dmpl", { ...DMPL, invoicePrefix: "DS" });
    expect(prefix.status).toBe(409);
    expect(prefix.body.error?.code ?? prefix.body.code).toBe("PREFIX_TAKEN");
    const gstin = await save("dmpl", { ...DMPL, gstin: DSPL.gstin });
    expect(gstin.status).toBe(409);
    expect((await save("dmpl", DMPL)).status).toBe(200);
    // Saving one company never touches the other.
    const dspl = await request(app).get("/v1/sales/settings/seller").set(auth(token));
    expect(dspl.body.data.profile).toMatchObject({ legalName: DSPL.legalName, bankName: "DSPL Bank" });
  });

  it("numbers every document in the company's own series and prints its own details", async () => {
    expect((await save("dspl", DSPL)).status).toBe(200);
    expect((await save("dmpl", DMPL)).status).toBe(200);
    const dm = await issued("dmpl");
    expect(dm).toMatchObject({ companyKey: "dmpl", number: `DM/${fy}/0001` });
    expect(dm.sellerSnapshot).toMatchObject({ legalName: "Dashmani Media Private Limited", gstin: DMPL.gstin, bankName: "DMPL Bank", accountNumber: "222222" });
    const ds = await issued("dspl");
    expect(ds).toMatchObject({ companyKey: "dspl", number: `DS/${fy}/0001` });
    expect(ds.sellerSnapshot).toMatchObject({ legalName: DSPL.legalName, bankName: "DSPL Bank" });
    expect((await issued("dmpl", "proforma")).number).toBe(`DMPI/${fy}/0001`);
    expect((await issued("dspl", "proforma")).number).toBe(`PI/${fy}/0001`);

    const q = await post("/sales/quotes", { companyKey: "dmpl", clientId, title: "Launch", items: line.map((l) => ({ ...l, kind: "custom" })) });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body.data.number).toMatch(/^DMQ\//);
    const o = await post(`/sales/quotes/${q.body.data.id}/convert`, {});
    expect(o.body.data).toMatchObject({ companyKey: "dmpl" });
    expect(o.body.data.number).toMatch(/^DMSO\//);
    const fromOrder = await post(`/sales/orders/${o.body.data.id}/invoice`, {});
    expect(fromOrder.body.data.companyKey).toBe("dmpl");

    const cn = await post("/sales/credit-notes", { invoiceId: dm.id, reason: "Not delivered", taxablePaise: 50_000 });
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);
    expect(cn.body.data.number).toBe(`DMCN/${fy}/0001`);
    const rc = await post("/sales/payments", { companyKey: "dmpl", clientId, amountPaise: 10_000, mode: "upi", paidOn: todayIST() });
    expect(rc.status, JSON.stringify(rc.body)).toBe(201);
    expect(rc.body.data).toMatchObject({ companyKey: "dmpl" });
    expect(rc.body.data.number).toMatch(/^DMRC\//);
    const rf = await post(`/sales/payments/${rc.body.data.id}/refunds`, { amountPaise: 5_000, mode: "upi", refundedOn: todayIST() });
    expect(rf.status, JSON.stringify(rf.body)).toBe(201);
    expect(rf.body.data.refunds[0].number).toBe(`DMRF/${fy}/0001`);
  });

  it("keeps the books apart: payments, moves between companies, lists and the dashboard", async () => {
    expect((await save("dspl", DSPL)).status).toBe(200);
    expect((await save("dmpl", DMPL)).status).toBe(200);
    const ds = await issued("dspl");
    const dm = await issued("dmpl");
    // A Dashmani Media receipt cannot pay a Digital Sukoon invoice, at record time or later.
    const wrong = await post("/sales/payments", { companyKey: "dmpl", clientId, amountPaise: 118_000, mode: "upi", paidOn: todayIST(), allocations: [{ invoiceId: ds.id, amountPaise: 118_000 }] });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error?.code ?? wrong.body.code).toBe("WRONG_COMPANY");
    const adv = await post("/sales/payments", { companyKey: "dmpl", clientId, amountPaise: 118_000, mode: "upi", paidOn: todayIST() });
    expect((await post(`/sales/payments/${adv.body.data.id}/allocations`, { allocations: [{ invoiceId: ds.id, amountPaise: 1_000 }] })).status).toBe(409);
    expect((await post(`/sales/payments/${adv.body.data.id}/allocations`, { allocations: [{ invoiceId: dm.id, amountPaise: 118_000 }] })).status).toBe(200);

    // A draft cannot be moved to the other company.
    const draft = await post("/sales/invoices", { companyKey: "dmpl", clientId, items: line });
    const moved = await request(app).put(`/v1/sales/invoices/${draft.body.data.id}`).set(auth(token)).send({ companyKey: "dspl", clientId, items: line });
    expect(moved.status).toBe(409);

    const list = await request(app).get("/v1/sales/invoices?company=dmpl").set(auth(token));
    expect(list.body.data.every((i: { companyKey: string }) => i.companyKey === "dmpl")).toBe(true);
    expect(list.body.data.map((i: { id: string }) => i.id)).toContain(dm.id);
    const all = await request(app).get("/v1/sales/invoices").set(auth(token));
    expect(all.body.data.length).toBe(3);

    const dashDm = (await request(app).get("/v1/sales/dashboard?company=dmpl").set(auth(token))).body.data;
    const dashDs = (await request(app).get("/v1/sales/dashboard").set(auth(token))).body.data;
    expect(dashDm).toMatchObject({ company: "dmpl", invoicedFyCount: 1, collectedFyPaise: 118_000, outstandingPaise: 0 });
    expect(dashDs).toMatchObject({ company: "dspl", invoicedFyCount: 1, collectedFyPaise: 0, outstandingPaise: ds.totalPaise });

    const stmt = (await request(app).get(`/v1/sales/clients/${clientId}/statement?company=dspl`).set(auth(token))).body.data;
    expect(stmt.invoices.map((i: { id: string }) => i.id)).toEqual([ds.id]);
    expect(stmt.payments).toHaveLength(0);
  });
});
