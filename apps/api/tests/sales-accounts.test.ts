/**
 * The accounts page on sales.digitalsukoon.com (spec-accounts §4, §8 tests 1–27): the pure helpers,
 * every live figure (SQL aggregates in one read-only snapshot) checked against the dashboard and the
 * client statement it must agree with, the GST section rules (owner 2026-11-05: "no GST" = SEZ when
 * the buyer has a GSTIN, export when abroad), GSTR-3B 3.1, the GST warnings, and the GSTR-1 B2B /
 * CDNR / sales-register and TDS CSVs (the worked example of §4.9, one FY earlier so it is closed).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import {
  ageBucket,
  classifyTds,
  creditNoteDeadline,
  filedChecks,
  financialYear,
  formatFiledAmount,
  fyBounds,
  fyLabelsBetween,
  fyQuarter,
  gstr1Date,
  gstr1DueDay,
  gstr1Pos,
  parseFiledAmount,
  periodBounds,
  todayIST,
  FILED_FIGURE_KEYS,
  type FiledFigureKey,
} from "@dashmani/shared";
import app from "../src/app";
import { getAccounts } from "../src/services/sales/accounts.service";
import { createTestRole, createTestUser, generateHrToken, generateToken } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const MUMBAI = "27AAKCD3352K1ZF";
const GURUGRAM = "06AAKCD3352K1ZJ";
const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: MUMBAI, pan: "AAKCD3352K", addressLine1: "702, Parinee I, Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "INV", creditNotePrefix: "CN", serialDigits: 4, defaultDueDays: 15,
  branches: [{ label: "Gurugram", gstin: GURUGRAM, addressLine1: "Hunch Circle, Sector 29", city: "Gurugram", pincode: "122001", invoicePrefix: "INV", creditNotePrefix: "CNHR", serialDigits: 3 }],
};
const DMPL = {
  legalName: "Dashmani Media Private Limited", gstin: "27AAJCD7425L1Z8", pan: "AAJCD7425L", addressLine1: "Off-702 Parinee I", city: "Mumbai",
  stateCode: "27", pincode: "400053", invoicePrefix: "DM", creditNotePrefix: "DMCN", quotePrefix: "DMQ", orderPrefix: "DMSO", receiptPrefix: "DMRC",
};
const L = (rupees: number) => rupees * 100;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = todayIST();
const CURRENT_FY = financialYear(TODAY).label;

// ─── Pure helpers (no DB) ──────────────────────────────────────────────────────────────────────

describe("accounts — pure helpers", () => {
  it("1. fyBounds / fyLabelsBetween", () => {
    expect(fyBounds("2025-26")).toEqual({ label: "2025-26", startDay: "2025-04-01", endDay: "2026-03-31", endExclusive: "2026-04-01" });
    for (const bad of ["2025-27", "25-26", "2025-2026", "abcd-ef"]) expect(fyBounds(bad)).toBeNull();
    expect(fyBounds("2099-00")).toEqual({ label: "2099-00", startDay: "2099-04-01", endDay: "2100-03-31", endExclusive: "2100-04-01" });
    expect(fyLabelsBetween("2023-24", "2026-27")).toEqual(["2026-27", "2025-26", "2024-25", "2023-24"]);
  });

  it("2. fyQuarter", () => {
    expect(["2026-04-01", "2026-06-30", "2026-07-01", "2026-12-31", "2027-01-01", "2027-03-31"].map(fyQuarter)).toEqual([1, 1, 2, 3, 4, 4]);
  });

  it("3. periodBounds", () => {
    expect(periodBounds("2026-10")).toMatchObject({ kind: "month", from: "2026-10-01", toExclusive: "2026-11-01", fy: "2026-27", label: "October 2026" });
    expect(periodBounds("2027-02")).toMatchObject({ from: "2027-02-01", toExclusive: "2027-03-01", fy: "2026-27" });
    expect(periodBounds("2026-12")).toMatchObject({ toExclusive: "2027-01-01" });
    expect(periodBounds("2026-27-Q3")).toMatchObject({ kind: "quarter", from: "2026-10-01", toExclusive: "2027-01-01", label: "Q3 2026-27 (Oct–Dec)" });
    expect(periodBounds("2026-27-Q4")).toMatchObject({ from: "2027-01-01", toExclusive: "2027-04-01" });
    expect(periodBounds("2026-27")).toMatchObject({ kind: "year", from: "2026-04-01", toExclusive: "2027-04-01", fy: "2026-27" });
    expect(periodBounds("2026-13")).toBeNull();
    expect(periodBounds("2026-27-Q5")).toBeNull();
  });

  it("4. ageBucket", () => {
    const t = "2026-11-05";
    expect(["2026-11-06", "2026-11-05", "2026-10-06", "2026-10-05", "2026-08-07", "2026-08-06"].map((d) => ageBucket(t, d)))
      .toEqual(["not_due", "d0_30", "d0_30", "d31_60", "d61_90", "d90_plus"]);
  });

  it("5. classifyTds (the rate check the page shows)", () => {
    const k = (tds: number, pan: string | null = null) => classifyTds(tds, 10_000_000, 11_800_000, pan);
    expect(k(1_000_000).kind).toBe("p10");
    expect(k(200_000).kind).toBe("p2");
    expect(k(200_000, "ABCPX1234Y").label).toContain("individual/HUF is 1%");
    expect(k(236_000).kind).toBe("on_total");
    expect(k(275_000)).toMatchObject({ kind: "other", label: "2.75% of taxable" });
    expect(k(1_000_090).kind).toBe("p10");
  });

  it("6. parseFiledAmount / formatFiledAmount", () => {
    expect(parseFiledAmount("-1,23,456.78", "rupees")).toBe(-12_345_678);
    expect(parseFiledAmount("(1,234)", "rupees")).toBe(-123_400);
    expect(parseFiledAmount("−5", "rupees")).toBe(-500);
    expect(parseFiledAmount("12.5", "lakhs")).toBe(125_000_000);
    expect(parseFiledAmount("", "rupees")).toBeNull();
    expect(parseFiledAmount("12a", "rupees")).toBe("invalid");
    expect(parseFiledAmount("1.234", "rupees")).toBe("invalid");
    expect(formatFiledAmount(482_153_000, "lakhs")).toBe("48.2153");
    for (const unit of ["rupees", "thousands", "lakhs", "crores"] as const) {
      for (const p of [482_153_000, -120_000_000, 1, 0, 99]) expect(parseFiledAmount(formatFiledAmount(p, unit), unit)).toBe(p);
    }
    expect(formatFiledAmount(null, "rupees")).toBe("");
  });

  it("7. filedChecks", () => {
    const f = (o: Partial<Record<FiledFigureKey, number | null>>) => ({ ...Object.fromEntries(FILED_FIGURE_KEYS.map((x) => [x, null])), ...o }) as Record<FiledFigureKey, number | null>;
    const balanced = f({ revenuePaise: L(1000), otherIncomePaise: L(100), totalExpensesPaise: L(600), profitBeforeTaxPaise: L(500), taxExpensePaise: L(100), profitAfterTaxPaise: L(400), totalAssetsPaise: L(900), totalLiabilitiesPaise: L(300), equityPaise: L(600) });
    expect(filedChecks(balanced, "rupees")).toEqual([]);
    expect(filedChecks({ ...balanced, profitAfterTaxPaise: L(350) }, "rupees")).toEqual(["Profit before tax − tax is ₹400.00, but profit after tax says ₹350.00."]);
    // A statement in lakhs is rounded to ₹1,000 — a ₹900 difference is rounding, not an error.
    expect(filedChecks({ ...balanced, profitAfterTaxPaise: L(400) + L(900) }, "lakhs")).toEqual([]);
  });

  it("8. GSTR-1 formatting and deadlines", () => {
    expect(gstr1Date("2026-10-14")).toBe("14-Oct-2026");
    expect(gstr1Pos("27", "IN")).toBe("27-Maharashtra");
    expect(gstr1Pos(null, "AE")).toBe("96-Other Countries");
    expect(gstr1Pos("26", "IN")).toBe("26-Dadra & Nagar Haveli & Daman & Diu");
    expect(gstr1DueDay("2026-10-31")).toBe("2026-11-11");
    expect(gstr1DueDay("2026-12-02")).toBe("2027-01-11");
    expect(creditNoteDeadline("2025-06-01")).toBe("2026-11-30");
    expect(creditNoteDeadline("2026-02-01")).toBe("2026-11-30");
  });
});

// ─── Shared DB fixtures (called from beforeEach INSIDE each describe) ─────────────────────────

interface World {
  sales: string; admin: string; employee: string; hr: string;
  filmy: string; kanara: string; hunch: string;
}

async function seedWorld(): Promise<World> {
  await prisma.systemSetting.deleteMany({ where: { key: { startsWith: "sales.seller" } } });
  await createTestRole("Sales", ["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
  await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
  await createTestRole("Employee", [{ resource: "attendance", action: "view", scope: "own" }]);
  const s = await createTestUser({ roleNames: ["Sales"] });
  const a = await createTestUser({ roleNames: ["Admin"] });
  const e = await createTestUser({ roleNames: ["Employee"] });
  const admin = generateToken(a.id, a.email, ["Admin"]);
  const saved = await request(app).put("/v1/sales/settings/seller").set(auth(admin)).send(SELLER);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const client = async (name: string, legalName: string, profile: Record<string, unknown>) => {
    const c = await prisma.client.create({ data: { companyName: name, contactName: "X", email: `${name.replace(/\W/g, "").toLowerCase()}@c.test`, passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName, addressLine1: "Street 1", city: "City", pincode: "400001", ...profile } });
    return c.id;
  };
  return {
    sales: generateToken(s.id, s.email, ["Sales"]),
    admin,
    employee: generateToken(e.id, e.email, ["Employee"]),
    hr: generateHrToken(s.id, s.email, ["Sales"]),
    filmy: await client("Filmy Brands", "Filmy Brands Private Limited", { gstin: "27AABCU9603R1ZX", pan: "AABCU9603R", stateCode: "27", state: "Maharashtra" }),
    kanara: await client("Kanara Foods", "Kanara Foods Private Limited", { gstin: "29AAACB1234F1Z9", stateCode: "29", state: "Karnataka" }),
    hunch: await client("Hunch Media", "Hunch Media Private Limited", { gstin: "06AABCH1234M1Z5", stateCode: "06", state: "Haryana" }),
  };
}

function api(w: () => World) {
  const post = (path: string, body: unknown, t = w().sales) => request(app).post(`/v1${path}`).set(auth(t)).send(body as object);
  async function draft(clientId: string, o: { day: string; price: number; due?: string; company?: string; taxMode?: string; kind?: string }) {
    const d = await post("/sales/invoices", {
      companyKey: o.company ?? "dspl", kind: o.kind ?? "tax_invoice", clientId, issueDate: o.day, dueDate: o.due ?? null, taxMode: o.taxMode,
      items: [{ description: "Campaign", quantity: 1, unitPricePaise: o.price }],
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    return d.body.data as { id: string };
  }
  async function issue(clientId: string, o: { day: string; price: number; due?: string; company?: string; taxMode?: string; kind?: string }) {
    const d = await draft(clientId, o);
    const r = await post(`/sales/invoices/${d.id}/issue`, { issueDate: o.day, ...(o.due ? { dueDate: o.due } : {}), taxResolution: "keep" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as { id: string; number: string; totalPaise: number; taxablePaise: number };
  }
  async function pay(clientId: string, o: { amount: number; tds?: number; day: string; mode?: string; company?: string; allocs?: Array<{ invoiceId: string; amountPaise: number; tdsPaise?: number }> }) {
    const r = await post("/sales/payments", { companyKey: o.company ?? "dspl", clientId, amountPaise: o.amount, tdsPaise: o.tds ?? 0, mode: o.mode ?? "bank_transfer", paidOn: o.day, allocations: o.allocs ?? [] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data as { id: string };
  }
  async function credit(invoiceId: string, taxable: number, day: string) {
    const r = await post("/sales/credit-notes", { invoiceId, reason: "Post not delivered", taxablePaise: taxable, issueDate: day });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data as { id: string; number: string; totalPaise: number };
  }
  async function accounts(fy: string, company = "dspl") {
    const r = await request(app).get(`/v1/sales/accounts?company=${company}&fy=${fy}`).set(auth(w().sales));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  }
  const dashboard = async (company = "dspl") => (await request(app).get(`/v1/sales/dashboard?company=${company}`).set(auth(w().sales))).body.data;
  return { post, draft, issue, pay, credit, accounts, dashboard };
}

// ─── Live figures ──────────────────────────────────────────────────────────────────────────────

describe("accounts — live figures", () => {
  let world: World;
  beforeEach(async () => { world = await seedWorld(); });
  const { post, draft, issue, pay, credit, accounts, dashboard } = api(() => world);

  it("10. invoiced counts tax invoices issued|paid only; cancelled shown apart; current FY = dashboard", async () => {
    const a = await issue(world.filmy, { day: "2025-05-10", price: L(100_000) });
    const b = await issue(world.kanara, { day: "2025-06-10", price: L(50_000) });
    const c = await issue(world.filmy, { day: "2025-07-10", price: L(10_000) });
    await pay(world.filmy, { amount: c.totalPaise, day: "2025-07-20", allocs: [{ invoiceId: c.id, amountPaise: c.totalPaise }] });
    await issue(world.filmy, { day: "2025-07-11", price: L(70_000), kind: "proforma" });
    const x = await issue(world.filmy, { day: "2025-08-10", price: L(30_000) });
    expect((await post(`/sales/invoices/${x.id}/cancel`, { reason: "Duplicate" })).status).toBe(200);
    await draft(world.filmy, { day: "2025-09-10", price: L(40_000) });
    const v = await accounts("2025-26");
    const rows = await prisma.salesInvoice.findMany({ where: { id: { in: [a.id, b.id, c.id] } } });
    const sum = (k: "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise" | "totalPaise") => rows.reduce((s, r) => s + r[k], 0);
    expect(v.invoiced.gross).toMatchObject({ count: 3, taxablePaise: sum("taxablePaise"), cgstPaise: sum("cgstPaise"), sgstPaise: sum("sgstPaise"), igstPaise: sum("igstPaise"), totalPaise: sum("totalPaise") });
    expect(v.invoiced.cancelled).toEqual({ count: 1, totalPaise: x.totalPaise });
    expect(v.fy).toMatchObject({ label: "2025-26", closed: true });

    await issue(world.filmy, { day: TODAY, price: L(12_345) });
    await issue(world.kanara, { day: TODAY, price: L(6_789) });
    const now = await accounts(CURRENT_FY);
    expect(now.invoiced.gross.totalPaise).toBe((await dashboard()).invoicedFyPaise);
    expect(now.invoiced.gross.count).toBe(2);
  });

  it("11. credit notes count by their own date, cancelled ones never", async () => {
    const inv = await issue(world.filmy, { day: "2025-05-01", price: L(100_000) });
    const c1 = await credit(inv.id, L(10_000), "2025-08-01");
    const c2 = await credit(inv.id, L(5_000), "2025-09-01");
    expect((await post(`/sales/credit-notes/${c2.id}/cancel`, {})).status).toBe(200);
    const c3 = await credit(inv.id, L(1_000), "2026-04-02");
    const y = await accounts("2025-26");
    expect(y.invoiced.creditNotes).toMatchObject({ count: 1, totalPaise: c1.totalPaise, onEarlierYearInvoices: 0 });
    expect(y.invoiced.net.totalPaise).toBe(inv.totalPaise - c1.totalPaise);
    expect(y.invoiced.net.taxablePaise).toBe(L(90_000));
    const n = await accounts("2026-27");
    expect(n.invoiced.creditNotes).toMatchObject({ count: 1, totalPaise: c3.totalPaise, onEarlierYearInvoices: 1 });
    expect(n.invoiced.net.totalPaise).toBe(-c3.totalPaise);
  });

  it("12. the FY boundary is the IST day (31 March / 1 April)", async () => {
    const mar = await issue(world.filmy, { day: "2026-03-31", price: L(1_000) });
    const apr = await issue(world.filmy, { day: "2026-04-01", price: L(2_000) });
    await pay(world.filmy, { amount: L(500), day: "2026-03-31" });
    const y = await accounts("2025-26");
    const n = await accounts("2026-27");
    expect([y.invoiced.gross.count, y.invoiced.gross.totalPaise, y.collected.receipts]).toEqual([1, mar.totalPaise, 1]);
    expect(y.months[11]).toMatchObject({ month: "2026-03", invoicedPaise: mar.totalPaise, collectedPaise: L(500) });
    expect([n.invoiced.gross.count, n.invoiced.gross.totalPaise, n.collected.receipts]).toEqual([1, apr.totalPaise, 0]);
  });

  it("13. collected = recorded receipts − issued refunds, by mode; TDS beside it; = dashboard", async () => {
    const run = async (d1: string, d2: string, d3: string) => {
      await pay(world.filmy, { amount: L(50_000), mode: "upi", day: d1 });
      const bt = await pay(world.kanara, { amount: L(30_000), tds: L(2_000), mode: "bank_transfer", day: d2 });
      const vd = await pay(world.filmy, { amount: L(10_000), tds: L(700), mode: "cash", day: d1 });
      expect((await post(`/sales/payments/${vd.id}/void`, { reason: "Bounced cheque" })).status).toBe(200);
      expect((await post(`/sales/payments/${bt.id}/refunds`, { amountPaise: L(5_000), mode: "bank_transfer", refundedOn: d3 })).status).toBe(201);
      const r2 = await post(`/sales/payments/${bt.id}/refunds`, { amountPaise: L(1_000), mode: "upi", refundedOn: d3 });
      expect((await post(`/sales/refunds/${r2.body.data.refunds.find((r: { amountPaise: number }) => r.amountPaise === L(1_000)).id}/cancel`, {})).status).toBe(200);
    };
    await run("2025-06-10", "2025-07-01", "2025-07-05");
    const v = await accounts("2025-26");
    expect(v.collected).toMatchObject({ receipts: 2, receivedPaise: L(80_000), refundedPaise: L(5_000), netPaise: L(75_000), tdsPaise: L(2_000) });
    const byMode = Object.fromEntries(v.collected.byMode.map((m: { mode: string }) => [m.mode, m]));
    expect(byMode.upi).toMatchObject({ receipts: 1, receivedPaise: L(50_000), refundedPaise: 0, netPaise: L(50_000) });
    expect(byMode.bank_transfer).toMatchObject({ receipts: 1, receivedPaise: L(30_000), refundedPaise: L(5_000), netPaise: L(25_000) });
    expect(v.collected.byMode.reduce((s: number, m: { netPaise: number }) => s + m.netPaise, 0)).toBe(v.collected.netPaise);
    expect(byMode.cash).toBeUndefined();
    expect(v.tds.totalPaise).toBe(L(2_000));

    await run(TODAY, TODAY, TODAY);
    const now = await accounts(CURRENT_FY);
    const dash = await dashboard();
    expect(now.collected.netPaise).toBe(dash.collectedFyPaise);
    expect(now.collected.tdsPaise).toBe(dash.tdsFyPaise);
    expect(now.tds.totalPaise).toBe(dash.tdsFyPaise);
  });

  it("14. receivables today: five buckets, part-paid balance, equal to the dashboard", async () => {
    const price = L(100_000); // total ₹1,18,000 intra for Filmy
    const due = (n: number) => addDays(TODAY, n);
    await issue(world.filmy, { day: TODAY, due: due(5), price });
    await issue(world.filmy, { day: due(-20), due: due(-10), price });
    await issue(world.filmy, { day: due(-50), due: due(-45), price });
    await issue(world.filmy, { day: due(-5), due: due(0), price });    // due today: 0 days late, not overdue
    await issue(world.filmy, { day: due(-40), due: due(-30), price }); // the last day of 0–30
    await issue(world.filmy, { day: due(-40), due: due(-31), price }); // the first day of 31–60
    await issue(world.filmy, { day: due(-80), due: due(-75), price });
    const old = await issue(world.kanara, { day: due(-130), due: due(-120), price });
    const part = await issue(world.filmy, { day: due(-20), due: due(-10), price });
    await pay(world.filmy, { amount: L(50_000), day: TODAY, allocs: [{ invoiceId: part.id, amountPaise: L(50_000) }] });
    const full = await issue(world.filmy, { day: due(-20), due: due(-10), price });
    await pay(world.filmy, { amount: full.totalPaise, day: TODAY, allocs: [{ invoiceId: full.id, amountPaise: full.totalPaise }] });
    await issue(world.filmy, { day: due(-20), due: due(-10), price, kind: "proforma" });
    const v = await accounts(CURRENT_FY);
    const T = L(118_000);
    const b = Object.fromEntries(v.receivables.buckets.map((x: { key: string }) => [x.key, x]));
    expect(v.receivables.buckets.map((x: { key: string }) => x.key)).toEqual(["not_due", "d0_30", "d31_60", "d61_90", "d90_plus"]);
    expect(b.not_due).toMatchObject({ paise: T, invoices: 1, label: "Not yet due" });
    expect(b.d0_30).toMatchObject({ paise: 3 * T + (T - L(50_000)), invoices: 4 });
    expect(b.d31_60).toMatchObject({ paise: 2 * T, invoices: 2 });
    expect(b.d61_90).toMatchObject({ paise: T, invoices: 1 });
    expect(b.d90_plus).toMatchObject({ paise: old.totalPaise, invoices: 1 });
    const dash = await dashboard();
    expect(v.receivables.totalPaise).toBe(dash.outstandingPaise);
    expect(v.receivables.overduePaise).toBe(dash.overduePaise);
    expect(v.receivables.invoices).toBe(9);
    expect(v.receivables.overduePaise).toBe(v.receivables.totalPaise - 2 * T); // not-due and due-today are not overdue
    expect(v.receivables.asOf).toBe(TODAY);
    expect(v.receivables.topDebtors.map((d: { clientId: string }) => d.clientId)).toEqual([world.filmy, world.kanara]);
    expect(v.receivables.topDebtors[0]).toMatchObject({ name: "Filmy Brands Private Limited", invoices: 8, oldestDue: due(-75) });
  });

  it("15. unapplied advances equal the client statement", async () => {
    const inv = await issue(world.filmy, { day: "2025-05-01", price: L(100_000) });
    await pay(world.filmy, { amount: L(20_000), tds: L(1_000), day: "2025-05-02" });
    await pay(world.filmy, { amount: L(50_000), day: "2025-05-03", allocs: [{ invoiceId: inv.id, amountPaise: L(30_000) }] });
    const c = await pay(world.filmy, { amount: L(40_000), day: "2025-05-04" });
    expect((await post(`/sales/payments/${c.id}/refunds`, { amountPaise: L(15_000), mode: "upi", refundedOn: "2025-05-05" })).status).toBe(201);
    const d = await pay(world.filmy, { amount: L(10_000), day: "2025-05-06" });
    await post(`/sales/payments/${d.id}/void`, { reason: "Entered twice" });
    const v = await accounts("2025-26");
    const stmt = (await request(app).get(`/v1/sales/clients/${world.filmy}/statement?company=dspl`).set(auth(world.sales))).body.data;
    expect(v.unapplied).toMatchObject({ cashPaise: L(20_000 + 20_000 + 25_000), tdsPaise: L(1_000), receipts: 3, clients: 1 });
    expect(v.unapplied.top).toEqual([{ clientId: world.filmy, name: "Filmy Brands Private Limited", paise: stmt.totals.unappliedPaise }]);
  });

  it("16. company isolation: Dashmani Media's books never show on Digital Sukoon's page", async () => {
    expect((await request(app).put("/v1/sales/settings/seller?company=dmpl").set(auth(world.admin)).send(DMPL)).status).toBe(200);
    const empty = await accounts(CURRENT_FY);
    const dm = await issue(world.filmy, { day: TODAY, price: L(100_000), company: "dmpl" });
    await issue(world.kanara, { day: TODAY, price: L(20_000), company: "dmpl" });
    await credit(dm.id, L(5_000), TODAY);
    const p = await pay(world.filmy, { amount: L(30_000), tds: L(2_000), day: TODAY, company: "dmpl", allocs: [{ invoiceId: dm.id, amountPaise: L(10_000), tdsPaise: L(2_000) }] });
    await post(`/sales/payments/${p.id}/refunds`, { amountPaise: L(1_000), mode: "upi", refundedOn: TODAY });
    const ds = await accounts(CURRENT_FY);
    for (const k of ["invoiced", "collected", "tds", "receivables", "unapplied", "months"] as const) expect(ds[k]).toEqual(empty[k]);
    expect(ds.gst.documents).toEqual([]);
    const dmv = await accounts(CURRENT_FY, "dmpl");
    expect(dmv.company).toBe("dmpl");
    expect(dmv.invoiced.gross.count).toBe(2);
    expect(dmv.invoiced.creditNotes.count).toBe(1);
    expect(dmv.collected).toMatchObject({ receipts: 1, refundedPaise: L(1_000), tdsPaise: L(2_000) });
    expect(dmv.receivables.invoices).toBe(2);
    expect(dmv.unapplied.cashPaise).toBe(L(19_000));
    expect(dmv.registrations.map((r: { gstin: string }) => r.gstin)).toEqual(["27AAJCD7425L1Z8"]);
    // …and the other way round.
    await issue(world.filmy, { day: TODAY, price: L(1_000) });
    expect((await accounts(CURRENT_FY, "dmpl")).invoiced.gross.count).toBe(2);
  });

  it("17. GST by registration: Mumbai and Gurugram apart, a credit note in its invoice's registration", async () => {
    const mh = await issue(world.filmy, { day: "2025-10-14", price: L(100_000) });
    const hr = await issue(world.hunch, { day: "2025-10-20", price: L(50_000) });
    expect(hr.number).toMatch(/^INV\/25-26\/\d{3}$/);
    expect(mh.number).toMatch(/^INV\/25-26\/\d{4}$/);
    const cn = await credit(hr.id, L(5_000), "2025-10-25");
    const v = await accounts("2025-26");
    expect(v.registrations.map((r: { gstin: string; current: boolean }) => [r.gstin, r.current])).toEqual([[MUMBAI, true], [GURUGRAM, true]]);
    expect(v.registrations[1].label).toBe(`Gurugram · ${GURUGRAM}`);
    const reg = (g: string) => v.gst.byRegistration.find((r: { gstin: string }) => r.gstin === g);
    const oct = (g: string) => reg(g).months.find((m: { month: string }) => m.month === "2025-10");
    expect(reg(MUMBAI).months).toHaveLength(12);
    expect(oct(MUMBAI).invoices).toMatchObject({ count: 1, taxablePaise: L(100_000), cgstPaise: L(9_000), sgstPaise: L(9_000), igstPaise: 0 });
    expect(oct(MUMBAI).creditNotes.count).toBe(0);
    expect(oct(GURUGRAM).invoices).toMatchObject({ count: 1, taxablePaise: L(50_000), cgstPaise: L(4_500), sgstPaise: L(4_500) });
    expect(oct(GURUGRAM).creditNotes).toMatchObject({ count: 1, taxablePaise: L(5_000), totalPaise: cn.totalPaise });
    for (const k of ["taxablePaise", "cgstPaise", "sgstPaise", "igstPaise", "totalPaise"]) {
      expect(oct(GURUGRAM).net[k]).toBe(oct(GURUGRAM).invoices[k] - oct(GURUGRAM).creditNotes[k]);
    }
    const docs = v.gst.documents.filter((d: { month: string }) => d.month === "2025-10");
    expect(docs).toEqual([
      { month: "2025-10", gstin: GURUGRAM, doc: "invoice", series: "INV", first: hr.number, last: hr.number, total: 1, cancelled: 0 },
      { month: "2025-10", gstin: GURUGRAM, doc: "credit_note", series: "CNHR", first: cn.number, last: cn.number, total: 1, cancelled: 0 },
      { month: "2025-10", gstin: MUMBAI, doc: "invoice", series: "INV", first: mh.number, last: mh.number, total: 1, cancelled: 0 },
    ]);
  });

  it("18. GSTR-1 sections and GSTR-3B 3.1(a)/(b), net of credit notes", async () => {
    const mk = async (name: string, profile: Record<string, unknown>) => {
      const c = await prisma.client.create({ data: { companyName: name, contactName: "X", email: `${name.replace(/\W/g, "")}@s.test`, passwordHash: "x" } });
      await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName: `${name} Ltd`, ...profile } });
      return c.id;
    };
    const sezC = await mk("SEZ Unit", { gstin: "27AAACS1234A1Z1", stateCode: "27" });
    const ka = await mk("Karnataka Retail", { stateCode: "29" });
    const mhu = await mk("Mumbai Retail", { stateCode: "27" });
    const ae = await mk("Dubai Co", { country: "AE" });
    const d = "2025-11-10";
    const b2b = await issue(world.filmy, { day: d, price: L(100_000) });
    await issue(sezC, { day: d, price: L(100_000), taxMode: "none" });
    await issue(ka, { day: d, price: L(120_000) });       // inter, total 1,41,600 → b2cl
    await issue(ka, { day: d, price: L(80_000) });        // inter, total 94,400 → b2cs
    await issue(mhu, { day: d, price: L(120_000) });      // intra → b2cs
    await issue(ae, { day: d, price: L(50_000) });        // abroad → exp
    await issue(mhu, { day: d, price: L(30_000), taxMode: "none" }); // domestic, unregistered, no tax → check
    await credit(b2b.id, L(10_000), d);
    const v = await accounts("2025-26");
    const nov = v.gst.byRegistration.find((r: { gstin: string }) => r.gstin === MUMBAI).months.find((m: { month: string }) => m.month === "2025-11");
    expect(nov.gstr3b.a).toEqual({ taxablePaise: L(90_000 + 120_000 + 80_000 + 120_000), cgstPaise: L(8_100 + 10_800), sgstPaise: L(8_100 + 10_800), igstPaise: L(21_600 + 14_400) });
    expect(nov.gstr3b.b).toEqual({ taxablePaise: L(150_000), igstPaise: 0 });
    expect(nov.b2cTaxablePaise).toBe(L(320_000));
    const check = v.gst.warnings.find((w: { code: string }) => w.code === "SECTION_CHECK");
    expect(check).toMatchObject({ count: 1, documents: [] });

    const csv = await request(app).get("/v1/sales/accounts/gst.csv?company=dspl&period=2025-11&layout=register").set(auth(world.sales));
    expect(csv.status).toBe(200);
    const lines = csv.text.replace(/^﻿/, "").trim().split("\r\n").slice(1).map((l) => l.split(","));
    const sections = lines.filter((l) => l[2] === "Tax invoice").map((l) => l[1]).sort();
    expect(sections).toEqual(["b2b", "b2cl", "b2cs", "b2cs", "check", "exp", "sez"]);
  });

  it("19. warnings: changed after the GSTR-1 due date, credit note after 30 November", async () => {
    const a = await issue(world.filmy, { day: "2025-10-10", price: L(1_000) });
    const b = await issue(world.filmy, { day: "2025-10-11", price: L(1_000) });
    const c = await issue(world.filmy, { day: "2025-10-12", price: L(1_000) });
    const d = await issue(world.filmy, { day: "2025-10-13", price: L(1_000) });
    const e = await issue(world.filmy, { day: "2025-10-14", price: L(1_000) });
    for (const x of [a, b, d, e]) expect((await post(`/sales/invoices/${x.id}/cancel`, { reason: "Wrong client" })).status).toBe(200);
    await prisma.salesInvoice.update({ where: { id: a.id }, data: { cancelledAt: new Date("2025-11-12T05:00:00Z") } }); // 12 Nov IST → late
    await prisma.salesInvoice.update({ where: { id: b.id }, data: { cancelledAt: new Date("2025-11-10T05:00:00Z") } }); // 10 Nov IST
    await prisma.salesInvoice.update({ where: { id: e.id }, data: { cancelledAt: new Date("2025-11-11T05:00:00Z") } }); // 11 Nov IST = the due day itself
    await prisma.salesInvoice.update({ where: { id: d.id }, data: { cancelledAt: new Date("2025-11-11T19:00:00Z") } }); // 12 Nov 00:30 IST (11th in UTC) → late
    await prisma.salesEvent.create({ data: { entityType: "invoice", entityId: c.id, action: "edited_after_issue", note: "x", createdAt: new Date("2025-11-15T05:00:00Z") } });
    const v = await accounts("2025-26");
    const w = v.gst.warnings.find((x: { code: string }) => x.code === "CHANGED_AFTER_DUE");
    expect(w.count).toBe(3);
    expect(w.documents.map((x: { id: string }) => x.id).sort()).toEqual([a.id, c.id, d.id].sort());
    expect(v.gst.documents.find((x: { doc: string; month: string }) => x.doc === "invoice" && x.month === "2025-10")).toMatchObject({ total: 5, cancelled: 4 });

    const old1 = await issue(world.kanara, { day: "2025-06-01", price: L(10_000) });
    const old2 = await issue(world.kanara, { day: "2025-06-02", price: L(10_000) });
    const late = await credit(old1.id, L(1_000), "2026-12-01");
    await credit(old2.id, L(1_000), "2026-11-30");
    const n = await accounts("2026-27");
    const cw = n.gst.warnings.find((x: { code: string }) => x.code === "CREDIT_NOTE_LATE");
    expect(cw).toMatchObject({ count: 1, documents: [{ id: late.id, kind: "credit_note", number: late.number }] });
    expect(n.invoiced.creditNotes.onEarlierYearInvoices).toBe(2);

    // s.34(2): the late note stays in the credit-note totals and the register, but never reduces
    // GSTR-3B 3.1 or appears in the CDNR file. The note on the deadline day itself still does.
    const mum = n.gst.byRegistration.find((r: { gstin: string }) => r.gstin === MUMBAI);
    const nov = mum.months.find((m: { month: string }) => m.month === "2026-11");
    const dec = mum.months.find((m: { month: string }) => m.month === "2026-12");
    expect(nov.gstr3b.a).toEqual({ taxablePaise: -L(1_000), cgstPaise: 0, sgstPaise: 0, igstPaise: -L(180) });
    expect(dec.creditNotes.count).toBe(1);
    expect(dec.creditNotes.igstPaise).toBe(L(180));
    expect(dec.gstr3b.a).toEqual({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
    const file = async (layout: string) => {
      const r = await request(app).get(`/v1/sales/accounts/gst.csv?company=dspl&period=2026-27&layout=${layout}${layout === "cdnr" ? `&gstin=${MUMBAI}` : ""}`).set(auth(world.sales));
      expect(r.status, r.text).toBe(200);
      return r.text;
    };
    const cdnr = await file("cdnr");
    expect(cdnr).not.toContain(late.number);
    expect(cdnr.trim().split("\r\n")).toHaveLength(2);
    expect(await file("register")).toContain(late.number);
  });

  it("20. twelve months Apr→Mar, empty months 0, a credit-note-only month negative, future flagged", async () => {
    const inv = await issue(world.filmy, { day: "2025-05-15", price: L(10_000) });
    const cn = await credit(inv.id, L(1_000), "2025-09-10");
    const v = await accounts("2025-26");
    expect(v.months.map((m: { month: string }) => m.month)).toEqual(["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
    expect(v.months[0]).toEqual({ month: "2025-04", invoicedPaise: 0, collectedPaise: 0, tdsPaise: 0, future: false });
    expect(v.months[1].invoicedPaise).toBe(inv.totalPaise);
    expect(v.months[5].invoicedPaise).toBe(-cn.totalPaise);
    const now = await accounts(CURRENT_FY);
    for (const m of now.months) expect(m.future).toBe(`${m.month}-01` > TODAY);
  });

  it("21. TDS by client and quarter, PAN from profile or GSTIN, the on-total rate hint", async () => {
    const inv = await issue(world.filmy, { day: "2025-05-01", price: L(100_000) }); // total 1,18,000
    const tds = L(2_360); // 2% of the TOTAL incl. GST
    await pay(world.filmy, { amount: inv.totalPaise - tds, tds, day: "2025-05-10", allocs: [{ invoiceId: inv.id, amountPaise: inv.totalPaise - tds, tdsPaise: tds }] });
    await pay(world.filmy, { amount: L(1_000), tds: L(5_000), day: "2025-11-10" });
    await pay(world.kanara, { amount: L(1_000), tds: L(10_000), day: "2026-01-15" });
    const vd = await pay(world.kanara, { amount: L(1_000), tds: L(7_000), day: "2025-08-01" });
    await post(`/sales/payments/${vd.id}/void`, { reason: "Entered twice" });
    const v = await accounts("2025-26");
    expect(v.tds).toMatchObject({ totalPaise: L(17_360), receipts: 3, byQuarter: [tds, 0, L(5_000), L(10_000)] });
    const [a, b] = v.tds.clients;
    expect(a).toMatchObject({ clientId: world.kanara, pan: "AAACB1234F", panSource: "gstin", gstin: "29AAACB1234F1Z9", quarters: [0, 0, 0, L(10_000)], totalPaise: L(10_000), receipts: 1, rates: [] });
    expect(b).toMatchObject({ clientId: world.filmy, name: "Filmy Brands Private Limited", pan: "AABCU9603R", panSource: "profile", quarters: [tds, 0, L(5_000), 0], totalPaise: L(7_360), receipts: 2 });
    expect(b.rates).toHaveLength(1);
    expect(b.rates[0]).toMatchObject({ kind: "on_total" });
    expect(b.rates[0].label).toBe("2% on the total incl. GST — should be on ₹1,00,000");

    const csv = await request(app).get("/v1/sales/accounts/tds.csv?company=dspl&fy=2025-26").set(auth(world.sales));
    expect(csv.status).toBe(200);
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="tds-by-client-dspl-2025-26.csv"');
    const rows = csv.text.replace(/^﻿/, "").split("\r\n");
    expect(rows[0]).toBe("Client,Legal name,PAN,PAN source,GSTIN,Q1 Apr-Jun,Q2 Jul-Sep,Q3 Oct-Dec,Q4 Jan-Mar,Total TDS,Receipts with TDS,Rates seen");
    expect(rows[2]).toBe("Filmy Brands,Filmy Brands Private Limited,AABCU9603R,profile,27AABCU9603R1ZX,2360.00,0.00,5000.00,0.00,7360.00,2,\"2% on the total incl. GST — should be on ₹1,00,000\"");
  });

  it("22. years and filed-vs-live comparison", async () => {
    await issue(world.filmy, { day: "2025-09-01", price: L(820_000) });
    const filed = await request(app).put("/v1/sales/accounts/filed/2025-26?company=dspl").set(auth(world.admin))
      .send({ ...Object.fromEntries(FILED_FIGURE_KEYS.map((k) => [k, null])), revenuePaise: L(1_000_000), enteredIn: "rupees", notes: null, baseUpdatedAt: null });
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    const v = await accounts("2025-26");
    expect(v.comparison).toEqual({ state: "closed_filed", filedRevenuePaise: L(1_000_000), liveNetTaxablePaise: L(820_000), gapPaise: L(180_000), gapBp: 1800 });
    expect(v.filed.figures.revenuePaise).toBe(L(1_000_000));
    const y = v.years.find((x: { fy: string }) => x.fy === "2025-26");
    expect(y).toMatchObject({ closed: true, liveInvoices: 1, liveNetTaxablePaise: L(820_000), gapPaise: L(180_000) });
    expect((await accounts("2024-25")).comparison.state).toBe("closed_not_filed");
    const now = await accounts(CURRENT_FY);
    expect(now.comparison).toMatchObject({ state: "current", filedRevenuePaise: null, gapPaise: null });
    expect(now.filed).toBeNull();
    const start = Number(CURRENT_FY.slice(0, 4));
    expect(now.years.slice(0, 4).map((x: { fy: string }) => x.fy)).toEqual(fyLabelsBetween(`${start - 3}-${String((start - 2) % 100).padStart(2, "0")}`, CURRENT_FY));
    expect(now.years[0]).toMatchObject({ fy: CURRENT_FY, closed: false });
  });

  it("23. the snapshot is read-only: only SELECTs inside a READ ONLY transaction", async () => {
    await issue(world.filmy, { day: "2025-05-01", price: L(1_000) });
    const calls: string[] = [];
    const real = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, opts: unknown) => {
      if (typeof fn !== "function") return real(fn as never, opts as never);
      return real(async (tx: Record<string, unknown>) => {
        const proxy = new Proxy(tx, {
          get(target, prop: string) {
            const v = target[prop];
            if (typeof v === "function") return (...args: unknown[]) => { calls.push(prop === "$executeRawUnsafe" ? `exec:${String(args[0])}` : prop); return (v as (...a: unknown[]) => unknown).apply(target, args); };
            if (v && typeof v === "object") return new Proxy(v as Record<string, unknown>, { get(t2, p2: string) { const f = t2[p2]; if (typeof f === "function") { calls.push(`${prop}.${p2}`); return (f as (...a: unknown[]) => unknown).bind(t2); } return f; } });
            return v;
          },
        });
        return (fn as (t: unknown) => unknown)(proxy);
      }, opts as never);
    }) as never);
    try {
      await getAccounts("dspl", "2025-26");
    } finally {
      spy.mockRestore();
    }
    expect(calls[0]).toBe("exec:SET TRANSACTION READ ONLY");
    expect(calls[1]).toBe("exec:SET LOCAL statement_timeout = '10s'");
    const rest = calls.slice(2);
    expect(rest.filter((c) => c !== "$queryRaw")).toEqual(["financeFiledYear.findMany", "client.findMany"]);
    expect(rest.filter((c) => c === "$queryRaw")).toHaveLength(12);
  });

  it("24. gates and parameters", async () => {
    for (const p of ["/sales/accounts", "/sales/accounts/gst.csv?period=2025-10", "/sales/accounts/tds.csv", "/sales/accounts/filed"]) {
      expect((await request(app).get(`/v1${p}`).set(auth(world.sales))).status, p).toBe(200);
      expect((await request(app).get(`/v1${p}`).set(auth(world.employee))).status, p).toBe(403);
      expect((await request(app).get(`/v1${p}`).set(auth(world.hr))).status, p).toBe(403);
      expect((await request(app).get(`/v1${p}`)).status, p).toBe(401);
    }
    const err = async (q: string) => (await request(app).get(`/v1/sales/accounts?${q}`).set(auth(world.sales))).body.error;
    expect(await err("fy=2025-27")).toMatchObject({ code: "BAD_FY", message: "Pick a financial year like 2025-26." });
    expect(await err("fy=2099-00")).toMatchObject({ code: "BAD_FY", message: "2099-00 hasn't started yet." });
    expect((await err("fy=2009-10")).code).toBe("BAD_FY");
    expect((await err("company=xyz")).code).toBe("BAD_COMPANY");
  });
});

// ─── CSVs: the worked example (§4.9) one FY earlier ────────────────────────────────────────────

describe("accounts — GST CSVs", () => {
  let world: World;
  beforeEach(async () => { world = await seedWorld(); });
  const { post, issue, credit, accounts } = api(() => world);
  const csv = (q: string) => request(app).get(`/v1/sales/accounts/gst.csv?company=dspl&${q}`).set(auth(world.sales)).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  const lines = (b: Buffer) => b.toString("utf8").replace(/^﻿/, "").split("\r\n").filter(Boolean);

  async function workedExample() {
    const mk = async (name: string, legal: string, profile: Record<string, unknown>) => {
      const c = await prisma.client.create({ data: { companyName: name, contactName: "X", email: `${name.replace(/\W/g, "") || "x"}@w.test`, passwordHash: "x" } });
      await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName: legal, ...profile } });
      return c.id;
    };
    const filmy = await issue(world.filmy, { day: "2025-10-14", due: "2025-10-29", price: L(100_000) });
    const hunch = await issue(world.hunch, { day: "2025-10-20", due: "2025-11-04", price: L(50_000) });
    const kanara = await issue(world.kanara, { day: "2025-10-22", due: "2025-11-06", price: L(200_000) });
    const cn = await credit(kanara.id, L(20_000), "2025-10-30");
    const sez = await issue(await mk("SEZ Unit", "SEZ Unit Private Limited", { gstin: "27AAACS1234A1Z1", stateCode: "27" }), { day: "2025-10-24", price: L(10_000), taxMode: "none" });
    await issue(await mk("Mumbai Retail", "Mumbai Retail", { stateCode: "27" }), { day: "2025-10-25", price: L(5_000) });
    await issue(await mk("Dubai Co", "Dubai Co LLC", { country: "AE" }), { day: "2025-10-26", price: L(7_000) });
    await issue(await mk("Formula", "=CMD()", { gstin: "27AABCF1234A1Z1", stateCode: "27" }), { day: "2025-10-27", price: L(1_000) });
    const gone = await issue(world.filmy, { day: "2025-10-28", price: L(3_000) });
    expect((await post(`/sales/invoices/${gone.id}/cancel`, { reason: "Wrong client" })).status).toBe(200);
    return { filmy, hunch, kanara, cn, sez, gone };
  }

  it("25. GSTR-1 B2B: offline-tool headers, the Filmy row byte for byte, SEZ in, B2C and export out", async () => {
    const w = await workedExample();
    const r = await csv(`period=2025-10&layout=b2b&gstin=${MUMBAI}`);
    expect(r.status).toBe(200);
    const buf = r.body as Buffer;
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.headers["content-disposition"]).toBe(`attachment; filename="gstr1-b2b-${MUMBAI}-2025-10.csv"`);
    expect(r.headers["access-control-expose-headers"]).toBe("Content-Disposition");
    expect(r.headers["cache-control"]).toBe("no-store");
    const ls = lines(buf);
    expect(ls[0]).toBe("GSTIN/UIN of Recipient,Receiver Name,Invoice Number,Invoice date,Invoice Value,Place Of Supply,Reverse Charge,Applicable % of Tax Rate,Invoice Type,E-Commerce GSTIN,Rate,Taxable Value,Cess Amount,Integrated Tax,Central Tax,State/UT Tax");
    expect(ls[1]).toBe(`27AABCU9603R1ZX,Filmy Brands Private Limited,${w.filmy.number},14-Oct-2025,118000.00,27-Maharashtra,N,,Regular B2B,,18,100000.00,0.00,0.00,9000.00,9000.00`);
    expect(ls).toHaveLength(5); // header + Filmy, Kanara, SEZ, =CMD() (Gurugram, B2C, export and the cancelled one are not here)
    expect(ls[2]).toBe(`29AAACB1234F1Z9,Kanara Foods Private Limited,${w.kanara.number},22-Oct-2025,236000.00,29-Karnataka,N,,Regular B2B,,18,200000.00,0.00,36000.00,0.00,0.00`);
    expect(ls[3]).toContain(`,${w.sez.number},24-Oct-2025,10000.00,27-Maharashtra,N,,SEZ supplies without payment,,18,10000.00,0.00,0.00,0.00,0.00`);
    expect(ls[4]).toContain(",'=CMD(),");
    expect(ls.join("\n")).not.toContain(w.hunch.number + ",20-Oct");

    const g = lines((await csv(`period=2025-10&layout=b2b&gstin=${GURUGRAM}`)).body as Buffer);
    expect(g).toHaveLength(2);
    expect(g[1]).toBe(`06AABCH1234M1Z5,Hunch Media Private Limited,${w.hunch.number},20-Oct-2025,59000.00,06-Haryana,N,,Regular B2B,,18,50000.00,0.00,0.00,4500.00,4500.00`);
  });

  it("26. CDNR row; the register lists cancelled invoices and credit notes as bare negatives and sums to the net", async () => {
    const w = await workedExample();
    const cd = lines((await csv(`period=2025-10&layout=cdnr&gstin=${MUMBAI}`)).body as Buffer);
    expect(cd[0]).toBe("GSTIN/UIN of Recipient,Receiver Name,Note Number,Note Date,Note Type,Place Of Supply,Reverse Charge,Note Supply Type,Note Value,Applicable % of Tax Rate,Rate,Taxable Value,Cess Amount,Integrated Tax,Central Tax,State/UT Tax");
    expect(cd[1]).toBe(`29AAACB1234F1Z9,Kanara Foods Private Limited,${w.cn.number},30-Oct-2025,C,29-Karnataka,N,Regular B2B,23600.00,,18,20000.00,0.00,3600.00,0.00,0.00`);
    expect(cd).toHaveLength(2);

    const r = await csv("period=2025-10&layout=register");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="sales-register-dspl-2025-10.csv"');
    const reg = lines(r.body as Buffer).map((l) => l.split(","));
    expect(reg[0].join(",")).toBe("Seller GSTIN,Section,Document,Number,Date,Status,Recipient GSTIN,Recipient name,Place of supply,Tax mode,Rate %,Taxable value,CGST,SGST,IGST,Round off,Document value,Against invoice,Cancelled on");
    const cnRow = reg.find((l) => l[3] === w.cn.number)!;
    expect(cnRow.slice(11, 18)).toEqual(["-20000.00", "0.00", "0.00", "-3600.00", "0.00", "-23600.00", w.kanara.number]);
    const goneRow = reg.find((l) => l[3] === w.gone.number)!;
    expect(goneRow[5]).toBe("cancelled");
    expect(goneRow[18]).toBe(TODAY); // cancelled today, as an IST day
    expect(goneRow[11]).toBe("");
    const sumTaxable = reg.slice(1).reduce((s, l) => s + (l[11] ? Math.round(Number(l[11]) * 100) : 0), 0);
    const v = await accounts("2025-26");
    expect(sumTaxable).toBe(v.invoiced.net.taxablePaise);
    const sumTotal = reg.slice(1).reduce((s, l) => s + (l[16] ? Math.round(Number(l[16]) * 100) : 0), 0);
    expect(sumTotal).toBe(v.invoiced.net.totalPaise);
  });

  it("27b. the register for a former registration and for documents with no seller GSTIN", async () => {
    const w = await workedExample();
    const FORMER = "27AAKCD3352K2ZE";
    await prisma.$executeRaw`UPDATE sales_invoices SET seller_snapshot = jsonb_set(seller_snapshot, '{gstin}', to_jsonb(${FORMER}::text)) WHERE id = ${w.filmy.id}`;
    await prisma.$executeRaw`UPDATE sales_invoices SET seller_snapshot = seller_snapshot - 'gstin' WHERE id = ${w.hunch.id}`;
    const numbers = (b: Buffer) => lines(b).slice(1).map((l) => l.split(",")[3]);
    const former = await csv(`period=2025-10&layout=register&gstin=${FORMER}`);
    expect(former.status).toBe(200);
    expect(former.headers["content-disposition"]).toBe(`attachment; filename="sales-register-dspl-${FORMER}-2025-10.csv"`);
    expect(numbers(former.body as Buffer)).toEqual([w.filmy.number]);
    const none = await csv("period=2025-10&layout=register&gstin=none");
    expect(none.headers["content-disposition"]).toBe('attachment; filename="sales-register-dspl-no-gstin-2025-10.csv"');
    expect(numbers(none.body as Buffer)).toEqual([w.hunch.number]);
    const all = numbers((await csv("period=2025-10&layout=register")).body as Buffer);
    expect(all).toContain(w.filmy.number);
    expect(all).toContain(w.hunch.number);
    const bad = await request(app).get("/v1/sales/accounts/gst.csv?company=dspl&period=2025-10&layout=register&gstin=xyz").set(auth(world.sales));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("UNKNOWN_REGISTRATION");
    // GSTR-1 files still take only a current registration.
    expect((await request(app).get(`/v1/sales/accounts/gst.csv?company=dspl&period=2025-10&layout=b2b&gstin=${FORMER}`).set(auth(world.sales))).body.error.code).toBe("UNKNOWN_REGISTRATION");
  });

  it("27. CSV errors", async () => {
    const code = async (q: string) => { const r = await request(app).get(`/v1/sales/accounts/gst.csv?company=dspl&${q}`).set(auth(world.sales)); return [r.status, r.body.error?.code, r.body.error?.message]; };
    expect((await code("period=2025-13"))[1]).toBe("BAD_PERIOD");
    expect((await code("period=2099-01"))[0]).toBe(400);
    expect((await code("layout=b2b"))[1]).toBe("BAD_PERIOD");
    const pick = await code("period=2025-10&layout=b2b");
    expect(pick.slice(0, 2)).toEqual([400, "PICK_REGISTRATION"]);
    expect(pick[2]).toBe(`Digital Sukoon files GST from 2 registrations — pick Mumbai (${MUMBAI}) or Gurugram (${GURUGRAM}).`);
    expect((await code("period=2025-10&layout=cdnr"))[1]).toBe("PICK_REGISTRATION");
    expect((await code("period=2025-10&layout=b2b&gstin=27AAJCD7425L1Z8"))).toEqual([400, "UNKNOWN_REGISTRATION", "27AAJCD7425L1Z8 is not one of Digital Sukoon's GST registrations."]);
    expect((await code("period=2025-10&layout=x"))[1]).toBe("BAD_LAYOUT");
    // The register needs no registration and an empty period is a header-only file.
    const empty = await request(app).get("/v1/sales/accounts/gst.csv?company=dspl&period=2025-26-Q1").set(auth(world.sales));
    expect(empty.status).toBe(200);
  });
});
