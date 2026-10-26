/**
 * E-invoicing (IRN) against a simulated IRP, plus the NIC client's encryption handshake against a
 * fake NIC server. What must hold: only B2B/SEZ/export documents register; the data check runs
 * before a serial is spent; the INV-01 totals reconcile exactly; failures stay visible and retry
 * without ever double-registering; IRNs cancel only within 24 hours; credit notes refer to their
 * invoice.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { financialYear, todayIST } from "@dashmani/shared";
import { setIrpProviderForTests } from "../src/services/sales/irp/provider";
import { MockIrp } from "../src/services/sales/irp/mock";
import { NicIrp, aesDecrypt, aesEncrypt } from "../src/services/sales/irp/nic";

const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702, Parinee I, Andheri West",
  city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "DS", creditNotePrefix: "CN",
  branches: [{ label: "Gurugram", gstin: "06AAKCD3352K1ZJ", addressLine1: "Huda City Centre, Sector 29", city: "Gurugram", pincode: "122001", invoicePrefix: "DSHR", creditNotePrefix: "CNHR" }],
  eInvoicing: { enabled: true },
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("e-invoicing", () => {
  let token: string;
  let adminToken: string;
  let irp: MockIrp;
  const fy = financialYear(todayIST()).short;
  const c: Record<string, string> = {};

  beforeEach(async () => {
    irp = new MockIrp();
    setIrpProviderForTests(irp);
    await prisma.systemSetting.deleteMany({ where: { key: "sales.seller" } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ roleNames: ["Sales"] });
    const a = await createTestUser({ roleNames: ["Admin"] });
    token = generateToken(u.id, u.email, ["Sales"]);
    adminToken = generateToken(a.id, a.email, ["Admin"]);
    const mk = async (key: string, profile: Record<string, unknown> | null) => {
      const cl = await prisma.client.create({ data: { companyName: `Client ${key}`, contactName: "X", email: `${key}@c.test`, passwordHash: "x" } });
      if (profile) await prisma.clientBillingProfile.create({ data: { clientId: cl.id, legalName: `Client ${key} Pvt Ltd`, ...profile } as never });
      c[key] = cl.id;
    };
    await mk("ka", { gstin: "29AAACB1234F1Z9", stateCode: "29", addressLine1: "12 MG Road", city: "Bengaluru", pincode: "560001" });
    await mk("hr", { gstin: "06AABCH1234A1Z5", stateCode: "06", addressLine1: "DLF Phase 2", city: "Gurugram", pincode: "122002" });
    await mk("nopin", { gstin: "29AAACB9999F1Z1", stateCode: "29", addressLine1: "Somewhere", city: "Mysuru" });
    await mk("b2c", { stateCode: "27", addressLine1: "Bandra", city: "Mumbai", pincode: "400050" });
    expect((await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER)).status).toBe(200);
  });
  afterEach(() => setIrpProviderForTests(undefined));

  const api = () => request(app);
  const draft = (clientId: string, items = [{ description: "Reel", quantity: 1, unitPricePaise: 100_000 }], extra: Record<string, unknown> = {}) =>
    api().post("/v1/sales/invoices").set(auth(token)).send({ clientId, items, ...extra }).then((r) => r.body.data);
  const issue = (id: string) => api().post(`/v1/sales/invoices/${id}/issue`).set(auth(token)).send({});
  const row = (invoiceId: string) => prisma.salesEInvoice.findUnique({ where: { invoiceId } });

  it("registers a B2B tax invoice, with INV-01 totals that reconcile line by line", async () => {
    const d = await draft(c.ka, [
      { description: "Bollywood Society · Reel", quantity: 2, unitPricePaise: 333_333 },
      { description: "Story mention", quantity: 1, unitPricePaise: 100_001, discountPaise: 1_001 },
    ], { discountPaise: 12_345 });
    const r = await issue(d.id);
    expect(r.status).toBe(200);
    expect(r.body.data.einvoice).toMatchObject({ status: "registered", docType: "INV", gstin: "27AAKCD3352K1ZF" });
    expect(r.body.data.einvoice.irn).toMatch(/^[0-9a-f]{64}$/);
    const e = (await row(d.id))!;
    const p = e.payload as any;
    expect(p).toMatchObject({ Version: "1.1", TranDtls: { SupTyp: "B2B" }, DocDtls: { Typ: "INV", No: `DS/${fy}/0001` }, BuyerDtls: { Gstin: "29AAACB1234F1Z9", Pos: "29", Pin: 560001 }, SellerDtls: { Pin: 400053, Stcd: "27" } });
    expect(p.DocDtls.Dt).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    const sum = (k: string) => Math.round(p.ItemList.reduce((s: number, it: any) => s + it[k] * 100, 0));
    expect(sum("AssAmt")).toBe(Math.round(p.ValDtls.AssVal * 100));
    expect(sum("IgstAmt")).toBe(Math.round(p.ValDtls.IgstVal * 100));
    expect(sum("TotItemVal") + Math.round(p.ValDtls.RndOffAmt * 100)).toBe(Math.round(p.ValDtls.TotInvVal * 100));
    expect(Math.round(p.ValDtls.TotInvVal * 100)).toBe(r.body.data.totalPaise);
    // The PDF renders the QR.
    const pdf = await api().get(`/v1/sales/invoices/${d.id}/pdf`).set(auth(token));
    expect(pdf.status).toBe(200);
  });

  it("registers from the Gurugram GSTIN for a Haryana client", async () => {
    const d = await draft(c.hr);
    const r = await issue(d.id);
    expect(r.body.data.einvoice).toMatchObject({ status: "registered", gstin: "06AAKCD3352K1ZJ" });
    expect(((await row(d.id))!.payload as any).SellerDtls).toMatchObject({ Gstin: "06AAKCD3352K1ZJ", Stcd: "06" });
  });

  it("does not register B2C invoices, proformas, or anything before the applicable date", async () => {
    expect((await issue((await draft(c.b2c)).id)).body.data.einvoice).toBeNull();
    expect((await issue((await draft(c.ka, undefined, { kind: "proforma" })).id)).body.data.einvoice).toBeNull();
    await api().put("/v1/sales/settings/seller").set(auth(adminToken)).send({ ...SELLER, eInvoicing: { enabled: true, applicableFrom: "2099-04-01" } });
    expect((await issue((await draft(c.ka)).id)).body.data.einvoice).toBeNull();
    expect(irp.calls).toEqual([]);
  });

  it("refuses to issue when the IRP would reject the data, without spending a serial", async () => {
    const bad = await issue((await draft(c.nopin)).id);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("EINVOICE_DATA_MISSING");
    expect(bad.body.error.message).toContain("client PIN code");
    expect((await issue((await draft(c.ka)).id)).body.data.number).toBe(`DS/${fy}/0001`);
  });

  it("keeps the invoice issued when the IRP is down, shows the failure, and registers on retry", async () => {
    irp.failNext("9999", "IRP unavailable");
    const d = await draft(c.ka);
    const r = await issue(d.id);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: "issued", einvoice: { status: "failed", lastError: "IRP unavailable" } });
    const again = await api().post(`/v1/sales/invoices/${d.id}/einvoice`).set(auth(token));
    expect(again.body.data.einvoice.status).toBe("registered");
    expect(irp.calls).toEqual(["generate", "getByDocument", "generate"]);
  });

  it("never registers twice when the IRP registered it but the answer was lost", async () => {
    irp.failNext("504", "Gateway timeout", true); // registered on the IRP, answer lost
    const d = await draft(c.ka);
    expect((await issue(d.id)).body.data.einvoice.status).toBe("failed");
    const again = await api().post(`/v1/sales/invoices/${d.id}/einvoice`).set(auth(token));
    expect(again.body.data.einvoice.status).toBe("registered");
    expect(irp.calls).toEqual(["generate", "getByDocument"]); // found, not generated again
  });

  it("cancels the IRN with the invoice inside 24 hours, and refuses after", async () => {
    const d1 = await draft(c.ka);
    await issue(d1.id);
    const cx = await api().post(`/v1/sales/invoices/${d1.id}/cancel`).set(auth(token)).send({ reason: "Raised on wrong client" });
    expect(cx.status).toBe(200);
    expect(cx.body.data).toMatchObject({ status: "cancelled", einvoice: { status: "cancelled" } });
    expect(irp.calls).toContain("cancel");
    const d2 = await draft(c.ka);
    await issue(d2.id);
    await prisma.salesEInvoice.update({ where: { invoiceId: d2.id }, data: { ackDate: new Date(Date.now() - 25 * 3600_000) } });
    const late = await api().post(`/v1/sales/invoices/${d2.id}/cancel`).set(auth(token)).send({ reason: "Too late" });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("IRN_CANCEL_WINDOW");
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: d2.id } })).status).toBe("issued");
  });

  it("registers a credit note that refers to its invoice, and prints it", async () => {
    const d = await draft(c.ka);
    const inv = (await issue(d.id)).body.data;
    const cn = await api().post("/v1/sales/credit-notes").set(auth(token)).send({ invoiceId: d.id, reason: "One reel dropped", taxablePaise: 50_000 });
    expect(cn.status).toBe(201);
    const e = (await prisma.salesEInvoice.findUnique({ where: { creditNoteId: cn.body.data.id } }))!;
    expect(e).toMatchObject({ docType: "CRN", status: "registered" });
    expect((e.payload as any).RefDtls.PrecDocDtls[0].InvNo).toBe(inv.number);
    expect((e.payload as any).DocDtls).toMatchObject({ Typ: "CRN", No: `CN/${fy}/0001` });
    expect((await api().get(`/v1/sales/credit-notes/${cn.body.data.id}/pdf`).set(auth(token))).status).toBe(200);
  });

  it("records a clear failure when e-invoicing is on but no IRP connection is configured", async () => {
    setIrpProviderForTests(null);
    const d = await draft(c.ka);
    const r = await issue(d.id);
    expect(r.body.data.einvoice.status).toBe("failed");
    expect(r.body.data.einvoice.lastError).toContain("no IRP connection is configured");
  });
});

describe("NIC client handshake", () => {
  it("logs in with RSA + AES, encrypts the payload with the session key and decrypts the answer", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sek = crypto.randomBytes(32);
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init: { headers: Record<string, string>; body?: string; method: string }) => {
      seen.push(`${init.method} ${url.replace("https://nic.test", "")}`);
      const json = (o: unknown) => ({ status: 200, json: async () => o }) as Response;
      if (url.endsWith("/eivital/v1.04/auth")) {
        const data = JSON.parse(init.body!).Data as string;
        const inner = JSON.parse(Buffer.from(crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(data, "base64")).toString(), "base64").toString());
        expect(inner).toMatchObject({ UserName: "dsuser", Password: "secret", ForceRefreshAccessToken: true });
        const appKey = Buffer.from(inner.AppKey, "base64");
        return json({ Status: 1, Data: { AuthToken: "tok", Sek: aesEncrypt(appKey, sek), TokenExpiry: "2099-01-01 00:00:00" } });
      }
      expect(init.headers).toMatchObject({ AuthToken: "tok", user_name: "dsuser", gstin: "27AAKCD3352K1ZF", client_id: "cid" });
      const sent = JSON.parse(aesDecrypt(sek, JSON.parse(init.body!).Data).toString());
      expect(sent.DocDtls.No).toBe("DS/26-27/0001");
      return json({ Status: 1, Data: aesEncrypt(sek, Buffer.from(JSON.stringify({ AckNo: 112010000001, AckDt: "2026-10-27 10:00:00", Irn: "a".repeat(64), SignedInvoice: "si", SignedQRCode: "qr", Status: "ACT" }))) });
    }) as unknown as typeof fetch;
    const nic = new NicIrp({
      baseUrl: "https://nic.test", clientId: "cid", clientSecret: "cs",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      credentials: () => ({ user: "dsuser", password: "secret" }), fetch: fakeFetch,
    });
    const res = await nic.generate("27AAKCD3352K1ZF", { DocDtls: { Typ: "INV", No: "DS/26-27/0001", Dt: "27/10/2026" } });
    expect(res).toEqual({ irn: "a".repeat(64), ackNo: "112010000001", ackDate: "2026-10-27 10:00:00", signedInvoice: "si", signedQrCode: "qr" });
    expect(seen).toEqual(["POST /eivital/v1.04/auth", "POST /eicore/v1.03/Invoice"]);
  });
});
