/**
 * Tally export + Send to Tally through the real routes and database (spec-tally §8.2, T1–T31).
 * Seeding happens inside each describe's beforeEach (vitest runs same-level hooks in parallel).
 * The push tests swap in a fake Tally (setTallyTransportForTests); the real-socket test talks to a
 * local http server with SALES_TALLY_ALLOW_LOOPBACK=1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import { gunzipSync, gzipSync } from "zlib";
import { createHash } from "crypto";
import request from "supertest";
import { prisma } from "@dashmani/db";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { flushSalesBackground } from "../src/services/sales/common";
import { setTallyTransportForTests, type TallyTransport, type TransportResult } from "../src/services/sales/tally/push.service";
import { pushRegistry } from "../src/services/sales/tally/export.service";
import { messageBlocks } from "../src/services/sales/tally/xml-read";
import { createTestRole, createTestUser, generateToken } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const HARYANA = { label: "Gurugram", gstin: "06AAKCD3352K1ZJ", addressLine1: "Hunch Circle, Sector 29", city: "Gurugram", pincode: "122001", invoicePrefix: "INVHR", creditNotePrefix: "CNHR", serialDigits: 3 };
const SELLER = {
  legalName: "Digital Sukoon Private Limited", gstin: "27AAKCD3352K1ZF", pan: "AAKCD3352K", addressLine1: "702, Parinee I, Andheri West", city: "Mumbai",
  state: "Maharashtra", stateCode: "27", pincode: "400053", invoicePrefix: "INV", creditNotePrefix: "CN", bankName: "IDFC First Bank", accountNumber: "88452818788",
  ifsc: "IDFB0040178", branches: [HARYANA],
};
const DMPL = { legalName: "Dashmani Media Private Limited", gstin: "27AAJCD7425L1Z8", addressLine1: "Off-702 Parinee I", city: "Mumbai", stateCode: "27", pincode: "400053", invoicePrefix: "DM", creditNotePrefix: "DMCN", quotePrefix: "DMQ", orderPrefix: "DMSO", receiptPrefix: "DMRC" };
const TALLY = (over: Record<string, unknown> = {}) => ({
  booksFrom: "2026-04-01",
  registrations: [{ gstin: "27AAKCD3352K1ZF", tallyCompany: "Digital Sukoon Private Limited", registrationName: "Maharashtra Registration" }, { gstin: "06AAKCD3352K1ZJ", tallyCompany: "Digital Sukoon Private Limited", registrationName: "Haryana Registration" }],
  ledgers: { bank: "IDFC First Bank A/c 8788" },
  ledgersConfirmed: true,
  ...over,
});
const OCT = { from: "2026-10-01", to: "2026-10-31" };

let sales: string;
let adminT: string;
let employee: string;
const clients: Record<string, string> = {};

async function seed() {
  await prisma.systemSetting.deleteMany({ where: { OR: [{ key: { startsWith: "sales.seller" } }, { key: { startsWith: "sales.tally" } }] } });
  await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
  await createTestRole("Admin", ["view", "manage", "approve"].map((action) => ({ resource: "sales", action, scope: "global" })));
  await createTestRole("Employee", [{ resource: "tasks", action: "view", scope: "own" }]);
  const [u, a, e] = await Promise.all([createTestUser({ roleNames: ["Sales"] }), createTestUser({ roleNames: ["Admin"] }), createTestUser({ roleNames: ["Employee"] })]);
  sales = generateToken(u.id, u.email, ["Sales"]);
  adminT = generateToken(a.id, a.email, ["Admin"]);
  employee = generateToken(e.id, e.email, ["Employee"]);
  for (const [key, name, gstin, city] of [["mh", "Filmy Brands Private Limited", "27AABCU9603R1ZX", "Mumbai"], ["ka", "Bengaluru Beats Private Limited", "29AAACB1234F1Z9", "Bengaluru"], ["hr", "Gurgaon Grooves Private Limited", "06AABCH1234A1Z5", "Gurugram"]] as const) {
    const c = await prisma.client.create({ data: { companyName: name.split(" ")[0], contactName: "X", email: `${key}-${Date.now()}@c.test`, passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: c.id, legalName: name, gstin, pan: gstin.slice(2, 12), stateCode: gstin.slice(0, 2), addressLine1: "1 Road", city, pincode: "400050", state: "S" } });
    clients[key] = c.id;
  }
  expect((await request(app).put("/v1/sales/settings/seller").set(auth(adminT)).send(SELLER)).status).toBe(200);
  expect((await request(app).put("/v1/sales/settings/seller?company=dmpl").set(auth(adminT)).send(DMPL)).status).toBe(200);
}
const saveTally = async (over: Record<string, unknown> = {}, company = "dspl") => {
  const r = await request(app).put(`/v1/sales/tally/settings?company=${company}`).set(auth(adminT)).send(TALLY(over));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};

async function invoice(client: string, o: { amount?: number; issueDate?: string; sac?: string; company?: string; extra?: Record<string, unknown> } = {}) {
  const d = await request(app).post("/v1/sales/invoices").set(auth(sales)).send({
    companyKey: o.company ?? "dspl", clientId: clients[client], items: [{ description: "Instagram reel", unitPricePaise: o.amount ?? 10_000_000, ...(o.sac ? { sac: o.sac } : {}) }], ...(o.extra ?? {}),
  });
  expect(d.status, JSON.stringify(d.body)).toBe(201);
  const i = await request(app).post(`/v1/sales/invoices/${d.body.data.id}/issue`).set(auth(sales)).send({ issueDate: o.issueDate ?? "2026-10-10", ...(o.extra?.taxMode ? { taxResolution: "keep" } : {}) });
  expect(i.status, JSON.stringify(i.body)).toBe(200);
  return i.body.data as { id: string; number: string; totalPaise: number; taxablePaise: number };
}
async function pay(client: string, o: { amount: number; tds?: number; paidOn?: string; allocs?: Array<{ invoiceId: string; amountPaise: number; tdsPaise?: number }>; mode?: string; company?: string }) {
  const r = await request(app).post("/v1/sales/payments").set(auth(sales)).send({
    companyKey: o.company ?? "dspl", clientId: clients[client], amountPaise: o.amount, tdsPaise: o.tds ?? 0, mode: o.mode ?? "bank_transfer", reference: "UTR123", paidOn: o.paidOn ?? "2026-10-20", allocations: o.allocs ?? [],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; number: string };
}
const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString();
async function preview(o: { from?: string; to?: string; mode?: string; gstin?: string; company?: string; token?: string } = {}) {
  return request(app).get(`/v1/sales/tally/preview?${qs({ company: o.company ?? "dspl", from: o.from ?? OCT.from, to: o.to ?? OCT.to, mode: o.mode ?? "new_only", gstin: o.gstin })}`).set(auth(o.token ?? sales));
}
async function exportRun(o: { from?: string; to?: string; mode?: string; gstin?: string; ack?: boolean; allowPartial?: boolean; token?: string; path?: string } = {}) {
  const p = await preview(o);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const acks = o.ack === false ? [] : p.body.data.issues.filter((i: { severity: string }) => i.severity === "ack").map((i: { id: string }) => i.id);
  return request(app).post(`/v1/sales/tally/${o.path ?? "runs"}`).set(auth(o.token ?? sales)).send({
    companyKey: "dspl", from: o.from ?? OCT.from, to: o.to ?? OCT.to, gstin: o.gstin ?? null, mode: o.mode ?? "new_only", previewHash: p.body.data.previewHash, acknowledge: acks, allowPartial: o.allowPartial ?? false,
  });
}
const confirm = (id: string, created: number, extra: Record<string, number> = {}, token = sales) =>
  request(app).post(`/v1/sales/tally/runs/${id}/confirm`).set(auth(token)).send({ created, errors: 0, note: "Imported by Priya on 2 Dec", ...extra });
async function vouchersXml(runId: string) {
  const r = await prisma.salesTallyRun.findUniqueOrThrow({ where: { id: runId } });
  return gunzipSync(Buffer.from(r.vouchersXmlGz!)).toString("ascii");
}

// ─────────────────────────────────────────────────────────────────────────────────

describe("settings, RBAC and refusals (T1–T4, T31)", () => {
  beforeEach(seed);

  it("T2: refuses by default — no settings, corrupted settings, missing booksFrom", async () => {
    const r = await preview();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("TALLY_NOT_CONFIGURED");
    expect(r.body.error.details).toBeUndefined();
    const view = await request(app).get("/v1/sales/tally/settings").set(auth(sales));
    expect(view.body.data).toMatchObject({ saved: false, pushEnabled: false });
    expect(view.body.data.settings.ledgers.bank).toBe("IDFC First Bank A/c 8788");
    expect(view.body.data.settings.registrations.map((x: { registrationName: string }) => x.registrationName)).toEqual(["Maharashtra Registration", "Haryana Registration"]);
    await prisma.systemSetting.create({ data: { key: "sales.tally", value: "{not json" } });
    expect((await preview()).body.error.code).toBe("TALLY_NOT_CONFIGURED");
    await prisma.systemSetting.delete({ where: { key: "sales.tally" } });
    const saved = await saveTally({ booksFrom: null });
    expect(saved.missing).toContain("the date Tally's books already cover");
    expect((await preview()).body.error.code).toBe("TALLY_NOT_CONFIGURED");
  });

  it("T1: RBAC — Sales previews, exports and confirms; admin-only routes refuse Sales; Employee refused everywhere", async () => {
    await saveTally();
    await invoice("mh");
    expect((await preview()).status).toBe(200);
    const run = await exportRun();
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect((await confirm(run.body.data.id, 1)).status).toBe(200);
    for (const [method, path] of [["put", "/v1/sales/tally/settings"], ["post", "/v1/sales/tally/test"], ["post", "/v1/sales/tally/pushes"], ["post", `/v1/sales/tally/runs/${run.body.data.id}/retry`], ["post", "/v1/sales/tally/parties/match"], ["post", "/v1/sales/tally/resolve"]] as const) {
      expect((await request(app)[method](path).set(auth(sales)).send({})).status, path).toBe(403);
    }
    for (const path of ["/v1/sales/tally/settings", "/v1/sales/tally/runs", `/v1/sales/tally/runs/${run.body.data.id}`, "/v1/sales/tally/parties"]) {
      expect((await request(app).get(path).set(auth(employee))).status, path).toBe(403);
    }
    expect((await preview({ token: employee })).status).toBe(403);
  });

  it("T3 (R/G): Tally settings never leak into an issued invoice's seller snapshot", async () => {
    await saveTally({ pushUrl: "http://100.101.102.103:9000" });
    const inv = await invoice("mh");
    const row = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    const snap = JSON.stringify(row.sellerSnapshot);
    for (const k of ["pushUrl", "ledgers", "tally", "booksFrom", "100.101.102.103"]) expect(snap).not.toContain(k);
  });

  it("T4 (R/G): changing a ledger name un-ticks 'These names match our Tally'", async () => {
    await saveTally();
    const r = await request(app).put("/v1/sales/tally/settings").set(auth(adminT)).send(TALLY({ ledgers: { bank: "IDFC First Bank A/c 8788", outputCgst: "CGST Payable" } }));
    expect(r.status).toBe(200);
    const stored = JSON.parse((await prisma.systemSetting.findUniqueOrThrow({ where: { key: "sales.tally" } })).value);
    expect(stored.ledgersConfirmed).toBe(false);
    expect(r.body.data.missing).toContain("ticking 'These names match our Tally'");
    // Saving the same names again keeps a fresh tick.
    await request(app).put("/v1/sales/tally/settings").set(auth(adminT)).send(TALLY({ ledgers: { bank: "IDFC First Bank A/c 8788", outputCgst: "CGST Payable" } }));
    expect(JSON.parse((await prisma.systemSetting.findUniqueOrThrow({ where: { key: "sales.tally" } })).value).ledgersConfirmed).toBe(true);
  });

  it("refuses a registration the company does not hold", async () => {
    const r = await request(app).put("/v1/sales/tally/settings").set(auth(adminT)).send(TALLY({ registrations: [{ gstin: "29AAACB1234F1Z9", tallyCompany: "X Co" }] }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("UNKNOWN_REGISTRATION");
  });

  it("T31: tally_run events are readable; TALLY_* errors carry no details", async () => {
    await saveTally();
    await invoice("mh");
    const run = await exportRun();
    const ev = await request(app).get(`/v1/sales/events?entityType=tally_run&entityId=${run.body.data.id}`).set(auth(sales));
    expect(ev.status).toBe(200);
    expect(ev.body.data.map((e: { action: string }) => e.action)).toContain("built");
    const again = await exportRun();
    expect(again.body.error.code).toBe("TALLY_RUN_OPEN");
    expect(again.body.error.details).toBeUndefined();
    const bad = await request(app).get(`/v1/sales/tally/runs/${run.body.data.id}/file?part=nope`).set(auth(sales));
    expect(bad.body.error).toMatchObject({ code: "BAD_QUERY" });
    expect((await request(app).get(`/v1/sales/tally/documents/order/x`).set(auth(sales))).body.error.code).toBe("BAD_QUERY");
  });
});

describe("selection, routing, blocking, staleness (T5–T9, T30)", () => {
  beforeEach(async () => { await seed(); await saveTally(); });

  it("T5: selection and the 'Tally should show' block; dmpl never leaks (I9)", async () => {
    const a = await invoice("mh", { issueDate: "2026-10-05" });
    const b = await invoice("ka", { issueDate: "2026-10-06" });
    const c = await invoice("mh", { issueDate: "2026-10-07" });
    expect((await request(app).post(`/v1/sales/invoices/${c.id}/cancel`).set(auth(sales)).send({ reason: "Wrong client" })).status).toBe(200);
    await request(app).post("/v1/sales/invoices").set(auth(sales)).send({ clientId: clients.mh, items: [{ description: "Draft", unitPricePaise: 100 }] });
    const pf = await request(app).post("/v1/sales/invoices").set(auth(sales)).send({ clientId: clients.ka, kind: "proforma", items: [{ description: "Advance", unitPricePaise: 1_000_000 }] });
    const pfi = await request(app).post(`/v1/sales/invoices/${pf.body.data.id}/issue`).set(auth(sales)).send({ issueDate: "2026-10-08" });
    await pay("ka", { amount: 1_180_000, paidOn: "2026-10-09", allocs: [{ invoiceId: pfi.body.data.id, amountPaise: 1_180_000 }] });
    expect((await request(app).post("/v1/sales/credit-notes").set(auth(sales)).send({ invoiceId: a.id, reason: "Story dropped", taxablePaise: 1_000_000, issueDate: "2026-10-15" })).status).toBe(201);
    await pay("mh", { amount: a.totalPaise - 1_180_000 - 200_000, tds: 200_000, paidOn: "2026-10-20", allocs: [{ invoiceId: a.id, amountPaise: a.totalPaise - 1_180_000 - 200_000, tdsPaise: 200_000 }] });
    const voided = await pay("ka", { amount: 50_000, paidOn: "2026-10-21" });
    await request(app).post(`/v1/sales/payments/${voided.id}/void`).set(auth(sales)).send({ reason: "Bounced cheque" });
    const adv = await pay("ka", { amount: 300_000, paidOn: "2026-10-22" });
    expect((await request(app).post(`/v1/sales/payments/${adv.id}/refunds`).set(auth(sales)).send({ amountPaise: 100_000, mode: "bank_transfer", refundedOn: "2026-10-25" })).status).toBe(201);
    await invoice("mh", { issueDate: "2026-10-12", company: "dmpl" });
    await saveTally({ booksFrom: "2026-10-04" });
    await invoice("mh", { issueDate: "2026-10-03" });

    const r = await preview();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = r.body.data;
    expect(p.counts.sales).toEqual({ create: 3, alter: 0, cancel: 0 });
    expect(p.counts.creditNotes.create).toBe(1);
    expect(p.counts.receipts.create).toBe(3); // proforma advance, TDS receipt, the advance that was refunded
    expect(p.counts.refunds.create).toBe(1);
    expect(p.counts.beforeBooks).toBe(1);
    expect(p.counts.skipped).toBe(1);
    const codes = p.issues.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["ADVANCE_RECEIVED", "VOIDED_NEVER_SENT", "BEFORE_BOOKS_EXCLUDED", "FIRST_EXPORT_OVERLAP"]));
    expect(p.documents.some((d: { number: string }) => d.number?.startsWith("PI"))).toBe(false);
    const g = p.tallyShouldShow.gst.find((x: { gstin: string }) => x.gstin === "27AAKCD3352K1ZF");
    expect(g.documents).toMatchObject({ issued: 2, cancelled: 1 });
    expect(g.b2b.taxablePaise).toBe(a.taxablePaise + b.taxablePaise);
    expect(g.creditNotes.taxablePaise).toBe(1_000_000);
    expect(p.tallyShouldShow.tds).toEqual([{ fy: "2026-27", ledger: "TDS Receivable", paise: 200_000, receipts: 1 }]);
    const run = await exportRun();
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const xml = await vouchersXml(run.body.data.id);
    expect(xml).not.toContain("DM/");
    expect(xml).toContain("<ISCANCELLED>Yes</ISCANCELLED>");
    expect(xml).not.toContain('VCHTYPE="Journal"');
    expect(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(xml)).toBe(true);
  });

  it("T6: routing — two Tally companies need a registration; receipts spanning them are blocked", async () => {
    const split = { registrations: [{ gstin: "27AAKCD3352K1ZF", tallyCompany: "Digital Sukoon Private Limited" }, { gstin: "06AAKCD3352K1ZJ", tallyCompany: "Digital Sukoon Gurugram" }] };
    await saveTally(split);
    await saveTally(split); // the first save un-ticked the check (names changed); the second re-ticks it
    const mh = await invoice("mh");
    const hr = await invoice("hr");
    await request(app).post("/v1/sales/credit-notes").set(auth(sales)).send({ invoiceId: hr.id, reason: "Discount", taxablePaise: 100_000, issueDate: "2026-10-15" });
    expect((await preview()).body.error.code).toBe("TALLY_PICK_REGISTRATION");
    const g = await preview({ gstin: "06AAKCD3352K1ZJ" });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.data.tallyCompany).toBe("Digital Sukoon Gurugram");
    const nums = g.body.data.documents.map((d: { number: string }) => d.number);
    expect(nums).toHaveLength(2);
    expect(nums).toEqual(expect.arrayContaining([hr.number, expect.stringMatching(/^CNHR/)]));
    const run = await exportRun({ gstin: "06AAKCD3352K1ZJ" });
    expect(await vouchersXml(run.body.data.id)).toContain("<SVCURRENTCOMPANY>Digital Sukoon Gurugram</SVCURRENTCOMPANY>");
    await request(app).post(`/v1/sales/tally/runs/${run.body.data.id}/discard`).set(auth(sales)).send({ reason: "Test only" });
    // The same client billed once from each registration (chosen by hand), then one receipt paying both.
    const fromHr = await invoice("mh", { extra: { sellerGstin: "06AAKCD3352K1ZJ" } });
    await pay("mh", { amount: 400_000, allocs: [{ invoiceId: mh.id, amountPaise: 200_000 }, { invoiceId: fromHr.id, amountPaise: 200_000 }] });
    const both = [...(await preview({ gstin: "27AAKCD3352K1ZF" })).body.data.issues, ...(await preview({ gstin: "06AAKCD3352K1ZJ" })).body.data.issues];
    expect(both.map((i: { code: string }) => i.code)).toContain("RECEIPT_SPANS_COMPANIES");
  });

  it("T7: blocking — no ledger for a SAC, missing gateway ledger, zero-rated, no place of supply; leave-out exports the rest", async () => {
    const good = await invoice("mh");
    const odd = await invoice("ka", { sac: "998361" });
    const sez = await invoice("ka", { extra: { taxMode: "none" } });
    await prisma.clientBillingProfile.update({ where: { clientId: clients.hr }, data: { stateCode: null, gstin: null } });
    const nopos = await invoice("hr", { extra: { placeOfSupplyCode: null } });
    await pay("ka", { amount: odd.totalPaise, mode: "razorpay", allocs: [{ invoiceId: odd.id, amountPaise: odd.totalPaise }] });
    const p = (await preview()).body.data;
    const byNumber = Object.fromEntries(p.documents.map((d: { number: string; action: string }) => [d.number, d.action]));
    expect(byNumber[good.number]).toBe("create");
    const codes = p.issues.filter((i: { severity: string }) => i.severity === "block").map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["NO_SALES_LEDGER", "ZERO_RATED_UNSUPPORTED", "LEDGER_MISSING"]));
    expect(byNumber[sez.number]).toBe("blocked");
    expect(p.issues.find((i: { number: string }) => i.number === sez.number).message).toMatch(/export\/SEZ/);
    // Review fix: the held-back SEZ invoice is SEZWOP in GSTR-1, never counted in B2B / B2C.
    const mh = p.tallyShouldShow.gst.find((x: { gstin: string }) => x.gstin === "27AAKCD3352K1ZF");
    expect(mh.sezwop).toMatchObject({ count: 1, taxablePaise: sez.taxablePaise });
    expect(mh.b2b.count).toBe(2); // good + odd, not the SEZ one
    expect(p.tallyShouldShow.zeroRatedByHand).toBe(true);
    if (byNumber[nopos.number] === "blocked") expect(codes).toContain("PLACE_OF_SUPPLY_MISSING");
    const refused = await exportRun();
    expect(refused.body.error.code).toBe("TALLY_BLOCKED");
    const partial = await exportRun({ allowPartial: true });
    expect(partial.status, JSON.stringify(partial.body)).toBe(201);
    const items = await prisma.salesTallyItem.findMany({ where: { runId: partial.body.data.id } });
    expect(items.filter((i) => i.outcome === "blocked").map((i) => i.issueCode)).toEqual(expect.arrayContaining(["NO_SALES_LEDGER", "ZERO_RATED_UNSUPPORTED"]));
  });

  it("T7b: a receipt on a blocked invoice is DEPENDS_ON_UNSENT", async () => {
    const odd = await invoice("ka", { sac: "998361" });
    await pay("ka", { amount: odd.totalPaise, allocs: [{ invoiceId: odd.id, amountPaise: odd.totalPaise }] });
    const p = (await preview()).body.data;
    expect(p.issues.map((i: { code: string }) => i.code)).toContain("DEPENDS_ON_UNSENT");
  });

  it("review: a ₹0 invoice is held back (ZERO_VALUE_INVOICE), never a 500 for the whole month", async () => {
    const good = await invoice("mh");
    const free = await invoice("mh", { amount: 0 });
    const r = await preview();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const byNumber = Object.fromEntries(r.body.data.documents.map((d: { number: string; action: string }) => [d.number, d.action]));
    expect(byNumber[free.number]).toBe("blocked");
    expect(byNumber[good.number]).toBe("create");
    expect(r.body.data.issues.find((i: { number: string }) => i.number === free.number).code).toBe("ZERO_VALUE_INVOICE");
    expect((await request(app).get(`/v1/sales/tally/documents/invoice/${free.id}`).set(auth(sales))).status).toBe(200);
    expect((await exportRun({ allowPartial: true })).status).toBe(201);
  });

  it("T8 (R/G, I6): a stale preview is refused and no run row is written", async () => {
    const a = await invoice("mh");
    const p = await preview();
    await pay("mh", { amount: 100_000, allocs: [{ invoiceId: a.id, amountPaise: 100_000 }] });
    const r = await request(app).post("/v1/sales/tally/runs").set(auth(sales)).send({ companyKey: "dspl", ...OCT, mode: "new_only", previewHash: p.body.data.previewHash, acknowledge: ["FIRST_EXPORT_OVERLAP:-"] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("TALLY_PREVIEW_STALE");
    expect(await prisma.salesTallyRun.count()).toBe(0);
  });

  it("T9: acks — the first run needs its tick; it is stored on the run", async () => {
    await invoice("mh");
    const r = await exportRun({ ack: false });
    expect(r.body.error.code).toBe("TALLY_ACK_REQUIRED");
    const ok = await exportRun();
    expect(ok.status).toBe(201);
    expect(ok.body.data.acknowledged.map((x: { id: string }) => x.id)).toEqual(["FIRST_EXPORT_OVERLAP:-"]);
  });

  it("T30: the size cap", async () => {
    vi.stubEnv("SALES_TALLY_MAX_DOCS", "3");
    try {
      for (let i = 0; i < 4; i++) await invoice("mh");
      const r = await preview();
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("TALLY_RUN_TOO_LARGE");
    } finally { vi.unstubAllEnvs(); }
  });

  it("refuses a period that ends before booksFrom", async () => {
    const r = await preview({ from: "2026-01-01", to: "2026-03-31" });
    expect(r.body.error.code).toBe("TALLY_PERIOD_BEFORE_BOOKS");
  });
});

describe("file runs: confirm, only-new, cancellations, parties, money (T10–T20, T29)", () => {
  beforeEach(async () => { await seed(); await saveTally(); });

  it("T16 (R/G, I8) + T10: counted confirm, then only new; everything = alters; edits and earlier changes", async () => {
    const a = await invoice("mh");
    const b = await invoice("ka");
    const run = (await exportRun()).body.data;
    expect((await confirm(run.id, 1)).body.error.code).toBe("TALLY_COUNT_MISMATCH");
    expect((await confirm(run.id, 2, { errors: 1 })).body.error.code).toBe("TALLY_IMPORT_HAD_ERRORS");
    const ok = await confirm(run.id, 1, { altered: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.items.map((i: { outcome: string }) => i.outcome)).toEqual(["synced", "synced"]);
    expect((await confirm(run.id, 2)).body.error.code).toBe("TALLY_RUN_STATE");
    const ev = await prisma.salesEvent.findMany({ where: { entityType: "invoice", entityId: a.id, action: "tally_synced" } });
    expect(ev.length).toBe(1);
    expect((await prisma.salesTallyParty.findFirstOrThrow({ where: { clientId: clients.mh } })).lockedAt).not.toBeNull();

    const again = (await preview()).body.data;
    expect(again.counts.vouchers).toBe(0);
    expect((await exportRun()).body.error.code).toBe("TALLY_NOTHING_TO_EXPORT");
    const all = (await preview({ mode: "everything" })).body.data;
    expect(all.counts.sales.alter).toBe(2);
    // Recording a payment does not make the invoice changed.
    await pay("ka", { amount: 100_000, paidOn: "2026-11-02", allocs: [{ invoiceId: b.id, amountPaise: 100_000 }] });
    expect((await preview()).body.data.counts.sales).toEqual({ create: 0, alter: 0, cancel: 0 });
    // Renaming ledgers in settings changes no hash.
    await saveTally({ ledgers: { bank: "IDFC First Bank A/c 8788", outputCgst: "CGST Out", outputSgst: "SGST Out" } });
    await saveTally({ ledgers: { bank: "IDFC First Bank A/c 8788", outputCgst: "CGST Out", outputSgst: "SGST Out" } });
    expect((await preview()).body.data.counts.sales).toEqual({ create: 0, alter: 0, cancel: 0 });
    // Editing the issued invoice → one alter; next month carries it as an earlier change.
    const ed = await request(app).put(`/v1/sales/invoices/${a.id}`).set(auth(sales)).send({ clientId: clients.mh, poNumber: "PO-77", items: [{ description: "Instagram reel", unitPricePaise: 10_000_000 }] });
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    expect((await preview()).body.data.counts.sales.alter).toBe(1);
    const nov = (await preview({ from: "2026-11-01", to: "2026-11-30" })).body.data;
    expect(nov.documents.find((d: { docId: string }) => d.docId === a.id)).toMatchObject({ action: "alter", reason: "earlier_change" });
  });

  it("T15 (R/G, I4): one open run at a time; discard brings the documents back; concurrent creates make one run", async () => {
    await invoice("mh");
    const one = await exportRun();
    expect(one.status).toBe(201);
    expect((await exportRun()).body.error.code).toBe("TALLY_RUN_OPEN");
    expect((await request(app).post(`/v1/sales/tally/runs/${one.body.data.id}/discard`).set(auth(sales)).send({ reason: "Never imported" })).body.data.status).toBe("discarded");
    const p = await preview();
    expect(p.body.data.counts.sales.create).toBe(1);
    const body = { companyKey: "dspl", ...OCT, mode: "new_only", previewHash: p.body.data.previewHash, acknowledge: p.body.data.issues.filter((i: { severity: string }) => i.severity === "ack").map((i: { id: string }) => i.id) };
    const [x, y] = await Promise.all([1, 2].map(() => request(app).post("/v1/sales/tally/runs").set(auth(sales)).send(body)));
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(["TALLY_RUN_OPEN", "TALLY_PREVIEW_STALE"]).toContain((x.status === 409 ? x : y).body.error.code);
    expect(await prisma.salesTallyRun.count({ where: { status: "open" } })).toBe(1);
  });

  it("T11 + T13 + T12: the worked example end to end, refunds and cancellations", async () => {
    const inv = await invoice("mh", { issueDate: "2026-10-05", extra: { poNumber: "FB/PO/2211", poDate: "2026-10-01" } });
    const rc = await pay("mh", { amount: inv.totalPaise - 200_000, tds: 200_000, paidOn: "2026-10-20", allocs: [{ invoiceId: inv.id, amountPaise: inv.totalPaise - 200_000, tdsPaise: 200_000 }] });
    const one = (await exportRun()).body.data;
    expect(one.voucherCount).toBe(2);
    expect(one.controlTotalPaise).toBe(2 * inv.totalPaise);
    expect((await confirm(one.id, 2)).status).toBe(200);
    // November: a credit note after payment releases money back to the receipt.
    expect((await request(app).post("/v1/sales/credit-notes").set(auth(sales)).send({ invoiceId: inv.id, reason: "Post-sale discount: 1 story not delivered", taxablePaise: 1_000_000, issueDate: "2026-11-02" })).status).toBe(201);
    const nov = (await preview({ from: "2026-11-01", to: "2026-11-30" })).body.data;
    expect(nov.documents.filter((d: { action: string }) => d.action !== "unchanged").map((d: { docType: string; action: string }) => `${d.docType}:${d.action}`).sort()).toEqual(["credit_note:create", "receipt:alter"]);
    const two = (await exportRun({ from: "2026-11-01", to: "2026-11-30" })).body.data;
    const xml = await vouchersXml(two.id);
    expect(xml).toContain(`<BILLTYPE>On Account</BILLTYPE>`);
    expect(xml).toContain(`<NAME>${rc.number}</NAME>`);
    expect(xml).toContain('VCHTYPE="Credit Note" ACTION="Create"');
    expect(xml).toContain(`REMOTEID="dsh-rcpt-${rc.id}" VCHTYPE="Receipt" ACTION="Alter"`);
    expect(xml).not.toContain(`dsh-inv-${inv.id}`);
    expect((await confirm(two.id, 1, { altered: 1 })).status).toBe(200);
    // T13: a refund is a Payment voucher; the receipt is not re-sent because of it.
    const rf = await request(app).post(`/v1/sales/payments/${rc.id}/refunds`).set(auth(sales)).send({ amountPaise: 500_000, mode: "bank_transfer", refundedOn: "2026-11-10" });
    expect(rf.status, JSON.stringify(rf.body)).toBe(201);
    const p3 = (await preview({ from: "2026-11-01", to: "2026-11-30" })).body.data;
    expect(p3.documents.filter((d: { action: string }) => d.action === "create").map((d: { docType: string }) => d.docType)).toEqual(["refund"]);
    const three = (await exportRun({ from: "2026-11-01", to: "2026-11-30" })).body.data;
    const x3 = await vouchersXml(three.id);
    expect(x3).toContain('VCHTYPE="Payment" ACTION="Create"');
    expect(x3).toContain("<AMOUNT>-5000.00</AMOUNT>");
    await confirm(three.id, 1);
    // T12: void the synced receipt → Cancel; a cancelled refund → Cancel.
    await request(app).post(`/v1/sales/refunds/${rf.body.data.id ?? (await prisma.salesRefund.findFirstOrThrow()).id}/cancel`).set(auth(sales));
    const refundRow = await prisma.salesRefund.findFirstOrThrow();
    if (refundRow.status !== "cancelled") await request(app).post(`/v1/sales/refunds/${refundRow.id}/cancel`).set(auth(sales));
    await request(app).post(`/v1/sales/payments/${rc.id}/void`).set(auth(sales)).send({ reason: "Bounced" });
    const p4 = (await preview({ from: "2026-11-01", to: "2026-11-30" })).body.data;
    const acts = p4.documents.filter((d: { action: string }) => d.action === "cancel").map((d: { docType: string }) => d.docType).sort();
    expect(acts).toEqual(["receipt", "refund"]);
    const four = (await exportRun({ from: "2026-11-01", to: "2026-11-30" })).body.data;
    const x4 = await vouchersXml(four.id);
    expect(x4).toContain(`TAGVALUE="${rc.number}" VCHTYPE="Receipt" ACTION="Cancel"`);
  });

  it("T12b: a never-sent cancelled invoice is an ISCANCELLED create; a synced one becomes a Cancel", async () => {
    const a = await invoice("mh");
    const b = await invoice("mh");
    const run = (await exportRun()).body.data;
    await confirm(run.id, 2);
    await request(app).post(`/v1/sales/invoices/${a.id}/cancel`).set(auth(sales)).send({ reason: "Wrong client selected" });
    const c = await invoice("mh");
    await request(app).post(`/v1/sales/invoices/${c.id}/cancel`).set(auth(sales)).send({ reason: "Duplicate" });
    const p = (await preview()).body.data;
    const byId = Object.fromEntries(p.documents.map((d: { docId: string; action: string; reason: string }) => [d.docId, `${d.action}:${d.reason}`]));
    expect(byId[a.id]).toBe("cancel:cancelled");
    expect(byId[c.id]).toBe("create:cancelled");
    expect(byId[b.id]).toBe("unchanged:null");
    // Review fix: once confirmed, the cancelled create is in Tally as cancelled — no second Cancel.
    const two = (await exportRun()).body.data;
    expect(two.voucherCount).toBe(2);
    expect((await confirm(two.id, 1, { cancelled: 1 })).status).toBe(200);
    const again = (await preview()).body.data;
    expect(again.counts.vouchers).toBe(0);
    expect(again.documents.find((d: { docId: string }) => d.docId === c.id).action).toBe("unchanged");
    expect((await request(app).get(`/v1/sales/tally/documents/invoice/${c.id}`).set(auth(sales))).body.data.state).toBe("cancelled_in_tally");
    expect((await exportRun()).body.error.code).toBe("TALLY_NOTHING_TO_EXPORT");
  });

  it("T14: proforma converted after its receipt went to Tally — the receipt is altered to the tax invoice", async () => {
    const pf = await request(app).post("/v1/sales/invoices").set(auth(sales)).send({ clientId: clients.ka, kind: "proforma", items: [{ description: "Advance", unitPricePaise: 1_000_000 }] });
    const pfi = (await request(app).post(`/v1/sales/invoices/${pf.body.data.id}/issue`).set(auth(sales)).send({ issueDate: "2026-10-08" })).body.data;
    const rc = await pay("ka", { amount: pfi.totalPaise, paidOn: "2026-10-09", allocs: [{ invoiceId: pfi.id, amountPaise: pfi.totalPaise }] });
    const one = (await exportRun()).body.data;
    expect((await confirm(one.id, one.voucherCount)).status).toBe(200);
    const conv = await request(app).post(`/v1/sales/invoices/${pfi.id}/convert`).set(auth(sales));
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    const tax = await request(app).post(`/v1/sales/invoices/${conv.body.data.id}/issue`).set(auth(sales)).send({ issueDate: "2026-11-05" });
    expect(tax.status, JSON.stringify(tax.body)).toBe(200);
    const nov = (await preview({ from: "2026-11-01", to: "2026-11-30" })).body.data;
    const rows = Object.fromEntries(nov.documents.map((d: { docId: string; action: string; reason: string }) => [d.docId, `${d.action}:${d.reason}`]));
    expect(rows[conv.body.data.id]).toBe("create:new");
    expect(rows[rc.id]).toBe("alter:earlier_change");
    const run = (await exportRun({ from: "2026-11-01", to: "2026-11-30" })).body.data;
    const xml = await vouchersXml(run.id);
    expect(xml).toContain(`REMOTEID="dsh-rcpt-${rc.id}" VCHTYPE="Receipt" ACTION="Alter"`);
    expect(xml).toContain(`<NAME>${tax.body.data.number}</NAME>`);
  });

  it("T17: party ledgers — locked names, admin rename, taken names, the same GSTIN", async () => {
    await invoice("mh");
    const run = (await exportRun()).body.data;
    await confirm(run.id, 1);
    const put = (token: string, body: Record<string, unknown>, client = clients.mh) => request(app).put(`/v1/sales/tally/parties/${client}`).set(auth(token)).send(body);
    expect((await put(sales, { ledgerName: "Filmy Brands Pvt Ltd" })).body.error.code).toBe("TALLY_LEDGER_LOCKED");
    expect((await put(adminT, { ledgerName: "Filmy Brands Pvt Ltd" })).body.error.code).toBe("TALLY_LEDGER_LOCKED");
    const renamed = await put(adminT, { ledgerName: "Filmy Brands Pvt Ltd", confirmRenamedInTally: true });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data.ledgerName).toBe("Filmy Brands Pvt Ltd");
    expect((await put(sales, { ledgerName: "filmy brands pvt ltd" }, clients.ka)).body.error.code).toBe("TALLY_LEDGER_NAME_TAKEN");
    const acct = await put(sales, { ledgerName: "output cgst" }, clients.ka);
    expect(acct.body.error.code).toBe("TALLY_LEDGER_NAME_TAKEN");
    expect(acct.body.error.message).toMatch(/account ledgers/);
    const twin = await prisma.client.create({ data: { companyName: "Filmy Twin", contactName: "X", email: `twin-${Date.now()}@c.test`, passwordHash: "x" } });
    await prisma.clientBillingProfile.create({ data: { clientId: twin.id, legalName: "Filmy Brands Private Limited", gstin: "27AABCU9603R1ZX", stateCode: "27" } });
    expect((await put(sales, { ledgerName: "Filmy Brands Pvt Ltd" }, twin.id)).status).toBe(200);
    // The billing name changes later: the pinned name is still used and no new master is written.
    await prisma.clientBillingProfile.update({ where: { clientId: clients.mh }, data: { legalName: "Filmy Brands (India) Private Limited" } });
    await invoice("mh");
    const r2 = (await exportRun()).body.data;
    expect(r2.masterCount).toBe(0);
    expect(await vouchersXml(r2.id)).toContain("<PARTYLEDGERNAME>Filmy Brands Pvt Ltd</PARTYLEDGERNAME>");
  });

  it("T18 (R/G): BIGINT control total and party amounts stay exact as numbers", async () => {
    const big = 1_500_000_000; // ₹1,50,00,000
    const invs = [await invoice("mh", { amount: big }), await invoice("mh", { amount: big }), await invoice("mh", { amount: big })];
    await pay("mh", { amount: 2_100_000_000, tds: 100_000_000, allocs: [{ invoiceId: invs[0].id, amountPaise: invs[0].totalPaise - 100_000_000, tdsPaise: 100_000_000 }, { invoiceId: invs[1].id, amountPaise: 2_100_000_000 - (invs[0].totalPaise - 100_000_000) }] });
    const run = await exportRun();
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.data.controlTotalPaise).toBe(3 * invs[0].totalPaise + 2_200_000_000);
    expect(typeof run.body.data.controlTotalPaise).toBe("number");
    const rcItem = run.body.data.items.find((i: { docType: string }) => i.docType === "receipt");
    expect(rcItem.partyAmountPaise).toBe(2_200_000_000);
    const row = await prisma.salesTallyRun.findUniqueOrThrow({ where: { id: run.body.data.id } });
    expect(row.controlTotalPaise).toBe(BigInt(3 * invs[0].totalPaise + 2_200_000_000));
  });

  it("T19 (I7): downloads serve the stored bytes, verify the sha256, and refuse a tampered file", async () => {
    await invoice("mh");
    const run = (await exportRun()).body.data;
    const row = await prisma.salesTallyRun.findUniqueOrThrow({ where: { id: run.id } });
    const raw = gunzipSync(Buffer.from(row.vouchersXmlGz!));
    expect(createHash("sha256").update(raw).digest("hex")).toBe(row.vouchersSha256);
    const r = await request(app).get(`/v1/sales/tally/runs/${run.id}/file?part=vouchers`).set(auth(sales)).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(Buffer.compare(r.body as Buffer, raw)).toBe(0);
    expect(r.headers["content-type"]).toMatch(/text\/xml/);
    expect(r.headers["content-disposition"]).toBe(`attachment; filename="tally-dspl-2026-10-01_2026-10-31-export1-vouchers.xml"`);
    expect(r.headers["access-control-expose-headers"]).toBe("Content-Disposition");
    expect(r.headers["cache-control"]).toBe("no-store");
    const m = await request(app).get(`/v1/sales/tally/runs/${run.id}/file?part=masters`).set(auth(sales));
    expect(m.status).toBe(200);
    await prisma.salesTallyRun.update({ where: { id: run.id }, data: { vouchersXmlGz: gzipSync(Buffer.from(raw.toString().replace("Instagram", "Instagrem"))) } });
    const bad = await request(app).get(`/v1/sales/tally/runs/${run.id}/file?part=vouchers`).set(auth(sales));
    expect(bad.status).toBe(500);
    expect(bad.body.error.code).toBe("TALLY_FILE_CORRUPT");
    await prisma.salesTallyRun.update({ where: { id: run.id }, data: { mastersXmlGz: null, mastersSha256: null } });
    expect((await request(app).get(`/v1/sales/tally/runs/${run.id}/file?part=masters`).set(auth(sales))).status).toBe(404);
  });

  it("T20 (I1): preview, run and confirm never write a sales document", async () => {
    const a = await invoice("mh");
    await pay("mh", { amount: 100_000, allocs: [{ invoiceId: a.id, amountPaise: 100_000 }] });
    await request(app).post("/v1/sales/credit-notes").set(auth(sales)).send({ invoiceId: a.id, reason: "Discount", taxablePaise: 100_000, issueDate: "2026-10-15" });
    const snap = async () => {
      const out: Record<string, unknown> = {};
      for (const t of ["sales_invoices", "sales_payments", "sales_payment_allocations", "sales_credit_notes", "sales_refunds"]) {
        const col = t === "sales_invoices" ? "updated_at" : "created_at";
        out[t] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n, max(${col}) AS m FROM ${t}`);
      }
      return JSON.stringify(out);
    };
    await flushSalesBackground();
    const before = await snap();
    const run = (await exportRun()).body.data;
    await confirm(run.id, run.voucherCount);
    await preview({ mode: "everything" });
    expect(await snap()).toBe(before);
  });

  it("T29: manual resolution records a confirmed manual run; the next preview shows it unchanged", async () => {
    const sez = await invoice("ka", { extra: { taxMode: "none" } });
    expect((await preview()).body.data.documents[0]).toMatchObject({ action: "blocked" });
    const r = await request(app).post("/v1/sales/tally/resolve").set(auth(adminT)).send({ companyKey: "dspl", docs: [{ docType: "invoice", docId: sez.id }], note: "Entered by hand in Tally by Priya" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ channel: "manual", status: "confirmed" });
    expect((await preview()).body.data.documents[0]).toMatchObject({ action: "unchanged" });
    const st = await request(app).get(`/v1/sales/tally/documents/invoice/${sez.id}`).set(auth(sales));
    expect(st.body.data.state).toBe("synced");
  });

  it("document status: never → pending → synced → changed", async () => {
    const a = await invoice("mh");
    const st = async () => (await request(app).get(`/v1/sales/tally/documents/invoice/${a.id}`).set(auth(sales))).body.data.state;
    expect(await st()).toBe("never");
    const run = (await exportRun()).body.data;
    expect(await st()).toBe("pending");
    await confirm(run.id, 1);
    expect(await st()).toBe("synced");
    await request(app).put(`/v1/sales/invoices/${a.id}`).set(auth(sales)).send({ clientId: clients.mh, poNumber: "PO-1", items: [{ description: "Instagram reel", unitPricePaise: 10_000_000 }] });
    expect(await st()).toBe("changed");
  });

  it("T28: match from a pasted ledger export, then apply", async () => {
    await invoice("mh"); await invoice("ka"); await invoice("hr");
    const xml = `<ENVELOPE><LEDGER NAME="Filmy Brands (Tally)"><PARENT>Sundry Debtors</PARENT><LEDGSTREGDETAILS.LIST><GSTIN>27AABCU9603R1ZX</GSTIN></LEDGSTREGDETAILS.LIST></LEDGER>`
      + `<LEDGER NAME="Bengaluru Beats Private Limited"><PARENT>Sundry Debtors</PARENT></LEDGER>`
      + `<LEDGER NAME="Gurgaon Grooves Private Limited"><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>07AAAAA0000A1Z5</PARTYGSTIN></LEDGER></ENVELOPE>`;
    const m = await request(app).post("/v1/sales/tally/parties/match").set(auth(adminT)).send({ companyKey: "dspl", source: "xml", xml });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.data.suggestions.map((s: { by: string; tallyName: string }) => `${s.by}:${s.tallyName}`)).toEqual(["gstin:Filmy Brands (Tally)", "name:Bengaluru Beats Private Limited"]);
    expect(m.body.data.conflicts).toEqual([{ tallyName: "Gurgaon Grooves Private Limited", gstins: ["07AAAAA0000A1Z5", "06AABCH1234A1Z5"] }]);
    const apply = await request(app).post("/v1/sales/tally/parties/apply").set(auth(adminT)).send({ companyKey: "dspl", mappings: m.body.data.suggestions.map((s: { clientId: string; tallyName: string }) => ({ clientId: s.clientId, ledgerName: s.tallyName, existsInTally: true })) });
    expect(apply.body.data).toEqual({ saved: 2, skipped: [] });
    expect(await prisma.salesEvent.count({ where: { entityType: "client", action: "tally_ledger_set" } })).toBe(2);
    const bad = await request(app).post("/v1/sales/tally/parties/apply").set(auth(adminT)).send({ companyKey: "dspl", mappings: [{ clientId: clients.hr, ledgerName: "Round Off", existsInTally: true }] });
    expect(bad.body.data).toMatchObject({ saved: 0, skipped: [{ clientId: clients.hr, reason: expect.stringMatching(/account ledger/) }] });
    const run = (await exportRun({ allowPartial: true })).body.data;
    expect(run.masterCount).toBe(1); // only the Haryana client's ledger is new
  });
});

// ── Push ──────────────────────────────────────────────────────────────────────────

interface FakeVoucher { number: string; type: string; party: string; amountPaise: number; remoteId: string; cancelled: boolean; masterId: string }
function fakeTally(o: { companies?: string[]; ledgers?: Array<{ name: string; gstin?: string }>; vouchers?: FakeVoucher[]; failCollections?: boolean } = {}) {
  const state = {
    companies: o.companies ?? ["Digital Sukoon Private Limited"],
    ledgers: new Map((o.ledgers ?? [
      "Sales - Advertising Services", "Output CGST", "Output SGST", "Output IGST", "Round Off", "TDS Receivable", "IDFC First Bank A/c 8788", "Cash",
    ].map((name) => ({ name }))).map((l) => [l.name.toLowerCase(), l])),
    vouchers: new Map((o.vouchers ?? []).map((v) => [v.remoteId, v])),
    posts: [] as string[],
    creates: new Map<string, number>(),
    dropReplyOnce: new Set<string>(),
    notSent: 0,
    lineError: null as string | null,
  };
  let id = 100;
  const transport: TallyTransport = {
    async send(_t, body): Promise<TransportResult> {
      if (body === null) return { ok: true, status: 200, body: "<RESPONSE>TallyPrime Server is Running</RESPONSE>" };
      if (state.notSent > 0 && body.includes("Import Data") && body.includes("<VOUCHER")) { state.notSent -= 1; return { ok: false, kind: "NOT_SENT", message: "ECONNREFUSED" }; }
      if (body.includes("<TYPE>Collection</TYPE>")) {
        if (o.failCollections && body.includes("DshVouchers")) return { ok: false, kind: "NOT_SENT", message: "ECONNRESET" };
        if (body.includes("<ID>DshCompanies</ID>")) return { ok: true, status: 200, body: `<ENVELOPE>${state.companies.map((c) => `<COMPANY NAME="${c}"></COMPANY>`).join("")}</ENVELOPE>` };
        if (body.includes("<ID>DshLedgers</ID>")) return { ok: true, status: 200, body: `<ENVELOPE>${[...state.ledgers.values()].map((l) => `<LEDGER NAME="${l.name.replace(/&/g, "&amp;")}">${l.gstin ? `<PARTYGSTIN>${l.gstin}</PARTYGSTIN>` : ""}</LEDGER>`).join("")}</ENVELOPE>` };
        return { ok: true, status: 200, body: `<ENVELOPE>${[...state.vouchers.values()].map((v) => `<VOUCHER REMOTEID="${v.remoteId}"><VOUCHERNUMBER>${v.number}</VOUCHERNUMBER><VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME><PARTYLEDGERNAME>${v.party}</PARTYLEDGERNAME><AMOUNT>${(v.amountPaise / 100).toFixed(2)}</AMOUNT><MASTERID>${v.masterId}</MASTERID><ISCANCELLED>${v.cancelled ? "Yes" : "No"}</ISCANCELLED></VOUCHER>`).join("")}</ENVELOPE>` };
      }
      state.posts.push(body);
      let created = 0, altered = 0, cancelled = 0;
      let remote = "";
      for (const b of messageBlocks(body)) {
        if (b.key.startsWith("ledger:")) { state.ledgers.set(b.key.slice(7).toLowerCase(), { name: b.key.slice(7) }); created += 1; continue; }
        if (state.lineError) return { ok: true, status: 200, body: `<RESPONSE><CREATED>0</CREATED><ERRORS>1</ERRORS><LINEERROR>${state.lineError}</LINEERROR></RESPONSE>` };
        const action = b.raw.match(/ACTION="(\w+)"/)![1];
        if (action === "Cancel") {
          const num = b.raw.match(/TAGVALUE="([^"]+)"/)![1];
          const v = [...state.vouchers.values()].find((x) => x.number === num);
          if (v) v.cancelled = true;
          cancelled += 1;
          continue;
        }
        remote = b.raw.match(/REMOTEID="([^"]+)"/)![1];
        const party = b.raw.match(/<PARTYLEDGERNAME>([^<]+)</)![1];
        const amount = Math.round(Math.abs(Number(b.raw.match(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/)?.[1] ?? 0)) * 100);
        const existed = state.vouchers.has(remote);
        state.vouchers.set(remote, { number: b.raw.match(/<VOUCHERNUMBER>([^<]+)</)![1], type: b.raw.match(/VCHTYPE="([^"]+)"/)![1], party, amountPaise: amount, remoteId: remote, cancelled: b.raw.includes("<ISCANCELLED>Yes"), masterId: String(++id) });
        if (action === "Create") state.creates.set(remote, (state.creates.get(remote) ?? 0) + 1);
        if (existed && action === "Alter") altered += 1; else created += 1;
      }
      if (state.dropReplyOnce.has(remote)) { state.dropReplyOnce.delete(remote); return { ok: false, kind: "NO_ANSWER", message: "timed out" }; }
      return { ok: true, status: 200, body: `<RESPONSE><CREATED>${created}</CREATED><ALTERED>${altered}</ALTERED><CANCELLED>${cancelled}</CANCELLED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS><LASTVCHID>${id}</LASTVCHID></RESPONSE>` };
    },
  };
  return { state, transport };
}

describe("Send to Tally (T21–T27)", () => {
  beforeEach(async () => {
    await seed();
    vi.stubEnv("SALES_TALLY_PUSH_ENABLED", "1");
    vi.stubEnv("SALES_TALLY_ALLOW_LOOPBACK", "1");
    await saveTally({ pushUrl: "http://127.0.0.1:9000" });
  });
  afterEach(() => { setTallyTransportForTests(undefined); vi.unstubAllEnvs(); });

  const push = async () => { const r = await exportRun({ token: adminT, path: "pushes" }); await flushSalesBackground(); return r; };
  const runOf = async (id: string) => (await request(app).get(`/v1/sales/tally/runs/${id}`).set(auth(sales))).body.data;

  it("T21: happy path — company check, pre-flight, masters, one POST per voucher in order", async () => {
    const f = fakeTally();
    setTallyTransportForTests(f.transport);
    const a = await invoice("mh");
    await pay("mh", { amount: a.totalPaise, allocs: [{ invoiceId: a.id, amountPaise: a.totalPaise }] });
    const r = await push();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const run = await runOf(r.body.data.id);
    expect(run.status).toBe("pushed");
    expect(run.items.map((i: { outcome: string }) => i.outcome)).toEqual(["synced", "synced"]);
    expect(run.items[0].tallyVchId).toBeTruthy();
    expect(f.state.posts.length).toBe(3); // masters + 2 vouchers
    expect(f.state.posts[0]).toContain("All Masters");
    expect(f.state.posts[1]).toContain('VCHTYPE="Sales"');
    expect(f.state.posts[2]).toContain('VCHTYPE="Receipt"');
    const ev = await prisma.salesEvent.findMany({ where: { entityType: "tally_run", entityId: run.id } });
    expect(ev.map((e) => e.action)).toEqual(expect.arrayContaining(["built", "push_started", "pushed"]));
    expect(await prisma.salesEvent.count({ where: { action: "tally_synced" } })).toBe(2);
  });

  it("T22 (R/G, I4): a lost reply is adopted on retry — exactly one Create reaches Tally", async () => {
    const f = fakeTally();
    setTallyTransportForTests(f.transport);
    const a = await invoice("mh");
    f.state.dropReplyOnce.add(`dsh-inv-${a.id}`);
    const r = await push();
    const run = await runOf(r.body.data.id);
    expect(run.status).toBe("partial");
    expect(run.items[0].outcome).toBe("unknown");
    const retry = await request(app).post(`/v1/sales/tally/runs/${run.id}/retry`).set(auth(adminT));
    expect(retry.status).toBe(202);
    await flushSalesBackground();
    const after = await runOf(run.id);
    expect(after.items[0].outcome).toBe("adopted");
    expect(after.status).toBe("pushed");
    expect(f.state.creates.get(`dsh-inv-${a.id}`)).toBe(1);
  });

  it("T23: pre-flight — identical voucher adopted; different refused; read failure sends nothing", async () => {
    const a = await invoice("mh");
    const f = fakeTally({ vouchers: [{ number: a.number, type: "Sales", party: "Filmy Brands Private Limited", amountPaise: -a.totalPaise, remoteId: "typed-by-hand", cancelled: false, masterId: "9" }] });
    setTallyTransportForTests(f.transport);
    const r = await push();
    const run = await runOf(r.body.data.id);
    expect(run.items[0].outcome).toBe("adopted");
    expect(f.state.posts.filter((p) => p.includes("<VOUCHER")).length).toBe(0);

    const b = await invoice("mh");
    const g = fakeTally({ vouchers: [{ number: b.number, type: "Sales", party: "Someone Else", amountPaise: 1, remoteId: "x", cancelled: false, masterId: "9" }] });
    setTallyTransportForTests(g.transport);
    const r2 = await push();
    const run2 = await runOf(r2.body.data.id);
    expect(run2.items[0]).toMatchObject({ outcome: "failed", issueCode: "VOUCHER_EXISTS_DIFFERENT" });
    await request(app).post(`/v1/sales/tally/runs/${run2.id}/close`).set(auth(adminT)).send({ reason: "Fix by hand" });

    const h = fakeTally({ failCollections: true });
    setTallyTransportForTests(h.transport);
    await invoice("ka");
    const r3 = await push();
    const run3 = await runOf(r3.body.data.id);
    expect(run3.status).toBe("partial");
    expect(run3.pushResult.error).toMatch(/nothing was sent/);
    expect(h.state.posts.length).toBe(0);
  });

  it("T23b (I5): an alter whose Tally amount is neither the last sent nor the new is EDITED_IN_TALLY", async () => {
    const f = fakeTally();
    setTallyTransportForTests(f.transport);
    const a = await invoice("mh");
    await push();
    await request(app).put(`/v1/sales/invoices/${a.id}`).set(auth(sales)).send({ clientId: clients.mh, poNumber: "PO-1", items: [{ description: "Instagram reel", unitPricePaise: 10_000_000 }] });
    f.state.vouchers.get(`dsh-inv-${a.id}`)!.amountPaise = 123;
    const r = await push();
    const run = await runOf(r.body.data.id);
    expect(run.items[0]).toMatchObject({ outcome: "failed", issueCode: "EDITED_IN_TALLY" });
  });

  it("T24: line errors fail the item and its dependants; three transport failures stop; close supersedes; company not open", async () => {
    const f = fakeTally();
    setTallyTransportForTests(f.transport);
    const a = await invoice("mh");
    await pay("mh", { amount: a.totalPaise, allocs: [{ invoiceId: a.id, amountPaise: a.totalPaise }] });
    f.state.lineError = "Ledger 'Output CGST' does not exist!";
    const r = await push();
    const run = await runOf(r.body.data.id);
    expect(run.items.find((i: { docType: string }) => i.docType === "invoice")).toMatchObject({ outcome: "failed", error: "Ledger 'Output CGST' does not exist!" });
    expect(run.items.find((i: { docType: string }) => i.docType === "receipt")).toMatchObject({ outcome: "failed", issueCode: "DEPENDS_ON_UNSENT" });
    f.state.lineError = null;
    f.state.notSent = 3;
    await request(app).post(`/v1/sales/tally/runs/${run.id}/retry`).set(auth(adminT));
    await flushSalesBackground();
    const again = await runOf(run.id);
    expect(again.status).toBe("partial");
    const closed = await request(app).post(`/v1/sales/tally/runs/${run.id}/close`).set(auth(adminT)).send({ reason: "Gave up for now" });
    expect(closed.body.data.items.every((i: { outcome: string }) => i.outcome === "superseded")).toBe(true);
    expect((await preview()).body.data.counts.sales.create).toBe(1);

    const g = fakeTally({ companies: ["Some Other Co"] });
    setTallyTransportForTests(g.transport);
    const r2 = await push();
    const run2 = await runOf(r2.body.data.id);
    expect(run2.status).toBe("partial");
    expect(run2.pushResult.error).toMatch(/isn't open/);
    expect(g.state.posts.length).toBe(0);
  });

  it("T25: the kill switch and the URL guard", async () => {
    await invoice("mh");
    vi.stubEnv("SALES_TALLY_PUSH_ENABLED", "0");
    expect((await request(app).post("/v1/sales/tally/pushes").set(auth(adminT)).send({})).body.error.code).toBe("TALLY_PUSH_OFF");
    expect((await request(app).post("/v1/sales/tally/test").set(auth(adminT))).body.error.code).toBe("TALLY_PUSH_OFF");
    expect((await request(app).post("/v1/sales/tally/runs/x/retry").set(auth(adminT))).body.error.code).toBe("TALLY_PUSH_OFF");
    expect((await exportRun()).status).toBe(201);
    vi.stubEnv("SALES_TALLY_PUSH_ENABLED", "1");
    await saveTally({ pushUrl: null });
    expect((await request(app).post("/v1/sales/tally/test").set(auth(adminT))).body.error.code).toBe("TALLY_URL_MISSING");
    await saveTally({ pushUrl: "http://8.8.8.8:9000" });
    const t = await request(app).post("/v1/sales/tally/test").set(auth(adminT));
    expect(t.status).toBe(422);
    expect(t.body.error.code).toBe("TALLY_URL_REFUSED");
  });

  it("T26: real socket — no answer is unknown, an oversized reply is cut, a redirect is a bad response", async () => {
    vi.stubEnv("SALES_TALLY_TIMEOUT_MS", "300");
    let mode: "hang" | "huge" | "redirect" = "hang";
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (body.includes("DshCompanies")) return res.end(`<ENVELOPE><COMPANY NAME="Digital Sukoon Private Limited"></COMPANY></ENVELOPE>`);
        if (body.includes("DshLedgers")) return res.end(`<ENVELOPE>${["Sales - Advertising Services", "Output CGST", "Output SGST", "Round Off"].map((n) => `<LEDGER NAME="${n}"></LEDGER>`).join("")}</ENVELOPE>`);
        if (body.includes("DshVouchers")) return res.end("<ENVELOPE></ENVELOPE>");
        if (body.includes("All Masters")) return res.end("<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>");
        if (mode === "hang") return; // never answers
        if (mode === "redirect") { res.writeHead(302, { Location: "http://example.com/" }); return res.end(); }
        res.write("<RESPONSE>");
        const chunk = "x".repeat(1 << 16);
        for (let i = 0; i < 40; i++) res.write(chunk);
        res.end();
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      // the guard allows 9000–9010 only: forward a port in range to the test server
      const proxy = http.createServer((req, res) => {
        const p = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 500, r.headers); r.pipe(res); });
        p.on("error", () => res.destroy());
        req.pipe(p);
      });
      let listened = 0;
      for (const candidate of [9007, 9008, 9009, 9010]) {
        try { await new Promise<void>((ok, bad) => { proxy.once("error", bad); proxy.listen(candidate, "127.0.0.1", () => ok()); }); listened = candidate; break; } catch { /* port busy */ }
      }
      expect(listened).toBeGreaterThan(0);
      await saveTally({ pushUrl: `http://127.0.0.1:${listened}` });
      try {
        await invoice("mh");
        const t0 = Date.now();
        const r = await push();
        const run = await runOf(r.body.data.id);
        expect(run.items[0].outcome).toBe("unknown");
        expect(Date.now() - t0).toBeLessThan(5_000);
        mode = "huge";
        await request(app).post(`/v1/sales/tally/runs/${run.id}/retry`).set(auth(adminT));
        await flushSalesBackground();
        expect((await runOf(run.id)).items[0].outcome).toBe("unknown");
        mode = "redirect";
        await request(app).post(`/v1/sales/tally/runs/${run.id}/retry`).set(auth(adminT));
        await flushSalesBackground();
        expect((await runOf(run.id)).items[0]).toMatchObject({ outcome: "failed", issueCode: "TALLY_BAD_RESPONSE" });
      } finally { proxy.closeAllConnections(); await new Promise((ok) => proxy.close(ok)); }
    } finally { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); }
  }, 30_000);

  it("T27: a pushing run with no worker and no heartbeat is stale; Retry resumes it", async () => {
    const f = fakeTally();
    setTallyTransportForTests(f.transport);
    await invoice("mh");
    const r = await exportRun({ token: adminT, path: "pushes" });
    await flushSalesBackground();
    const id = r.body.data.id;
    await prisma.salesTallyRun.update({ where: { id }, data: { status: "pushing" } });
    await prisma.$executeRaw`UPDATE sales_tally_runs SET updated_at = ${new Date(Date.now() - 10 * 60_000).toISOString()}::timestamp WHERE id = ${id}`;
    await prisma.$executeRaw`UPDATE sales_tally_items SET outcome = 'sending' WHERE run_id = ${id}`;
    pushRegistry.delete(id);
    expect((await runOf(id)).stale).toBe(true);
    expect((await request(app).post(`/v1/sales/tally/runs/${id}/retry`).set(auth(adminT))).status).toBe(202);
    await flushSalesBackground();
    const run = await runOf(id);
    expect(run.status).toBe("pushed");
    expect(["synced", "adopted"]).toContain(run.items[0].outcome);
  });

  it("review: a send that stopped before anything reached Tally leaves its new parties unlocked", async () => {
    const g = fakeTally({ companies: ["Some Other Co"] });
    setTallyTransportForTests(g.transport);
    await invoice("mh");
    const r = await push();
    const run = await runOf(r.body.data.id);
    expect(run.status).toBe("partial");
    await request(app).post(`/v1/sales/tally/runs/${run.id}/close`).set(auth(adminT)).send({ reason: "Tally was closed" });
    expect((await prisma.salesTallyParty.findFirstOrThrow({ where: { clientId: clients.mh } })).lockedAt).toBeNull();
    expect((await preview()).body.data.counts.masters.partiesNew).toBe(1);
  });

  it("review: a queued run nobody claimed is stale and can be retried", async () => {
    const f = fakeTally();
    setTallyTransportForTests(f.transport);
    await invoice("mh");
    const r = await exportRun({ token: adminT, path: "pushes" });
    await flushSalesBackground();
    const id = r.body.data.id;
    await prisma.salesTallyItem.updateMany({ where: { runId: id }, data: { outcome: "pending" } });
    await prisma.$executeRaw`UPDATE sales_tally_runs SET status = 'queued', updated_at = ${new Date(Date.now() - 10 * 60_000).toISOString()}::timestamp WHERE id = ${id}`;
    pushRegistry.delete(id);
    expect((await runOf(id)).stale).toBe(true);
    expect((await request(app).post(`/v1/sales/tally/runs/${id}/retry`).set(auth(adminT))).status).toBe(202);
    await flushSalesBackground();
    expect((await runOf(id)).status).toBe("pushed");
  });

  it("review: EDITED_IN_TALLY is marked as done by hand from its own (open) run; the next preview shows it unchanged", async () => {
    const f = fakeTally();
    setTallyTransportForTests(f.transport);
    const a = await invoice("mh");
    await push();
    await request(app).put(`/v1/sales/invoices/${a.id}`).set(auth(sales)).send({ clientId: clients.mh, poNumber: "PO-1", items: [{ description: "Instagram reel", unitPricePaise: 10_000_000 }] });
    f.state.vouchers.get(`dsh-inv-${a.id}`)!.amountPaise = 123;
    const run = await runOf((await push()).body.data.id);
    expect(run.items[0]).toMatchObject({ outcome: "failed", issueCode: "EDITED_IN_TALLY" });
    const resolve = (fromRunId?: string) => request(app).post("/v1/sales/tally/resolve").set(auth(adminT)).send({ companyKey: "dspl", docs: [{ docType: "invoice", docId: a.id }], note: "Fixed in Tally by Priya", ...(fromRunId ? { fromRunId } : {}) });
    expect((await resolve()).body.error.code).toBe("TALLY_RUN_OPEN");
    const ok = await resolve(run.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const src = await runOf(run.id);
    expect(src.status).toBe("closed");
    expect(src.items[0].outcome).toBe("superseded");
    const p = (await preview()).body.data;
    expect(p.documents.find((d: { docId: string }) => d.docId === a.id).action).toBe("unchanged");
    expect(p.openRun).toBeNull();
  });

  it("review: an alter whose voucher Tally lost is sent as a Create with the same REMOTEID", async () => {
    const f = fakeTally();
    setTallyTransportForTests(f.transport);
    const a = await invoice("mh");
    await push();
    await request(app).put(`/v1/sales/invoices/${a.id}`).set(auth(sales)).send({ clientId: clients.mh, poNumber: "PO-1", items: [{ description: "Instagram reel", unitPricePaise: 10_000_000 }] });
    f.state.vouchers.delete(`dsh-inv-${a.id}`);
    f.state.posts.length = 0;
    const run = await runOf((await push()).body.data.id);
    expect(run.items[0]).toMatchObject({ action: "alter", outcome: "synced" });
    const sent = f.state.posts.find((x) => x.includes("<VOUCHER"))!;
    expect(sent).toContain(`REMOTEID="dsh-inv-${a.id}"`);
    expect(sent).toContain('ACTION="Create"');
    expect(sent).not.toContain('ACTION="Alter"');
    expect(f.state.creates.get(`dsh-inv-${a.id}`)).toBe(2);
  });

  it("review: PARTY_LEDGER_CONFLICT and LEDGER_MISSING fail before anything is sent", async () => {
    const base = ["Sales - Advertising Services", "Output CGST", "Output SGST", "Output IGST", "Round Off", "TDS Receivable", "IDFC First Bank A/c 8788", "Cash"];
    const f = fakeTally({ ledgers: [...base.map((name) => ({ name })), { name: "Filmy Brands Private Limited", gstin: "27AAAAA0000A1Z5" }] });
    setTallyTransportForTests(f.transport);
    await invoice("mh");
    const run = await runOf((await push()).body.data.id);
    expect(run.items[0]).toMatchObject({ outcome: "failed", issueCode: "PARTY_LEDGER_CONFLICT" });
    expect(f.state.posts.filter((x) => x.includes("<VOUCHER")).length).toBe(0);
    await request(app).post(`/v1/sales/tally/runs/${run.id}/close`).set(auth(adminT)).send({ reason: "Rename in Tally" });

    const g = fakeTally({ ledgers: base.filter((n) => n !== "Output CGST").map((name) => ({ name })) });
    setTallyTransportForTests(g.transport);
    const run2 = await runOf((await push()).body.data.id);
    expect(run2.items[0]).toMatchObject({ outcome: "failed", issueCode: "LEDGER_MISSING" });
    expect(run2.items[0].error).toMatch(/Output CGST/);
    expect(g.state.posts.filter((x) => x.includes("<VOUCHER")).length).toBe(0);
  });

  it("test connection reports open companies and ledgers", async () => {
    const f = fakeTally({ companies: ["Digital Sukoon Private Limited"] });
    setTallyTransportForTests(f.transport);
    const t = await request(app).post("/v1/sales/tally/test").set(auth(adminT));
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect(t.body.data).toMatchObject({ reachable: true, missingCompanies: [], openCompanies: ["Digital Sukoon Private Limited"] });
    expect(t.body.data.ledgers.find((l: { name: string }) => l.name === "Output CGST").found).toBe(true);
    expect(t.body.data.server).toBe("TallyPrime Server is Running");
    // Something else at that address: nothing of its reply is echoed (R6).
    setTallyTransportForTests({ async send() { return { ok: true, status: 200, body: "<html>MinIO Console secret-bucket-list</html>" }; } });
    const other = await request(app).post("/v1/sales/tally/test").set(auth(adminT));
    expect(other.body.error.code).toBe("TALLY_BAD_RESPONSE");
    expect(JSON.stringify(other.body)).not.toMatch(/MinIO|secret/);
  });
});
