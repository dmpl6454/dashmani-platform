/**
 * Two GST registrations of one company (Digital Sukoon Private Limited: Maharashtra principal,
 * Haryana additional): each supply is billed from the registration in the client's state, else
 * the principal one; each GSTIN numbers its own invoices and credit notes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../src/app";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { financialYear, todayIST } from "@dashmani/shared";

const HARYANA = {
  label: "Gurugram", gstin: "06AAKCD3352K1ZJ", addressLine1: "3rd to 5th Floor, Hunch Circle Private Limited, Huda City Centre, Sector 29",
  city: "Gurugram", pincode: "122001", invoicePrefix: "DSHR", creditNotePrefix: "CNHR",
};
const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702, Parinee I, Shaha Industrial Estate Road, Andheri West",
  city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "DS", creditNotePrefix: "CN", branches: [HARYANA],
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("GST registrations", () => {
  let token: string;
  let adminToken: string;
  const fy = financialYear(todayIST()).short;
  const clients: Record<string, string> = {};

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: "sales.seller" } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ roleNames: ["Sales"] });
    const a = await createTestUser({ roleNames: ["Admin"] });
    token = generateToken(u.id, u.email, ["Sales"]);
    adminToken = generateToken(a.id, a.email, ["Admin"]);
    for (const [key, gstin] of [["hr", "06AABCH1234A1Z5"], ["mh", "27AABCU9603R1ZX"], ["ka", "29AAACB1234F1Z9"]] as const) {
      const c = await prisma.client.create({ data: { companyName: `Client ${key}`, contactName: "X", email: `${key}@c.test`, passwordHash: "x" } });
      await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName: `Client ${key} Pvt Ltd`, gstin, stateCode: gstin.slice(0, 2) } });
      clients[key] = c.id;
    }
  });

  const save = (body: unknown) => request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(body);
  async function issued(clientId: string) {
    const d = (await request(app).post("/v1/sales/invoices").set(auth(token)).send({ clientId, items: [{ description: "Reel", quantity: 1, unitPricePaise: 100_000 }] })).body.data;
    const r = await request(app).post(`/v1/sales/invoices/${d.id}/issue`).set(auth(token)).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  }

  it("bills each client from the registration in its state, else the principal one, each with its own series", async () => {
    expect((await save(SELLER)).status).toBe(200);
    const hr = await issued(clients.hr);
    expect(hr).toMatchObject({ number: `DSHR/${fy}/0001`, taxMode: "intra", cgstPaise: 9_000, sgstPaise: 9_000 });
    expect(hr.sellerSnapshot).toMatchObject({ gstin: "06AAKCD3352K1ZJ", stateCode: "06", state: "Haryana", city: "Gurugram", registration: "Gurugram", legalName: "Digital Sukoon Private Limited" });
    const mh = await issued(clients.mh);
    expect(mh).toMatchObject({ number: `DS/${fy}/0001`, taxMode: "intra" });
    expect(mh.sellerSnapshot.gstin).toBe("27AAKCD3352K1ZF");
    const ka = await issued(clients.ka);
    expect(ka).toMatchObject({ number: `DS/${fy}/0002`, taxMode: "inter", igstPaise: 18_000 });
    expect((await issued(clients.hr)).number).toBe(`DSHR/${fy}/0002`);
    // A credit note follows the GSTIN of its invoice.
    const cn = await request(app).post("/v1/sales/credit-notes").set(auth(token)).send({ invoiceId: hr.id, reason: "Not delivered", taxablePaise: 100_000 });
    expect(cn.body.data.number).toBe(`CNHR/${fy}/0001`);
    const cn2 = await request(app).post("/v1/sales/credit-notes").set(auth(token)).send({ invoiceId: ka.id, reason: "Not delivered", taxablePaise: 100_000 });
    expect(cn2.body.data.number).toBe(`CN/${fy}/0001`);
  });

  it("refuses registrations that clash or disagree with their GSTIN", async () => {
    expect((await save({ ...SELLER, branches: [{ ...HARYANA, invoicePrefix: "DS" }] })).status).toBe(400); // prefix taken
    expect((await save({ ...SELLER, branches: [{ ...HARYANA, gstin: "27AAKCD3352K1ZF" }] })).status).toBe(400); // same state/GSTIN as principal
    expect((await save({ ...SELLER, branches: [{ ...HARYANA, stateCode: "07" }] })).status).toBe(400); // GSTIN is Haryana
    const ok = await save(SELLER);
    expect(ok.body.data.profile.branches[0]).toMatchObject({ stateCode: "06", state: "Haryana" });
  });
});
