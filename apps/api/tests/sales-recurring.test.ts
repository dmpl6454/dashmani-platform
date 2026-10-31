/**
 * The GST registration chosen by hand on an invoice, and recurring / retainer invoices.
 * Choice: overrides the automatic registration (GSTIN, series, tax mode), must be one of the
 * company's own GSTINs, null keeps today's automatic behaviour. Recurring: one invoice per period
 * (claimed), the date moves on, draft vs issue + email, paused/ended skipped, failures recorded
 * and retried, "Run now".
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { financialYear, todayIST } from "@dashmani/shared";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { sendEmail } from "../src/services/email.service";
import { firstRunDate, nextPeriod, periodLabel, runDueRecurring, runRecurringOnce } from "../src/services/sales/recurring.service";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const HARYANA = {
  label: "Gurugram", gstin: "06AAKCD3352K1ZJ", addressLine1: "Hunch Circle, Huda City Centre, Sector 29",
  city: "Gurugram", pincode: "122001", invoicePrefix: "DSHR", creditNotePrefix: "CNHR",
};
const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702, Parinee I, Andheri West",
  city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "DS", creditNotePrefix: "CN",
  email: "accounts@ds.test", branches: [HARYANA],
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const fy = () => financialYear(todayIST()).short;

describe("pure schedule helpers", () => {
  it("finds the first billing day, the next period and its label", () => {
    expect(firstRunDate("2026-11-03", 5)).toBe("2026-11-05");
    expect(firstRunDate("2026-11-10", 5)).toBe("2026-12-05");
    expect(firstRunDate("2026-12-20", 1)).toBe("2027-01-01");
    expect(nextPeriod("2026-11-05", "monthly", 5)).toBe("2026-12-05");
    expect(nextPeriod("2026-12-05", "monthly", 5)).toBe("2027-01-05");
    expect(nextPeriod("2026-11-28", "quarterly", 28)).toBe("2027-02-28");
    expect(nextPeriod("2026-11-01", "yearly", 1)).toBe("2027-11-01");
    expect(periodLabel("2026-11-05", "monthly")).toBe("November 2026");
    expect(periodLabel("2026-11-05", "quarterly")).toBe("Nov 2026 – Jan 2027");
    expect(periodLabel("2026-11-05", "yearly")).toBe("Nov 2026 – Oct 2027");
  });
});

describe("GST registration chosen on the invoice, and recurring invoices", () => {
  let token: string;
  let adminToken: string;
  const clients: Record<string, string> = {};

  beforeEach(async () => {
    vi.mocked(sendEmail).mockClear();
    await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales." } } });
    await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const u = await createTestUser({ roleNames: ["Sales"] });
    const a = await createTestUser({ roleNames: ["Admin"] });
    token = generateToken(u.id, u.email, ["Sales"]);
    adminToken = generateToken(a.id, a.email, ["Admin"]);
    for (const [key, gstin] of [["hr", "06AABCH1234A1Z5"], ["mh", "27AABCU9603R1ZX"], ["ka", "29AAACB1234F1Z9"]] as const) {
      const c = await prisma.client.create({ data: { companyName: `Client ${key}`, contactName: "X", email: `${key}@c.test`, passwordHash: "x" } });
      await prisma.clientBillingProfile.create({
        data: { clientId: c.id, legalName: `Client ${key} Pvt Ltd`, gstin, stateCode: gstin.slice(0, 2), addressLine1: "1 Road", city: "City", pincode: "400001", state: "State", billingEmail: `${key}-billing@c.test` },
      });
      clients[key] = c.id;
    }
    expect((await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send(SELLER)).status).toBe(200);
  });

  const draft = (clientId: string, extra: Record<string, unknown> = {}) =>
    request(app).post("/v1/sales/invoices").set(auth(token)).send({ clientId, items: [{ description: "Reel", quantity: 1, unitPricePaise: 100_000 }], ...extra });
  const issue = (id: string) => request(app).post(`/v1/sales/invoices/${id}/issue`).set(auth(token)).send({});

  describe("billed-from registration", () => {
    it("bills from the chosen registration: its GSTIN, its series and the tax mode it gives", async () => {
      // A Karnataka client is billed from the principal (IGST) automatically; chosen: Haryana, still IGST.
      const ka = await draft(clients.ka, { sellerGstin: "06aakcd3352k1zj" });
      expect(ka.status, JSON.stringify(ka.body)).toBe(201);
      expect(ka.body.data).toMatchObject({ sellerGstin: "06AAKCD3352K1ZJ", taxMode: "inter", igstPaise: 18_000 });
      const kaIssued = (await issue(ka.body.data.id)).body.data;
      expect(kaIssued.number).toBe(`DSHR/${fy()}/0001`);
      expect(kaIssued.sellerSnapshot).toMatchObject({ gstin: "06AAKCD3352K1ZJ", city: "Gurugram" });

      // A Haryana client billed from the principal by hand: IGST, the principal's series.
      const hr = await draft(clients.hr, { sellerGstin: "27AAKCD3352K1ZF" });
      expect(hr.body.data).toMatchObject({ taxMode: "inter", igstPaise: 18_000 });
      const hrIssued = (await issue(hr.body.data.id)).body.data;
      expect(hrIssued.number).toBe(`DS/${fy()}/0001`);
      expect(hrIssued.sellerSnapshot.gstin).toBe("27AAKCD3352K1ZF");
    });

    it("leaves the automatic choice unchanged when none is picked", async () => {
      const hr = await draft(clients.hr);
      expect(hr.body.data).toMatchObject({ sellerGstin: null, taxMode: "intra", cgstPaise: 9_000 });
      const issued = (await issue(hr.body.data.id)).body.data;
      expect(issued.number).toBe(`DSHR/${fy()}/0001`);
    });

    it("refuses a GSTIN that is not one of the company's registrations, and one removed before issue", async () => {
      const bad = await draft(clients.ka, { sellerGstin: "29AAACB1234F1Z9" });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("UNKNOWN_REGISTRATION");
      const ok = await draft(clients.ka, { sellerGstin: HARYANA.gstin });
      // Settings drop the Haryana registration: the draft can no longer be issued from it.
      expect((await request(app).put("/v1/sales/settings/seller").set(auth(adminToken)).send({ ...SELLER, branches: [] })).status).toBe(200);
      const r = await issue(ok.body.data.id);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("REGISTRATION_GONE");
    });
  });

  describe("recurring invoices", () => {
    const template = (extra: Record<string, unknown> = {}) => ({
      clientId: clients.mh, title: "Monthly retainer", frequency: "monthly", dayOfMonth: 1, startDate: todayIST(),
      lines: [{ description: "Social media management", quantity: 1, unitPricePaise: 5_000_000 }], ...extra,
    });
    const create = (extra: Record<string, unknown> = {}) => request(app).post("/v1/sales/recurring").set(auth(token)).send(template(extra));
    const makeDue = (id: string, day: string) => prisma.salesRecurringInvoice.update({ where: { id }, data: { nextRunDate: new Date(`${day}T00:00:00Z`) } });

    it("bills a due period once as a draft, moves to the next period, and never bills the period twice", async () => {
      const created = await create();
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.data.id;
      const today = todayIST();
      await makeDue(id, today);
      const [first, second] = await Promise.all([runRecurringOnce(id, { issueDay: today }), runRecurringOnce(id, { issueDay: today })]);
      const made = [first, second].filter((r) => r.invoiceId);
      expect(made).toHaveLength(1);
      const inv = await request(app).get(`/v1/sales/invoices/${made[0].invoiceId}`).set(auth(token));
      expect(inv.body.data).toMatchObject({ status: "draft", number: null, recurringId: id, subtotalPaise: 5_000_000, cgstPaise: 450_000, sgstPaise: 450_000, totalPaise: 5_900_000 });
      expect(inv.body.data.notes).toContain("Monthly retainer");
      const tpl = (await request(app).get(`/v1/sales/recurring/${id}`).set(auth(token))).body.data;
      expect(tpl.nextRunDate).toBe(nextPeriod(today, "monthly", 1));
      expect(tpl).toMatchObject({ lastInvoiceId: made[0].invoiceId, lastError: null, status: "active" });
      expect(tpl.invoices).toHaveLength(1);
      // Not due any more: the daily run bills nothing.
      expect((await runDueRecurring(today)).filter((r) => r.invoiceId)).toHaveLength(0);
    });

    it("issue mode issues the invoice and emails it to the client", async () => {
      const id = (await create({ mode: "issue" })).body.data.id;
      await makeDue(id, todayIST());
      const r = await runRecurringOnce(id);
      expect(r).toMatchObject({ issued: true, emailed: true, error: null });
      const inv = (await request(app).get(`/v1/sales/invoices/${r.invoiceId}`).set(auth(token))).body.data;
      expect(inv).toMatchObject({ status: "issued", number: `DS/${fy()}/0001` });
      expect(String(vi.mocked(sendEmail).mock.calls.at(-1)![0].to)).toContain("mh-billing@c.test");
    });

    it("skips paused and ended templates; resume does not back-bill the paused periods", async () => {
      const id = (await create()).body.data.id;
      await makeDue(id, "2026-01-01");
      expect((await request(app).post(`/v1/sales/recurring/${id}/pause`).set(auth(token))).body.data.status).toBe("paused");
      expect((await runDueRecurring(todayIST())).filter((r) => r.recurringId === id && r.invoiceId)).toHaveLength(0);
      const resumed = (await request(app).post(`/v1/sales/recurring/${id}/resume`).set(auth(token))).body.data;
      expect(resumed.status).toBe("active");
      expect(resumed.nextRunDate >= todayIST()).toBe(true);
      expect((await request(app).post(`/v1/sales/recurring/${id}/end`).set(auth(token))).body.data.status).toBe("ended");
      expect((await request(app).post(`/v1/sales/recurring/${id}/run`).set(auth(token))).status).toBe(409);
    });

    it("records a failure, creates nothing, and retries the same period next time", async () => {
      const id = (await create({ mode: "issue" })).body.data.id;
      await makeDue(id, todayIST());
      // The client is gone from under the template (a hard failure creating the invoice).
      const tpl = await prisma.salesRecurringInvoice.findUniqueOrThrow({ where: { id } });
      await prisma.salesRecurringInvoice.update({ where: { id }, data: { lines: [{ description: "x", quantity: 1, unitPricePaise: 2_147_000_000 }, { description: "y", quantity: 1, unitPricePaise: 2_147_000_000 }] } });
      const r = await runRecurringOnce(id);
      expect(r.invoiceId).toBeNull();
      expect(r.error).toMatch(/Could not create the invoice/);
      const after = await prisma.salesRecurringInvoice.findUniqueOrThrow({ where: { id } });
      expect(after.nextRunDate.toISOString().slice(0, 10)).toBe(tpl.nextRunDate.toISOString().slice(0, 10));
      expect(after.lastError).toMatch(/larger than/);
      expect(await prisma.salesInvoice.count({ where: { recurringId: id } })).toBe(0);
    });

    it("issue mode leaves a draft when the invoice cannot be issued", async () => {
      await prisma.systemSetting.deleteMany({ where: { key: "sales.seller" } }); // no GST profile → a tax invoice can't be issued
      const id = (await create({ mode: "issue" })).body.data.id;
      await makeDue(id, todayIST());
      const r = await runRecurringOnce(id);
      expect(r).toMatchObject({ issued: false });
      expect(r.error).toMatch(/left as a draft/);
      const inv = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: r.invoiceId! } });
      expect(inv.status).toBe("draft");
    });

    it("Run now bills the next period immediately and refuses a GSTIN the company does not hold", async () => {
      const id = (await create({ sellerGstin: HARYANA.gstin })).body.data.id;
      const run = await request(app).post(`/v1/sales/recurring/${id}/run`).set(auth(token));
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      expect(run.body.data.result.invoiceId).toBeTruthy();
      const inv = (await request(app).get(`/v1/sales/invoices/${run.body.data.result.invoiceId}`).set(auth(token))).body.data;
      expect(inv).toMatchObject({ sellerGstin: HARYANA.gstin, taxMode: "inter" });
      expect((await create({ sellerGstin: "29AAACB1234F1Z9" })).status).toBe(400);
      expect((await create({ dayOfMonth: 30 })).status).toBe(400);
    });

    it("is staff-only", async () => {
      const plain = await createTestUser({ email: "plain@ds.test" });
      expect((await request(app).get("/v1/sales/recurring").set(auth(generateToken(plain.id, plain.email, [])))).status).toBe(403);
    });
  });
});
